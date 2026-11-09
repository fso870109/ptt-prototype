# 第二階段真實瀏覽器測試（Chromium + 假麥克風 + 模擬定位）
# 用法：ADMIN_USERNAME=... ADMIN_PASSWORD=... python3 test/browser_e2e.py [baseUrl]
import sys, os, time, json, urllib.request
from playwright.sync_api import sync_playwright
BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8800').rstrip('/')
AU, AP = os.environ['ADMIN_USERNAME'], os.environ['ADMIN_PASSWORD']
res = []
def ok(n, c, x=''): res.append(bool(c)); print('PASS' if c else 'FAIL', n, x)
def api(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
sfx = hex(int(time.time()))[-5:]
_, j = api('POST', '/api/login', {'username': AU, 'password': AP, 'org': 'DEMO'}); ADM = j['token']
users = {}
for key, name in [('ba', '小明'), ('bb', '小華')]:
    s, j = api('POST', '/api/admin/users', {'username': f't_{key}_{sfx}', 'displayName': name, 'password': f'{key}-Pass-1234'}, ADM)
    users[name] = {'id': j['user']['id'], 'username': j['user']['username'], 'password': f'{key}-Pass-1234'}
s, j = api('POST', '/api/admin/users', {'username': f't_dsp_{sfx}', 'displayName': '調度員一', 'password': 'Dsp-Pass-1234', 'role': 'dispatcher'}, ADM)
users['調度'] = {'id': j['user']['id'], 'username': j['user']['username'], 'password': 'Dsp-Pass-1234'}
try:
  with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
    pages, bins, reqs = {}, {}, []
    geo = {'小明': {'latitude': 25.0330, 'longitude': 121.5654}, '小華': {'latitude': 25.0478, 'longitude': 121.5170}}
    for name in ['小明', '小華']:
        ctx = b.new_context(permissions=['microphone', 'geolocation'], geolocation=geo[name], viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        pg = ctx.new_page(); bins[name] = {'in': 0, 'out': 0}
        def onws(ws, name=name):
            ws.on('framereceived', lambda f: bins[name].__setitem__('in', bins[name]['in'] + (0 if isinstance(f, str) else 1)))
            ws.on('framesent', lambda f: bins[name].__setitem__('out', bins[name]['out'] + (0 if isinstance(f, str) else 1)))
        pg.on('websocket', onws); pg.on('request', lambda r: reqs.append(r.url)); pg.on('dialog', lambda d: d.accept())
        pg.goto(BASE)
        pages[name] = pg
    A, B = pages['小明'], pages['小華']
    # 登入
    A.fill('#org', 'DEMO'); A.fill('#username', users['小明']['username']); A.fill('#password', 'wrong-password'); A.click('#enter')
    A.wait_for_function("document.querySelector('#loginErr').textContent.length > 0", timeout=8000)
    ok('錯誤密碼顯示錯誤訊息、不能進入', '錯誤' in A.inner_text('#loginErr') and A.is_hidden('#main'), A.inner_text('#loginErr'))
    for name, pg in pages.items():
        pg.fill('#org', 'DEMO'); pg.fill('#username', users[name]['username']); pg.fill('#password', users[name]['password']); pg.click('#enter')
        pg.wait_for_selector('#connText:has-text("已連線")', timeout=15000)
    ok('兩個帳號用帳密登入成功', True)
    hint = A.inner_text('#sttHint')
    ok('對講畫面說明即時字幕（支援或不支援都會顯示說明）', '字幕' in hint or '語音轉文字' in hint, hint)
    time.sleep(1)
    A.click('[data-tab="members"]'); names = A.inner_text('#memberList')
    ok('自動加入「大廳」且看到彼此與角色', '小明' in names and '小華' in names and '一般' in names, names.replace('\n', ' '))
    # 對講
    def center(pg, sel):
        bx = pg.locator(sel).bounding_box(); return bx['x'] + bx['width'] / 2, bx['y'] + bx['height'] / 2
    ax, ay = center(A, '#ptt'); bx, by = center(B, '#ptt')
    A.mouse.move(ax, ay); A.mouse.down(); A.wait_for_selector('#ptt.talking', timeout=6000); time.sleep(0.8)
    st = B.inner_text('#talkStatus')
    ok('B 畫面顯示「小明 正在說話」', '小明 正在說話' in st, st)
    B.mouse.move(bx, by); B.mouse.down(); time.sleep(0.5); bt = B.inner_text('#pttText'); tb = B.evaluate("document.querySelector('#ptt').classList.contains('talking')"); B.mouse.up()
    ok('B 搶話被擋（同為一般）', '小明' in bt and not tb, bt)
    time.sleep(1.2); A.mouse.up(); time.sleep(1.2)
    ok('A 送出語音、B 即時收到', bins['小明']['out'] >= 10 and bins['小華']['in'] >= 10, f"送 {bins['小明']['out']} / 收 {bins['小華']['in']}")
    ok('B 顯示「最近說話：小明」', '最近說話：小明' in B.inner_text('#lastTalk'))
    A.fill('#chatInput', '哈囉這是文字訊息'); A.click('#chatForm .send-btn')
    B.wait_for_function("document.querySelector('#chatList').innerText.includes('哈囉這是文字訊息')", timeout=8000)
    ok('B 即時看到 A 送出的文字訊息', '哈囉這是文字訊息' in B.inner_text('#chatList') and '小明' in B.inner_text('#chatList'))
    # 只聽
    api('PUT', f"/api/admin/channels/lobby/members/{users['小華']['id']}", {'role': 'listener'}, ADM)
    B.wait_for_function("document.querySelector('#pttText').textContent.includes('只聽')", timeout=8000)
    B.mouse.move(bx, by); B.mouse.down(); time.sleep(0.5); talking = B.evaluate("document.querySelector('#ptt').classList.contains('talking')"); B.mouse.up()
    ok('後台把 B 設為「只聽」→ 按鈕顯示只聽且不能講', not talking and '只聽' in B.inner_text('#roleBadge'), B.inner_text('#roleBadge'))
    # 優先搶話：A 設為主管，B 回一般；B 先講，A 按下中斷
    api('PUT', f"/api/admin/channels/lobby/members/{users['小華']['id']}", {'role': 'member'}, ADM)
    api('PUT', f"/api/admin/channels/lobby/members/{users['小明']['id']}", {'role': 'supervisor'}, ADM)
    A.wait_for_function("document.querySelector('#roleBadge').textContent.includes('主管')", timeout=8000)
    B.wait_for_function("document.querySelector('#pttText').textContent.includes('按住講話')", timeout=8000)
    ax, ay = center(A, '#ptt'); bx, by = center(B, '#ptt')
    B.mouse.move(bx, by); B.mouse.down(); B.wait_for_selector('#ptt.talking', timeout=6000); time.sleep(0.6)
    A.mouse.move(ax, ay); A.mouse.down(); A.wait_for_selector('#ptt.talking', timeout=6000)
    B.wait_for_function("document.querySelector('#toast').textContent.includes('中斷')", timeout=6000)
    ok('主管 A 按下中斷 B，B 畫面提示被中斷', '小明' in B.inner_text('#toast') and not B.evaluate("document.querySelector('#ptt').classList.contains('talking')"), B.inner_text('#toast'))
    time.sleep(0.5); A.mouse.up(); B.mouse.up(); time.sleep(0.8)
    # 地圖與位置
    A.click('[data-tab="map"]'); A.check('#shareLoc')
    B.click('[data-tab="map"]'); B.check('#shareLoc')
    B.wait_for_function("document.querySelector('#locList').textContent.includes('小明')", timeout=15000)
    ll = B.inner_text('#locList')
    ok('B 的地圖頁看到 A 的位置、電量與更新時間', '小明' in ll and '電量' in ll and ('秒前' in ll or '分鐘前' in ll), ll.replace('\n', ' | '))
    try: B.wait_for_function("document.querySelectorAll('.leaflet-marker-icon').length >= 2", timeout=15000)
    except Exception: pass
    nmk = B.evaluate("document.querySelectorAll('.leaflet-marker-icon').length")
    attr = B.inner_text('.leaflet-control-attribution')
    ok('Leaflet 地圖有標記並標示 OpenStreetMap 來源', nmk >= 2 and 'OpenStreetMap' in attr, f'{nmk} 個標記；{attr}')
    # 緊急警報：長按不足 2 秒 → 取消
    A.click('[data-tab="channels"]')
    sx, sy = center(A, '#sos')
    A.mouse.move(sx, sy); A.mouse.down(); time.sleep(0.8); A.mouse.up(); time.sleep(0.8)
    ok('長按不足 2 秒不會發出警報（防誤觸）', B.is_hidden('#alertOverlay'))
    A.mouse.move(sx, sy); A.mouse.down(); time.sleep(2.4); A.mouse.up()
    B.wait_for_selector('#alertOverlay:not(.hidden)', timeout=10000)
    who = B.inner_text('#alertWho'); where = B.inner_text('#alertWhere'); href = B.get_attribute('#alertMapLink', 'href') or ''
    ok('B 出現全螢幕警報，含姓名、位置與地圖連結', '小明' in who and '25.03' in where and 'openstreetmap.org' in href, f'{who} / {where}')
    ok('一般成員 B 沒有「解除警報」按鈕', B.is_hidden('#alertResolve'))
    siren = B.evaluate("!!siren")
    ok('B 播放警示音', siren)
    # 管理員從後台解除
    actx = b.new_context(viewport={'width': 1100, 'height': 900}); ap = actx.new_page(); ap.on('dialog', lambda d: d.accept())
    ap.goto(BASE + '/admin'); ap.fill('#org', 'DEMO'); ap.fill('#username', AU); ap.fill('#password', AP); ap.click('#loginForm button')
    ap.wait_for_selector('#panels:not(.hidden)', timeout=10000)
    ap.wait_for_selector('#alertList button[data-resolve]', timeout=10000)
    ok('後台看到進行中的警報', '小明' in ap.inner_text('#alertList'))
    ap.click('#alertList button[data-resolve]')
    B.wait_for_selector('#alertOverlay', state='hidden', timeout=10000)
    ok('管理員解除後，B 的警報畫面關閉並提示已解除', B.is_hidden('#alertOverlay') and B.is_hidden('#alertBanner'))
    # 後台建立使用者
    ap.fill('#nuUsername', f't_ui_{sfx}'); ap.fill('#nuName', '後台建立'); ap.click('#newUser button')
    ap.wait_for_selector(f'#userRows tr:has-text("t_ui_{sfx}")', timeout=8000)
    npw = ap.inner_text('#newPw')
    ok('後台介面建立使用者並顯示一次性密碼', '自動產生的密碼' in npw)
    ap.wait_for_selector('#saveCaptions', timeout=8000)
    ok('後台有儲存字幕開關且預設關閉', ap.is_visible('#saveCaptions') and not ap.is_checked('#saveCaptions'))
    _, ul = api('GET', '/api/admin/users', None, ADM)
    for u in ul['users']:
        if u['username'] == f't_ui_{sfx}': users['ui'] = {'id': u['id']}
    # 調度台
    dctx = b.new_context(permissions=['microphone'], viewport={'width': 1440, 'height': 900})
    dp = dctx.new_page(); dp.on('dialog', lambda d: d.accept())
    dp.goto(BASE + '/dispatch')
    dp.fill('#org', 'DEMO'); dp.fill('#username', users['調度']['username']); dp.fill('#password', users['調度']['password']); dp.click('#loginForm button')
    dp.wait_for_selector('#desk:not(.hidden)', timeout=15000)
    dp.wait_for_function("document.querySelector('#chList') && document.querySelector('#chList').innerText.includes('大廳')", timeout=15000)
    ok('調度台桌面版顯示頻道清單、佇列與地圖', dp.is_visible('#chList') and dp.is_visible('#queueList') and dp.is_visible('#map') and '大廳' in dp.inner_text('#chList'))
    A.click('#callDispatch')
    dp.wait_for_selector('#queueList button[data-pick]', timeout=10000)
    ok('個人呼叫出現在調度台來電佇列', '小明' in dp.inner_text('#queueList'))
    dp.click('#queueList button[data-pick]')
    A.wait_for_function("document.querySelector('#dispatchStatus').textContent.includes('已接聽')", timeout=10000)
    dp.wait_for_function("document.querySelector('#targetLabel') && document.querySelector('#targetLabel').innerText.includes('一對一')", timeout=8000)
    ok('接聽後呼叫者看到一對一提示', '已接聽' in A.inner_text('#dispatchStatus') and '一對一' in dp.inner_text('#targetLabel'))
    dp.click('#doneBtn')
    A.wait_for_function("document.querySelector('#dispatchStatus').classList.contains('hidden') || document.querySelector('#dispatchStatus').textContent === ''", timeout=8000)
    dp.screenshot(path='test/screenshot_dispatch.png', full_page=True)
    # 非管理員進後台與調度台
    B.goto(BASE + '/admin'); B.wait_for_selector('#denied:not(.hidden)', timeout=8000)
    ok('非管理員打開 /admin 顯示「需要管理員權限」', B.is_visible('#denied') and B.is_hidden('#panels'))
    B.goto(BASE + '/dispatch'); B.wait_for_selector('#denied:not(.hidden)', timeout=8000)
    ok('一般使用者打開 /dispatch 顯示需要調度員權限', B.is_visible('#denied') and B.is_hidden('#desk'))
    bad = [u for u in reqs if '/audio/' in u or '/api/history' in u or u.endswith('.wav')]
    ok('整個過程沒有請求任何錄音或歷史', not bad, f'{len(reqs)} 個請求')
    A.screenshot(path='test/screenshot_A.png'); ap.screenshot(path='test/screenshot_admin.png', full_page=True)
    b.close()
finally:
    for k, u in users.items(): api('DELETE', f"/api/admin/users/{u['id']}", None, ADM)
    _, ul = api('GET', '/api/admin/users', None, ADM)
    left = [u['username'] for u in ul['users'] if sfx in u['username']]
    api('POST', '/api/logout', {}, ADM)
    ok('清理測試帳號', not left, ','.join(u['username'] for u in ul['users']))
print(f"\n{sum(res)}/{len(res)} 通過"); sys.exit(0 if all(res) else 1)
