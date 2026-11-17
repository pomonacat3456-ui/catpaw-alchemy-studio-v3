import { HttpError, type Env, type JobRow, type JobSpec, type JobState } from "./types";
import { canonicalJson, sha256Hex } from "./lib/crypto";
import { canTransition, TERMINAL } from "./lib/states";
import { checkCanon, checkFormat, liveAllowed, type CanonRow } from "./lib/validate";
import { estimateCredits } from "./lib/cost";
import { getAdapter, providerForLine } from "./providers";

export const nowIso = () => new Date().toISOString();
const scopeOf = (env: Env) => env.BUDGET_SCOPE || "staging-mock";
const maxAttempts = (env: Env) => Math.max(1, Number(env.MAX_ATTEMPTS || 3));
const maxJobCredits = (env: Env) => Number(env.MAX_JOB_CREDITS || 30);

export async function idempotencyKey(spec: JobSpec): Promise<string> {
  // Stable over key order / cast order; any change of content => new key.
  return sha256Hex(canonicalJson({ v: 1, ...spec, cast: [...spec.cast].sort() }));
}

export function newJobId(line: string): string {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `cpa3-${line}-${d}-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

/** Honest labels attached to every job view. */
export function labels(job: JobRow) {
  return {
    mock: job.mode === "mock",
    paid: false,
    published: false,
    rebuild: "fresh-rebuild-not-zip-restore",
  };
}

export function view(job: JobRow) {
  return {
    ...labels(job),
    jobId: job.id,
    line: job.line,
    mode: job.mode,
    provider: job.provider,
    state: job.state,
    protagonist: job.character_id,
    master_url: job.master_url,
    aspect: job.aspect,
    spec: JSON.parse(job.spec_json),
    idempotency_key: job.idempotency_key,
    credits: { estimated: job.estimated_credits, reserved: job.reserved_credits, spent_mock: job.spent_credits, unit: "mock-credit" },
    attempts: job.attempts,
    max_attempts: job.max_attempts,
    provider_task_id: job.provider_task_id,
    blocked_reasons: job.blocked_reasons ? JSON.parse(job.blocked_reasons) : [],
    qa: job.qa_json ? JSON.parse(job.qa_json) : null,
    last_error: job.last_error,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

export async function getJob(env: Env, id: string): Promise<JobRow> {
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
  if (!job) throw new HttpError(404, "job_not_found");
  return job;
}

function eventStmt(env: Env, jobId: string | null, type: string, from: string | null, to: string | null, detail?: unknown) {
  return env.DB.prepare("INSERT INTO events (job_id, type, from_state, to_state, detail_json, created_at) VALUES (?,?,?,?,?,?)")
    .bind(jobId, type, from, to, detail === undefined ? null : JSON.stringify(detail), nowIso());
}

export async function logEvent(env: Env, jobId: string | null, type: string, detail?: unknown) {
  await eventStmt(env, jobId, type, null, null, detail).run();
}

/** SQL guard: true only if THIS transition (identified by tx token) actually applied. */
export const TX_GUARD = "EXISTS (SELECT 1 FROM jobs WHERE id = ? AND last_tx = ?)";
export type ExtraBuilder = (tx: string) => D1PreparedStatement[];

/**
 * Optimistic, guarded transition in ONE D1 batch (= one transaction):
 *   UPDATE jobs ... SET last_tx = <fresh token> WHERE id = ? AND state = <from>
 * Every side-effect statement (event row, cost ledger, assets) is conditioned on TX_GUARD,
 * so if another request moved the job first nothing else is written and we answer 409.
 */
export async function transition(
  env: Env,
  job: JobRow,
  to: JobState,
  set: Record<string, unknown> = {},
  detail?: unknown,
  extra?: ExtraBuilder,
): Promise<JobRow> {
  if (!canTransition(job.state, to)) throw new HttpError(409, "invalid_transition", { from: job.state, to });
  const tx = crypto.randomUUID();
  const cols = Object.keys(set);
  const sql = `UPDATE jobs SET state = ?, updated_at = ?, last_tx = ?${cols.map((c) => `, ${c} = ?`).join("")} WHERE id = ? AND state = ?`;
  const stmt = env.DB.prepare(sql).bind(to, nowIso(), tx, ...cols.map((c) => set[c] as any), job.id, job.state);
  const ev = env.DB.prepare(
    `INSERT INTO events (job_id, type, from_state, to_state, detail_json, created_at) SELECT ?, 'transition', ?, ?, ?, ? WHERE ${TX_GUARD}`,
  ).bind(job.id, job.state, to, detail === undefined ? null : JSON.stringify(detail), nowIso(), job.id, tx);
  const res = await env.DB.batch([stmt, ...(extra ? extra(tx) : []), ev]);
  if (!res[0].meta.changes) throw new HttpError(409, "concurrent_state_change", { expected: job.state });
  return getJob(env, job.id);
}

export async function createJob(env: Env, spec: JobSpec): Promise<{ job: JobRow; deduplicated: boolean }> {
  const key = await idempotencyKey(spec);
  const id = newJobId(spec.line);
  const now = nowIso();
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO jobs (id, idempotency_key, line, mode, provider, state, character_id, master_url, aspect, spec_json,
       estimated_credits, max_attempts, created_at, updated_at)
     VALUES (?,?,?,?,?,'draft',?,?,?,?,?,?,?,?)`,
  ).bind(id, key, spec.line, spec.mode, providerForLine(spec.line), spec.protagonist, spec.master_url ?? null, spec.aspect,
    JSON.stringify(spec), estimateCredits(spec), maxAttempts(env), now, now).run();
  if (ins.meta.changes) {
    const steps: D1PreparedStatement[] = [];
    const mk = (idx: number, kind: string, dur: number | null) =>
      env.DB.prepare("INSERT INTO steps (id, job_id, idx, kind, duration_sec, state, created_at, updated_at) VALUES (?,?,?,?,?,'pending',?,?)")
        .bind(`${id}-s${idx}`, id, idx, kind, dur, now, now);
    if (spec.line === "B") for (let i = 0; i < spec.images; i++) steps.push(mk(i, "image", null));
    else spec.segments.forEach((s, i) => steps.push(mk(i, "segment", s)));
    if (spec.line === "C") steps.push(mk(spec.segments.length, "music", null));
    steps.push(eventStmt(env, id, "created", null, "draft", { idempotency_key: key, mode: spec.mode }));
    await env.DB.batch(steps.slice(0, 100));
    return { job: await getJob(env, id), deduplicated: false };
  }
  const existing = await env.DB.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").bind(key).first<JobRow>();
  if (!existing) throw new HttpError(500, "idempotency_lookup_failed");
  await logEvent(env, existing.id, "idempotent_replay", { idempotency_key: key });
  return { job: existing, deduplicated: true };
}

