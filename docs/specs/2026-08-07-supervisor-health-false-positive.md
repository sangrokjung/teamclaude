# 슈퍼바이저 헬스체크 오탐으로 인한 502 (Proxy worker failed after dispatch)

상태: 근본 원인 확정(실측), 구현 완료. 2026-08-21 후속 조사에서 단일 relay 오류의 즉시 SIGKILL 경로를 추가 차단 중.

## Problem

Claude Code가 `API Error: 502 Proxy worker failed after dispatch; request was not replayed`로 턴을 잃는다.

실측(2026-08-07, 실가동 데몬 `~/.claude/logs/teamclaude-daemon.err.log`):

| 신호 | 값 |
|---|---|
| 최근 5,000줄 내 워커 종료 사유 | `SIGKILL` 198건, 자체 크래시 0건 |
| 로그 전체 `failed 2 health checks; restarting it.` | 301건 |
| 로그 전체 워커 종료 | SIGKILL 666 / exit 1 915 / exit 0 1 |
| `exit 1`(config 절단 크래시) 마지막 발생 | 라인 23709 (총 44,589줄). 2026-07-27 원자적 쓰기 수정으로 종결 |
| 헬스 프로브 경로 지연 (부하 load1 25~35, 180샘플) | p50 8ms / p90 191ms / **p99 1,438ms / max 1,635ms** |
| 현행 판정 기준 | 타임아웃 2,000ms × 연속 2회 (간격 5,000ms) |

즉 **현재 살아 있는 실패 모드는 100% 슈퍼바이저가 자기 워커를 죽인 것**이며, 워커가 스스로 죽은 사례는 최근 구간에 하나도 없다. 재기동 직후 트래픽을 거의 처리하지 않은 새 워커도 곧바로 다시 SIGKILL된다(out.log 배너 연속 3회). 멈춘(wedged) 워커일 수 없다.

원인 사슬:

1. 슈퍼바이저는 공개 포트를 소유하고 **모든 SSE 바이트 릴레이와 모든 요청 바디 버퍼링을 같은 이벤트 루프에서** 처리한다.
2. 호스트 과부하(load1 25~37 / 16코어, 메모리 압력)에서 그 루프가 수백 ms~수 초 멈춘다.
3. 헬스 프로브의 2초 타임아웃 타이머도 **같은 멈춘 루프**에 있다. 루프가 풀리는 순간 타이머가 먼저 발화해, 워커가 이미 응답을 보냈는지와 무관하게 실패로 기록된다. 얼어붙은 판사가 피고를 유죄로 만든다.
4. 연속 2회면 `SIGKILL`. 유예 없음.
5. SIGKILL은 그 워커의 **모든 in-flight 요청**을 즉사시킨다.
6. `forwardToWorker`의 재전송 조건은 `replaySafe = GET|HEAD|OPTIONS`뿐이라 `POST /v1/messages`는 재전송되지 않는다 → 클라이언트에 502.

증폭 요인:

- `continuityMode: true` + 계정 소진 상태에서 요청이 워커 안에 **1초 폴링으로 장시간 주차**된다(`No eligible capacity` 대기 스팸). 죽는 순간 다수 턴이 동시에 사라진다.
- `maxConcurrentPerAccount: 1` × 15계정 → admission capacity 271. 한 번의 SIGKILL이 최대 271건을 파괴한다.
- p99 1.44초는 2초 한도 바로 아래다. 여유가 없다.

### 두 번째 원인: 셸 래퍼가 데몬을 강제 종료한다

`~/.zshrc`의 `claude()` 래퍼는 실행 직전 프록시를 `curl --connect-timeout 1 --max-time 1`로 1회 확인하고, 실패하면 `launchctl kickstart -k`로 **데몬 전체를 SIGKILL 후 재기동**했다. 같은 실측(p99 1.44s)에서 정상 프록시가 1초를 넘기므로, 새 `claude` 세션 하나가 살아 있는 프록시를 죽인다. 종료 경로에 로그가 없어 out.log에는 재기동 배너만 남는다(누적 3,356회, 12:03~12:11에는 launchd `ThrottleInterval`(30s) 주기로 연속 재기동).

슈퍼바이저 헬스체크와 정확히 같은 오류다. 부하 걸린 호스트에서 1~2초 타임아웃을 생존 판정으로 쓴 것. 처방도 같다: 단발 프로브로 죽이지 않고, 3회(각 4초) 재시도를 모두 놓쳤을 때만 다운으로 판정한다. 가드의 목적(프록시 다운 시 Claude 직결 차단)은 유지된다.

## Goal

