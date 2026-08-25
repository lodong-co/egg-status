/**
 * 프로브 러너 — GitHub Actions(우리 DC 밖)에서 돌며 컴포넌트 상태를 재고 docs/state.json 을 갱신한다.
 *
 * 왜 밖에서 재는가 (실측 근거):
 *   2026-08-01 egg-api 가 9시간 30분 동안 요청을 한 건도 처리 못 했는데, 내부 감시 지표는
 *   그 구간에도 96.429% 로 전날·다음날과 소수점까지 같았다. 감시 주체가 죽은 대상 안에
 *   있었기 때문이다. 그래서 이 스크립트는 GitHub 러너에서만 돈다.
 *
 * 사용: node scripts/probe.mjs   (레포 루트에서)
 */

import { readFile, writeFile } from 'node:fs/promises';

const STATE_PATH = new URL('../docs/state.json', import.meta.url);
const RETAIN_DAYS = 90;
const TIMEOUT_MS = 10_000;

/**
 * 이 시간을 넘겨 200 이 오면 "느림" 으로 센다.
 *
 * <p>200 이라고 다 정상은 아니다. 트래픽이 몰려 8초씩 걸리는 날도 응답은 200 이라,
 * 성공/실패만 세면 그런 날이 초록으로 보인다. 실제로 느려진 날을 놓치는 셈이다.
 *
 * <p>GitHub 러너에서 한국까지 왕복이라 평소가 0.7~1.4초다. 여기에 여유를 두고 4초로 잡았다.
 * 사람이 "느리다" 고 느끼기 시작하는 선이기도 하다. 10초를 넘으면 그건 실패로 접힌다.
 */
const SLOW_MS = 4_000;

/** 공개 컴포넌트 5줄. 배열 순서 = 페이지 표시 순서. */
export const TARGETS = [
  {
    id: 'console',
    name: '관리 콘솔',
    desc: '대시보드 · API',
    url: 'https://egghosting.com/api/public/status',
    // 무인증 공개 헬스(PublicStatusController). DB 왕복 1회를 실제로 수행하므로
    // "앱은 살아있는데 커넥션 풀이 마른" 상태까지 잡힌다.
    // 🔴 홈(/)만 찌르면 안 된다. 2026-08-01 당시 홈은 webvip 를 보고 살아 있었고
    //    API 만 죽은 노드에 고정돼 있어서, 홈 프로브는 9시간 30분을 통째로 놓쳤을 것이다.
  },
  {
    id: 'web',
    name: '웹호스팅',
    desc: '웹호스팅 플랫폼',
    url: 'https://sajuj.com/',
    // 카나리 — 고객 사이트를 개별로 잴 수 없어, 같은 경로(공인 → FortiGate → 앞단 nginx →
    // 컨테이너)를 타는 우리 자체 사이트를 대신 잰다.
  },
  { id: 'cloud',  name: '클라우드 서버', desc: '클라우드 VM 플랫폼', url: 'https://hrdlo.kr/' },
  {
    id: 'domain',
    name: '도메인',
    desc: '도메인 등록 · DNS',
    url: 'https://eggdomains.com/',
    // 자체 권위 DNS(ns1/ns2.eggdomains.com, 독산DC) 위에 있어 DNS 가 죽으면 이 요청부터
    // 실패한다. 2026-07-22 · 08-07 에 실제로 그랬다.
  },
  { id: 'login',  name: '로그인', desc: 'LD PASS 통합 로그인', url: 'https://ldpass.com/' },
];

/**
 * 실패를 한 단어로 접는다. 이 값이 그대로 하루치에 쌓여서 나중에 원인이 된다.
 *
 * <p>예전에는 실패를 세기만 하고 왜 실패했는지는 어디에도 안 남겼다.
 * 그래서 지난 장애의 원인을 물으면 답할 데이터가 없었다.
 */
function reasonOf(res, err) {
  if (err) {
    if (err.name === 'TimeoutError') return 'timeout';
    const m = String(err.message || err);
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return 'dns';
    if (/ECONNREFUSED/i.test(m)) return 'refused';
    if (/ECONNRESET|EPIPE/i.test(m)) return 'reset';
    if (/certificate|TLS|SSL|altname/i.test(m)) return 'tls';
    return 'network';
  }
  return 'http-' + res.status;
}