export async function loadCanon(env: Env, ids: string[]): Promise<Map<string, CanonRow>> {
  const m = new Map<string, CanonRow>();
  if (!ids.length) return m;
  const rows = await env.DB.prepare(`SELECT * FROM canon_characters WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<CanonRow>();
  for (const r of rows.results) m.set(r.id, r);
  return m;
}

/** draft|blocked -> preflight -> ready|blocked. CANON gate, format/duration, live gate, per-job cost cap. */
export async function preflight(env: Env, job: JobRow): Promise<JobRow> {
  const spec = JSON.parse(job.spec_json) as JobSpec;
  const mid = await transition(env, job, "preflight");
  const reasons = [...checkFormat(spec), ...checkCanon(spec, await loadCanon(env, spec.cast))];
  if (spec.mode === "live") {
    const g = liveAllowed(env);
    if (!g.allowed) reasons.push(`live_blocked:${g.reason}`);
  }
  const est = estimateCredits(spec);
  if (est > maxJobCredits(env)) reasons.push(`cost_estimate_${est}_exceeds_job_cap_${maxJobCredits(env)}`);
  const estimateRow: ExtraBuilder = (tx) => [env.DB.prepare(
    `INSERT OR IGNORE INTO costs (id, job_id, kind, credits, scope, paid, batch_token, created_at) SELECT ?, ?, 'estimate', ?, ?, 0, ?, ? WHERE ${TX_GUARD}`,
  ).bind(crypto.randomUUID(), job.id, est, scopeOf(env), tx, nowIso(), job.id, tx)];
  if (reasons.length) return transition(env, mid, "blocked", { blocked_reasons: JSON.stringify(reasons) }, { reasons }, estimateRow);
  return transition(env, mid, "ready", { blocked_reasons: null, estimated_credits: est }, { estimated_credits: est }, estimateRow);
}

/**
 * ready -> queued with an ATOMIC budget reservation. One D1 batch (= one transaction):
 *  1. insert the job's single 'reserve' cost row only if budget headroom exists and job is ready (UNIQUE(job_id,kind) blocks a 2nd reserve)
 *  2. bump budgets.reserved only if *this* batch's row exists
 *  3. move the job to queued only if *this* batch's row exists
 * The CHECK(reserved+spent<=limit) on budgets is a final backstop.
 */
export async function enqueue(env: Env, job: JobRow): Promise<JobRow> {
  if (job.state !== "ready") throw new HttpError(409, "invalid_transition", { from: job.state, to: "queued" });
  const c = job.estimated_credits;
  const scope = scopeOf(env);
  const tok = crypto.randomUUID();
  const now = nowIso();
  const DB = env.DB;
  await DB.batch([
    DB.prepare(
      `INSERT OR IGNORE INTO costs (id, job_id, kind, credits, scope, paid, batch_token, created_at)
       SELECT ?, ?, 'reserve', ?, ?, 0, ?, ?
       WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ? AND state = 'ready')
         AND EXISTS (SELECT 1 FROM budgets WHERE scope = ? AND limit_credits - reserved - spent >= ?)`,
    ).bind(crypto.randomUUID(), job.id, c, scope, tok, now, job.id, scope, c),
    DB.prepare(
      `UPDATE budgets SET reserved = reserved + ? WHERE scope = ?
       AND EXISTS (SELECT 1 FROM costs WHERE job_id = ? AND kind = 'reserve' AND batch_token = ?)`,
    ).bind(c, scope, job.id, tok),
    DB.prepare(
      `UPDATE jobs SET state = 'queued', reserved_credits = ?, updated_at = ? WHERE id = ? AND state = 'ready'
       AND EXISTS (SELECT 1 FROM costs WHERE job_id = ? AND kind = 'reserve' AND batch_token = ?)`,
    ).bind(c, now, job.id, job.id, tok),
    DB.prepare(
      `INSERT INTO events (job_id, type, from_state, to_state, detail_json, created_at)
       SELECT ?, 'transition', 'ready', 'queued', ?, ? WHERE EXISTS (SELECT 1 FROM costs WHERE job_id = ? AND kind = 'reserve' AND batch_token = ?)`,
    ).bind(job.id, JSON.stringify({ reserved_credits: c, scope }), now, job.id, tok),
  ]);
  const after = await getJob(env, job.id);
  if (after.state === "queued") return after;
  const b = await DB.prepare("SELECT * FROM budgets WHERE scope = ?").bind(scope).first<any>();
  await logEvent(env, job.id, "budget_guard_rejected", { needed: c, budget: b });
  throw new HttpError(402, "budget_guard_rejected", {
    needed: c,
    available: b ? b.limit_credits - b.reserved - b.spent : 0,
    note: "mock credits only; no money involved",
  });
}

function releaseStmts(env: Env, job: JobRow): ExtraBuilder {
  return (tx) => {
    if (!job.reserved_credits) return [];
    const scope = scopeOf(env);
    return [
      env.DB.prepare(
        `INSERT OR IGNORE INTO costs (id, job_id, kind, credits, scope, paid, batch_token, created_at)
         SELECT ?, ?, 'release', ?, ?, 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM costs WHERE job_id = ? AND kind IN ('commit','release')) AND ${TX_GUARD}`,
      ).bind(crypto.randomUUID(), job.id, job.reserved_credits, scope, tx, nowIso(), job.id, job.id, tx),
      env.DB.prepare(
        `UPDATE budgets SET reserved = reserved - ? WHERE scope = ? AND EXISTS (SELECT 1 FROM costs WHERE job_id = ? AND kind='release' AND batch_token = ?)`,
      ).bind(job.reserved_credits, scope, job.id, tx),
    ];
  };
}

/** queued -> running: submit to adapter (mock by default; live adapter fails closed). */
export async function run(env: Env, job: JobRow): Promise<JobRow> {
  if (job.state !== "queued") throw new HttpError(409, "invalid_transition", { from: job.state, to: "running" });
  const attempt = job.attempts + 1;
  const adapter = getAdapter(job, env);
  let sub;
  try {
    sub = await adapter.submit(job, attempt);
  } catch (e) {
    if (e instanceof HttpError) await logEvent(env, job.id, "provider_submit_refused", { code: e.code, detail: e.detail });
    throw e;
  }
  return transition(env, job, "running", { attempts: attempt, provider_task_id: sub.providerTaskId, running_since: nowIso(), last_error: null },
    { provider: adapter.name, mock: sub.mock, provider_task_id: sub.providerTaskId, attempt });
}

/** Failure path shared by provider failure, timeout, QA fail and review rework: retry if attempts left, else fail + release. */
export async function failOrRetry(env: Env, job: JobRow, error: string): Promise<JobRow> {
  if (job.attempts < job.max_attempts) {
    return transition(env, job, "queued", { last_error: error, provider_task_id: null, running_since: null }, { retry: true, error, attempts: job.attempts });
  }
  return transition(env, job, "failed", { last_error: error, reserved_credits: 0, running_since: null }, { retry: false, error, attempts: job.attempts }, releaseStmts(env, job));
}

export async function cancel(env: Env, job: JobRow, reason: string): Promise<JobRow> {
  if (TERMINAL.includes(job.state)) throw new HttpError(409, "invalid_transition", { from: job.state, to: "cancelled" });
  return transition(env, job, "cancelled", { last_error: `cancelled:${reason}`, reserved_credits: 0, running_since: null }, { reason }, releaseStmts(env, job));
}

export interface CallbackPayload {
  event_id: string;
  job_id: string;
  provider_task_id: string;
  status: "succeeded" | "failed";
  outputs?: { step_idx: number; url: string }[];
  error?: string;
}

/** Handles an already signature-verified callback. Dedupes on event_id. */
export async function handleCallback(env: Env, p: CallbackPayload) {
  if (!p || typeof p.event_id !== "string" || !p.event_id || typeof p.job_id !== "string" || typeof p.provider_task_id !== "string" || !["succeeded", "failed"].includes(p.status))
    throw new HttpError(400, "invalid_callback_payload");
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO callback_events (event_id, job_id, provider_task_id, status, received_at) VALUES (?,?,?,?,?)")
    .bind(p.event_id, p.job_id, p.provider_task_id, p.status, nowIso()).run();
  if (!ins.meta.changes) {
    await logEvent(env, p.job_id, "callback_duplicate_ignored", { event_id: p.event_id });
    return { duplicate: true, job: view(await getJob(env, p.job_id)) };
  }
  const job = await getJob(env, p.job_id);
  if (job.state !== "running" || job.provider_task_id !== p.provider_task_id) {
    await logEvent(env, job.id, "callback_stale_ignored", { event_id: p.event_id, state: job.state, provider_task_id: p.provider_task_id });
    throw new HttpError(409, "stale_callback", { state: job.state });
  }
  if (p.status === "failed") return { duplicate: false, job: view(await failOrRetry(env, job, p.error || "provider_failed")) };
  const outputs = Array.isArray(p.outputs) ? p.outputs : [];
  const steps = await env.DB.prepare("SELECT idx, kind FROM steps WHERE job_id = ? ORDER BY idx").bind(job.id).all<{ idx: number; kind: string }>();
  const now = nowIso();
  const extra: ExtraBuilder = (tx) => {
    const out: D1PreparedStatement[] = [];
    for (const s of steps.results) {
      const o = outputs.find((x) => x.step_idx === s.idx);
      const url = o && typeof o.url === "string" ? o.url : `mock://${job.id}/a${job.attempts}/step-${s.idx}`;
      out.push(env.DB.prepare(
        `INSERT OR IGNORE INTO assets (id, job_id, step_idx, version, kind, url, provider_task_id, mock, created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${TX_GUARD}`,
      ).bind(crypto.randomUUID(), job.id, s.idx, job.attempts, s.kind, url, p.provider_task_id, job.mode === "mock" ? 1 : 0, now, job.id, tx));
      out.push(env.DB.prepare(`UPDATE steps SET state = 'generated', updated_at = ? WHERE job_id = ? AND idx = ? AND ${TX_GUARD}`).bind(now, job.id, s.idx, job.id, tx));
    }
    return out;
  };
  return { duplicate: false, job: view(await transition(env, job, "qa", { running_since: null }, { event_id: p.event_id, assets: steps.results.length }, extra)) };
}

