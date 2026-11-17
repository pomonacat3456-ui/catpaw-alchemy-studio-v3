import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createJob, enqueue, failOrRetry, getJob, preflight, run, transition } from "../src/jobs";
import { livePoll } from "../src/live";
import { syncCanon } from "../src/canon";
import { parseSpec } from "../src/lib/validate";
import { autoImageQa, sniffImage } from "../src/lib/image";
import { providerDeps } from "../src/providers/runninghub";
import { DB, uniq } from "./helpers";

const KEY = "rh-test-key-SHOULD-NEVER-BE-STORED";
const MASTER = "https://images.example.test/canon/B_T01_master.png";
const OUT = "https://rh-cdn.example.test/out/still.png";
const realFetch = providerDeps.fetch;
let calls: { url: string; body?: string }[] = [];
let point = 17500;
let outputsSeq: any[] = [];
let outImage: Uint8Array;

function png(w: number, h: number, size = 20000) {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w); dv.setUint32(20, h);
  return b;
}

function mockFetch() {
  providerDeps.fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    const J = (o: unknown) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
    if (url.endsWith("/uc/openapi/accountStatus")) return J({ code: 0, data: { remainCoins: "698", remainPoint: point, remainMoney: "0.0000", currency: "USD", currentTaskCounts: "0", apiType: "NORMAL" } });
    if (url === MASTER) return new Response(new Uint8Array(4096), { headers: { "content-type": "image/png" } });
    if (url.endsWith("/task/openapi/upload")) return J({ code: 0, data: { fileName: "api/uploaded_master.png" } });
    if (url.endsWith("/task/openapi/ai-app/run")) return J({ code: 0, data: { taskId: `21299${Math.floor(Math.random() * 1e12)}` } });
    if (url.endsWith("/task/openapi/outputs")) return J(outputsSeq.shift() ?? { code: 804, msg: "running" });
    if (url === OUT) return new Response(outImage, { headers: { "content-type": "image/png" } });
    return new Response("unexpected " + url, { status: 599 });
  }) as typeof fetch;
}
async function prodEnv(over: Record<string, unknown> = {}) {
  const n = (await DB.prepare("SELECT COUNT(*) n FROM jobs WHERE mode='live' AND provider='runninghub-nb' AND provider_task_id IS NOT NULL").first<any>()).n;
  return { ...(env as any), ENVIRONMENT: "production", LIVE_PROVIDERS_ENABLED: "true", OWNER_LIVE_APPROVAL_ID: "owner-test-approval",
    RUNNINGHUB_API_KEY: KEY, LIVE_MAX_SUBMISSIONS_B: String(n + 1), BUDGET_SCOPE: "production-mock", ...over };
}
const LOOK = { name: "測試喵", fur: "white fur", costume: "red robe", weapon: "未確認實體武器；火系術法", magic: "fire magic" };
async function bQueued(e: any, over: Record<string, unknown> = {}) {
  const spec = parseSpec({ line: "B", mode: "live", protagonist: "B_T01", master_url: MASTER, images: 1, look: LOOK, scene: `stage ${uniq()}`, ...over });
  let { job } = await createJob(e, spec);
  job = await preflight(e, job);
  if (job.state !== "ready") return job;
  await DB.prepare("UPDATE jobs SET live_approval_ref = 'owner 2026-11-17 14:26 test' WHERE id = ?").bind(job.id).run();
  return enqueue(e, await getJob(e, job.id));
}
const done = (url = OUT) => ({ code: 0, data: [{ fileUrl: url, fileType: "png", consumeCoins: null, taskCostTime: "12", settleMode: "POINT", chargedPoint: "6.5" }] });

beforeEach(async () => {
  calls = []; point = 17500; outputsSeq = []; outImage = png(900, 1600);
  mockFetch();
  await DB.prepare("UPDATE budgets SET reserved = 0, spent = 0 WHERE scope = 'production-live-b'").run();
  await syncCanon(env as any, { sheet_id: "TESTSHEET_1234567890abcdef", rows: [
    { character_id: "B_T01", name: "測試喵", gender: "母喵", canon_status: "CANON_LOCKED", production_gate: "可製片", master_asset_id: "AST_B",
      master_url: MASTER, asset_approved: true, master_readable: "公開可讀", sheet_tab: "Master總控", sheet_row: 2 },
  ] });
});
afterEach(() => { providerDeps.fetch = realFetch; });

