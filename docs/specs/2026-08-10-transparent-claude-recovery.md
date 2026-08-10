# Transparent Claude recovery

## Problem

TeamClaude의 Claude recovery는 `teamclaude run`이 Claude Code의 부모 프로세스일
때만 동작한다. 사용자가 평소처럼 `claude`를 실행하거나, wrapper 적용 전에 시작된
`qjc-worker` 세션을 계속 사용하면 벤더 Claude 바이너리가 직접 실행되어 transcript
감시, account rotation, timeout reopen을 모두 우회한다.

현재 관찰된 증상은 다음 세 종류다.

1. `You're out of usage credits ... Fable 5`
2. `claude-sonnet-5 is temporarily unavailable, so auto mode cannot determine the safety of Bash`
3. `Request timed out`

첫 번째와 세 번째는 launcher recovery 경로가 이미 존재하지만 우회된 세션에는
적용되지 않는다. 두 번째는 API terminal error가 아니라 transcript의
`toolDenialKind=automode-unavailable` tool-result이므로 현재 API-error classifier가
분류하지 않는다.

## Goal

- 사용자는 interactive shell, `qjc-worker`, 자동화에서 평소처럼 `claude`만 실행한다.
- 모든 새 Claude 프로세스는 한 개의 TeamClaude recovery launcher를 거친다.
- 기존 session ID와 transcript를 보존한 채 usage-credit, timeout, 일시적 safety
  classifier 장애에서 bounded recovery를 수행한다.
- ambiguous dispatch나 unsafe tool을 자동으로 중복 실행하지 않는다.
- worker와 main PC에 같은 설치·검증 절차를 적용하고 운영 runbook을 남긴다.

## Non-goals

- source Claude 설정인 `.claude/`, `.claude.json`, `.mcp.json`을 수정하지 않는다.
- 이미 실행 중인 프로세스의 부모를 런타임에 바꾸지 않는다. 기존 legacy 세션은 같은
  session ID로 launcher 아래에 한 번 재개해야 한다.
- safety classifier가 실패했다고 Bash를 자동 승인하거나 permission mode를 낮추지
  않는다.
- post-dispatch 502, connection reset, timeout에서 원본 unsafe POST나 마지막 tool을
  proxy 내부에서 replay하지 않는다.
- 무제한 재시도, 무제한 account rotation, 무제한 session reopen을 허용하지 않는다.

## Considered approaches

### A. 단일 transparent launcher + 명시적 vendor binary (선택)

PATH와 `qjc-worker`가 같은 launcher를 호출하고, launcher가
`TEAMCLAUDE_CLAUDE_BIN`으로 실제 vendor binary를 명시한다. interactive alias,
절대경로 실행, worker 세션이 같은 복구 계약을 공유한다. 재귀를 구조적으로 막고 실제
E2E 검증이 가능하다.

### B. shell alias/function만 유지

interactive zsh에서는 간단하지만 non-interactive shell, launchd, `qjc-worker`의
절대경로 실행이 우회한다. 현재 장애를 재발시키므로 기각한다.

### C. `/opt/homebrew/bin/claude` wrapper만 유지

`~/.local/bin`이 PATH 앞에 있거나 자동화가 vendor 절대경로를 사용하면 우회한다.
현재 PATH와 맞지 않아 기각한다.

## Architecture

### 1. Entrypoint contract

모든 관리 대상 진입점은 checked wrapper 하나를 호출한다.

```text
user / qjc-worker / automation
              │
              ▼
       transparent `claude`
              │
              ▼
        `teamclaude run`
              │
              ▼
    `runClaudeWithRecovery()`
              │
              ▼
       explicit vendor binary
```

Wrapper는 인자를 byte-for-byte 배열로 전달하고 `exec`로 launcher에 제어권을
넘긴다. `--help`, `--version`, `--resume`, `--session-id`, `--settings`, `-p`를
특별히 재해석하지 않는다. launcher는 child exit code와 signal을 호출자에게 그대로
전달한다.

