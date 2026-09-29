# Anthropic quota snapshot 재검증

## Goal
재시작 뒤 다른 Claude 세션에서 이미 변한 Anthropic quota를 오래된 snapshot이 가용 계정에서 잘못 제외하지 않도록 한다.

## Non-goals
Codex usage refresh/reset-credit 정책과 계정 credential 저장 형식은 변경하지 않는다.

## Acceptance
- Anthropic snapshot quota는 시작 직후 dashboard에 표시하되 live quota 응답 전 routing exclusion 근거로 사용하지 않는다.
- 5h·7d unified quota의 utilization/reset 전체가 같은 live 응답에서 확인되기 전에는 provisional marker를 지우지 않는다.
- 저장된 probe template가 있으면 client traffic을 기다리지 않고 provisional 계정을 재측정한다.
- lifecycle status probe 기본 timeout은 과부하에서 정상 프로세스를 오판하지 않도록 5초이며 환경변수로 덮어쓸 수 있다.
- provisional restore, partial/headerless response, restored-template warmup 회귀 테스트가 통과한다.

## Verification
`npx eslint src/account-manager.js src/index.js src/server.js test/account-manager.test.js test/warmup.test.js`

`node --test --test-concurrency=1 --test-name-pattern='provisional quota snapshot|headerless response keeps' test/account-manager.test.js`

`node --test --test-concurrency=1 --test-name-pattern='restored probe template immediately' test/warmup.test.js`
