# tabterm 네이티브 앱 경험 설계 (앱엔진 + PWA 강화)

- 작성일: 2026-06-07
- 상태: 설계 제시 — 사용자 검토 대기
- 범위: 단일 사용자(solo), 개발자 계정 없음, Windows 호스트
- 결정 방향: PWA 강화 + 토큰 페어링 앱엔진 (네이티브 .ipa 아님)

---

## 1. 배경 / 문제

tabterm 은 Tailscale Serve(HTTPS) 위에서 동작하는 브라우저 PTY 멀티플렉서이며
iPad/iPhone 에서는 "홈 화면에 추가"로 PWA 처럼 사용 중이다. 현재 겪는 통증:

| 통증 | 근본 원인 | 본 설계의 해결 |
|------|-----------|----------------|
| 캐시 연동 문제 | 브라우저 간 동기화된 공유 쿠키/캐시 | iOS 홈화면 PWA 독립 스토리지 + 디바이스별 토큰 |
| 다른 컴퓨터 중복 실행 충돌 | 공유 세션ID + worker-session 409 | 디바이스별 토큰으로 세션 충돌 원천 제거 + 공존 강화 |
| 글씨 깨짐 | xterm 폰트/셀그리드 desync (모바일 CSS override) | 폰트 렌더링 감사·수정 |
| 매번 12자+ 비번 재로그인 | in-memory 세션 휘발 (서버 재시작/만료) | 디스크 영속 디바이스 토큰 → 무한 자동 재연결 |

### 현재 코드 기준 사실 (그라운딩)

- 인증: `POST /api/auth/login` → `auth.issueSession()` → `tabterm.sid`(httpOnly) +
  `tabterm.sid.csrf`(JS 읽기 가능) 쿠키. 세션 맵은 **in-memory**, 서버 재시작 시 소실.
- `requireAuth` = 쿠키 세션 검증만. `requireCsrf` = csrf 쿠키 vs `x-tabterm-csrf` 헤더 비교.
- WS `/ws/pty?sessionId=` = **쿠키 인증** + Origin 검증 (server/ws.js).
- 멀티클라이언트 글리프 손상은 `ws.js`의 `updateClientDims`(min-dims across clients)로
  이미 완화됨 (커밋 b71584c, 7bd2a3c).
- 비번: scrypt N=65536 r=8 p=1, salt 16B, timing-safe (server/auth.js).
- iOS 11.3+ 홈화면 PWA 는 Safari 와 분리된 독립 스토리지를 가진다 → "캐시 연동" 원인 자동 제거.

---

## 2. 핵심 아키텍처 결정

### 디바이스 토큰 통합 방식: 토큰 → 쿠키 세션 교환 (채택)

디바이스 토큰은 디스크 영속(durable). 앱 실행 시 **신규 엔드포인트 1개**(`/api/auth/device/session`)
에서 토큰을 일반 쿠키 세션으로 교환한다. 기존 모든 라우트 + WS 는 **변경 없이 쿠키 인증 유지**.

- 디바이스 토큰 = 영속 "연결"(클로드 앱의 영속 로그인에 해당)
- 쿠키 세션 = 그로부터 파생되는 임시 실행 세션
- 장점: blast radius 최소, WS/CSRF/Origin 코어 불변, revoke 단순, 추론 용이
- 단점: PWA 내부 쿠키 의존 — 단 PWA 격리 쿠키 스토어라 무해

#### 기각된 대안

- 대안 B (Bearer 토큰 전면): `requireAuth`/`requireCsrf`/`ws.js`/모든 클라 fetch 수정.
  blast radius 큼, WS URL 토큰 로그 누출 위험. 기각.
- 대안 C (HTTP=bearer + WS 단기 티켓): 가장 안전한 WS 이나 부품 최다. solo 환경엔 과설계. 기각.

---

## 3. Phase 1 — 앱엔진 (사용자 명시 요청, 핵심)

### 3.1 데이터 모델

