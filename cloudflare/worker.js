/**
 * 에그호스팅 공개 상태 페이지 — Cloudflare Worker 단일 배포.
 *
 * 하는 일 두 가지:
 *   1) cron(기본 5분)마다 아래 TARGETS 를 "우리 DC 밖에서" 찔러 결과를 KV 에 누적한다.
 *   2) HTTP 요청에 현재 상태 페이지(HTML)와 원시 상태(JSON)를 돌려준다.
 *
 * 왜 밖에서 재야 하나 (실측 근거):
 *   2026-08-01 egg-api 가 9시간 30분 동안 요청을 한 건도 처리하지 못했는데, 우리 내부 감시
 *   지표는 그 구간에도 96.429% 로 전날·다음날과 소수점까지 같았다. 감시 주체가 죽은 대상
 *   안에 있었기 때문이다. 그래서 이 워커는 우리 인프라 밖에서만 돈다.
 *
 * KV 쓰기 예산: 실행당 정확히 1회. 5분 간격 = 하루 288회 (무료 한도 1,000회 안).
 *   ⚠ cron 을 1분으로 당기면 1,440회가 되어 무료 한도를 넘는다. 간격 변경 시 반드시 재계산할 것.
 */

/** 공개 컴포넌트 5줄. 순서가 곧 페이지 표시 순서. */
const TARGETS = [
  {
    id: 'console',
    name: '관리 콘솔',
    desc: '대시보드 · API',
    url: 'https://egghosting.com/api/public/status',
    // 무인증 공개 헬스(PublicStatusController). DB 왕복 1회를 실제로 수행하므로
    // "앱은 살아있는데 커넥션 풀이 마른" 상태까지 잡힌다. 홈(/)만 찌르면 8/1 을 놓친다.
  },
  {
    id: 'web',
    name: '웹호스팅',
    desc: '웹호스팅 플랫폼',
    url: 'https://sajuj.com/',
    // 카나리. 고객 사이트를 개별로 잴 수 없어, 같은 경로(공인 → FortiGate → 앞단 nginx →
    // 컨테이너)를 타는 우리 자체 사이트를 대신 잰다.
  },
  {
    id: 'cloud',
    name: '클라우드 서버',
    desc: '클라우드 VM 플랫폼',
    url: 'https://hrdlo.kr/',
    // 카나리(IAAS 경로).
  },
  {
    id: 'domain',
    name: '도메인',
    desc: '도메인 등록 · DNS',
    url: 'https://eggdomains.com/',
    // 자체 권위 DNS(ns1/ns2.eggdomains.com) 위에 있어, DNS 가 죽으면 이 요청부터 실패한다.
    // 2026-07-22 · 08-07 에 실제로 그랬다.
  },
  {
    id: 'login',
    name: '로그인',
    desc: 'LD PASS 통합 로그인',
    url: 'https://ldpass.com/',
  },
];

const KV_KEY = 'state';
const RETAIN_DAYS = 90;
const PROBE_TIMEOUT_MS = 10_000;

/* ────────────────────────── 진입점 ────────────────────────── */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runProbes(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/state') {
      const state = await loadState(env);
      return json(state);
    }

    // 수동 점검 트리거. cron 을 기다리지 않고 즉시 재보고 싶을 때.
    // PROBE_TOKEN 을 설정해 두면 그 값을 아는 사람만 호출할 수 있다.
    if (url.pathname === '/api/probe' && request.method === 'POST') {
      const token = env.PROBE_TOKEN;
      if (token && url.searchParams.get('token') !== token) {
        return json({ error: 'forbidden' }, 403);
      }
      const state = await runProbes(env);
      return json(state);
    }

    const state = await loadState(env);
    return new Response(renderPage(state, env), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // 상태 페이지가 캐시돼 옛 결과를 보여주면 존재 이유가 사라진다.
        'cache-control': 'no-store',
      },
    });
  },
};

/* ────────────────────────── 점검 ────────────────────────── */

