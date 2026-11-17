# 貓掌鍊金術 3.0 Production 部署報告 · 2026-11-17

負責：5F 鐵璃喵工程師　　依據：老闆 2026-11-17 11:11（台北時間）親自回覆（GitHub 維持 public、token 不變、允許**一次** live 實測、接正式 CANON Sheet、上 production；不得儲值或產生新費用）。

## 0. 結論
- ✅ Production 已上線（workers.dev、免費方案、無自訂網域），四線 Mock 與所有閘門線上實測 69/69 通過。
- ✅ 正式 CANON Sheet 已唯讀同步進 production D1（46 列）。
- ⛔ **唯一一次 live 生成「沒有送出」**，0 次付費呼叫、0 枚額度消耗。原因有兩個，任一個都足以擋下：
  1. **沒有 provider 金鑰**：box 的環境變數、`/home/box/secrets`、`/home/box/.secrets`、`/workspace/runninghub-mcp-runtime`、`/workspace/ai-music-studio-v2*` 都沒有 `RUNNINGHUB_API_KEY` 或 `PIXVERSE_API_KEY`（過去的實測是當次 session 注入的環境變數，現在已不存在）。因此連**餘額都查不到**，依規則停止。
  2. **CANON 沒有任何角色可送 live**：Sheet 自己的「Master總控 › 製片准入（公式）」46 列全部是「暫停製片」或「禁止引用」；有核准 Master 圖（approved=TRUE）的 3 位角色（MZ_003 焚天赤焰喵、MZ_004 青鹿靈喵、MZ_005 金麟雷喵）的 Master 都是**私人 Drive 檢視頁網址**（「私人 Drive，無匿名讀取權限」/「尚無圖片網址」），外部模型讀不到。Sheet 說明頁也寫明：「只有 CANON 已核准且 Master 圖有真實網址、已審核，才能自動送 PixVerse」。
- 所以：live jobId／provider task id／餘額前後／結果檔／影格 QA → **無（未送出）**。

## 1. 網址
| | URL |
|---|---|
| Production | https://catpaw-alchemy-v3.gogototo24.workers.dev/ |
| Production health | https://catpaw-alchemy-v3.gogototo24.workers.dev/health（ok, environment=production, schema 0003, live_providers=false, r2_bound=true, provider_key=false） |
| Staging（備援，未動） | https://catpaw-alchemy-v3-staging.gogototo24.workers.dev/ （仍為 3.0.0-rebuild.1、schema 0002） |

Production 資源（全部新建）：
- Worker `catpaw-alchemy-v3`，version `a965bb8c-1c85-4d17-857a-dee7b114e5e0`（2026-11-17 11:23 台北時間部署），cron `*/10 * * * *`
- D1 `catpaw-alchemy-v3`（id 25218f6e-7441-4ad9-91fa-3cd371aa40a9），migrations 0001 / 0002（空，夾具已移出）/ 0003；**無任何 staging 夾具**
- R2 `catpaw-alchemy-v3-assets`（帳號原本已啟用 R2，免費額度內，無計費變更）
- Secrets：`ADMIN_KEY`、`CALLBACK_HMAC_SECRET` → `/home/box/secrets/catpaw_alchemy_v3_prod_admin_key`、`catpaw_alchemy_v3_prod_callback_hmac_secret`（mode 600，未印出）
- 未動：threads-scheduler（Worker / D1 / R2 `threads-scheduler-media`）、staging 的 Worker/D1/secrets。

## 2. Repo 與 CI
| | Commit | CI |
|---|---|---|
| GitHub https://github.com/pomonacat3456-ui/catpaw-alchemy-studio-v3 (public) | 程式 `ccb875d`（完整 SHA 見回報）＋本報告 commit | Actions：secret-scan + test 皆 success |
| GitLab https://gitlab.com/gogototo24/catpaw-alchemy-studio-v3 (private) | 同上 | Pipeline：secret-scan + test |

## 3. 機密衛生
- gitleaks 8.28.0 掃描**兩個 remote 的完整歷史**（mirror clone）：no leaks found。
- 另外逐字比對 staging/prod 的 admin key、HMAC secret、GitHub token、GitLab token、Crosswalk key：兩邊歷史都不存在。
- CI 已新增 gitleaks 全歷史掃描步驟（GitHub Actions `secret-scan` job、GitLab `secret-scan` stage）。
- CANON 原始匯出與同步 payload 含私人世界觀資料與私人 Drive 檔案 id，放在 `canon-sync/raw|out/`（gitignored，不進 public repo）；production curl log 內的 Drive 檔案 id 已遮蔽。

## 4. 測試
`npm ci && npm run typecheck && npm test` → **62 passed / 0 failed / 0 skipped**（4 個檔：unit 15、integration 30、canon 7、live 10）。
新增：live adapter（mocked fetch）— 成功路徑（餘額→上傳→**只一次** create→輪詢→R2→QA，金鑰不入庫）、全域上限 1、餘額不足 402 且無付費呼叫、私人 Drive Master 拒絕、805 失敗不自動重試並釋放預算、缺 owner/金鑰/環境/開關一律拒絕、CANON live 閘門、預算 400 枚只容一筆 5 秒、HMAC 回呼不能完成 live 任務；CANON 核准規則、同步來源紀錄、缺席撤銷、production 忽略夾具。

