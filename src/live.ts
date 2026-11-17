import { HttpError, type Env, type JobRow, type JobSpec } from "./types";
import { liveAllowed } from "./lib/validate";
import { DEFAULT_H3_WORKFLOW_ID, ProviderError, RunningHubClient, h3NodeInfo, providerDeps, type Balance } from "./providers/runninghub";

const MAX_MASTER_BYTES = 30 * 1024 * 1024;

export function rhClient(env: Env): RunningHubClient {
  if (!env.RUNNINGHUB_API_KEY) throw new HttpError(503, "provider_key_missing", { provider: "runninghub-h3" });
  return new RunningHubClient(env.RUNNINGHUB_API_KEY, env.RUNNINGHUB_BASE_URL || undefined);
}

function asHttp(e: unknown): never {
  if (e instanceof HttpError) throw e;
  if (e instanceof ProviderError) throw new HttpError(502, e.code, e.detail);
  throw e;
}

async function logEv(env: Env, jobId: string, type: string, detail: unknown) {
  await env.DB.prepare("INSERT INTO events (job_id, type, from_state, to_state, detail_json, created_at) VALUES (?,?,?,?,?,?)")
    .bind(jobId, type, null, null, JSON.stringify(detail), new Date().toISOString()).run();
}

/** Free, read-only balance query. */
export async function providerBalance(env: Env): Promise<Balance> {
  try { return await rhClient(env).accountStatus(); } catch (e) { asHttp(e); }
}

/**
 * Gate + submit ONE live RunningHub H3 task. Called only from run() for mode=live jobs in state queued.
 * Ordering matters: every free check happens before the single paid call (createTask).
 */