신규 파일 `data/devices.json` (mode 0600, atomic tmp-rename write, 기존 labels/auth 패턴 재사용):

```
{
  "v": 1,
  "devices": [
    {
      "id": "<base64url 12B>",
      "name": "<사용자 지정 또는 'iPhone'>",
      "tokenHash": "<scrypt(token)>",
      "tokenSalt": "<base64 16B>",
      "createdAt": "<ISO>",
      "lastSeenAt": "<ISO>",
      "revokedAt": null
    }
  ]
}
```

- 토큰 원문은 디스크에 저장하지 않는다 (scrypt 해시 + salt 만 저장).
- 토큰 발급 시 1회만 평문 반환 (페어링/등록 응답).

### 3.2 신규 모듈

`server/device-auth.js` — 디바이스 스토어 + 페어링 코드 스토어 + 라우트 등록 함수.
`server/index.js` 에는 `registerDeviceAuth(app, { auth, requireAuth, requireCsrf })` 호출만 추가.
(dp-proxy/system 라우트가 분리 등록되는 기존 패턴과 동일.)

페어링 코드 스토어: in-memory Map `{ code -> { expires, used:false } }`, TTL 120s, GC 포함.
(코드는 일회성 부트스트랩이라 영속 불필요 — 토큰만 영속.)

### 3.3 엔드포인트

| 엔드포인트 | 인증 | 동작 |
|-----------|------|------|
| `POST /api/auth/pair/start` | 쿠키 (기존 로그인 PC) + CSRF | 6자리 코드 생성(TTL 120s, 단일사용) + QR payload(`{origin, code}`) 반환 |
| `POST /api/auth/pair/claim` | 코드 (body) | 코드 검증·소비 → 디바이스 토큰 발급 + devices.json 기록. 응답에 평문 토큰 1회 |
| `POST /api/auth/device/register` | 비번 (body, rate-limit) | 비번 폴백 — PC 없이 폰만으로 토큰 발급 |
| `POST /api/auth/device/session` | 디바이스 토큰 (Bearer 또는 body) | 토큰 검증 → `auth.issueSession()` → 쿠키 set. lastSeenAt 갱신 |
| `GET /api/auth/devices` | 쿠키 | 페어링된 디바이스 목록 (id, name, createdAt, lastSeenAt, revoked) |
| `DELETE /api/auth/devices/:id` | 쿠키 + CSRF | revoke (revokedAt 설정) |

### 3.4 연결 흐름

1. 페어링(1회): 로그인된 PC 브라우저 설정에서 `pair/start` → QR/6자리 코드 표시.
   폰 앱에서 스캔/입력 → `pair/claim` → 토큰 수신 → PWA localStorage(격리) 저장.
   (PC 없을 때: 폰에서 비번 1회 입력 → `device/register` → 토큰 수신.)
2. 매 실행: PWA 부팅 시 저장된 토큰으로 `device/session` POST → 쿠키 세션 자동 발급.
3. 이후: WS·API 전부 기존 쿠키로 동작. 변경 없음.
4. 서버 재시작/쿠키 만료: 토큰은 디스크 영속 → 다음 실행에서 2번이 재실행 → 무한 자동 재연결.

### 3.5 클라이언트 변경 (최소)

`public/app.js` 부팅 로직: 쿠키 세션 없음(401) 감지 시 →
저장된 디바이스 토큰 있으면 `device/session` 자동 호출 → 성공 시 기존 흐름 재개.
토큰도 없고 세션도 없으면 → 페어링/로그인 화면. (구현은 승인 후 plan 단계에서 상세화.)

---

## 4. Phase 2 — PWA 강화

### 4.1 폰트 / 셀그리드 (글씨 깨짐)
- `public/app.js` + `public/styles.css` 의 xterm `fontFamily`/`fontSize`/`letterSpacing`/
  `lineHeight` 와 fit addon 셀 계산 desync 감사.