async function probe(target, firstOkAt) {
  const started = Date.now();
  let res = null;
  let err = null;
  try {
    res = await fetch(target.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'egg-status-probe/1.0 (+https://egghosting.com)' },
    });
  } catch (e) {
    err = e;
  }

  const latencyMs = Date.now() - started;
  const up = Boolean(res) && res.status >= 200 && res.status < 300;

  /*
    아직 한 번도 200 을 받은 적 없는데 404/405 가 오면, 그건 장애가 아니라
    우리가 점검 주소를 잘못 겨눈 것이다. 실제로 2026-08-19~20 에 관리 콘솔이
    그랬다. 헬스 엔드포인트가 배포되기 전이라 프로브가 404 를 받았고,
    멀쩡한 이틀이 「전체 장애」 로 칠해졌다.

    그래서 이 경우만 측정에서 뺀다(측정 없음, 회색). 초록으로 칠하지 않는다 —
    우리는 그 시간에 상태를 모른다.

    한 번이라도 200 을 받은 뒤의 404 는 그대로 장애로 센다. 그건 라우팅이
    깨진 것일 수 있고, 그런 진짜 장애를 이 규칙이 가려서는 안 된다.
  */
  const unmeasured = !up && !firstOkAt && res !== null && (res.status === 404 || res.status === 405);

  return {
    id: target.id, name: target.name, desc: target.desc,
    up,
    statusCode: res ? res.status : null,
    latencyMs,
    slow: up && latencyMs > SLOW_MS,
    unmeasured,
    reason: up ? null : reasonOf(res, err),
    error: up ? null : (err ? (err.name === 'TimeoutError' ? 'timeout' : String(err.message || err)) : 'http ' + res.status),
  };
}

