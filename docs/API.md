# 一鍵對講 PTT 原型 · 原生 App／客戶端 API

本文件說明 HTTPS REST 與 WebSocket 協定，供網頁與原生 App 對接。  
**語音只做即時轉發，伺服器不保存任何錄音。**

- 生產環境：`https://ptt-prototype.onrender.com`
- WebSocket：同一主機 `wss://ptt-prototype.onrender.com/ws`（本機 `ws://localhost:8800/ws`）
- 時戳一律為 Unix epoch **毫秒**（UTC）
- 字元編碼 UTF-8；JSON 物件欄位以本文件為準
- 伺服器不保存音訊；`/audio/*` 一律 404

> 文件會隨功能迭代更新。標有「規劃／後續」的段落是給原生 App 的預留說明，實作後會改成確定規格。

---

## 1. 連線與安全

### 1.1 TLS
麥克風與定位需在 **HTTPS**（或 `localhost`）下使用。雲端已是 HTTPS。

### 1.2 認證
1. `POST /api/login` 取得 `token`（不透明字串，約 43 字元 base64url）。
2. 之後 HTTP 請求加標頭：`Authorization: Bearer <token>`
3. WebSocket 連上後 **10 秒內**必須送出第一則 JSON：`{ "t": "hello", "token": "<token>" }`，否則連線以代碼 `4001` 關閉。
4. Token 有效期 **30 天**；伺服器只保存 token 的 SHA-256，無法從資料庫還原明文。
5. 管理員重設密碼或停用帳號時，該使用者所有 token 立即失效；進行中的 WebSocket 會收到 `{ "t": "auth_failed", "reason": "revoked" }` 並以代碼 `4003` 關閉。

登入失敗（帳密錯誤）同一 IP+帳號累計 10 次後鎖 10 分鐘，回 `429`。

### 1.3 CORS
REST API 回應含 `Access-Control-Allow-Origin: *` 與 `Access-Control-Allow-Headers: Authorization, Content-Type`，原生 App 可從其他 origin 呼叫。WebSocket 本身不受 CORS 限制。

### 1.4 角色

**帳號角色 `user.role`**

| 值 | 說明 |
|---|---|
| `admin` | 平台管理員。可使用 `/platform` 與所有 `/api/platform/*`。用公司代碼登入後也可使用該公司的 `/admin`、`/dispatch` 與 `/api/admin/*`。在該公司未個別指派的頻道預設為「主管」。可見該公司全體位置與警報。帳號本身不屬於任何一家公司（`orgId` 為 `null`）。 |
| `org_admin` | 公司管理員。可使用該公司的 `/admin`、`/dispatch` 與 `/api/admin/*`，不可使用 `/api/platform/*`。在該公司未個別指派的頻道預設為「主管」。可見該公司全體位置與警報。 |
| `dispatcher` | 調度員。可使用該公司的 `/dispatch` 同時監聽多頻道、處理來電佇列。不可使用 `/api/admin/*`。在未個別指派的頻道預設為「主管」。可見該公司全體位置與警報，可解除警報。 |
| `user` | 一般使用者。可按「呼叫調度台」進入該公司共用佇列。 |

**頻道角色**（每個頻道、每位成員一份）

| 值 | 中文 | 可講 | 優先權 |
|---|---|---|---|
| `supervisor` | 主管 | 是 | 3 |
| `member` | 一般 | 是 | 2 |
| `listener` | 只聽 | 否 | 0 |

開放頻道（`open: true`）且未個別指派時，一般使用者預設為 `member`。  
警報發送者在警報期間優先權為 **100**（最高，可中斷任何人，連「只聽」也能講）。

---

## 2. REST API

未特別註明時，成功回應為 JSON、`Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store`。  
除 `/api/health`、`/api/login` 外皆需 Bearer token；缺少或無效回 `401 { "error": "unauthorized" }`。

### 2.1 `GET /api/health`
不需登入。

```json
{
  "ok": true,
  "storage": "postgres",
  "online": 0,
  "channels": 1,
  "users": 1,
  "activeTalks": 0,
  "activeAlerts": 0,
  "storesAudio": false,
  "messages": 0,
  "photos": 0,
  "photoBytes": 0,
  "photoRetentionDays": 7,
  "photoQuotaBytes": 314572800,
  "orgs": 1,
  "dispatchQueue": 0
}
```

- `storage`：`postgres` 或 `json`（本機無 `DATABASE_URL` 時）
- `storesAudio` 永遠為 `false`
- `orgs`：公司數量（含預設公司）
- `dispatchQueue`：記憶體中尚未結束的調度台呼叫數（含等候中與進行中）
- `online`／`channels`／`users` 目前是全站合計（原型洩漏，正式環境不應公開）

