# TeamCodex status 계정 정체성

## Problem

`GET /teamclaude/status`가 계정 이름만 반환해, 같은 이름의 다른 OAuth 계정으로 교체되는 동안 외부 대시보드가 이전 계정의 quota와 상태를 새 계정에 잘못 연결할 수 있습니다.

## Goal

credential-free status 응답에 안정적인 계정 정체성을 제공해 소비자가 UUID-first로 config와 live 상태를 결합하게 합니다.

## Non-goals

- OAuth credential, token, email을 추가로 노출하지 않습니다.
- 계정 저장·선택·SIGHUP 동기화 정책을 변경하지 않습니다.
- 실행 중 proxy를 강제 재시작하지 않습니다.

## Requirements

- 최상위에 `currentAccountUuid`, 각 account row에 `accountUuid`를 nullable 값으로 제공합니다.
- access/refresh/id token은 status에 포함하지 않습니다.
- UUID가 없는 API-key·legacy account는 `null`을 반환합니다.

## Acceptance criteria

- 같은 이름의 다른 UUID를 status 소비자가 구분할 수 있습니다.
- status JSON에 credential 필드가 없습니다.
- 기존 status 필드와 계정 선택 동작은 변하지 않습니다.

## Risks

- 구버전 소비자는 새 JSON 필드를 무시하므로 호환됩니다.
- 이미 실행 중인 구버전 worker는 다음 자연 재시작 전까지 새 필드를 제공하지 않습니다.

## Verification

- `test/account-manager.test.js`
- 전체 `npm test`
- 메뉴바 UUID-first fixture/self-test와 status smoke test
