# cmux renderer 및 agent session 안전 복구

상태: 재발 방지 구현·live QA 완료. 최신 fresh-context 승인 상태는 review ledger를 SSOT로 사용한다.

## Problem

cmux 재시작 직후 수십 개 Claude/Codex agent가 동시에 자동 재개됐고, WebKit/Ghostty renderer 오류 뒤 surface와 PTY metadata가 서로 교차했다. 일부 Codex surface는 전역 인증이 정상인데도 로그인 선택 화면을 남겼다. 역사 session 목록을 recency나 cwd로 추측해 재개하면 중복 실행 또는 잘못된 대화 재개가 발생할 수 있다.

2026-08-03 실제 강제 종료는 cmux crash가 아니라 launchd `KeepAlive` supervisor가 `osascript ... to quit`을 실행한 결과였다. AppKit 종료 처리 재진입은 즉시 강제 종료로 승격됐고, 재시작 뒤 UUID가 바뀐 topology를 원본과 완전 동일하게 요구한 supervisor가 `EX_TEMPFAIL`을 반환해 launchd가 83회 재실행했다.

## Goal

1. 기존 cmux topology와 살아 있는 agent를 보존한다.
2. 자동 대량 재개를 차단하고 renderer/PTTY mapping을 비파괴 방식으로 회복한다.
3. 신뢰 가능한 public binding과 active map이 일치하는 누락 세션만 직렬 재개한다.
4. Codex 로그인 선택 화면을 재로그인 없이 정상화한다.
5. 같은 장애가 다시 발생해도 폭주·중복 재개 없이 복구 가능한 runbook과 rollback을 남긴다.
6. unattended recovery에는 살아 있는 cmux를 종료할 권한을 주지 않고, launchd 실패 재실행 루프를 구조적으로 제거한다.

## Non-goals

- 역사 store에서 가장 최근 세션을 추측해 재개하지 않는다.
- 기존 agent process, surface, workspace를 일괄 종료하지 않는다.
- cmux를 downgrade/reinstall하거나 source `.claude/` 설정을 직접 수정하지 않는다.
- 사용자 소유의 기존 TeamClaude 코드 변경을 정리하거나 되돌리지 않는다.

## Requirements