export async function liveSubmit(env: Env, job: JobRow) {
  const gate = liveAllowed(env);
  if (!gate.allowed) throw new HttpError(403, "live_provider_blocked", { reason: gate.reason, provider: job.provider });
  if (!job.live_approval_ref) throw new HttpError(403, "live_job_not_owner_approved");
  if (job.provider !== "runninghub-h3" || job.line !== "A") throw new HttpError(403, "live_only_runninghub_h3_line_A");
  const spec = JSON.parse(job.spec_json) as JobSpec;
  const canon = await env.DB.prepare("SELECT * FROM canon_characters WHERE id = ?").bind(job.character_id).first<any>();
  if (!canon || canon.approved !== 1 || canon.sex !== "female" || canon.source === "staging-fixture" || canon.master_url !== job.master_url)
    throw new HttpError(403, "canon_not_live_approved", { character: job.character_id });
  const client = rhClient(env);

  // Global cap: claim a live submission slot atomically (counts every claim, including failed paid calls).
  const cap = Math.max(0, Number(env.LIVE_MAX_SUBMISSIONS ?? 1));
  const claimTag = `claim:${job.id}:${crypto.randomUUID()}`;
  const claim = await env.DB.prepare(
    `UPDATE jobs SET provider_task_id = ? WHERE id = ? AND state = 'queued' AND mode = 'live'
       AND (SELECT COUNT(*) FROM jobs WHERE mode = 'live' AND provider_task_id IS NOT NULL) < ?`,
  ).bind(claimTag, job.id, cap).run();
  if (!claim.meta.changes) throw new HttpError(403, "live_submission_cap_reached", { cap });
  const unclaim = () => env.DB.prepare("UPDATE jobs SET provider_task_id = NULL WHERE id = ? AND provider_task_id = ?").bind(job.id, claimTag).run();

  let balanceBefore: Balance, fileName: string;
  try {
    balanceBefore = await client.accountStatus();
    if (balanceBefore.remainCoins < job.estimated_credits) {
      await logEv(env, job.id, "provider_balance_insufficient", { remainCoins: balanceBefore.remainCoins, needed: job.estimated_credits });
      throw new HttpError(402, "provider_balance_insufficient", { remainCoins: balanceBefore.remainCoins, needed: job.estimated_credits, note: "no top-up attempted" });
    }
    if (!/^https:\/\//.test(job.master_url ?? "")) throw new HttpError(422, "master_url_not_https");
    const img = await providerDeps.fetch(job.master_url!, { redirect: "follow" });
    const ct = img.headers.get("content-type") ?? "";
    if (!img.ok || !ct.startsWith("image/")) throw new HttpError(422, "master_image_unreadable", { status: img.status, content_type: ct.slice(0, 60) });
    const bytes = await img.arrayBuffer();
    if (bytes.byteLength < 1024 || bytes.byteLength > MAX_MASTER_BYTES) throw new HttpError(422, "master_image_bad_size", { bytes: bytes.byteLength });
    fileName = await client.upload(bytes, `${job.character_id}.${ct.includes("png") ? "png" : "jpg"}`);
  } catch (e) {
    await unclaim(); // nothing paid was sent; slot released
    asHttp(e);
  }

  const workflowId = env.RUNNINGHUB_H3_WORKFLOW_ID || DEFAULT_H3_WORKFLOW_ID;
  const nodes = h3NodeInfo(fileName!, spec.prompt, spec.segments[0]);
  let taskId: string;
  try {
    taskId = await client.createTask(workflowId, nodes); // PAID
  } catch (e) {
    // Keep the claim (counts toward the cap): we cannot prove nothing was charged.
    await env.DB.prepare("UPDATE jobs SET provider_task_id = ? WHERE id = ?").bind(`create-failed:${job.id}`, job.id).run();
    await logEv(env, job.id, "provider_create_failed", { error: e instanceof ProviderError ? { code: e.code, detail: e.detail } : String(e), balance_before: balanceBefore! });
    asHttp(e);
  }
  return {
    providerTaskId: taskId!,
    mock: false,
    meta: { provider: "runninghub-h3", workflow_id: workflowId, uploaded_file: fileName!, balance_before: balanceBefore!, submitted_at: new Date().toISOString(), owner_approval: job.live_approval_ref },
  };
}

/**
 * Poll a running live job. On success: download the result (to R2 if bound), record balance after + coins
 * consumed, write the asset, move to QA. On provider failure: fail without auto-retry, release the reservation.
 */
export async function livePoll(env: Env, job: JobRow, deps: {
  transition: (env: Env, job: JobRow, to: any, set?: Record<string, unknown>, detail?: unknown, extra?: (tx: string) => D1PreparedStatement[]) => Promise<JobRow>;
  failOrRetry: (env: Env, job: JobRow, err: string) => Promise<JobRow>;
}): Promise<{ job: JobRow; status: string }> {
  if (job.mode !== "live" || job.state !== "running" || !job.provider_task_id) throw new HttpError(409, "not_a_running_live_job");
  const client = rhClient(env);
  let out;
  try { out = await client.outputs(job.provider_task_id); } catch (e) { asHttp(e); }
  if (out!.status === "running") {
    await logEv(env, job.id, "live_poll", { code: (out as any).code });
    return { job, status: "running" };
  }
  const meta = job.provider_meta_json ? JSON.parse(job.provider_meta_json) : {};
  let balanceAfter: Balance | { error: string };
  try { balanceAfter = await client.accountStatus(); } catch { balanceAfter = { error: "balance_unavailable" }; }
  meta.balance_after = balanceAfter;
  if (out!.status === "failed") {
    meta.provider_failure = (out as any).reason;
    await env.DB.prepare("UPDATE jobs SET provider_meta_json = ? WHERE id = ?").bind(JSON.stringify(meta), job.id).run();
    const fresh = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(job.id).first<JobRow>();
    return { job: await deps.failOrRetry(env, fresh!, `provider_failed:${(out as any).reason}`), status: "failed" };
  }
  const ok = out as Extract<typeof out, { status: "succeeded" }>;
  meta.consume_coins = ok.consumeCoins;
  meta.task_cost_time = ok.taskCostTime;
  if ("remainCoins" in balanceAfter && meta.balance_before?.remainCoins != null)
    meta.balance_delta = meta.balance_before.remainCoins - balanceAfter.remainCoins;
  let r2Key: string | null = null;
  const dl = await providerDeps.fetch(ok.fileUrl);
  if (dl.ok && env.ASSETS_BUCKET) {
    r2Key = `live/${job.id}/${job.provider_task_id}.${ok.fileType || "mp4"}`;
    await env.ASSETS_BUCKET.put(r2Key, dl.body, { httpMetadata: { contentType: "video/mp4" }, customMetadata: { jobId: job.id, taskId: job.provider_task_id } });
  } else if (!dl.ok) meta.download_error = dl.status;
  const coins = ok.consumeCoins ?? job.reserved_credits;
  const now = new Date().toISOString();
  const extra = (tx: string) => [
    env.DB.prepare(`INSERT OR IGNORE INTO assets (id, job_id, step_idx, version, kind, url, provider_task_id, mock, created_at)
      SELECT ?,?,?,?,?,?,?,0,? WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ? AND last_tx = ?)`)
      .bind(crypto.randomUUID(), job.id, 0, job.attempts, "segment", r2Key ? `r2://${r2Key}` : ok.fileUrl, job.provider_task_id, now, job.id, tx),
    env.DB.prepare(`INSERT OR IGNORE INTO costs (id, job_id, kind, credits, scope, paid, batch_token, created_at)
      SELECT ?, ?, 'provider_charge', ?, 'runninghub-coins', 1, ?, ? WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ? AND last_tx = ?)`)
      .bind(crypto.randomUUID(), job.id, coins, tx, now, job.id, tx),
    env.DB.prepare(`UPDATE steps SET state = 'generated', updated_at = ? WHERE job_id = ? AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND last_tx = ?)`)
      .bind(now, job.id, job.id, tx),
  ];
  const next = await deps.transition(env, job, "qa",
    { running_since: null, result_url: ok.fileUrl, result_r2_key: r2Key, provider_meta_json: JSON.stringify(meta) },
    { provider_task_id: job.provider_task_id, consume_coins: ok.consumeCoins, r2_key: r2Key }, extra);
  return { job: next, status: "succeeded" };
}
