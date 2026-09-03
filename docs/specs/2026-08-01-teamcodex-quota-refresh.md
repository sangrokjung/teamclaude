# TeamCodex 계정별 사용량 자동 갱신

## Problem

Codex provider는 계정별 사용량을 upstream 응답 헤더에서만 학습합니다. Proxy가 재시작되어 기존 5시간 창이 만료되면 측정값이 `null`로 지워지지만, 현재 Codex 응답은 rate-limit 헤더를 항상 반환하지 않아 대시보드의 대부분 계정이 계속 `—`로 남습니다. 또한 `x-codex-primary-window-minutes`가 10080분인 새 limit도 기존 코드는 무조건 5시간 창으로 분류합니다.

## Goal

Codex 공식 `GET /backend-api/wham/usage`를 계정별로 안전하게 조회하고, 실제 window 길이에 따라 5시간·7일 사용량을 정확히 반영합니다.

## Non-goals

- OAuth 계정·token 저장 형식이나 계정 선택 정책을 변경하지 않습니다.
- 사용량 조회 실패를 계정 auth 오류나 quota 소진으로 취급하지 않습니다.
- Anthropic provider의 기존 active warm-up 동작을 변경하지 않습니다.
- 대시보드가 credential이나 raw usage 응답을 노출하지 않습니다.

## Requirements

- Codex provider 시작 직후와 기존 warm-up 주기에 각 계정의 공식 usage endpoint를 best-effort 조회합니다.
- 계정 추가·삭제 live config-sync 직후에도 현재 계정 목록을 즉시 다시 조회합니다.
- 요청은 해당 계정의 bearer token과 `ChatGPT-Account-ID`만 사용하며 응답 body·credential을 로그에 남기지 않습니다.
- primary/secondary 이름이 아니라 `window_minutes`로 300분 창은 5시간, 10080분 창은 7일에 결합합니다.
- endpoint가 401·5xx·timeout·비정상 JSON을 반환해도 기존 quota·status·routing을 손상시키지 않습니다.
- 동시 refresh fan-out은 single-flight이고 서버 종료 시 timer를 정리합니다.

## Acceptance criteria

- 5개 계정의 usage endpoint가 값을 반환하면 `/teamclaude/status`의 각 계정에 해당 5시간·7일 값이 나타납니다.
- primary가 10080분인 응답은 `unified7d`에만 반영되고 `unified5h`를 오염시키지 않습니다.
- 기존 header-only 300/10080분 응답도 같은 규칙으로 분류됩니다.
- 조회 실패 계정은 이전 측정값을 유지하며 다른 계정의 refresh를 막지 않습니다.
- 기존 TeamCodex proxy PID는 구현 전 진단 동안 유지하고, 배포 시 한 번의 정상 재시작 후 실제 메뉴바 snapshot에서 사용량을 확인합니다.

## Risks

- 공식 usage endpoint는 계정당 주기적으로 1회 호출됩니다. 기본 5분 간격을 사용해 호출량을 제한합니다.
- OpenAI가 JSON 계약을 변경하면 refresh가 best-effort로 실패하고 기존 응답 헤더 학습 경로가 유지됩니다.

## Verification

- `test/server-codex.test.js`의 failing-first mapping·fleet refresh 테스트
- `npm test` 및 `npx eslint src/ test/`
- 실제 `/teamclaude/status` 5계정 측정 확인
- 메뉴바 `--teamcodex-snapshot` 렌더 확인
