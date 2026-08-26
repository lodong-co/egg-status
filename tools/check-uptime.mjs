/**
 * 가동률 화면(/uptime)이 제대로 그리는지 브라우저로 확인한다.
 *
 * <p>status.claude.com/uptime 과 같은 형태다 — 컴포넌트마다 석 달 달력,
 * 하루가 한 칸, 달마다 가동률 %.
 *
 * <p>특히 <b>판정이 두 화면에서 같은지</b>를 본다. grade() 가 두 벌이 되면
 * 같은 날이 목록에서는 노랑인데 달력에서는 초록으로 보이게 된다.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, sleep } from './cdp.mjs';

const DOCS = fileURLToPath(new URL('../docs', import.meta.url));
const PORT = 8905;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.xml': 'application/xml', '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(DOCS, rel.endsWith('/') ? rel + 'index.html' : rel);
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

const SITE = 'http://127.0.0.1:' + PORT;
let b = null;

try {
  b = await open(9347);

  // ── 현재 상태 화면에서 가동률로 갈 수 있어야 한다
  await b.goto(SITE + '/');
  await b.until("document.querySelectorAll('.comp').length > 0");
  const upHref = await b.evaluate(
    "([].slice.call(document.querySelectorAll('.uptime-link a'))[0]||{}).getAttribute?"
    + "document.querySelector('.uptime-link a').getAttribute('href'):'없음'",
  );
  check('막대 위에 지난 기록 링크가 있다', upHref === './uptime/', upHref);
  check('안내 문구도 같이', /90일 가동률/.test(String(await b.evaluate("document.querySelector('.uptime-link').textContent"))),
    String(await b.evaluate("document.querySelector('.uptime-link').textContent")).trim());
  check('인시던트 목록은 그대로 그려진다',
    Number(await b.evaluate("document.querySelectorAll('#incidentList .day').length")) > 0,
    (await b.evaluate("document.querySelectorAll('#incidentList .day').length")) + '일치');

  // ── 가동률 화면
  await b.goto(SITE + '/uptime/');
  await b.until("document.querySelectorAll('.uc').length > 0");

  check('컴포넌트 5줄', await b.evaluate("document.querySelectorAll('.uc').length") === 5,
    await b.evaluate("document.querySelectorAll('.uc').length"));
  /* 측정 시작 전의 달은 안 그린다. 빈 회색 격자가 가로의 절반을 먹기 때문이다.
     데이터가 쌓이면 저절로 석 달이 된다 — 그래서 1~3 사이면 맞다. */
  const perComp = await b.evaluate(
    "[].slice.call(document.querySelectorAll('.uc')).map(function(u){return u.querySelectorAll('.month').length})",
  );
  check('컴포넌트마다 달이 1~3개', Array.isArray(perComp) && perComp.length === 5
    && perComp.every(function (n) { return n >= 1 && n <= 3; })
    && new Set(perComp).size === 1, JSON.stringify(perComp));

  /* 그린 달은 전부 측정 시작 이후여야 한다. */
  const tooEarly = await b.evaluate(
    "(function(){var start=STATE.startedAt.slice(0,7);"
    + "return [].slice.call(document.querySelectorAll('.day[data-key]'))"
    + ".filter(function(d){return d.dataset.key.slice(0,7) < start}).length;})()",
  );
  check('측정 시작 전 달은 안 그린다', tooEarly === 0, tooEarly + '칸');
  const range = String(await b.evaluate("document.querySelector('.uc-range').textContent"));
  // 「8월 ~ 8월」 처럼 같은 달을 두 번 적지 않는다.
  check('기간 문구가 자연스럽다', !/(\d+)월 ~ \1월/.test(range), range);

  check('요일 머리가 붙는다',
    (await b.evaluate("document.querySelector('.dow').textContent")) === '일월화수목금토',
    await b.evaluate("document.querySelector('.dow').textContent"));

  // 달력 모양: 1일이 실제 요일 자리에서 시작하는가
  const aligned = await b.evaluate(`(function(){
    var m=document.querySelector('.month .days');
    var kids=[].slice.call(m.children);
    var firstReal=kids.findIndex(function(d){return d.dataset && d.dataset.key;});
    if(firstReal<0) return 'ok-no-data';
    var key=kids[firstReal].dataset.key.split('-');
    var dow=new Date(Date.UTC(+key[0],+key[1]-1,+key[2])).getUTCDay();
    return (firstReal % 7) === dow ? 'ok' : '어긋남 idx='+firstReal+' dow='+dow;
  })()`);
  check('1일이 맞는 요일 칸에서 시작', String(aligned).startsWith('ok'), aligned);

  // ── 이번 달은 숫자가, 데이터 없는 달은 「측정 없음」이 나온다
  const rates = await b.evaluate(
    "[].slice.call(document.querySelectorAll('.uc')[0].querySelectorAll('.month-rate')).map(function(e){return e.textContent.trim()}).join(' | ')",
  );
  check('달마다 가동률이 나온다', /%/.test(String(rates)), rates);
  check('빈 「측정 없음」 달이 남아 있지 않다', !/측정 없음/.test(String(rates)), rates);

  // ── 아직 오지 않은 날은 안 칠한다
  const future = await b.evaluate(`(function(){
    var today = dayKeys(1)[0];
    return [].slice.call(document.querySelectorAll('.day[data-key]'))
      .filter(function(d){ return d.dataset.key > today; }).length;
  })()`);
  check('미래 날짜는 칠하지 않는다', future === 0, future + '칸');

  // ── 보정한 이틀은 여기서도 초록
  for (const day of ['2026-08-19', '2026-08-20']) {
    const cls = await b.evaluate(
      "(document.querySelector('.day[data-comp=\"console\"][data-key=\"" + day + "\"]')||{}).className||'없음'",
    );
    check('관리 콘솔 ' + day + ' 초록', /\bok\b/.test(String(cls)) && !/major|partial/.test(String(cls)), cls);
  }

  // ── 판정이 목록 화면과 같은가 (grade 가 한 벌인지)
  const same = await b.evaluate(
    "JSON.stringify([grade({ok:10,total:10,slow:0}),grade({ok:10,total:10,slow:5}),grade({ok:60,total:100}),grade(null)])",
  );
  check('판정 함수가 목록 화면과 같다',
    String(same) === '[{"cls":"ok","label":"정상"},{"cls":"degraded","label":"응답 지연"},{"cls":"partial","label":"부분 장애"},{"cls":"nodata","label":"측정 없음"}]',
    String(same).slice(0, 70) + '…');

  // ── 툴팁
  await b.evaluate(`(function(){
    var d=document.querySelector('.day[data-comp="console"][data-key="2026-08-19"]');
    d.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));return true;})()`);
  await sleep(300);
  const tip = await b.evaluate("document.getElementById('tip').textContent");
  check('칸에 올리면 툴팁이 뜬다', /2026년 8월 19일/.test(String(tip)), String(tip).replace(/\s+/g, ' ').slice(0, 80));
  check('보정 사실도 툴팁에', /보정됨/.test(String(tip)), '');

  // ── 되돌아가는 길
  const back = await b.evaluate("(document.querySelector('.back a')||{}).getAttribute?document.querySelector('.back a').getAttribute('href'):'없음'");
  check('현재 상태로 돌아가는 링크', back === '../', back);
  check('마지막 점검 시각이 나온다', /마지막 점검 20/.test(String(await b.evaluate("document.getElementById('checked').textContent"))),
    await b.evaluate("document.getElementById('checked').textContent"));
} catch (err) {
  check('실행', false, String(err.message || err).split('\n')[0]);
} finally {
  console.log('');
  for (const o of out) console.log('  ' + (o.ok ? 'OK  ' : 'FAIL') + '  ' + String(o.n).padEnd(32) + ' ' + (o.d === undefined ? '' : o.d));
  console.log('\n  통과 ' + pass + ' · 실패 ' + fail);
  if (b) await b.close();
  server.close();
  await sleep(200);
  process.exit(fail ? 1 : 0);
}
