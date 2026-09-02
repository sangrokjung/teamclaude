# TeamCodex status 계정 정체성

> 상태: superseded. 현재 public status는 display name과 stable ID를 모두
> 생략합니다. identity-bearing snapshot은 `localhost + proxy API key +
> explicit identity header`를 모두 만족한 내부 호출에만 반환됩니다.

## Problem

`GET /teamclaude/status`가 계정 이름만 반환해, 같은 이름의 다른 OAuth 계정으로 교체되는 동안 외부 대시보드가 이전 계정의 quota와 상태를 새 계정에 잘못 연결할 수 있습니다.

## Goal

trusted local status 응답에 안정적인 계정 정체성을 제공해 복구·CLI 소비자가
UUID-first로 config와 live 상태를 결합하게 합니다.

## Non-goals

- public status에 OAuth credential, token, email, display name, stable ID를
  노출하지 않습니다.
- 계정 저장·선택·SIGHUP 동기화 정책을 변경하지 않습니다.
- 실행 중 proxy를 강제 재시작하지 않습니다.

## Requirements

- trusted internal snapshot에 최상위 `currentAccountUuid`, 각 account row의
  `accountUuid`·`name`을 제공합니다.
- public snapshot에는 `currentAccount`, `currentAccountUuid`,
  `accountUuid`, `name`을 제공하지 않습니다.
- access/refresh/id token은 status에 포함하지 않습니다.
- UUID가 없는 API-key·legacy account는 `null`을 반환합니다.

## Acceptance criteria

- trusted local status 소비자는 같은 이름의 다른 UUID를 구분할 수 있습니다.
- status JSON에 credential 필드가 없습니다.
- 기존 status 필드와 계정 선택 동작은 변하지 않습니다.

## Risks

- 공개 status의 `name`에 의존하던 외부 소비자는 opaque 상태 정보만 받습니다. 계정
  식별이 필요하면 같은 머신의 `teamcodex status` 또는 capability가 있는 내부 호출로
  이동해야 합니다.
- 이미 실행 중인 구버전 worker는 다음 자연 재시작 전까지 이전 identity 노출 계약을
  유지할 수 있으므로, 릴리스 후에는 worker를 재시작해야 합니다.

## Verification

- `test/account-manager.test.js`
- 전체 `npm test`
- 메뉴바 UUID-first fixture/self-test와 status smoke test
