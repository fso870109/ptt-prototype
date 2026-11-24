# 持續說話（鎖定講話／聲控）真實瀏覽器測試（Chromium + 假麥克風）
# 用法：ADMIN_USERNAME=... ADMIN_PASSWORD=... python3 test/browser_talkmodes.py [baseUrl]
import sys, os, time, json, urllib.request
from playwright.sync_api import sync_playwright
BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8800').rstrip('/')
AU, AP = os.environ['ADMIN_USERNAME'], os.environ['ADMIN_PASSWORD']
SHOTS = os.environ.get('SHOT_DIR', '')
res = []
DBG = []
def ok(n, c, x=''):
    res.append(bool(c)); print('PASS' if c else 'FAIL', n, x)
    if not c and DBG:
        try: print('  EventLog:', '\n   '.join(DBG[0].evaluate("EventLog.lines.slice(-15)")), '\n  state:', DBG[0].evaluate("JSON.stringify({pressing:S.pressing,granted:S.granted,locked:S.locked,kind:S.talkKind,P, disabled: btn.disabled, at: (() => { const r = btn.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2); return e ? (e.id || e.className || e.tagName) + ' ' + (e.textContent||'').slice(0,60) : null })(), rect: btn.getBoundingClientRect().toJSON(), scrollY})"))
        except Exception as e: print('  dbg err', e)