### 2.2 `POST /api/login`
原生 App **必須**提供公司代碼，欄位名用 `org` 或 `orgCode` 都可以：

```json
{ "username": "alice", "password": "********", "org": "DEMO" }
```

- `org`／`orgCode`：2–16 位英數字（不分大小寫，伺服器會轉成大寫）。缺少時回 `400 need_org`。
- 預設公司代碼為 `DEMO`（由既有資料遷移而來）。
- 平台管理員另可用平台代碼登入（預設 `PLATFORM`，可用環境變數 `PLATFORM_ORG_CODE` 覆寫）。此時回應的 `org` 為 `null`，只能操作 `/api/platform/*`；要管理某一公司請改用該公司代碼登入（同一個平台管理員帳號）。
- 帳號名稱在**同一公司內**唯一；不同公司可以有相同的 `username`。

成功 `200`：

```json
{
  "token": "...",
  "user": { "id": "u…", "username": "alice", "displayName": "小明", "role": "user", "orgId": "odefault", "disabled": false, "createdAt": 1731200000000 },
  "org": {
    "id": "odefault",
    "code": "DEMO",
    "name": "預設公司",
    "plan": "free",
    "seatLimit": 10,
    "seatsUsed": 3,
    "expiresAt": null,
    "disabled": false,
    "status": "active",
    "settings": { "saveCaptions": false }
  }
}
```

失敗：

| 狀態 | error | 說明 |
|---|---|---|
| 400 | `need_org` | 未提供公司代碼 |
| 401 | `invalid_credentials` | 帳號、密碼或公司代碼錯誤（不區分「沒有這家公司」以免探測） |
| 403 | `disabled` | 帳號已停用 |
| 403 | `org_disabled` | 此公司已被停用 |
| 403 | `org_expired` | 此公司方案已到期 |
| 429 | `too_many_attempts` | 嘗試過多 |

帳號規則：3–32 字元，`[a-zA-Z0-9_.-]`。密碼至少 8 字元（建立時）。公司代碼：2–16 位 `[A-Z0-9]`。

### 2.3 `POST /api/logout`
撤銷**目前這個** token。`200 { "ok": true }`

### 2.4 `GET /api/me`
`{ "user": { ..., "orgId" }, "channels": [ /* 見 welcome.channels */ ], "org": { /* 同 login.org；平台代碼登入時為 null */ } }`

### 2.5 `POST /api/me/password`
```json
{ "oldPassword": "...", "newPassword": "至少8字元" }
```
舊密碼錯 `400 error: wrong_password`；新密碼太短 `400 error: weak_password`。

### 2.6 `GET /api/locations`
回傳目前呼叫者**可見範圍內**每個人的**最新一筆**位置（不做軌跡、不存歷史）：

```json
{
  "locations": [
    {
      "id": "u…",
      "name": "顯示名",
      "online": true,
      "channel": "lobby",
      "channelName": "大廳",
      "lat": 25.033,
      "lng": 121.5654,
      "acc": 15,
      "battery": 82,
      "charging": false,
      "ts": 1731200000000
    }
  ]
}
```

- `battery`：0–100 的整數；未知為 `null`（iOS Safari 不支援 Battery Status API）
- `acc`：定位誤差公尺，可能為 `null`
- 可見範圍：限同一公司。自己；該公司的平台／公司管理員與調度員看全體；一般成員只看**目前與自己在同一頻道**的人

### 2.7 `GET /api/alerts`
進行中、呼叫者可見的警報（限同一公司：管理員與調度員看全部；一般成員看自己發的＋目前同頻道的）。格式見 WebSocket `alert`。

### 2.8 公司後台（需已進入某一公司的 `admin` 或 `org_admin`，否則 `403 forbidden`；平台管理員若用 `PLATFORM` 登入則回 `400 need_org`）

