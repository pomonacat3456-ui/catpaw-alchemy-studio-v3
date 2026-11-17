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
BASE=https://catpaw-alchemy-v3-staging.<subdomain>.workers.dev scripts/verify-staging.sh
```
機密只放 Cloudflare secrets 與本機 mode 600 檔案，不進 repo。範本見 `.dev.vars.example`。

## API 摘要
`GET /health`（公開） · `GET /api/meta|budget|canon|jobs` · `POST /api/jobs` · `GET /api/jobs/:id` ·
`POST /api/jobs/:id/{preflight,enqueue,run,qa,approve,reject,deliver,cancel,publish,mock/callback}` ·
`POST /api/callbacks/:provider`（HMAC） · `POST /api/admin/sweep`

## 尚未完成（需設定或 owner 核准）
- CANON 角色目前是 **staging 測試夾具**（`.invalid` 網址），尚未接 CANON Google Sheet v3。
- RunningHub H3 / PixVerse live adapter、n8n、Drive/R2 素材、YouTube/Threads 發布器：皆未實作，需 P4 PR + owner 核准單筆實測。
- 正式網站/正式 Worker 切換、任何付費：須 owner 明確核准。
