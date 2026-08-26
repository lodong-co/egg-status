/**
 * 한 러너 안에서 계속 재는 루프.
 *
 * <p><b>왜 이게 필요한가 (실측).</b> 예약 실행(cron)을 10분으로 걸어 뒀지만
 * 실제 간격은 중앙값 <b>38분</b>, 최대 <b>108분</b>이었다. 10분 안팎으로 돈 적은 한 번도 없다.
 * GitHub 의 schedule 은 러너가 붐비면 늦추거나 건너뛴다.
 *
 * <p>그 간격이면 느린 게 문제가 아니라 <b>안 보이는 게</b> 문제다.
 * 38분에 한 번 보면 20~30분짜리 장애는 통째로 지나가고 기록에 아예 안 남는다.
 *
 * <p>그래서 한 번 뜬 러너를 오래 쓰면서 그 안에서 1분마다 잰다.
 * 예약 실행의 역할이 바뀐다 — 이제 "10분마다 측정" 이 아니라
 * <b>"이 루프가 끊기면 다시 살리는"</b> 것이다.
 *
 * <p>재는 것과 올리는 것은 따로 간다. 1분마다 커밋하면 하루 1,440번이라
 * Pages 빌드 한도(시간당 약 10회)를 넘는다. 그래서 <b>바뀌었을 때는 즉시</b>,
 * 아무 일 없으면 10분에 한 번만 올린다. 조용할 때 조용한 게 맞다.
 *
 * <p>사용: node scripts/watch.mjs   (레포 루트 기준)
 *   환경변수 RUN_MINUTES  이 루프를 돌 시간(분). 0 이면 한 번만 재고 끝낸다.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

const PROBE = new URL('./probe.mjs', import.meta.url);
const STATE = new URL('../docs/state.json', import.meta.url);
const INCIDENTS = new URL('../docs/incidents.json', import.meta.url);

/** 얼마나 자주 재나. 검사는 이걸 짧게 줄여서 몇 초 만에 여러 회차를 본다. */
const PROBE_MS = Number(process.env.PROBE_SECONDS ?? 60) * 1000;

/** 아무 일 없어도 이만큼 지나면 한 번은 올린다. 페이지의 「마지막 측정」이 너무 낡아 보이지 않게. */
const PUSH_MS = Number(process.env.PUSH_SECONDS ?? 600) * 1000;

/**
 * 이 루프를 돌 시간.
 *
 * <p>GitHub 의 작업 하나는 최대 6시간이다. 그 앞에서 스스로 끝낸다.
 * 끝나면 대기 중이던 예약 실행이 바로 이어받는다(concurrency 로 겹치지는 않게 해 뒀다).
 */
const RUN_MINUTES = Number(process.env.RUN_MINUTES ?? 330);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 사람 눈에 시간이 보이게. 러너 로그는 UTC 라 KST 를 같이 찍는다. */
const stamp = () => {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(11, 19) + ' KST';
};

/**
 * 올릴 만한 변화가 있었는지 가리는 지문.
 *
 * <p>측정값 자체(응답 시간, 횟수)는 매분 바뀌므로 기준이 될 수 없다.
 * <b>사람이 봐야 하는 변화</b> — 뜨고 죽는 것, 인시던트가 열리고 닫히는 것 — 만 본다.
 */
async function fingerprint() {
  try {
    const st = JSON.parse(await readFile(STATE, 'utf8'));
    let inc = [];
    try {
      inc = JSON.parse(await readFile(INCIDENTS, 'utf8'));
    } catch { /* 없으면 빈 것으로 */ }
    return JSON.stringify({
      up: (st.components || []).map((c) => c.id + ':' + c.up + ':' + Boolean(c.unmeasured)),
      inc: (Array.isArray(inc) ? inc : []).map((i) => (i.id || i.title) + ':' + (i.resolvedAt || 'open')),
    });
  } catch {
    return '';
  }
}

async function git(...args) {
  try {
    const { stdout } = await run('git', args, { encoding: 'utf8' });
    return stdout.trim();
  } catch (e) {
    return 'ERR:' + String(e.stderr || e.message || e).trim().split('\n')[0];
  }
}

async function push(why) {
  await git('add', 'docs/state.json', 'docs/feed.xml', 'docs/incidents.json');
  const staged = await git('diff', '--staged', '--quiet');
  // diff --quiet 는 변경이 있으면 종료코드 1 → 여기서는 'ERR:' 로 돌아온다.
  if (!staged.startsWith('ERR:')) {
    return false;
  }
  const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  await git('commit', '-m', 'status: ' + at + (why ? ' (' + why + ')' : ''));
  // 예약 실행이 겹쳤을 때를 대비해 rebase 후 push.
  await git('pull', '--rebase', '--autostash', 'origin', process.env.GITHUB_REF_NAME || 'main');
  const out = await git('push');
  if (out.startsWith('ERR:')) {
    console.log('  ⚠ push 실패: ' + out);
    return false;
  }
  return true;
}

// ── 시작
const endAt = Date.now() + RUN_MINUTES * 60 * 1000;
console.log('[watch] ' + stamp() + ' 시작 · ' + (PROBE_MS / 1000) + '초마다 측정 · '
  + RUN_MINUTES + '분 동안 (0 이면 한 번만)');

let last = await fingerprint();
let lastPush = 0;
let n = 0;

for (;;) {
  const started = Date.now();
  n += 1;

  try {
    const { stdout } = await run('node', [PROBE.pathname.replace(/^\/([A-Za-z]:)/, '$1')], { encoding: 'utf8' });
    // 평소에는 조용히. 뭔가 잘못됐을 때만 러너 로그에 남긴다.
    const notable = stdout.split('\n').filter((l) => /DOWN|SLOW|측정불가|인시던트|⚠/.test(l));
    if (notable.length) {
      console.log('[watch] ' + stamp() + '  #' + n);
      for (const l of notable) console.log('  ' + l.trimEnd());
    }
  } catch (e) {
    // 한 번 실패했다고 루프를 죽이지 않는다. 다음 회차에 다시 시도한다.
    console.log('[watch] ' + stamp() + ' 프로브 실행 실패: ' + String(e.message || e).split('\n')[0]);
  }

  const now = await fingerprint();
  const changed = now !== last && now !== '';
  const due = Date.now() - lastPush >= PUSH_MS;

  if (changed || due) {
    const ok = await push(changed ? '상태 변화' : '');
    if (ok) {
      lastPush = Date.now();
      console.log('[watch] ' + stamp() + ' 올림' + (changed ? ' — 상태가 바뀌었다' : '')
        + ' (측정 ' + n + '회)');
    } else if (due) {
      // 올릴 게 없으면 그것도 정상이다. 다음 주기까지 다시 안 본다.
      lastPush = Date.now();
    }
    last = now;
  }

  if (RUN_MINUTES <= 0 || Date.now() >= endAt) {
    break;
  }

  // 프로브에 걸린 시간만큼 빼서 간격이 밀리지 않게 한다.
  const wait = Math.max(1000, PROBE_MS - (Date.now() - started));
  await sleep(wait);
}

// 끝내기 전에 남은 것을 올린다. 여기서 안 올리면 마지막 몇 분이 사라진다.
await push('마무리');
console.log('[watch] ' + stamp() + ' 끝 · 측정 ' + n + '회');
