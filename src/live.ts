import { HttpError, type Env, type JobRow, type JobSpec } from "./types";
import { LIVE_PROVIDERS_LINE_A, LIVE_PROVIDERS_LINE_B, liveAllowed } from "./lib/validate";
import { autoImageQa } from "./lib/image";
import { PixVerseClient, pixGeneratePayload, type PixBalance } from "./providers/pixverse";
import { DEFAULT_H3_WORKFLOW_ID, DEFAULT_NB_WEBAPP_ID, DEFAULT_QWEN_WEBAPP_ID, IMAGE_TYPES, nbNodeInfo, qwenNodeInfo, ProviderError, RunningHubClient, h3NodeInfo, providerDeps, type Balance } from "./providers/runninghub";

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
export async function providerBalance(env: Env, provider = "runninghub"): Promise<Balance | PixBalance> {
  try { return provider === PIX ? await pixClient(env).balance() : await rhClient(env).accountStatus(); } catch (e) { asHttp(e); }
}

const PIX = "pixverse";

/**
 * RunningHub has TWO prepaid pools on one account (accountStatus):
 *   remainPoint = plan 點數 (NORMAL / consumer-member keys settle workflow tasks here: usage.settleMode "POINT", chargedPoint)
 *   remainCoins = RH幣 (separate pool), remainMoney = wallet (Enterprise-Shared keys only).
 * Observed 2026-11-17: H3 5s task charged 54.23 點數, 0 RH幣, $0.
 * For NORMAL keys the points pool must cover LIVE_POINTS_5S/15S; if the API returns no remainPoint we fail closed
 * unless the owner supplied a manual balance (LIVE_MANUAL_POINTS_BALANCE).
 */
/** Line B image: plan 點數 must cover the per-image estimate (NORMAL key); fail closed when unknown. */
export function rhImageBalanceCheck(env: Env, b: Balance, needed: number) {
  let points = b.remainPoint ?? null, source = "api.remainPoint";
  if (points == null && env.LIVE_MANUAL_POINTS_BALANCE) { points = Number(env.LIVE_MANUAL_POINTS_BALANCE); source = "owner_manual"; }
  if (points == null || !Number.isFinite(points)) return { ok: false, pool: "points", reason: "points_balance_unavailable_owner_must_provide", needed };
  return { ok: points >= needed, pool: "points", remainPoint: points, source, needed, apiType: b.apiType ?? null };
}

export function rhBalanceCheck(env: Env, b: Balance, segments: number[]) {
  const p5 = Number(env.LIVE_POINTS_5S || 60), p15 = Number(env.LIVE_POINTS_15S || 180);
  const neededPoints = segments.reduce((a, s) => a + (s === 15 ? p15 : p5), 0);
  if (b.apiType && b.apiType !== "NORMAL") {
    const neededCoins = segments.reduce((a, s) => a + (s === 15 ? Number(env.LIVE_COINS_15S || 950) : Number(env.LIVE_COINS_5S || 350)), 0);
    return { ok: b.remainCoins >= neededCoins, pool: "coins", remainCoins: b.remainCoins, needed: neededCoins, apiType: b.apiType };
  }
  let points = b.remainPoint ?? null, source = "api.remainPoint";
  if (points == null && env.LIVE_MANUAL_POINTS_BALANCE) { points = Number(env.LIVE_MANUAL_POINTS_BALANCE); source = "owner_manual"; }
  if (points == null || !Number.isFinite(points)) return { ok: false, pool: "points", reason: "points_balance_unavailable_owner_must_provide", needed: neededPoints };
  return { ok: points >= neededPoints, pool: "points", remainPoint: points, source, needed: neededPoints, apiType: b.apiType ?? null };
}

export function pixClient(env: Env): PixVerseClient {
  if (!env.PIXVERSE_API_KEY) throw new HttpError(503, "provider_key_missing", { provider: PIX, note: "PIXVERSE_API_KEY secret not set" });
  return new PixVerseClient(env.PIXVERSE_API_KEY, env.PIXVERSE_BASE_URL || undefined);
}

