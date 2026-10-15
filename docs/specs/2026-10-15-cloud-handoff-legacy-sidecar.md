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
- 3차 적대 검증 Important 4건 반영(2026-10-16), `ps`의 공백 이어 붙인 문자열에서 argv·env 경계를 추측하던 부분을 없앴다.
  - 세션·대상 선정: 구버전 코드(PR #66 이전 `dbce9e1`과 현재 배포본 모두)의 fleet_exhausted 경로는 `acquireFleetRecoveryClaim` → `claimSessionLease(storePath, sessionId)`로 감독 자신의 pid·processStartSeconds lease를 잡은 채 `wait`한다(cmux 환경, `CMUX_SURFACE_ID` 있을 때). 그래서 세션 ID는 그 감독이 보유한 단 하나의 lease 파일명으로 정한다. argv와 hook sessions json은 쓰지 않는다. lease가 없는(비 cmux) 감독이나 lease가 2개 이상인 감독은 제외한다(의도된 fail-closed). 감독이 살아 있는 동안 rescuer는 lease를 잡지 못하고, sidecar의 영구 claim은 어떤 신호보다 먼저 생긴다.
  - 풀 소속: 값을 추출하지 않고 "없음"만 증명한다(`provesDefaultPool`). 원래 지시는 `TEAMCLAUDE_PROVIDER=`가 있으면 제외였지만, 실측 결과 운영 감독 95개 모두 `TEAMCLAUDE_PROVIDER=anthropic`을 갖고 있어 그대로 두면 대상이 0개가 된다. 그래서 이 키가 정확히 한 번, 공백 바로 뒤에, 값이 정확히 `anthropic`이고 그 뒤가 공백이나 끝일 때만 허용한다. 풀을 바꾸는 값은 정확히 `codex` 하나뿐이고 `anthropic`으로 시작하는 텍스트는 그 값이 될 수 없으므로 안전하다. sidecar 자신도 config 재정의가 있으면 no-op이다.
  - 마지막 확인: 상태 재조회 → 동기 ps 확인 → 즉시 SIGSTOP → 멈춘 상태에서 재확인 → SIGTERM → SIGCONT 순서로 진행한다. 첫 확인이 실패하면 신호를 하나도 보내지 않는다. 한계: 동기 ps 스냅샷과 SIGSTOP 사이의 수 ms는 덮지 못한다.
  - 회귀 5개 파일 99 pass, 0 fail. 실측 스모크(수치만): 감독 95, 풀 증명 통과 95, 자기 lease 보유 24, childless 0.
- 4차 적대 검증 Important 3건 반영(2026-10-16).
  - HOME 판정 제거: `defaultCmuxRescuePaths()`는 구버전(`dbce9e1`)과 현재 모두 `homedir()`(HOME, 없으면 passwd 홈)에만 의존하고, store 경로를 바꾸는 다른 env override는 없다. sidecar는 자기 store의 lease만 읽으므로, HOME이 다른 감독은 lease가 다른 store에 있어 후보가 될 수 없다. 그래서 `ps` 텍스트의 `HOME=` 규칙은 삭제했다. 대신 env가 보이는지(명령줄 + 공백 + `NAME=`)만 확인한다. `TEAMCLAUDE_CONFIG=`·`XDG_CONFIG_HOME=` 부재 증명과 `TEAMCLAUDE_PROVIDER=anthropic` 규칙은 유지한다. 한계: 다른 HOME의 `.cmuxterm`이 sidecar store로 향하는 심링크인데 `.config`는 다른 경우는 구분하지 못한다.
  - lease 소유권 재확인: 첫 lease 읽기 때 pid·processStartSeconds·nonce를 저장하고, SIGSTOP 울타리 안에서 다시 읽어 셋이 같을 때만 진행한다. 다르거나 없거나 읽기에 실패하면 STOP → CONT로 되돌리고 claim을 해제한다. nonce 없는 lease는 처음부터 대상에서 뺀다.
  - 진행·완료된 세션 재실행 방지: 기존 `unresolvedApiError`(cmux-session-guards)를 재사용한 `unresolvedExhaustionErrorState`(종류 `fleet_exhausted`·`usage_limit`)로 transcript가 미해결 소진 오류로 끝나는지 검사한다. snapshot·push 전에 한 번, SIGSTOP 울타리 안에서 한 번 검사한다. 상태 파일에 offset을 저장하는 방식 대신 이 방식을 고른 이유는 세 가지다. rescuer가 이미 쓰는 판정과 같은 규칙이고, 오류 뒤 대화(user 또는 정상 assistant)를 바로 미해결 해제로 보며, 감독이 멈춘 동안에는 transcript가 바뀌지 않는다. transcript 경로는 울타리 밖에서 한 번만 찾아 둔다(전체 트리 탐색).
  - 회귀 5개 파일 104 pass, 0 fail(sidecar 44). cmux rescue·lease 테스트 97 pass. 실측 스모크(수치만): 감독 95, 풀 증명 통과 95, 자기 lease 보유 24(재읽기 nonce 일치 24), 미해결 소진 transcript 0.
- 5차 적대 검증 Important 3건 반영(2026-10-16).
  - 풀 소속은 두 증거를 AND로 묶는다. (a) 감독 lease가 sidecar 자신의 store에 있고, (b) `ps -wwE` 텍스트에서 `HOME=`가 정확히 1회, 공백 바로 뒤, 값이 sidecar HOME과 정확히 같고, 그 뒤가 끝이거나 공백 + 대문자 env 이름 토큰(`/^[A-Z_][A-Z0-9_]*=/`)이어야 한다. 소문자 토큰이 이어지거나, HOME이 다르거나, 2회 나오거나, 없으면 제외한다. store를 공유하더라도 HOME이 다르면 제외한다. sidecar 자신도 절대 경로 HOME이 있어야 한다. 위협 모델: 같은 uid 프로세스는 같은 신뢰 영역이다. 같은 uid가 일부러 `HOME="<sidecar HOME> X=y"`를 만들고 store까지 symlink로 공유하는 경우는 잔여 위험으로 받아들인다.
  - 오류 이벤트 동일성: 첫 검사(snapshot 전)에서 transcript identity(dev/ino), 오류 레코드 offset, uuid(eventId)를 저장한다. SIGSTOP 울타리 안 재검사에서 셋이 모두 같고 여전히 마지막 미해결 상태여야 진행한다. 새 오류 B, 오류 뒤 대화, 파일 교체, 판정 불가는 STOP → CONT, `CloudHandoffNotStopped`, claim 해제로 끝난다. 상태 파일에 저장하는 대신 같은 실행 안에서 첫 검사 결과를 들고 간다. 첫 검사와 울타리 사이가 한 실행 안이고, 다음 주기에는 처음부터 다시 판정하기 때문이다.
  - transcript 읽기 무결성: rescuer의 관대한 스캐너는 그대로 두고, sidecar 전용 엄격 스캐너 `scanExhaustionTail`(src/sidecar-transcript.js)을 새로 둔다. 실제 `bytesRead`가 요청 길이와 같아야 하고, 읽은 뒤 fstat·lstat로 dev/ino와 크기를 다시 확인한다. short read, 축소·증가, 교체, 파싱 실패 레코드, 줄바꿈 없는 마지막 레코드는 모두 `unknown`(handoff 불가)이다. 앞 회차에 cmux-session-guards.js에 추가했던 `unresolvedExhaustionErrorState`는 제거해 그 파일을 base와 같게 되돌렸다.
  - 경계 테스트는 메모리 스텁만 쓰는 `test/cloud-sidecar-proofs.test.js`로 옮겼다(mkdtemp 없음).
  - 회귀 5개 파일 + proofs: 111 pass, 0 fail. cmux rescue·lease 97 pass. 실측 스모크(수치만): 감독 94, 풀 증명 통과 94, 자기 lease 보유 24, 엄격 스캔 결과 clear 24(unknown 0).
