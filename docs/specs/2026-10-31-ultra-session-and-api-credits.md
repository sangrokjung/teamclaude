# Spec: Ultra 5시간 한도 없음 대응과 Claude API 키 크레딧 풀
- Intent: docs/intents/2026-10-31-ultra-session-and-api-credits.md
- Status: draft
- Grade: L (시크릿 경계: API 키 / 실제 과금 경로)

## Problem

1. 2026-10-30부터 검증된 Ultra(옛 Max 20x) 계정은 `anthropic-ratelimit-unified-5h-*` 헤더 없이 7d 헤더만 받는다(라이브 풀 21개 중 1개, 2026-10-31 실측). 프록시의 "완전 측정" 판정(`AccountManager._fullyMeasured`)은 OAuth 계정에 5h·7d 둘 다를 요구하므로 이 계정을 active warm-up 대상으로 계속 고르고, 상태 응답·CLI·TUI·메뉴바는 5h 값이 비어 있는 이유(측정 전인지, 한도가 없는지)를 구분하지 못한다.
2. API 키 계정(`type: 'apikey'`, `teamclaude api`)은 이미 풀에 들어가지만 구독 계정과 같은 순위로 섞여 쓰이고, 크레딧 잔액을 모르며, 크레딧이 떨어진 키의 400 응답을 일반 오류처럼 클라이언트에 돌려준다.

## Goal

- 5시간 한도가 없는 구독 계정을 사실로 기록하고, 프로브 반복을 멈추고, 모든 화면에서 "5시간 한도 없음"으로 보여 준다.
- API 키 계정을 "마지막 계층"으로 바꾼다. 구독 계정이 요청 모델을 하나도 서빙할 수 없을 때만 쓴다.
- API 키마다 충전 금액 대비 추정 지출과 남은 금액을 계산해 상태 응답·CLI·TUI·메뉴바에 보여 준다.
- 크레딧 소진 거절을 감지해 그 키를 빼고, 요청은 클라이언트에 오류를 주지 않고 다음 계정으로 넘긴다.

## Non-goals

- OpenAI API 키(Codex 풀). 다음 작업.
- Admin API·ID 페더레이션·콘솔 비공식 엔드포인트로 실제 잔액 조회.
- 지출 상한(대표 결정: 자동 충전을 끄는 것으로 충분).
- 메뉴바에서 키 입력·수정. 메뉴바는 보기 전용.
- 운영 프록시(고정 스냅샷 패키지) 배포와 재시작. 머지 후 대표 결정.

## Requirements

### A. 5시간 한도 없는 구독 계정

- A1. `quota.sessionWindowStated`(null | true | false)를 추가한다. Anthropic 모드 OAuth 응답에서:
  - `anthropic-ratelimit-unified-5h-utilization` 또는 `-reset` 헤더가 있으면 true.
  - 상태 코드 < 400이고, 7d 헤더가 있고, 5h 헤더가 하나도 없고, `unified-status`가 `rejected`가 아니면 false.
  - 그 밖(오류 응답, 헤더 없음)은 값을 바꾸지 않는다. API 키·Codex 계정은 건드리지 않는다.
