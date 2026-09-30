# Anthropic quota snapshot 재검증

Intent: ../intents/2026-09-30-web-quota-reset.md

## Goal
재시작 뒤 다른 Claude 세션에서 이미 변한 Anthropic quota를 오래된 snapshot이 가용 계정에서 잘못 제외하지 않도록 한다.

## Non-goals
Codex usage refresh/reset-credit 정책과 계정 credential 저장 형식은 변경하지 않는다.

## Acceptance
- Anthropic snapshot quota는 시작 직후 dashboard에 표시하되 live quota 응답 전 routing exclusion 근거로 사용하지 않는다.
- 5h·7d unified quota의 utilization/reset 전체가 같은 live 응답에서 확인되기 전에는 provisional marker를 지우지 않는다.
- utilization은 `0..1`, reset·standard limit/remaining은 엄격한 숫자 형식과 유효한 범위를 만족해야 live revalidation으로 인정한다.
- provisional 상태에서도 같은 응답으로 완성된 model weekly window의 소진은 해당 모델 라우팅에 즉시 반영한다.
- snapshot의 model weekly window는 폐기하고 live model 응답 전까지 pending으로 유지해 stale 값이 재활성화되지 않게 한다.
- 저장된 probe template가 있으면 client traffic을 기다리지 않고 provisional 계정을 재측정한다.
- 기본 브랜치의 lifecycle status probe, OAuth upsert, account rotation 보호 동작은 유지한다.
- provisional restore, partial/headerless response, restored-template warmup 회귀 테스트가 통과한다.

## Verification
`npx eslint src/account-manager.js src/index.js src/server.js test/account-manager.test.js test/warmup.test.js`

`node --test --test-concurrency=1 --test-name-pattern='provisional quota snapshot|headerless response keeps' test/account-manager.test.js`

`node --test --test-concurrency=1 --test-name-pattern='restored probe template immediately' test/warmup.test.js`