export const QA_CHECKS_VIDEO = ["safe_area", "audio", "image_quality", "character_consistency", "tail_frame"];
export const QA_CHECKS_IMAGE = ["safe_area", "image_quality", "character_consistency"];

export async function qa(env: Env, job: JobRow, body: any): Promise<JobRow> {
  if (job.state !== "qa") throw new HttpError(409, "invalid_transition", { from: job.state, to: "review" });
  const required = job.line === "B" ? QA_CHECKS_IMAGE : QA_CHECKS_VIDEO;
  const checks = body?.checks ?? {};
  const missing = required.filter((k) => typeof checks[k] !== "boolean");
  if (missing.length) throw new HttpError(400, "qa_checks_missing", { missing, required });
  const failed = required.filter((k) => checks[k] !== true);
  const rec = { checks, failed, notes: typeof body?.notes === "string" ? body.notes.slice(0, 500) : undefined, at: nowIso() };
  if (failed.length) {
    await env.DB.prepare("UPDATE jobs SET qa_json = ? WHERE id = ?").bind(JSON.stringify(rec), job.id).run();
    return failOrRetry(env, await getJob(env, job.id), `qa_failed:${failed.join(",")}`);
  }
  return transition(env, job, "review", { qa_json: JSON.stringify(rec) }, rec);
}

