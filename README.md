# 貓掌鍊金術 3.0 · CatPaw Alchemy Studio v3

> **全新重建（fresh rebuild），不是原 ZIP 還原。** 原始 `catpaw-alchemy-studio-v3-mock.zip` 已遺失，本 repo 依 2026-11-17 交接規格從頭重寫。
> 本版本 **mock-first、fail-closed**：`mock:true / paid:false / published:false`。沒有任何真實 provider 呼叫、付費生成或對外發布的程式路徑。

## 架構
- **前端**：`public/index.html`，手機優先 9:16 總控台（Cloudflare Worker static assets）。
- **API**：Cloudflare Worker（`src/index.ts`），`x-admin-key` 驗證；provider 回呼以 HMAC 簽章驗證。
- **資料**：D1（`jobs`, `steps`, `assets`, `events`, `costs`, `budgets`, `canon_characters`, `callback_events`）。
- **四條產線**：A 短影音 / B 寫真圖片 / C 音樂 MV / D 長片漫劇，統一 jobId（`cpa3-<線>-<日期>-<hex>`）。

## 狀態機
`draft → preflight → blocked | ready → queued → running → qa → review → approved → delivered`
（另有 `failed`、`cancelled` 終態；失敗/QA 不過/審核退回在次數內回到 `queued` 重試。）
每次轉換都是單一 D1 batch（交易），以 `WHERE state = <from>` + `last_tx` token 保證並發時只有一個成功、副作用只寫一次。

## 閘門
| 閘門 | 行為 |
|---|---|
| CANON gate | 角色須已登錄、已核准、`sex='female'`（DB CHECK 也鎖死）、物種 cat；必須帶主角**完全相同**的核准 Master URL（https）；提示詞禁用人臉/人手/多指/公貓等 |
| 時長/格式 | 9:16；分段只允許 5s（便宜測試）或 15s（正式）；B 線 1–8 張；C 線需音樂參考 |
| 冪等 | SHA-256(canonical JSON 規格 + 可選 `Idempotency-Key`)，`UNIQUE` 索引；重送回同一 jobId |
| 預算 | mock credits 預估 → 單筆上限 → 排入時**原子預留**（batch + `UNIQUE(job_id,kind)` + budgets CHECK）；交付 commit、取消/失敗 release，各只一次 |
| 回呼 | `x-catpaw-timestamp` + `x-catpaw-signature: sha256=hex(HMAC(secret, ts + "." + body))`，±300s，event_id 去重，舊 task id 忽略 |
| 重試/超時 | `MAX_ATTEMPTS`（預設 3），cron 每 30 分鐘掃描逾時（`RUNNING_TIMEOUT_SEC`） |
| Live provider | `LiveAdapter` fail-closed：非 production、未明確啟用或無 owner 核准 id 一律 403；即使全開也回 501（本版不含 live HTTP 程式） |
| 發布 | 獨立閘門，`/publish` 永遠 403；`published` 欄位 DB CHECK 鎖 0；生成/交付成功不會觸發發布 |

## 開發與測試
```bash
npm ci
npm run typecheck
npm test            # vitest + @cloudflare/vitest-plugin（workerd + 本地 D1，套用 migrations）
```
CI：`.github/workflows/ci.yml`、`.gitlab-ci.yml`（只跑 typecheck + test，不部署）。

## Staging 部署（隔離）
```bash
npx wrangler d1 create catpaw-alchemy-v3-staging          # 已建立，id 在 wrangler.toml
npm run db:migrate:staging
npx wrangler deploy
tr -d '\n' < /path/to/admin_key | npx wrangler secret put ADMIN_KEY
tr -d '\n' < /path/to/hmac      | npx wrangler secret put CALLBACK_HMAC_SECRET
BASE=https://catpaw-alchemy-v3-staging.<subdomain>.workers.dev scripts/verify.sh
```
機密只放 Cloudflare secrets 與本機 mode 600 檔案，不進 repo。範本見 `.dev.vars.example`。

## API 摘要
`GET /health`（公開） · `GET /api/meta|budget|canon|jobs` · `POST /api/jobs` · `GET /api/jobs/:id` ·
`POST /api/jobs/:id/{preflight,enqueue,run,qa,approve,reject,deliver,cancel,publish,mock/callback}` ·
`POST /api/callbacks/:provider`（HMAC） · `POST /api/admin/sweep`

## Production（2026-11-17 起）
- Worker `catpaw-alchemy-v3` + D1 `catpaw-alchemy-v3` + R2 `catpaw-alchemy-v3-assets`：`npx wrangler deploy --env production`（只用 workers.dev）。
- Staging（`catpaw-alchemy-v3-staging`）保持原樣當備援；若要重新部署 staging，須先 `npm run db:migrate:staging` 套用 0003。
- 測試夾具已移到 `seed/staging-fixtures.sql`，production D1 不含任何夾具（0002 現為空 migration）。

## CANON 同步（唯讀）
1. 用 Drive connector 唯讀取得 Sheet `1qvEJtoNPUjzBmwbpNQ09PJCc9MChvLx20JS8lDGJuuY` 的文字匯出，存到 `canon-sync/raw/`（gitignored）。
2. `scripts/canon-sync.py <export.txt> --post <BASE> --admin-key-file <file>` → `POST /api/admin/canon/sync`。
3. 核准由 Worker 判斷（`src/canon.ts`，fail-closed）：
   - **mock 可用**：母喵 + `CANON_LOCKED` + 圖片素材 `approved=TRUE` 且有 https 網址的 CHARACTER_MASTER。
   - **live 可用**：以上全部 + Master總控「製片准入」為開放值（可製片/准許製片/允許製片/開放製片/放行）+ 外部模型可讀 + 直接圖片網址（非 Drive 檢視頁）。
   - 每列記錄 sheet_id / 分頁 / 列號 / synced_at / 不核准原因；下次同步缺席的列自動撤銷核准。

## Live provider（RunningHub MiniMax H3，預設關閉）
送出順序：環境=production、`LIVE_PROVIDERS_ENABLED=true`、`OWNER_LIVE_APPROVAL_ID`、該任務 `live-approve`（owner 核准紀錄）、CANON live 核准、
全域上限 `LIVE_MAX_SUBMISSIONS`（預設 1，原子佔位）、`RUNNINGHUB_API_KEY`、**餘額查詢 ≥ 預估**、Master 圖可讀 → 上傳 → **唯一一次付費 create** →
cron/`POST /api/jobs/:id/poll` 輪詢 → 結果下載到 R2 → QA。live 任務不自動重試；餘額前後、consumeCoins、task id 皆寫入 `provider_meta`。

## 尚未完成（需設定或 owner 核准）
- PixVerse live adapter、n8n、YouTube/Threads 發布器：未實作。RunningHub H3 已實作但 production 預設關閉。
- 正式網站/正式 Worker 切換、任何付費：須 owner 明確核准。
