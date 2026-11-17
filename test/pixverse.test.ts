import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createJob, enqueue, failOrRetry, getJob, preflight, run, transition } from "../src/jobs";
import { livePoll } from "../src/live";
import { createLiveOverride, syncCanon } from "../src/canon";
import { parseSpec } from "../src/lib/validate";
import { providerDeps } from "../src/providers/runninghub";
import { pixGeneratePayload } from "../src/providers/pixverse";
import { DB, uniq } from "./helpers";

const PKEY = "pix-test-key-SHOULD-NEVER-BE-STORED";
const BASE = "https://pix.example.test/openapi/v2";
const MASTER = "https://images.example.test/canon/PX_T01_master.png";
const realFetch = providerDeps.fetch;
let calls: { url: string; body?: string; headers?: any }[] = [];
let credits = 2070;
let results: any[] = [];
let generateResp: any = { ErrCode: 0, Resp: { video_id: 432658773528999, credits: 35 } };

function mockFetch() {
  providerDeps.fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined, headers: init?.headers });
    const J = (o: unknown) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
    if (url === `${BASE}/account/balance`) return J({ ErrCode: 0, Resp: { credit_monthly: credits, credit_package: 0 } });
    if (url === MASTER) return new Response(new Uint8Array(4096), { headers: { "content-type": "image/png" } });
    if (url === `${BASE}/image/upload`) return J({ ErrCode: 0, Resp: { img_id: 894905555 } });
    if (url === `${BASE}/video/img/generate`) return J(generateResp);
    if (url.startsWith(`${BASE}/video/result/`)) return J(results.shift() ?? { ErrCode: 0, Resp: { status: 5 } });
    if (url === "https://media.pix.example.test/out.mp4") return new Response(new Uint8Array(8192), { headers: { "content-type": "video/mp4" } });
    return new Response("unexpected " + url, { status: 599 });
  }) as typeof fetch;
}
async function pixCount() {
  return (await DB.prepare("SELECT COUNT(*) n FROM jobs WHERE mode='live' AND provider='pixverse' AND provider_task_id IS NOT NULL").first<any>()).n as number;
}
async function prodEnv(over: Record<string, unknown> = {}) {
  return { ...(env as any), ENVIRONMENT: "production", LIVE_PROVIDERS_ENABLED: "true", OWNER_LIVE_APPROVAL_ID: "owner-test-approval",
    PIXVERSE_API_KEY: PKEY, PIXVERSE_BASE_URL: BASE, LIVE_MAX_SUBMISSIONS: String((await pixCount()) + 1), BUDGET_SCOPE: "production-mock", ...over };
}
const LOOK = { name: "測試喵", fur: "white fur", costume: "red robe", weapon: "未確認實體武器；火系術法", magic: "fire magic" };
async function pixQueued(e: any, over: Record<string, unknown> = {}) {
  const spec = parseSpec({ line: "A", mode: "live", provider: "pixverse", protagonist: "PX_T01", master_url: MASTER, segments: [5],
    look: LOOK, prompt: uniq(), ...over });
  let { job } = await createJob(e, spec);
  job = await preflight(e, job);
  if (job.state !== "ready") return job;
  await DB.prepare("UPDATE jobs SET live_approval_ref = 'owner 2026-11-17 13:01 test' WHERE id = ?").bind(job.id).run();
  return enqueue(e, await getJob(e, job.id));
}

beforeEach(async () => {
  calls = []; credits = 2070; results = [];
  generateResp = { ErrCode: 0, Resp: { video_id: 432658773528999, credits: 35 } };
  mockFetch();
  await DB.prepare("UPDATE budgets SET reserved = 0, spent = 0, limit_credits = 2000 WHERE scope = 'production-live'").run();
  await syncCanon(env as any, { sheet_id: "TESTSHEET_1234567890abcdef", rows: [
    { character_id: "PX_T01", name: "測試喵", gender: "母喵", canon_status: "CANON_LOCKED", production_gate: "可製片", master_asset_id: "AST_PX",
      master_url: MASTER, asset_approved: true, master_readable: "公開可讀", sheet_tab: "Master總控", sheet_row: 2 },
    { character_id: "PX_T02", name: "暫停喵", gender: "母喵", canon_status: "CANON_LOCKED", production_gate: "暫停製片", master_url: "https://drive.google.com/file/d/x/view",
      asset_approved: true, master_readable: "私人", sheet_tab: "Master總控", sheet_row: 3 },
  ] });
  await DB.prepare("UPDATE canon_live_overrides SET expires_at = '2000-01-01T00:00:00Z'").run();
});
afterEach(() => { providerDeps.fetch = realFetch; });

