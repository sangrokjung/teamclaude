# TeamCodex status 계정 정체성 실행 계획

> 상태: superseded. 공개 status에 stable identity를 제공한다는 초기 계획은
> 계정 표시 이름도 식별 정보라는 보안 검토 결과로 대체되었습니다.

1. `AccountManager.getStatus()`는 기본 응답에서 `name`, `accountUuid`,
   `currentAccount`, `currentAccountUuid`를 생략합니다.
   - 검증: public/spoofed status가 이름과 stable ID를 모두 포함하지 않습니다.
2. localhost caller가 proxy API key와 `x-teamcodex-status-identity: 1`을 모두
   제공할 때만 identity-bearing snapshot을 반환합니다.
   - 검증: trusted local request는 UUID-first 복구와 CLI 출력을 계속 지원합니다.
3. supervisor는 원격 요청의 identity capability header를 worker에 전달하지
   않습니다.
   - 검증: 유효한 proxy key를 가진 remote request도 identity를 얻지 못합니다.
4. CLI `status`와 내부 `api /teamclaude/status`는 명시적으로 capability를
   요청하고, TUI는 live AccountManager를 직접 읽어 계정명을 계속 표시합니다.
   - 검증: status CLI, supervisor, TUI의 회귀 테스트와 xterm.js 수동 QA를 실행합니다.

## Verification

완료 시 public/trusted status 계약, 전체 테스트, xterm.js TUI 증거와 exact review
SHA를 기록합니다.