- A2. 플래그는 quota 스냅샷(`<config>.quota.json`)에 저장·복원한다.
- A3. `_fullyMeasured`: OAuth 계정은 7d가 있고 (5h가 있거나 `sessionWindowStated === false`)이면 완전 측정이다. 그래서 active warm-up이 이 계정을 반복 프로브하지 않는다.
- A4. `sessionWindowStated === false`인데 남아 있는 5h 값은 reset이 없거나 지나면 지운다. 0%로 영원히 남지 않게 한다.
- A5. 계정 선택은 플래그가 아니라 실제 측정값으로만 막는다. 플래그가 틀려도 소진 계정이 풀에 돌아오지 않는다(상류 PR #622와 같은 원칙).
- A6. 표시:
  - `/teamclaude/status`에 계정별 `sessionWindowStated`를 싣는다.
  - CLI `status`와 TUI는 5h 자리에 `no 5h limit`(TUI 폭이 좁으면 `5h —·none` 류의 짧은 표기)를 쓴다.
  - 메뉴바 Claude 탭·개요는 5시간 막대 자리에 "5시간 한도 없음"(영어 "No 5-hour limit")을 쓰고, 소진 예측·재시도 시각 계산(`computeTeamClaudeRetryAfterSeconds` 등)은 주간 창만 쓴다.
  - Codex 풀은 이번 범위 밖이다(포크의 Codex 쪽은 이 필드를 쓰지 않는다).

### B. API 키 크레딧 계층

- B1. 설정(`config.accounts[]`, `type: 'apikey'`) 선택 필드:
  - `creditUsd`: 충전·지급 금액(USD, 양수).
  - `creditSince`: 지출 집계 시작 시각(ms). `creditUsd`를 새로 정할 때 같이 갱신.
  - `creditExpiresAt`: 크레딧 만료 시각(ms, 선택).
  - `creditExhausted`: `{ reason, at }` 또는 없음. 영속 플래그(`subscriptionDisabled`와 같은 방식, `onAccountFlag` 경로).
- B2. CLI:
  - `teamclaude api [--name N] [--credit USD] [--expires YYYY-MM-DD]`: 기존 프롬프트로 키를 받는다(에코 없이). 키는 출력·로그에 쓰지 않는다.
  - `teamclaude api-credit <name> <USD|clear> [--expires YYYY-MM-DD|none]`: 충전 금액을 다시 정하면 `creditSince`를 지금으로, 지출 원장을 0으로, `creditExhausted`를 지운다. 실행 중 서버는 `syncAccountsFromDisk` 경로로 반영한다.
  - codex 모드 설정에서는 둘 다 거부한다.
- B3. 계층: Anthropic 모드에서 API 키 계정은 "유료 계층"이다. 요청 모델을 서빙할 수 있는 OAuth 계정(쿼터·스로틀·비활성·오류 기준, 동시성 한도로만 꽉 찬 계정은 서빙 가능으로 셈)이 하나라도 있으면 API 키 계정은 고르지 않는다. 기존 Codex 크레딧 계층(`_creditTier`·`_anyIncludedAvailable`·`_creditsUnlocked`)의 구조를 일반화해 쓴다. OAuth 계정이 하나도 없는 풀(API 키만 있는 사용자)은 지금처럼 API 키를 바로 쓴다.
  - 계층 순서: 구독 계정 → (모델별 소진이면) API 키 계정이 원래 모델로 서빙 → `modelFallbacks` 재작성 → continuity 대기.
  - `/byok` 통로 요청은 반대로 API 키 계정을 **먼저** 쓴다(대표 2026-10-31: 크레딧은 결제 주기 끝에 사라지므로). 쓸 수 있는 API 키가 없거나 모두 소진이면 지금처럼 구독 계정으로 간다. 통로 판별은 기존 `ctx.byok`(경로 접두로만 정해지는 구조적 판별)을 쓴다.
  - Claude Code 요청(`/v1/...`)도 마지막 계층으로 API 키를 쓴다(대표 2026-10-31 "사용해도 됩니다"). 공식 문서는 구독 동봉 크레딧의 Claude Code 사용을 막지만, 10/31 실측에서 Claude Code 표시가 있는 요청도 200이었다. 상류가 거절하면 B7로 처리한다. 요청을 다르게 꾸미지 않는다.
  - API 키끼리 순서: `creditExpiresAt`이 가까운 키 먼저(없으면 맨 뒤), 같으면 추정 잔액이 적은 키 먼저(먼저 비우기), 그다음 배열 순서.
- B4. 지출 원장: 성공 응답(스트리밍 포함)의 `usage`에서 `input_tokens`, `cache_creation_input_tokens`(가능하면 5분·1시간 분리 필드), `cache_read_input_tokens`, `output_tokens`와 응답 모델로 비용을 계산해 계정의 `quota.apiSpendUsd`에 더한다. 단가를 모르는 모델의 토큰은 `quota.apiUnpricedTokens`에 따로 센다. 원장은 quota 스냅샷에 저장한다. `creditSince`가 바뀌면 0부터 다시 센다.
- B5. 단가표: 새 모듈 `src/api-pricing.js`(런타임 의존성 0). 현행 Claude 모델의 공개 단가(입력·출력·캐시 쓰기 5분/1시간·캐시 읽기, 1M 토큰당 USD)를 기본값으로 넣고, `config.apiPricing`으로 모델별 덮어쓰기를 받는다. 모델 이름은 날짜·`[1m]` 접미를 떼고 가장 긴 접두로 맞춘다. 단가 출처와 확인 날짜를 모듈 주석에 적는다.
- B6. 추정 잔액 = `creditUsd − apiSpendUsd`. 추정은 계정을 막지 않는다. 실제 거절만 막는다.
- B7. 거절 감지: API 키 계정의 응답 중 아래는 `creditExhausted`를 세우고 그 키를 빼고, 응답 바이트가 클라이언트로 나가기 전이면 다음 계정으로 재시도한다(5xx 장애 조치와 같은 경로, 같은 계정 재시도 없음).
  - 400 `invalid_request_error`, 메시지에 `credit balance is too low` → reason `credit-exhausted`.
  - 400, 메시지에 `reached your specified API usage limits` → `usage-limit`.
  - 429, `error.details.error_code === 'enforced_spend_limit_reached'` → `spend-limit`.
  - 402 `billing_error` → `billing`.
  - 해제: `teamclaude api-credit` 재설정, 키 재등록(`updateAccountTokens` 경로), 또는 `teamclaude enable`이 아닌 명시 명령만. 자동 프로브로 되살리지 않는다.
- B8. (10/31 실측: `sk-ant-usr-` 키로 Claude Code `system` 표시가 있는 요청·없는 요청 모두 200. OAuth 전용 beta 헤더는 미실측.) OAuth 전용 요청 요소: Claude Code가 보낸 요청을 API 키로 전달할 때 상류가 거부하는 요소가 있으면(예: `anthropic-beta`의 `oauth-2025-04-20`) API 키 계정에 한해 그 요소만 뺀다. 무엇을 빼야 하는지는 구현 단계에서 실제 키로 최소 요청을 보내 확인하고, 확인 결과를 PR 증거에 남긴다. 빼지 않아도 되면 아무것도 바꾸지 않는다.
- B9. 상태 응답: API 키 계정에 `credit: { usd, spentUsd, remainingUsd, since, expiresAt, exhausted, exhaustedReason, unpricedTokens }`를 싣는다. 키 값·키 일부는 싣지 않는다.
- B10. 표시:
  - CLI `status`: API 키 행에 `credit ~$12.30 left of $50.00 (est.)`, 소진이면 `[credit exhausted]`, 만료일.
  - TUI: 같은 정보를 한 줄로.
  - 메뉴바 Claude 탭: API 키 계정은 구독 계정 아래 "API 크레딧" 묶음으로 따로 보인다. 행마다 남은 금액 막대(추정 표시), 만료일, 소진 라벨. 개요의 "쓸 수 있는 계정" 집계는 구독과 API를 나눠 센다. 한국어·영어 문구를 같이 넣는다.
  - 메뉴바 소비 지점마다 테스트를 둔다(상태 필드 추가 시 소비자 전수 배선 규칙).

## Acceptance criteria

1. 5h 헤더 없이 7d 헤더만 오는 성공 응답 뒤 그 OAuth 계정은 `sessionWindowStated: false`, active warm-up 대상에서 빠지고, 재시작 뒤에도 유지된다.
2. 같은 계정에 5h 헤더가 다시 오면 true로 돌아가고 막대가 다시 보인다.
3. OAuth 계정 하나라도 요청 모델을 서빙할 수 있으면 API 키 계정에는 요청이 가지 않는다. OAuth 전부가 쿼터 소진·스로틀이면 API 키 계정이 원래 모델로 서빙한다.
4. API 키 계정에서 400 "credit balance is too low"를 받으면 클라이언트는 그 오류를 보지 않고 다음 계정(없으면 기존 429/continuity 경로)으로 가며, 그 키는 `creditExhausted`로 영속되고 재시작 뒤에도 빠져 있다.
5. `teamclaude api-credit <name> 50`으로 원장이 0, 소진 플래그가 해제된다.
6. 스트리밍·비스트리밍 응답 모두 비용이 원장에 쌓이고, 단가표 계산이 손계산 예제와 맞는다(테스트).
7. 상태 응답·CLI·TUI·메뉴바 어디에도 키 값이 나오지 않는다(테스트로 스캔).
8. 메뉴바: 5시간 한도 없음 문구, API 크레딧 묶음, 개요 집계가 한국어·영어로 나온다(QA 훅 캡처).

## Risks

- 단가표가 실제와 다르면 추정 잔액이 틀린다. 추정임을 화면에 표시하고, 실제 거절을 진실로 삼는다.
- Claude Code의 OAuth 전용 헤더·본문 때문에 API 키 요청이 거절될 수 있다(B8 실측으로 해소).
- 크레딧 거절 메시지 문구가 바뀌면 감지가 빠진다. 감지 실패 시 400이 클라이언트에 가는 기존 동작으로 떨어질 뿐 과금 위험은 없다.
- 계층 일반화가 Codex 크레딧 계층 동작을 바꿀 수 있다. Codex 기존 테스트 전량 통과로 막는다.
- 운영 프록시는 고정 스냅샷이다. 머지만으로는 운영에 반영되지 않는다.

## Concerns

- 시크릿 경계(`secrets-env-git.md`): 키 값은 설정 파일(0600)에만 있고 출력·로그·상태 응답·커밋에 나오지 않아야 한다. 대표가 대화에 붙인 키는 세션이 등록하지 않는다. 등록은 대표가 `! teamclaude api`로 직접 한다. 해소(설계에 반영).
- 공개 저장소 게시 경계: 테스트 픽스처에 실제 계정 이름·이메일·키 접두 이외 값을 쓰지 않는다. 커밋 전 grep 스윕. 해소(절차).
- 운영 반영(재시작): 대표 결정 필요(기존 지시: 작업이 없을 때·새벽 시간). 보류.
- 롤백 위험: 이 변경을 되돌리면 옛 코드는 API 키 계정을 구독과 같은 순위로 쓴다. 롤백 전에 API 키 계정을 `teamclaude disable`해야 한다. 해소(Rollback 절차).

## Alternatives

- Admin API로 실제 지출 조회: 4~24시간 지연, 키 종류 제약, 비밀 하나 증가. 기각(대표 동의).
- 콘솔 쿠키로 비공식 잔액 엔드포인트: 깨지기 쉽고 세션 쿠키를 다뤄야 한다. 기각.
- 상류 PR #622 그대로 이식: 상류 구조(`warmer.js`·`quota-summary.js`)가 포크에 없다. 원칙(플래그는 표시·프로브에만, 선택은 측정값)만 가져와 포크에 맞게 구현한다.

## Decision

A는 상류 #622 원칙을 포크 구조에 맞춰 구현. B는 Codex 크레딧 계층을 일반화한 "유료 계층" + 로컬 추정 원장 + 상류 거절 감지.

## Migration

- 새 설정 필드는 모두 선택이다. 기존 API 키 계정은 `creditUsd`가 없어도 유료 계층으로 동작하고, 잔액은 "충전 금액 미입력"으로 보인다.
- quota 스냅샷 새 필드는 없으면 null/0으로 시작한다.

## Rollout

1. PR 머지(필수 CI·독립 적대 검토·메뉴바 QA).
2. 운영 반영은 대표 결정 뒤 기존 배포 경로(고정 패키지 갱신)와 재시작. 메뉴바는 새 빌드 설치.
3. 반영 뒤 대표가 키를 등록: `! teamclaude api --name <계정>-api --credit <금액>`.
4. 실제 키로 최소 요청 1회 확인(B8).

## Rollback

1. `teamclaude disable <API 키 계정>`으로 API 키 계정을 먼저 뺀다.
2. 이전 패키지로 되돌리고 재시작. 새 설정 필드는 옛 코드가 무시한다.

## Observability

- 로그: 계층 전환(`[TeamClaude] paid tier: <name>`), 크레딧 거절 감지(사유), 원장 재설정. 키 값 없음.
- 상태 응답 `credit` 블록, `sessionWindowStated`.

## Runbook

- "API 키가 안 쓰인다": 구독 계정이 하나라도 서빙 가능한지 `teamclaude status`로 본다. 정상 동작이다.
- "API 키가 소진으로 빠졌다": 콘솔 Billing에서 잔액 확인 → 충전했다면 `teamclaude api-credit <name> <금액>`.
- "추정 잔액이 실제와 다르다": 콘솔 금액으로 `api-credit` 재설정, 단가는 `config.apiPricing`으로 보정.

## Verification

- 단위·통합 테스트: A1~A6, B1~B9 각 요구에 대한 RED→GREEN 테스트(`test/` Node 테스트, 메뉴바 Swift 테스트).
- 실표면: 메뉴바 QA 훅 캡처(개요·Claude 탭, 5시간 한도 없음 행과 API 크레딧 묶음). 개발 픽스처 프록시(TEAMCLAUDE_CONFIG 임시 설정)로 CLI `status`·TUI 확인.
- 실제 키 최소 요청(B8)은 대표가 키를 등록한 뒤 운영 반영 단계에서 한다. 그 전까지 PR 증거에 "B8 실측 대기"로 적는다.

## Open questions

- 운영 3456 설정에서 `/byok` 통로가 꺼져 있다(상태 응답 `byok: null`). Hermes 설정 두 곳은 이 통로를 가리킨다. 통로를 켜는 것은 설정 변경이라 B 배포 때 대표에게 확인한다.

- 구독 동봉 무료 크레딧의 만료 규칙(조사 중). 결과에 따라 `--expires` 기본값 안내와 순서 규칙(B3)을 확정한다. 지금은 선택 입력으로 둔다.
- 단가표의 정확한 현행 값은 구현 시 공식 가격 페이지로 확인한다.
