# TeamCodex relay 502 재발 방지 runbook

## 목적

다음 오류가 발생했을 때 단일 supervisor→worker relay 연결 오류가 공유 worker
장애로 확대되지 않게 하고, 실패한 Codex 세션만 최대 한 번 안전하게 재개합니다.

```text
unexpected status 502 Bad Gateway: TeamCodex tunnel disconnected after request
dispatch; request was not replayed.
```

unsafe POST는 업스트림이 이미 접수했을 수 있으므로 프록시가 재전송하지 않습니다.
재발 시에도 HTTP replay하지 않습니다. TeamCodex CLI는 invocation nonce와 Codex session에
결속된 1회용 receipt를 소비하고, 별도 watchdog은 현재 cmux surface의 정확한 checkpoint
binding을 제출 직전까지 재검증한 뒤 세션을 이어갑니다.

## 2026-08-21 근본 원인

supervisor는 client socket별 keep-alive agent로 공유 worker에 요청을 전달합니다. 과거
코드는 한 relay 연결의 reset 또는 비동기 `EPIPE`를 worker 전체 장애의 증거로 오판해
요청 경로에서 건강한 worker를 `SIGKILL`할 수 있었습니다. 그 결과 관련 없는 진행 중
요청까지 끊기며 502가 연쇄적으로 발생했습니다.

## 코드 불변조건

1. relay request 오류는 해당 client socket의 agent만 reset합니다. 이 경로는 worker를
   kill하거나 recycle하지 않습니다. 전역 교체는 child `exit` 또는 독립적인 HTTP+IPC
   health 경로만 소유합니다 (`src/index.js:815`).
2. 일반 timeout/strike는 `workerHealthFailureThreshold`에 도달한 뒤 IPC로 재확인합니다.
   반면 connection refused/reset 또는 non-200인 `PROBE_BROKEN`은 즉시 IPC 확인으로
   이동할 수 있습니다 (`src/index.js:1152`, `src/index.js:1166`).
3. IPC pong이 오면 event loop가 살아 있다는 뜻입니다. listener만 확정적으로 깨졌다면
   `SIGTERM` 후 `workerRecycleGraceMs` 동안 drain하고, 그래도 종료하지 않을 때만
   `SIGKILL`합니다. IPC도 응답하지 않고 supervisor 자체 stall 증거도 없을 때만 즉시
   kill합니다 (`src/index.js:1098`, `src/worker-health.js:64`).
4. `child.send()` ping은 synchronous throw와 asynchronous callback error를 모두 회수해
   닫힌 IPC channel의 `EPIPE`가 unhandled error가 되지 않게 합니다
   (`src/index.js:1070`).
5. dispatch 후 unsafe POST는 재전송하지 않고 완전한 502로 종료합니다. supervisor의
   recovery receipt는 invocation nonce로 조회하고 Codex session을 담으며 한 번 소비하면
   삭제됩니다 (`src/index.js:336`, `src/index.js:351`). TeamCodex CLI는 receipt session이
   명시적 resume 대상 또는 현재 cmux session과 일치할 때만 한 번 재개합니다
   (`src/index.js:2270`, `src/index.js:2427`). 별도 watchdog은 surface·checkpoint·command
   binding과 오류 fingerprint를 제출 직전까지 재검증하고 중복 제출을 차단합니다.
6. `test/server-supervisor.test.js:237`은 첫 relay reset이 502를 반환하더라도 worker
   PID가 유지되고, 같은 worker가 다음 POST를 200으로 처리해야 통과합니다.

## 상시 감시

세 launchd interval job이 서로 다른 방어선을 담당합니다.

- `com.qjc.teamcodex-proxy-guard` (60초): status가 200이면 `inflight`와 무관하게
  healthy입니다. status가 실패해도 listener가 있으면 프로세스를 보존합니다.
- `com.qjc.codex-502-watchdog` (60초): allowlist와 정확히 일치하는 오류·빈 prompt·
  checkpoint만 최대 한 번 재개합니다. stale하거나 모호한 surface에는 보내지 않습니다.
- `com.qjc.teamcodex-runtime-deployer` (30초): 명시 승인된 source hash만 두 번의
  zero-inflight 표본 뒤 immutable artifact로 배포하며, 검증 실패 시 last-good으로
  rollback합니다.

interval job은 tick 사이에 `state = not running`일 수 있습니다. `runs`가 증가하고
`last exit code = 0`이며 최근 로그가 갱신되는지가 건강성 기준입니다. service 자체가
없으면 비정상입니다.

