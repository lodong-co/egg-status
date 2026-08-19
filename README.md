# egg-status — 에그호스팅 공개 상태 페이지

서비스별 운영 상태를 **에그호스팅 인프라 밖에서** 측정해 공개한다.
새 계정도, 비용도 들지 않는다 — GitHub Actions(측정) + GitHub Pages(페이지)만 쓴다.

## 왜 밖에서 재는가 (실측 근거)

2026-08-01, egg-api 가 **9시간 30분** 동안 HTTP 요청을 한 건도 처리하지 못했다.
그런데 그 구간의 내부 감시 지표는 **96.429%** 로 전날·다음날과 소수점까지 같았고,
텔레그램 알림도 15:11 이후 10시간 동안 egg-api 관련 건이 **0건**이었다.

감시 주체(내부 TCP 체크, 알림 디스패처)가 **죽은 대상 안에** 있었기 때문이다.
그래서 이 측정은 우리 DC 와 접점이 0인 GitHub 러너에서만 돈다.

## 구조

```
GitHub Actions (10분 cron)
   └ scripts/probe.mjs   5개 컴포넌트 프로브 → docs/state.json 갱신 → 커밋
GitHub Pages (main /docs)
   └ docs/index.html     state.json 을 읽어 상태 표시
status.egghosting.com    NameSilo DNS 에 CNAME → <org>.github.io
```

### 감시 대상 5줄

| 컴포넌트 | 프로브 대상 | 비고 |
|---|---|---|
| 관리 콘솔 | `egghosting.com/api/public/status` | 무인증 공개 헬스. **DB 왕복 1회 포함** |
| 웹호스팅 | `sajuj.com` | 카나리 |
| 클라우드 서버 | `hrdlo.kr` | 카나리 |
| 도메인 | `eggdomains.com` | 자체 권위 DNS 의존 |
| 로그인 | `ldpass.com` | 자체 권위 DNS 의존 |

**카나리란**: 고객 사이트를 개별로 잴 수 없으므로, 유료 고객과 **같은 경로**
(공인 IP → FortiGate → 앞단 nginx → 컨테이너)를 타는 우리 자체 서비스를 대신 잰다.
우리 소유라 고객 동의 문제가 없다.

🔴 **관리 콘솔은 홈(`/`)이 아니라 API 를 찔러야 한다.** 2026-08-01 당시 홈은 webvip 를 보고
살아 있었고 API 만 죽은 노드에 고정돼 있었다. 홈만 찌르는 프로브는 그 9시간 30분을 통째로
놓친다.

## 설치

### 1. 레포 + Pages

```bash
gh repo create <org>/egg-status --public --source=. --push
gh api -X POST repos/<org>/egg-status/pages \
  -f 'source[branch]=main' -f 'source[path]=/docs'
```

### 2. DNS (NameSilo)

`egghosting.com` 의 권위 DNS 는 NameSilo(dnsowl)다. 여기에 한 줄 추가한다.

```
Type      CNAME
Hostname  status              ← 라벨만. "status.egghosting.com" 아님
Target    <org>.github.io     ← 레포 이름은 들어가지 않는다
TTL       3600                ← NameSilo 최소값 (300 넣으면 code280 거부)
```

전파 2~3분. 확인: `nslookup status.egghosting.com 8.8.8.8`

### 3. 커스텀 도메인 연결

```bash
gh api -X PUT repos/<org>/egg-status/pages -f cname=status.egghosting.com
```
GitHub 이 DNS 를 확인한 뒤 Let's Encrypt 인증서를 자동 발급한다(수 분~1시간).
발급되면 Settings → Pages 에서 **Enforce HTTPS** 를 켠다.

⚠️ **순서를 지킬 것.** DNS 를 먼저 넣지 않고 커스텀 도메인을 설정하면 인증서 발급이 실패한다.

## 함정

**① 와일드카드를 덮어쓴다 — 정상 동작이다.**
`A * → 210.207.108.133` 이 이미 있어 지금 `status.egghosting.com` 은 우리 DC 로 간다.
명시적 CNAME 을 넣으면 더 구체적인 레코드가 이겨 GitHub 으로 간다.

**② 🔴 `status` 라벨을 고객 서브도메인 발급에서 예약어로 막을 것.**
고객이 `status` 를 집어가면 앞단 nginx 에 vhost 가 생겨 충돌한다.
라벨 발급에 DB 유니크 제약이 없고 앱 레벨에서만 걸러진다.

**③ GitHub schedule 은 정확하지 않다.**
러너가 붐비면 늦거나 건너뛴다. 그래서 10분은 "정확히 10분"이 아니라 "대체로 10분"이다.
가동률을 공개할 단계가 되면 외부 프로버로 옮기는 편이 낫다 —
`cloudflare/worker.js` 에 Cloudflare Worker 대안 구현이 들어 있다(cron 이 정확함, 계정 1개 필요).

**④ 60일간 커밋이 없으면 GitHub 이 scheduled workflow 를 자동 비활성화한다.**
이 레포는 10분마다 커밋되므로 해당 없음.

## 운영

### 가동률 %(90일) 공개하기

수집은 첫날부터 계속되지만(`docs/state.json` 의 `daily`) 화면에는 안 나온다.
공개하기로 결정하면 `docs/index.html` 의 렌더 함수에 열을 추가한다.

🔴 공개 전에 **보상 기준을 먼저 문서화**할 것. 숫자를 공개하는 순간 SLA 로 읽히고
환불 근거가 된다. 현재 MRR 의 79% 가 단일 고객(전용서버)에 몰려 있어 노출이 크다.

### 컴포넌트 추가/변경

`scripts/probe.mjs` 의 `TARGETS` 배열만 고친다. 배열 순서 = 페이지 표시 순서.

## 이 페이지가 하지 않는 것

- **개별 고객 서비스 상태를 보여주지 않는다.** 플랫폼 컴포넌트만 본다.
  고객 A 의 컨테이너만 죽으면 이 페이지는 초록이다. 그 한계를 페이지에 명시해 뒀다.
- **과거를 소급하지 않는다.** 측정 시작일부터만 데이터가 있다.
  2026-08-01 장애 등 그 이전 건은 가동률이 아니라 포스트모템 글로 다뤄야 한다.
