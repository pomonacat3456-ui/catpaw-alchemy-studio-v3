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

/** Synthetic ISO-BMFF mp4 header (ftyp + moov/mvhd + trak/tkhd), padded to `size` bytes; enough for probeMp4. */
export function fakeMp4(width: number, height: number, seconds: number, size = 60_000): Uint8Array {
  const box = (type: string, body: Uint8Array) => {
    const b = new Uint8Array(8 + body.length); const dv = new DataView(b.buffer);
    dv.setUint32(0, b.length); for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i); b.set(body, 8); return b;
  };
  const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  const ftyp = box("ftyp", new Uint8Array([105, 115, 111, 109, 0, 0, 2, 0]));
  const mv = new Uint8Array(100); const mdv = new DataView(mv.buffer); mdv.setUint32(12, 1000); mdv.setUint32(16, Math.round(seconds * 1000));
  const tk = new Uint8Array(84); const tdv = new DataView(tk.buffer); tdv.setUint32(76, width * 65536); tdv.setUint32(80, height * 65536);
  const moov = box("moov", cat(box("mvhd", mv), box("trak", box("tkhd", tk))));
  const head = cat(ftyp, moov);
  const mdat = box("mdat", new Uint8Array(Math.max(0, size - head.length - 8)));
  return cat(head, mdat);
}