```bash
for label in \
  com.qjc.teamcodex-proxy-guard \
  com.qjc.codex-502-watchdog \
  com.qjc.teamcodex-runtime-deployer
do
  launchctl print "gui/$(id -u)/$label" | \
    rg 'state =|runs =|last exit code|run interval'
done

port=$(jq -r .port ~/.config/teamcodex.server.json)
curl -fsS -D - "http://127.0.0.1:${port}/teamclaude/status" -o /dev/null | \
  rg -i 'HTTP/|x-teamcodex-(active-requests|source-hash|deployment-draining)'

tail -20 ~/.codex/log/teamcodex-proxy-guard.log
tail -20 ~/.codex/log/codex-502-watchdog.log
tail -20 ~/.codex/log/teamcodex-runtime-deployer.log
```

정상 상태는 HTTP 200, rollout 외 시간의 `deployment-draining: 0`, 승인 또는
last-good receipt와 같은 source hash, guard의 `action=healthy`, 세 interval job의
exit 0입니다. deployer의 `busy`·`fence-busy`는 진행 중 요청이 끝나기를 안전하게
기다리는 상태이며, `unapproved`는 등록돼 있지만 working tree를 배포하지 않는다는
뜻입니다.

watchdog `--status` 원문에는 로컬 surface와 checkpoint 식별자가 있으므로 외부 보고에
붙여 넣지 않습니다. 필요하면 `last_scan`의 집계값만 별도로 요약합니다.

## 감시기 등록 복구

plist는 있지만 service가 없을 때만 해당 interval job을 다시 등록합니다. 로드는 새
runtime hash를 승인하지 않으며, 승인 receipt를 자동으로 만들거나 변경해서는 안 됩니다.

```bash
launchctl load ~/Library/LaunchAgents/com.qjc.teamcodex-runtime-deployer.plist
launchctl print gui/$(id -u)/com.qjc.teamcodex-runtime-deployer | \
  rg 'runs =|last exit code|run interval'
tail -1 ~/.codex/log/teamcodex-runtime-deployer.log
```

명시 승인된 disk source가 아니라면 첫 tick의 `unapproved`가 안전한 결과입니다.

## 부하 대기형 회귀 검증

전체 테스트나 relay 통합 테스트는 로컬 부하가 낮아질 때까지 `qgate`의 heavy queue에서
기다리게 합니다. detached job은 호출 세션이 끊겨도 실행되고 결과가 남습니다.

```bash
python3 ~/.claude/scripts/qgate.py run --detach --slot heavy \
  --label teamcodex-relay-regression -- \
  node --test --test-name-pattern='one reset relay socket does not SIGKILL' \
  test/server-supervisor.test.js

python3 ~/.claude/scripts/qgate.py wait TICKET --timeout 300
```

PASS 기준은 테스트 1건 성공, 첫 요청의 완전한 502, 동일 worker PID 생존, 후속
POST 200입니다. 운영 확인에서는 세 interval job의 `runs` 증가·exit 0, live HTTP
200, 현재 승인 receipt와 같은 source hash, drain 0을 별도 evidence로 캡처합니다.
승인 hash와 ticket 번호는 배포마다 바뀌므로 이 runbook의 고정 계약으로 기록하지
않습니다.

## 재발 시 대응

1. status가 200이고 worker PID가 유지되면 단일 relay 실패로 분류합니다. worker를
   재시작하거나 kill하지 말고 watchdog이 1회 제출 또는 stale 거부했는지 확인합니다.
2. status가 실패하지만 listener가 있으면 guard가 프로세스를 보존해야 합니다. HTTP·IPC
   health와 host contention을 조사하며 `kickstart -k`를 사용하지 않습니다.
3. status와 listener가 모두 없는 표본이 세 번 연속일 때만 guard의 비파괴적
   `launchctl kickstart` 경로를 허용합니다.
4. worker PID 또는 `SIGKILL` 로그가 증가하면 status header, source hash, supervisor·
   worker PID, bounded health log를 수집합니다. unapproved working tree를 실행하지 말고
   immutable last-good artifact로 rollback합니다.
5. 안전 경계 때문에 502로 끝난 요청은 수동 HTTP replay하지 않습니다. 자동 재개가
   fail-closed면 현재 cmux binding을 확인한 뒤 `teamcodex codex resume`로 정확한 세션만
   수동 재개합니다.

## 금지 사항

- unsafe POST replay 활성화
- 정상 status 200 또는 listener 존재 상태에서 강제 재시작
- 단일 relay 오류를 worker 장애로 간주한 `SIGKILL`
- 테스트·독립 검토 없이 approval hash 갱신
- watchdog의 raw checkpoint/surface 정보를 외부 보고에 포함