1. 슈퍼바이저가 **건강한 워커를 죽이지 않는다**. 자기 루프가 멈춰 얻은 프로브 결과로 유죄 판정하지 않는다.
2. 진짜로 멈춘(wedged) 워커는 지금처럼 복구한다. 기존 SIGSTOP 회귀 테스트를 그대로 통과한다.
3. 워커 교체가 불가피할 때 unsafe in-flight 요청의 불확실성을 숨기지 않는다. 이미 업스트림이 접수했을 수 있는 POST는 재전송하지 않고 완전한 502로 종료한다.
4. 판정 임계값에 실측 기반 여유를 준다.
5. 502로 종료된 Codex CLI 작업은 서버 replay가 아니라 current-surface exact-session 복구로 이어질 수 있다. 계약은 `docs/specs/2026-07-31-codex-exact-session-resume.md`가 소유한다.

## Non-goals

- 계정 소진(quota) 자체 해결, `continuityMode`/`maxConcurrentPerAccount` 운영값 변경.
- 호스트 부하 관리(qgate·세션 수)는 별개 축이다.
- 슈퍼바이저를 멀티 워커로 확장.
- 무의존성·ESM·Node 18+ 제약 완화(불변).

## Requirements

1. **자기 멈춤 할인**: 슈퍼바이저는 자기 이벤트 루프 정체를 측정한다. 프로브 구간 중 자기 정체가 `max(250ms, timeout/2)` 이상이면 그 실패는 **무효(inconclusive)**로 처리한다. strike도 아니고 성공 리셋도 아니다.
2. **IPC 교차 확인**: 임계 도달 시 워커에 IPC ping을 보낸다. pong이 오면 워커 이벤트 루프는 살아 있으므로 **죽이지 않는다**(호스트 경합). IPC timeout도 supervisor 이벤트 루프가 소유하므로 ping 구간의 자기 정체가 `max(250ms, timeout/2)` 이상이면 pong 미관측을 **무효(inconclusive)**로 처리한다. 자기 정체가 없고 pong도 없을 때만 wedged로 보고 SIGKILL한다.
3. **치명 오류 구분**: 프로브가 타임아웃이 아니라 연결 거부/리셋(`ECONNREFUSED`/`ECONNRESET`/`EPIPE` 등) 또는 200이 아닌 상태코드로 실패하면 리스너가 실제로 깨진 것이다. 이때는 IPC가 살아 있어도 교체하되, 루프가 살아 있으므로 **SIGTERM 유예 배수(`workerRecycleGraceMs`, 기본 5,000ms) 후 SIGKILL**로 드레인한다.
4. **임계값 여유**: `workerHealthTimeoutMs` 기본 2,000 → 5,000, `workerHealthFailureThreshold` 기본 2 → 3. 설정으로 override 가능하다(테스트가 사용). 하한은 1ms까지 허용해 테스트가 확정적 타임아웃을 만들 수 있게 한다.
5. **unsafe 요청 무재전송**: 워커 연결이 성립한 뒤 사망했다면 슈퍼바이저는 업스트림 접수 여부를 증명할 수 없다. `POST /v1/messages`는 설정값과 관계없이 재전송하지 않고 `Request was not replayed`를 포함한 완전한 502를 반환한다. 과거 설정의 `replayOnWorkerDeath`는 안전 경계를 바꾸지 않는 무효 값으로 취급한다.
6. 판정 로직은 순수 함수로 분리해 결정론적으로 단위 테스트한다(`src/worker-health.js`).
7. 기존 계약 유지: 공개 리스너는 사라지지 않는다, SSE 중간 사망은 `overloaded_error` 주입으로 종료, 클라이언트 abort(`clientGone`)는 워커를 재활용하지 않는다.
8. **런타임 드리프트 차단**: status 응답은 supervisor가 실제 로드한 source SHA-256, active public request 수, deployment-draining 상태를 내부 운영 헤더로 제공한다. 배포 감시기는 승인 파일의 hash와 현재 source가 정확히 일치하고, active request가 연속 두 번(legacy 헤더 부재 런타임은 세 번) 0일 때만 후보를 만든다. 마지막 표본 뒤에는 live lifecycle ID가 일치하는 local-only drain control로 신규 admission을 먼저 막고 그 응답의 active count가 0일 때만 bootout한다. drain은 기본 15초 lease 뒤 자동 해제되어 deployer 사망이 영구 503을 만들지 않는다. 최초 legacy 전환은 동일 PID/argv만 20초 뒤 `SIGCONT`하는 detached guard를 먼저 띄우고 supervisor를 `SIGSTOP`한 뒤 established public connection 0을 재검증한다. 경쟁 연결이 있으면 즉시 `SIGCONT`하고 다음 주기로 미룬다.
9. **불변 artifact와 rollback**: 승인 hash와 일치하는 `src/*.js`는 content-addressed read-only artifact로 원자 복사하고, `package.json`은 고정된 최소 ES module metadata만 생성한다. artifact 트리의 symlink, 비정규 파일, 다른 소유자를 거부하고 target과 rollback을 launch 직전에 다시 검증한다. launchd bootout/bootstrap의 timeout·OS 오류·비정상 종료는 모두 rollback 분기로 들어가며, rollback 건강성까지 확인한다. 복사 중 source나 package identity가 달라져도 중단한다.
10. **최초 배포와 실패 잠금**: 승인 receipt는 현재 사용자 소유의 group/other 권한 없는 regular file만 `O_NOFOLLOW`로 읽는다. 최초 legacy 배포는 전역 `teamcodex@1.3.3`의 name/version/type/bin과 고정 bundle hash가 모두 일치할 때만 immutable last-good artifact를 seed한다. 이 pinned rollback만 source-hash 헤더 부재를 허용한다. target 또는 rollback 검증이 실패하면 모든 경로에서 동일 승인 hash를 `rollout-failed`로 잠근다. source가 다른 값으로 왕복해도 잠금은 유지되고, 승인 파일 제거가 한 deployer 주기에 실제 관측된 뒤 다시 기록된 경우에만 해제한다. 임의의 미승인 source 변경은 자동 배포하지 않는다.
11. **단일 relay 오류는 worker 사망 증거가 아니다**: supervisor→worker의 한 HTTP 요청에서 `ECONNRESET`/`EPIPE`가 발생해도 살아 있는 공유 worker를 요청 경로가 직접 SIGKILL하거나 global ready 상태에서 제외하지 않는다. 해당 연결의 keep-alive agent만 폐기하고, 프로세스/리스너 교체는 worker `exit` 이벤트 또는 1~3번의 health+IPC 교차 확인 경로만 소유한다. dispatch 전 unsafe POST는 기존 bounded retry가 가능하고, dispatch 후 unsafe POST는 기존대로 재전송하지 않는다. IPC ping 전송 오류는 callback으로 회수해 이미 시작된 child의 spawn-error handler를 소비하거나 supervisor의 unhandled `error`가 되지 않게 한다.

