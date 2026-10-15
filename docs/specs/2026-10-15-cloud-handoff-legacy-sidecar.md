# 실행 중인 구버전 세션의 클라우드 인계 (legacy sidecar)

- Intent: docs/intents/2026-10-15-cloud-handoff-running-sessions.md

Status: accepted
관련: `docs/specs/2026-10-14-cloud-handoff-on-exhaustion.md` (PR #66)

## 문제
PR #66의 클라우드 인계는 `teamclaude run` 감독 프로세스 안에서 동작한다. 배포 전에 시작된 감독 프로세스는 구버전 코드를 메모리에 올린 채 계속 돌고 있어서, 풀이 소진되면 여전히 로컬에서 기다린다.

## 관찰한 구버전 동작
- 풀 소진(`fleet_exhausted`)이면 감독 프로세스가 세션 lease를 잡고, 자식 claude를 멈춘 뒤 `wait(retryAfter)`(상한 7일) 한 번으로 리셋까지 잔다. 그동안 자식 프로세스는 없다.
- 깨어나면 `--resume <id> continue`로 로컬에서 재개한다.

## 제안
외부 사이드카(`teamclaude cloud-sidecar` 단발 실행 + launchd 60초 주기)가 소진 대기 중인 구버전 감독 프로세스를 찾아 PR #66과 같은 인계를 대신 수행한다.

1. `cloudFallbackOnExhaustion !== true`면 아무것도 하지 않는다.
2. 프록시 상태로 풀 소진을 판정한다. usable 계정이 0이고, 가장 빠른 복구 시각이 지금부터 10분(`CLOUD_HANDOFF_MIN_WAIT_SECONDS`) 이상 남아야 한다. 하나라도 불확실하면 아무것도 하지 않는다.
3. 대상: 배포 컷오프(설정 `cloudSidecarLegacyBefore`, ISO 시각) 이전에 시작된 `teamclaude run` 감독 프로세스 중 자식 claude 프로세스가 없는 것. 연속 2회 스캔(60초 이상) 동안 자식이 없어야 한다(다른 짧은 대기와 구분, 상태 파일에 pid+시작시각으로 기록).
4. 세션 ID는 argv의 `--session-id <uuid>` 또는 `--resume <uuid>`를 쓰고, 없으면 cmux lease 저장소에서 그 pid에 묶인 세션으로 찾는다. 찾지 못하면 건너뛴다(fail-closed).
5. cwd는 해당 pid의 cwd(`lsof`)를 쓴다.
6. 운영 모듈의 `attemptCloudHandoff`를 그대로 쓴다. 스냅샷과 시크릿 스캔, 계정 선택, 프롬프트, 원장이 PR #66과 동일하다. 연결은 다음과 같다.
   - `claimBeforeLaunch`: `claimSessionOnce`(영구 claim, rescuer 재실행 방지)
   - `beforeLaunch`: 같은 pid와 시작 시각인지, 여전히 자식이 없는지 재확인한 뒤 감독 프로세스에 SIGTERM을 보내고 종료를 확인한다. 확인하지 못하면 예외를 던져 launch-failed 경로로 간다.
   - `launchCloud`: TTY가 필요하므로 `script -q /dev/null <vendor> --cloud <prompt>`로 실행한다.
7. 결과는 원장 `~/.config/teamclaude-cloud-handoffs.jsonl`에 `source: "legacy-sidecar"`로 기록한다.
8. 한 번 실행에 인계는 최대 N건(기본 4)만 하고, 나머지는 다음 주기로 미룬다.

## Non-goals
- 새 코드로 시작한 감독 프로세스는 건드리지 않는다(스스로 처리한다).
- 소진이 아닌 상태의 세션은 절대 건드리지 않는다.

## Acceptance
- 소진이 아니거나, 기능이 꺼졌거나, 컷오프 이후 프로세스이거나, 자식이 살아 있거나, 1회 스캔만 관측됐거나, 세션 ID를 모르면 kill 0건, launch 0건.
- 조건을 모두 만족하면 claim → SIGTERM → cloud launch 순서로 실행되고 원장에 기록된다.
- claim이 거부되면 kill하지 않는다.
- 테스트: 의존성을 주입한 단위 테스트(프로세스 목록, 상태, kill, launch를 스텁).

## Verification
- `node --test test/cloud-sidecar.test.js test/cloud-handoff.test.js test/claude-recovery-cloud.test.js test/run-cloud-handoff.test.js test/secrets.test.js`: 83 pass, 0 fail (사이드카 24건).
- 사이드카 테스트가 덮는 것: 기능 꺼짐·컷오프 미설정, 소진 아님·상태 조회 실패·판정 불가, 복구 10분 미만, 컷오프 이후 프로세스, 자식 생존, 1회 관측·60초 미만, 세션 ID 없음, vendor·cwd 없음, claim 거부(kill 0·launch 0), 정상 경로(claim → SIGTERM → launch 순서, 원장 `source: "legacy-sidecar"`, 실제 `attemptCloudHandoff`·로컬 bare origin 사용), SIGTERM 전 재확인 실패 시 kill 없음·claim 해제, SIGTERM 후 생존 시 launch 없음·claim 유지, 감독당 1회 시도, 실행당 상한(기본 4·설정 2).
- 실제 seam 스모크: 임시 설정으로 `teamclaude cloud-sidecar` 실행 시 기능 꺼짐 no-op, `ps` 파싱·상태 파일 0600 기록, codex 모드 거부(exit 1). `processIsAlive`·`readProcessCwd`·`script -q /dev/null` 실행을 자기 프로세스와 `/usr/bin/true`로 확인.
- 린트: `eslint src test` 0 errors (기존 경고만).
- 적대 검증 Important 3건 반영(2026-10-16): ① 신뢰 설치 경로 정확 일치 + 대상 환경의 config realpath·provider 일치(읽기 실패 시 제외, snapshot·push 전), ② SIGTERM 직전 상태 재조회로 소진·600초 재평가(회복·조회 실패 시 kill 없이 `CloudHandoffNotStopped` → claim 해제), ③ argv를 absent/valid/ambiguous/forked로 구분해 absent만 저장소 fallback. 회귀 5개 파일 93 pass, 0 fail.
- 2차 적대 검증 Important 2건 반영(2026-10-16): ① `ps -wwE` 환경에서 판정 키는 토큰 경계에 정확히 한 번, 값 다음 토큰은 끝 또는 `NAME=` 형태일 때만 인정(공백 경로·다른 값 안의 `KEY=` 제외), ② 최종 확인을 SIGSTOP 울타리 안에서 수행(STOP → 목록 재확인 → TERM → CONT, 실패 시 STOP → CONT·claim 해제, CONT는 finally). 회귀 5개 파일 100 pass, 0 fail.