`TEAMCLAUDE_CLAUDE_BIN`은 wrapper 자신이나 PATH의 `claude`가 아니라 관리되는
`claude-vendor` shim을 가리킨다. shim은 실행할 때마다
`~/.local/share/claude/versions/*` 중 최신 실행 가능한 native binary를 semantic version
순서로 고르므로 vendor 업데이트 뒤 wrapper 재설치가 필요 없다. wrapper·shim·native가
같은 realpath를 가리키거나 대상이 실행 불가능하거나 symlink loop이면 fail-closed하고
재귀하지 않는다. 운영 비상 우회는 이 shim 이름으로만 제공한다.

### 2. New sessions and legacy sessions

새 interactive shell, 새 `qjc-worker agent-session claude`, 새 자동화는 모두
transparent launcher를 사용한다. qjc-worker가 이미 공용 wrapper를 호출하는 현재
구조는 유지하되 wrapper가 fixed port를 선행 probe해 정상 동적 port를 차단하지
않도록 TeamClaude의 `ensureProxyRunning`/`findRunningServer`를 SSOT로 사용한다.

이미 실행 중인 direct-vendor 세션은 부모 프로세스를 바꿀 수 없다. 해당 세션이 종료
또는 terminal error에 도달하면 저장된 exact session ID를 사용해 launcher 아래에서
한 번만 `--resume <id>`로 재개한다. session ID를 추측하거나 최신 transcript를 대신
선택하지 않는다.

### 3. Error recovery

#### Usage credits

구조화된 API-error record와 관찰된 전체 정규화 메시지에서만 usage-credit exact
recovery class를 분류한다. 사용자 prompt나 부분 문자열은 분류하지 않는다. launcher는
현재 child를 중지하고 proxy가 준비된 뒤 이전·현재 account UUID가 모두 유효하며 실제로
달라진 경우에만 같은 session을 `continue`로 재개한다. 계정 이름만 달라진 것은 회전
성공이 아니다. Fable model-scoped exhaustion은
proxy의 `modelFallbacks`에서 먼저 같은 request의 완결된 429 계약에 따라 처리하고,
CLI의 local subscription credit gate는 launcher의 account rotation으로 처리한다.
같은 account로의 눈속임 재시작은 금지한다.

#### Request timeout

구조화된 `server_error`와 관찰된 전체 정규화 `Request timed out` record만 timeout으로
분류한다. 사용자 prompt나 메시지 내부의 부분 문자열은 분류하지 않는다. dispatch
결과가 불확실하므로 `--resume <id>`로 UI-only reopen하고 `continue`나 원본 prompt를
자동 전송하지 않는다. 일반 retry budget을 적용한다.

#### Safety classifier unavailable

`type=user`, error tool-result, `toolDenialKind=automode-unavailable`의 구조화된 필드를
우선 사용하고 알려진 문구는 보조 조건으로만 확인한다. 이것은 실제 Bash 실행 실패가
아니라 실행 전 safety classification 거부이므로 account나 일반 quota 상태를
오염시키지 않는다.

Launcher는 해당 record만으로 Claude child를 즉시 죽이지 않는다. Claude가 읽기 전용
작업으로 계속 진행하거나 이후 정상 assistant/user record를 쓰면 해결된 것으로
간주한다. terminal stop과 함께 unresolved denial이 남은 경우에만 bounded backoff 후
같은 session에 안전한 continuation을 한 번 요청한다. continuation은 실패한 Bash를
자동 승인·재실행하라는 지시가 아니라 읽기 전용 작업을 계속하고 classifier가 회복된
뒤 필요한 tool을 다시 판단하라는 지시다. 반복 denial은 전용 budget 소진 후 자동
재시도를 멈추고 session과 transcript를 보존한다.

### 4. Safety boundaries

- Proxy가 받은 unsafe POST의 ambiguous network/5xx 결과는 내부 replay하지 않는다.
- exact completed 429/403처럼 upstream이 실행을 거부했다고 증명된 경우만 기존
  failover 계약을 유지한다.
- `automode-unavailable`은 permission bypass, model 강제 변경, Bash 자동 승인의
  근거가 아니다.
- classifier와 launcher는 ANSI escape, 줄바꿈, 표시용 model suffix를 정규화하되
  구조화된 record type과 denial kind가 맞지 않으면 동작하지 않는다.
