import { describe, expect, it } from "vitest";
import { canonicalJson, hmacSha256Hex, sha256Hex, verifyCallbackSignature } from "../src/lib/crypto";
import { canTransition, TRANSITIONS } from "../src/lib/states";
import { checkCanon, checkFormat, liveAllowed, parseSpec } from "../src/lib/validate";
import { estimateCredits } from "../src/lib/cost";
import { idempotencyKey } from "../src/jobs";
import { LiveAdapter, MockAdapter } from "../src/providers";

const canon = new Map([
  ["f", { id: "f", display_name: "F", sex: "female", species: "cat", master_url: "https://x.invalid/f.png", approved: 1, source: "fixture" }],
  ["m", { id: "m", display_name: "M", sex: "male", species: "cat", master_url: "https://x.invalid/m.png", approved: 1, source: "fixture" }],
  ["u", { id: "u", display_name: "U", sex: "female", species: "cat", master_url: "https://x.invalid/u.png", approved: 0, source: "fixture" }],
]);
const base = { line: "A", protagonist: "f", master_url: "https://x.invalid/f.png", segments: [5, 15], prompt: "ok" };

describe("crypto / idempotency", () => {
  it("canonicalJson is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [1, { z: 1, y: 2 }] } })).toBe(canonicalJson({ a: { c: [1, { y: 2, z: 1 }], d: 2 }, b: 1 }));
  });
  it("sha256 matches a known vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("idempotency key is stable across key/cast order and changes with content", async () => {
    const a = await idempotencyKey(parseSpec({ ...base, cast: ["f", "x"] }));
    const b = await idempotencyKey(parseSpec({ prompt: "ok", segments: [5, 15], cast: ["x", "f"], master_url: "https://x.invalid/f.png", protagonist: "f", line: "A" }));
    const c = await idempotencyKey(parseSpec({ ...base, cast: ["f", "x"], prompt: "ok2" }));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
  it("HMAC verification accepts valid and rejects forged/stale/missing", async () => {
    const now = 1_800_000_000;
    const sig = await hmacSha256Hex("s3cret", `${now}.{"a":1}`);
    expect((await verifyCallbackSignature("s3cret", String(now), `sha256=${sig}`, '{"a":1}', now)).ok).toBe(true);
    expect(await verifyCallbackSignature("s3cret", String(now), `sha256=${sig}`, '{"a":2}', now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifyCallbackSignature("wrong", String(now), `sha256=${sig}`, '{"a":1}', now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifyCallbackSignature("s3cret", String(now - 301), `sha256=${sig}`, '{"a":1}', now)).toEqual({ ok: false, reason: "timestamp_out_of_window" });
    expect(await verifyCallbackSignature("s3cret", String(now), null, '{"a":1}', now)).toEqual({ ok: false, reason: "missing_signature" });
    expect(await verifyCallbackSignature(undefined, String(now), `sha256=${sig}`, '{"a":1}', now)).toEqual({ ok: false, reason: "callback_secret_not_configured" });
  });
});

describe("state machine", () => {
  it("follows draft->preflight->blocked/ready->queued->running->qa->review->approved->delivered", () => {
    const path = ["draft", "preflight", "ready", "queued", "running", "qa", "review", "approved", "delivered"] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1])).toBe(true);
    expect(canTransition("preflight", "blocked")).toBe(true);
  });
  it("forbids skipping and leaving terminal states", () => {
    expect(canTransition("draft", "running")).toBe(false);
    expect(canTransition("ready", "delivered")).toBe(false);
    expect(canTransition("qa", "approved")).toBe(false);
    expect(canTransition("blocked", "queued")).toBe(false);
    for (const t of ["delivered", "failed", "cancelled"] as const) expect(TRANSITIONS[t]).toEqual([]);
  });
});

describe("format / duration validation", () => {
  it("accepts only 5s or 15s segments", () => {
    expect(checkFormat(parseSpec({ ...base, segments: [5, 15] }))).toEqual([]);
    expect(checkFormat(parseSpec({ ...base, segments: [10] }))).toContain("invalid_duration_10s_allowed_5_or_15");
    expect(checkFormat(parseSpec({ ...base, segments: [] }))).toContain("line_A_segment_count_1_to_3");
  });
  it("requires 9:16, B images 1-8, C audio", () => {
    expect(checkFormat(parseSpec({ ...base, aspect: "16:9" }))).toContain("aspect_must_be_9:16");
    expect(checkFormat(parseSpec({ ...base, line: "B", segments: [], images: 9 }))).toContain("line_B_images_must_be_1_to_8");
    expect(checkFormat(parseSpec({ ...base, line: "C" }))).toContain("line_C_requires_audio_ref");
  });
  it("rejects malformed input with 400-level errors", () => {
    expect(() => parseSpec({ ...base, line: "E" })).toThrow("invalid_line");
    expect(() => parseSpec({ ...base, protagonist: "" })).toThrow("missing_protagonist");
  });
});

