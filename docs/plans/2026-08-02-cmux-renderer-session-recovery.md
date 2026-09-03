# cmux renderer 및 agent session 안전 복구 실행 계획

## Tasks

1. [x] 복구 lock과 owner-only snapshot을 만들고 원본 hash와 mode를 확인한다.
2. [x] renderer/auth/hook/surface RED 기준선을 민감정보 없이 기록한다.
3. [x] cmux auto-resume를 끄고 현재 stable에서 미지원인 관련 key를 정리한다.
4. [x] 강제 종료 주체·시각·재실행 횟수와 topology mismatch를 runtime evidence로 확정한다.
5. [x] unattended supervisor에서 cmux quit primitive를 제거하고 failing-first 테스트를 추가한다.
6. [x] launchd plist를 `KeepAlive` 없는 one-shot으로 전환하고 live label 부재를 확인한다.
7. [x] generic runtime `task_id`가 session active review state를 덮어쓰지 못하도록 회귀를 고정한다.
8. [x] email guard의 일반 진단 명령 오탐과 고급 parameter expansion 우회를 canonical source에서 수정하고 Gmail write 차단 회귀를 보존한다.
9. [x] heavy gate를 거쳐 `reload-config`와 비파괴 `refresh-surfaces`를 수행한다.
10. [x] 전체 테스트와 live cmux/Codex/topology/hook QA를 실행한다.
11. fresh context 목표·정확성 lane과 런타임·launchd·보안 lane의 최신 상태는 review ledger의 aggregate change ref 행을 SSOT로 사용한다.
12. review 결과는 evidence ledger에서만 갱신해 검토 대상 spec/plan의 self-invalidating verdict 변경을 피한다.
13. [x] retained quit-hazard claim의 script hash migration을 owner-only attestation과 fail-closed runtime gate로 고정한다.
14. [x] resume approval modal을 해제하고 잘못 저장된 `policy:auto` 레코드를 owner-only 백업 뒤 fail-closed 제거한다.
15. [x] migration launchd/PID 부재 판정을 exact subprocess evidence로 고정하고 adversarial hook의 invalid review를 지원 wire에서 block한다.
16. [x] Python heredoc의 `getattr`/`importlib`/`__import__` 동적 process sink 우회를 차단하고 재등장한 launchd label을 disabled+bootout한다.
17. [x] 독립 `com.qjc.cmux-auto-approve-resume` KeepAlive daemon과 Auto-Restore 클릭 sink를 failing-first로 retire하고 live label을 disabled+bootout한다.
18. [x] 저장 recovery plist를 `RunAtLoad=false`/`KeepAlive` 부재로 retire하고 `uchg`로 고정해 외부 nonce 갱신과 재-bootstrap을 차단한다.
19. [x] 같은 change의 최신 `REQUEST_CHANGES`가 오래된 `APPROVE`보다 우선하도록 adversarial gate의 Stop 상태 전이를 보강한다.
20. [x] cmux 밖 external agent의 exact preflight identity와 복구 전 부재 provenance를 durable state·migration·final fleet 경계에서 fail-closed로 고정한다.
21. [x] immutable retired recovery plist와 future submission transport를 분리한다. nonce-bound owner-only 임시 plist를 exclusive 생성하고 path/device/inode/content identity와 single-link 상태를 검증하며, public path를 nonce quarantine으로 원자 이동한 뒤 verified FD만 `/dev/fd`로 bootstrap한다. partial writer·pre-bootstrap cleanup·bootstrap 성공/실패 뒤 verified inode를 zeroize하고, 이동 전 실패의 empty tombstone과 late foreign replacement는 보존한다. exact launchctl absence·watchdog argv/receipt/PID/fresh timestamp 순서·complete fast path 승인 handshake를 결합하고, 취소 직전 소유권이 바뀐 동일 label은 bootout하지 않는 회귀를 고정한다.