1. 설정·session store·topology를 owner-only snapshot으로 보존하고 hash를 검증한다.
2. `terminal.autoResumeAgentSessions`를 false로 유지해 restart thundering herd를 차단한다.
3. 현재 cmux stable에서 지원되지 않는 renderer/hibernation/resume 설정 family를 제거한다.
4. renderer 복구는 `reload-config`와 `refresh-surfaces`만 자동 실행할 수 있다. 살아 있는 cmux의 종료·재시작은 unattended supervisor에서 금지하고, 별도의 사용자 승인 작업으로만 다룬다.
5. 복구 후보는 public binding, active map, exact process identity, PTY 점유 상태를 모두 대조한다. cmux 밖 external agent는 preflight의 PID·PPID·TTY·command hash와 session/provider identity를 보존하며, 과거 완료된 `external-preserved` 증거로 복구 전에 이미 부재했음이 입증된 경우만 비파괴 부재로 분류한다.
6. 동일 checkpoint/process/surface를 두 번 재개하지 않는다.
7. Codex 전역 인증이 정상일 때 로그인 surface에서 `codex login`이나 OAuth browser를 열지 않는다.
8. hook 오탐은 규칙 출처와 재현 입력을 확인하고, source `.claude/` 설정이 아닌 canonical 생성 원본 또는 프로젝트 소유 경계에서만 고친다.
9. 실제 terminal 및 browser surface QA와 fresh-context 적대 검토를 완료한다.
10. launchd recovery plist는 one-shot이어야 하며 `KeepAlive`를 포함하지 않는다.
11. runtime의 generic `task_id`는 session active review state를 덮어쓰지 못한다.
12. 이메일 guard는 실제 Gmail write route와 알 수 없는 dynamic command origin을 fail-closed로 차단한다. command substitution이나 jq 변수식, 안전한 quoted Python heredoc이 포함된 일반 진단 명령은 허용하되, 지원하지 않는 `${...}` parameter expansion이나 Python process-execution sink를 `getattr`·`importlib`·`__import__`·alias로 우회해 Gmail write를 실행할 수 없다.
13. retained quit-hazard claim의 script hash migration은 owner-only attestation을 사용하고, live owner·launchd·watchdog·target drift에서는 fail-closed한다.
14. migration의 launchd/service 부재와 owner PID 부재는 정확한 subprocess 결과로만 인정하며, 모호한 비정상 종료는 fail-closed한다.
15. adversarial review hook의 성공 event는 지원되는 wire shape만 반환하고, malformed·nonce mismatch·checker mutation 같은 invalid review는 `SubagentStop`에서 명시적으로 block한다. 같은 change에 더 최신 `REQUEST_CHANGES`가 기록되면 이전 `APPROVE`를 무효화하고 maker revision·새 evidence·새 review 전까지 `Stop`을 차단한다.
16. `Allow Resume Command?` 승인에서는 `Keep Manual`만 허용한다. `Auto-Restore` 레코드가 생기면 signed field를 직접 고치지 않고 owner-only 백업 뒤 해당 approval을 제거해 fail-closed한다.
17. `Auto-Restore`를 자동 클릭하는 별도 LaunchAgent는 disabled+unloaded 상태를 유지한다. 저장 plist에는 `KeepAlive`가 없어야 하고 `RunAtLoad=false`여야 하며, 연결된 AppleScript는 클릭 없이 `auto-approve-resume-disabled`로 종료해야 한다.
18. 사고에 사용된 저장 recovery plist는 `RunAtLoad=false`, `KeepAlive` 부재, owner immutable flag(`uchg`) 상태로 보존해 다른 세션이나 도구가 nonce를 갱신하거나 다시 bootstrap하지 못하게 한다.
19. 향후 승인된 one-shot 제출은 retired plist를 쓰지 않는다. 32자리 hex nonce에 결합된 owner-only 임시 plist를 `O_EXCL`·`O_NOFOLLOW`·mode 0600으로 만들고, final·temporary path 충돌과 device/inode/content hash 교체를 fail-closed한다. 생성·path open·FD open·quarantine 이동·bootstrap 직전까지 inode가 single-link(`st_nlink == 1`)인지 확인하고, 원래 공개 path를 nonce-bound quarantine path로 원자 이동한 뒤 검증 FD의 `/dev/fd/<n>`만 bootstrap에 전달한다. pathname `unlink`는 writer 성공·실패 어느 경로에서도 사용하지 않는다. partial write 실패나 bootstrap 전 cleanup 실패도 검증 FD가 가리키는 inode를 먼저 `ftruncate(0)`·`fsync`하고, namespace 이동을 안전하게 완료하지 못했다면 마지막 검증 이름에 빈 tombstone을 남겨 foreign path를 건드리지 않는다. bootstrap 성공·실패 뒤에도 같은 방식으로 검증 inode만 retire하고, 늦게 생긴 foreign quarantine replacement는 삭제하지 않은 채 identity drift로 fail-closed한다. cleanup 실패에서는 bootstrap하지 않는다. exact original path는 watchdog argv와 detached receipt에 함께 묶되, 취소 직전에도 launchd PID·receipt·nonce·target·fresh timestamp 소유권을 다시 확인하며 foreign 또는 교체된 동일 label은 bootout하지 않는다. watchdog의 complete fast path를 포함한 모든 경로는 canonical/fresh `createdAt`·`approvedAt` 순서, receipt·PID·transport identity, submit 측의 원자적 `submission-approved`를 확인하기 전에는 recovery나 claim cleanup을 시작하지 않는다.

## Acceptance criteria