describe("CANON gate (unit)", () => {
  it("passes a compliant female, approved protagonist with exact master URL", () => {
    expect(checkCanon(parseSpec(base), canon as any)).toEqual([]);
  });
  it("rejects unregistered, male, unapproved, missing/wrong master URL and forbidden terms", () => {
    expect(checkCanon(parseSpec({ ...base, protagonist: "nobody" }), canon as any)).toContain("canon_unregistered_character:nobody");
    expect(checkCanon(parseSpec({ ...base, cast: ["m"] }), canon as any)).toContain("canon_all_female_rule_violated:m");
    expect(checkCanon(parseSpec({ ...base, cast: ["u"] }), canon as any)).toContain("canon_character_not_approved:u");
    expect(checkCanon(parseSpec({ ...base, master_url: undefined }), canon as any)).toContain("canon_missing_master_url");
    expect(checkCanon(parseSpec({ ...base, master_url: "https://x.invalid/other.png" }), canon as any)).toContain("canon_master_url_not_the_approved_master");
    expect(checkCanon(parseSpec({ ...base, master_url: "http://x.invalid/f.png" }), canon as any)).toContain("canon_master_url_must_be_https");
    expect(checkCanon(parseSpec({ ...base, prompt: "貓俠舉起人手" }), canon as any)).toContain("canon_forbidden_term:人手");
    expect(checkCanon(parseSpec({ ...base, prompt: "a male cat" }), canon as any)).toContain("canon_forbidden_term:male");
    expect(checkCanon(parseSpec({ ...base, prompt: "a female cat queen, 人類手掌 replaced by paws" }), canon as any)).toEqual([]);
  });
});

describe("cost + provider adapters", () => {
  it("estimates mock credits", () => {
    expect(estimateCredits(parseSpec({ ...base, segments: [5, 15] }))).toBe(4);
    expect(estimateCredits(parseSpec({ ...base, line: "B", segments: [], images: 3 }))).toBe(3);
    expect(estimateCredits(parseSpec({ ...base, line: "C", segments: [15], audio_ref: "a" }))).toBe(5);
  });
  it("live gate is closed outside production / without explicit enable + owner approval", () => {
    expect(liveAllowed({ ENVIRONMENT: "staging", LIVE_PROVIDERS_ENABLED: "true", OWNER_LIVE_APPROVAL_ID: "x" } as any).allowed).toBe(false);
    expect(liveAllowed({ ENVIRONMENT: "production", LIVE_PROVIDERS_ENABLED: "false", OWNER_LIVE_APPROVAL_ID: "x" } as any).allowed).toBe(false);
    expect(liveAllowed({ ENVIRONMENT: "production", LIVE_PROVIDERS_ENABLED: "true" } as any).allowed).toBe(false);
  });
  it("live adapter fails closed (blocked in staging; in production still needs a per-job owner approval)", async () => {
    const job: any = { id: "j", mode: "live", line: "A", provider: "runninghub-h3" };
    await expect(new LiveAdapter("runninghub-h3", { ENVIRONMENT: "staging", LIVE_PROVIDERS_ENABLED: "true", OWNER_LIVE_APPROVAL_ID: "x" } as any).submit(job, 1)).rejects.toThrow("live_provider_blocked");
    await expect(new LiveAdapter("runninghub-h3", { ENVIRONMENT: "production", LIVE_PROVIDERS_ENABLED: "false", OWNER_LIVE_APPROVAL_ID: "x" } as any).submit(job, 1)).rejects.toThrow("live_provider_blocked");
    await expect(new LiveAdapter("runninghub-h3", { ENVIRONMENT: "production", LIVE_PROVIDERS_ENABLED: "true", OWNER_LIVE_APPROVAL_ID: "x" } as any).submit(job, 1)).rejects.toThrow("live_job_not_owner_approved");
  });
  it("mock adapter does no I/O and returns deterministic task id", async () => {
    expect((await new MockAdapter("pixverse").submit({ id: "j1" } as any, 2)).providerTaskId).toBe("mock-pixverse-j1-a2");
  });
});
