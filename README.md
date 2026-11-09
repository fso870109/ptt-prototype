# 一鍵對講 PTT 原型（第二階段・網頁版）

**線上測試網址：https://ptt-prototype.onrender.com**　·　**公司後台：https://ptt-prototype.onrender.com/admin**　·　**平台後台：https://ptt-prototype.onrender.com/platform**　·　**調度台：https://ptt-prototype.onrender.com/dispatch**
（Render 免費方案，新加坡機房）

對標 Zello 的 Push-to-Talk 網頁原型，行動裝置優先、可加到主畫面（PWA），介面為繁體中文。
**語音只做即時轉發、不保存錄音**（伺服器不寫磁碟、不留在記憶體）。

## 功能
### 第一階段（維持）
- 頻道對講、線上成員、按住講話（觸控／滑鼠／電腦空白鍵），約 100ms 一包即時串流。
- 伺服器端 floor control：同一頻道／私訊同時只有一人能講；放開、斷線、斷流 3 秒或超過 60 秒自動釋放。
- 一對一私人對講（點成員）；對方不在線時無法發話（沒有留言）。
- 「最近說話：誰 · 幾點 · 幾秒」純文字狀態；iOS 音訊解鎖、連線燈號、自動重連。

### 第二階段（新增）
1. **帳號登入與管理後台**
   - 公司代碼＋帳號＋密碼登入（原生 App 同樣要帶公司代碼，見 `docs/API.md`）；密碼用 **scrypt**（Node 內建 `crypto.scryptSync`，N=16384，隨機 salt）雜湊保存。
   - 登入後拿到隨機 token（30 天），伺服器只存 token 的 SHA-256。WebSocket 與 API 都要帶 token；未登入一律拒絕。登入錯誤 10 次鎖 10 分鐘。
   - 角色：**平台管理員**（`admin`）／**公司管理員**（`org_admin`）／**調度員**／一般使用者。公司後台 `/admin` 可：建立使用者（可自動產生密碼，只顯示一次）、改名、重設密碼（舊登入立即失效）、停用／啟用（立即踢下線）、刪除、設定身分（公司管理員／調度員／使用者，不能把帳號設成平台管理員）；建立／刪除頻道（大廳不可刪）、設定開放／封閉、指派成員與頻道角色；查看與解除警報。
   - 頻道與私人對講都以**帳號身分**檢查權限：封閉頻道只有被指派的人（與管理員）看得到、進得去；權限被拿掉時會立即被移回大廳。
   - 第一個**平台管理員**由環境變數 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 建立；之後若環境變數的密碼改了，重啟時會以環境變數為準（忘記密碼時的救援方式）。平台管理員登入時可填公司代碼（預設 `DEMO`）進入該公司後台，或填 `PLATFORM` 進入平台後台。
