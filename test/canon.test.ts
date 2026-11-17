import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { canonApproval, PRODUCTION_GATE_OPEN } from "../src/canon";
import { checkCanon, parseSpec } from "../src/lib/validate";
import { DB, api } from "./helpers";

const base = { character_id: "MZ_X01", name: "X", gender: "母喵", canon_status: "CANON_LOCKED", production_gate: "可製片",
  master_url: "https://cdn.example.test/m.png", asset_approved: true, master_readable: "公開可讀", sheet_tab: "Master總控", sheet_row: 2 };

describe("CANON approval rules (fail-closed)", () => {
  it("approves only when every sheet gate is open", () => {
    expect(canonApproval(base)).toMatchObject({ approved: true, mockEligible: true, reasons: [] });
    expect(PRODUCTION_GATE_OPEN).not.toContain("暫停製片");
  });
  it("closed production gate / private Master => not live-approved but still mock-eligible", () => {
    const a = canonApproval({ ...base, production_gate: "暫停製片", master_readable: "私人 Drive，無匿名讀取權限" });
    expect(a.approved).toBe(false);
    expect(a.mockEligible).toBe(true);
    expect(a.reasons).toEqual(expect.arrayContaining(["production_gate_closed:暫停製片", "master_not_model_readable:私人 Drive，無匿名讀取權限"]));
  });
  it("not CANON_LOCKED, unapproved asset, or missing URL => neither live nor mock", () => {
    for (const over of [{ canon_status: "MASTER_FOUND" }, { asset_approved: false }, { master_url: "" }]) {
      const a = canonApproval({ ...base, ...over });
      expect(a.approved).toBe(false);
      expect(a.mockEligible).toBe(false);
    }
  });
  it("non-female rows are rejected", () => {
    expect(canonApproval({ ...base, gender: "公喵" })).toMatchObject({ female: false, approved: false, mockEligible: false });
  });
});

describe("CANON sync endpoint", () => {
  it("imports with provenance, rejects non-female, and revokes rows missing from the next sync", async () => {
    const sheet = "SHEETSYNC_abcdefghijklmnop";
    const r = await api("POST", "/api/admin/canon/sync", { sheet_id: sheet, rows: [
      base, { ...base, character_id: "MZ_X02", production_gate: "暫停製片" }, { ...base, character_id: "MZ_X03", gender: "公喵" },
    ] });
    expect(r.status).toBe(200);
    expect(r.data.stats).toEqual({ received: 3, imported: 2, approved_live: 1, mock_eligible: 2, rejected_not_female: 1, rejected_invalid: 0 });
    const row = await DB.prepare("SELECT * FROM canon_characters WHERE id = 'MZ_X01'").first<any>();
    expect(row).toMatchObject({ sex: "female", approved: 1, mock_eligible: 1, source: "canon-sheet-v3", sheet_id: sheet, sheet_tab: "Master總控", sheet_row: 2 });
    expect(row.synced_at).toMatch(/^2\d{3}-/);
    expect(await DB.prepare("SELECT id FROM canon_characters WHERE id = 'MZ_X03'").first()).toBeNull();
    await api("POST", "/api/admin/canon/sync", { sheet_id: sheet, rows: [{ ...base, character_id: "MZ_X02", production_gate: "暫停製片" }] });
    const gone = await DB.prepare("SELECT approved, mock_eligible, approval_reasons FROM canon_characters WHERE id = 'MZ_X01'").first<any>();
    expect(gone).toEqual({ approved: 0, mock_eligible: 0, approval_reasons: '["missing_from_latest_sync"]' });
  });
  it("requires admin key and a valid sheet id", async () => {
    expect((await api("POST", "/api/admin/canon/sync", { sheet_id: "x", rows: [base] })).status).toBe(400);
    expect((await api("POST", "/api/admin/canon/sync", { sheet_id: "SHEETSYNC_abcdefghijklmnop", rows: [base] }, { "x-admin-key": "nope" })).status).toBe(401);
  });
  it("production ignores staging fixtures entirely", async () => {
    const rows = (await DB.prepare("SELECT * FROM canon_characters WHERE id = 'fixture-fulan'").all<any>()).results;
    const canon = new Map(rows.map((r) => [r.id, r]));
    const spec = parseSpec({ line: "A", protagonist: "fixture-fulan", master_url: rows[0].master_url, segments: [5], prompt: "ok" });
    expect(checkCanon(spec, canon as any, { environment: "staging" })).toEqual([]);
    expect(checkCanon(spec, canon as any, { environment: "production" })).toContain("canon_unregistered_character:fixture-fulan");
    void env;
  });
});
