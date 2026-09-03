# Claude subscription-disabled account failover

## Problem

Anthropic OAuth account의 조직이 Claude Code subscription access를 비활성화하면 `/v1/messages`가 완결된 HTTP 403을 반환합니다. 현재 proxy는 upstream 401만 account auth failure로 격리하므로 이 403을 Claude Code에 그대로 전달하고, sticky/affinity 선택은 같은 account를 계속 사용합니다. 건강한 account가 남아 있어도 CLI가 `Your organization has disabled Claude subscription access for Claude Code`로 즉시 종료됩니다.

## Goal

정확히 식별된 subscription-disabled OAuth 403을 account-scoped 영구 인증 오류로 격리하고, 같은 request를 다른 사용 가능한 account로 즉시 재전송합니다. 일반 permission 403은 account 상태를 바꾸거나 재전송하지 않습니다.

## Non-goals

- 조직의 Anthropic 관리 정책을 변경하거나 API key 사용으로 자동 전환하지 않습니다.
- 모든 403을 인증 오류로 간주하지 않습니다.
- client 저장 로그인, source Claude config, account credential을 수정하지 않습니다.
- 기존 401 refresh retry, 429 quota, 5xx/network continuity 의미를 바꾸지 않습니다.

## Requirements

1. `provider=anthropic`, OAuth account, HTTP 403, JSON `error.type='permission_error'`, `error.details.error_code='oauth_not_allowed_for_organization'`일 때만 account-scoped subscription rejection으로 분류합니다. Claude Code가 가공해 표시하는 자연어 문구에는 의존하지 않습니다.
2. 분류된 account는 `status='error'`, `_errorFromRefresh=false`가 되어 selection, affinity, warm-up, refresh sweep의 자동 부활 대상에서 제외됩니다.
3. 403은 upstream이 요청을 완결해 거부한 증거이므로 다른 사용 가능한 account가 있으면 POST도 안전하게 한 번씩 failover할 수 있습니다. 한 request에서 account별 최대 1회, 전체 account 수를 상한으로 합니다.
4. 건강한 account가 성공하면 client는 그 성공 response를 받습니다.
5. 모든 account가 동일하게 거부되면 마지막 upstream 403의 status/body/end-to-end headers를 그대로 반환합니다.
6. 다른 permission 403, malformed JSON 403, oversized 403 body는 기존 pass-through/response-limit 의미를 유지하며 account 상태를 변경하지 않습니다.
7. log에는 account name과 분류 결과만 남기고 token, Authorization, upstream body의 민감 데이터를 새로 출력하지 않습니다.

## Acceptance criteria

- 실제 `teamclaude run -- -p ...`로 기존 오류가 재현되고 usage가 0인 403임을 기록합니다.
- synthetic upstream에서 account A가 정확한 subscription-disabled 403, B가 200이면 A는 한 번만 호출되고 `error`로 격리되며 client는 B의 200을 받습니다.
- 두 account 모두 정확한 403이면 둘 다 한 번씩 격리되고 마지막 원본 403 body/header가 client에 반환됩니다.
- 일반 `permission_error` 403이면 failover하지 않고 원본 403을 반환하며 account는 active 상태를 유지합니다.
- 기존 401/429/stream/affinity 관련 regression과 전체 `npm test`, `npx eslint src/ test/`가 통과합니다.
- 실제 Claude Code QA에서 subscription-disabled account를 앞에 둔 격리 harness가 건강한 account 응답으로 종료되며 credential이 evidence에 노출되지 않습니다.

## Risks

- 분류가 넓으면 request-scoped permission 403을 잘못 격리할 수 있습니다. 구조화된 upstream `error_code`와 OAuth account 조건으로 제한합니다.
- 403 body를 분류하려면 buffering이 필요합니다. 기존 `maxResponseBytes` 상한을 그대로 적용하고, 초과 시 기존 502 response-limit 계약을 유지합니다.
- account가 조직 관리자 설정 변경 후 회복되어도 자동으로 부활하지 않습니다. upstream-auth error의 기존 계약대로 re-import/login 또는 명시적 운영 조치로만 복구합니다.

## Verification

- Red/green: 전용 `test/server-403.test.js`의 exact-match failover test를 수정 전 실패, 수정 후 성공으로 확인합니다.
- Targeted: 403 전용 test와 `test/server-401.test.js`, 429/network/stream 관련 test를 실행합니다.
- Full: 부하 게이트를 거친 `npm test`, `npx eslint src/ test/`를 실행합니다.
- Manual: 격리된 temp config/upstream에서 실제 `node src/index.js run -- -p ...`를 사용해 CLI 결과를 관찰합니다.
- Adversarial: goal, hands-on QA, code quality, security/auth boundary, context/history의 독립 5개 lane이 현재 diff를 검토합니다.

## Alternatives

- 모든 403 failover: 구현은 단순하지만 권한 부족·정책 위반 request까지 fleet 전체에 재전송하므로 기각합니다.
- CLI error text를 감지해 process를 재시작: 이미 실패 response가 client에 노출되고 account 상태가 오염된 채 남으므로 기각합니다.
- 해당 account를 수동 disable: 즉시 운영 우회는 가능하지만 새 account에서 같은 문제가 재발하고 자동 복구 요구를 충족하지 못합니다.

## Decision

Proxy response 경계에서 exact structured error-code 403 classifier를 사용합니다. 완결된 account-scoped rejection만 account error로 격리하고, 다른 403은 byte-preserving pass-through합니다.

## Migration

Config/schema/data migration은 없습니다. 기존 account 상태 파일 형식도 변경하지 않습니다.

## Rollout

1. synthetic red/green과 전체 regression을 통과시킵니다.
2. 임시 local server/Claude config로 실제 CLI failover를 확인합니다.
3. 운영 server는 검증 완료 뒤 `teamclaude restart`로 새 worker를 로드합니다.
4. status에서 거부 account가 `error`로 격리되고 건강한 active account가 선택되는지 확인합니다.

## Rollback

- 운영 우회: 문제 account를 `teamclaude disable <name>`로 제외합니다.
- 코드 rollback: 이 변경의 classifier/403 branch/test/docs를 reverse-revert합니다.
- Config/data migration이 없으므로 별도 rollback 작업은 없습니다. 격리된 account는 re-import/login 또는 server restart 후 검증된 credential로 복구합니다.

## Observability

- 분류 시 `[TeamClaude] 403 subscription access disabled on "<account>" — marking account error and switching`을 남깁니다.
- body/token은 log하지 않습니다.
- `teamclaude status`의 account `error`와 active account 변경이 운영 확인 표면입니다.

## Runbook

1. CLI에 해당 문구가 나타나면 `teamclaude status`에서 active/error account를 확인합니다.
2. 건강한 account가 남았는데도 client가 403을 받으면 server가 수정 버전을 로드했는지 확인하고 `teamclaude restart`합니다.
3. 모든 account가 error면 각 조직의 Claude Code subscription access를 관리자에게 확인한 뒤 account를 re-import/login합니다.
4. 긴급 우회는 문제 account disable이며, API key 자동 전환이나 source Claude config 수정은 하지 않습니다.