2. **即時位置地圖與電量**
   - 「地圖」分頁，打開「分享我的位置與電量」開關並同意瀏覽器定位權限後才會回報（每 30 秒一次＋移動時，最快 15 秒一次）。
   - 電量用 Battery Status API：Android Chrome／桌面 Chrome 可用；**iOS Safari 不支援，顯示「不明」**。
   - 地圖用 **Leaflet 1.9.4（放在本 repo `public/vendor/leaflet`，BSD-2 授權）＋ OpenStreetMap 圖磚**，右下角標示「© OpenStreetMap 貢獻者」。只在使用者打開地圖時載入圖磚，不預先下載、不大量抓取，符合 [OSM 圖磚使用政策](https://operations.osmfoundation.org/policies/tiles/)；若之後使用量變大應改用付費圖磚服務或自架。
   - 伺服器**只在記憶體保留每人最新一筆位置**（不做軌跡、不存歷史、不寫資料庫），重啟即消失；關掉開關會立即刪除。
   - 可見範圍：同一公司內，平台／公司管理員與調度員看全體；一般成員只看**目前在同一頻道**的人。不同公司彼此看不到。
3. **頻道角色與優先搶話**
   - 角色：**主管**（可講、優先權 3）、**一般**（可講、優先權 2）、**只聽**（不能按講）。開放頻道未指派的人＝一般；管理員與調度員未被指派時＝主管。
   - 伺服器端判斷：優先權較高者按下可**中斷**較低者，被中斷者畫面提示「你的發話被 ○○ 中斷」；同等或較低者按下會看到「○○ 正在說話」。
4. **緊急警報**
   - 紅色按鈕需**長按 2 秒**才會送出（放開取消，防誤觸）。
   - 廣播給**所有在線管理員、調度員＋同頻道成員**：全螢幕閃爍警示、警示音（Web Audio 產生）、震動、發送者姓名、頻道、當下位置與 OpenStreetMap 地圖連結（無定位時顯示「不明」）。
   - 警報期間發送者取得**最高發話權（優先權 100）**，連「只聽」角色也能講，並可中斷主管。
   - 管理員與調度員可在對講畫面、調度台或後台**解除警報**；發送者也可以自行取消。警報只存在記憶體，不保存錄音。

### 網頁調度台
- 平台管理員（進入該公司後）、公司管理員或調度員開啟 `/dispatch`（為電腦大螢幕設計：左側多頻道監聽、中間大對講鍵、右側來電佇列，下方嵌入地圖與緊急警報面板）。
- 可同時監聽多個有權限的頻道：每個頻道可勾選收聽、靜音、調音量，並顯示誰正在講。
- 選頻道或接聽後來電即可對講（大按鈕，電腦也可按住空白鍵講話）。
- 一般使用者在對講畫面按「呼叫調度台」，來電進入**所有在線調度員共用的佇列**；調度員接聽後轉成一對一，並可轉接給其他在線調度員。
- 佇列只存在伺服器記憶體，不保存錄音。
- 一般使用者開啟 `/dispatch` 會看到權限不足提示。

### 文字與照片
- 頻道與一對一可送文字（最長 2000 字）與照片。
- 網頁端會先壓縮：長邊不超過 1280，JPEG／WebP，盡量壓到約 200KB 以內；伺服器拒絕超過 220KB 或非 JPEG/WebP/PNG 的檔案。
- 文字與照片存在 Postgres（本機則 `data/chat.json` + `data/photos/`）。**語音仍然不保存。**
- 照片保留 **7 天**；全部照片合計超過 **300MB** 時由舊到新自動刪除（啟動時與每小時清理）。免費 Postgres 總容量 1GB。
- 讀取照片必須登入，且要有該頻道或該則私訊的權限（未登入 401，沒權限 403）。
- API 詳見 [`docs/API.md`](docs/API.md)。


### 多公司分開使用與收費佔位
- 既有資料會自動遷到預設公司（代碼 `DEMO`、名稱「預設公司」）。之後每個使用者、頻道、地圖位置、警報、文字／照片、調度佇列都依公司隔離；不同公司可以使用相同帳號名稱。
- 登入必須帶**公司代碼**（JSON 欄位 `org` 或 `orgCode`）。公司被停用回 `403 org_disabled`；方案到期回 `403 org_expired`，該公司使用者會被踢下線。
- 平台後台 `/platform`（僅平台管理員）：建立／停用／刪除公司（預設公司不能刪，只能停用）、指定公司管理員、調整方案與座位數、**手動標記已付款**以延長到期日。
- 方案與金額（免費 0／10 人、標準月費 990／年費 9900、專業月費 2990／年費 29900，新台幣）都是**可在平台後台調整的範例佔位值**，標示 `example: true`，**不是正式報價**。本原型**沒有**接綠界、Stripe 或其他需要商店帳號的真實金流。
- `POST /api/billing/checkout` 固定回 `{ "ok": false, "error": "not_connected", "example": true }`，並帶入該方案的範例金額；客戶若已另外付款，由平台管理員按「標記已付款」。
- 人數上限依該公司的 `seatLimit`（未另外設定時跟方案走）；超過回 `403 seat_limit`。免費方案預設不過期；付費方案新建時給 14 天試用。
- 照片總配額 300MB 目前仍是全站共用（各公司尚未分開計算），這是已知限制。


### 即時語音轉文字
- 講話時，若瀏覽器支援 **Web Speech API**，會用 `zh-TW` 即時辨識，並把字幕文字廣播給同頻道／同一通對講的人（含正在監聽的調度員）。
- **伺服器不保存、也不轉送語音去做辨識**；只傳遞文字。伺服器端 STT 僅保留 `lib/stt.js` 的可插拔空介面（回 `not_implemented`），沒有接任何付費或需要 API 金鑰的雲端服務。
- 公司管理員可在後台打開「把最終字幕存成文字紀錄」：只有辨識完成的句子會以 `kind: "caption"` 的文字訊息保存，語音本身永不保存。預設關閉。
- 不支援的瀏覽器（常見於 **Firefox** 與部分 **iOS Safari**）會看到說明文字，對講功能不受影響，只是沒有字幕。
- Chrome／Edge 的 Web Speech API 可能會把聲音送到瀏覽器廠商的辨識服務；這不是本伺服器，請在隱私需求高的場合改用系統內建／裝置端辨識的原生 App（送字幕文字即可，見 `docs/API.md`）。
- 同時開麥克風對講與瀏覽器語音辨識，少數裝置可能較不穩或需要再允許一次權限。

## 架構
```
手機瀏覽器 ──WebSocket /ws（hello 帶 token）──▶ Node.js 伺服器 ──▶ 同頻道／私訊的線上成員
   │  JSON：join / ptt_start / ptt_stop / loc / alert_start / alert_resolve / listen / dispatch_* / chat / caption …
   │  二進位：16kHz 16-bit PCM（每包約 100ms），伺服器加 streamId 後轉發即丟棄
   └──HTTP：/api/login（需公司代碼）、/api/me、/api/locations、/api/alerts、/api/messages、/api/photos、/api/admin/*、/api/platform/*、/api/billing/checkout、靜態檔（含 /dispatch、/platform）
記憶體：線上狀態、floor、最近說話者、位置（最新一筆）、警報
資料庫：公司、方案佔位、帳號（雜湊密碼）、頻道、成員角色、登入 session —— 沒有任何音訊／位置／警報
```
- 持久化（`lib/store.js`）：有 `DATABASE_URL` 時用 **Postgres**（一張表 `ptt_state`，整份狀態存成一列 JSONB）；沒有時用 `data/db.json`（本機開發用）。
- 依賴：`ws`、`pg`；前端純 HTML/CSS/JS，Leaflet 放在 `public/vendor`。

## 雲端部署（Render）與持久化
| 資源 | 方案 | 說明 |
|---|---|---|
| Web Service `ptt-prototype` | free | Node，`npm ci` / `node server.js`，健康檢查 `/api/health` |
| Postgres `ptt-prototype-db` | free | 存公司、方案佔位、帳號、頻道、角色、session |

環境變數：`ADMIN_USERNAME`、`ADMIN_PASSWORD`（不放在 repo）、`DATABASE_URL`（由 `render.yaml` 的 `fromDatabase` 帶入）。可選 `PLATFORM_ORG_CODE`（預設 `PLATFORM`）作為平台管理員登入用的代碼。

### 免費方案限制（重要）
- **Free Postgres 30 天後到期**：本資料庫建立於 2026-11-10，**2026-12-10 00:48（台北時間）到期**；到期後有 14 天寬限期可升級成付費方案，之後 Render 會**刪除資料庫與所有資料**。Free Postgres 也**沒有備份**，Render 可能隨時維護重啟；每個 workspace 只能有一個 free Postgres，容量 1 GB。
  - 到期前若要繼續免費使用：建新的 free Postgres、把 `ptt_state` 那一列匯出再匯入（或重新建立帳號），並更新 `DATABASE_URL`。
  - 如果資料庫不可用或沒設 `DATABASE_URL`，伺服器會改用容器內的 `data/db.json`：**重新部署、重啟或休眠後帳號與頻道都會消失**，只剩環境變數建立的管理員與「大廳」。
- **Web Service 閒置 15 分鐘會休眠**，下一個人打開要等約 1 分鐘喚醒；每月 750 免費小時、頻寬有上限。
- 本 repo 推送到 GitHub 後 **Render 不會自動部署**（Render 帳號沒有連結 GitHub），需在 Render 後台或用 API 手動部署。

## 檔案
| 路徑 | 說明 |
|---|---|
| `server.js` | HTTP + WebSocket、floor control（優先權）、位置、警報、聊天／照片、調度監聽與佇列、多公司隔離、後台 API |
| `lib/store.js` / `lib/auth.js` | 持久化（Postgres / JSON）、密碼雜湊與 token |
| `lib/orgs.js` / `lib/billing.js` | 公司遷移與方案預設、金流佔位回應 |
| `lib/stt.js` | 伺服器端 STT 佔位介面（預設不實作、不處理音訊） |
| `public/index.html` `app.js` `style.css` | 對講 App（PWA） |
| `public/admin.html` `admin.js` `admin.css` | 公司後台 |
| `public/platform.html` `platform.js` | 平台後台 |
| `public/dispatch.html` `dispatch.js` `dispatch.css` | 網頁調度台 |
| `public/vendor/leaflet/` | Leaflet 1.9.4 |
| `render.yaml` | Render Blueprint（web service + free Postgres） |
| `docs/API.md` | 供原生 App 使用的協定說明 |
| `lib/media.js` | 文字／照片儲存與 7 天／容量清理 |
| `test/e2e.js` | 協定層測試（多帳號；登入、後台、權限、優先搶話、位置、警報、文字／照片、調度台、多公司隔離／座位／到期／金流佔位、即時字幕、不保存錄音） |
| `test/browser_e2e.py` | 真實瀏覽器測試（Chromium + 假麥克風 + 模擬定位） |

## 本機啟動
```bash
npm install
ADMIN_USERNAME=admin ADMIN_PASSWORD='至少8字元的密碼' node server.js      # 預設埠 8800，資料存 data/db.json
# 要用 Postgres：再加 DATABASE_URL=postgres://...
```
麥克風與定位都需要 **HTTPS**（或 localhost）。

### 測試
```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=... node test/e2e.js http://localhost:8800 --data-dir=./data
ADMIN_USERNAME=admin ADMIN_PASSWORD=... python3 test/browser_e2e.py http://localhost:8800
```
測試會自己建立 `t_` 開頭的帳號與頻道，結束時刪除。

## 建議測試方式（兩支手機或手機＋電腦）
1. 電腦打開 `/admin`，用公司代碼 `DEMO` 與平台管理員登入（或先到 `/platform` 建立公司），建立 2–3 個使用者（密碼可留空自動產生），建立一個頻道並指派角色（例如 A＝主管、B＝一般、C＝只聽）。手機登入時同樣要填公司代碼。
2. 手機各自用帳號登入對講頁，切到該頻道：B 按住講話時 C 只能聽；A 按下會中斷 B，B 畫面會提示。
3. 「地圖」分頁打開分享開關並允許定位：彼此看得到位置、電量（iPhone 顯示「不明」）、更新時間。
4. 長按紅色「緊急警報」2 秒：同頻道與管理員畫面出現全螢幕警示與警示音；在後台或對講頁用管理員解除。
5. 電腦打開 `/dispatch`（管理員或另建一個「調度員」帳號）：可同時聽多個頻道、看誰在講、調各頻道音量。一般使用者按「呼叫調度台」後，調度員從來電佇列接聽即變一對一，並可轉接給其他在線調度員。
6. iPhone：第一次要點畫面一下啟用聲音；建議關掉靜音鍵。

## 已知限制
- **背景／鎖屏收不到、也不會回報位置**：網頁在 iOS 鎖屏或切到背景後 WebSocket 與定位都會暫停。要像 Zello 一樣，必須做原生 App（iOS PushToTalk framework、Android 前景服務）。
- **沒有留言**：不在線或斷線時講的話會直接錯過。
- **位置、警報與調度台佇列只在記憶體**：伺服器重啟／休眠後消失；警報期間若伺服器重啟，警報會遺失，需重新發出。
- 警示音由網頁播放，手機靜音／鎖屏時可能聽不到；iOS 不支援震動。
- iOS 音訊：麥克風開著時可能走聽筒、音量變小；尚未在實機 iPhone 驗證。
- 頻寬：PCM 約 32 KB/s，尚未做 Opus 壓縮。
- 單一 Node 程序；整份狀態存成一列 JSONB，適合幾十～幾百個帳號的測試規模，不適合正式上線。
- 收費只是佔位：沒有真實金流、發票或自動續約；到期後需平台管理員手動標記已付款。
- 照片 300MB 配額目前全站共用，尚未依公司分開計算。
- 即時字幕依瀏覽器 Web Speech API，不是我們自己的辨識引擎；不支援的瀏覽器沒有字幕。Chrome 可能把聲音送到 Google。
- 沒有雙因素驗證、沒有密碼找回信；token 存在瀏覽器 localStorage。
