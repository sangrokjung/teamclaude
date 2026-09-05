# TeamClaude 구독 오판·qjc-agent 세션 상한 재발 방지 runbook

## 결론

계정의 `usable:false` 또는 세션 시작 실패를 구독 연체로 단정하지 않는다. TeamClaude는
Anthropic이 반환한 구조화 코드가 정확히
`oauth_not_allowed_for_organization`일 때만 해당 OAuth 계정을
subscription-disabled 상태로 격리한다. qjc-agent는 UUID가 확인된 비첨부 유휴
세션만 2시간 뒤 자동 정리하고, 기존 개발은 새 세션을 만들기 전에 exact tmux
session 또는 canonical session UUID로 재접속한다.

이 문서는 2026-08-11 발생한 다음 두 증상의 통합 운영 SSOT다.

- 정상 구독인 `pooled-d` 계정이 연체처럼 해석되어 사용 대상에서 빠진 문제
- 메인 머신에서 `codex` 실행 시 `관리 세션 상한`과 qgate 때문에 시작이 차단된 문제

## 절대 규칙

1. 자연어 403 문구, `usable:false`, 높은 사용률만으로 연체나 구독 비활성화를
   판정하지 않는다.
2. 계정 확인에는 credential이 없는 `GET /teamclaude/status`만 사용한다. token,
   config credential, request authorization header를 출력하거나 문서에 남기지 않는다.
3. tmux session은 `attached=0`, 2시간 이상 유휴, 정확한 workspace와 transcript
   UUID의 1:1 대응을 모두 확인한 뒤에만 정리한다.
4. `qjc-agent reap-idle --dry-run` 결과를 먼저 확인하고, 그 다음에만
   `qjc-agent reap-idle --apply`를 실행한다. 활성·첨부 세션은 임의 종료하지 않는다.
5. 기존 Codex 개발을 이어갈 때는 새 세션 생성보다 exact attach를 우선한다. cwd,
   branch, canonical UUID 중 하나라도 다르면 추측해서 연결하지 않는다.

## 1. TeamClaude 구독 상태 오판 방지

### 판정 기준

subscription-disabled의 유일한 자동 격리 조건은 다음 다섯 조건의 동시 충족이다.

```text
provider=anthropic
account.type=oauth
HTTP status=403
error.type=permission_error
error.details.error_code=oauth_not_allowed_for_organization
```

자연어 메시지만 비슷한 403, malformed JSON, 일반 permission 403은 원본 그대로
전달하며 계정을 `error`로 바꾸거나 다른 계정으로 재전송하지 않는다. 코드 기준은
`src/server.js`의 `isClaudeSubscriptionAccessDisabled()`와 403 분기이며, 회귀 경계는
`test/server-403.test.js`가 고정한다.

다음 상태는 연체 증거가 아니다.

| 관찰 값 | 해석 |
| --- | --- |
| `status: active` | 계정 인증 오류로 격리되지 않음 |
| `errorReason: null` | 운영 진단 표면에 별도 오류 사유 없음 |
| `subscriptionDisabled: null` | 구조화된 subscription-disabled 판정 없음 |
| `usable: false` | 쿼터, 동시성 cap, 일시 throttle, 수동 disable 등 별도 원인 가능 |
| 5시간 사용률이 임계치 이상 | 해당 quota window가 reset될 때까지 선택 제외될 수 있음 |

`errorReason`, `subscriptionDisabled`, `usable`은 운영 대시보드가 계산해 보여줄 수
있는 진단 필드다. raw `/teamclaude/status`에서는 `status`, `enabled`, `quota`,
`inflight`, `maxConcurrent`, `rateLimitedUntil`을 기준으로 같은 원인을 구분한다.

### 시크릿 없는 확인

프록시가 실행 중인 머신에서 다음 endpoint만 조회한다.

```bash
curl -fsS http://127.0.0.1:3456/teamclaude/status | jq '{
  switchThreshold,
  accounts: [.accounts[] | {
    status, enabled, quota, inflight, maxConcurrent, rateLimitedUntil
  }]
}'
```

판정 순서는 다음과 같다.

