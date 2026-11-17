import { beforeEach, describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { DB, MASTER, allPass, api, createReady, resetBudget, signedCallback, spec, toRunning } from "./helpers";
import { cancel, deliver, getJob, sweepTimeouts } from "../src/jobs";
import { env } from "cloudflare:workers";

beforeEach(async () => { await resetBudget(200); });

const cbFor = (job: any, status = "succeeded", event_id = `evt-${crypto.randomUUID()}`) =>
  ({ event_id, job_id: job.jobId, provider_task_id: job.provider_task_id, status, outputs: [{ step_idx: 0, url: "mock://out/0.mp4" }] });

describe("health & auth", () => {
  it("/health is public and honest about mock/paid/published", async () => {
    const r = await (exports as any).default.fetch("https://staging.test/health");
    const d: any = await r.json();
    expect(r.status).toBe(200);
    expect(d).toMatchObject({ ok: true, d1: "ok", mock: true, paid: false, published: false, live_providers: false, rebuild: "fresh-rebuild-not-zip-restore" });
    expect(d.schema_version).toBe("0005_line_b_live_budget.sql");
  });
  it("API requires the admin key", async () => {
    expect((await api("GET", "/api/jobs", undefined, { "x-admin-key": "wrong" })).status).toBe(401);
    expect((await api("GET", "/api/jobs")).status).toBe(200);
  });
});

describe("full mock flow on all four lines", () => {
  for (const line of ["A", "B", "C", "D"] as const) {
    it(`line ${line}: draft -> ... -> delivered, labelled mock/paid:false/published:false`, async () => {
      const c = await api("POST", "/api/jobs", spec(line));
      expect(c.status).toBe(201);
      const id = c.data.job.jobId;
      expect(id).toMatch(new RegExp(`^cpa3-${line}-\\d{8}-[0-9a-f]{10}$`));
      expect(c.data.job).toMatchObject({ state: "draft", mock: true, paid: false, published: false });
      expect((await api("POST", `/api/jobs/${id}/preflight`)).data.job.state).toBe("ready");
      expect((await api("POST", `/api/jobs/${id}/enqueue`)).data.job.state).toBe("queued");
      const run = await api("POST", `/api/jobs/${id}/run`);
      expect(run.data.job.state).toBe("running");
      expect(run.data.job.provider_task_id).toMatch(/^mock-/);
      const cb = await signedCallback(cbFor(run.data.job));
      expect(cb.status).toBe(200);
      expect(cb.data.job.state).toBe("qa");
      expect((await api("POST", `/api/jobs/${id}/qa`, { checks: allPass(line) })).data.job.state).toBe("review");
      expect((await api("POST", `/api/jobs/${id}/approve`, {})).data.job.state).toBe("approved");
      const d = await api("POST", `/api/jobs/${id}/deliver`);
      expect(d.data.job).toMatchObject({ state: "delivered", mock: true, paid: false, published: false });
      expect(d.data.job.assets.length).toBeGreaterThan(0);
      expect(d.data.job.costs.map((x: any) => x.kind).sort()).toEqual(["commit", "estimate", "reserve"]);
      expect(d.data.job.costs.every((x: any) => x.paid === 0)).toBe(true);
      const g = await api("GET", `/api/jobs/${id}`);
      expect(g.data.events.filter((e: any) => e.type === "transition").map((e: any) => e.to_state)).toEqual(
        ["preflight", "ready", "queued", "running", "qa", "review", "approved", "delivered"],
      );
    });
  }
});

describe("CANON gate (integration)", () => {
  it("blocks missing master URL", async () => {
    const { preflight } = await createReady("A", { master_url: undefined });
    expect(preflight.data.job.state).toBe("blocked");
    expect(preflight.data.job.blocked_reasons).toContain("canon_missing_master_url");
  });
  it("blocks wrong master URL, unregistered and unapproved cast", async () => {
    const r1 = await createReady("A", { master_url: MASTER["fixture-liuli"] });
    expect(r1.preflight.data.job.blocked_reasons).toContain("canon_master_url_not_the_approved_master");
    const r2 = await createReady("A", { cast: ["fixture-fulan", "random-tomcat"] });
    expect(r2.preflight.data.job.blocked_reasons).toContain("canon_unregistered_character:random-tomcat");
    const r3 = await createReady("B", { cast: ["fixture-pending"] });
    expect(r3.preflight.data.job.blocked_reasons).toContain("canon_character_not_approved:fixture-pending");
  });
  it("all-female rule is enforced by the DB as well (male canon row cannot be inserted)", async () => {
    await expect(
      DB.prepare("INSERT INTO canon_characters (id, display_name, sex, species, master_url, approved, source, created_at) VALUES ('m','M','male','cat','https://x.invalid',1,'t','t')").run(),
    ).rejects.toThrow(/CHECK/);
  });
  it("blocked job cannot be enqueued", async () => {
    const { id } = await createReady("A", { segments: [10] });
    const g = await api("GET", `/api/jobs/${id}`);
    expect(g.data.state).toBe("blocked");
    expect(g.data.blocked_reasons).toContain("invalid_duration_10s_allowed_5_or_15");
    expect((await api("POST", `/api/jobs/${id}/enqueue`)).status).toBe(409);
  });
});

describe("paid / live blocking", () => {
  it("live mode is blocked in preflight and the live adapter is never reached", async () => {
    const { id, preflight } = await createReady("A", { mode: "live" });
    expect(preflight.data.job.state).toBe("blocked");
    expect(preflight.data.job.blocked_reasons.some((r: string) => r.startsWith("live_blocked:"))).toBe(true);
    // Even if someone forces the row to queued, run() fails closed via the live adapter.
    await DB.prepare("UPDATE jobs SET state='queued' WHERE id = ?").bind(id).run();
    const r = await api("POST", `/api/jobs/${id}/run`);
    expect(r.status).toBe(403);
    expect(r.data.error).toBe("live_provider_blocked");
    expect((await api("GET", `/api/jobs/${id}`)).data.state).toBe("queued");
  });
  it("paid can never be set (DB CHECK)", async () => {
    const { id } = await createReady("A");
    await expect(DB.prepare("UPDATE jobs SET paid = 1 WHERE id = ?").bind(id).run()).rejects.toThrow(/CHECK/);
  });
});

describe("idempotency", () => {
  it("same request returns the same job and reserves only once", async () => {
    const body = spec("C");
    const a = await api("POST", "/api/jobs", body);
    const b = await api("POST", "/api/jobs", { ...body, cast: [...(body.cast as string[])].reverse() });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.data.deduplicated).toBe(true);
    expect(b.data.job.jobId).toBe(a.data.job.jobId);
    const id = a.data.job.jobId;
    await api("POST", `/api/jobs/${id}/preflight`);
    expect((await api("POST", `/api/jobs/${id}/enqueue`)).status).toBe(200);
    expect((await api("POST", `/api/jobs/${id}/enqueue`)).status).toBe(409);
    const reserves = await DB.prepare("SELECT COUNT(*) n FROM costs WHERE job_id = ? AND kind='reserve'").bind(id).first<any>();
    expect(reserves.n).toBe(1);
    const budget = await DB.prepare("SELECT reserved FROM budgets WHERE scope='staging-mock'").first<any>();
    expect(budget.reserved).toBe(a.data.job.credits.estimated);
  });
  it("Idempotency-Key header distinguishes otherwise identical requests", async () => {
    const body = spec("A");
    const a = await api("POST", "/api/jobs", body, { "idempotency-key": "k1" });
    const b = await api("POST", "/api/jobs", body, { "idempotency-key": "k2" });
    const c = await api("POST", "/api/jobs", body, { "idempotency-key": "k1" });
    expect(a.data.job.jobId).not.toBe(b.data.job.jobId);
    expect(c.data.job.jobId).toBe(a.data.job.jobId);
  });
});

