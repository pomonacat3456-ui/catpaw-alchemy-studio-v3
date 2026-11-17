# 《貓掌鍊金術 3.0》單次 Live 測試報告（2026-11-17，時間皆為 Asia/Taipei）

- 授權：owner 11:11（一次 live 測試）＋ 11:50「用焚天赤焰喵測試，Master 可以放公開」
- 角色：MZ_003 焚天赤焰喵（CANON Sheet 未修改；Sheet gate 仍為「暫停製片」）
- 放行方式：D1 `canon_live_overrides` 單次覆寫 `ovr-b30f3836-…`，approver `owner 2026-11-17 11:50`，綁定單一 job，max_uses=1，11:55:40 已消耗（used_count=1），其他角色/其他 job 一律仍被擋。
- 公開 Master：`https://catpaw-alchemy-v3.gogototo24.workers.dev/public/canon/MZ_003-master.png`（僅 R2 `public/canon/` 前綴對外；其他 key 404；sha256 與 Drive 原檔一致 c776a094…1ac9）。Drive 分享設定未變更。

## Job
| 項目 | 值 |
|---|---|
| jobId | cpa3-A-20261117-16b8151ffd（A 線、live、runninghub-h3、5s、9:16） |
| provider task id | 2122539141694840833 |
| 第 1 次 run | 11:54 失敗於「付費前」：master_image_unreadable 404（Worker 無法 fetch 自己的 workers.dev 網域）。未呼叫 createTask、未扣點、override 未消耗、cap slot 已釋放。 |
| 修正 | 自家 `PUBLIC_ORIGIN/public/canon/*` 的 Master 改由 R2 直接讀取（新增測試） |
| 第 2 次 run（唯一允許的付費前重試） | 11:55:41 送出 → 12:02:10 成功（約 6.5 分） |
| 輸出 R2 | `live/cpa3-A-20261117-16b8151ffd/2122539141694840833.mp4`（需 admin key） |
| 輸出檔 | 768x1344、h264 24fps、5.17s、含 AAC 音軌、7.28 MB |
| 狀態 | 停在 `qa`（未 approve / deliver / publish） |

## 點數
- 送出前 698 coins；完成後（12:02、12:03 兩次查詢）仍為 698，`consume_coins` 為 null、balance_delta 0。
- 系統內以估算值 350 記 provider_charge（paid=1）。RunningHub 扣點可能延遲入帳，需之後再查。

## 影格 QA（人工目視，6 張 1.2fps）
- ✅ 母喵、單一角色、無真人/路人、無實體武器、火系術法（掌心火焰、火焰環）
- ✅ 與 Master 高度一致：長赤紅波浪髮、赤金火焰王冠、黑金赤紅女王戰袍、紅飄帶、金飾紅寶石、臉頰赤焰紋、赤金眼、白色長尾
- ✅ 直式 768x1344（4:7，接近 9:16；為 workflow 固定尺寸）
- ❌ 手部：多數影格為擬人手指＋紅指甲（僅最後一格有貓掌肉球）→ 違反「無人手」
- ❌ 臉/身形：擬人化半人臉、人形身材＋明顯乳溝 → 違反「無人臉」並有品牌風險
- ❌ 質感：偏動漫/數位繪畫，非布袋戲偶
- 結論：技術流程成功；CANON 風格 QA 不通過。根因主要繼承自 Master（Master 本身即擬人手與人形身材，Sheet 亦註記「乾淨Master QA未通過」）。

## 收尾
- 12:03 重新部署 LIVE_PROVIDERS_ENABLED="false"，刪除 OWNER_LIVE_APPROVAL_ID secret；/health `live_providers:false`、`live_gate_reason: live_providers_not_enabled`。
- 未發布任何內容；staging 未動。

