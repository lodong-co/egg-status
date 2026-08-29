/**
 * 하루 판정 규칙 검사.
 *
 * <p>한 번 실패로 하루를 「성능 저하」로 칠하던 것을 고쳤다. 그 규칙이
 * 의도대로 도는지, 그리고 진짜 장애는 여전히 잡히는지 본다.
 */
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const src = await readFile(new URL('../docs/common.js', import.meta.url), 'utf8');
const ctx = { document: { getElementById: () => null }, window: {}, Date };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const { grade, downtimeText, causeText } = ctx;

let ok = 0;
let no = 0;
const check = (name, got, want) => {
  if (got === want) { ok += 1; console.log(`  OK    ${name}`); }
  else { no += 1; console.log(`  FAIL  ${name}\n          받음: ${got}\n          바람: ${want}`); }
};

// 2026-08-27 에 실제로 있었던 모양
const blip = { ok: 254, total: 255, slow: 0, confirmed: 0, fails: { timeout: 1 } };
check('한 번 실패는 정상으로 친다', grade(blip).label, '정상');
check('한 번 실패는 다운타임 0', downtimeText(blip), '기록된 다운타임 없음');
check('그래도 실패 사실은 남긴다',
  causeText(blip), '응답 없음(시간 초과) 1회 (연속 실패 아님 — 장애로 세지 않음)');

// 연속 두 번이면 장애다
const real = { ok: 253, total: 255, slow: 0, confirmed: 2, fails: { timeout: 2 } };
check('연속 두 번은 성능 저하', grade(real).label, '성능 저하');
check('연속 두 번은 다운타임 계산', downtimeText(real), '다운타임 약 11분');
check('연속 두 번은 꼬리표 없음', causeText(real), '응답 없음(시간 초과) 2회');

// 크게 무너진 날
const bad = { ok: 100, total: 255, slow: 0, confirmed: 155, fails: { timeout: 155 } };
check('절반 넘게 죽으면 전체 장애', grade(bad).label, '전체 장애');

const partial = { ok: 240, total: 255, slow: 0, confirmed: 15, fails: { refused: 15 } };
check('일부 죽으면 부분 장애', grade(partial).label, '부분 장애');

// 측정 불가(점검 주소 없음)는 꼬리표를 붙이지 않는다
const un = { ok: 4, total: 4, slow: 0, confirmed: 0, fails: { 'probe-404': 4 } };
check('측정 불가에는 꼬리표 없음', causeText(un), '점검 주소 없음(측정 불가) 4회');

// 느린 날
const slow = { ok: 255, total: 255, slow: 30, confirmed: 0, fails: {} };
check('느린 날은 응답 지연', grade(slow).label, '응답 지연');

// 옛 기록(confirmed 없음)
const legacy = { ok: 254, total: 255, slow: 0, fails: { timeout: 1 } };
check('옛 기록도 정상으로 친다', grade(legacy).label, '정상');


/*
  사람이 적어 넣은 인시던트가 그날 판정에 반영되는가.

  바깥에서 200 만 보는 점검은 「페이지는 뜨는데 버튼만 죽은」 고장을 못 본다.
  그런 날을 초록으로 두고 가동률 100% 라고 쓰면 실제보다 좋게 말하는 것이다.
*/
const clean = { ok: 153, total: 153, slow: 0, confirmed: 0, fails: {} };
const kakao = [{ impact: 'minor', downMinutes: 27 }];

check('점검이 못 본 장애도 등급에 든다', grade(clean, kakao).label, '성능 저하');
check('그 시간이 다운타임으로 나온다', downtimeText(clean, kakao), '다운타임 약 27분');
check('인시던트가 없으면 그대로 정상', grade(clean, []).label, '정상');
check('인시던트를 안 넘겨도 안 깨진다', grade(clean).label, '정상');

const big = [{ impact: 'major', downMinutes: 800 }];
check('오래 죽었으면 부분 장애 이상', ['부분 장애', '전체 장애'].includes(grade(clean, big).label), true);

// 하루보다 긴 값을 적어도 하루를 넘지 않는다
const absurd = [{ impact: 'major', downMinutes: 99999 }];
check('하루를 넘지 않는다', downtimeText(clean, absurd), '다운타임 약 24시간');

console.log(`\n  (인시던트 반영 포함) 통과 ${ok} · 실패 ${no}`);
process.exit(no === 0 ? 0 : 1);