/** 일자 경계는 KST 기준(장애 날짜가 한국 날짜와 맞아야 한다). */
function dayKey(date = new Date()) {
  const d = new Date(date.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function prune(perDay) {
  const keys = Object.keys(perDay).sort();
  if (keys.length <= RETAIN_DAYS) return perDay;
  return Object.fromEntries(keys.slice(-RETAIN_DAYS).map((k) => [k, perDay[k]]));
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8'));
  } catch {
    return { schema: 1, startedAt: null, updatedAt: null, components: [], daily: {} };
  }
}

const prev = await loadState();
const now = new Date();
const today = dayKey(now);
const results = await Promise.all(
  TARGETS.map((t) => probe(t, (prev.components || []).find((c) => c.id === t.id)?.firstOkAt || null)),
);

const daily = prev.daily || {};
const components = results.map((r) => {
  const before = (prev.components || []).find((c) => c.id === r.id);

  // 가동률(%) 공개는 데이터가 쌓인 뒤 따로 판단하기로 했다. 표시와 무관하게 수집은 계속한다.
  const perDay = daily[r.id] || {};
  const cell = perDay[today] || { ok: 0, total: 0 };
  if (cell.slow === undefined) cell.slow = 0;
  if (!cell.fails) cell.fails = {};

  if (r.unmeasured) {
    // 셈에 넣지 않는다. 다만 몇 번이었는지는 남겨서 눈에 띄게 한다.
    cell.fails['probe-404'] = (cell.fails['probe-404'] || 0) + 1;
  } else {
    cell.total += 1;
    if (r.up) {
      cell.ok += 1;
      if (r.slow) cell.slow += 1;
    } else {
      cell.fails[r.reason] = (cell.fails[r.reason] || 0) + 1;
    }
  }
  perDay[today] = cell;
  daily[r.id] = prune(perDay);

  return {
    ...r,
    // 처음으로 200 을 받은 시점. 점검 주소가 제대로 걸렸는지의 기준이 된다.
    firstOkAt: r.up ? (before?.firstOkAt || now.toISOString()) : (before?.firstOkAt || null),
    // 화면이 "느림" 을 라벨로 쓰려면 기준을 알아야 한다.
    slowMs: SLOW_MS,
    // 상태가 뒤집힌 시점. 그대로면 이전 값을 이어받는다.
    changedAt: before && before.up === r.up && before.changedAt ? before.changedAt : now.toISOString(),
  };
});

const state = {
  schema: 1,
  startedAt: prev.startedAt || today,
  updatedAt: now.toISOString(),
  components,
  daily,
  /*
    손으로 바로잡은 기록. 프로브가 만들지 않고, 지우지도 않는다.
    측정이 틀렸다고 조용히 고치면 그 상태판은 못 믿는다. 고쳤으면 고쳤다고 남긴다.
  */
  corrections: prev.corrections || [],
};

await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');

for (const c of components) {
  const tag = c.unmeasured ? '측정불가' : c.up ? (c.slow ? 'SLOW' : 'UP  ') : 'DOWN';
  console.log(`${tag} ${c.id.padEnd(8)} ${String(c.statusCode ?? '-').padEnd(4)} ${c.latencyMs}ms ${c.error || ''}`);
  if (c.unmeasured) {
    console.log(`     ⚠ ${c.id}: 점검 주소가 ${c.statusCode} 를 낸다. 아직 한 번도 200 을 못 받았다.`);
    console.log('       TARGETS 의 url 을 확인할 것. 장애로 세지 않고 측정에서 뺐다.');
  }
}

/* ────────────────────────────────────────────────────────────────
   RSS 피드 생성 — docs/incidents.json 을 읽어 docs/feed.xml 을 만든다.

   페이지의 "알림 받기" 가 가리키는 대상이다. 우리는 메일·SMS 발송 인프라가
   없으므로 구독 수단은 RSS 하나뿐이고, 그래서 이 파일은 반드시 있어야 한다.
   인시던트가 없으면 항목 0개짜리 유효한 피드를 낸다(리더가 404 를 싫어한다).
   내용이 안 바뀌면 파일을 다시 쓰지 않는다 — 불필요한 커밋을 막기 위해서다.
   ──────────────────────────────────────────────────────────────── */

const SITE = 'https://status.egghosting.com';
const INCIDENTS_PATH = new URL('../docs/incidents.json', import.meta.url);
const FEED_PATH = new URL('../docs/feed.xml', import.meta.url);

const xmlEscape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

async function writeFeed() {
  let incidents = [];
  try {
    const parsed = JSON.parse(await readFile(INCIDENTS_PATH, 'utf8'));
    if (Array.isArray(parsed)) incidents = parsed;
  } catch {
    // 파일이 없거나 깨졌으면 빈 피드로 둔다. 프로브 자체를 실패시키지는 않는다.
  }

  const items = [...incidents]
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, 30)
    .map((inc) => {
      const updates = (inc.updates || [])
        .map((u) => `${u.status || ''}: ${u.body || ''}`).join('\n');
      const last = (inc.updates || [])[(inc.updates || []).length - 1];
      const pub = new Date(inc.resolvedAt || last?.at || inc.startedAt).toUTCString();
      // guid 는 안정적이어야 한다. 리더가 이 값으로 읽음 여부를 기억한다.
      const guid = `${SITE}/#${inc.id || inc.startedAt}`;
      return `    <item>
      <title>${xmlEscape(inc.title)}</title>
      <link>${xmlEscape(SITE)}</link>
      <guid isPermaLink="false">${xmlEscape(guid)}</guid>
      <pubDate>${pub}</pubDate>
      <description>${xmlEscape(updates)}</description>
    </item>`;
    }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>에그호스팅 서비스 상태</title>
    <link>${SITE}</link>
    <description>에그호스팅의 서비스 인시던트 공지</description>
    <language>ko</language>
${items}
  </channel>
</rss>
`;

  // 내용이 같으면 건드리지 않는다(빈 커밋으로 Pages 빌드를 낭비하지 않도록).
  let before = null;
  try { before = await readFile(FEED_PATH, 'utf8'); } catch { /* 첫 실행 */ }
  if (before !== xml) await writeFile(FEED_PATH, xml, 'utf8');
}

await writeFeed();