- [x] owner-only snapshot과 hash 검증이 완료된다.
- [x] cmux가 기존 PID로 PONG을 유지하고 현재 topology가 연속 관찰 사이에서 불변이다.
- [x] `terminal.autoResumeAgentSessions=false`가 적용된다.
- [x] supervisor source에 cmux quit primitive가 없고 plist에 `KeepAlive`가 없다.
- [x] launchd/service 및 owner PID 부재 판정이 exact stdout/stderr/returncode 경계 밖에서 fail-closed한다.
- [x] invalid adversarial review가 wire상 조용한 성공으로 사라지지 않고 block된다.
- [x] 문제가 된 launchd label이 disabled+unload 상태이고 exit 127 좀비가 없다.
- [x] 현재 정확한 Codex session process와 TTY가 살아 있고 연속 관찰에서 PID가 유지된다.
- [x] hook의 정상 prompt/진단 명령 오탐 경로가 문서화되고 source-level 회귀 테스트가 통과한다.
- [x] `terminal.resumeCommands`에 자동 복원 approval이 없고 `terminal.autoResumeAgentSessions=false`가 함께 유지된다.
- [x] `com.qjc.cmux-auto-approve-resume`가 service-not-found+disabled이고 저장 plist/script가 자동 승인 경로를 재생성할 수 없다.
- [x] 저장 recovery plist가 `RunAtLoad=false`, `KeepAlive` 부재, `uchg` 상태이며 쓰기 시도가 실패한다.
- [x] one-shot 제출 transport가 nonce-bound 임시 plist를 사용하고 retired plist의 byte/mode/flag를 바꾸지 않는다. symlink/교체/hardlink retention/operational launchctl 오류를 거부하고, public path를 nonce quarantine으로 이동한 뒤 single-link verified FD만 bootstrap한다. partial writer·pre-bootstrap cleanup·bootstrap 성공/실패 모두 검증 inode를 zeroize하고, 이동 전 실패의 empty tombstone과 late foreign replacement는 보존해 pathname TOCTOU를 만들지 않는다. canonical/fresh submit 승인 전에는 complete fast path도 recovery·claim cleanup을 시작하지 않는다. 실패 job은 재확인한 receipt/PID/nonce/target 소유권이 exact할 때만 취소한다.
- 독립 적대 reviewer 승인 여부는 `.omo/evidence/cmux-unattended-restart-prevention/review-ledger.md`의 최신 aggregate change ref 행으로 판정한다. 문서 안에 mutable verdict를 중복 기록하지 않는다.

기존 재시작이 남긴 `error.Defunct`는 5초당 133건에서 비파괴 refresh 후 135건으로 지속됐다. modal 해제 뒤 최신 5분에는 `error.Defunct` 1,626건과 cmux CPU 약 29%가 관찰됐지만, 메모리 여유 36%, `Will force immediate termination`·`RenderBox`·SIGKILL·Jetsam·crash는 모두 0건이었다. `surface-health`는 사용자 소유의 window 밖 surface 12개를 보고했다. 이 항목은 기존 surface를 닫지 않는 범위에서는 복구할 수 없으므로 이번 강제 종료 재발 방지 완료 조건에서 분리하고, 사용자 승인 없는 surface 폐쇄·재시작은 수행하지 않는다.

## Alternatives

- 전체 `restore-session`: 이미 topology가 복원된 상태에서 중복 surface를 만들 수 있어 기각한다.
- 역사 session store 최신 항목 일괄 재개: active identity가 아니므로 기각한다.
- cmux 강제 종료/SIGKILL: 저장 상태를 더 오염시킬 수 있어 금지한다.
- unattended graceful quit: AppKit 종료 재진입과 세션 전체 중단을 다시 만들 수 있어 금지한다.
- launchd `KeepAlive` watchdog: 영구 topology mismatch를 무한 재실행하므로 금지한다.
- 즉시 reinstall/downgrade: 최신 stable이며 renderer refresh 전에 근거가 부족해 기각한다.

## Decision

자동 재개를 먼저 끈 뒤 비파괴 renderer refresh를 수행한다. unattended supervisor는 live cmux를 발견하면 `automated-quit-disabled`로 fail-closed하고, launchd job은 one-shot으로 끝난다. 별도 Auto-Restore 클릭 daemon도 disabled+unloaded하고 저장 plist/script를 fail-closed 상태로 둔다. 사고에 사용된 저장 recovery plist는 retired 상태로 전환한 뒤 `uchg`로 고정하고, 승인된 future submit은 별도의 nonce-bound 임시 plist만 사용한다. 이미 발생한 restart state의 증거는 owner-only snapshot에 보존하되 재실행하지 않는다. 세션은 active-only, exact-binding, concurrency 1 원칙으로 다루며, resume command approval은 manual-only로 유지한다. Codex 인증은 `login status`와 auth file mode만 확인하고 토큰 값은 읽거나 출력하지 않는다.

## Migration