所有清單與操作都只作用於**目前 token 所屬公司**。

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/admin/users` | 本公司使用者（含 `online`、`channel`） |
| POST | `/api/admin/users` | 建立。body：`username`（必填）、`displayName`、`password`（省略則自動產生，回應裡只出現一次）、`role`：`user`／`dispatcher`／`org_admin`。不可建立平台管理員。超過公司座位數回 `403 seat_limit`。成功 `201` |
| PATCH | `/api/admin/users/:id` | `displayName`、`role`（同上，不可設為 `admin`）、`disabled`、`password` 或 `resetPassword: true`（自動產生新密碼） |
| DELETE | `/api/admin/users/:id` | 刪除（不能刪自己；不能刪其他公司的人） |
| GET | `/api/admin/channels` | 本公司頻道清單與成員角色 |
| POST | `/api/admin/channels` | `{ "name", "open" }`（名稱在同一公司內唯一） |
| PATCH | `/api/admin/channels/:id` | `{ "name", "open" }` |
| DELETE | `/api/admin/channels/:id` | 不能刪大廳（預設公司 id=`lobby`，其他公司為 `lobby-<orgId>`） |
| PUT | `/api/admin/channels/:id/members/:userId` | `{ "role": "supervisor" / "member" / "listener" }` |
| DELETE | `/api/admin/channels/:id/members/:userId` | 移除指派 |
| GET | `/api/admin/alerts` | 本公司進行中警報 |
| POST | `/api/admin/alerts/:id/resolve` | 解除警報 |
| GET | `/api/admin/settings` | `{ "settings": { "saveCaptions": false }, "org": { ... } }` |
| PATCH | `/api/admin/settings` | `{ "saveCaptions": true 或 false }`（公司管理員可開關；即時語音轉文字若開啟會用到） |

管理員不能停用自己或移除自己的管理員權限（`400 self_lockout`）。停用／重設密碼會立即踢下線。

### 2.8.1 平台後台（需 `user.role === "admin"`，否則 `403 forbidden`）

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/platform/plans` | 方案與範例金額（`example: true`） |
| PATCH | `/api/platform/plans` | 調整 `free`／`standard`／`pro` 的 `label`、`seats`、`priceMonthly`、`priceYearly`。金額永遠標 `example: true` |
| GET | `/api/platform/orgs` | 公司一覽、方案、`platformCode` |
| POST | `/api/platform/orgs` | 建立公司。body：`code`、`name`、`plan`（`free`／`standard`／`pro`）、可選 `seatLimit`、`adminUsername`、`adminDisplayName`、`adminPassword`。付費方案預設 14 天試用 |
| GET | `/api/platform/orgs/:id` | 單一公司與該公司使用者 |
| PATCH | `/api/platform/orgs/:id` | `name`、`code`、`plan`、`seatLimit`、`expiresAt`、`disabled`、`settings.saveCaptions`。停用會立即踢該公司所有人 |
| DELETE | `/api/platform/orgs/:id` | 刪除公司及其使用者、頻道、訊息。預設公司 `odefault` 不能刪（`400 protected`） |
| POST | `/api/platform/orgs/:id/mark-paid` | `{ "days": 30, "note": "..." }` 手動延長到期日並解除停用。**不會向任何金流請款** |
| POST | `/api/platform/orgs/:id/admins` | 再指定一位公司管理員 |

頁面：`GET /platform`。

### 2.8.2 `POST /api/billing/checkout`

需登入。本原型**沒有**接綠界、Stripe 或其他真實金流，固定回 `200`：

```json
{
  "ok": false,
  "error": "not_connected",
  "example": true,
  "message": "尚未接上真實金流……",
  "provider": null,
  "orgId": "o…",
  "orgCode": "DEMO",
  "plan": "standard",
  "period": "monthly",
  "amount": 990,
  "currency": "TWD",
  "note": "範例佔位金額，非正式報價"
}
```

body 可帶 `plan`、`period`（`monthly`／`yearly`）。若要自行串接金流，請實作 `createCheckout`／`handleWebhook` 取代 `lib/billing.js` 的佔位函式。客戶若已另外付款，由平台管理員呼叫 `mark-paid`。

### 2.9 不存在的路徑
- `/api/history`、`/audio/*` → `404`（不保存錄音）
- 其他未知 `/api/*` → `404 { "error": "not_found" }`

---

## 3. WebSocket `/ws`

### 3.1 連線
```
wss://<host>/ws
```
- 子協定：無
- 最大訊息：256 KiB
- 客戶端應把 `binaryType` 設成 `arraybuffer`（瀏覽器）或等價設定
- 伺服器每 10 秒送 WebSocket ping；請回應 pong（大多數函式庫自動處理）
- 建議客戶端每 15 秒送 `{ "t": "ping", "ts": <epochMs> }`，會收到 `{ "t": "pong", "ts": <原值> }`。若 8 秒內沒收到 pong 可自行重連
- 斷線後請用指數退避重連（建議 1s 起、上限約 10s），重連後重新 `hello` + `join`

關閉代碼：`4001` 認證失敗或逾時；`4003` 帳號被停用／密碼已重設。

### 3.2 客戶端 → 伺服器（JSON）

所有 JSON 訊息必有字串欄位 `t`。

#### `hello`（連線後第一則，必送）
```json
{ "t": "hello", "token": "<Bearer token 同一字串>" }
```

#### `join` — 切換目前頻道
```json
{ "t": "join", "channel": "lobby" }
```
每個連線（準確地說：這個使用者的線上狀態）同時只「在」一個頻道。私人對講不需 join。

