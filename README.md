# 一鍵對講 PTT 原型（第二階段・網頁版）

**線上測試網址：https://ptt-prototype.onrender.com**　·　**管理後台：https://ptt-prototype.onrender.com/admin**
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
   - 帳號＋密碼登入；密碼用 **scrypt**（Node 內建 `crypto.scryptSync`，N=16384，隨機 salt）雜湊保存。
   - 登入後拿到隨機 token（30 天），伺服器只存 token 的 SHA-256。WebSocket 與 API 都要帶 token；未登入一律拒絕。登入錯誤 10 次鎖 10 分鐘。
   - 角色：**管理員**／一般使用者。後台 `/admin` 可：建立使用者（可自動產生密碼，只顯示一次）、改名、重設密碼（舊登入立即失效）、停用／啟用（立即踢下線）、刪除、設為管理員；建立／刪除頻道（大廳不可刪）、設定開放／封閉、指派成員與頻道角色；查看與解除警報。
   - 頻道與私人對講都以**帳號身分**檢查權限：封閉頻道只有被指派的人（與管理員）看得到、進得去；權限被拿掉時會立即被移回大廳。
   - 第一個管理員由環境變數 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 建立；之後若環境變數的密碼改了，重啟時會以環境變數為準（忘記密碼時的救援方式）。
