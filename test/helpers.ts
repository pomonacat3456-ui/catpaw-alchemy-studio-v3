import { env, exports } from "cloudflare:workers";
import { hmacSha256Hex } from "../src/lib/crypto";

export const ADMIN = "test-admin-key";
export const SECRET = "test-callback-secret";
export const DB = (env as any).DB as D1Database;
export const MASTER = {
  "fixture-fulan": "https://canon-fixtures.invalid/master/fixture-fulan-v1.png",
  "fixture-liuli": "https://canon-fixtures.invalid/master/fixture-liuli-v1.png",
};

let n = 0;
export const uniq = (p = "t") => `${p}-${Date.now()}-${++n}-${Math.random().toString(36).slice(2, 8)}`;

export async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await (exports as any).default.fetch(
    new Request(`https://staging.test${path}`, {
      method,
      headers: { "x-admin-key": ADMIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status as number, data };
}

export function spec(line: "A" | "B" | "C" | "D", over: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    line,
    mode: "mock",
    protagonist: "fixture-fulan",
    cast: ["fixture-fulan"],
    master_url: MASTER["fixture-fulan"],
    prompt: `測試 ${uniq(line)}`,
  };
  if (line === "A") base.segments = [5, 15];
  if (line === "B") base.images = 3;
  if (line === "C") { base.segments = [15, 15]; base.audio_ref = "mock://audio/theme.wav"; }
  if (line === "D") base.segments = [15, 15, 5];
  return { ...base, ...over };
}

export async function signedCallback(payload: unknown, opts: { secret?: string; ts?: number; tamper?: boolean } = {}) {
  const raw = JSON.stringify(payload);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = await hmacSha256Hex(opts.secret ?? SECRET, `${ts}.${raw}`);
  const body = opts.tamper ? raw.replace("succeeded", "failed") : raw;
  const res = await (exports as any).default.fetch(
    new Request("https://staging.test/api/callbacks/runninghub-h3", {
      method: "POST",
      headers: { "content-type": "application/json", "x-catpaw-timestamp": ts, "x-catpaw-signature": `sha256=${sig}` },
      body,
    }),
  );
  return { status: res.status, data: (await res.json()) as any };
}

export async function createReady(line: "A" | "B" | "C" | "D", over: Record<string, unknown> = {}) {
  const c = await api("POST", "/api/jobs", spec(line, over));
  const id = c.data.job.jobId as string;
  const p = await api("POST", `/api/jobs/${id}/preflight`);
  return { id, preflight: p };
}

export async function toRunning(line: "A" | "B" | "C" | "D", over: Record<string, unknown> = {}) {
  const { id, preflight } = await createReady(line, over);
  if (preflight.data.job?.state !== "ready") throw new Error("not ready: " + JSON.stringify(preflight.data));
  const q = await api("POST", `/api/jobs/${id}/enqueue`);
  if (q.status !== 200) throw new Error("enqueue failed " + JSON.stringify(q.data));
  const r = await api("POST", `/api/jobs/${id}/run`);
  return { id, job: r.data.job };
}

export const allPass = (line: string) =>
  line === "B"
    ? { safe_area: true, image_quality: true, character_consistency: true }
    : { safe_area: true, audio: true, image_quality: true, character_consistency: true, tail_frame: true };

export async function resetBudget(limit = 200) {
  await DB.prepare("UPDATE budgets SET limit_credits = ?, reserved = 0, spent = 0 WHERE scope = 'staging-mock'").bind(limit).run();
}