describe("budget guard + atomic reservation", () => {
  it("rejects enqueue beyond the budget with 402 and leaves job ready", async () => {
    await resetBudget(3);
    const { id } = await createReady("A"); // 4 credits
    const r = await api("POST", `/api/jobs/${id}/enqueue`);
    expect(r.status).toBe(402);
    expect(r.data.error).toBe("budget_guard_rejected");
    expect((await api("GET", `/api/jobs/${id}`)).data.state).toBe("ready");
  });
  it("concurrent enqueues never over-reserve", async () => {
    await resetBudget(10); // fits two 4-credit jobs, not three
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await createReady("A")).id);
    const rs = await Promise.all(ids.map((id) => api("POST", `/api/jobs/${id}/enqueue`)));
    expect(rs.filter((r) => r.status === 200).length).toBe(2);
    expect(rs.filter((r) => r.status === 402).length).toBe(2);
    const b = await DB.prepare("SELECT reserved FROM budgets WHERE scope='staging-mock'").first<any>();
    expect(b.reserved).toBe(8);
  });
  it("per-job cost cap blocks oversized jobs at preflight", async () => {
    const { preflight } = await createReady("D", { segments: Array(12).fill(15) }); // 36 > 30
    expect(preflight.data.job.state).toBe("blocked");
    expect(preflight.data.job.blocked_reasons.join()).toContain("exceeds_job_cap_30");
  });
  it("cancel releases the reservation", async () => {
    const { id } = await toRunning("A");
    expect((await DB.prepare("SELECT reserved FROM budgets WHERE scope='staging-mock'").first<any>()).reserved).toBe(4);
    const c = await api("POST", `/api/jobs/${id}/cancel`, { reason: "test" });
    expect(c.data.job.state).toBe("cancelled");
    expect((await DB.prepare("SELECT reserved FROM budgets WHERE scope='staging-mock'").first<any>()).reserved).toBe(0);
    expect((await api("POST", `/api/jobs/${id}/cancel`, {})).status).toBe(409);
  });
});