## 5. Production 線上實測（`verify/prod-curl-2026-11-17.log`，69/69）
使用 CANON 角色 MZ_003 焚天赤焰喵（mock 可用、live 不可用），全部 mock:true / paid:false / published:false：
| 項目 | jobId |
|---|---|
| A 短影音 draft→…→delivered | cpa3-A-20261117-78486797e4 |
| B 寫真圖片 | cpa3-B-20261117-76b3ea63eb |
| C 音樂 MV | cpa3-C-20261117-e12824dc10 |
| D 長片漫劇 | cpa3-D-20261117-3ccd2ad41f |
| 冪等重送（同 jobId）、CANON 拒絕（缺 URL／未登錄／10 秒）、blocked 不可排入、偽造/未簽回呼 401、失敗重試、重複事件去重、取消、發布 403 | 見 log；回呼/取消用 cpa3-B-20261117-8702dfae5e |
| live 模式 → blocked：`canon_character_not_approved_for_live:MZ_003`、`live_blocked:live_providers_not_enabled` | cpa3-A-20261117-cb3e140bf1 |
| `GET /api/provider/balance` → 503 `provider_key_missing` | — |
預算：production-mock spent 22 mock credits、production-live 0 枚。

## 6. CANON 同步統計
- 來源：Google Sheet `1qvEJtoNPUjzBmwbpNQ09PJCc9MChvLx20JS8lDGJuuY`（檔名「貓掌江湖試算表」，內容《貓掌江湖》中央資料庫 v3，最後修改 2026-11-05），Drive connector **唯讀** read_file_content，未改動 Sheet。
- 同步時間 2026-11-17 11:24（台北時間）。
- 46 列收到 / 46 列匯入 / live 核准 **0** / mock 可用 **3**（MZ_003、MZ_004、MZ_005）/ 非母喵拒絕 0 / 格式錯誤 0。
- 使用欄位：角色總表 `character_id, canonical_name, gender, canon_status, costume_lock, weapon_lock`（列號＝sheet_row）；Master總控 `角色ID, Master資產ID, 外部模型可讀, 製片准入（公式）`；圖片素材 `asset_id, character_id, asset_type, url, approved`。
- 每列存 sheet_id、分頁、列號、synced_at、不核准原因（approval_reasons）。

## 7. Live 實測狀態
| 項目 | 結果 |
|---|---|
| live jobId | 無（未建立付費任務） |
| provider task id | 無 |
| 餘額前 / 後 / 消耗 | 無法查詢（無金鑰）/ — / **0** |
| 結果檔 | 無 |
| 影格 QA | 無 |
Live 程式已部署但 `LIVE_PROVIDERS_ENABLED="false"`，未設定 `OWNER_LIVE_APPROVAL_ID`、`RUNNINGHUB_API_KEY`。

### 要跑那一次 live 需要的條件（全部要有）
1. 老闆提供 RunningHub API key（以隱藏表單交給 5F，存 `/home/box/secrets`，mode 600，用 `wrangler secret put RUNNINGHUB_API_KEY --env production` 設定）。
2. 在 CANON Sheet 讓一位角色真正放行：Master總控「製片准入」改成開放值（例如「可製片」）、圖片素材 approved=TRUE、Master 網址是外部可直接讀的圖片網址（不是 Drive 檢視頁；可放 R2 或公開圖床），「外部模型可讀」填可讀。改完我重新唯讀同步。**我不會改 Sheet。**
3. 之後才流程：查餘額（≥350 枚才送）→ 開 `LIVE_PROVIDERS_ENABLED` → 建 A 線 5 秒 live 任務 → `live-approve` 記錄老闆核准 → 唯一一次送出 → 輪詢 → 存 R2 與 `live-test/` → 抽影格自查 → 關閉 live。

## 8. Live-verified vs mock-only
- 線上實測（真的在 production 跑過）：health、驗證、四線 mock 全流程、冪等、CANON 閘門（含正式 Sheet 資料）、時長、預算、回呼簽章/去重、重試、取消、發布阻擋、live 阻擋（環境開關 + CANON）、provider 金鑰缺失時 fail-closed、CANON 同步。
- 只在測試（mocked fetch）驗證：RunningHub 餘額查詢、上傳、建立任務、輪詢、R2 存檔、費用紀錄、全域上限。
- 未實作：PixVerse live adapter、n8n、發布器（發布閘門永遠關閉）。

## 9. 回滾
```bash
cd /workspace/catpaw-alchemy-studio-v3
npx wrangler rollback --env production                  # production 回上一版（目前只有一版）
npx wrangler delete --name catpaw-alchemy-v3            # 撤下 production，使用者改用 staging 網址
npx wrangler d1 delete catpaw-alchemy-v3
npx wrangler r2 bucket delete catpaw-alchemy-v3-assets
```
（刪除為不可逆，須老闆同意。）Staging 未動，可直接當備援。

## 10. 需要老闆決定 / 提供
1. RunningHub API key（或 PixVerse key，若要改用 PixVerse 需另寫 adapter）。
2. 在 CANON Sheet 放行一位角色並提供外部可讀的 Master 圖網址（或同意把核准 Master 圖放到 R2 公開讀取）。
3. 上述完成後，確認仍要跑那一次 5 秒 live 測試。
