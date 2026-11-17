import { HttpError, type Env, type JobRow } from "./types";
import { hmacSha256Hex, timingSafeEqualStr, verifyCallbackSignature } from "./lib/crypto";
import { LINES, parseSpec } from "./lib/validate";
import { TRANSITIONS } from "./lib/states";
import {
  cancel, createJob, deliver, enqueue, failOrRetry, getJob, handleCallback, logEvent, preflight, qa, run, sweepTimeouts,
  transition, view, type CallbackPayload,
} from "./jobs";

export const VERSION = "3.0.0-rebuild.1";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-catpaw-mock": "true" },
  });

async function requireAdmin(req: Request, env: Env) {
  if (!env.ADMIN_KEY) throw new HttpError(503, "admin_key_not_configured"); // fail closed
  const got = req.headers.get("x-admin-key") ?? "";
  if (!(await timingSafeEqualStr(got, env.ADMIN_KEY))) throw new HttpError(401, "unauthorized");
}

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "invalid_json_body");
  }
}

async function jobDetail(env: Env, job: JobRow) {
  const [steps, assets, events, costs] = await Promise.all([
    env.DB.prepare("SELECT idx, kind, duration_sec, state FROM steps WHERE job_id = ? ORDER BY idx").bind(job.id).all(),
    env.DB.prepare("SELECT step_idx, version, kind, url, provider_task_id, mock, created_at FROM assets WHERE job_id = ? ORDER BY version, step_idx").bind(job.id).all(),
    env.DB.prepare("SELECT id, type, from_state, to_state, detail_json, created_at FROM events WHERE job_id = ? ORDER BY id").bind(job.id).all(),
    env.DB.prepare("SELECT kind, credits, scope, paid, created_at FROM costs WHERE job_id = ? ORDER BY created_at").bind(job.id).all(),
  ]);
  return { ...view(job), next_states: TRANSITIONS[job.state], steps: steps.results, assets: assets.results, events: events.results, costs: costs.results };
}

