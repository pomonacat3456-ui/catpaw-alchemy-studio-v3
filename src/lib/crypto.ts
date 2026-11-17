const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable JSON: object keys sorted recursively, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalJson(v === undefined ? null : v)).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Constant-time string comparison (compares digests so length is not leaked). */
export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0 && a.length === b.length;
}

export const CALLBACK_MAX_SKEW_SEC = 300;

/**
 * Callback signature: hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`)),
 * sent as header `x-catpaw-signature: sha256=<hex>` with `x-catpaw-timestamp: <unix seconds>`.
 */
export async function verifyCallbackSignature(
  secret: string | undefined,
  timestamp: string | null,
  signatureHeader: string | null,
  rawBody: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!secret) return { ok: false, reason: "callback_secret_not_configured" };
  if (!timestamp || !/^\d{9,11}$/.test(timestamp)) return { ok: false, reason: "missing_or_bad_timestamp" };
  if (Math.abs(nowSec - Number(timestamp)) > CALLBACK_MAX_SKEW_SEC) return { ok: false, reason: "timestamp_out_of_window" };
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return { ok: false, reason: "missing_signature" };
  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  const ok = await timingSafeEqualStr(signatureHeader.slice(7).toLowerCase(), expected);
  return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
}