- recovery 횟수는 오류 종류별 bounded budget을 적용하고 정상 transcript가 뒤따르면
  stale error를 재처리하지 않는다.

## Test design

### Unit and integration

- plain `claude`가 launcher를 정확히 한 번 호출하고 vendor가 정확히 한 번 spawn된다.
- wrapper와 vendor가 같은 경로면 exit 75/구체적 오류로 종료하며 recursion 0회다.
- argv의 공백, glob, JSON settings, `--`, `--resume`, `-p`가 변형 없이 전달된다.
- child exit code와 SIGINT/SIGTERM이 호출자에게 보존된다.
- usage-credit의 `Fable 5`, ANSI, 줄바꿈 변형은 분류하고 일반 사용자 문장은 오탐하지
  않는다.
- timeout은 UI-only reopen하며 원본 prompt와 `continue`를 보내지 않는다.
- `automode-unavailable` exact tool denial은 terminal unresolved 상태에서만 한 번
  continuation하고, 정상 후속 record·다른 tool error·사용자 문구는 무시한다.
- persistent denial과 timeout은 budget을 넘지 않는다.
- proxy의 unsafe POST upstream hit는 항상 1회다.

### Real-path E2E

- `zsh -ic`, `zsh -lc`, qjc-worker 격리 harness에서 `claude`의 parent chain에
  `teamclaude run`이 존재하고 `TEAMCLAUDE_SESSION_SUPERVISED=1`이다.
- 실제 PATH의 첫 `claude`, `/opt/homebrew/bin/claude`, qjc-worker wrapper가 같은
  launcher contract를 만족한다.
- synthetic transcript에서 attempt-1/attempt-2 marker와 session ID를 측정해 중복
  request, session drift, 무한 reopen이 없음을 확인한다.
- worker 검증 후 main PC에서 동일 checksum, wrapper resolution, proxy status,
  synthetic error E2E를 다시 실행한다.

### Adversarial review gates

1. 복구 classifier near-miss와 ANSI/split-write/stale-offset 공격 검토
2. argv injection, symlink swap, wrapper recursion, secret 출력 검토
3. unsafe request replay와 Bash permission bypass 0회 검토
4. 전체 test, targeted test, ESLint, `git diff --check`
5. 실제 machine parent-chain과 동일-session marker 증거

## Rollout

1. TDD로 wrapper/launcher test를 먼저 실패시킨다.
2. TeamClaude launcher와 공용 wrapper를 최소 수정한다.
3. worker의 새 격리 session에서 실제-path E2E를 통과시킨다.
4. 실행 중인 legacy session 목록과 exact session ID를 기록하고, 각 세션은 종료 시
   또는 현재 terminal failure에서 launcher 아래로 한 번 재개한다.
5. main PC에 같은 파일 checksum을 배포하고 새 shell 및 qjc-worker E2E를 통과시킨다.
6. README와 incident runbook의 수동 `teamclaude run` 지시를 평상시 `claude`, 진단용
   `teamclaude run`, 비상 우회 `claude-vendor`로 구분한다.

## Rollback

- 공용 wrapper를 직전 백업으로 원자 복원하고 shell command cache를 초기화한다.
- vendor binary와 session transcript는 이동·삭제하지 않는다.
- safety-denial recovery는 별도 budget을 0으로 설정해 즉시 끌 수 있게 한다.
- schema/data migration은 없다.

## Observability

- launcher 시작 시 비민감 debug mode에서만 launcher/vendor resolved path와 supervision
  여부를 출력한다.
- recovery log에는 kind, session ID, attempt/budget, account 변경 확인 여부만 남기고
  credential, prompt, tool input은 남기지 않는다.
- runbook은 `ps` parent chain, TeamClaude status, transcript structured fields,
  wrapper checksum을 재발 판정의 네 가지 증거로 사용한다.

## Decision

단일 transparent launcher를 모든 관리 대상 Claude 진입점에 적용한다. usage-credit와
timeout의 기존 복구 코드는 유지하되 plain/worker 우회를 제거하고,
`automode-unavailable`은 permission을 낮추지 않는 별도 bounded recovery로 추가한다.