async function health(env: Env) {
  let d1 = "error";
  let schema: string | null = null;
  try {
    const r = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first<{ name: string }>().catch(() => null);
    schema = r?.name ?? null;
    await env.DB.prepare("SELECT 1").first();
    d1 = "ok";
  } catch {}
  return json({
    ok: d1 === "ok",
    service: "catpaw-alchemy-studio-v3",
    version: VERSION,
    environment: env.ENVIRONMENT,
    rebuild: "fresh-rebuild-not-zip-restore",
    d1,
    schema_version: schema,
    mock: true,
    paid: false,
    published: false,
    live_providers: false,
    publish_gate: "closed",
    secrets_configured: { admin_key: !!env.ADMIN_KEY, callback_hmac: !!env.CALLBACK_HMAC_SECRET },
    time: new Date().toISOString(),
  }, d1 === "ok" ? 200 : 503);
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const m = req.method;

  if (p === "/health" && m === "GET") return health(env);

  // Provider callbacks: authenticated by HMAC signature, not by admin key.
  const cb = p.match(/^\/api\/callbacks\/([a-z0-9-]+)$/);
  if (cb && m === "POST") {
    const raw = await req.text();
    const v = await verifyCallbackSignature(env.CALLBACK_HMAC_SECRET, req.headers.get("x-catpaw-timestamp"), req.headers.get("x-catpaw-signature"), raw);
    if (!v.ok) {
      await logEvent(env, null, "callback_rejected", { provider: cb[1], reason: v.reason });
      throw new HttpError(401, "callback_signature_rejected", { reason: v.reason });
    }
    let payload: CallbackPayload;
    try { payload = JSON.parse(raw); } catch { throw new HttpError(400, "invalid_json_body"); }
    return json(await handleCallback(env, payload));
  }

  if (!p.startsWith("/api/")) throw new HttpError(404, "not_found");
  await requireAdmin(req, env);

  if (p === "/api/meta" && m === "GET")
    return json({ version: VERSION, environment: env.ENVIRONMENT, lines: LINES, states: TRANSITIONS, mock: true, paid: false, published: false, rebuild: "fresh-rebuild-not-zip-restore" });
  if (p === "/api/budget" && m === "GET")
    return json({ unit: "mock-credit", paid: false, budgets: (await env.DB.prepare("SELECT * FROM budgets").all()).results });
  if (p === "/api/canon" && m === "GET")
    return json({ note: "staging fixtures, not the real CANON Sheet v3", characters: (await env.DB.prepare("SELECT * FROM canon_characters ORDER BY id").all()).results });
  if (p === "/api/admin/sweep" && m === "POST") return json({ swept: await sweepTimeouts(env) });

  if (p === "/api/jobs" && m === "GET") {
    const line = url.searchParams.get("line");
    const q = line
      ? env.DB.prepare("SELECT * FROM jobs WHERE line = ? ORDER BY created_at DESC LIMIT 50").bind(line)
      : env.DB.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50");
    return json({ jobs: (await q.all<JobRow>()).results.map(view) });
  }
  if (p === "/api/jobs" && m === "POST") {
    const body = await readJson(req);
    const hdr = req.headers.get("idempotency-key");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_json_body");
    if (hdr && !body.client_ref) body.client_ref = hdr.slice(0, 200);
    const spec = parseSpec(body);
    const { job, deduplicated } = await createJob(env, spec);
    let j = job;
    if (!deduplicated && body.auto_preflight === true) j = await preflight(env, job);
    return json({ deduplicated, job: await jobDetail(env, j) }, deduplicated ? 200 : 201);
  }

  const jm = p.match(/^\/api\/jobs\/([A-Za-z0-9-]+)(?:\/([a-z-]+(?:\/[a-z-]+)?))?$/);
  if (!jm) throw new HttpError(404, "not_found");
  const job = await getJob(env, jm[1]);
  const action = jm[2];
  if (!action && m === "GET") return json(await jobDetail(env, job));
  if (m !== "POST") throw new HttpError(405, "method_not_allowed");
  const body: any = req.headers.get("content-type")?.includes("json") ? await readJson(req) : {};

  let out: JobRow;
  switch (action) {
    case "preflight": out = await preflight(env, job); break;
    case "enqueue": out = await enqueue(env, job); break;
    case "run": out = await run(env, job); break;
    case "qa": out = await qa(env, job, body); break;
    case "approve":
      if (job.state !== "review") throw new HttpError(409, "invalid_transition", { from: job.state, to: "approved" });
      out = await transition(env, job, "approved", {}, { by: "admin", note: body?.note });
      break;
    case "reject":
      if (job.state !== "review") throw new HttpError(409, "invalid_transition", { from: job.state, to: "queued" });
      out = await failOrRetry(env, job, `review_rejected:${String(body?.reason ?? "").slice(0, 200)}`);
      break;
    case "deliver": out = await deliver(env, job); break;
    case "cancel": out = await cancel(env, job, String(body?.reason ?? "admin_cancel").slice(0, 200)); break;
    case "publish": {
      // Separate publish gate. This build ships no publisher; generation success never publishes.
      await logEvent(env, job.id, "publish_blocked", { state: job.state, gate_env: env.PUBLISH_GATE_ENABLED ?? "unset" });
      throw new HttpError(403, "publish_blocked", {
        reason: "publish gate is separate from generation and closed in this build; owner approval of a named draft required",
        published: false,
      });
    }
    case "mock/callback": {
      // Convenience for the staging console: server-side signs a MOCK callback and sends it through the same verifier.
      if (job.mode !== "mock") throw new HttpError(403, "mock_callback_only_for_mock_jobs");
      if (!env.CALLBACK_HMAC_SECRET) throw new HttpError(503, "callback_secret_not_configured");
      const payload = JSON.stringify({
        event_id: `mock-evt-${crypto.randomUUID()}`, job_id: job.id, provider_task_id: job.provider_task_id ?? "",
        status: body?.status === "failed" ? "failed" : "succeeded", error: body?.status === "failed" ? "mock_failure" : undefined,
      });
      const ts = String(Math.floor(Date.now() / 1000));
      const v = await verifyCallbackSignature(env.CALLBACK_HMAC_SECRET, ts, `sha256=${await hmacSha256Hex(env.CALLBACK_HMAC_SECRET, `${ts}.${payload}`)}`, payload);
      if (!v.ok) throw new HttpError(500, "self_sign_failed");
      const r = await handleCallback(env, JSON.parse(payload));
      return json(r);
    }
    default: throw new HttpError(404, "unknown_action");
  }
  return json({ job: await jobDetail(env, out) });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ ok: false, error: e.code, detail: e.detail ?? null, mock: true, paid: false, published: false }, e.status);
      console.error("unhandled", e);
      return json({ ok: false, error: "internal_error" }, 500);
    }
  },
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sweepTimeouts(env).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