describe("PixVerse native live adapter (mocked fetch)", () => {
  it("payload: v6-max 540p, 9:16, audio off, prompt + negative_prompt", () => {
    const p = pixGeneratePayload({ imgId: 7, prompt: "p", negative: "human hands", seconds: 5 });
    expect(p).toEqual({ model: "v6-max", prompt: "p", negative_prompt: "human hands", duration: 5, quality: "540p", img_id: 7, aspect_ratio: "9:16", generate_audio_switch: false });
    expect(() => pixGeneratePayload({ imgId: 7, prompt: " ", seconds: 5 })).toThrow("pixverse_prompt_required");
  });

  it("full path: balance -> upload -> ONE generate -> poll -> R2 + credits + balance delta; key never stored", async () => {
    const e = await prodEnv();
    let job = await pixQueued(e);
    expect(job.state).toBe("queued");
    expect(job.provider).toBe("pixverse");
    expect(job.estimated_credits).toBe(35);
    job = await run(e, job);
    expect(job.state).toBe("running");
    expect(job.provider_task_id).toBe("432658773528999");
    const gen = calls.filter((c) => c.url.endsWith("/video/img/generate"));
    expect(gen).toHaveLength(1);
    const body = JSON.parse(gen[0].body!);
    expect(body.img_id).toBe(894905555);
    expect(body.negative_prompt).toContain("human hands");
    expect(body.prompt).toContain("paw pads");
    expect(gen[0].headers["API-KEY"]).toBe(PKEY);
    expect(calls.findIndex((c) => c.url.endsWith("/account/balance"))).toBeLessThan(calls.findIndex((c) => c.url.endsWith("/video/img/generate")));

    expect((await livePoll(e, job, { transition, failOrRetry })).status).toBe("running");
    credits = 2035;
    results.push({ ErrCode: 0, Resp: { status: 1, url: "https://media.pix.example.test/out.mp4", credits: 35, outputWidth: 592, outputHeight: 1024, seed: 1 } });
    const done = await livePoll(e, await getJob(e, job.id), { transition, failOrRetry });
    expect(done.status).toBe("succeeded");
    expect(done.job.state).toBe("qa");
    expect(done.job.result_r2_key).toBe(`live/${job.id}/432658773528999.mp4`);
    const meta = JSON.parse(done.job.provider_meta_json!);
    expect(meta.balance_before.credits).toBe(2070);
    expect(meta.balance_after.credits).toBe(2035);
    expect(meta.balance_delta).toBe(35);
    expect(meta.credits).toBe(35);
    const charge = await DB.prepare("SELECT * FROM costs WHERE job_id = ? AND kind = 'provider_charge'").bind(job.id).first<any>();
    expect(charge.scope).toBe("pixverse-credits");
    const dump = JSON.stringify(await DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(job.id).first()) +
      JSON.stringify((await DB.prepare("SELECT * FROM events WHERE job_id = ?").bind(job.id).all()).results);
    expect(dump).not.toContain(PKEY);
  });

  it("insufficient PixVerse credits: refused before upload/generate, slot released, nothing paid", async () => {
    const e = await prodEnv();
    const job = await pixQueued(e);
    credits = 10;
    await expect(run(e, job)).rejects.toThrow("provider_balance_insufficient");
    expect(calls.some((c) => c.url.endsWith("/video/img/generate") || c.url.endsWith("/image/upload"))).toBe(false);
    const j = await getJob(e, job.id);
    expect(j.provider_task_id).toBeNull();
    expect(j.paid).toBe(0);
  });

  it("missing PIXVERSE_API_KEY fails closed (no RunningHub substitution)", async () => {
    const e = await prodEnv({ PIXVERSE_API_KEY: undefined, RUNNINGHUB_API_KEY: "rh-key" });
    const job = await pixQueued(e);
    await expect(run(e, job)).rejects.toThrow("provider_key_missing");
    expect(calls.length).toBe(0);
  });

  it("cap is per provider and counts the paid PixVerse submission; generate failure is not retried", async () => {
    const e = await prodEnv();
    const a = await pixQueued(e);
    generateResp = { ErrCode: 500, ErrMsg: `boom ${PKEY}` };
    await expect(run(e, a)).rejects.toThrow("provider_create_failed");
    const ev = JSON.stringify((await DB.prepare("SELECT detail_json FROM events WHERE job_id = ?").bind(a.id).all()).results);
    expect(ev).not.toContain(PKEY);
    const b = await pixQueued(e);
    await expect(run(e, b)).rejects.toThrow("live_submission_cap_reached");
  });

  it("moderation/failed result -> failed, no auto-retry", async () => {
    const e = await prodEnv();
    let job = await pixQueued(e);
    job = await run(e, job);
    results.push({ ErrCode: 0, Resp: { status: 7 } });
    const r = await livePoll(e, job, { transition, failOrRetry });
    expect(r.status).toBe("failed");
    expect(r.job.state).toBe("failed");
  });

  it("single-use override works for PixVerse too and is consumed right before generate", async () => {
    const e = await prodEnv();
    const blocked = await pixQueued(e, { protagonist: "PX_T02" });
    expect(blocked.state).toBe("blocked");
    const { override } = await createLiveOverride(e, { character_id: "PX_T02", master_url: MASTER, approver: "owner 2026-11-17 13:01" });
    const job = await pixQueued(e, { protagonist: "PX_T02" });
    expect(job.state).toBe("queued");
    const ran = await run(e, job);
    expect(ran.state).toBe("running");
    const ov = await DB.prepare("SELECT used_count FROM canon_live_overrides WHERE id = ?").bind(override.id).first<any>();
    expect(ov.used_count).toBe(1);
  });
});
