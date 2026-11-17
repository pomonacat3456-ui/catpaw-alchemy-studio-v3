import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createJob, enqueue, failOrRetry, getJob, preflight, run, transition } from "../src/jobs";
import { livePoll } from "../src/live";
import { createLiveOverride, syncCanon } from "../src/canon";
import { parseSpec } from "../src/lib/validate";
import { providerDeps } from "../src/providers/runninghub";
import { DB, signedCallback, uniq } from "./helpers";

const KEY = "rh-test-key-SHOULD-NEVER-BE-STORED";
const MASTER = "https://images.example.test/canon/MZ_T01_master.png";
const realFetch = providerDeps.fetch;
let calls: { url: string; body?: string }[] = [];
let balance = "698";
let outputsSeq: any[] = [];

function mockFetch() {
  providerDeps.fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = init?.body && typeof init.body === "string" ? init.body : undefined;
    calls.push({ url, body });
    const J = (o: unknown) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
    if (url.endsWith("/uc/openapi/accountStatus")) return J({ code: 0, data: { remainCoins: balance, remainMoney: "0.0000", currency: "USD", currentTaskCounts: "0" } });
    if (url === MASTER) return new Response(new Uint8Array(4096), { headers: { "content-type": "image/png" } });
    if (url.startsWith("https://drive.google.com/")) return new Response("<html>login</html>", { headers: { "content-type": "text/html" } });
    if (url.endsWith("/task/openapi/upload")) return J({ code: 0, data: { fileName: "api/uploaded_master.png" } });
    if (url.endsWith("/task/openapi/create")) return J({ code: 0, data: { taskId: "2119999999999999999" } });
    if (url.endsWith("/task/openapi/outputs")) return J(outputsSeq.shift() ?? { code: 804, msg: "running" });
    if (url === "https://rh-cdn.example.test/out/video.mp4") return new Response(new Uint8Array(8192), { headers: { "content-type": "video/mp4" } });
    return new Response("unexpected " + url, { status: 599 });
  }) as typeof fetch;
}

async function liveCount() {
  return (await DB.prepare("SELECT COUNT(*) n FROM jobs WHERE mode='live' AND provider_task_id IS NOT NULL").first<any>()).n as number;
}
async function prodEnv(over: Record<string, unknown> = {}) {
  return { ...(env as any), ENVIRONMENT: "production", LIVE_PROVIDERS_ENABLED: "true", OWNER_LIVE_APPROVAL_ID: "owner-test-approval",
    RUNNINGHUB_API_KEY: KEY, LIVE_MAX_SUBMISSIONS: String((await liveCount()) + 1), BUDGET_SCOPE: "production-mock", ...over };
}

async function seedCanon(e: any) {
  return syncCanon(e, {
    sheet_id: "TESTSHEET_1234567890abcdef",
    rows: [
      { character_id: "MZ_T01", name: "測試核准喵", gender: "母喵", canon_status: "CANON_LOCKED", production_gate: "可製片", master_asset_id: "AST_T1",
        master_url: MASTER, asset_approved: true, master_readable: "公開可讀", weapon: "白玉劍", sheet_tab: "Master總控", sheet_row: 2 },
      { character_id: "MZ_T02", name: "暫停喵", gender: "母喵", canon_status: "CANON_LOCKED", production_gate: "暫停製片", master_url: "https://drive.google.com/file/d/x/view",
        asset_approved: true, master_readable: "私人 Drive，無匿名讀取權限", sheet_tab: "Master總控", sheet_row: 3 },
      { character_id: "MZ_T03", name: "私圖喵", gender: "母喵", canon_status: "CANON_LOCKED", production_gate: "可製片", master_url: "https://drive.google.com/file/d/y/view",
        asset_approved: true, master_readable: "公開可讀", sheet_tab: "Master總控", sheet_row: 4 },
    ],
  });
}

async function liveQueued(e: any, over: Record<string, unknown> = {}) {
  const spec = parseSpec({ line: "A", mode: "live", protagonist: "MZ_T01", master_url: MASTER, segments: [5], prompt: `布袋戲偶質感全母喵 ${uniq()}`, ...over });
  let { job } = await createJob(e, spec);
  job = await preflight(e, job);
  if (job.state !== "ready") return job;
  await DB.prepare("UPDATE jobs SET live_approval_ref = 'owner 2026-11-17 test' WHERE id = ?").bind(job.id).run();
  return enqueue(e, await getJob(e, job.id));
}

