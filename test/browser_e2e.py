# 真實瀏覽器端對端測試（Chromium + 假麥克風）：python3 test/browser_e2e.py [baseUrl]
import sys, time, json
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8800'
res = []
def ok(n, c, x=''): res.append(c); print('PASS' if c else 'FAIL', n, x)
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
    pages, bins = [], {}
    for name in ['小明', '小華']:
        ctx = b.new_context(permissions=['microphone'], viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        pg = ctx.new_page(); bins[name] = {'in': 0, 'out': 0}
        def onws(ws, name=name):
            ws.on('framereceived', lambda f: bins[name].__setitem__('in', bins[name]['in'] + (0 if isinstance(f, str) else 1)))
            ws.on('framesent', lambda f: bins[name].__setitem__('out', bins[name]['out'] + (0 if isinstance(f, str) else 1)))
        pg.on('websocket', onws)
        pg.goto(BASE); pg.fill('#nick', name); pg.click('#enter')
        pg.wait_for_selector('#connText:has-text("已連線")', timeout=10000)
        pages.append(pg)
    A, B = pages
    time.sleep(1)
    A.click('[data-tab="members"]')
    names = A.inner_text('#memberList')
    ok('兩個瀏覽器都自動加入「大廳」且看到彼此', '小明' in names and '小華' in names, names.replace('\n', ' '))
    # A 按住講話 2.5 秒
    box = A.locator('#ptt').bounding_box(); cx, cy = box['x'] + box['width']/2, box['y'] + box['height']/2
    A.mouse.move(cx, cy); A.mouse.down()
    A.wait_for_selector('#ptt.talking', timeout=5000)
    ok('A 按下後取得發言權（按鈕變紅「說話中」）', True, A.inner_text('#pttText'))
    time.sleep(0.8)
    st = B.inner_text('#talkStatus')
    ok('B 畫面顯示「小明 正在說話」', '小明 正在說話' in st, st)
    # B 在 A 講話時按下 → 被擋
    bb = B.locator('#ptt').bounding_box(); B.mouse.move(bb['x']+bb['width']/2, bb['y']+bb['height']/2); B.mouse.down(); time.sleep(0.4)
    bt = B.inner_text('#pttText'); talking_b = B.evaluate("document.querySelector('#ptt').classList.contains('talking')")
    B.mouse.up()
    ok('B 搶話被擋，按鈕顯示「小明 正在說話」', ('小明' in bt) and not talking_b, bt)
    time.sleep(1.7); A.mouse.up(); time.sleep(1.2)
    ok('A 的瀏覽器實際送出麥克風語音封包', bins['小明']['out'] >= 15, f"{bins['小明']['out']} 包")
    ok('B 的瀏覽器即時收到語音封包', bins['小華']['in'] >= 15, f"{bins['小華']['in']} 包")
    live = B.evaluate("({state: actx && actx.state, t: actx && actx.currentTime})")
    ok('B 的 AudioContext 為 running（可播放）', live['state'] == 'running', json.dumps(live))
    B.wait_for_selector('#historyList li[data-id]', timeout=5000)
    h = B.inner_text('#historyList li[data-id]')
    ok('B 的語音紀錄出現小明的留言', '小明' in h, h.replace('\n', ' '))
    B.click('#historyList button[data-play]'); time.sleep(1.0)
    pl = B.evaluate("({paused: player.paused, t: player.currentTime, dur: player.duration, err: player.error && player.error.code})")
    ok('B 點「播放」可回放歷史語音', (pl['t'] > 0.3 and not pl['err']), json.dumps(pl))
    # 私人對講：A 點小華
    A.click('#memberList li[data-name="小華"]')
    lbl = A.inner_text('#targetLabel'); ok('A 點成員進入私人對講', '私人對講：小華' in lbl, lbl)
    A.mouse.move(cx, cy); A.mouse.down(); A.wait_for_selector('#ptt.talking', timeout=5000); time.sleep(1.5); A.mouse.up(); time.sleep(1.2)
    B.click('[data-tab="dms"]'); dm = B.inner_text('#dmList')
    ok('B 的私訊清單出現小明', '小明' in dm, dm.replace('\n', ' '))
    # 自動重連：模擬 A 網路中斷
    A.context.set_offline(True); A.evaluate("S.ws.close()"); time.sleep(1.5)
    off = A.inner_text('#connText'); A.context.set_offline(False)
    A.wait_for_selector('#connText:has-text("已連線")', timeout=20000)
    ok('斷線顯示狀態並自動重連', ('斷線' in off or '重新連線' in off), off)
    A.screenshot(path='test/screenshot_A.png'); B.screenshot(path='test/screenshot_B.png')
    b.close()
print(f"\n{sum(res)}/{len(res)} 通過"); sys.exit(0 if all(res) else 1)