1. 각 account row의 `status`가 `error`인지 확인한다.
2. `enabled:false`인지 확인한다.
3. 5시간·주간 quota가 `switchThreshold` 이상인지와 reset 시각을 확인한다.
4. `inflight == maxConcurrent` 또는 `rateLimitedUntil`이 미래인지 확인한다.
5. 실제 upstream 응답에 exact structured error code가 있을 때만 조직 구독 접근
   비활성화로 판정한다.

### 2026-08-11 `pooled-d` 판정 근거

사고 당시 `pooled-d` 계정은 14:01 KST까지 실제 사용 기록이 있었고, 5시간 사용률
99%, 주간 사용률 20%, 5시간 window reset은 17:20 KST였다. 이는 결제 연체가
아니라 5시간 quota 임계치 때문에 일시적으로 선택 대상에서 빠진 상태다.
`status:active`, `errorReason:null`, `subscriptionDisabled:null`도 같은 결론을
지지했다. 이 시각과 수치는 사고 증거이며 다음 장애의 고정값으로 재사용하지 않는다.

## 2. qjc-agent 세션 상한 재발 방지

### 직접 원인

UUID가 없는 레거시 Claude tmux session 4개가 유휴 정리에서 안전상 제외되었다.
해당 세션들은 2시간 이상 유휴였지만 `missing-native-session-id`라서 reaper가
종료하지 않았고, 관리 세션 상한 20개와 qgate slot을 계속 점유했다. 그 결과 메인
머신의 `codex` wrapper는 새 원격 세션 생성 전 다음 메시지로 중단됐다.

```text
관리 세션 상한 20개에 도달했습니다. 기존 세션에 재접속하거나 종료하세요.
agent session 시작 조건을 충족하지 못했습니다.
```

### 예방 장치

- 신규 Claude session은 qjc-worker가 UUID를 생성해 `--session-id`로 전달하고,
  `native_session_id`와 `canonical_session_id`를 상태에 기록한다.
- Codex session은 canonical transcript UUID와 workspace가 일치해야 저장·정리·재개
  대상이 된다.
- LaunchAgent `com.qjc.agent-session-reaper`는 5분(`StartInterval=300`)마다
  `qjc-worker reap-idle --apply`를 실행한다.
- TTL은 `QJC_WORKER_IDLE_TTL_SECONDS=7200`이다.
- reaper는 실행 직전에도 `attached=0`, session/window activity, state identity를
  다시 확인한다. 검사 중 attach나 활동이 생기면 정리하지 않는다.
- `missing-native-session-id` 또는 `missing-canonical-session-id`는 자동 삭제하지
  않는다. 이는 metadata 무결성 사고로 취급하고 exact transcript를 찾아 1:1로
  보정하거나, 백업 후 확인된 legacy session만 수동 정리한다.

LaunchAgent 자체의 필수 설정은 다음과 같다.

```text
ProgramArguments:
  /Users/imac/qjc-agent-server/bin/qjc-worker
  reap-idle
  --apply
StartInterval: 300
QJC_WORKER_IDLE_TTL_SECONDS: 7200
```

`--apply`가 없으면 기본 동작은 dry-run이므로 자동 정리가 아니다. 배포 또는 재설치
후에는 반드시 아래 명령으로 실제 launchd 인자까지 확인한다.

```bash
plutil -p ~/Library/LaunchAgents/com.qjc.agent-session-reaper.plist
launchctl print "gui/$(id -u)/com.qjc.agent-session-reaper"
```

### 안전 정리 절차

메인 머신에서는 다음 순서를 사용한다.

```bash
qjc-agent status
qjc-agent reap-idle --dry-run
qjc-agent reap-idle --apply
qjc-agent status
```

worker에서 직접 점검할 때의 동등 명령은 다음과 같다.

```bash
QJC_WORKER_IDLE_TTL_SECONDS=7200 \
  ~/qjc-agent-server/bin/qjc-worker reap-idle --dry-run
QJC_WORKER_IDLE_TTL_SECONDS=7200 \
  ~/qjc-agent-server/bin/qjc-worker reap-idle --apply
python3 ~/qjc-agent-server/bin/qgate.py status
```

`--dry-run` 후보마다 다음을 대조한다.

- tmux `attached=0`
- session/window의 마지막 활동이 7200초 이전
- session 이름의 tool과 workspace가 state의 값과 일치
- Codex는 `canonical_session_id`, Claude는 `native_session_id`가 UUID 형식
- transcript metadata의 cwd가 정확한 worker workspace와 일치
- 보존할 cmux surface나 현재 개발 branch가 해당 session을 사용하지 않음