describe("image sniff / auto QA", () => {
  it("reads PNG/JPEG headers and enforces 9:16 + size", () => {
    expect(sniffImage(png(900, 1600).buffer)).toEqual({ format: "png", width: 900, height: 1600 });
    const jpg = new Uint8Array(20000); jpg.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x06, 0x40, 0x03, 0x84]);
    expect(sniffImage(jpg.buffer)).toEqual({ format: "jpeg", width: 900, height: 1600 });
    expect(autoImageQa(png(900, 1600).buffer).ok).toBe(true);
    expect(autoImageQa(png(1024, 1024).buffer).failed[0]).toMatch(/^aspect_not_9:16/);
    expect(autoImageQa(png(270, 480).buffer).failed[0]).toMatch(/^resolution_too_low/);
    expect(autoImageQa(new Uint8Array(30000).buffer).failed).toContain("not_a_decodable_image");
  });
});

describe("line B live (RunningHub 全能图片V1, mocked)", () => {
  it("submit -> poll -> R2 image -> auto QA -> review; points charged; own budget scope", async () => {
    const e = await prodEnv();
    let job = await bQueued(e);
    expect(job.state).toBe("queued");
    expect(job.provider).toBe("runninghub-nb");
    expect(job.estimated_credits).toBe(20);
    job = await run(e, job);
    expect(job.state).toBe("running");
    const runCall = calls.find((c) => c.url.endsWith("/ai-app/run"))!;
    const body = JSON.parse(runCall.body!);
    expect(body.webappId).toBe("1960491621961953282");
    expect(body.nodeInfoList).toEqual(expect.arrayContaining([{ nodeId: "13", fieldName: "width", fieldValue: "900" }, { nodeId: "13", fieldName: "height", fieldValue: "1600" }]));
    expect(body.nodeInfoList.find((n: any) => n.nodeId === "17").fieldValue).toContain("Keep this exact character");
    point = 17493.5;
    outputsSeq = [done()];
    const r = await livePoll(e, job, { transition, failOrRetry });
    expect(r.status).toBe("succeeded");
    expect(r.job.state).toBe("review");
    expect(r.job.result_r2_key).toMatch(/\.png$/);
    const meta = JSON.parse(r.job.provider_meta_json!);
    expect(meta.charged_point).toBe(6.5);
    expect(meta.point_delta).toBe(6.5);
    expect(meta.auto_qa.ok).toBe(true);
    const c = await DB.prepare("SELECT scope, credits FROM costs WHERE job_id = ? AND kind IN ('provider_charge','reserve') ORDER BY kind").bind(job.id).all<any>();
    expect(c.results).toEqual([{ scope: "runninghub_points", credits: 6.5 }, { scope: "production-live-b", credits: 20 }]);
    const obj = await (env as any).ASSETS_BUCKET.get(r.job.result_r2_key);
    expect(obj.httpMetadata.contentType).toBe("image/png");
    const dump = JSON.stringify(await DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(job.id).first());
    expect(dump).not.toContain(KEY);
  });

  it("wrong aspect output -> auto QA fail -> failed (no paid retry)", async () => {
    const e = await prodEnv();
    let job = await run(e, await bQueued(e));
    outImage = png(1024, 1024);
    outputsSeq = [done()];
    const r = await livePoll(e, job, { transition, failOrRetry });
    expect(r.status).toBe("auto_qa_failed");
    expect(r.job.state).toBe("failed");
    expect(calls.filter((c) => c.url.endsWith("/ai-app/run"))).toHaveLength(1);
  });

  it("line B is closed by default (LIVE_MAX_SUBMISSIONS_B unset) and checks the points balance first", async () => {
    const closed = await prodEnv({ LIVE_MAX_SUBMISSIONS_B: undefined });
    await expect(run(closed, await bQueued(closed))).rejects.toThrow("live_submission_cap_reached");
    const e = await prodEnv();
    point = 5;
    await expect(run(e, await bQueued(e))).rejects.toThrow("provider_balance_insufficient");
    expect(calls.some((c) => c.url.endsWith("/ai-app/run") || c.url.endsWith("/upload"))).toBe(false);
  });

  it("B rejects video providers and multi-image live jobs", async () => {
    expect(() => parseSpec({ line: "B", protagonist: "X", provider: "pixverse" })).toThrow("invalid_provider");
    const e = await prodEnv();
    const j = await bQueued(e, { images: 2 });
    expect(j.state).toBe("blocked");
    expect(JSON.parse(j.blocked_reasons!)).toContain("live_line_B_requires_exactly_one_image");
  });

  it("provider moderation failure reports the readable reason (not [object Object]) and charges nothing", async () => {
    const e = await prodEnv();
    const job = await run(e, await bQueued(e));
    outputsSeq = [{ code: 805, msg: "APIKEY_TASK_STATUS_ERROR", data: { failedReason: { node_name: "RH_Nano_Banana_Image2Image", exception_message: "Image generation failed. content guidelines." } } }];
    const r = await livePoll(e, job, { transition, failOrRetry });
    expect(r.job.state).toBe("failed");
    expect(r.job.last_error).toBe("provider_failed:RH_Nano_Banana_Image2Image: Image generation failed. content guidelines.");
  });
});