#### `ptt_start` — 請求發言權
發話對象必須是你目前 `join` 的頻道、一對一對象，或（僅調度員／管理員）已用 `listen` 勾選的頻道。
對頻道：
```json
{ "t": "ptt_start", "conv": "lobby" }
```
對一對一（以對方使用者 id）：
```json
{ "t": "ptt_start", "to": "u0abc123def456" }
```
`conv` 為頻道 id，或伺服器產生的 `dm:<idA>:<idB>`（兩個 id **按字串排序**後用冒號連接，並加前綴 `dm:`）。客戶端送 `to` 即可，不必自己組 `conv`。

私人對講對象必須在線，否則 `floor_denied` `reason: "offline"`（沒有留言）。  
「只聽」角色對頻道發話會得到 `reason: "listen_only"`（警報期間除外）。  
沒有權限：`reason: "no_access"`。  
頻道已被同等或更高優先權佔用：`reason: "busy"`，附 `by`、`byName`。

單次發話上限 **60 秒**。

#### `ptt_stop` — 放開按鈕、結束發話
```json
{ "t": "ptt_stop" }
```

#### `loc` — 回報位置（需使用者同意）
```json
{
  "t": "loc",
  "lat": 25.033,
  "lng": 121.5654,
  "acc": 15,
  "battery": 0.82,
  "charging": false
}
```
- `lat`/`lng` 必填，範圍 lat ∈ [-90,90]、lng ∈ [-180,180]
- `battery`：若提供須為 0–1 的小數，伺服器存成 0–100 的整數
- `charging`：布林或省略
- 伺服器端節流：同一使用者 **2 秒內**的後續回報會被丟棄
- 建議客戶端約每 15–30 秒回報一次；只在記憶體保留最新一筆

#### `loc_off` — 停止分享，刪除記憶體中的位置
```json
{ "t": "loc_off" }
```

#### `get_locs` — 請伺服器重送目前可見的位置清單
```json
{ "t": "get_locs" }
```
回應為一則 `locs`。

#### `alert_start` — 發出緊急警報
```json
{ "t": "alert_start", "lat": 25.033, "lng": 121.5654, "acc": 8 }
```
`lat`/`lng` 可省略：會改用該使用者最近一次 `loc`，都沒有則位置為 null。  
同一使用者重複送出會**更新**既有警報的位置，不會產生第二筆。  
請在客戶端做防誤觸（網頁版為長按 2 秒）。

#### `alert_resolve` — 解除警報
```json
{ "t": "alert_resolve", "id": "a…" }
```
僅管理員、調度員或該則警報的發送者可以解除。

#### `listen` — 同時監聽多個頻道（僅管理員／調度員）
```json
{ "t": "listen", "channels": ["lobby", "c…"] }
```
伺服器只保留呼叫者有權限的頻道 id，並回 `{ "t": "listening", "channels": ["lobby", "c…"] }`。  
監聽中的頻道會把你列入語音接收名單（即使你目前 `join` 在別的頻道或尚未 join）。每條頻道仍受既有 floor control 約束。一般使用者送出此訊息會收到 `{ "t": "error", "code": "forbidden" }`。

#### `dispatch_call` — 一般使用者呼叫調度台
```json
{ "t": "dispatch_call" }
```
同一人若已有一通 `waiting` 呼叫，伺服器回傳既有項目而不新增。調度員／管理員送出會被拒絕（`forbidden`）。呼叫者會收到 `queue_self`；所有在線調度員會收到更新後的 `queue`。

#### `dispatch_pickup` — 調度員接聽
```json
{ "t": "dispatch_pickup", "id": "q…" }
```
成功後該則改為 `held`，並建立呼叫者與該調度員的一對一對話（`dm:<sortedUserIds>`）。呼叫者與接聽者都會收到 `dispatch_pickup`（接聽者帶 `pickup: true` 與 `conv`）。

#### `dispatch_transfer` — 把進行中的通話轉給其他在線調度員
```json
{ "t": "dispatch_transfer", "id": "q…", "to": "u…" }
```
只有目前 `heldBy` 的調度員能轉接；`to` 必須是其他在線的管理員或調度員。呼叫者與新調度員會收到 `dispatch_transfer`（新調度員帶 `pickup: true` 與新的 `conv`）。

#### `dispatch_done` — 結束這通呼叫
```json
{ "t": "dispatch_done", "id": "q…" }
```
呼叫者、目前接聽者或管理員可以結束。佇列項目從記憶體刪除，相關人士收到 `dispatch_done`。

#### `ping`
```json
{ "t": "ping", "ts": 1731200000000 }
```

---

### 3.3 伺服器 → 客戶端（JSON）