def api(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
sfx = hex(int(time.time()))[-5:]
_, j = api('POST', '/api/login', {'username': AU, 'password': AP, 'org': 'DEMO'}); ADM = j['token']
users = {}
for key, name in [('ma', '甲'), ('mb', '乙')]:
    s, j = api('POST', '/api/admin/users', {'username': f't_{key}_{sfx}', 'displayName': name, 'password': f'{key}-Pass-1234'}, ADM)
    users[name] = {'id': j['user']['id'], 'username': j['user']['username'], 'password': f'{key}-Pass-1234'}
try:
  with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
    pages, bins = {}, {}
    for name in ['甲', '乙']:
        ctx = b.new_context(permissions=['microphone'], viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        pg = ctx.new_page(); bins[name] = {'in': 0, 'out': 0}
        def onws(ws, name=name):
            ws.on('framereceived', lambda f: bins[name].__setitem__('in', bins[name]['in'] + (0 if isinstance(f, str) else 1)))
            ws.on('framesent', lambda f: bins[name].__setitem__('out', bins[name]['out'] + (0 if isinstance(f, str) else 1)))
        pg.on('websocket', onws); pg.on('dialog', lambda d: d.accept())
        pg.goto(BASE); pages[name] = pg
        pg.fill('#org', 'DEMO'); pg.fill('#username', users[name]['username']); pg.fill('#password', users[name]['password']); pg.click('#enter')
        pg.wait_for_selector('#connText:has-text("已連線")', timeout=20000)
    A, B = pages['甲'], pages['乙']
    DBG.append(A)
    time.sleep(1)
    def center(pg, sel):
        bx = pg.locator(sel).bounding_box(); return bx['x'] + bx['width'] / 2, bx['y'] + bx['height'] / 2
    def tap_xy():
        A.locator('#ptt').scroll_into_view_if_needed(); return center(A, '#ptt')
    def cls(pg): return pg.evaluate("document.querySelector('#ptt').className")
    ok('預設為按住講話', '按住講話' in A.inner_text('#modeChip') and '按住講話' in A.inner_text('#pttText'))
    # 設定頁切到鎖定講話
    A.click('#modeChip'); A.wait_for_selector('#talkModeGrid', state='visible')
    A.click('#talkModeGrid [data-mode="lock"]')
    ok('設定頁可選「鎖定講話」並記住', A.evaluate("localStorage.getItem('ptt_talk_mode')") == 'lock' and 'active' in A.get_attribute('#talkModeGrid [data-mode="lock"]', 'class'))
    if SHOTS: A.screenshot(path=SHOTS + '/settings_lock.png', full_page=True)
    A.click('.tabs button[data-tab="channels"]')
    ax, ay = center(A, '#ptt')
    ax, ay = tap_xy(); A.mouse.move(ax, ay); A.mouse.down(); time.sleep(0.12); A.mouse.up()
    A.wait_for_selector('#ptt.talking.locked', timeout=8000)
    out0 = bins['甲']['out']; time.sleep(3)
    st = B.inner_text('#talkStatus')
    ok('點一下就鎖定講話，放開後仍持續發送 3 秒', 'talking' in cls(A) and bins['甲']['out'] - out0 >= 20 and '甲 正在說話' in st, f"送 {bins['甲']['out'] - out0} 包；{st}")
    ok('鎖定時按鈕顯示「鎖定講話中」', '鎖定講話中' in A.inner_text('#pttText'), A.inner_text('#pttText'))
    if SHOTS: A.screenshot(path=SHOTS + '/locked.png')
    if SHOTS: print('DEBUG at point:', A.evaluate("(() => { const e = document.elementFromPoint(%f, %f); return e ? (e.id || e.className || e.tagName) : null })()" % (ax, ay)), center(A, '#ptt'), (ax, ay))
    A.evaluate("EventLog.add('test', 'second tap')")
    ax, ay = tap_xy(); A.mouse.move(ax, ay); A.mouse.down(); time.sleep(0.1); A.mouse.up(); time.sleep(0.8)
    ok('再點一下結束鎖定講話', 'talking' not in cls(A) and 'locked' not in cls(A), cls(A))
    time.sleep(0.6)
    ok('對方顯示最近說話：甲', '最近說話：甲' in B.inner_text('#lastTalk'))
    # 鎖定模式下長按＝一般按住講話
    ax, ay = tap_xy(); A.mouse.move(ax, ay); A.mouse.down(); A.wait_for_selector('#ptt.talking', timeout=6000); time.sleep(0.9); A.mouse.up(); time.sleep(0.8)
    ok('鎖定模式長按放開就結束（按住講話照常可用）', 'talking' not in cls(A) and 'locked' not in cls(A), cls(A))
    # 鎖定講話中切換到私訊 → 自動結束
    ax, ay = tap_xy(); A.mouse.move(ax, ay); A.mouse.down(); time.sleep(0.12); A.mouse.up(); A.wait_for_selector('#ptt.talking.locked', timeout=8000)
    A.evaluate("openDm(%s, '乙')" % json.dumps(users['乙']['id']))
    time.sleep(1)
    ok('鎖定講話中切換對話會自動結束', 'talking' not in cls(A), cls(A))
    A.click('#backToChannel'); time.sleep(0.5)
    # 聲控
    A.click('#modeChip'); A.click('#talkModeGrid [data-mode="vox"]')
    ok('選聲控會出現靈敏度與音量表', A.is_visible('#voxSens') and A.is_visible('#voxTest'))
    A.evaluate("document.querySelector('#voxSens').value = 100; document.querySelector('#voxSens').dispatchEvent(new Event('input'))")
    A.click('#voxTest'); lvl = 0; t0 = time.time()
    while time.time() - t0 < 3:
        lvl = max(lvl, A.evaluate("parseFloat(document.querySelector('#voxLevel').style.width) || 0")); time.sleep(0.05)
    ok('測試麥克風時音量表會動', lvl > 0, f'{lvl}%')
    if SHOTS: A.screenshot(path=SHOTS + '/settings_vox.png', full_page=True)
    A.click('#voxTest')
    A.click('.tabs button[data-tab="channels"]')
    ax, ay = tap_xy(); A.mouse.move(ax, ay); A.mouse.down(); time.sleep(0.12); A.mouse.up(); time.sleep(0.3)
    ok('點一下開啟聲控（待命）', 'vox-armed' in cls(A) and '聲控' in A.inner_text('#modeChip'), cls(A))
    out0 = bins['甲']['out']; saw_talk = False; t0 = time.time()
    while time.time() - t0 < 10 and not saw_talk:
        saw_talk = 'vox-talking' in cls(A); time.sleep(0.05)
    time.sleep(1)
    heard = '甲 正在說話' in B.inner_text('#talkStatus') or bins['乙']['in'] > 0
    # 讓麥克風變安靜（停用音軌＝靜音），應在約 0.9 秒後自動放掉發言權
    A.evaluate("mic.getAudioTracks().forEach(t => t.enabled = false)")
    t1 = time.time(); released_at = None
    while time.time() - t1 < 5:
        if 'talking' not in cls(A) and 'pressing' not in cls(A): released_at = time.time() - t1; break
        time.sleep(0.05)
    ok('聲控偵測到聲音自動發話，對方聽得到', saw_talk and heard and bins['甲']['out'] > out0, f"送 {bins['甲']['out'] - out0} 包")
    ok('聲控安靜約 1 秒後自動放掉發言權', released_at is not None and 0.6 <= released_at <= 2.5 and 'vox-armed' in cls(A), f'{released_at}')
    time.sleep(1.5)
    ok('安靜時不會再發話', 'talking' not in cls(A) and 'pressing' not in cls(A))
    A.evaluate("mic.getAudioTracks().forEach(t => t.enabled = true)")
    if SHOTS: A.screenshot(path=SHOTS + '/vox_armed.png')
    ax, ay = tap_xy(); A.mouse.move(ax, ay); A.mouse.down(); time.sleep(0.12); A.mouse.up(); time.sleep(0.5)
    out1 = bins['甲']['out']; time.sleep(2.5)
    ok('再點一下關閉聲控，之後不再發送', 'vox-armed' not in cls(A) and bins['甲']['out'] - out1 <= 2, f"{bins['甲']['out'] - out1}")
    # 聲控：切換對話自動關閉
    ax, ay = tap_xy(); A.mouse.move(ax, ay); A.mouse.down(); time.sleep(0.12); A.mouse.up(); time.sleep(0.3)
    A.evaluate("openDm(%s, '乙')" % json.dumps(users['乙']['id'])); time.sleep(0.5)
    ok('聲控中切換對話會自動關閉聲控', 'vox-armed' not in cls(A))
    b.close()
finally:
    for u in users.values(): api('DELETE', '/api/admin/users/' + u['id'], None, ADM)
    _, cl = api('GET', '/api/admin/calls?limit=1000', None, ADM)
    ids = {u['id'] for u in users.values()}
    for c in (cl.get('calls') or []):
        if c.get('from') in ids or c.get('peerId') in ids: api('DELETE', '/api/admin/calls/' + c['id'], None, ADM)
    api('POST', '/api/logout', {}, ADM)
print(f"\n{sum(res)}/{len(res)} 通過"); sys.exit(0 if all(res) else 1)
