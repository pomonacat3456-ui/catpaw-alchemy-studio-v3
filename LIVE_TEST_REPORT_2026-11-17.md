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