## 補記（13:10 Asia/Taipei）：H3 實際扣點與 PixVerse 路線
- H3 task 2122539141694840833 實際以「點數方案」結算：`/openapi/v2/query` usage `settleMode=POINT`、`chargedPoint=54.23`，RH幣 0、錢包 $0（owner 帳單截圖一致）。accountStatus 同帳號（apiType=NORMAL 消費級-會員 key），`remainPoint`=點數池、`remainCoins`=RH幣（獨立池）、`remainMoney`=錢包。
- 已修正 production D1：該 job 的 provider_charge = 54.23，scope `runninghub_points`；provider_meta 加 settle_mode/charged_point。
- 程式：NORMAL key 的餘額檢查改用 `remainPoint`（LIVE_POINTS_5S 預設 60）；API 若不回 remainPoint 則 fail-closed，除非 owner 提供 `LIVE_MANUAL_POINTS_BALANCE`。完成時記錄 chargedPoint / point_delta。
- PixVerse：RunningHub 有 `POST /openapi/v2/pixverse-v6/image-to-video`（標準模型 API），但官方文件明定「模型 API 僅支援企業級-共享 API Key」（錯誤碼 1014），計費走錢包；本 key 為 NORMAL、錢包 $0 → 不可用。PixVerse 原生 OpenAPI 需要 PIXVERSE_API_KEY（box 上沒有）。已實作原生 adapter（mock 測試），未送出任何 PixVerse 任務。
- A 線 prompt builder a-line-v2：貓掌肉球、貓臉、全母喵、布袋戲偶材質、端莊服裝，negative prompt 獨立欄位。

## PixVerse 單次測試（14:07 owner 授權，時間 Asia/Taipei）
- 部署 cee74e3 → version 7f91f238（live false）；PIXVERSE_API_KEY 以 production secret 設定。
- 單次覆寫 `ovr-d5c1c7b1-…`（approver `owner 2026-11-17 14:07`），已於送出前消耗（used_count=1）。
- jobId `cpa3-A-20261117-a24722d2ed`，PixVerse video_id `435760615055773`；v6-max、540p、5s、9:16、無音訊；prompt builder a-line-v2（含 negative_prompt）。
- 14:14:51 送出 → 14:16:21 完成；14:15:13 已關 live（/health live_providers:false），OWNER_LIVE_APPROVAL_ID 已刪除。
- PixVerse 點數：送出前 570 → 完成後 525，實扣 45（API 回報 45；估算 35 偏低，預設已改為 45）。D1 provider_charge=45，scope pixverse-credits。
- 輸出：592x1024（≈9:16）h264 24fps 5.04s、無音軌；R2 `live/cpa3-A-20261117-a24722d2ed/435760615055773.mp4`。

### QA（6 格 1.2fps，人工目視）：FAIL
- ✅ 後半（f_04–f_06）：正面抬起「真貓掌＋粉色肉球」、貓臉（貓鼻、鬍鬚、尖耳）明顯改善、火焰環、無實體武器、單一母喵、王冠/赤髮/黑金赤紅袍與 Master 一致。
- ❌ 前半（f_01–f_03）沿用 Master 起始姿勢：擬人手指＋紅色長指甲（f_01、f_03），f_04–f_06 肉球上仍有紅色尖爪。
- ❌ 服裝不端莊：f_01 明顯乳溝、f_01/f_03 高衩露腿。
- ❌ 質感偏數位繪畫／動漫，非布袋戲偶。
- 根因：image-to-video 以 Master 為第一幀，Master 本身即擬人手、低胸高衩；prompt 只能改善後段動作。要通過需先產出符合規範的新 Master（貓掌、端莊服裝、偶質感）。

### Owner 覆核（14:23 Asia/Taipei）：通過
- owner（card t128s575）：「這支直接過關，人手也沒關係」；先前 t128u：「很好啊，她就是火紅的辣」。
- owner 接受 MZ_003 此支影片的較暴露服裝與擬人手，覆蓋內部 QA FAIL。
- job `cpa3-A-20261117-a24722d2ed` 經正常 admin 路徑 qa → review → approved（approver `owner 2026-11-17 14:23`），另記 `owner_qa_override` 事件。未發布、未 deliver、live 維持關閉、CANON Sheet 未修改。

## Line B automation — MZ_003 焚天赤焰喵 (owner 14:26 「B線也測自動化」)

Pipeline per run: balance check (RunningHub plan 點數) → single-use CANON override (approver `owner 2026-11-17 14:26`) → create live B job → live-approve → enqueue → paid submit → poll → download → R2 `live/<job>/<task>.png` → automated technical QA (decodable PNG/JPEG/WebP, ≥10 KB, short side ≥512, 9:16 ±3 %) → `review`. Per the owner, costume and human-like hands are accepted, so the automated check is technical only. Nothing was delivered or published.

