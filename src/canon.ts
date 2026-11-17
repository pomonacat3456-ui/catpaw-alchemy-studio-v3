import { HttpError, type Env } from "./types";

/** Sheet「製片准入（公式）」values that OPEN production. Anything else (incl. 暫停製片 / 禁止引用 / blank) keeps it closed. */
export const PRODUCTION_GATE_OPEN = ["可製片", "准許製片", "允許製片", "開放製片", "放行"];

export interface CanonSyncRow {
  character_id: string;
  name: string;
  gender: string; // sheet value, must be 母喵
  canon_status: string; // 角色總表 canon_status
  production_gate: string; // Master總控 製片准入（公式）
  master_asset_id?: string;
  master_url?: string; // 圖片素材 url of the approved CHARACTER_MASTER asset
  asset_approved: boolean; // 圖片素材 approved == TRUE
  master_readable?: string; // Master總控 外部模型可讀
  weapon?: string;
  outfit?: string;
  sheet_tab: string;
  sheet_row: number;
}

/** Fail-closed approval. approved = live-eligible; mock_eligible = may be used for mock jobs. */
export function canonApproval(r: CanonSyncRow) {
  const why: string[] = [];
  const female = r.gender?.trim() === "母喵";
  if (!female) why.push(`not_female:${r.gender}`);
  if (r.canon_status !== "CANON_LOCKED") why.push(`canon_status_not_locked:${r.canon_status || "blank"}`);
  if (!r.asset_approved) why.push("master_asset_not_approved");
  if (!/^https:\/\//.test(r.master_url ?? "")) why.push("master_url_missing");
  const mockEligible = female && why.length === 0;
  const gate = (r.production_gate ?? "").trim();
  if (!PRODUCTION_GATE_OPEN.includes(gate)) why.push(`production_gate_closed:${gate || "blank"}`);
  if (/^https:\/\/(drive|docs)\.google\.com\//.test(r.master_url ?? "")) why.push("master_url_is_drive_viewer_not_direct_image");
  const readable = (r.master_readable ?? "").trim();
  if (!readable || /無|尚無|私人|不可/.test(readable)) why.push(`master_not_model_readable:${readable || "blank"}`);
  return { female, approved: female && why.length === 0, mockEligible, reasons: why };
}

export async function syncCanon(env: Env, body: any) {
  const sheetId = String(body?.sheet_id ?? "");
  if (!/^[A-Za-z0-9_-]{20,}$/.test(sheetId)) throw new HttpError(400, "invalid_sheet_id");
  const rows: CanonSyncRow[] = Array.isArray(body?.rows) ? body.rows : [];
  if (!rows.length || rows.length > 500) throw new HttpError(400, "rows_required_1_to_500");
  const syncedAt = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  const stats = { received: rows.length, imported: 0, approved_live: 0, mock_eligible: 0, rejected_not_female: 0, rejected_invalid: 0 };
  const detail: { id: string; approved: boolean; mock_eligible: boolean; reasons: string[] }[] = [];
  for (const r of rows) {
    if (!r || typeof r.character_id !== "string" || !/^[A-Za-z0-9_]{2,40}$/.test(r.character_id) || typeof r.name !== "string") { stats.rejected_invalid++; continue; }
    const a = canonApproval(r);
    if (!a.female) { stats.rejected_not_female++; detail.push({ id: r.character_id, approved: false, mock_eligible: false, reasons: a.reasons }); continue; }
    stats.imported++;
    if (a.approved) stats.approved_live++;
    if (a.mockEligible) stats.mock_eligible++;
    detail.push({ id: r.character_id, approved: a.approved, mock_eligible: a.mockEligible, reasons: a.reasons });
    stmts.push(env.DB.prepare(
      `INSERT INTO canon_characters (id, display_name, sex, species, master_url, approved, mock_eligible, weapon, outfit, source, created_at,
         canon_status, production_gate, master_asset_id, master_readable, approval_reasons, sheet_id, sheet_tab, sheet_row, synced_at)
       VALUES (?, ?, 'female', 'cat', ?, ?, ?, ?, ?, 'canon-sheet-v3', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, master_url=excluded.master_url, approved=excluded.approved,
         mock_eligible=excluded.mock_eligible, weapon=excluded.weapon, outfit=excluded.outfit, source=excluded.source,
         canon_status=excluded.canon_status, production_gate=excluded.production_gate, master_asset_id=excluded.master_asset_id,
         master_readable=excluded.master_readable, approval_reasons=excluded.approval_reasons, sheet_id=excluded.sheet_id,
         sheet_tab=excluded.sheet_tab, sheet_row=excluded.sheet_row, synced_at=excluded.synced_at`,
    ).bind(r.character_id, r.name.slice(0, 80), r.master_url ?? "", a.approved ? 1 : 0, a.mockEligible ? 1 : 0, r.weapon?.slice(0, 200) ?? null,
      r.outfit?.slice(0, 200) ?? null, syncedAt, r.canon_status ?? null, r.production_gate ?? null, r.master_asset_id ?? null,
      r.master_readable ?? null, JSON.stringify(a.reasons), sheetId, r.sheet_tab, Number(r.sheet_row) || null, syncedAt));
  }
  // Characters that were synced before but are no longer in the sheet lose approval (fail-closed).
  const ids = rows.map((r) => r?.character_id).filter((x) => typeof x === "string");
  stmts.push(env.DB.prepare(
    `UPDATE canon_characters SET approved = 0, mock_eligible = 0, approval_reasons = '["missing_from_latest_sync"]'
     WHERE source = 'canon-sheet-v3' AND sheet_id = ? AND id NOT IN (SELECT value FROM json_each(?))`,
  ).bind(sheetId, JSON.stringify(ids)));
  await env.DB.batch(stmts);
  return { sheet_id: sheetId, synced_at: syncedAt, stats, rows: detail };
}