describe("retry / timeout / failure recovery", () => {
  it("provider failure retries until max_attempts then fails and releases budget", async () => {
    let { id, job } = await toRunning("A");
    for (let attempt = 1; attempt <= 3; attempt++) {
      const cb = await signedCallback(cbFor(job, "failed"));
      expect(cb.status).toBe(200);
      if (attempt < 3) {
        expect(cb.data.job.state).toBe("queued");
        job = (await api("POST", `/api/jobs/${id}/run`)).data.job;
        expect(job.attempts).toBe(attempt + 1);
      } else {
        expect(cb.data.job.state).toBe("failed");
      }
    }
    const b = await DB.prepare("SELECT reserved, spent FROM budgets WHERE scope='staging-mock'").first<any>();
    expect(b).toEqual({ reserved: 0, spent: 0 });
  });
  it("a failed attempt can recover and still deliver", async () => {
    let { id, job } = await toRunning("B");
    await signedCallback(cbFor(job, "failed"));
    job = (await api("POST", `/api/jobs/${id}/run`)).data.job;
    expect((await signedCallback(cbFor(job))).data.job.state).toBe("qa");
    expect((await api("POST", `/api/jobs/${id}/qa`, { checks: allPass("B") })).data.job.state).toBe("review");
  });
  it("QA failure goes back to queued (rework) and records the failed checks", async () => {
    const { id, job } = await toRunning("A");
    await signedCallback(cbFor(job));
    const q = await api("POST", `/api/jobs/${id}/qa`, { checks: { ...allPass("A"), character_consistency: false } });
    expect(q.data.job.state).toBe("queued");
    expect(q.data.job.last_error).toContain("character_consistency");
  });
  it("timeout sweep moves stuck running jobs to retry", async () => {
    const { id } = await toRunning("D");
    await DB.prepare("UPDATE jobs SET running_since = '2000-01-01T00:00:00Z' WHERE id = ?").bind(id).run();
    const swept = await sweepTimeouts(env as any);
    expect(swept).toContainEqual({ jobId: id, state: "queued" });
    expect((await api("GET", `/api/jobs/${id}`)).data.last_error).toBe("timeout");
  });
});