2. **即時位置地圖與電量**
   - 「地圖」分頁，打開「分享我的位置與電量」開關並同意瀏覽器定位權限後才會回報（每 30 秒一次＋移動時，最快 15 秒一次）。
   - 電量用 Battery Status API：Android Chrome／桌面 Chrome 可用；**iOS Safari 不支援，顯示「不明」**。
   - 地圖用 **Leaflet 1.9.4（放在本 repo `public/vendor/leaflet`，BSD-2 授權）＋ OpenStreetMap 圖磚**，右下角標示「© OpenStreetMap 貢獻者」。只在使用者打開地圖時載入圖磚，不預先下載、不大量抓取，符合 [OSM 圖磚使用政策](https://operations.osmfoundation.org/policies/tiles/)；若之後使用量變大應改用付費圖磚服務或自架。
   - 伺服器**只在記憶體保留每人最新一筆位置**（不做軌跡、不存歷史、不寫資料庫），重啟即消失；關掉開關會立即刪除。
   - 可見範圍：管理員看全體；一般成員只看**目前在同一頻道**的人。
3. **頻道角色與優先搶話**
   - 角色：**主管**（可講、優先權 3）、**一般**（可講、優先權 2）、**只聽**（不能按講）。開放頻道未指派的人＝一般；管理員未被指派時＝主管。
   - 伺服器端判斷：優先權較高者按下可**中斷**較低者，被中斷者畫面提示「你的發話被 ○○ 中斷」；同等或較低者按下會看到「○○ 正在說話」。
4. **緊急警報**
   - 紅色按鈕需**長按 2 秒**才會送出（放開取消，防誤觸）。
   - 廣播給**所有在線管理員＋同頻道成員**：全螢幕閃爍警示、警示音（Web Audio 產生）、震動、發送者姓名、頻道、當下位置與 OpenStreetMap 地圖連結（無定位時顯示「不明」）。
   - 警報期間發送者取得**最高發話權（優先權 100）**，連「只聽」角色也能講，並可中斷主管。
   - 管理員可在對講畫面或後台**解除警報**；發送者也可以自行取消。警報只存在記憶體，不保存錄音。

## 架構
```
手機瀏覽器 ──WebSocket /ws（hello 帶 token）──▶ Node.js 伺服器 ──▶ 同頻道／私訊的線上成員
   │  JSON：join / ptt_start / ptt_stop / loc / alert_start / alert_resolve …
   │  二進位：16kHz 16-bit PCM（每包約 100ms），伺服器加 streamId 後轉發即丟棄
   └──HTTP：/api/login、/api/me、/api/locations、/api/alerts、/api/admin/*、靜態檔
記憶體：線上狀態、floor、最近說話者、位置（最新一筆）、警報
資料庫：帳號（雜湊密碼）、頻道、成員角色、登入 session —— 沒有任何音訊／位置／警報
```
- 持久化（`lib/store.js`）：有 `DATABASE_URL` 時用 **Postgres**（一張表 `ptt_state`，整份狀態存成一列 JSONB）；沒有時用 `data/db.json`（本機開發用）。
- 依賴：`ws`、`pg`；前端純 HTML/CSS/JS，Leaflet 放在 `public/vendor`。

## 雲端部署（Render）與持久化
| 資源 | 方案 | 說明 |
|---|---|---|
| Web Service `ptt-prototype` | free | Node，`npm ci` / `node server.js`，健康檢查 `/api/health` |
| Postgres `ptt-prototype-db` | free | 存帳號、頻道、角色、session |

環境變數：`ADMIN_USERNAME`、`ADMIN_PASSWORD`（不放在 repo）、`DATABASE_URL`（由 `render.yaml` 的 `fromDatabase` 帶入）。

### 免費方案限制（重要）
- **Free Postgres 30 天後到期**：本資料庫建立於 2026-11-10，**2026-12-10 00:48（台北時間）到期**；到期後有 14 天寬限期可升級成付費方案，之後 Render 會**刪除資料庫與所有資料**。Free Postgres 也**沒有備份**，Render 可能隨時維護重啟；每個 workspace 只能有一個 free Postgres，容量 1 GB。
  - 到期前若要繼續免費使用：建新的 free Postgres、把 `ptt_state` 那一列匯出再匯入（或重新建立帳號），並更新 `DATABASE_URL`。
  - 如果資料庫不可用或沒設 `DATABASE_URL`，伺服器會改用容器內的 `data/db.json`：**重新部署、重啟或休眠後帳號與頻道都會消失**，只剩環境變數建立的管理員與「大廳」。
- **Web Service 閒置 15 分鐘會休眠**，下一個人打開要等約 1 分鐘喚醒；每月 750 免費小時、頻寬有上限。
- 本 repo 推送到 GitHub 後 **Render 不會自動部署**（Render 帳號沒有連結 GitHub），需在 Render 後台或用 API 手動部署。

## 檔案
| 路徑 | 說明 |
|---|---|
| `server.js` | HTTP + WebSocket、floor control（優先權）、位置、警報、後台 API |
| `lib/store.js` / `lib/auth.js` | 持久化（Postgres / JSON）、密碼雜湊與 token |
| `public/index.html` `app.js` `style.css` | 對講 App（PWA） |
| `public/admin.html` `admin.js` `admin.css` | 管理後台 |
| `public/vendor/leaflet/` | Leaflet 1.9.4 |
| `render.yaml` | Render Blueprint（web service + free Postgres） |
| `test/e2e.js` | 協定層測試（多帳號；登入、後台、權限、優先搶話、位置、警報、不保存錄音） |
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
1. 電腦打開 `/admin`，用管理員登入，建立 2–3 個使用者（密碼可留空自動產生），建立一個頻道並指派角色（例如 A＝主管、B＝一般、C＝只聽）。
2. 手機各自用帳號登入對講頁，切到該頻道：B 按住講話時 C 只能聽；A 按下會中斷 B，B 畫面會提示。
3. 「地圖」分頁打開分享開關並允許定位：彼此看得到位置、電量（iPhone 顯示「不明」）、更新時間。
4. 長按紅色「緊急警報」2 秒：同頻道與管理員畫面出現全螢幕警示與警示音；在後台或對講頁用管理員解除。
5. iPhone：第一次要點畫面一下啟用聲音；建議關掉靜音鍵。

## 已知限制
- **背景／鎖屏收不到、也不會回報位置**：網頁在 iOS 鎖屏或切到背景後 WebSocket 與定位都會暫停。要像 Zello 一樣，必須做原生 App（iOS PushToTalk framework、Android 前景服務）。
- **沒有留言**：不在線或斷線時講的話會直接錯過。
- **位置與警報只在記憶體**：伺服器重啟／休眠後消失；警報期間若伺服器重啟，警報會遺失，需重新發出。
- 警示音由網頁播放，手機靜音／鎖屏時可能聽不到；iOS 不支援震動。
- iOS 音訊：麥克風開著時可能走聽筒、音量變小；尚未在實機 iPhone 驗證。
- 頻寬：PCM 約 32 KB/s，尚未做 Opus 壓縮。
- 單一 Node 程序；整份狀態存成一列 JSONB，適合幾十～幾百個帳號的測試規模，不適合正式上線。
- 沒有雙因素驗證、沒有密碼找回信；token 存在瀏覽器 localStorage。