## Trade-off (명시)

슈퍼바이저는 "워커가 업스트림 호출 전에 죽었다"와 "업스트림이 이미 받았는데 응답만 유실됐다"를 구분할 수 없다. 후자를 재전송하면 쿼터를 두 번 쓰고 업스트림 호출이 중복된다. 이 불확실성은 `test/supervisor-midstream.test.js`의 "an upstream-accepted POST must never be replayed internally"로 고정된 계약이므로 설정으로도 뒤집지 않는다.

대신 근본 원인(오탐 kill) 제거로 워커 사망 자체를 줄이는 것이 1차 처방이다. 진짜 사망 뒤 사용자 작업 복구는 요청 replay가 아니라 Codex가 이미 기록한 current-surface exact checkpoint를 새 프로세스로 여는 2차 처방이다. 이 경계는 upstream 중복 inference와 다른 session 오재개를 동시에 피한다.

## Verification

- `node --test` 전체 통과.
- 신규 단위 테스트: 자기 멈춤 할인 / IPC 교차 확인 / IPC timeout 자기 정체 무효화 / 치명 오류 구분 판정표.
- 신규 통합 테스트: ① 건강하지만 프로브가 반드시 타임아웃하는 워커는 교체되지 않는다 ② supervisor가 IPC ping 뒤 `SIGSTOP`되어 timer가 overdue여도 이미 pong한 worker PID가 유지된다 ③ in-flight POST 중 워커 SIGKILL 시 클라이언트는 완전한 502를 받고 upstream hit는 1회다 ④ lifecycle-bound deployment drain이 신규 POST를 worker로 보내지 않는다.
- 기존 통합 테스트 유지: SIGSTOP으로 멈춘 워커는 여전히 교체된다.
- 신규 통합 테스트: supervisor의 worker-bound HTTP 요청 하나만 `ECONNRESET`으로 실패시켜도 worker PID가 유지되고 다음 status/request가 같은 worker에서 성공한다. old code는 이 시나리오에서 worker를 SIGKILL해 RED여야 한다.
- 실가동: 현재 source로 데몬을 재기동한 뒤 구형 `failed 2 health checks` 문구가 사라지고, 고부하 오탐 시 `host contention` 보호 분기가 관찰되는지 확인한다.
- 배포 안전: `test_teamcodex_runtime_deployer.py` 32건이 busy reset, source-change reset, legacy 3-sample, admission fence와 detached unfreeze guard, fence-release probe timeout/PID transition, owner-only approval receipt, unapproved fail-closed, pinned 1.3.3 bootstrap, symlink 없는 immutable artifact, source/package/launch TOCTOU 차단, launchctl 예외 rollback, exact launchd argv, 모든 실패 경로의 hash 잠금을 검증한다.