기존의 자동 누락 세션 복구·browser surface 생성 작업은 superseded 처리한다. 사용자의 재발 방지 지시와 실제 사고 원인에 따라 unattended recovery 자체가 live cmux를 종료하지 못하게 바뀌었으며, 현재 사용자 surface를 닫거나 다시 재시작하는 작업은 범위 밖이다.

## Verification log

- RED: `codex login status`는 환경변수 토글 전후 모두 ChatGPT 로그인으로 성공했다.
- RED: 로그인 선택 화면이 남은 surface가 존재한다.
- RED: cmux debug metadata의 surface resume binding, initial command, 실제 PTY/process가 교차한다.
- RED: `terminal.autoResumeAgentSessions`가 켜져 있고 재시작 직후 agent 동시 기동이 관찰됐다.
- 원인: `osascript ... to quit` → AppKit 종료 재진입 → 새 topology UUID와 원본 UUID 완전 동일성 실패 → `EX_TEMPFAIL`/launchd 83회 재실행.
- RED: unattended quit·KeepAlive·unsafe source primitive 테스트 3개가 2 failures + 1 error로 실패했다.
- GREEN: 동일 3개 targeted 테스트 통과, private supervisor 전체 `60 tests` 통과.
- RED: supervisor hook prerequisite에 active-state 회귀 2개가 누락된 테스트가 실패했다.
- GREEN: prerequisite tuple에 회귀 2개를 포함한 뒤 targeted 및 전체 suite 통과.
- 적대 RED: `${X:0:3}`, `${X%ZZ}`, `${X,,}`, `${X[0]}`, `${COMMAND:0}` command/newline origin 6건이 exit 0으로 허용됐다.
- 적대 GREEN: 지원하지 않는 `${...}` expansion을 dynamic marker로 fail-closed 처리한 뒤 email guard 전체 `10 tests` 통과.
- GREEN: adversarial review gate 최신 전체 `48 tests` 통과.
- Manual QA: cmux PID `15594` PONG 및 Codex PID `72547` 생존, topology hash 5초 불변(81 surfaces), `autoResumeAgentSessions=false`, launchd label/exit 127 job/KeepAlive/automated quit 모두 없음.
- Manual QA: 실제 hook CLI에서 `UserPromptSubmit`과 generic `task_id`가 포함된 `PreToolUse` 모두 exit 0/allow.
- Residual: `error.Defunct`는 5초 133건 → non-destructive refresh 후 135건으로 기존 손상이 지속된다. `surface-health`의 window 밖 사용자 surface 10개는 자동 폐쇄하지 않는다. 같은 구간의 `RenderBox`와 `Will force immediate termination`은 0건이다.
- 최신 live QA: renderer/hibernation 6개 stale key를 helper로 제거했고 `autoResumeAgentSessions=false`를 재확인했다. structure-only topology hash와 cmux PID `15594`/현재 Codex PID `95708`은 5초간 불변, surface 85개, 새 forced termination/RenderBox/Defunct는 0건이었다. 기존 PID `72547`은 사라졌지만 cmux 재시작 없이 같은 session이 10:13에 resume된 상태로 확인돼 이번 강제 종료 경로와 분리했다.
- 최신 residual: `surface-health`의 window 밖 사용자 surface는 12개다. validator에는 renderer/hibernation 외 사용자 소유 unknown notification/automation key 6개가 남아 있으며 이번 종료 재발 방지 범위에서는 수정하지 않았다.
- Concurrent merge RED: 새 retained hazard migration tests가 구현보다 먼저 들어온 시점에 68 tests 중 6 errors(`migrate_retained_hazard` 부재)가 재현됐다.
- Concurrent merge GREEN: live owner·launchd·watchdog·target drift 차단과 partial attestation replay 구현이 안정화된 최신 source에서 supervisor 전체 `69 tests`가 통과했다.
- Modal QA: `Allow Resume Command?`가 main queue를 점유해 cmux socket 명령을 막았다. modal 해제 뒤 `list-windows`/`tree --all --json`/`surface-health`가 즉시 회복됐지만 `source=cmux-safe-recovery-v3`, `policy=auto` approval 1건이 확인됐다.
- Approval hardening: 원본 `cmux.json`을 mode 0600 백업하고 `cmux-settings unset terminal.resumeCommands`로 auto approval을 제거했다. reload 뒤 `autoResumeAgentSessions=false`, `resumeCommands` 부재, cmux PONG을 확인했다. signature/policy field는 직접 수정하지 않았다.
- Hook RED: 정상 Python heredoc의 `window["ref"]`와 starred argument를 shell executable glob으로 오판해 exit 2로 차단했다.
- Hook GREEN: quoted Python heredoc body만 dynamic command-origin shell lexing에서 제외했다. static Gmail route 검사는 유지했고 targeted 3/3, full email guard `15 tests`가 통과했다.
- Security review RED: quoted Python heredoc 안의 literal/`"g"+"ws"` `subprocess.run(...)` Gmail write가 parser-only hook에서 exit 0으로 허용됐다.
- Security review GREEN: heredoc 본문을 실행하지 않고 AST로 `subprocess`/`os`/direct process sink와 단순 문자열·list·alias를 평가한다. literal·문자열 결합·module alias·import alias·동적 executable·`os.system` 우회는 차단하고 안전한 Python 진단은 허용한다.
- Wire-schema RED: 성공 hook 메타데이터를 `{}`로 정규화한 뒤 기존 테스트 6개가 custom `decision`/`verdict`/`classification`을 기대해 실패했고, checker mutation·malformed review는 wire상 조용한 allow로 사라졌다.
- Wire-schema GREEN: 성공 결과는 `status --json` SSOT로 검증하고 invalid review만 `SubagentStop`에서 block한다. targeted 6/6과 adversarial review gate 전체 `55 tests`가 통과했다.
- Security review RED: Python heredoc의 `getattr(subprocess, "run")`, `importlib.import_module("subprocess").run`, assigned sink가 Gmail write route를 exit 0으로 허용했다.
- Security review GREEN: module/sink resolver가 `getattr`·`importlib`·`__import__`·assigned alias를 추적한다. email guard 전체 `16 tests`가 안전 control과 함께 통과했다.
- Runtime QA RED: one-shot label이 `runs=1`, `last exit=75 EX_TEMPFAIL`로 재등장했다. exact label만 `disable`+`bootout`했고 readback은 service-not-found+disabled다. cmux/Codex PID와 PONG은 불변이다.
- Auto-approve daemon RED: stored plist의 `RunAtLoad=true`에서 retirement 계약 테스트가 실패했다.
- Auto-approve daemon GREEN: owner-only backup 뒤 plist `RunAtLoad=false`/`KeepAlive` 부재, AppleScript `auto-approve-resume-disabled` fail-closed, live label service-not-found+disabled를 확인했다.
- Stored recovery plist RED: disabled label과 무관하게 다른 세션이 plist nonce를 다시 써 aggregate change ref가 검토 중 변했고, `test_stored_recovery_plist_is_retired_and_immutable`가 `RunAtLoad=true`에서 실패했다.
- Stored recovery plist GREEN: owner-only backup 뒤 `RunAtLoad=false`/`KeepAlive` 부재로 retire하고 `chflags uchg`를 적용했다. targeted 테스트가 통과했고 실제 `touch`가 `Operation not permitted`로 실패하며 hash가 유지됐다.
- Review state RED: 같은 change에 `APPROVE` 뒤 `REQUEST_CHANGES`가 기록돼 status는 `awaiting-maker-revision`이었지만 Stop이 오래된 approval을 사용해 allow했다. full suite와 targeted 격리에서 동일 실패를 재현했다.
- Review state GREEN: `completion_decision`이 `needs_maker_revision`을 `awaiting-maker-revision` 차단 사유로 반영한 뒤 targeted 테스트가 통과했다.
- External preflight RED: 새 3개 경계가 `capture_external_preflight` 부재와 `migration-hazard-state` 선차단으로 2 failures + 3 errors를 냈다. 첫 구현 중간본은 기존 external identity 회귀 3건을 추가로 노출했다.
- External preflight GREEN: exact PID/PPID/TTY/command hash와 session/provider drift를 분류하고, 과거 완료된 `external-preserved` predecessor가 있을 때만 `absent-before-recovery`를 허용했다. supervisor 전체 `88 tests`가 통과했다.
- Submission plist GREEN: 새 3개 경계가 nonce-bound 임시 path, watchdog argv/receipt exact binding, bootstrap 실패 cleanup, foreign path 거부, retired plist byte/mode 불변을 확인했다.
- Submission transport hardening RED: symlink collision, same-owner replacement, operational launchctl 오류, cleanup 실패, watchdog 검증 순서, submit 승인 handshake 경계 8개가 `4 failures + 4 errors`로 실패했다.
- Submission transport hardening GREEN: exclusive writer와 device/inode/hash cleanup identity, exact launchctl 판정, 실패 후 bootout, `detached-ready`→`submission-approved` handshake, 승인 timeout claim release, malformed external session drift가 targeted `8/8` 및 전체 `98/98`에서 통과했다.
- Final heavy suites: private supervisor `98 tests`, adversarial review gate `73 tests`, email guard `16 tests` 모두 OK.
- Final manual QA: cmux PID `15594`, 보호 대상 Codex PID `95708`/`ttys001`, 현재 Codex PID `80672`/`ttys015`가 유지됐다. structure-only topology hash `b5ee6bc4...`는 5초 불변(1 window/14 workspaces/19 panes/90 surfaces), 두 위험 launchd label은 service-not-found+disabled, recovery plist는 `RunAtLoad=false`/`KeepAlive` 부재/`uchg`였다.
- Post-review FD/approval RED: cleanup-before-bootstrap, verified FD bootstrap, unlink race replacement 보존, parent approval post-commit readback 제거, complete fast-path fresh approval, canonical timestamp, foreign 동일-label cancel ownership 7개가 `4 failures + 3 errors`로 실패했다.
- Post-review FD/approval GREEN: 검증 FD를 유지한 채 원래 public path를 nonce quarantine으로 이동하고 `/dev/fd`로 bootstrap한다. cancel 직전 launchd PID·receipt·nonce·target·fresh timestamp를 재검증하며 replacement/foreign job은 보존한다. complete fast path도 `submission-approved` 전에는 claim을 정리하지 않는다. 인접 targeted `10/10`과 당시 supervisor 전체 `104/104`가 통과했다.
- Hardlink·retirement RED/GREEN: writer/open/cleanup/bootstrap 네 경계가 retained hardlink를 모두 허용해 4개 subtest가 RED였고, 승인 기록은 `createdAt > approvedAt`을 commit 전에 거부하지 않았으며, pathname unlink 경계에서는 foreign replacement 삭제가 가능했다. create/path/FD/quarantine/bootstrap 직전은 `st_nlink == 1`을 강제하고, destructive unlink를 제거해 nonce quarantine + verified FD bootstrap + 성공·실패 후 verified inode zeroization으로 전환했다. late foreign replacement는 보존하고 identity drift로 fail-closed한다. targeted `10/10`이 통과했으며 전체 기준은 supervisor `108/108`이다.
- Writer/pre-bootstrap failure RED/GREEN: partial writer 실패가 public path를 pathname unlink해 hardlink에 partial bytes를 남겼고, quarantine 전 cleanup 실패는 outer verified FD를 close만 해 전체 plist를 남겼다. 공통 verified-FD zeroization helper를 적용해 두 경로 모두 inode를 먼저 `ftruncate(0)`·`fsync`하고 foreign namespace를 건드리지 않는 empty tombstone으로 retire한다. 두 신규 RED와 기존 hardlink 회귀 targeted `3/3`이 GREEN이며 전체 기준은 supervisor `110/110`이다.
- Final residual: 최근 10분 `error.Defunct=959`는 잔존했지만 `Will force immediate termination`/`RenderBox`/SIGKILL/Jetsam/crash 및 새 cmux diagnostic report는 0건이었다. 사용자 surface 폐쇄·cmux 재시작은 수행하지 않았다.