beforeEach(async () => {
  calls = []; balance = "698"; outputsSeq = [];
  mockFetch();
  await DB.prepare("UPDATE budgets SET reserved = 0, spent = 0 WHERE scope IN ('production-live','production-mock')").run();
  await DB.prepare("UPDATE budgets SET limit_credits = 400 WHERE scope = 'production-live'").run();
  await seedCanon(env);
  await DB.prepare("UPDATE canon_live_overrides SET expires_at = '2000-01-01T00:00:00Z'").run(); // no leftovers between tests
});
afterEach(() => { providerDeps.fetch = realFetch; });

describe("live RunningHub adapter (mocked fetch)", () => {
  it("happy path: balance check -> upload -> ONE create -> poll -> R2 copy -> qa, all recorded, key never stored", async () => {
    const e = await prodEnv();
    let job = await liveQueued(e);
    expect(job.state).toBe("queued");
    expect(job.estimated_credits).toBe(350);
    expect(job.max_attempts).toBe(1);
    job = await run(e, job);
    expect(job.state).toBe("running");
    expect(job.provider_task_id).toBe("2119999999999999999");
    expect(job.paid).toBe(1);
    expect(calls.filter((c) => c.url.endsWith("/task/openapi/create")).length).toBe(1);
    const order = calls.map((c) => c.url.split("/").slice(-1)[0]);
    expect(order.indexOf("accountStatus")).toBeLessThan(order.indexOf("create"));
    const createBody = JSON.parse(calls.find((c) => c.url.endsWith("/create"))!.body!);
    expect(createBody.workflowId).toBe("2114090140428013570");
    expect(createBody.nodeInfoList).toContainEqual({ nodeId: "199", fieldName: "height", fieldValue: "1344" });
    expect(createBody.nodeInfoList).toContainEqual({ nodeId: "197", fieldName: "value", fieldValue: "5" });

    outputsSeq = [{ code: 804, msg: "running" }, { code: 0, data: [{ fileUrl: "https://rh-cdn.example.test/out/video.mp4", fileType: "mp4", consumeCoins: "322", taskCostTime: "284" }] }];
    balance = "698";
    let r = await livePoll(e, job, { transition, failOrRetry });
    expect(r.status).toBe("running");
    balance = "376";
    r = await livePoll(e, await getJob(e, job.id), { transition, failOrRetry });
    expect(r.status).toBe("succeeded");
    expect(r.job.state).toBe("qa");
    const meta = JSON.parse(r.job.provider_meta_json!);
    expect(meta.balance_before.remainCoins).toBe(698);
    expect(meta.balance_after.remainCoins).toBe(376);
    expect(meta.consume_coins).toBe(322);
    expect(meta.balance_delta).toBe(322);
    expect(r.job.result_r2_key).toBe(`live/${job.id}/2119999999999999999.mp4`);
    const obj = await (env as any).ASSETS_BUCKET.get(r.job.result_r2_key);
    expect(obj).not.toBeNull();
    expect((await obj.arrayBuffer()).byteLength).toBe(8192);
    const charge = await DB.prepare("SELECT credits, paid FROM costs WHERE job_id = ? AND kind = 'provider_charge'").bind(job.id).first<any>();
    expect(charge).toEqual({ credits: 322, paid: 1 });
    expect(r.job.published).toBe(0);
    // the provider key must never be persisted anywhere
    for (const t of ["jobs", "events", "costs", "assets"]) {
      const dump = JSON.stringify((await DB.prepare(`SELECT * FROM ${t}`).all()).results);
      expect(dump.includes(KEY)).toBe(false);
    }
  });

  it("global live cap: a second live job is refused before any paid call", async () => {
    const e = await prodEnv();
    await DB.prepare("UPDATE budgets SET limit_credits = 1000 WHERE scope = 'production-live'").run(); // budget is not what stops it
    const first = await liveQueued(e);
    await run(e, first);
    const second = await liveQueued(e);
    calls = [];
    await expect(run(e, second)).rejects.toThrow("live_submission_cap_reached");
    expect(calls.length).toBe(0);
    expect((await getJob(e, second.id)).state).toBe("queued");
  });

  it("insufficient balance: 402, no upload/create, claim released, job stays queued", async () => {
    const e = await prodEnv();
    balance = "100";
    const job = await liveQueued(e);
    await expect(run(e, job)).rejects.toThrow("provider_balance_insufficient");
    expect(calls.some((c) => c.url.endsWith("/create") || c.url.endsWith("/upload"))).toBe(false);
    const j = await getJob(e, job.id);
    expect(j.state).toBe("queued");
    expect(j.provider_task_id).toBeNull();
    expect(j.paid).toBe(0);
  });

  it("unreadable Master image (private Drive HTML) is refused before any paid call", async () => {
    const e = await prodEnv();
    await DB.prepare("UPDATE canon_characters SET master_url = 'https://drive.google.com/file/d/z/view' WHERE id = 'MZ_T01'").run();
    const job = await liveQueued(e, { master_url: "https://drive.google.com/file/d/z/view" });
    await expect(run(e, job)).rejects.toThrow("master_image_unreadable");
    expect(calls.some((c) => c.url.endsWith("/create"))).toBe(false);
    expect((await getJob(e, job.id)).provider_task_id).toBeNull();
  });

  it("provider failure (805) fails the job without auto-retry and releases the reservation", async () => {
    const e = await prodEnv();
    const job = await run(e, await liveQueued(e));
    outputsSeq = [{ code: 805, msg: "failed", data: { failedReason: "node error" } }];
    const r = await livePoll(e, job, { transition, failOrRetry });
    expect(r.job.state).toBe("failed");
    const b = await DB.prepare("SELECT reserved FROM budgets WHERE scope = 'production-live'").first<any>();
    expect(b.reserved).toBe(0);
    expect(calls.filter((c) => c.url.endsWith("/create")).length).toBe(1);
  });

  it("refuses without per-job owner approval, without key, outside production, or when disabled", async () => {
    const e = await prodEnv();
    const spec = parseSpec({ line: "A", mode: "live", protagonist: "MZ_T01", master_url: MASTER, segments: [5], prompt: `p ${uniq()}` });
    let { job } = await createJob(e, spec);
    job = await enqueue(e, await preflight(e, job));
    await expect(run(e, job)).rejects.toThrow("live_job_not_owner_approved");
    await DB.prepare("UPDATE jobs SET live_approval_ref = 'owner ok ref' WHERE id = ?").bind(job.id).run();
    job = await getJob(e, job.id);
    await expect(run({ ...e, RUNNINGHUB_API_KEY: undefined }, job)).rejects.toThrow("provider_key_missing");
    await expect(run({ ...e, ENVIRONMENT: "staging" }, job)).rejects.toThrow("live_provider_blocked");
    await expect(run({ ...e, LIVE_PROVIDERS_ENABLED: "false" }, job)).rejects.toThrow("live_provider_blocked");
    await expect(run({ ...e, OWNER_LIVE_APPROVAL_ID: "" }, job)).rejects.toThrow("live_provider_blocked");
    expect(calls.length).toBe(0);
  });

  it("CANON: live preflight blocks characters whose sheet production gate is closed or Master not readable", async () => {
    const e = await prodEnv();
    const a = await liveQueued(e, { protagonist: "MZ_T02", master_url: "https://drive.google.com/file/d/x/view" });
    expect(a.state).toBe("blocked");
    expect(JSON.parse(a.blocked_reasons!)).toContain("canon_character_not_approved_for_live:MZ_T02");
    const b = await liveQueued(e, { protagonist: "MZ_T03", master_url: "https://drive.google.com/file/d/y/view" });
    expect(b.state).toBe("blocked");
    expect(JSON.parse(b.blocked_reasons!)).toContain("canon_character_not_approved_for_live:MZ_T03");
  });

  it("budget guard: production-live budget (400 coins) fits only one 5s job", async () => {
    const e = await prodEnv();
    await liveQueued(e);
    await expect(liveQueued(e)).rejects.toThrow("budget_guard_rejected");
  });

  it("live is line-A single-segment only and capped at LIVE_MAX_JOB_COINS", async () => {
    const e = await prodEnv();
    const c = await liveQueued(e, { segments: [5, 5] });
    expect(JSON.parse(c.blocked_reasons!)).toContain("live_requires_exactly_one_segment");
    const d = await liveQueued(e, { segments: [15] });
    expect(JSON.parse(d.blocked_reasons!).join()).toContain("exceeds_job_cap_400");
  });

  it("signed HMAC callbacks cannot complete a live job (provider polling only)", async () => {
    const e = await prodEnv();
    const job = await run(e, await liveQueued(e));
    const r = await signedCallback({ event_id: `evt-${uniq()}`, job_id: job.id, provider_task_id: job.provider_task_id, status: "succeeded" });
    expect(r.status).toBe(409);
    expect(r.data.error).toBe("live_jobs_use_provider_polling");
  });

  it("single-job owner override: releases ONE closed-gate character for ONE job, consumed at the paid call", async () => {
    const e = await prodEnv();
    await DB.prepare("UPDATE budgets SET limit_credits = 2000 WHERE scope = 'production-live'").run();
    // MZ_T02 is blocked by the sheet (暫停製片, private Drive)
    const blocked = await liveQueued(e, { protagonist: "MZ_T02", master_url: MASTER });
    expect(blocked.state).toBe("blocked");
    await expect(createLiveOverride(e, { character_id: "MZ_T02", master_url: MASTER, approver: "x" })).rejects.toThrow("approver_required");
    const { override } = await createLiveOverride(e, { character_id: "MZ_T02", master_url: MASTER, approver: "owner 2026-11-17 11:50", reason: "test" });
    await expect(createLiveOverride(e, { character_id: "MZ_T02", master_url: MASTER, approver: "owner again ok" })).rejects.toThrow("an_active_override_already_exists");
    const j1 = await liveQueued(e, { protagonist: "MZ_T02", master_url: MASTER });
    expect(j1.state).toBe("queued");
    // a second job cannot use the override bound to j1
    const j2 = await liveQueued(e, { protagonist: "MZ_T02", master_url: MASTER });
    expect(j2.state).toBe("blocked");
    // other characters remain blocked
    const other = await liveQueued(e, { protagonist: "MZ_T03", master_url: MASTER });
    expect(other.state).toBe("blocked");
    const ran = await run(e, j1);
    expect(ran.state).toBe("running");
    expect(JSON.parse(ran.provider_meta_json!).canon_override.approver).toBe("owner 2026-11-17 11:50");
    const ov = await DB.prepare("SELECT used_count, job_id, consumed_at FROM canon_live_overrides WHERE id = ?").bind(override.id).first<any>();
    expect(ov.used_count).toBe(1);
    expect(ov.job_id).toBe(j1.id);
    expect(ov.consumed_at).toBeTruthy();
  });

  it("override is NOT consumed when a pre-charge step fails (balance), so one retry stays possible", async () => {
    const e = await prodEnv();
    const { override } = await createLiveOverride(e, { character_id: "MZ_T02", master_url: MASTER, approver: "owner 2026-11-17 11:50" });
    const j = await liveQueued(e, { protagonist: "MZ_T02", master_url: MASTER });
    balance = "10";
    await expect(run(e, j)).rejects.toThrow("provider_balance_insufficient");
    const ov = await DB.prepare("SELECT used_count FROM canon_live_overrides WHERE id = ?").bind(override.id).first<any>();
    expect(ov.used_count).toBe(0);
  });

  it("override cannot target a character without a sheet-approved Master", async () => {
    const e = await prodEnv();
    await syncCanon(e, { sheet_id: "TESTSHEET_1234567890abcdef", rows: [{ character_id: "MZ_T09", name: "無圖喵", gender: "母喵", canon_status: "MASTER_FOUND",
      production_gate: "暫停製片", master_url: "", asset_approved: false, master_readable: "", sheet_tab: "t", sheet_row: 9 }] });
    await expect(createLiveOverride(e, { character_id: "MZ_T09", master_url: MASTER, approver: "owner 2026-11-17 11:50" })).rejects.toThrow("character_not_eligible_for_override");
    await seedCanon(env);
  });

  it("own public CANON Master URL is read from R2 (a Worker cannot fetch its own workers.dev host)", async () => {
    const ORIGIN = "https://catpaw-own.example.workers.dev";
    const url = `${ORIGIN}/public/canon/MZ_T02-master.png`;
    await (env as any).ASSETS_BUCKET.put("public/canon/MZ_T02-master.png", new Uint8Array(4096).fill(7), { httpMetadata: { contentType: "image/png" } });
    const e = await prodEnv({ PUBLIC_ORIGIN: ORIGIN });
    await DB.prepare("UPDATE budgets SET limit_credits = 2000 WHERE scope = 'production-live'").run();
    await createLiveOverride(e, { character_id: "MZ_T02", master_url: url, approver: "owner 2026-11-17 11:50" });
    const j = await liveQueued(e, { protagonist: "MZ_T02", master_url: url });
    expect(j.state).toBe("queued");
    const ran = await run(e, j);
    expect(ran.state).toBe("running");
    expect(calls.some((c: any) => String(c.url ?? c).startsWith(ORIGIN))).toBe(false);
  });
});