하나라도 불일치하거나 `reason=missing-*-session-id`가 나오면 `--apply` 대상이 아니다.
활성 session을 확보하려고 일괄 `tmux kill-server`, 이름 prefix 일괄 종료, 최신 세션
추측을 사용하지 않는다.

## 3. 기존 Codex 세션 exact 재연결

먼저 저장된 route와 살아 있는 tmux session을 확인한다.

```bash
qjc-agent saved
qjc-agent status
```

살아 있는 exact tmux session이 있으면 해당 이름으로 재접속한다.

```bash
qjc-agent attach <exact-tmux-session>
```

tmux session은 없고 canonical Codex session만 저장돼 있으면 exact UUID로 재개한다.

```bash
qjc-agent resume <canonical-session-uuid>
```

cmux에서는 명령을 실행하기 전에 올바른 workspace와 surface를 선택한다. 접속 뒤
다음을 확인한다.

```bash
pwd
git branch --show-current
git status --short
```

2026-08-11 `sinsang-ax` 복구 대상은 다음과 같았다.

```text
tmux session:
  qjc-codex-sinsang-ax-19e584719e4e-0538268a-e602-42d2-8478-8dd7d0290896
branch:
  feature/customer-feedback-loop
main cmux 당시 위치:
  workspace:2 / surface:2
```

cmux 번호는 가변이므로 사고 증거로만 사용한다. 이후에는 exact tmux session 이름,
cwd, branch를 다시 확인하고 연결한다.

## 4. 장애 판정 체크리스트

### 계정 선택 이상

- [ ] `/teamclaude/status`를 credential 없이 조회했다.
- [ ] `status`, `enabled`, quota reset, concurrency, throttle을 각각 구분했다.
- [ ] `usable:false`만으로 연체라고 판단하지 않았다.
- [ ] exact `oauth_not_allowed_for_organization` 403만 계정 격리 대상으로 판정했다.
- [ ] 일반 permission 403이 계정 상태를 바꾸지 않는 테스트를 통과했다.

### Codex 시작 차단

- [ ] `managed_sessions < max`다.
- [ ] qgate가 `gate: OPEN`이다.
- [ ] LaunchAgent 인자에 `reap-idle --apply`가 있고 최근 exit code가 0이다.
- [ ] reaper TTL이 7200초, 실행 주기가 300초다.
- [ ] `reason=missing-*-session-id`가 반복되면 metadata 사고로 등록했다.
- [ ] 새 session 생성 전 `qjc-agent saved`와 exact attach 대상을 확인했다.

## 5. 완료 기준과 회귀 검증

다음 조건을 모두 충족해야 장애를 종료한다.

- TeamClaude account가 `status:active`이고 subscription-disabled 판정이 없다.
- quota로 제외된 계정은 reset 이후 다시 측정·선택 가능하다.
- `managed_sessions < max`이고 qgate가 `gate: OPEN`이다.
- 보존 대상 tmux session은 살아 있고 `attached=1`이다.
- 재연결된 Codex의 cwd와 branch가 의도한 프로젝트와 일치한다.
- LaunchAgent의 실제 인자가 `reap-idle --apply`, 주기가 300초, TTL이 7200초다.
- 다음 회귀 검증이 통과한다.

```bash
node --test test/server-403.test.js test/server-401.test.js
npx eslint src/ test/
python3 ~/qjc-agent-server/bin/qgate.py run \
  --slot heavy --label teamclaude-clean-regression -- \
  env -u TEAMCLAUDE_PROVIDER -u TEAMCLAUDE_SESSION_SUPERVISED npm test
```

전체 테스트는 qgate를 통해 실행한다. 감독 중인 TeamClaude/Codex 세션에서 실행하면
중첩 실행 방지 marker가 자식 테스트에 상속되므로 위처럼 두 marker만 제거한다.
credential이나 proxy URL은 제거하지 않는다. 테스트 완료 수는 고정값으로
문서화하지 않고 해당 실행의 pass/fail과 시각을 기록한다.

## 관련 문서

- `docs/runbooks/claude-subscription-disabled.md`
- `docs/runbooks/codex-provider-session-recovery.md`
- `docs/runbooks/cmux-renderer-session-recovery.md`
