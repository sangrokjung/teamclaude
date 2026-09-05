# TeamCodex relay 502 완료 게이트

## Goal

단일 supervisor→worker relay 소켓 오류가 공유 worker `SIGKILL`로 확대되는 502를 차단하고, 재발한 정확한 실패 세션만 한 번 자동 재개하며, TUI에서 `yoon` 계정을 제거한다.

## Acceptance

1. live `GET http://127.0.0.1:3457/teamclaude/status`가 HTTP 200, source hash `815c07565d581c8bd7e61fa9b83eb698b915ca950a8f9b34ed34e6e99f1a3386`, deployment drain `0`을 반환한다.
2. 180초 동안 supervisor/worker PID와 `SIGKILL`·health-kill·`EPIPE` 누적치가 증가하지 않는다.
3. relay lifecycle 회귀 6건이 단일 relay reset의 동일 worker 생존·후속 POST 200, 실제 crash/wedge 교체, host/IPC contention 오탐 방지, unsafe POST no-replay를 검증한다.
4. watchdog 50건과 실제 tick이 exact checkpoint를 1회 재개하고 후속 tick은 0회 제출한다.
5. TUI와 CLI 제거 회귀가 통과하고 실제 격리 표면에서 `yoon=0`, `alpha=1`이다.
6. 승인 hash와 last-good가 `815c075...`이며 rollback artifact `3f2079...`가 보존된다.

## Evidence

- `.omo/evidence/teamcodex-live-recovery/relay-fault-red.txt`
- `.omo/evidence/teamcodex-live-recovery/relay-fault-green.txt`
- `.omo/evidence/teamcodex-live-recovery/relay-live-runtime-green.txt`
- `.omo/evidence/teamcodex-live-recovery/relay-final-regression.txt`
- `.omo/evidence/teamcodex-live-recovery/watchdog-green.txt`
- `.omo/evidence/teamcodex-live-recovery/account-remove-green.txt`
- qgate ticket `1787284693626027000-15884`, rc=0

## Risk

운영 runtime·process lifecycle·unsafe POST replay 경계를 변경하므로 L risk로 분류한다. 실제 credential이나 고객 데이터는 포함하지 않아 data classification은 L1이다.

## Rollback

운영 검증 실패 시 content-addressed artifact `3f2079a19cd4b4b97baec6ef591809398c4fcb051cf6e6c5f668ae3160a574b0`로 exact launchd rollback한다. 현재 target 검증 완료 후에도 이 artifact는 삭제하지 않는다.
