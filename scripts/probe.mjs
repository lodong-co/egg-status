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

async function probe(target) {
  const started = Date.now();
  try {
    const res = await fetch(target.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'egg-status-probe/1.0 (+https://egghosting.com)' },
    });
    return {
      id: target.id, name: target.name, desc: target.desc,
      up: res.status >= 200 && res.status < 300,
      statusCode: res.status,
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (e) {
    // 타임아웃·DNS 실패·TCP 거부를 구분하지 않고 전부 DOWN 으로 접는다.
    return {
      id: target.id, name: target.name, desc: target.desc,
      up: false, statusCode: null,
      latencyMs: Date.now() - started,
      error: e?.name === 'TimeoutError' ? 'timeout' : String(e?.message || e),
    };
  }
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
const results = await Promise.all(TARGETS.map(probe));

const daily = prev.daily || {};
const components = results.map((r) => {
  const before = (prev.components || []).find((c) => c.id === r.id);

  // 가동률(%) 공개는 데이터가 쌓인 뒤 따로 판단하기로 했다. 표시와 무관하게 수집은 계속한다.
  const perDay = daily[r.id] || {};
  const cell = perDay[today] || { ok: 0, total: 0 };
  cell.total += 1;
  if (r.up) cell.ok += 1;
  perDay[today] = cell;
  daily[r.id] = prune(perDay);

  return {
    ...r,
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
};

await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');

for (const c of components) {
  console.log(`${c.up ? 'UP  ' : 'DOWN'} ${c.id.padEnd(8)} ${String(c.statusCode ?? '-').padEnd(4)} ${c.latencyMs}ms ${c.error || ''}`);
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
