# 一鍵對講 PTT 原型（第一階段・網頁版）

**線上測試網址：https://ptt-prototype.onrender.com**（Render 免費方案，新加坡機房）


對標 Zello 的 Push-to-Talk 網頁原型，行動裝置優先、可加到主畫面（PWA），介面為繁體中文。

## 功能
1. **暱稱登入**：輸入暱稱即可使用；瀏覽器會記住一組隨機 ID（localStorage），重新整理或重連後身分不變。沒有密碼。
2. **頻道**：預設「大廳」，可建立新頻道、切換頻道，看到頻道內線上成員與人數。
3. **按住講話**：大按鈕支援觸控按住、滑鼠按住，電腦上也可按住**空白鍵**。按住時錄音並每約 100ms 串流一包給同頻道線上成員即時播放。
4. **伺服器端發言權（floor control）**：每個頻道／私訊同時只允許一人講話；其他人按下會看到「某某正在說話」。講話者放開、斷線、或超過 60 秒時，伺服器自動釋放發言權。
5. **不保存錄音（降低伺服器負擔）**：伺服器只做即時轉發，語音不寫入磁碟、也不留在記憶體；講完就沒有了，沒有歷史清單、回放或離線留言。畫面只保留「最近說話：誰 · 幾點 · 幾秒」與本次開啟期間的文字動態（純文字，不含音訊）。
6. **一對一私人對講**：在「成員」分頁點一個人即進入私人對講；「私訊」分頁列出最近私人對講過的人。因為不留言，對方不在線時無法發話（會提示「目前不在線」）。
7. **相容性與連線**：iOS Safari AudioContext 在使用者手勢中解鎖、`navigator.audioSession`（iOS 17+）設定；連線狀態燈號、指數退避自動重連、心跳偵測半開連線。

## 架構
```
手機瀏覽器 ──WebSocket(/ws)──▶ Node.js 伺服器 ──▶ 同頻道/私訊的其他線上成員
   │  JSON：hello / join / ptt_start / ptt_stop …        │
   │  二進位：16kHz 16-bit 單聲道 PCM（每包約 100ms）    ├─ floor control（記憶體中，每個對話一把鎖）
   │                                                    ├─ 只計算長度（判斷斷流），不保留任何音訊
   └──HTTP：/api/health、靜態檔                          └─ data/db.json  只存頻道清單
```
- **伺服器轉發**（不是 P2P）：跟 Zello 一樣，所有語音都經過伺服器，伺服器才能做發言權控制。這一版依需求**不錄存**，伺服器收到一包就轉發一包，轉完即丟棄。`/api/history`、`/audio/*` 一律回 404。
- 伺服器轉發時在每包前面加 4-byte streamId，接收端依 streamId 排程播放（約 180ms 抖動緩衝）。
- 依賴只有 `ws` 一個套件；前端是純 HTML/CSS/JS，無建置步驟。

### 為什麼目前用 PCM 而不是 Opus？
設計規劃寫的是 Opus。實作時發現瀏覽器的 MediaRecorder 在 iOS Safari 只能錄 `audio/mp4`(AAC)，Chrome 錄 `webm/opus`，兩邊格式不同，且 webm 分段不能單獨解碼、iPhone 上 MediaSource 支援也不完整，近即時播放會很不穩。所以原型先用「Web Audio 擷取 → 16kHz PCM → WebSocket」，所有瀏覽器都能即時播放，代價是頻寬約 32 KB/s（Opus 約 2–3 KB/s）。下一步可改用 WebCodecs `AudioEncoder`（Opus）或做成原生 App 時直接用 Opus。

## 檔案
| 路徑 | 說明 |
|---|---|
| `server.js` | HTTP + WebSocket 伺服器、floor control、存檔、API |
| `public/index.html` `app.js` `style.css` | 前端（PWA） |
| `public/manifest.webmanifest` `sw.js` `icon*` | PWA 安裝用 |
| `run.sh` | 常駐腳本，伺服器當掉自動重啟 |
| `test/e2e.js` | 協定層端對端測試（模擬 3 個客戶端） |
| `test/browser_e2e.py` | 真實瀏覽器測試（Chromium + 假麥克風，兩個工作階段） |
| `data/` | 執行時產生，只有 `db.json`（頻道清單），沒有任何音訊 |