#### `welcome` — `hello` 成功
```json
{
  "t": "welcome",
  "user": { "id": "u…", "username": "alice", "displayName": "小明", "role": "user", "orgId": "odefault", "disabled": false, "createdAt": 1731200000000 },
  "org": { "id": "odefault", "code": "DEMO", "name": "預設公司", "plan": "free", "status": "active", "settings": { "saveCaptions": false } },
  "channels": [
    {
      "id": "lobby",
      "name": "大廳",
      "open": true,
      "myRole": "member",
      "myRoleLabel": "一般",
      "canTalk": true,
      "online": 2,
      "last": 1731200000000,
      "lastTalk": { "from": "u…", "fromName": "小華", "toName": null, "ts": 1731200000000, "durMs": 1500 }
    }
  ],
  "dms": [
    { "conv": "dm:uAaa:uBbb", "peerId": "uBbb", "peerName": "小華", "last": 1731200000000, "lastTalk": { } }
  ],
  "online": [{ "id": "u…", "name": "小明", "channel": "lobby" }],
  "alerts": [ /* 見 alert */ ],
  "queue": [ /* 僅調度員／管理員：見 queue；其他人為 [] */ ],
  "dispatchers": [ /* 僅調度員／管理員：目前在線的 {id,name}；其他人為 [] */ ],
  "roles": {
    "supervisor": { "label": "主管", "prio": 3, "talk": true },
    "member": { "label": "一般", "prio": 2, "talk": true },
    "listener": { "label": "只聽", "prio": 0, "talk": false }
  },
  "serverTime": 1731200000000
}
```
`lastTalk` 是**純文字狀態**（誰、何時、講了幾毫秒），不含音訊、不含可回放的網址。伺服器重啟即消失。

#### `auth_failed`
```json
{ "t": "auth_failed", "reason": "invalid_token" }
```
`reason`：`invalid_token` | `not_logged_in` | `revoked` | `org_inactive`（公司停用或到期）。隨後連線會關閉（代碼 `4003`）。

#### `joined`
```json
{ "t": "joined", "channel": "lobby", "myRole": "member" }
```
若權限被拿掉，可能變成 `{ "t": "joined", "channel": "lobby", "reason": "access_changed" }`（被移回大廳）；若連大廳都不能進，`channel` 可能為 `null`。

#### `channels` / `members` / `online`
```json
{ "t": "channels", "channels": [ /* 同 welcome.channels */ ] }
{ "t": "members", "channel": "lobby", "members": [{ "id": "u…", "name": "小明", "role": "member" }] }
{ "t": "online", "online": [{ "id": "u…", "name": "小明", "channel": "lobby" }] }
```

#### `floor_granted`
```json
{ "t": "floor_granted", "conv": "lobby", "streamId": 12, "prio": 2, "maxMs": 60000 }
```
收到後才可開始送二進位音訊。`streamId` 是本次發話的識別，接收端用來分開不同人的播放排程。

#### `floor_denied`
```json
{ "t": "floor_denied", "conv": "lobby", "reason": "busy", "by": "u…", "byName": "小華" }
```
`reason`：`busy` | `no_access` | `listen_only` | `offline`

#### `floor_revoked` — 你的發話被伺服器結束
```json
{ "t": "floor_revoked", "conv": "lobby", "reason": "preempted", "by": "u…", "byName": "主管王" }
```
`reason`：

| 值 | 說明 |
|---|---|
| `preempted` | 被更高優先權中斷 |
| `timeout` | 已達 60 秒 |
| `stalled` | 超過約 3 秒沒收到音訊封包（剛按下尚未有音訊時寬限 10 秒） |

#### `talk_start` — 別人開始在你聽得到的對話裡講話
```json
{ "t": "talk_start", "conv": "lobby", "streamId": 12, "from": "u…", "fromName": "小華", "prio": 2, "toName": null }
```
一對一時 `toName` 為對方顯示名。隨後會收到該 `streamId` 的二進位音訊。

#### `talk_end`
```json
{
  "t": "talk_end",
  "conv": "lobby",
  "streamId": 12,
  "from": "u…",
  "reason": "released",
  "lastTalk": { "from": "u…", "fromName": "小華", "toName": null, "ts": 1731200000000, "durMs": 1500 }
}
```
`reason`：`released`（對方放開）| `preempted` | `timeout` | `stalled` | `disconnect` | `left` | `switch` | `restart` | `deleted` | `revoked`  
被中斷時還有 `by`、`byName`。  
`lastTalk` 在幾乎沒送到音訊時可能為 `null`。

#### `channel_activity`
```json
{ "t": "channel_activity", "channel": "lobby", "last": 1731200000000, "lastTalk": { } }
```
給「看得到這個頻道、但不一定正在裡面」的人更新最近說話者文字。

#### `loc` / `locs` / `loc_remove`
```json
{ "t": "loc", "loc": { /* 同 GET /api/locations 的單筆 */ } }
{ "t": "locs", "locs": [ /* 多筆 */ ] }
{ "t": "loc_remove", "id": "u…" }
```

