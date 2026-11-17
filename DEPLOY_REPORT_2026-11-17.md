# 貓掌鍊金術 3.0 部署報告（Staging）· 2026-11-17

負責：5F 鐵璃喵工程師　　指派：老闆經 9F 縛嵐姑娘喵總（2026-11-17 10:00 台北時間）
**性質：全新重建（fresh rebuild），不是原 ZIP 還原。** 原 `catpaw-alchemy-studio-v3-mock.zip` 找不到，依交接規格從頭寫。
**全程 mock:true / paid:false / published:false；沒有呼叫任何真實 provider、沒有花錢、沒有發布、沒有動正式系統。**

## 1. Repo
| | 網址 | Commit |
|---|---|---|
| GitHub（主，CI 綠） | https://github.com/pomonacat3456-ui/catpaw-alchemy-studio-v3 （public，帳號 pomonacat3456-ui） | 程式 commit `258da82e71ae08809f8a4b15f653e88f470ee4cd`；本報告另以下一個 commit 加入 |
| GitLab（備，CI 綠） | https://gitlab.com/gogototo24/catpaw-alchemy-studio-v3 （private，project id 89036357，新建） | 同上 `258da82e71ae08809f8a4b15f653e88f470ee4cd` |

兩邊內容完全相同（同一個 git 歷史，push 到兩個 remote）。CI：
- GitHub Actions run 44001661085：success，45/45 tests
- GitLab pipeline 3076950860：success，45/45 tests
兩邊都跑得順；建議 GitHub 當主、GitLab 當備（GitLab 為 private，GitHub 為 public）。

## 2. Staging 環境（全新隔離資源）
- Worker：`catpaw-alchemy-v3-staging`（Cloudflare 帳號 gogototo24@gmail.com，Workers Free）
- 網址（9:16 手機總控台）：https://catpaw-alchemy-v3-staging.gogototo24.workers.dev/
- Health：https://catpaw-alchemy-v3-staging.gogototo24.workers.dev/health
- Worker version id：`c8302bdf-0991-4964-b6fc-bd7e1a06ca39`（部署於 2026-11-17 10:13 台北時間）
- D1：`catpaw-alchemy-v3-staging`（id de174b2d-7cce-409b-9945-1323adeabf86），migrations `0001_init.sql`、`0002_staging_fixtures.sql`（health 回報 schema_version=0002_staging_fixtures.sql）
- Secrets：`ADMIN_KEY`、`CALLBACK_HMAC_SECRET`（本機產生，存 `/home/box/secrets/catpaw_alchemy_v3_admin_key`、`..._callback_hmac_secret`，mode 600；以 `wrangler secret put` 設定，未印出、未進 repo）
- Cron：`*/30 * * * *` 逾時掃描（免費額度內）
- 未碰：threads-scheduler Worker / threads-scheduler-db / 任何既有 Worker、D1、R2、secret。停權帳號 gogototo24-lang 的 repo 未碰。

## 3. 測試
指令：`npm ci && npm run typecheck && npm test`（vitest 4.1 + @cloudflare/vitest-plugin，在 workerd + 本地 D1 跑，套用真實 migrations）
結果：**45 passed / 0 failed / 0 skipped**（本機、乾淨 clone、GitHub Actions、GitLab CI 四處一致）
涵蓋：CANON gate（未登錄/非母/未核准/缺或錯 Master URL/禁用詞、DB CHECK）、5s/15s 與格式、live/付費阻擋（live adapter fail-closed）、paid/published DB 鎖、SHA-256 冪等（同 key 同 job、只預留一次）、預算守衛與並發原子預留、單筆上限、取消釋放、重試到上限後失敗並釋放、失敗後可恢復、QA 不過退回、逾時掃描、偽造/篡改/過期/未簽回呼拒絕、回呼去重、舊 task id 回呼忽略、發布永遠 403、亂序動作 409、並發轉換只有一個成功且副作用只寫一次、四線完整流程。
另做了 mutation 檢查：放寬時長規則、拿掉轉換守衛時，對應測試確實會失敗。

