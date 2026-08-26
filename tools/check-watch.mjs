/**
 * 측정 루프가 제대로 도는지, 그리고 <b>실제로 커밋·푸시가 되는지</b> 확인한다.
 *
 * <p>여기가 고장 나면 상태판이 통째로 멈춘다. 재기는 재는데 아무도 못 보는 상태가 된다.
 * 그래서 진짜 git 저장소(로컬 bare 를 origin 으로)를 만들어 놓고 밀어 보게 한다.
 *
 * <p>루프 간격은 env 로 줄인다. 1분씩 기다릴 수는 없다.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const ROOT = path.join(os.tmpdir(), 'egg-status-watch-test');
const WORK = path.join(ROOT, 'work');
const ORIGIN = path.join(ROOT, 'origin.git');
const PORT = 8903;

let pass = 0;
let fail = 0;
const out = [];
const check = (n, ok, d) => { out.push({ n, ok: Boolean(ok), d }); if (ok) pass += 1; else fail += 1; };

const mode = { console: 200, web: 200, cloud: 200, domain: 200, login: 200 };
const server = http.createServer((req, res) => {
  const id = req.url.replace(/^\//, '').split('?')[0];
  res.writeHead(mode[id] ?? 200, { 'Content-Type': 'text/plain' });
  res.end('x');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const git = (args, cwd) => exec('git', args, { cwd, encoding: 'utf8' });

try {
  // ── 저장소 두 개: 작업본과 origin(bare)
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(WORK, 'docs'), { recursive: true });
  await exec('git', ['init', '--bare', '-b', 'main', ORIGIN]);

  // 프로브가 우리 서버를 보게 한 사본 + watch 는 그대로
  let code = fs.readFileSync(path.join(REPO, 'scripts', 'probe.mjs'), 'utf8');
  const ids = [];
  code.replace(/id: '([a-z]+)'/g, (m, g) => { ids.push(g); return m; });
  let i = 0;
  code = code.replace(/url: 'https:\/\/[^']*'/g, () => "url: 'http://127.0.0.1:" + PORT + "/" + ids[i++] + "'");
  fs.writeFileSync(path.join(WORK, 'scripts', 'probe.mjs'), code);
  fs.copyFileSync(path.join(REPO, 'scripts', 'watch.mjs'), path.join(WORK, 'scripts', 'watch.mjs'));
  fs.writeFileSync(path.join(WORK, 'docs', 'incidents.json'), '[]\n');
  fs.writeFileSync(path.join(WORK, 'docs', 'state.json'),
    JSON.stringify({ schema: 1, startedAt: null, updatedAt: null, components: [], daily: {} }, null, 2) + '\n');

  await git(['init', '-b', 'main'], WORK);
  await git(['config', 'user.name', 'test bot'], WORK);
  await git(['config', 'user.email', 'test@example.com'], WORK);
  await git(['remote', 'add', 'origin', ORIGIN], WORK);
  await git(['add', '-A'], WORK);
  await git(['commit', '-m', '처음'], WORK);
  await git(['push', '-u', 'origin', 'main'], WORK);

  const originLog = async () => (await git(['log', '--oneline'], ORIGIN)).stdout.trim().split('\n');
  const before = (await originLog()).length;

  const watch = (env) => exec('node', [path.join(WORK, 'scripts', 'watch.mjs')], {
    cwd: WORK, encoding: 'utf8',
    env: { ...process.env, GITHUB_REF_NAME: 'main', ...env },
  });

  // ── 1. 한 번만 재고 끝내기 (RUN_MINUTES=0)
  const one = await watch({ RUN_MINUTES: '0' });
  check('한 번만 재고 끝난다', /끝 · 측정 1회/.test(one.stdout), (one.stdout.match(/끝 · .*/) || [''])[0]);
  const after1 = await originLog();
  check('origin 에 커밋이 올라갔다', after1.length > before, after1[0]);

  const st1 = JSON.parse(fs.readFileSync(path.join(WORK, 'docs', 'state.json'), 'utf8'));
  check('측정값이 실제로 담겼다', (st1.components || []).length === 5, (st1.components || []).length + '개');

  // ── 2. 여러 회차를 돌고, 조용하면 뜸하게 올린다
  const many = await watch({ RUN_MINUTES: '0.5', PROBE_SECONDS: '1', PUSH_SECONDS: '600' });
  // 「올림 (측정 N회)」 줄이 먼저 나오므로 마지막 「끝 · 측정 N회」를 봐야 한다.
  const n = Number((many.stdout.match(/끝 · 측정 (\d+)회/) || [])[1] || 0);
  check('여러 회차를 돈다', n >= 5, n + '회 (약 30초 동안 1초 간격)');
  const after2 = await originLog();
  /* 시작할 때 한 번, 끝낼 때 한 번은 올린다. 그 사이는 조용하면 안 올린다.
     state.json 은 측정할 때마다 바뀌므로, 올리기로 한 순간엔 커밋이 반드시 하나 생긴다.
     그래서 「안 올린다」는 커밋 수가 측정 수보다 훨씬 적은 것으로 확인한다. */
  const commits = after2.length - after1.length;
  check('조용할 땐 매번 안 올린다', commits <= 3 && n >= 5,
    '측정 ' + n + '회에 커밋 ' + commits + '건');

  const st2 = JSON.parse(fs.readFileSync(path.join(WORK, 'docs', 'state.json'), 'utf8'));
  const today = Object.keys(st2.daily.console).sort().pop();
  check('안 올려도 측정은 쌓인다', st2.daily.console[today].total >= n, JSON.stringify(st2.daily.console[today]));

  // ── 3. 상태가 바뀌면 그 자리에서 올린다
  const beforeDown = (await originLog()).length;
  mode.console = 503;
  const down = await watch({ RUN_MINUTES: '0.06', PROBE_SECONDS: '1', PUSH_SECONDS: '600' });
  const afterDown = await originLog();
  check('죽으면 바로 올린다', afterDown.length > beforeDown, afterDown[0]);
  check('왜 올렸는지 로그에', /상태가 바뀌었다/.test(down.stdout), (down.stdout.match(/올림.*/) || [''])[0]);
  /* 끝낼 때 「마무리」 커밋이 하나 더 붙으므로 맨 위만 보면 안 된다. */
  check('커밋 메시지에도 남는다', afterDown.slice(0, 3).some((l) => /상태 변화/.test(l)),
    afterDown.slice(0, 2).join(' | '));

  // ── 4. 살아나도 바로 올린다
  const beforeUp = (await originLog()).length;
  mode.console = 200;
  await watch({ RUN_MINUTES: '0.06', PROBE_SECONDS: '1', PUSH_SECONDS: '600' });
  check('살아나도 바로 올린다', (await originLog()).length > beforeUp, (await originLog())[0]);

  // ── 5. 프로브가 터져도 루프는 안 죽는다
  const broken = path.join(WORK, 'scripts', 'probe.mjs');
  const good = fs.readFileSync(broken, 'utf8');
  fs.writeFileSync(broken, 'throw new Error("일부러 터뜨림");\n');
  const survived = await watch({ RUN_MINUTES: '0.06', PROBE_SECONDS: '1', PUSH_SECONDS: '600' });
  check('프로브가 터져도 루프는 계속', /프로브 실행 실패/.test(survived.stdout) && /끝 ·/.test(survived.stdout),
    (survived.stdout.match(/프로브 실행 실패.*/) || [''])[0].slice(0, 60));
  fs.writeFileSync(broken, good);

  // ── 6. 마지막에 남은 걸 올린다
  const beforeLast = (await originLog()).length;
  await watch({ RUN_MINUTES: '0.06', PROBE_SECONDS: '1', PUSH_SECONDS: '600' });
  check('끝낼 때 남은 걸 올린다', (await originLog()).length > beforeLast, '마무리 커밋');
} catch (err) {
  check('실행', false, String(err.message || err).split('\n')[0]);
} finally {
  console.log('');
  for (const o of out) console.log('  ' + (o.ok ? 'OK  ' : 'FAIL') + '  ' + String(o.n).padEnd(30) + ' ' + (o.d === undefined ? '' : o.d));
  console.log('\n  통과 ' + pass + ' · 실패 ' + fail);
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