데이터 migration은 없다. 사용자 cmux 설정에서 auto-resume를 false로 전환하고 미지원 key를 제거한다. 사고 중 생성된 단일 `policy:auto` resume approval은 owner-only 원본 백업 뒤 전체 approval key를 제거했으며, 새 approval은 앱의 `Keep Manual` 선택으로만 만든다. 기존 Auto-Restore 클릭 plist/script는 owner-only 백업 뒤 retired 상태로 전환했다. 사고 recovery plist도 owner-only backup 뒤 `RunAtLoad=false`로 바꾸고 `uchg`를 적용했다.

## Rollout

snapshot → RED 기준선 → auto-resume 및 auto approval 차단 → Auto-Restore 클릭 daemon retire → supervisor quit 권한 제거 → launchd one-shot 전환 → renderer refresh → active-only 상태 확인 → terminal/hook QA → fresh-context 검토 순서로 진행한다.

## Rollback

snapshot의 `cmux.json`을 복원하더라도 auto-resume는 false로 유지한다. rollback에서 supervisor의 quit primitive, launchd `KeepAlive`, Auto-Restore 클릭 daemon을 복원하지 않는다. 저장 recovery plist의 `uchg`를 해제하거나 freeze 전 backup을 복원하지 않는다. 별도 사용자 승인으로 분석 목적 수정이 꼭 필요한 경우에만 exact path를 확인한 뒤 `chflags nouchg`로 해제하고, 수정 직후 retired 필드와 hash를 재검증해 `chflags uchg`를 다시 적용한다. surface 또는 binding 불일치가 생기면 자동 폐쇄하지 않고 snapshot과 대조한 상태에서 중단한다.

## Observability

- `cmux ping`, `cmux surface-health`, `cmux debug-terminals`
- process count/start time/TTY와 exact binding의 교차 확인
- macOS log의 `RenderBox`, `error.Defunct`, crash/SIGKILL/jetsam signature count
- launchd label disabled+부재, exit 127 job 부재, plist `KeepAlive` 부재
- 저장 recovery plist `RunAtLoad=false`, `KeepAlive` 부재, `uchg` 및 hash 불변
- nonce-bound 임시 submission plist의 exclusive write, path/device/inode/content identity, create/open/quarantine/bootstrap 직전의 `st_nlink == 1`, nonce quarantine 이동, verified FD 기반 `/dev/fd` bootstrap, partial writer·pre-bootstrap cleanup·bootstrap 성공/실패의 검증 inode zeroization, empty tombstone 및 late foreign replacement 보존, exact launchctl absence, detached receipt/PID/fresh timestamp 순서 결합, complete fast path를 포함한 submit 승인 handshake, foreign 동일 label bootout 금지, retired plist byte/mode/flag 불변
- Auto-Restore daemon label disabled+부재, 저장 plist `RunAtLoad=false`/`KeepAlive` 부재, AppleScript fail-closed marker
- `terminal.autoResumeAgentSessions=false`와 `terminal.resumeCommands` auto approval 부재
- `codex login status`와 로그인 화면 classifier

## Runbook

운영 절차는 `docs/runbooks/cmux-renderer-session-recovery.md`를 SSOT로 둔다.

## Risks

- cmux private metadata가 손상된 상태에서는 binding과 PTY가 불일치할 수 있다. 불일치 항목은 복구하지 않는다.
- renderer refresh도 85개 surface를 건드리는 작업이므로 heavy load gate를 거친다.
- source hook 설정은 생성물일 수 있으므로 canonical source를 찾기 전 수정하지 않는다.
- 현재 실행 중인 Codex hook runtime은 세션 시작 시 로드한 guard를 유지할 수 있다. canonical source와 hard-link된 installed file은 수정됐으며, 현재 세션을 종료하지 않고 direct hook surface로 검증한다.

## Verification

- 설정 validator와 JSON parse
- renderer refresh 전후 topology/process/signature 비교
- exact surface `read-screen`과 GUI screenshot
- 임시 terminal/browser surface E2E
- fresh context 적대 검토
- supervisor 110개, adversarial review gate 73개, email guard 16개 전체 회귀
- live cmux/Codex PID 불변, structure-only topology hash 5초 불변(90 surfaces), launchd/one-shot source 검사
