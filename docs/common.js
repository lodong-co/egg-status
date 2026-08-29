/*
  두 화면이 같이 쓰는 값과 함수.

  특히 grade() 가 여기 있어야 한다. 두 벌이면 언젠가 어긋나고,
  같은 날이 목록에서는 노랑인데 달력에서는 초록으로 보이게 된다.

  일반 스크립트다(모듈 아님). #tip 을 찾으므로 body 끝에서 불러야 한다.
*/
/* ─────────────────────────────────────────────────────────────
   가동률(%) 숫자 공개 스위치.

   false 로 두면 90일 바는 그리되 "99.87%" 같은 숫자와 다운타임 시간을
   표시하지 않는다.

   2026-08-19 에는 "수집만 하고 비공개"로 정했었다. 유료 MRR 의 79%가 단일
   고객(전용서버)이라, 보상 기준을 문서로 정하기 전에 가동률을 숫자로 내걸면
   사실상 SLA 를 약속하는 것이 되기 때문이다.
   지금 true 인 것은 status.claude.com 과 같은 형태를 요청받았기 때문이며,
   보상 기준 문서가 아직 없다는 사실은 그대로다. 되돌리려면 이 값만 false 로.
   ───────────────────────────────────────────────────────────── */
const SHOW_UPTIME = true;

const DAYS = 90;          // 바에 표시할 일수. status.claude.com 과 동일.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* 저장은 UTC ISO. 표시할 때만 KST 로 옮긴다. */
function kst(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    key: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
  };
}
const fmtKst = (iso) => { const k = kst(iso); return `${k.key} ${k.time} KST`; };

/* "2026-08-01" → "2026년 8월 1일" */
function longDate(key) {
  const [y, m, d] = key.split('-');
  return `${y}년 ${Number(m)}월 ${Number(d)}일`;
}

/* 오늘부터 거꾸로 n일치 날짜 키(KST). probe.mjs 의 dayKey 와 같은 규칙. */
function dayKeys(n) {
  const out = [];
  const nowKst = new Date(Date.now() + 9 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(nowKst.getTime() - i * 86400000);
    out.push(`${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`);
  }
  return out;
}

/*
  그날 장애로 인정한 점검 수.

  한 번 실패하고 다음에 바로 돌아온 것은 세지 않는다. 대개 점검하는 쪽의
  순간적인 네트워크 문제이고, 그 한 번이 255분의 1이어도 하루를 물들였다.
  프로브가 연속 두 번부터 세어 confirmed 에 담는다.

  옛 기록에는 이 값이 없다. 그때는 실패를 전부 셌는데, 지금 기준으로는
  장애로 인정한 적이 없는 날들이라 0 으로 본다.
*/
function confirmedFails(cell) {
  return cell && typeof cell.confirmed === 'number' ? cell.confirmed : 0;
}

/*
  점검으로는 안 보였지만 실제로 죽어 있던 시간(분).

  바깥에서 200 만 보는 점검은 「페이지는 뜨는데 버튼만 죽은」 고장을 못 본다.
  2026-08-29 카카오 로그인이 그랬다 — 26분 41초 동안 로그인이 안 됐는데
  점검은 내내 정상이었고 상태판은 가동률 100% 라고 말했다. 실제보다 좋게
  말한 것이라, 사람이 적어 넣은 인시던트의 시간을 여기서 같이 센다.

  인시던트에 downMinutes 를 적으면 그날 등급·다운타임·가동률에 반영된다.
*/
function manualDownMinutes(incidents) {
  if (!Array.isArray(incidents)) return 0;
  return incidents.reduce((sum, i) => sum + (Number(i && i.downMinutes) || 0), 0);
}

/*
  그날 「나쁜 것」의 크기를 점검 횟수로 환산한다.
  점검이 잡은 것(confirmed)과 사람이 적은 시간(분)을 같은 자로 잰다.
*/
function badSamples(cell, incidents) {
  const perSample = cell && cell.total ? 1440 / cell.total : 0;
  const manual = perSample ? manualDownMinutes(incidents) / perSample : 0;
  return Math.min(cell ? cell.total : 0, confirmedFails(cell) + manual);
}

/* 하루치 집계를 상태 등급으로 접는다. 경계는 Statuspage 관행. */
function grade(cell, incidents) {
  if (!cell || !cell.total) return { cls: 'nodata', label: '측정 없음' };
  const r = (cell.total - badSamples(cell, incidents)) / cell.total;
  if (r < 0.5) return { cls: 'major', label: '전체 장애' };
  if (r < 0.95) return { cls: 'partial', label: '부분 장애' };
  if (r < 1) return { cls: 'degraded', label: '성능 저하' };
  /* 다 떴지만 느렸던 날. 200 이라고 다 정상은 아니다 —
     트래픽이 몰려 응답이 늘어진 날을 초록으로 칠하면 그 날을 통째로 놓친다. */
  if ((cell.slow || 0) / cell.total >= 0.1) return { cls: 'degraded', label: '응답 지연' };
  return { cls: 'ok', label: '정상' };
}

/* 실패 원인. 프로브가 남긴 한 단어를 사람 말로 편다. */
const REASON = {
  timeout: '응답 없음(시간 초과)',
  dns: 'DNS 조회 실패',
  refused: '연결 거부',
  reset: '연결 끊김',
  tls: '인증서 오류',
  network: '네트워크 오류',
  'probe-404': '점검 주소 없음(측정 불가)',
};

function reasonLabel(key) {
  if (REASON[key]) return REASON[key];
  const m = /^http-(\d+)$/.exec(key);
  return m ? 'HTTP ' + m[1] : key;
}

/* 그날 왜 실패했는지. 많은 것부터. 없으면 빈 문자열. */
function causeText(cell) {
  const fails = cell && cell.fails;
  if (!fails) return '';
  const parts = Object.entries(fails)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => reasonLabel(k) + ' ' + v + '회');
  if (!parts.length) return '';
  const text = parts.join(' · ');

  /*
    실패는 있었는데 장애로 안 센 날. 숨기지 않고 왜 안 셌는지 같이 적는다 —
    기록을 지우면 이 상태판을 못 믿는다.
  */
  const onlyUnmeasured = Object.keys(fails).every((k) => k === 'probe-404');
  return confirmedFails(cell) === 0 && !onlyUnmeasured
    ? text + ' (연속 실패 아님 — 장애로 세지 않음)'
    : text;
}

/* 실패한 점검 비율을 하루(24h)에 대입한 근사치. 점검 간격이 일정하지 않아
   정확한 값이 아니므로 "약" 을 붙여 표시한다. */
function downtimeText(cell, incidents) {
  if (!cell || !cell.total) return '';
  const fail = badSamples(cell, incidents);
  if (fail <= 0) return '기록된 다운타임 없음';
  const mins = Math.round((fail / cell.total) * 1440);
  if (mins < 60) return `다운타임 약 ${mins}분`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `다운타임 약 ${h}시간 ${m}분` : `다운타임 약 ${h}시간`;
}

const tipEl = document.getElementById('tip');

function showTip(target, html) {
  tipEl.innerHTML = html;
  tipEl.classList.add('show');
  const r = target.getBoundingClientRect();
  const t = tipEl.getBoundingClientRect();
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(10, Math.min(left, window.innerWidth - t.width - 10));
  let top = r.top - t.height - 9;
  if (top < 8) top = r.bottom + 9;   /* 위가 좁으면 아래로 뒤집는다 */
  tipEl.style.left = left + 'px';
  tipEl.style.top = top + 'px';
}

const hideTip = () => tipEl.classList.remove('show');

const noStore = { cache: 'no-store' };