#### `alert` / `alert_end`
```json
{
  "t": "alert",
  "alert": {
    "id": "a…",
    "userId": "u…",
    "name": "小明",
    "channel": "lobby",
    "channelName": "大廳",
    "lat": 25.033,
    "lng": 121.5654,
    "acc": 8,
    "ts": 1731200000000
  }
}
```
`lat`/`lng` 可能為 `null`。地圖連結建議：  
`https://www.openstreetmap.org/?mlat=<lat>&mlon=<lng>#map=17/<lat>/<lng>`

```json
{ "t": "alert_end", "id": "a…", "by": "管理員" }
```

#### `error`
```json
{ "t": "error", "code": "no_access", "msg": "你沒有這個頻道的權限" }
```
常見 `code`：`no_access` | `no_alert` | `forbidden` | `no_queue` | `no_peer` | `empty` | `too_long`

#### `pong`
```json
{ "t": "pong", "ts": 1731200000000 }
```

#### `listening`
```json
{ "t": "listening", "channels": ["lobby", "c…"] }
```

#### `queue` / `queue_self`
```json
{
  "t": "queue",
  "items": [
    {
      "id": "q…",
      "from": "u…",
      "fromName": "小明",
      "channel": "lobby",
      "channelName": "大廳",
      "ts": 1731200000000,
      "status": "waiting",
      "heldBy": null,
      "heldByName": null
    }
  ]
}
```
`status`：`waiting`（排隊中）| `held`（已被某調度員接聽，此時 `heldBy` / `heldByName` 有值）。佇列只存在記憶體，伺服器重啟即清空。呼叫者自己會另外收到：
```json
{ "t": "queue_self", "item": { /* 同上單筆 */ } }
```

#### `dispatch_pickup` / `dispatch_transfer` / `dispatch_done`
```json
{ "t": "dispatch_pickup", "item": { /* 佇列項目，status=held */ }, "by": "u…", "byName": "調度甲", "conv": "dm:uAaa:uBbb", "pickup": true }
{ "t": "dispatch_transfer", "item": { }, "by": "調度甲", "to": "u…", "toName": "調度乙", "conv": "dm:uAaa:uCcc", "pickup": true }
{ "t": "dispatch_done", "id": "q…" }
```
`pickup: true` 只出現在「現在應該接下這通一對一」的調度員端。`dispatch_transfer` 送到原呼叫者時沒有 `pickup`，而是帶 `to` / `toName` 與新的 `conv`。

---

## 4. 音訊封包（PCM 16 kHz）

伺服器**不保存**這些資料，只轉發後丟棄（記憶體裡只留「已收到位元組數」用來算時長與偵測斷流）。

### 4.1 格式
| 項目 | 值 |
|---|---|
| 取樣率 | 16000 Hz |
| 聲道 | 1（單聲道） |
| 樣本位元 | 16-bit **有號小端序**（s16le / PCM_S16LE） |
| 淨荷 | 原始 PCM，**無** WAV／容器檔頭 |

建議客戶端約每 **100 ms** 送一包：100 ms × 16000 × 2 = **3200 位元組**。包大小不必精確，但單包須小於 WebSocket 上限（256 KiB）。整段發話位元組上限約 60 秒 × 32000 ≈ 1.92 MB（以累計計算，超長封包會被丟棄）。

頻寬約 32 KB/s。目前沒有 Opus／丟包補償；網路不穩時接收端可能聽到斷續。

### 4.2 客戶端 → 伺服器
在收到 `floor_granted` 之後、`ptt_stop`／`floor_revoked` 之前，送 **binary** WebSocket 影格：

```
[ pcm s16le ... ]
```

沒有握有發言權的 binary 會被忽略。不要把 JSON 跟 PCM 混在同一個影格。

### 4.3 伺服器 → 其他接收端
同樣是 binary 影格，前面多 4 位元組 **big-endian uint32** 的 `streamId`：

```
offset 0: streamId (uint32 BE)   —— 對應 talk_start / floor_granted 的 streamId
offset 4: pcm s16le ...          —— 與發送端送出的位元組相同
```

發送者**不會**收到自己的音訊。

### 4.4 播放建議
1. 依 `streamId` 分軌。
2. 解成 Float32（樣本 / 32768）後，用 16000 Hz 的 Audio buffer 排程播放。
3. 建議保留約 **180 ms** 抖動緩衝；某 `streamId` 的 `talk_end` 之後可結束該軌。
4. iOS：必須在使用者手勢裡 resume AudioContext；建議同時播放極短靜音。iOS 17+ 可設定 `navigator.audioSession.type = "playback"`。

---

## 5. Floor control（發言權）

每個 `conv`（頻道 id 或 `dm:a:b`）同一時間最多一把鎖。