async function runProbes(env) {
  const prev = await loadState(env);
  const now = new Date();
  const today = dayKey(now);

  const results = await Promise.all(TARGETS.map((t) => probe(t)));

  const daily = prev.daily || {};
  const components = results.map((r) => {
    const before = (prev.components || []).find((c) => c.id === r.id);

    // 일별 누적(가동률 계산용). 지금은 화면에 안 쓰지만 오늘부터 쌓아둔다.
    const perDay = daily[r.id] || {};
    const cell = perDay[today] || { ok: 0, total: 0 };
    cell.total += 1;
    if (r.up) cell.ok += 1;
    perDay[today] = cell;
    daily[r.id] = prune(perDay);

    return {
      ...r,
      // 상태가 바뀐 시점. 안 바뀌었으면 이전 값을 이어받는다.
      changedAt: before && before.up === r.up && before.changedAt
        ? before.changedAt
        : now.toISOString(),
    };
  });

  const state = {
    schema: 1,
    startedAt: prev.startedAt || today,
    updatedAt: now.toISOString(),
    components,
    daily,
  };

  await env.STATUS.put(KV_KEY, JSON.stringify(state));   // 실행당 쓰기 1회
  return state;
}

async function probe(target) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const res = await fetch(target.url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'egg-status-probe/1.0 (+https://egghosting.com)' },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    return {
      id: target.id,
      name: target.name,
      desc: target.desc,
      up: res.status >= 200 && res.status < 300,
      statusCode: res.status,
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (e) {
    // 타임아웃·DNS 실패·TCP 거부 전부 여기로 온다. 이유를 구분하지 않고 DOWN 으로 접는다.
    return {
      id: target.id,
      name: target.name,
      desc: target.desc,
      up: false,
      statusCode: null,
      latencyMs: Date.now() - started,
      error: e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 보존기간 밖 일자를 버린다. KV 값이 무한정 커지지 않게. */
function prune(perDay) {
  const keys = Object.keys(perDay).sort();
  if (keys.length <= RETAIN_DAYS) return perDay;
  const keep = keys.slice(-RETAIN_DAYS);
  const out = {};
  for (const k of keep) out[k] = perDay[k];
  return out;
}

async function loadState(env) {
  const raw = await env.STATUS.get(KV_KEY);
  if (!raw) return { schema: 1, startedAt: null, updatedAt: null, components: [], daily: {} };
  try {
    return JSON.parse(raw);
  } catch {
    return { schema: 1, startedAt: null, updatedAt: null, components: [], daily: {} };
  }
}

/* ────────────────────────── 렌더링 ────────────────────────── */

function renderPage(state, env) {
  // 가동률(%) 공개는 데이터가 쌓인 뒤 따로 판단하기로 했다. 그때 SHOW_UPTIME=true 로 켠다.
  const showUptime = String(env.SHOW_UPTIME || 'false') === 'true';

  const comps = state.components && state.components.length
    ? state.components
    : TARGETS.map((t) => ({ ...t, up: null, latencyMs: null, statusCode: null }));

  const known = comps.filter((c) => c.up !== null);
  const down = known.filter((c) => !c.up);
  const overall = known.length === 0
    ? { cls: 'pending', text: '측정 준비 중' }
    : down.length === 0
      ? { cls: 'up', text: '모든 시스템 정상' }
      : down.length === known.length
        ? { cls: 'down', text: '전체 장애' }
        : { cls: 'partial', text: `일부 시스템 장애 (${down.length}건)` };

  const rows = comps.map((c) => {
    const cls = c.up === null ? 'pending' : c.up ? 'up' : 'down';
    const label = c.up === null ? '측정 대기' : c.up ? '정상' : '장애';
    const uptimeCell = showUptime ? `<td class="pct">${fmtUptime(state, c.id)}</td>` : '';
    return `<tr>
      <td class="name"><span class="dot ${cls}"></span><span><b>${esc(c.name)}</b><em>${esc(c.desc || '')}</em></span></td>
      ${uptimeCell}
      <td class="state ${cls}">${label}</td>
    </tr>`;
  }).join('\n');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>에그호스팅 서비스 상태</title>
<meta name="description" content="에그호스팅의 서비스별 실시간 운영 상태">
<meta http-equiv="refresh" content="60">
<style>
  :root{
    --bg:#f6f7f9; --card:#fff; --line:#e5e7eb; --fg:#111827; --muted:#6b7280;
    --up:#16a34a; --down:#dc2626; --partial:#d97706; --pending:#9ca3af;
  }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#0b0f14; --card:#131a22; --line:#243040; --fg:#e6edf3; --muted:#9aa7b4; }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font-family:-apple-system,BlinkMacSystemFont,"Pretendard","Apple SD Gothic Neo","Malgun Gothic",sans-serif;
    line-height:1.5;-webkit-font-smoothing:antialiased}
  .wrap{max-width:760px;margin:0 auto;padding:48px 20px 64px}
  header{display:flex;align-items:baseline;gap:10px;margin-bottom:28px}
  header h1{font-size:20px;margin:0;letter-spacing:-.01em}
  header span{color:var(--muted);font-size:13px}
  .banner{border-radius:12px;padding:18px 20px;margin-bottom:20px;font-weight:600;font-size:17px;
    border:1px solid var(--line);background:var(--card);display:flex;align-items:center;gap:12px}
  .banner.up{border-color:color-mix(in srgb,var(--up) 40%,var(--line));color:var(--up)}
  .banner.partial{border-color:color-mix(in srgb,var(--partial) 40%,var(--line));color:var(--partial)}
  .banner.down{border-color:color-mix(in srgb,var(--down) 40%,var(--line));color:var(--down)}
  .banner.pending{color:var(--muted)}
  table{width:100%;border-collapse:collapse;background:var(--card);
    border:1px solid var(--line);border-radius:12px;overflow:hidden}
  td{padding:15px 20px;border-top:1px solid var(--line);vertical-align:middle}
  tr:first-child td{border-top:0}
  .name{display:flex;align-items:center;gap:11px}
  .name b{font-weight:600;font-size:15px;display:block}
  .name em{font-style:normal;color:var(--muted);font-size:12.5px;display:block;margin-top:1px}
  .dot{width:9px;height:9px;border-radius:50%;flex:0 0 9px;background:var(--pending)}
  .dot.up{background:var(--up)} .dot.down{background:var(--down)}
  .state{text-align:right;font-size:13.5px;font-weight:500;color:var(--muted);white-space:nowrap}
  .state.up{color:var(--up)} .state.down{color:var(--down)}
  .pct{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted);font-size:13px;white-space:nowrap}
  footer{margin-top:24px;color:var(--muted);font-size:12.5px;line-height:1.8}
  footer p{margin:0}
  .note{margin-top:18px;padding:14px 16px;border:1px solid var(--line);border-radius:10px;
    background:var(--card);color:var(--muted);font-size:12.5px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>에그호스팅 서비스 상태</h1>
    <span>egghosting.com</span>
  </header>

  <div class="banner ${overall.cls}">${overall.text}</div>

  <table>${rows}</table>

  <div class="note">
    이 페이지는 <b>플랫폼 컴포넌트의 상태</b>이며, 개별 서비스의 상태가 아닙니다.
    내 서비스 상태는 관리 콘솔에서 확인해 주세요.
  </div>

  <footer>
    <p>마지막 점검 ${state.updatedAt ? fmtKst(state.updatedAt) : '—'} · 5분 간격 자동 점검</p>
    <p>점검은 에그호스팅 인프라 외부에서 수행됩니다${state.startedAt ? ` · 측정 시작 ${state.startedAt}` : ''}</p>
  </footer>
</div>
</body>
</html>`;
}

function fmtUptime(state, id) {
  const perDay = (state.daily || {})[id] || {};
  let ok = 0, total = 0;
  for (const k of Object.keys(perDay)) { ok += perDay[k].ok; total += perDay[k].total; }
  if (!total) return '—';
  return `${((ok / total) * 100).toFixed(2)}%`;
}

/** KST 표기. 워커는 UTC 로 도니 표시할 때만 9시간 더한다. */
function fmtKst(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} KST`;
}

/** 일자 키도 KST 기준으로 끊는다(장애 날짜가 한국 날짜와 맞아야 함). */
function dayKey(date) {
  const d = new Date(date.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