## 雲端部署（Render）
- 服務：`ptt-prototype`（Web Service，Node，free 方案，region singapore），從本 repo 的 `main` 分支自動部署：push 到 main 就會重新部署。
- Build：`npm ci`；Start：`node server.js`；伺服器讀 `process.env.PORT`；健康檢查 `GET /api/health`。
- WebSocket 走同一個網址的 `wss://ptt-prototype.onrender.com/ws`。

### Render 免費方案的限制
- **閒置休眠**：約 15 分鐘沒有流量會休眠，下一個人打開時要等約 30–60 秒喚醒（畫面會顯示「重新連線中」，之後自動連上）。
- **磁碟不持久**：`data/db.json`（頻道清單）存在容器本機磁碟，**每次重新部署、重啟或休眠後都會清空**，自建的頻道會消失（只剩「大廳」）。語音本來就不保存，所以沒有錄音會遺失的問題。
- 免費方案有每月執行時數與頻寬上限；只適合小規模測試。

## 本機啟動
```bash
cd /workspace/ptt-prototype
npm install            # 只有 ws
nohup ./run.sh > server.log 2>&1 &    # 預設埠 8800，可用 PORT=xxxx 改
curl localhost:8800/api/health
```
麥克風必須在 **HTTPS**（或 localhost）下才能用，所以手機測試需要一個 HTTPS 網址，例如：
```bash
cloudflared tunnel --url http://localhost:8800     # 印出 https://xxxx.trycloudflare.com
```
> 開發用的 box 對外網路會擋 cloudflared（7844 埠）與 SSH 類 tunnel，所以改用 Render 部署取得公開網址。

### 在自己電腦上跑（最快的手機測試方式）
1. 裝 Node.js 18+，把整個資料夾複製過去，`npm install`，`node server.js`。
2. 安裝 cloudflared，執行 `cloudflared tunnel --url http://localhost:8800`，把印出的 https 網址用手機打開。

### 測試
```bash
node test/e2e.js http://localhost:8800     # 本機會另外檢查 data/ 只有 db.json
python3 test/browser_e2e.py http://localhost:8800
```

## 建議測試方式
- 兩支手機（或手機 + 電腦）打開同一個 https 網址，各輸入不同暱稱。
- 都會自動進到「大廳」。A 按住講話，B 應聽到並看到「A 正在說話」；B 此時按下會被擋。
- 讓 B 關掉頁面，A 講幾句，B 再打開 → 聽不到剛才的內容（不保存），只會看到頻道的「最近：A 幾點」。
- 在「成員」點對方 → 私人對講。
- iPhone：第一次要點畫面一下啟用聲音；建議關掉靜音鍵測試。

## 已知限制
- **雲端免費方案**：會休眠、重啟後資料清空（見上方「Render 免費方案的限制」）。
- **沒有真正的帳號系統**：暱稱可重複，ID 存在瀏覽器裡，清除瀏覽資料就變新身分；私訊權限只靠 ID，不安全，只適合測試。
- **背景/鎖屏收不到**：網頁在 iOS 鎖屏或切到背景後 WebSocket 會被暫停，收不到即時對講（也沒有留言可補聽）。要像 Zello 一樣鎖屏也能收，必須做原生 App 並使用 Apple **PushToTalk framework**；Android 也要前景服務（foreground service）。
- **iOS 音訊**：麥克風開著時 iPhone 可能改走聽筒、音量變小；Web Audio 可能受靜音鍵影響（iOS 17+ 已用 `audioSession` 嘗試處理）。這些尚未在實機 iPhone 驗證。
- **頻寬**：PCM 約 32 KB/s，弱網路下會斷續；尚未做 Opus 壓縮與丟包補償。
- **按下到開始收音**：第一次按下要等麥克風啟動，開頭約 0.1–0.5 秒可能被切掉；放開後麥克風會保留 20 秒，連續對講較順。最後不足 100ms 的尾音會被捨棄。
- **擴充性**：單一 Node 程序、資料存 JSON，適合幾十人測試，不適合正式上線。
- 單次發話上限 60 秒。
- **沒有留言**：不在線、切到背景或網路斷掉時講的話會直接錯過，事後無法補聽。若之後需要「離線留言」，要再加回伺服器儲存（會增加伺服器負擔與儲存成本）。
- 發話中超過 3 秒沒收到語音（例如手機斷網），伺服器會自動收回發言權，避免頻道被卡住；剛按下時（等麥克風權限）給 10 秒。