1. 客戶端送 `ptt_start`。
2. 無人佔用 → `floor_granted`，開始收 binary。
3. 已有人佔用：
   - 新請求優先權 **嚴格大於** 現任 → 現任收到 `floor_revoked` `preempted`，其他人收到 `talk_end` `preempted`，新請求者 `floor_granted`。
   - 否則 → 新請求者 `floor_denied` `busy`。
4. 釋放條件：`ptt_stop`、斷線、切頻道、超時 60 秒、超過 3 秒沒音訊（剛按下未送音訊前 10 秒）、被搶話、帳號被踢。

一對一的優先權固定等同「一般」（2），警報期間發送者為 100。

`conv` 規則：
- 頻道：就是頻道 `id`（大廳為 `lobby`）
- 一對一：`dm:` + 兩個使用者 id **按 UTF-8／JS 字串升序排列** + `:` 連接  
  例：id `uB` 與 `uA` → `dm:uA:uB`

---

## 6. 位置

- 只存在伺服器記憶體，最新一筆，重啟即消失。
- 不做軌跡、不寫資料庫。
- 可見範圍見 §2.6。
- 客戶端應先取得作業系統定位權限；使用者關閉分享時送 `loc_off`。

---

## 7. 緊急警報

- 只存在記憶體，不保存錄音。
- 廣播對象：發送者、所有**在線管理員與調度員**、與發送者**當時所在頻道**的在線成員。
- 其他頻道的一般成員收不到。
- 警報期間發送者取得最高發話權（即使頻道角色是「只聽」）。
- 解除後發話權恢復原本角色規則。

---

## 8. 文字與照片訊息

語音仍然不保存。文字與照片會保存（Postgres 資料表 `ptt_chat` / `ptt_photos`；本機無資料庫時為 `data/chat.json` + `data/photos/`）。

### 8.1 `GET /api/messages?conv=<id>&since=<ms>&limit=<n>`
需登入且對該 `conv` 有權限（頻道成員／管理員，或私訊雙方），否則 `401`／`403`。

```json
{
  "messages": [
    { "id": "m…", "conv": "lobby", "from": "u…", "fromName": "小明", "kind": "text", "text": "你好", "ts": 1731200000000 },
    { "id": "m…", "conv": "lobby", "from": "u…", "fromName": "小明", "kind": "photo", "photoId": "ab…16hex", "mime": "image/jpeg", "ts": 1731200000000 }
  ]
}
```
`since` 預設 0（只回傳 `ts > since`）；`limit` 預設 100、上限 200。依時間正序。

### 8.2 `POST /api/messages`
```json
{ "conv": "lobby", "text": "你好" }
```
成功 `201 { "message": { ... kind:"text" } }`。文字去掉頭尾空白後不可為空，最長 2000 字。  
一對一允許對方離線（與語音不同）。

也可透過 WebSocket 送 `{ "t": "chat", "conv": "lobby", "text": "你好" }`，效果相同。

### 8.3 `POST /api/photos`
```json
{ "conv": "lobby", "data": "<標準 base64，不要 data: 前綴>" }
```
成功 `201 { "message": { "kind":"photo", "photoId":"…", "mime":"image/jpeg" } }`。

伺服器端限制：
- 解碼後大小 **≤ 220 KB**（客戶端應壓到約 200 KB 以內），超過回 `413 too_large`
- 以檔頭辨識 MIME，只接受 **JPEG / WebP / PNG**（`bad_type`）
- 請求 JSON 上限約 400 KB

客戶端建議：長邊縮到 ≤ 1280，再以 WebP 或 JPEG 品質約 0.8 往下調到 ≤ 200 KB（網頁版已實作）。

### 8.4 `GET /api/photos/:id`
`:id` 為 16 位十六進位。需 `Authorization: Bearer`。
- 未登入 `401`
- 已登入但沒有該照片所屬對話的權限 `403`
- 成功回傳原始圖片位元組，`Content-Type` 為實際 MIME，`Cache-Control: private, max-age=86400`

請用 fetch（帶 token）轉成 blob URL 顯示，不要把 token 放到圖片 URL 的 query string。

### 8.5 WebSocket `chat`
伺服器廣播（對話內在線成員 + 發送者自己的所有連線）：
```json
{ "t": "chat", "message": { "id", "conv", "from", "fromName", "kind": "text"|"photo", "text?", "photoId?", "mime?", "ts" } }
```

### 8.6 保留與清理
- 照片保留 **7 天**（依上傳時間）
- 所有照片合計超過 **300 MB** 時，由最舊的開始刪，直到低於上限
- 啟動時清理一次，之後每小時一次
- 刪除頻道時一併刪該頻道的文字／照片；刪除使用者時刪其私訊對話
- 免費 Postgres 總容量 1 GB，請把照片配額與狀態 JSON 一併計算

### 8.7 網頁調度台 `/dispatch`

