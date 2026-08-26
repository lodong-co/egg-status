/**
 * 인시던트 자동 기록을 실제로 돌려 본다.
 *
 * <p>진짜 서비스를 죽일 수는 없으니, 프로브 사본이 우리가 조종하는 서버를 보게 하고
 * 그 서버를 죽였다 살린다.
 *
 * <p>기준이 <b>시간</b>(30분 계속 실패)이라 30분을 기다릴 수는 없다.
 * 대신 state.json 의 downSince 를 과거로 되감아서 "이미 31분째" 인 상황을 만든다.
 * 프로브 입장에서는 실제로 그만큼 지난 것과 구분되지 않는다.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run1 = promisify(execFile);

const SRC = fileURLToPath(new URL('../scripts/probe.mjs', import.meta.url));
const ROOT = path.join(os.tmpdir(), 'egg-status-inc-test');
const PORT = 8901;

let pass = 0;
let fail = 0;
const out = [];
const check = (n, ok, d) => { out.push({ n, ok: Boolean(ok), d }); if (ok) pass += 1; else fail += 1; };

/** 서버가 무슨 답을 줄지. 검사가 바꾼다. */
const mode = { console: 200, web: 200, cloud: 200, domain: 200, login: 200 };

const server = http.createServer((req, res) => {
  const id = req.url.replace(/^\//, '').split('?')[0];
  const code = mode[id] ?? 200;
  res.writeHead(code, { 'Content-Type': 'text/plain' });
  res.end(String(code));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// ── 사본 준비: 프로브가 우리 서버를 보게 한다
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
let code = fs.readFileSync(SRC, 'utf8');
const ids = [];
code.replace(/id: '([a-z]+)'/g, (m, g) => { ids.push(g); return m; });
let i = 0;
code = code.replace(/url: 'https:\/\/[^']*'/g, () => "url: 'http://127.0.0.1:" + PORT + "/" + ids[i++] + "'");
fs.writeFileSync(path.join(ROOT, 'scripts', 'probe.mjs'), code);

const DOCS = path.join(ROOT, 'docs');
const INC = path.join(DOCS, 'incidents.json');
const ST = path.join(DOCS, 'state.json');

// 사람이 쓴 인시던트 하나를 미리 넣어 둔다. 프로브가 이걸 건드리면 안 된다.
const HUMAN = {
  title: '사람이 쓴 글', impact: 'major', components: ['web'],
  startedAt: '2026-08-01T15:00:00Z', resolvedAt: '2026-08-01T16:00:00Z',
  updates: [{ at: '2026-08-01T16:00:00Z', status: 'resolved', body: '건드리면 안 된다.' }],
};
const reset = () => {
  fs.writeFileSync(INC, JSON.stringify([HUMAN], null, 2));
  fs.writeFileSync(ST, JSON.stringify({ schema: 1, startedAt: null, updatedAt: null, components: [], daily: {} }));
};
reset();

/* 반드시 비동기로. execFileSync 는 부모 이벤트 루프를 막아서
   이 파일의 테스트 서버가 요청에 답을 못 하고, 전부 timeout 이 된다. */
const run = async () => (await run1('node', [path.join(ROOT, 'scripts', 'probe.mjs')], { encoding: 'utf8' })).stdout;
const incs = () => JSON.parse(fs.readFileSync(INC, 'utf8'));
const autoFor = (id) => incs().find((x) => x.auto && (x.components || []).includes(id));

/** 「이미 N분째 죽어 있었다」로 만든다. 30분을 실제로 기다릴 수는 없다. */
const rewind = (id, minutes) => {
  const st = JSON.parse(fs.readFileSync(ST, 'utf8'));
  const c = st.components.find((x) => x.id === id);
  c.downSince = new Date(Date.now() - minutes * 60000).toISOString();
  fs.writeFileSync(ST, JSON.stringify(st));
};

try {
  // ── 1. 다 정상일 때는 아무것도 안 생긴다
  await run(); await run();
  check('정상일 땐 인시던트 안 생김', incs().length === 1, incs().length + '건 (사람이 쓴 1건만)');

  // ── 2. 30분 안에는 몇 번을 실패해도 안 연다
  mode.console = 503;
  await run();
  check('한 번 실패로는 안 연다', !autoFor('console'), '');
  await run(); await run(); await run();
  check('30분 안이면 여러 번 실패해도 안 연다', !autoFor('console'), '배포 중 튐 방지');

  // ── 3. 30분을 넘겨 계속 실패하면 연다
  rewind('console', 31);
  const log3 = await run();
  const opened = autoFor('console');
  check('30분 넘게 계속 실패하면 연다', Boolean(opened), opened ? opened.title : '안 열림');
  check('로그에도 남는다', /인시던트 열림/.test(log3), (log3.match(/▶.*/) || [''])[0].trim());
  check('본문에 몇 분째인지', /3\dㅂ?분째 응답하지 않고 있습니다/.test(opened?.updates?.[0]?.body || ''), opened?.updates?.[0]?.body);
  check('원인을 사람 말로', /HTTP 503/.test(opened?.updates?.[0]?.body || ''), '');
  check('조사가 맞다 (「이(가)」 아님)',
    /관리 콘솔이 /.test(opened?.updates?.[0]?.body || '') && !/\(가\)/.test(opened?.updates?.[0]?.body || ''), '');
  check('어느 컴포넌트인지 붙는다', opened?.components?.[0] === 'console', JSON.stringify(opened?.components));

  // ── 4. 계속 죽어 있어도 하나만
  await run(); await run();
  check('계속 죽어도 글은 하나', incs().filter((x) => x.auto && (x.components || []).includes('console')).length === 1, '');

  // ── 5. 살아나면 닫힌다
  mode.console = 200;
  const logR = await run();
  const closed = autoFor('console');
  check('회복하면 닫힌다', Boolean(closed?.resolvedAt), closed?.resolvedAt);
  check('닫힘도 로그에', /인시던트 닫힘/.test(logR), (logR.match(/◀.*/) || [''])[0].trim());
  const last = closed?.updates?.[closed.updates.length - 1];
  check('중단 시간이 적힌다', /약 \d+분 동안 응답하지 않았습니다/.test(last?.body || ''), last?.body);
  check('마지막 상태가 resolved', last?.status === 'resolved', last?.status);

  // ── 6. 다시 죽으면 새 글이 열린다
  mode.console = 503;
  await run(); rewind('console', 31); await run();
  const again = incs().filter((x) => x.auto && (x.components || []).includes('console'));
  check('다시 죽으면 새 글', again.length === 2, again.length + '건');
  check('앞 글은 닫힌 채로', Boolean(again[0].resolvedAt) && !again[1].resolvedAt, '');
  mode.console = 200; await run();

  // ── 7. 사람이 쓴 글은 그대로
  const human = incs().find((x) => !x.auto);
  check('사람이 쓴 글 안 건드림', JSON.stringify(human) === JSON.stringify(HUMAN), human?.title);

  // ── 8. 잠깐 튀었다 돌아오면 아무 일 없다 (30분을 못 채운다)
  reset();
  await run();
  mode.web = 503; await run(); await run();
  mode.web = 200; await run(); await run();
  check('잠깐 튀었다 돌아오면 글 없음', !autoFor('web'), '30분을 못 채웠다');

  // ── 9. 점검 주소가 틀린 경우엔 열지 않는다 (측정 불가)
  reset();
  mode.domain = 404;
  await run(); await run();
  rewind('domain', 60);
  await run();
  check('한 번도 200 못 받은 404 는 안 연다', !autoFor('domain'), autoFor('domain') ? '열림 ❌' : '안 열림');
  const st = JSON.parse(fs.readFileSync(ST, 'utf8'));
  const today = Object.keys(st.daily.domain).sort().pop();
  check('그 실패는 측정에서 빠진다', st.daily.domain[today].total === 0, JSON.stringify(st.daily.domain[today]));

  // ── 10. 한 번 200 을 받은 뒤의 404 는 진짜 장애로 센다
  mode.domain = 200; await run();
  mode.domain = 404; await run(); rewind('domain', 31); await run();
  check('200 받은 뒤의 404 는 장애로', Boolean(autoFor('domain')), autoFor('domain')?.title || '안 열림 ❌');

  // ── 11. RSS 에 실린다
  const feed = fs.readFileSync(path.join(DOCS, 'feed.xml'), 'utf8');
  check('RSS 에 항목이 생긴다', (feed.match(/<item>/g) || []).length > 0, (feed.match(/<item>/g) || []).length + '건');
  check('RSS 제목에 컴포넌트 이름', /<title>도메인 응답 없음<\/title>/.test(feed), (feed.match(/<title>[^<]*응답 없음[^<]*<\/title>/) || [''])[0]);
} catch (err) {
  check('실행', false, err.message);
} finally {
  console.log('');
  for (const o of out) console.log('  ' + (o.ok ? 'OK  ' : 'FAIL') + '  ' + String(o.n).padEnd(38) + ' ' + (o.d === undefined ? '' : o.d));
  console.log('\n  통과 ' + pass + ' · 실패 ' + fail);
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
