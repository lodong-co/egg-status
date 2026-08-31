import fs from 'node:fs';
const src = fs.readFileSync('C:/Users/lodong/Desktop/project/egg-status/docs/common.js', 'utf8');
const part = src.slice(src.indexOf('const BACK_HOME'), src.indexOf('(function drawBack'));

let store = {};
const reset = () => { store = {}; };
const mk = (referrer) => {
  const ss = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
  };
  const fn = new Function('document', 'sessionStorage', 'return (' + '() => {' + part + '\nreturn backTarget();})()');
  return fn({ referrer }, ss);
};

let ok = 0, no = 0;
const is = (m, got, want) => {
  if (got === want) { ok++; console.log('  OK    ' + m); }
  else { no++; console.log('  FAIL  ' + m + ' — ' + got + ' (기대: ' + want + ')'); }
};

reset();
is('에구에서 오면 에구로', mk('https://eggooo.com/hot').name, '에구 EGGOOO');
is('  주소도 그대로', mk('https://eggooo.com/hot').url, 'https://eggooo.com/hot');
is('조사가 붙는다', mk('https://eggooo.com/').particle, '로');
is('한 걸음 더 들어가도 기억한다', mk('https://status.egghosting.com/uptime/').name, '에구 EGGOOO');
is('referrer 가 없어도 기억한다', mk('').name, '에구 EGGOOO');

reset();
is('에그도메인', mk('https://eggdomains.com/').name, '에그도메인');
reset();
is('www 붙어도', mk('https://www.eggdomains.com/').name, '에그도메인');

reset();
is('모르는 곳은 홈으로', mk('https://evil.example.com/').url, 'https://egghosting.com');
reset();
is('비슷한 이름도 홈으로', mk('https://eggooo.com.evil.kr/').url, 'https://egghosting.com');
reset();
is('http 는 홈으로', mk('http://eggooo.com/').url, 'https://egghosting.com');
reset();
is('처음 들어오면 홈으로', mk('').url, 'https://egghosting.com');

reset();
store['egg-status-from'] = JSON.stringify({ url: 'https://evil.kr/', name: '나쁨', particle: '로' });
is('기억을 고쳐 넣어도 안 통한다', mk('').url, 'https://egghosting.com');

console.log('\n  통과 ' + ok + ' · 실패 ' + no);
process.exit(no ? 1 : 0);