export async function deliver(env: Env, job: JobRow): Promise<JobRow> {
  if (job.state !== "approved") throw new HttpError(409, "invalid_transition", { from: job.state, to: "delivered" });
  const scope = scopeOf(env);
  const c = job.reserved_credits;
  const commit: ExtraBuilder = (tx) => [
    env.DB.prepare(
      `INSERT OR IGNORE INTO costs (id, job_id, kind, credits, scope, paid, batch_token, created_at)
       SELECT ?, ?, 'commit', ?, ?, 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM costs WHERE job_id = ? AND kind IN ('commit','release')) AND ${TX_GUARD}`,
    ).bind(crypto.randomUUID(), job.id, c, scope, tx, nowIso(), job.id, job.id, tx),
    env.DB.prepare(
      `UPDATE budgets SET reserved = reserved - ?, spent = spent + ? WHERE scope = ? AND EXISTS (SELECT 1 FROM costs WHERE job_id = ? AND kind='commit' AND batch_token = ?)`,
    ).bind(c, c, scope, job.id, tx),
  ];
  // NOTE: delivery never triggers publishing. Publishing is a separate gate (see /publish).
  return transition(env, job, "delivered", { reserved_credits: 0, spent_credits: c }, { committed_mock_credits: c, publish_triggered: false }, commit);
}

/** Timeout sweep: running jobs past RUNNING_TIMEOUT_SEC go through the retry/fail path. */
export async function sweepTimeouts(env: Env, nowMs = Date.now()) {
  const timeoutSec = Number(env.RUNNING_TIMEOUT_SEC || 900);
  const cutoff = new Date(nowMs - timeoutSec * 1000).toISOString();
  const rows = await env.DB.prepare("SELECT * FROM jobs WHERE state = 'running' AND running_since IS NOT NULL AND running_since < ? LIMIT 50").bind(cutoff).all<JobRow>();
  const out: { jobId: string; state: string }[] = [];
  for (const j of rows.results) {
    try {
      const r = await failOrRetry(env, j, "timeout");
      out.push({ jobId: r.id, state: r.state });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
    }
  }
  return out;
}
