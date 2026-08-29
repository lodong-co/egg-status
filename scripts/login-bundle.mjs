/**
 * 로그인 화면이 실제로 눌러지는 상태인지 본다.
 *
 * <p>바깥에서 200 만 보는 점검은 「페이지는 뜨는데 버튼만 죽은」 고장을 못 본다.
 * 2026-08-29 카카오 로그인이 그랬다 — 26분 41초 동안 로그인이 안 됐는데
 * 헬스도 스모크도 내내 초록이었다.
 *
 * <p>원인은 늘 같은 자리다. {@code NEXT_PUBLIC_*} 는 빌드 때 값으로 치환되는데,
 * 빌드한 컴퓨터에 값이 없으면 비어 버린다. 그러면 버튼을 눌러도 인가 주소를
 * 만들지 못해 아무 일도 안 일어난다.
 *
 * <p>그래서 <b>로그인 화면의 스크립트에 그 값이 들어 있는지</b>를 본다.
 * 브라우저 없이 되는 검사다 — 화면을 받아 스크립트 주소를 뽑고, 그 안에
 * 값이 글자 그대로 있는지 찾는다.
 *
 * <p><b>매번 다 받지 않는다.</b> 스크립트 파일 이름에 내용 해시가 들어 있어서,
 * 이름이 그대로면 내용도 그대로다. 이름이 바뀌었을 때(=배포됐을 때)만 다시 본다.
 * 고장은 배포에서 생기므로 그 순간만 보면 된다.
 */

const TIMEOUT_MS = 10_000;
const UA = 'egg-status-probe/1.0 (+https://egghosting.com)';

/**
 * 로그인 화면에 반드시 들어 있어야 하는 값.
 *
 * <p>브라우저로 열면 누구나 보이는 공개값이라 시크릿이 아니다.
 * 이 값이 사라지면 그 버튼이 죽는다.
 */
export const LOGIN_PAGE = 'https://egghosting.com/login';
export const REQUIRED = [
  { label: '카카오', value: 'ddd00f5616eb63973d901c33955b2d05' },
];

const get = async (url) => fetch(url, {
  redirect: 'follow',
  signal: AbortSignal.timeout(TIMEOUT_MS),
  headers: { 'user-agent': UA },
});

/**
 * 결과는 세 가지다.
 *  - ok      : 값이 다 들어 있다
 *  - broken  : 값이 빠졌다. 그 버튼은 눌러도 안 된다
 *  - unknown : 확인을 못 했다(네트워크 등). 모르는 것이지 괜찮은 것이 아니다
 */
export async function checkLoginBundle(before) {
  let html;
  try {
    const res = await get(LOGIN_PAGE);
    if (!res.ok) return { state: 'unknown', why: 'http-' + res.status };
    html = await res.text();
  } catch (e) {
    return { state: 'unknown', why: e.name === 'TimeoutError' ? 'timeout' : 'network' };
  }

  const origin = new URL(LOGIN_PAGE).origin;
  const chunks = [...new Set(
    [...html.matchAll(/\/_next\/static\/chunks\/[A-Za-z0-9._-]+\.js/g)].map((m) => m[0]),
  )].sort();

  if (!chunks.length) return { state: 'unknown', why: 'no-chunks' };

  // 파일 이름에 내용 해시가 있다. 이름이 그대로면 다시 받을 이유가 없다.
  const fingerprint = chunks.join(',');
  if (before && before.fingerprint === fingerprint && before.state !== 'unknown') {
    return { ...before, reused: true };
  }

  const missing = [];
  let text = html;
  for (const c of chunks) {
    try {
      const res = await get(origin + c);
      if (res.ok) text += await res.text();
    } catch {
      return { state: 'unknown', why: 'chunk-fetch', fingerprint };
    }
  }
  for (const r of REQUIRED) {
    if (!text.includes(r.value)) missing.push(r.label);
  }

  return missing.length
    ? { state: 'broken', missing, fingerprint }
    : { state: 'ok', fingerprint };
}
