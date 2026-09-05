# 슈퍼바이저 헬스체크 오탐 수정 실행 계획

스펙: `docs/specs/2026-08-07-supervisor-health-false-positive.md`

## Tasks

1. [x] `src/worker-health.js` 신설: 순수 판정 함수 2종.
   - `healthProbeVerdict({ ok, fatal, selfStallMs, timeoutMs })` → `'healthy' | 'inconclusive' | 'strike' | 'broken'`
   - `unhealthyWorkerAction({ broken, ipcAlive, selfStallMs, timeoutMs })` → `'keep' | 'drain' | 'kill'`
   - `createLoopStallMeter({ tickMs })` (슈퍼바이저 자기 이벤트 루프 정체 누적기)
2. [x] `test/worker-health.test.js` (RED 먼저): 판정표 전수 + 정체 누적기 동작.
3. [x] `src/index.js` 슈퍼바이저 배선.
   - 기본값 조정(`workerHealthTimeoutMs` 5000, `workerHealthFailureThreshold` 3, 하한 1ms), 신규 `workerRecycleGraceMs`(5000)·`workerPingTimeoutMs`(min 500ms).
   - 루프 정체 계측기 기동 및 `finish()`에서 정리.
   - `checkWorkerHealth`가 `healthProbeVerdict`를 사용하고, 실패 원인(타임아웃 vs 연결 거부 vs 비200)을 구분해 전달.
   - 임계 도달 시 `pingWorker()` IPC 왕복 후 `unhealthyWorkerAction`으로 keep/drain/kill 분기. drain은 SIGTERM 후 유예 만료 시 SIGKILL.
4. [x] `src/index.js` 워커 배선: `teamcodex:ping` 수신 시 `teamcodex:pong` 응답. 슈퍼바이저는 `teamcodex:pong`을 대기자에 매칭.
5. [x] `forwardToWorker`의 unsafe POST **무재전송** 계약 유지. `test/supervisor-midstream.test.js`가 '업스트림이 받은 POST는 재전송 금지'를 고정하고 있고, 슈퍼바이저는 미발사와 응답유실을 구분할 수 없다. 과거 `replayOnWorkerDeath` 설정이 true여도 이 경계를 바꾸지 않는다.
6. [x] `test/server-supervisor.test.js` 통합 테스트 2건 추가(둘 다 구코드에서 RED 실증).
   - 슈퍼바이저 자체를 SIGSTOP으로 1.5초 정지 → 자기 정지 중 만료된 프로브로 워커를 죽이지 않는다(구코드: pid 교체됨).
   - `replayOnWorkerDeath: true`가 남아 있어도 in-flight POST 중 워커 SIGKILL → upstream 1회 + 클라이언트 완전한 502.
7. [x] 기존 SIGSTOP 통합 테스트 통과 확인(진짜 wedged는 여전히 교체).
8. [ ] `node --test` 전체 + `npx eslint src/` 통과. 부하 게이트 queue에 등록하며 targeted suite는 먼저 통과했다.
9. [ ] `CLAUDE.md` 아키텍처 문서 갱신(헬스체크·재전송 계약). 현재 다른 동시 세션이 파일 리스를 보유해 adversarial-review-gate가 편집을 `scope-conflict`로 차단한다. 리스 해제 후 적용.
10. [ ] 승인 hash를 기록한 뒤 zero-inflight 자동 배포 및 실가동 관측(구형 `failed 2 health checks` 제거, 헬스 실패·SIGKILL 증가율). `com.qjc.teamcodex-runtime-deployer`는 active request가 있거나 source hash가 미승인이면 fail-closed한다.
11. [ ] maker≠checker 독립 적대 검토.
12. [x] `~/.zshrc` `claude()` 래퍼의 1초 단발 프로브 → 3회 재시도로 교정(백업 `~/.zshrc.bak-teamclaude-probe-*`, `zsh -n` 통과, 살아있는 포트 up=1 / 죽은 포트 up=0 실측).
13. [x] supervisor status에 `x-teamcodex-active-requests`와 `x-teamcodex-source-hash`를 추가하고, 승인 hash의 immutable artifact만 zero-inflight에 배포하며 실패 시 직전 artifact로 rollback하는 launchd 감시기와 회귀 test를 추가했다. 최초 legacy 런타임은 검증된 전역 `teamcodex@1.3.3`을 pinned last-good으로 seed하고, 실패한 승인 hash는 재승인 전 자동 재시도하지 않는다.
14. [x] IPC corroboration 자체의 supervisor-stall 반례를 RED→GREEN으로 고정했다. ping 뒤 worker pong이 queue된 상태에서 supervisor timer가 overdue여도 worker PID를 유지한다.
15. [x] 마지막 zero-inflight 표본과 bootout 사이를 lifecycle-bound deployment drain으로 봉쇄했다. legacy 최초 전환은 `SIGSTOP` 후 connection 0 재검증으로 fail-closed한다.
16. [x] launchctl timeout/OSError가 rollback을 건너뛰지 않게 하고, artifact symlink·비정규 path·launch 직전 변조를 거부하며, 모든 rollout 예외에 failed hash를 영속화했다.
17. [x] deployer 사망이 drain 또는 SIGSTOP을 남기지 않도록 supervisor drain lease와 detached identity-bound legacy SIGCONT guard를 추가했다.
18. [x] approval receipt를 owner-only regular file과 `O_NOFOLLOW` open으로 제한해 symlink 또는 group-readable 승인 위조를 fail-closed했다.
19. [x] fence release의 launchd/ps identity probe가 timeout되어도 cleanup 예외를 전파하지 않고 lease 또는 detached guard가 복구하도록 고정했다.
20. [x] launchd PID가 새 runtime으로 바뀌어도 old frozen PID의 guard를 취소하지 않고 identity check 시점까지 유지한다.

## 2026-08-13 ULW verification

- `node --test test/worker-health.test.js`: 11 pass.
- supervisor targeted 7건: HTTP self-stall keep, IPC self-stall keep, unsafe POST no replay, nonce/session receipt once, active/hash headers, deployment drain, inherited Codex provider 모두 pass.
- `node --test test/codex-run.test.js`: exact-session recovery 13 pass.
- watchdog: 24 pass. global `ps` timeout을 제거하고 cmux stable UUID/resume binding으로 19개 후보를 0.75초에 dry-run했으며, 개별 inspect timeout 1개는 입력 없이 해당 surface에만 격리됐다.
- runtime deployer: 32 pass. admission fence와 unfreeze guard, fence-release timeout/PID transition, owner-only approval receipt, pinned legacy bootstrap, 최소 module metadata, source/package/launch TOCTOU, symlink 거부, launchctl 예외 rollback, 모든 실패 경로의 동일 hash 재시도 차단을 포함한다.

## Out of scope

계정 쿼터 소진, 호스트 부하(qgate), `continuityMode` 운영값, 멀티 워커.

## Rollback

`src/worker-health.js` 삭제 및 `src/index.js` 되돌림으로 원복. 설정만으로 즉시 완화하려면
`~/.config/teamclaude.json`에 `"workerHealthTimeoutMs": 5000, "workerHealthFailureThreshold": 3`,
`replayOnWorkerDeath`는 현재 unsafe POST 계약을 바꾸지 않으므로 rollback 수단이 아니다. 작업 복구는 linked Codex exact-session spec의 bounded CLI recovery만 비활성화한다.
