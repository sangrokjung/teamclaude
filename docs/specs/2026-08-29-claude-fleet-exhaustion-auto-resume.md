# Claude fleet exhaustion auto-resume

## Problem

TeamClaude proxy가 모든 Claude 계정의 제한 해제까지 남은 시간을 계산해 `All N accounts exhausted. Retry in Ns.` 429를 반환해도, `teamclaude run`의 Claude recovery harness는 이를 일반 `limit`으로만 분류합니다. 따라서 서버가 지시한 대기 시간을 버리고 최대 30초의 일반 backoff로 조기 재실행한 뒤 다시 실패합니다.

## Goal

`teamclaude run`으로 시작한 Claude Code가 정확한 fleet-exhaustion 429를 받으면 오류에 포함된 `Retry in Ns`를 기다린 뒤 동일 session을 `--resume <session-id> continue`로 자동 재실행합니다. 이미 실행 중인 cmux 세션이 recovery parent 없이 남은 경우에도, 소유자 전용 session registry와 transcript에서 같은 오류를 확인하고 제한 해제 시점 이후 새 비포커스 workspace에서 같은 session을 한 번만 재개합니다.

## Non-goals

- Claude Code source 설정이나 `.claude/` hook 파일을 수정하지 않습니다.
- 일반 rate/concurrency 429, timeout, login-expired, ambiguous dispatch의 기존 복구 의미를 바꾸지 않습니다.
- cmux session registry에 기록되지 않았거나 active surface mapping이 없는 일반 `claude` process에는 recovery parent를 소급 연결하지 않습니다.
- `codexFallbackOnExhaustion`이 활성화된 경우의 기존 Codex handoff 우선순위를 바꾸지 않습니다.

## Requirements

1. structured assistant `isApiErrorMessage`의 rate-limit 계열 HTTP 429 record에서 전체 `API Error: Server is temporarily limiting requests (not your usage limit) · All <count> accounts exhausted. Retry in <seconds>s.` 문장을 정확히 식별합니다. 실제 Claude 출력의 `Retry\n  in` 줄바꿈만 추가로 허용하며 앞뒤 공백, 축약 prefix, status/type/role 불일치는 자동 재개하지 않습니다.
2. 양의 안전한 정수 초만 대기값으로 인정하며 malformed·0·overflow 값은 기존 일반 limit 처리로 남깁니다. 실제 대기는 Anthropic의 가장 긴 weekly reset을 포괄하는 7일로 상한을 둡니다.
3. `autoResumeClaude: true`이고 exact session과 retry budget이 남았을 때만 Claude child를 종료하고 서버 지시 시간만큼 기다립니다.
4. 대기 후 같은 session에 literal `continue`를 보내 원래 prompt를 다시 실행합니다. 이 replay는 upstream이 완결된 429 거부를 반환한 경우에만 허용됩니다.
5. `codexFallbackOnExhaustion: true`이고 fresh general quota evidence로 전체 소진이 확인되면 기존처럼 대기보다 Codex handoff를 우선합니다.
6. fleet exhaustion 대기는 `claudeFleetExhaustionMaxRetries` budget을 사용하며 기본값 `0`은 제한 해제까지 계속 대기합니다. timeout·일반 오류의 `claudeAutoResumeMaxRetries` budget은 유지합니다.
7. 인접한 login/usage-limit 계정 회전은 account 이름이 아니라 이전·현재 UUID와 `CLAUDE_CODE_OAUTH_TOKEN` recovery marker가 모두 일치할 때만 재개합니다.
8. Codex handoff의 transcript metadata는 단일 행 branch allowlist를 통과한 값만 기록하고, 개행·Markdown·시크릿 후보가 섞이면 `unknown`으로 처리합니다.
9. cmux rescue는 fleet 오류의 transcript timestamp와 서버 retry hint가 아직 유효하면 process를 종료하거나 새 workspace를 만들지 않습니다. claim·종료 중 transcript, registry, parent·child process identity가 바뀌면 새 실행을 취소합니다.
10. cmux에서 ID 없는 `-r`/`--resume` picker와 `--continue`만 현재 surface의 active session으로 연결합니다. named resume, malformed `--session-id`, 일반 환경의 ambiguous selector는 기존 passthrough을 유지합니다. 연결은 registry의 active surface·PID·`pidStartSeconds`·launcher 작업 디렉터리와 현재 supervisor process identity를 모두 대조하며, 기존 transcript 끝을 새 child의 시작 offset으로 삼아 과거 오류를 재처리하지 않습니다.

## Acceptance criteria

- 제시된 오류 문구의 transcript record가 `fleet_exhausted`와 `2235000ms`로 분류됩니다.
- 짧은 fixture retry 값에서 첫 Claude child가 종료되고 지정 시간 이후 정확히 한 번 `--resume <session-id> continue`로 재실행됩니다.
- 일반 overload error는 기존 exponential backoff 경로를 유지합니다.
- malformed retry 값은 장기 대기 경로에 들어가지 않습니다.
- exact 문구라도 non-429, 앞뒤 공백, 같은 UUID 회전은 새 Claude child를 시작하지 않습니다.
- 악성 `gitBranch` metadata가 handoff 지시문이나 시크릿으로 나타나지 않습니다.
- cmux에 저장된 TeamClaude supervisor PID에서 공식 Claude native child를 찾아도, parent·child identity와 launch surface가 모두 일치할 때만 제한 해제 후 한 번 재개합니다.
- retry deadline 전 cmux scan은 후보만 기록하고 process 종료·workspace 생성은 하지 않습니다.
- 설정된 최대 대기 상한을 넘는 retry hint는 상한까지만 기다립니다.
- ID 없는 cmux 실행의 picker가 늦거나 resolver가 멈춰도 resolver deadline 이후 child를 그대로 반환하며, 다른 cwd·PID 재사용·오래된 transcript 오류를 자동 재개하지 않습니다.
- targeted test, 전체 suite, lint가 통과하고 실제 CLI fixture에서 같은 session 재실행을 관찰합니다.

## Risks

- 잘못 넓은 문구 매칭은 prompt text나 unrelated rate limit를 장기 대기로 오인할 수 있습니다. `isApiErrorMessage`, rate-limit error type, TeamClaude fleet-exhaustion 문장을 함께 요구합니다.
- 서버가 긴 reset을 반환하면 launcher parent도 오래 살아 있습니다. 이는 요청된 자동 재개 동작이며 사용자는 Ctrl-C로 중단할 수 있습니다. 기본 fleet retry budget `0`은 제한 해제까지 계속 대기하고, 양의 값은 해당 횟수에서 세션을 보존합니다.
- 장기 대기 후 다른 process가 같은 session을 수동 재개할 수 있습니다. claim 후 transcript·registry·process identity를 재확인하고, stop 뒤에는 사전 캡처한 session metadata만 사용해 registry 삭제 race에서 복구 정보를 잃지 않도록 합니다.

## Verification

- Red/green: `node --test test/claude-recovery.test.js`
- Targeted CLI: fake Claude transcript가 fleet-exhaustion을 기록한 뒤 재실행 call을 검증합니다.
- Full: 부하 게이트를 거쳐 `npm test`, `npm run lint`
- Adversarial: 현재 diff와 실행 evidence를 독립 checker가 대조합니다.