| run | job | provider | result | 點數 charged | balance before → after |
|---|---|---|---|---|---|
| 1 | cpa3-B-20261117-2b3fbe57c4 | runninghub-nb (全能图片V1 / Nano Banana) | provider 805 content-guideline rejection | 0 | 17587.77 → 17587.77 |
| 2 | cpa3-B-20261117-2750725745 | runninghub-nb (tasteful prompt) | 805 rejection | 0 | 17587.77 → 17587.77 |
| 3 | cpa3-B-20261117-edec63783a | runninghub-nb (neutral background-only prompt) | 805 rejection, so the Master image itself is rejected | 0 | 17587.77 → 17587.77 |
| 4 | cpa3-B-20261117-ba01931334 | runninghub-qwen (Qwen Image Edit2509 app 1977675852563513346) | review, 1536×2728 PNG | 20.74 | 17587.77 → 17567.03 |
| 5 | cpa3-B-20261117-6c858983a9 | runninghub-qwen | review, 768×1360 PNG | 22.95 | 17567.03 → 17544.08 |
| 6 | cpa3-B-20261117-23322f2b5a | runninghub-qwen | review, 768×1360 PNG | 19.21 | 17544.08 → 17524.87 |

Fixes: the provider failure reason was `[object Object]` and now shows the readable node and message. The default B provider is now Qwen Image Edit2509, because Nano Banana rejects this Master. Line B has one total cap across B providers.

Observations for human review: Qwen keeps the Master pose almost unchanged. Run 4 barely changed the scene. In run 5 the hair drifted to white (CANON drift), which the technical QA does not catch. Run 6 is closest to the brief.

Budget: `production-live-b` reserved 60 is held by design until deliver/commit. The 3 jobs are in `review`.

Live was turned off afterwards. The plain production redeploy set LIVE_PROVIDERS_ENABLED to false and LIVE_MAX_SUBMISSIONS_B to 0, OWNER_LIVE_APPROVAL_ID was deleted, and /health showed live_providers:false.

## Line A automation — MZ_003 焚天赤焰喵, PixVerse (owner t129u 「自動可以跑完就好」, t130u 「沒有上限，測順來」)

Runner: `tools/autorun.py A <n> ...`. Each run does a PixVerse balance check, creates a single-use override (approver `owner 2026-11-17 14:47`), creates the job (a-line-v2, v6-max, 540p, 5s, 9:16, no audio), then live-approves, enqueues and submits. The Worker polls, downloads, stores the clip in R2, and runs the **automated technical video QA**: mp4 box probe (ftyp/moov/mvhd/tkhd), duration 5s ±0.6, 9:16 ±4 %, short side ≥512, provider ok. A pass goes to `review`; a fail goes to `failed` with no paid retry. Costume and hands are not blocking.

| run | job | task | result | credits | balance before → after |
|---|---|---|---|---|---|
| 1 | cpa3-A-20261117-f94e203f57 | 435765194621330 | review; 592×1024, 5.04 s | 45 | 525 → 480 |
| 3 | cpa3-A-20261117-99c34486a5 | 435765448253883 | review; 592×1024, 5.04 s | 45 | 480 → 435 |
| 4 | cpa3-A-20261117-0c746fbdca | 435765652648096 | review; 592×1024, 5.04 s | 45 | 435 → 390 |

Run 1 was first created during the deploy propagation window and came back `blocked: live_providers_not_enabled` (no paid call). It was re-preflighted with its bound override and then ran.

Run 2 (cpa3-A-20261117-f55e4d5e5f) was blocked because the override was still bound to run 1. It was cancelled with no paid call and no charge.

The runner now checks `/health` live_providers before it creates an override.

Fixes: the `production-live` internal ledger limit went from 400 to 2000 (migration 0006). Held reservations (H3 350 + PixVerse 35, kept until deliver) had blocked enqueue. This is a ledger only; the real guard is the provider balance.

Palette sanity (`tools/palette_check.py`) is non-blocking:
- How it works: rembg mask, then the head/hair band (top 35 % of the character), comparing the saturated-red share with the near-white share. For video it takes the median over 5 frames.
- It flags B run5 (white hair: red 0.456, white 0.121).
- It passes all the other B stills and A clips (A runs: red 0.757 / 0.805 / 0.739).

Live was turned off afterwards. The plain production redeploy set live_providers to false, OWNER_LIVE_APPROVAL_ID was deleted, and the 3 clips are in `review` (not delivered or published).