`GET /dispatch` 回傳桌面版 HTML（管理員或調度員登入後使用；一般使用者會看到權限不足提示）。原生 App 不必載入此頁，只要實作上面的 `listen` / `dispatch_*` 訊息即可做同等功能：

- 同時訂閱多個 `channels` 並依頻道靜音／調音量（音量由客戶端處理，伺服器仍轉發全部封包）
- 用 `talk_start` / `talk_end` 的 `fromName` 顯示誰在講
- 選一個頻道或一對一 `conv` 後送 `ptt_start`（空白鍵或大按鈕按住講話）
- 顯示共用 `queue`，`dispatch_pickup` 後用回傳的 `conv` 做一對一
- 嵌入與一般客戶端相同的地圖（`loc` / `locs`）與警報面板（`alert` / `alert_end`）

---

## 9. 多租戶（公司隔離）與收費佔位

已實作。各公司的使用者、頻道、地圖位置、警報、文字／照片、調度佇列完全隔離。

- 預設公司：`id = odefault`，代碼 `DEMO`。升級既有資料庫時，非平台管理員的使用者與頻道會自動加上 `orgId: "odefault"`。預設公司大廳 id 仍為 `lobby`，其他公司大廳為 `lobby-<orgId>`。
- 登入請求見 §2.2，原生 App 必須有公司代碼欄位（`org` 或 `orgCode`）。
- `user.orgId`：一般帳號為所屬公司；平台管理員為目前 session 進入的公司，若用 `PLATFORM` 登入則為 `null`。
- 方案預設（皆 `example: true`，可在平台後台改，非正式報價）：免費 0 元／10 人；標準月 990／年 9900、50 人；專業月 2990／年 29900、200 人（TWD）。
- 座位數：該公司未停用的帳號數不可超過 `seatLimit`。
- 到期：`expiresAt` 為過去時間時無法登入（`org_expired`），線上連線會在下次訊息或最多約 30 秒內被踢。免費方案預設 `expiresAt: null`。
- 停用公司：`403 org_disabled`，並立即踢下線。
- 金流：見 §2.8.2。沒有綠界／Stripe／自動續約；「標記已付款」只是延長到期日的佔位操作。
- 限制：照片 300MB 配額目前全站共用，尚未依公司分開計算。`GET /api/health` 的人數／頻道數為全站合計。

---

## 10. 錯誤與 HTTP 狀態整理

| 狀態 | 典型 error |
|---|---|
| 400 | `bad_request` `bad_username` `bad_name` `bad_org` `bad_role` `weak_password` `wrong_password` `self_lockout` `protected` `need_org` |
| 401 | `unauthorized` `invalid_credentials` |
| 403 | `forbidden` `disabled` `org_disabled` `org_expired` `seat_limit` |
| 404 | `not_found` `no_user` |
| 409 | `exists` |
| 429 | `too_many_attempts` |
| 500 | `server_error` |

---

## 11. 原生 App 實作清單（建議順序）

1. 登入畫面要有**公司代碼**欄位，呼叫 `POST /api/login` 時送 `{ username, password, org }`（也接受 `orgCode`），保存 token 與公司代碼，再呼叫 `GET /api/me` 確認 `org`
2. 連 `/ws`，`hello` → 處理 `welcome` / `auth_failed`，斷線重連
3. `join` 頻道、畫成員清單
4. 按住講話：`ptt_start` → 等 `floor_granted` → 擷取麥克風轉 16 kHz s16le mono 分片送出 → 放開 `ptt_stop`；處理 `floor_denied` / `floor_revoked`
5. 收到 binary 依 `streamId` 播放；UI 顯示 `talk_start` / `talk_end`
6. 一對一：`ptt_start` + `to`
7. （使用者同意後）週期性 `loc`；地圖用 OSM 並標示來源
8. 長按防誤觸後 `alert_start`；全螢幕顯示 `alert`
9. 文字／照片：`GET/POST /api/messages`、`POST /api/photos`、`GET /api/photos/:id`（帶 Bearer，不要把 token 放進 URL）
10. 若要做調度功能：`listen`、顯示 `queue`、`dispatch_call` / `dispatch_pickup` / `dispatch_transfer` / `dispatch_done`
11. 若要做多公司：保存上次使用的公司代碼；處理 `need_org`／`org_disabled`／`org_expired`／`seat_limit`；公司管理員走 `/api/admin/*`，平台管理員另接 `/api/platform/*` 與佔位的 `/api/billing/checkout`（不要當成真實付款成功）
12. 背景／鎖屏收聽**無法**靠本網頁協定完成：iOS 需 PushToTalk framework，Android 需前景服務。本協定在 App 回到前景時重連即可補上成員與文字狀態，但錯過的語音無法補聽

背景限制與音訊解鎖細節見專案根目錄 `README.md`。
