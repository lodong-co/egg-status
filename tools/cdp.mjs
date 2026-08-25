/** 크롬을 CDP 로 모는 최소 도구. 클릭은 진짜 마우스 이벤트로 보낸다. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function open(port) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eggbox-cdp-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--window-size=1440,1000',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i += 1) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/version');
      const j = await r.json();
      wsUrl = j.webSocketDebuggerUrl;
    } catch { await sleep(250); }
  }
  if (!wsUrl) throw new Error('크롬이 안 뜬다');

  const ws = new WebSocket(wsUrl);
  await new Promise((r) => { ws.onopen = r; });
  const waiting = new Map();
  const events = [];
  const listeners = [];
  let id = 0;
  let sessionId = null;

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error) w.rej(new Error(m.error.message)); else w.res(m.result);
    } else if (m.method) {
      events.push(m.method);
      for (const fn of listeners) fn(m);
    }
  };

  const send = (method, params = {}, useSession = true) => {
    const msg = { id: (id += 1), method, params };
    if (useSession && sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => waiting.set(msg.id, { res, rej }));
  };

  const created = await send('Target.createTarget', { url: 'about:blank' }, false);
  const att = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true }, false);
  sessionId = att.sessionId;
  await send('Page.enable');
  await send('Runtime.enable');

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expression.slice(0, 70));
    return r.result ? r.result.value : undefined;
  };

  const goto = async (url) => {
    events.length = 0;
    await send('Page.navigate', { url });
    for (let i = 0; i < 100; i += 1) {
      if (events.includes('Page.loadEventFired')) break;
      await sleep(100);
    }
    await sleep(1800);
  };

  const until = async (expr, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evaluate(expr)) return true;
      await sleep(150);
    }
    return false;
  };

  /**
   * 진짜 마우스로 누른다.
   *
   * <p>element.click() 은 Next 의 Link 에서 화면 이동을 일으키지 못했다.
   * 실제 사용자는 좌표를 누르므로 그쪽으로 맞춘다.
   */
  const clickAt = async (finderJs) => {
    const box = await evaluate(
      '(function(){var el=' + finderJs + ';if(!el)return null;'
      + 'el.scrollIntoView({block:"center"});var r=el.getBoundingClientRect();'
      + 'if(r.width===0||r.height===0)return null;'
      + 'return {x:r.left+r.width/2,y:r.top+r.height/2};})()',
    );
    if (!box) return false;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
      });
    }
    return true;
  };

  const close = async () => {
    try { ws.close(); } catch { /* 무시 */ }
    proc.kill();
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 무시 */ }
  };

  const on = (fn) => { listeners.push(fn); };

  return { send, evaluate, goto, until, clickAt, on, close };
}