## 4. 線上實測（curl，log：`verify/staging-curl-2026-11-17.log`，69/69 檢查通過）
| 項目 | 結果 | jobId |
|---|---|---|
| /health 200、mock:true/paid:false/published:false | ✅ | — |
| 錯誤管理金鑰 → 401 | ✅ | — |
| A 短影音：建立→預檢→排入→Mock 生成→簽章回呼→QA→審核→核准→交付→讀回 | ✅ delivered | cpa3-A-20261117-d671c3620f |
| B 寫真圖片：同上 | ✅ delivered | cpa3-B-20261117-ca2beed056 |
| C 音樂 MV：同上 | ✅ delivered | cpa3-C-20261117-aac7d9feb4 |
| D 長片漫劇：同上 | ✅ delivered | cpa3-D-20261117-c15f2bbe3d |
| 冪等：重送 A 線同內容 → 200、deduplicated:true、同一 jobId | ✅ | cpa3-A-20261117-d671c3620f |
| CANON：缺 Master URL / 未登錄主角 / 10 秒分段 → blocked；blocked 不能排入（409） | ✅ | 見 log |
| live 模式 → blocked（付費阻擋） | ✅ | 見 log |
| 偽造簽章 → 401、未簽 → 401、工作狀態不變 | ✅ | cpa3-B-20261117-55eca8b8af |
| provider 失敗 → 重試回 queued；同 event 重送 → duplicate:true；取消 → cancelled 並釋放額度 | ✅ | cpa3-B-20261117-55eca8b8af |
| 已交付工作發布 → 403 publish_blocked | ✅ | cpa3-A-20261117-d671c3620f |
| 預算（mock credits）：limit 200、reserved 0、spent 22、paid 0 | ✅ | — |
| 前端頁面 200、headless Chrome 截圖正常顯示 9:16 介面與 mock/paid/published 標籤 | ✅（登入後的按鈕操作走同一套 API，未另做瀏覽器自動化） | — |

重跑：`BASE=https://catpaw-alchemy-v3-staging.gogototo24.workers.dev scripts/verify-staging.sh`

## 5. 各產線狀態
| 產線 | Mock ready | 待設定 | 單筆可測 | live verified |
|---|---|---|---|---|
| A 短影音 | ✅ | RunningHub H3 live adapter、正式 CANON 資料 | ❌ | ❌ |
| B 寫真圖片 | ✅ | PixVerse live adapter、正式 CANON 資料 | ❌ | ❌ |
| C 音樂 MV | ✅ | RunningHub H3、音樂來源（ai-music-studio-v2）串接 | ❌ | ❌ |
| D 長片漫劇 | ✅ | RunningHub H3、多段尾幀續接實作 | ❌ | ❌ |

只有 Mock 的部分 / 待設定：
- CANON 角色是 **staging 測試夾具**（縛嵐喵/琉璃喵/白帝喵尊/待審角色，網址為 `.invalid`），尚未接 CANON Google Sheet v3。
- RunningHub H3 / PixVerse live adapter：只有 fail-closed 外殼，沒有任何 live HTTP 程式。
- n8n 編排、R2/Drive 素材儲存、CatPaw Editor 後製、YouTube/Threads 發布器：未接。
- 生成結果是 `mock://` 假網址，預覽框只是 9:16 佔位，不是真影片。
- 成本單位是 mock credits，不是金額。
- 沒有獨立 Cloudflare Pages 專案：前端用同一個 Worker 的 static assets 提供（免費、隔離，少一個資源）。

## 6. 回滾
```bash
cd /workspace/catpaw-alchemy-studio-v3
npx wrangler rollback                                   # 回到前一版（目前只有一版）
npx wrangler delete --name catpaw-alchemy-v3-staging    # 整個刪除 staging Worker（含 secrets、cron）
npx wrangler d1 delete catpaw-alchemy-v3-staging        # 刪除 staging D1
```
以上都只影響本次新建資源；正式系統沒有改動，不需回滾。刪除屬不可逆動作，需老闆同意才執行。

## 7. 需要老闆核准的事項
1. GitHub repo 是 **public**：程式碼已公開（不含任何密鑰）。若要改 private 請老闆決定。
2. 任何 live provider 單筆實測（會扣 RunningHub/PixVerse 額度）。
3. 接正式 CANON Sheet v3、正式網站/正式 Worker 上線、自訂網域。
4. 任何發布（YouTube/Threads）— 本版完全沒有發布路徑。
5. 若要把 GitHub token 範圍縮到只有本 repo（目前 token 可存取多個 repo）。