- 모바일 CSS override 가 xterm 내부 셀 그리드와 어긋나는 b71584c 류 재발 차단.
- 고정폭 + 한글 지원 웹폰트(예: D2Coding / 나눔고딕코딩 subset) 셀프호스팅 검토
  (시스템 폰트 의존 제거 → 기기별 렌더링 편차 감소).

### 4.2 매니페스트 앱 아이덴티티
- `public/manifest.json` 에 `id` 추가 (안정적 PWA 식별 → iOS 재설치/중복 식별 일관성).
- `start_url` 에 `?source=pwa` 부가 (분석/분기용, 선택).

### 4.3 단일 인스턴스 락 (같은 기기 내)
- `navigator.locks` 또는 BroadcastChannel 로 같은 기기 내 중복 탭/창 감지 → 경고 배너.
- 기기 간 중복은 공존 모델이 처리(아래 5절) — 락 대상 아님.

### 4.4 캐시 격리 검증
- 홈화면 PWA 독립 스토리지 동작을 QA 체크리스트로 검증 (Safari 탭과 캐시/쿠키 분리 확인).

---

## 5. 멀티기기 동작 (확정: 공존 강화)

- 디바이스별 토큰 → 세션ID 충돌 없음.
- WS 는 `updateClientDims` min-dims 로 글리프 손상 방지 (기존).
- 폰+PC 동시에 같은 터미널 보기/입력 가능 (tabterm 멀티플렉서 철학에 부합).
- "이 기기로 독점" 토글은 미래 옵션 — 본 설계 범위 밖 (YAGNI).

---

## 6. 보안 모델

- 디바이스 토큰: 32B random, scrypt 해시 저장, timing-safe 비교 (auth.js 패턴 재사용).
- 페어링 코드: TTL 120s + 단일사용 + claim 시도 rate-limit (brute force 차단).
- `device/register`(비번 폴백): 기존 로그인과 동일 rate-limit (분당 5회, IP 단위).
- 디바이스 토큰 만료: 기본 무기한, `DEVICE_TOKEN_TTL_DAYS` env 로 조정 가능. revoke 즉시 무효.
- bearer 로 들어오는 `device/session` 은 CSRF 면제 (토큰은 브라우저가 자동 첨부하지 않으므로
  CSRF 비대상). 그 외 쿠키 인증 mutation 은 기존 CSRF 유지.
- 기존 CSRF / Origin / WS 핸드셰이크 검증 전부 불변.

---

## 7. 테스트

신규 `server/device-auth.test.js` (node --test):
- 페어링 코드: TTL 만료, 단일사용(재사용 거부), 잘못된 코드 거부.
- 디바이스 토큰: 발급 → 검증 → revoke 후 거부.
- 세션 교환: 유효 토큰 → 쿠키 발급, revoked/만료 토큰 → 401.
- 비번 폴백: 정상 발급, rate-limit 동작.
- devices.json: atomic write, 손상 시 복구/리셋 (labels.js 패턴 차용).
- 회귀: 기존 server/*.test.js 전부 통과 (쿠키/WS/CSRF 코어 불변 확인).

---

## 8. Out of scope (YAGNI)

- 네이티브 .ipa / WKWebView 래퍼 (Mac/빌드 환경 생기면 별도 spec — 이 강화 웹앱을 그대로 로드)
- 푸시 알림 (web push)
- 다중 사용자 / 계정 시스템
- "기기 독점" takeover 토글
- 토큰 자동 로테이션

---

## 9. 구현 순서 (승인 후 writing-plans 에서 상세화)

1. Phase 1 앱엔진: device-auth.js + devices.json 스토어 + 엔드포인트 + 테스트
2. Phase 1 클라이언트: app.js 토큰 부팅 흐름 + 페어링/설정 UI
3. Phase 2 폰트/셀그리드 수정
4. Phase 2 매니페스트 / 단일 인스턴스 락 / 캐시 격리 QA
5. 통합 검증: typecheck(해당 없음, JS) + lint + node --test + 실기기 PWA 확인
