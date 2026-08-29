/**
 * 상태판이 제대로 그리는지 브라우저로 확인한다.
 *
 * <p>고친 것 셋을 본다.
 * <ol>
 *   <li>관리 콘솔 8/19·8/20 이 초록이고, 툴팁에 「보정됨」 과 이유가 뜬다</li>
 *   <li>실패 원인이 사람 말로 나온다 (전에는 아무 데도 안 남았다)</li>
 *   <li>다 떴어도 느린 날은 노랑이다 (전에는 200 이라 초록이었다)</li>
 * </ol>
 */
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, sleep } from './cdp.mjs';

const DOCS = fileURLToPath(new URL('../docs', import.meta.url));
const PORT = 8899;
const TMP = path.join(os.tmpdir(), 'egg-status-slow-check');
let serveFrom = DOCS;

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xml': 'application/xml', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(serveFrom, rel === '/' ? 'index.html' : rel);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('no'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

let pass = 0;
let fail = 0;
const out = [];
const check = (n, ok, d) => { out.push({ n, ok: Boolean(ok), d }); if (ok) pass += 1; else fail += 1; };

let b = null;
try {
  b = await open(9341);
  await b.goto('http://127.0.0.1:' + PORT + '/');
  await b.until("document.querySelectorAll('.comp').length > 0");

  // ── 등급 판정
  const g = async (cell) => b.evaluate('JSON.stringify(grade(' + JSON.stringify(cell) + '))');
  check('다 뜨고 빠르면 정상', JSON.parse(await g({ ok: 10, total: 10, slow: 0 })).cls === 'ok', await g({ ok: 10, total: 10, slow: 0 }));
  check('다 떴어도 느리면 노랑', JSON.parse(await g({ ok: 10, total: 10, slow: 5 })).label === '응답 지연', await g({ ok: 10, total: 10, slow: 5 }));
  // confirmed = 장애로 인정한 점검 수. 연속 두 번부터 프로브가 센다.
  // 이게 없으면(= 한 번 실패하고 바로 돌아옴) 그날은 정상이다.
  const blip = { ok: 99, total: 100, confirmed: 0, fails: { timeout: 1 } };
  check('한 번 실패는 정상', JSON.parse(await g(blip)).cls === 'ok', await g(blip));
  check('조금 실패하면 성능 저하', JSON.parse(await g({ ok: 99, total: 100, confirmed: 1 })).cls === 'degraded', await g({ ok: 99, total: 100, confirmed: 1 }));
  check('절반 넘게 뜨면 부분 장애', JSON.parse(await g({ ok: 60, total: 100, confirmed: 40 })).cls === 'partial', await g({ ok: 60, total: 100, confirmed: 40 }));
  check('대부분 실패면 전체 장애', JSON.parse(await g({ ok: 10, total: 100, confirmed: 90 })).cls === 'major', await g({ ok: 10, total: 100, confirmed: 90 }));
  check('잰 적 없으면 측정 없음', JSON.parse(await g(null)).cls === 'nodata', await g(null));

  // ── 원인이 사람 말로 나오는가
  const cause = await b.evaluate("causeText({fails:{timeout:3,'http-502':2,dns:1}})");
  const causeStr = String(cause);
  check('실패 원인을 사람 말로',
    causeStr.includes('응답 없음(시간 초과) 3회')
    && causeStr.includes('HTTP 502 2회')
    && causeStr.includes('DNS 조회 실패 1회'), cause);

  // ── 보정한 이틀
  const seg = (id, key) => "document.querySelector('.seg[data-comp=\"" + id + "\"][data-key=\"" + key + "\"]')";
  for (const day of ['2026-08-19', '2026-08-20']) {
    const cls = await b.evaluate('(' + seg('console', day) + '||{}).className||"없음"');
    check('관리 콘솔 ' + day + ' 이 초록', /\bok\b/.test(String(cls)) && !/major|partial/.test(String(cls)), cls);
  }
  const tip = await b.evaluate("tipHtml('console','2026-08-19',(window.__st&&0)||{ok:4,total:4,fails:{'probe-404':4},slow:0},'2026-08-19')");
  check('툴팁에 보정 사실이 뜬다', /보정됨/.test(String(tip)), String(tip).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 110));
  check('보정 이유도 같이', /점검 주소 오류/.test(String(tip)), '');

  // ── 다른 컴포넌트의 같은 날은 안 건드렸나
  const webCls = await b.evaluate('(' + seg('web', '2026-08-19') + '||{}).className||"없음"');
  check('웹호스팅 8/19 는 그대로 초록', /\bok\b/.test(String(webCls)), webCls);

  // ── 지금 느리면 「느림」 으로 뜨는가 (느린 상태를 만든 사본으로 확인)
  const slowState = JSON.parse(fs.readFileSync(DOCS + '/state.json', 'utf8'));
  // 프로브가 새 스크립트로 한 번 돌아야 slowMs 가 생긴다. 그 뒤 상태를 흉내 낸다.
  for (const c of slowState.components) c.slowMs = 4000;
  slowState.components[0].latencyMs = 7000;
  fs.mkdirSync(TMP, { recursive: true });
  for (const f of ['index.html', 'incidents.json', 'common.css', 'common.js']) fs.copyFileSync(DOCS + '/' + f, TMP + '/' + f);
  fs.writeFileSync(TMP + '/state.json', JSON.stringify(slowState));
  serveFrom = TMP;
  await b.goto('http://127.0.0.1:' + PORT + '/');
  await b.until("document.querySelectorAll('.comp').length > 0");
  const liveCls = await b.evaluate("document.querySelector('.comp .comp-state').className + '|' + document.querySelector('.comp .comp-state').textContent");
  check('지금 느리면 「느림」 으로', /degraded/.test(String(liveCls)) && /느림/.test(String(liveCls)), liveCls);
  const slowBanner = await b.evaluate("document.getElementById('banner').textContent.trim()");
  check('배너도 응답 지연으로', /응답 지연/.test(String(slowBanner)), slowBanner);
  serveFrom = DOCS;
  await b.goto('http://127.0.0.1:' + PORT + '/');
  await b.until("document.querySelectorAll('.comp').length > 0");

  // ── 전체 화면이 깨지지 않았나
  const comps = await b.evaluate("document.querySelectorAll('.comp').length");
  check('컴포넌트 5줄 다 그려짐', comps === 5, comps);
  const banner = await b.evaluate("document.getElementById('banner').textContent.trim()");
  check('배너 정상', /정상|지연|장애/.test(String(banner)), banner);
  const segs = await b.evaluate("document.querySelectorAll('.seg').length");
  check('막대 90칸 × 5줄', segs === 450, segs);
} catch (err) {
  check('실행', false, err.message);
} finally {
  console.log('');
  for (const o of out) console.log('  ' + (o.ok ? 'OK  ' : 'FAIL') + '  ' + String(o.n).padEnd(36) + ' ' + (o.d === undefined ? '' : o.d));
  console.log('\n  통과 ' + pass + ' · 실패 ' + fail);
  if (b) await b.close();
  server.close();
  await sleep(200);
  process.exit(fail ? 1 : 0);
}
