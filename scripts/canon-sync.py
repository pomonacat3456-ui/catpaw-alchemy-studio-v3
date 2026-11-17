#!/usr/bin/env python3
"""
CANON Sheet v3 -> D1 sync (read-only on the sheet side).

Input : a text export of Google Sheet 1qvEJtoNPUjzBmwbpNQ09PJCc9MChvLx20JS8lDGJuuY obtained READ-ONLY
        (Drive connector read_file_content -> fileContent; tabs rendered as "## <tab>" + CSV).
Output: canon-sync/out/canon_payload.json and (with --post) POST to <BASE>/api/admin/canon/sync.
The Worker decides approval (fail-closed, src/canon.ts); this script only maps columns.
Raw exports and payloads are gitignored (private worldbuilding data / private Drive ids).

Usage: scripts/canon-sync.py <export.txt> [--post BASE] [--admin-key-file PATH]
"""
import csv, io, json, re, subprocess, sys, tempfile, os

SHEET_ID = "1qvEJtoNPUjzBmwbpNQ09PJCc9MChvLx20JS8lDGJuuY"

def tabs(text):
    parts = re.split(r"^## (.+)$", text, flags=re.M)
    return {parts[k].strip(): list(csv.reader(io.StringIO(parts[k + 1].strip("\n")))) for k in range(1, len(parts), 2)}

def table(rows):
    if not rows: return []
    h = rows[0]
    return [(i + 2, dict(zip(h, r))) for i, r in enumerate(rows[1:])]

def build(text):
    T = tabs(text)
    roster = table(T["角色總表"]); control = {d["角色ID"]: d for _, d in table(T["Master總控"])}
    assets = [d for _, d in table(T["圖片素材"])]
    out = []
    for row_no, c in roster:
        cid = (c.get("character_id") or "").strip()
        if not cid: continue
        m = control.get(cid, {})
        listed = set(re.findall(r"AST_\d{4}", m.get("Master資產ID", "") or ""))
        cands = [a for a in assets if a.get("character_id") == cid and a.get("asset_type") == "CHARACTER_MASTER"
                 and (a.get("approved") or "").upper() == "TRUE" and (a.get("url") or "").startswith("https://")]
        cands.sort(key=lambda a: (a["asset_id"] in listed, a["asset_id"]), reverse=True)
        best = cands[0] if cands else None
        out.append({
            "character_id": cid,
            "name": c.get("canonical_name", "").strip(),
            "gender": c.get("gender", "").strip(),
            "canon_status": c.get("canon_status", "").strip(),
            "production_gate": (m.get("製片准入（公式）") or "").strip(),
            "master_asset_id": best["asset_id"] if best else (m.get("Master資產ID") or None),
            "master_url": best["url"] if best else "",
            "asset_approved": bool(best),
            "master_readable": (m.get("外部模型可讀") or "").strip(),
            "weapon": c.get("weapon_lock", "").strip() or None,
            "outfit": c.get("costume_lock", "").strip() or None,
            "sheet_tab": "角色總表",
            "sheet_row": row_no,
        })
    return {"sheet_id": SHEET_ID, "rows": out}

def main():
    a = sys.argv[1:]
    if not a: sys.exit(__doc__)
    payload = build(open(a[0], encoding="utf-8").read())
    os.makedirs("canon-sync/out", exist_ok=True)
    with open("canon-sync/out/canon_payload.json", "w", encoding="utf-8") as f: json.dump(payload, f, ensure_ascii=False, indent=1)
    print(f"rows mapped: {len(payload['rows'])}")
    if "--post" in a:
        base = a[a.index("--post") + 1]
        keyf = a[a.index("--admin-key-file") + 1] if "--admin-key-file" in a else os.path.expanduser("~/secrets/catpaw_alchemy_v3_prod_admin_key")
        with tempfile.NamedTemporaryFile("w", delete=False) as cfg:
            os.chmod(cfg.name, 0o600)
            cfg.write('header = "x-admin-key: %s"\n' % open(keyf).read().strip())
        try:
            r = subprocess.run(["curl", "-sS", "-K", cfg.name, "-X", "POST", "-H", "content-type: application/json",
                                "--data-binary", "@canon-sync/out/canon_payload.json", base.rstrip("/") + "/api/admin/canon/sync"],
                               capture_output=True, text=True, check=True)
        finally:
            os.unlink(cfg.name)
        res = json.loads(r.stdout)
        with open("canon-sync/out/canon_sync_result.json", "w", encoding="utf-8") as f: json.dump(res, f, ensure_ascii=False, indent=1)
        print(json.dumps(res.get("stats", res), ensure_ascii=False))

if __name__ == "__main__":
    main()