/** Master bytes: our own public CANON path is read from R2 (a Worker cannot fetch its own workers.dev host). */
async function readMaster(env: Env, job: JobRow): Promise<{ bytes: ArrayBuffer; ct: string }> {
  if (!/^https:\/\//.test(job.master_url ?? "")) throw new HttpError(422, "master_url_not_https");
  const own = env.PUBLIC_ORIGIN ? `${env.PUBLIC_ORIGIN.replace(/\/$/, "")}/public/canon/` : "";
  let ct: string, bytes: ArrayBuffer;
  if (own && job.master_url!.startsWith(own) && /^[A-Za-z0-9_.-]+\.(png|jpe?g|webp)$/.test(job.master_url!.slice(own.length))) {
    const obj = await env.ASSETS_BUCKET?.get(`public/canon/${job.master_url!.slice(own.length)}`);
    ct = obj?.httpMetadata?.contentType ?? "";
    if (!obj || !ct.startsWith("image/")) throw new HttpError(422, "master_image_unreadable", { source: "r2-public", content_type: ct.slice(0, 60) });
    bytes = await obj.arrayBuffer();
  } else {
    const img = await providerDeps.fetch(job.master_url!, { redirect: "follow" });
    ct = img.headers.get("content-type") ?? "";
    if (!img.ok || !ct.startsWith("image/")) throw new HttpError(422, "master_image_unreadable", { status: img.status, content_type: ct.slice(0, 60) });
    bytes = await img.arrayBuffer();
  }
  if (bytes.byteLength < 1024 || bytes.byteLength > MAX_MASTER_BYTES) throw new HttpError(422, "master_image_bad_size", { bytes: bytes.byteLength });
  return { bytes, ct };
}

/**
 * Gate + submit ONE live task (RunningHub H3 workflow, or PixVerse native image-to-video).
 * Called only from run() for mode=live jobs in state queued.
 * Ordering matters: every free check happens before the single paid call.
 */
export async function liveSubmit(env: Env, job: JobRow) {
  const gate = liveAllowed(env);
  if (!gate.allowed) throw new HttpError(403, "live_provider_blocked", { reason: gate.reason, provider: job.provider });
  if (!job.live_approval_ref) throw new HttpError(403, "live_job_not_owner_approved");
  const isB = job.line === "B";
  if (isB ? !LIVE_PROVIDERS_LINE_B.includes(job.provider) : (job.line !== "A" || !LIVE_PROVIDERS_LINE_A.includes(job.provider)))
    throw new HttpError(403, "live_provider_not_wired_for_line", { line: job.line, provider: job.provider });
  const spec = JSON.parse(job.spec_json) as JobSpec;
  const canon = await env.DB.prepare("SELECT * FROM canon_characters WHERE id = ?").bind(job.character_id).first<any>();
  const override = await env.DB.prepare(
    "SELECT * FROM canon_live_overrides WHERE job_id = ? AND character_id = ? AND master_url = ? AND used_count < max_uses AND expires_at > ?",
  ).bind(job.id, job.character_id, job.master_url ?? "", new Date().toISOString()).first<any>();
  const sheetApproved = canon?.approved === 1 && canon.master_url === job.master_url;
  if (!canon || canon.sex !== "female" || canon.source === "staging-fixture" || (!sheetApproved && !override))
    throw new HttpError(403, "canon_not_live_approved", { character: job.character_id });
  const isPix = job.provider === PIX;
  const rh = isPix ? null : rhClient(env);
  const pix = isPix ? pixClient(env) : null;

  // Cap: claim a live submission slot atomically, PER PROVIDER (counts every claim, including failed paid calls).
  // Line B has its own total cap (default 0 = closed until the owner opens a window).
  const cap = Math.max(0, Number((isB ? env.LIVE_MAX_SUBMISSIONS_B : env.LIVE_MAX_SUBMISSIONS) ?? (isB ? 0 : 1)));
  const claimTag = `claim:${job.id}:${crypto.randomUUID()}`;
  const claim = await env.DB.prepare(
    `UPDATE jobs SET provider_task_id = ? WHERE id = ? AND state = 'queued' AND mode = 'live'
       AND (SELECT COUNT(*) FROM jobs WHERE mode = 'live' AND provider_task_id IS NOT NULL
            AND (CASE WHEN ? = 'B' THEN line = 'B' ELSE provider = ? END)) < ?`,
  ).bind(claimTag, job.id, job.line, job.provider, cap).run(); // line B: one total cap across all B providers
  if (!claim.meta.changes) throw new HttpError(403, "live_submission_cap_reached", { cap, provider: job.provider });
  const unclaim = () => env.DB.prepare("UPDATE jobs SET provider_task_id = NULL WHERE id = ? AND provider_task_id = ?").bind(job.id, claimTag).run();

  let balanceBefore: Balance | PixBalance, uploaded: string | number;
  try {
    if (pix) {
      const b = await pix.balance();
      balanceBefore = b;
      if (b.credits < job.estimated_credits) {
        await logEv(env, job.id, "provider_balance_insufficient", { provider: PIX, credits: b.credits, needed: job.estimated_credits });
        throw new HttpError(402, "provider_balance_insufficient", { provider: PIX, credits: b.credits, needed: job.estimated_credits, note: "no top-up attempted" });
      }
    } else {
      const b = await rh!.accountStatus();
      balanceBefore = b;
      const chk = isB ? rhImageBalanceCheck(env, b, job.estimated_credits) : rhBalanceCheck(env, b, spec.segments);
      if (!chk.ok) {
        await logEv(env, job.id, "provider_balance_insufficient", chk);
        throw new HttpError(402, "provider_balance_insufficient", { ...chk, note: "no top-up attempted" });
      }
    }
    const { bytes, ct } = await readMaster(env, job);
    const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
    uploaded = pix ? await pix.upload(bytes, `${job.character_id}.${ext}`, ct) : await rh!.upload(bytes, `${job.character_id}.${ext}`);
  } catch (e) {
    await unclaim(); // nothing paid was sent; slot released
    asHttp(e);
  }

  if (!sheetApproved && override) {
    // Consume the single-use override atomically right before the paid call (auto-expires after use).
    const used = await env.DB.prepare(
      "UPDATE canon_live_overrides SET used_count = used_count + 1, consumed_at = ? WHERE id = ? AND job_id = ? AND used_count < max_uses",
    ).bind(new Date().toISOString(), override.id, job.id).run();
    if (!used.meta.changes) { await unclaim(); throw new HttpError(403, "canon_override_already_used"); }
  }
  const common = { balance_before: balanceBefore!, submitted_at: "", owner_approval: job.live_approval_ref,
    canon_override: override ? { id: override.id, approver: override.approver } : null, prompt_builder: spec.prompt_builder ?? null };
  let taskId: string, extraMeta: Record<string, unknown>;
  try {
    if (pix) {
      const payload = pixGeneratePayload({ imgId: Number(uploaded!), prompt: spec.prompt, negative: spec.negative_prompt, seconds: spec.segments[0],
        model: env.PIXVERSE_MODEL, quality: env.PIXVERSE_QUALITY });
      const g = await pix.generate(payload); // PAID
      taskId = g.videoId;
      const hard = Number(env.LIVE_PIXVERSE_MAX_CREDITS || 60);
      extraMeta = { provider: PIX, model: payload.model, quality: payload.quality, duration: payload.duration, img_id: payload.img_id,
        credits_reported_at_submit: g.credits, credits_over_hard_cap: g.credits != null && g.credits > hard };
      if (g.credits != null && g.credits > hard) await logEv(env, job.id, "provider_credits_over_hard_cap", { credits: g.credits, hard_cap: hard });
    } else if (isB && job.provider === "runninghub-qwen") {
      const webappId = env.RUNNINGHUB_QWEN_WEBAPP_ID || DEFAULT_QWEN_WEBAPP_ID;
      taskId = await rh!.runApp(webappId, qwenNodeInfo(String(uploaded!), spec.prompt)); // PAID
      extraMeta = { provider: "runninghub-qwen", webapp_id: webappId, uploaded_file: uploaded!, size: "same_as_master" };
    } else if (isB) {
      const webappId = env.RUNNINGHUB_NB_WEBAPP_ID || DEFAULT_NB_WEBAPP_ID;
      taskId = await rh!.runApp(webappId, nbNodeInfo(String(uploaded!), spec.prompt)); // PAID
      extraMeta = { provider: "runninghub-nb", webapp_id: webappId, uploaded_file: uploaded!, size: "900x1600" };
    } else {
      const workflowId = env.RUNNINGHUB_H3_WORKFLOW_ID || DEFAULT_H3_WORKFLOW_ID;
      taskId = await rh!.createTask(workflowId, h3NodeInfo(String(uploaded!), spec.prompt, spec.segments[0])); // PAID
      extraMeta = { provider: "runninghub-h3", workflow_id: workflowId, uploaded_file: uploaded! };
    }
  } catch (e) {
    // Keep the claim (counts toward the cap): we cannot prove nothing was charged.
    await env.DB.prepare("UPDATE jobs SET provider_task_id = ? WHERE id = ?").bind(`create-failed:${job.id}`, job.id).run();
    await logEv(env, job.id, "provider_create_failed", { provider: job.provider, error: e instanceof ProviderError ? { code: e.code, detail: e.detail } : String(e), balance_before: balanceBefore! });
    asHttp(e);
  }
  return { providerTaskId: taskId!, mock: false, meta: { ...extraMeta!, ...common, submitted_at: new Date().toISOString() } };
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
  if (job.provider === PIX) return pixPoll(env, job, deps);
  const client = rhClient(env);
  const isB = job.line === "B";
  let out;
  try { out = await client.outputs(job.provider_task_id, isB ? IMAGE_TYPES : undefined); } catch (e) { asHttp(e); }
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
  meta.settle_mode = ok.settleMode ?? null; // "POINT" = charged to the plan 點數 pool, not RH幣
  meta.charged_point = ok.chargedPoint ?? null;
  meta.consume_money = ok.consumeMoney ?? null;
  if ("remainCoins" in balanceAfter && meta.balance_before?.remainCoins != null)
    meta.balance_delta = meta.balance_before.remainCoins - balanceAfter.remainCoins;
  if ("remainCoins" in balanceAfter && balanceAfter.remainPoint != null && meta.balance_before?.remainPoint != null)
    meta.point_delta = Math.round((meta.balance_before.remainPoint - balanceAfter.remainPoint) * 100) / 100;
  let r2Key: string | null = null;
  let autoQa: ReturnType<typeof autoImageQa> | null = null;
  const dl = await providerDeps.fetch(ok.fileUrl);
  if (!dl.ok) meta.download_error = dl.status;
  else if (isB) {
    // Line B: buffer the still, run the automated technical QA, store with its real content type.
    const buf = await dl.arrayBuffer();
    autoQa = autoImageQa(buf);
    meta.auto_qa = { ok: autoQa.ok, failed: autoQa.failed, info: autoQa.info, bytes: autoQa.bytes };
    if (env.ASSETS_BUCKET) {
      const ext = autoQa.info?.format === "jpeg" ? "jpg" : autoQa.info?.format ?? (ok.fileType || "png");
      r2Key = `live/${job.id}/${job.provider_task_id}.${ext}`;
      await env.ASSETS_BUCKET.put(r2Key, buf, { httpMetadata: { contentType: `image/${autoQa.info?.format ?? "png"}` }, customMetadata: { jobId: job.id, taskId: job.provider_task_id } });
    }
  } else if (env.ASSETS_BUCKET) {
    r2Key = `live/${job.id}/${job.provider_task_id}.${ok.fileType || "mp4"}`;
    await env.ASSETS_BUCKET.put(r2Key, dl.body, { httpMetadata: { contentType: "video/mp4" }, customMetadata: { jobId: job.id, taskId: job.provider_task_id } });
  }
  // POINT settlement: record the exact 點數 charged (REAL) under runninghub_points; else RH幣 coins.
  const isPoint = ok.settleMode === "POINT";
  const coins = isPoint ? (ok.chargedPoint ?? meta.point_delta ?? job.reserved_credits) : (ok.consumeCoins ?? job.reserved_credits);
  const chargeScope = isPoint ? "runninghub_points" : "runninghub-coins";
  const now = new Date().toISOString();
  const extra = (tx: string) => [
    env.DB.prepare(`INSERT OR IGNORE INTO assets (id, job_id, step_idx, version, kind, url, provider_task_id, mock, created_at)
      SELECT ?,?,?,?,?,?,?,0,? WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ? AND last_tx = ?)`)
      .bind(crypto.randomUUID(), job.id, 0, job.attempts, isB ? "image" : "segment", r2Key ? `r2://${r2Key}` : ok.fileUrl, job.provider_task_id, now, job.id, tx),
    env.DB.prepare(`INSERT OR IGNORE INTO costs (id, job_id, kind, credits, scope, paid, batch_token, created_at)
      SELECT ?, ?, 'provider_charge', ?, ?, 1, ?, ? WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ? AND last_tx = ?)`)
      .bind(crypto.randomUUID(), job.id, coins, chargeScope, tx, now, job.id, tx),
    env.DB.prepare(`UPDATE steps SET state = 'generated', updated_at = ? WHERE job_id = ? AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND last_tx = ?)`)
      .bind(now, job.id, job.id, tx),
  ];
  const next = await deps.transition(env, job, "qa",
    { running_since: null, result_url: ok.fileUrl, result_r2_key: r2Key, provider_meta_json: JSON.stringify(meta) },
    { provider_task_id: job.provider_task_id, consume_coins: ok.consumeCoins, r2_key: r2Key }, extra);
  if (isB) {
    // Automated QA (owner accepts MZ_003 content as-is): technical checks only; pass -> review, fail -> failed (no paid retry).
    const failed = !r2Key ? ["not_stored"] : autoQa ? autoQa.failed : ["download_failed"];
    const rec = { auto: true, checks: { file_ok: !failed.some((f) => /decodable|small|download|stored/.test(f)), size_ok: !failed.some((f) => f.startsWith("resolution")),
      aspect_ok: !failed.some((f) => f.startsWith("aspect")), provider_ok: true }, failed, info: autoQa?.info ?? null,
      notes: "auto technical QA; content accepted by owner 2026-11-17 14:23/14:26 for MZ_003", at: now };
    if (failed.length) {
      await env.DB.prepare("UPDATE jobs SET qa_json = ? WHERE id = ?").bind(JSON.stringify(rec), job.id).run();
      const fresh = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(job.id).first<JobRow>();
      return { job: await deps.failOrRetry(env, fresh!, `auto_qa_failed:${failed.join(",")}`), status: "auto_qa_failed" };
    }
    return { job: await deps.transition(env, next, "review", { qa_json: JSON.stringify(rec) }, rec), status: "succeeded" };
  }
  return { job: next, status: "succeeded" };
}

type PollDeps = Parameters<typeof livePoll>[2];

async function pixPoll(env: Env, job: JobRow, deps: PollDeps): Promise<{ job: JobRow; status: string }> {
  const pix = pixClient(env);
  let out;
  try { out = await pix.result(job.provider_task_id!); } catch (e) { asHttp(e); }
  if (out!.status === "running") {
    await logEv(env, job.id, "live_poll", { provider: PIX, code: (out as any).code });
    return { job, status: "running" };
  }
  const meta = job.provider_meta_json ? JSON.parse(job.provider_meta_json) : {};
  let after: PixBalance | { error: string };
  try { after = await pix.balance(); } catch { after = { error: "balance_unavailable" }; }
  meta.balance_after = after;
  if ("credits" in after && meta.balance_before?.credits != null) meta.balance_delta = meta.balance_before.credits - after.credits;
  if (out!.status === "failed") {
    meta.provider_failure = (out as any).reason;
    await env.DB.prepare("UPDATE jobs SET provider_meta_json = ? WHERE id = ?").bind(JSON.stringify(meta), job.id).run();
    const fresh = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(job.id).first<JobRow>();
    return { job: await deps.failOrRetry(env, fresh!, `provider_failed:${(out as any).reason}`), status: "failed" };
  }
  const ok = out as Extract<typeof out, { status: "succeeded" }>;
  meta.credits = ok.credits ?? meta.credits_reported_at_submit ?? null;
  meta.output = { width: ok.width, height: ok.height, seed: ok.seed };
  let r2Key: string | null = null;
  const dl = await providerDeps.fetch(ok.fileUrl);
  if (dl.ok && env.ASSETS_BUCKET) {
    r2Key = `live/${job.id}/${job.provider_task_id}.mp4`;
    await env.ASSETS_BUCKET.put(r2Key, dl.body, { httpMetadata: { contentType: "video/mp4" }, customMetadata: { jobId: job.id, taskId: job.provider_task_id!, provider: PIX } });
  } else if (!dl.ok) meta.download_error = dl.status;
  const credits = meta.credits ?? meta.balance_delta ?? job.reserved_credits;
  const now = new Date().toISOString();
  const extra = (tx: string) => [
    env.DB.prepare(`INSERT OR IGNORE INTO assets (id, job_id, step_idx, version, kind, url, provider_task_id, mock, created_at)
      SELECT ?,?,?,?,?,?,?,0,? WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ? AND last_tx = ?)`)
      .bind(crypto.randomUUID(), job.id, 0, job.attempts, "segment", r2Key ? `r2://${r2Key}` : ok.fileUrl, job.provider_task_id, now, job.id, tx),
    env.DB.prepare(`INSERT OR IGNORE INTO costs (id, job_id, kind, credits, scope, paid, batch_token, created_at)
      SELECT ?, ?, 'provider_charge', ?, 'pixverse-credits', 1, ?, ? WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ? AND last_tx = ?)`)
      .bind(crypto.randomUUID(), job.id, credits, tx, now, job.id, tx),
    env.DB.prepare(`UPDATE steps SET state = 'generated', updated_at = ? WHERE job_id = ? AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND last_tx = ?)`)
      .bind(now, job.id, job.id, tx),
  ];
  const next = await deps.transition(env, job, "qa",
    { running_since: null, result_url: ok.fileUrl, result_r2_key: r2Key, provider_meta_json: JSON.stringify(meta) },
    { provider: PIX, provider_task_id: job.provider_task_id, credits: meta.credits, r2_key: r2Key }, extra);
  return { job: next, status: "succeeded" };
}