describe("signed callbacks", () => {
  it("rejects forged signature, wrong secret, tampered body and stale timestamp", async () => {
    const { id, job } = await toRunning("A");
    expect((await signedCallback(cbFor(job), { secret: "attacker" })).status).toBe(401);
    expect((await signedCallback(cbFor(job), { tamper: true })).status).toBe(401);
    expect((await signedCallback(cbFor(job), { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    const unsigned = await (exports as any).default.fetch(new Request("https://staging.test/api/callbacks/runninghub-h3", { method: "POST", body: JSON.stringify(cbFor(job)) }));
    expect(unsigned.status).toBe(401);
    expect((await api("GET", `/api/jobs/${id}`)).data.state).toBe("running");
  });
  it("dedupes repeated callback events", async () => {
    const { job } = await toRunning("C");
    const payload = cbFor(job, "succeeded", "evt-dup-" + job.jobId);
    expect((await signedCallback(payload)).data).toMatchObject({ duplicate: false, job: { state: "qa" } });
    const again = await signedCallback(payload);
    expect(again.status).toBe(200);
    expect(again.data.duplicate).toBe(true);
    expect(again.data.job.state).toBe("qa");
    const assets = await DB.prepare("SELECT COUNT(*) n FROM assets WHERE job_id = ?").bind(job.jobId).first<any>();
    expect(assets.n).toBe(3); // 2 segments + music
  });
  it("ignores stale callbacks for an old provider task id", async () => {
    const { job } = await toRunning("A");
    const r = await signedCallback({ ...cbFor(job), provider_task_id: "mock-old-task" });
    expect(r.status).toBe(409);
  });
});

describe("publish gate", () => {
  it("publish is blocked even after delivery; nothing is ever published", async () => {
    const { id, job } = await toRunning("A");
    await signedCallback(cbFor(job));
    await api("POST", `/api/jobs/${id}/qa`, { checks: allPass("A") });
    await api("POST", `/api/jobs/${id}/approve`, {});
    const d = await api("POST", `/api/jobs/${id}/deliver`);
    expect(d.data.job.published).toBe(false);
    const p = await api("POST", `/api/jobs/${id}/publish`, {});
    expect(p.status).toBe(403);
    expect(p.data).toMatchObject({ error: "publish_blocked", published: false });
    const row = await DB.prepare("SELECT published FROM jobs WHERE id = ?").bind(id).first<any>();
    expect(row.published).toBe(0);
    await expect(DB.prepare("UPDATE jobs SET published = 1 WHERE id = ?").bind(id).run()).rejects.toThrow(/CHECK/);
  });
});

describe("state transition guards", () => {
  it("rejects out-of-order actions with 409", async () => {
    const { id } = await createReady("A");
    expect((await api("POST", `/api/jobs/${id}/run`)).status).toBe(409);
    expect((await api("POST", `/api/jobs/${id}/deliver`)).status).toBe(409);
    expect((await api("POST", `/api/jobs/${id}/approve`, {})).status).toBe(409);
    expect((await api("POST", `/api/jobs/${id}/qa`, { checks: allPass("A") })).status).toBe(409);
  });
  it("concurrent duplicate transitions: exactly one wins, side effects written once", async () => {
    const { id, job } = await toRunning("A");
    await signedCallback(cbFor(job));
    await api("POST", `/api/jobs/${id}/qa`, { checks: allPass("A") });
    await api("POST", `/api/jobs/${id}/approve`, {});
    const rs = await Promise.all([api("POST", `/api/jobs/${id}/deliver`), api("POST", `/api/jobs/${id}/cancel`, {}), api("POST", `/api/jobs/${id}/deliver`)]);
    expect(rs.filter((r) => r.status === 200).length).toBe(1);
    const costs = await DB.prepare("SELECT kind FROM costs WHERE job_id = ? AND kind IN ('commit','release')").bind(id).all();
    expect(costs.results.length).toBe(1);
    const b = await DB.prepare("SELECT reserved FROM budgets WHERE scope='staging-mock'").first<any>();
    expect(b.reserved).toBe(0);
  });
  it("stale writer loses: transition from an outdated snapshot is 409 and writes no side effects", async () => {
    const { id, job } = await toRunning("A");
    await signedCallback(cbFor(job));
    await api("POST", `/api/jobs/${id}/qa`, { checks: allPass("A") });
    await api("POST", `/api/jobs/${id}/approve`, {});
    const snapA = await getJob(env as any, id);
    const snapB = await getJob(env as any, id); // both see "approved"
    await deliver(env as any, snapA);
    await expect(cancel(env as any, snapB, "race")).rejects.toThrow("concurrent_state_change");
    expect((await getJob(env as any, id)).state).toBe("delivered");
    const rel = await DB.prepare("SELECT COUNT(*) n FROM costs WHERE job_id = ? AND kind = 'release'").bind(id).first<any>();
    expect(rel.n).toBe(0);
    const ev = await DB.prepare("SELECT COUNT(*) n FROM events WHERE job_id = ? AND to_state = 'cancelled'").bind(id).first<any>();
    expect(ev.n).toBe(0);
    const b = await DB.prepare("SELECT reserved, spent FROM budgets WHERE scope='staging-mock'").first<any>();
    expect(b).toEqual({ reserved: 0, spent: 4 });
  });
  it("rejects malformed jobs with 400", async () => {
    expect((await api("POST", "/api/jobs", { line: "Z" })).status).toBe(400);
    expect((await api("POST", "/api/jobs", { line: "A" })).status).toBe(400);
  });
});

describe("public canon route", () => {
  it("serves only public/canon/* from R2 without auth; nothing else", async () => {
    const b = (env as any).ASSETS_BUCKET as R2Bucket;
    await b.put("public/canon/MZ_TEST-master.png", new Uint8Array([137, 80, 78, 71]), { httpMetadata: { contentType: "image/png" } });
    await b.put("live/secret-job/out.mp4", new Uint8Array([1, 2, 3]));
    const ok = await (exports as any).default.fetch("https://staging.test/public/canon/MZ_TEST-master.png");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect((await (exports as any).default.fetch("https://staging.test/public/canon/missing.png")).status).toBe(404);
    expect((await (exports as any).default.fetch("https://staging.test/public/canon/../live/secret-job/out.mp4")).status).toBe(404);
    expect((await (exports as any).default.fetch("https://staging.test/public/live/secret-job/out.mp4")).status).toBe(404);
    expect((await (exports as any).default.fetch("https://staging.test/api/assets/r2/live/secret-job/out.mp4")).status).toBe(401);
  });
});
