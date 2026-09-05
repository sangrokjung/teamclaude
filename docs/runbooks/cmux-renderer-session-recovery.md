# cmux renderer 및 agent session 안전 복구 runbook

## 목적

cmux renderer 또는 surface/PTY mapping 이상이 발생해도 살아 있는 cmux와 agent session을 자동 종료하지 않고, 비파괴 관찰과 refresh만으로 안전하게 진단한다. 자동 복구가 해결하지 못하는 상태는 사용자 승인 경계에서 멈춘다.

## 절대 안전 규칙

1. unattended job은 live cmux에 quit, restart, SIGTERM, SIGKILL, AppleScript quit을 보내지 않는다.
2. launchd recovery job은 one-shot으로만 실행하며 `KeepAlive`를 넣지 않는다.
3. 사용자 surface, workspace, pane, agent process를 자동 폐쇄하거나 일괄 재개하지 않는다.
4. 역사 session의 recency나 cwd만으로 재개 대상을 추측하지 않는다.
5. `terminal.autoResumeAgentSessions=false`를 유지한다.
6. source `.claude/` 생성물을 직접 수정하지 않는다. hook 변경은 canonical source에서 수행한다.
7. `Auto-Restore` 버튼을 자동 클릭하는 LaunchAgent나 Accessibility daemon을 실행하지 않는다.
8. retired recovery plist의 `uchg`를 자동 해제하거나 freeze 전 backup을 복원하지 않는다.
9. 승인된 future submit도 retired plist를 transport로 재사용하지 않는다. nonce-bound 임시 plist를 exclusive 생성하고 path/device/inode/content identity를 검증한 read-only FD로 고정한다. 원래 path cleanup 성공 뒤 `/dev/fd/<n>`만 bootstrap하며, exact launchctl absence와 watchdog receipt/PID/fresh timestamp를 확인한다. complete fast path도 submit 승인 전에는 recovery나 claim cleanup을 시작하지 않는다. 실패 job은 취소 직전 동일 receipt/PID/nonce/target 소유권이 다시 확인될 때만 bootout하고 foreign 동일 label은 보존·중단한다.

## 장애 감지 시 1차 확인

다음 확인은 상태를 변경하지 않는다.

```bash
cmux ping
cmux surface-health
cmux debug-terminals
python3 ~/.codex/skills/cmux-settings/scripts/cmux-settings get terminal.autoResumeAgentSessions
launchctl print "gui/$(id -u)/com.qjc.cmux-safe-recovery-v3"
launchctl print "gui/$(id -u)/com.qjc.cmux-auto-approve-resume"
```

- `cmux ping`이 `PONG`이면 cmux는 live 상태다. 자동 종료·재시작 경로로 진입하지 않는다.
- launchd label이 존재하면 해당 job의 재실행 횟수와 종료 상태를 먼저 보존한다.
- `surface-health` 또는 `debug-terminals` 불일치는 자동 폐쇄 사유가 아니다.
- topology 불변성은 active marker나 동적 title을 제외한 window/workspace/pane/surface ref 구조로 비교한다.
- 인증 이상처럼 보여도 먼저 `codex login status`만 확인하며 토큰 값은 읽거나 출력하지 않는다.

## 재발 차단

launchd job이 반복 실행 중이면 정확한 label만 제거한다. 다른 job이나 cmux process는 건드리지 않는다.

이 사고 label은 one-shot이라도 다시 bootstrap되지 않도록 user domain에서 disabled 상태를 유지한다. 정상 상태는 `launchctl print gui/<uid>/com.qjc.cmux-safe-recovery-v3`가 service-not-found를 반환하고 `launchctl print-disabled gui/<uid>`가 해당 label을 `disabled`로 표시하는 조합이다.

```bash
launchctl bootout "gui/$(id -u)/com.qjc.cmux-safe-recovery-v3"
launchctl print "gui/$(id -u)/com.qjc.cmux-safe-recovery-v3"
```

두 번째 명령이 service 부재를 반환해야 한다. 저장 plist에는 `KeepAlive`가 없고 `RunAtLoad=false`이며 owner immutable flag(`uchg`)가 적용돼야 한다. supervisor는 live cmux를 만나면 subprocess 실행 전 `automated-quit-disabled`로 종료해야 한다. `ls -lO <exact-plist-path>`와 `plutil -p <exact-plist-path>`로 flag와 필드를 확인하고, hash를 전후 비교한 쓰기 시도가 `Operation not permitted`로 실패하는지 검증한다.

저장 plist는 증거용 retired artifact이며 launchctl 제출 파일이 아니다. 별도 승인으로 one-shot submit을 검증할 때는 `supervisor-v3-submit-<32-hex-nonce>.plist` 형식의 owner-only 임시 path만 허용한다. final 또는 `.tmp` path가 이미 존재하거나 symlink이면 제출하지 않고, exclusive 생성 직후 device/inode/content hash와 `st_nlink == 1`을 고정한다. path open·read/write FD open·nonce quarantine 이동·bootstrap 직전에도 같은 inode가 single-link인지 재검증하고, 원래 public path는 quarantine 이동으로 제거한다. pathname `unlink`는 사용하지 않는다. partial writer 또는 quarantine 전 cleanup 실패는 bootstrap하지 않고 verified FD inode부터 `ftruncate(0)`·`fsync`한 뒤 empty tombstone을 남긴다. launchctl에는 검증 FD의 `/dev/fd/<n>`만 전달하고, bootstrap 성공·실패 뒤에도 그 FD가 가리키는 inode만 같은 방식으로 retire한다. late foreign quarantine replacement는 삭제하지 않고 identity drift로 fail-closed한다. `launchctl print`는 정확한 exit 113·빈 stdout·현재 uid/label service-not-found stderr만 부재로 인정한다. watchdog argv와 detached receipt에는 원래 exact path가 들어가고, canonical/fresh `createdAt <= approvedAt`과 receipt PID·launchd PID가 일치한 뒤에만 submit 측이 `submission-approved`를 원자 기록한다. watchdog은 complete fast path에서도 그 승인을 확인하기 전 recovery나 claim cleanup을 시작하지 않는다. 실패 취소는 bootout 직전에 receipt/PID/nonce/target 소유권을 다시 확인하며, replacement 파일 또는 foreign 동일 label이면 지우거나 bootout하지 않고 중단한다.

Auto-Restore 클릭 daemon도 exact label `com.qjc.cmux-auto-approve-resume`를 disabled+unloaded 상태로 유지한다. 정상 상태는 `launchctl print` exit 113 service-not-found와 disabled map의 exact label이며, 저장 plist는 `RunAtLoad=false`이고 `KeepAlive`가 없어야 한다. 연결된 AppleScript는 `auto-approve-resume-disabled`로 즉시 종료해야 하며 `Auto-Restore` 클릭 코드를 포함하지 않는다.

이전 quit hazard가 남긴 claim/state의 script hash를 새 supervisor에 연결하는 migration은 자동 실행하지 않는다. 별도 승인 뒤에도 owner process가 죽어 있고, launchd label과 watchdog이 없고, target snapshot hash가 그대로이며, owner-only state/claim/attestation 검증이 모두 통과할 때만 수행한다. 일부 파일만 갱신된 상태에서는 attestation을 replay해 완료하거나 fail-closed해야 한다.

launchd 부재는 `launchctl print`의 exit 113, 빈 stdout, 현재 uid/label이 포함된 정확한 service-not-found stderr가 모두 일치할 때만 인정한다. owner PID 부재도 `ps -p <pid> -o pid=`의 exit 1과 빈 stdout/stderr가 모두 일치할 때만 인정하며, 다른 return code·경고·PID 불일치는 `migration-*-check`로 중단한다.

adversarial review hook은 성공 event에 임의 메타데이터를 싣지 않는다. 승인·거절 결과는 `status --json`과 receipt SSOT에서 확인하고, malformed review·재사용 nonce·receipt mismatch·checker mutation·stale evidence는 `SubagentStop` block으로 노출한다. 같은 change의 최신 receipt가 `REQUEST_CHANGES`이면 이전 `APPROVE`가 있어도 Stop을 차단하고, 실제 maker revision 뒤 새 evidence와 새 review를 요구한다.

## 허용된 비파괴 복구

현재 topology와 주요 agent PID/TTY를 먼저 기록한 뒤 아래 두 명령만 자동 실행할 수 있다.

```bash
cmux reload-config
python3 ~/.claude/scripts/qgate.py run --slot heavy -- cmux refresh-surfaces
```

refresh 전후에 다음을 대조한다.

- cmux PID와 시작 시각
- 보호 대상 agent PID와 TTY
- `cmux tree --all`의 surface 수와 topology hash
- 새 `Will force immediate termination`, `RenderBox`, crash, Jetsam signature
- `terminal.autoResumeAgentSessions=false`

PID가 바뀌거나 topology가 예상 없이 변하면 즉시 중단하고 snapshot과 로그만 보존한다.

## session 재개 경계

자동 대량 재개는 금지한다. 누락 session 재개가 별도 승인된 경우에도 public binding, active map, exact process identity, PTY 점유 상태가 모두 일치하는 대상만 concurrency 1로 처리한다. cmux 밖 external agent는 PID·PPID·TTY·command hash와 session/provider identity가 모두 일치해야 한다. 이미 부재한 external agent는 과거 완료된 `external-preserved` state와 완전한 predecessor migration attestation으로 복구 전 부재가 입증된 경우에만 `absent-before-recovery`로 처리하며, 다시 실행하거나 surface를 만들지 않는다. 하나라도 불일치하면 재개하지 않는다.

Codex 로그인 선택 화면이 남아 있어도 전역 인증이 정상이면 `codex login`이나 OAuth browser를 열지 않는다. 기존 정확한 process가 살아 있으면 그 process를 보존한다.

### `Allow Resume Command?` 승인

- 승인 창에서는 `Keep Manual`만 선택한다.
- `Auto-Restore`는 선택하지 않는다. `Ask Each Time`도 unattended 복구의 기본값으로 사용하지 않는다.
- `com.qjc.cmux-auto-approve-resume` 같은 자동 승인 daemon이 발견되면 해당 exact label만 disable+bootout하고, owner-only backup 뒤 저장 plist/script를 fail-closed 상태로 바꾼다.
- 창이 떠 있는 동안 `cmux ping`만 성공하고 `list-windows`/`tree`/`surface-health`가 timeout이면 앱을 종료하지 말고 창을 직접 해제한다.
- 해제 뒤 `terminal.resumeCommands`에 `policy:auto`가 생겼으면 signature나 `policy` field를 직접 바꾸지 않는다. 현재처럼 사고 레코드가 단 하나임을 확인한 경우에만 `cmux.json`을 mode 0600으로 백업하고 다음처럼 전체 approval key를 제거한다.

```bash
python3 ~/.codex/skills/cmux-settings/scripts/cmux-settings unset terminal.resumeCommands
cmux reload-config
python3 ~/.codex/skills/cmux-settings/scripts/cmux-settings get terminal.autoResumeAgentSessions
```

마지막 출력은 `false`여야 한다. 기존 approval이 여러 개면 일괄 삭제하지 말고 중단·보고한다. 새 approval은 다음 실제 재개 시 앱에서 `Keep Manual`을 선택해 다시 서명하게 한다.

## 중단 및 보고 조건

다음 중 하나라도 발생하면 자동 복구를 중단한다.

- live cmux 종료 또는 재시작이 필요해 보이는 경우
- 사용자 surface 폐쇄가 필요한 경우
- snapshot과 현재 topology UUID가 다른 경우
- exact binding, process identity, PTY 점유가 불일치하는 경우
- launchd job이 one-shot인데도 다시 나타나는 경우
- forced termination, crash, Jetsam 또는 커널 패닉 signature가 새로 발생한 경우

보고에는 발생 시각, cmux/agent PID 생존 여부, label 상태, topology 불변 여부, 비파괴 refresh 결과, 다음 승인 필요 행동을 포함한다. 토큰·시크릿·개인 session 내용은 포함하지 않는다.

## Rollback

설정 snapshot 복원이 필요해도 `terminal.autoResumeAgentSessions=false`는 유지한다. 다음 항목은 rollback하지 않는다.

- supervisor의 quit primitive
- launchd `KeepAlive`
- Auto-Restore 자동 클릭 LaunchAgent/AppleScript
- 자동 대량 session 재개
- UUID 완전 동일성을 강제하며 실패 재실행하는 watchdog
- retired recovery plist의 `uchg` 해제 또는 freeze 전 backup 복원
- retired recovery plist를 future launchd submission transport로 재사용

분석 목적으로 plist 수정이 반드시 필요한 예외에는 사용자 승인을 먼저 받고 exact path·현재 hash·disabled+unloaded label을 확인한다. 그 뒤에만 `chflags nouchg <exact-plist-path>`를 사용하며, 수정 후 `RunAtLoad=false`/`KeepAlive` 부재와 새 hash를 확인하고 `chflags uchg <exact-plist-path>`를 즉시 재적용한다.

rollback 뒤에도 `cmux ping`, PID/TTY, topology, launchd label 부재, forced termination 0건을 다시 검증한다.

## 완료 조건

- cmux와 보호 대상 agent의 PID/시작 시각이 유지된다.
- 연속 관찰에서 topology가 불변이다.
- launchd recovery label이 없고 plist에 `KeepAlive`가 없다.
- launchd user-domain disabled map에 정확한 recovery label이 `disabled`로 남아 있다.
- 저장 recovery plist가 `RunAtLoad=false`, `KeepAlive` 부재, `uchg` 상태로 유지된다.
- future submit seam은 nonce-bound 임시 plist만 exclusive 생성하고 path/device/inode/content identity, create/open/quarantine/bootstrap 직전 single-link, nonce quarantine 이동, verified FD `/dev/fd` bootstrap, partial writer·pre-bootstrap cleanup·bootstrap 성공/실패 뒤 verified inode zeroization, empty tombstone 및 late foreign replacement 보존, exact launchctl absence, watchdog receipt/PID/fresh timestamp 순서, complete fast path submit 승인 handshake, foreign 동일 label bootout 금지를 보장한다.
- `com.qjc.cmux-auto-approve-resume`가 service-not-found+disabled이며 저장 plist/script도 fail-closed다.
- unattended supervisor가 live cmux를 종료할 수 없다.
- retained hazard migration이 live owner·launchd·watchdog·target drift에서 fail-closed한다.
- 새 forced termination, crash, Jetsam signature가 없다.
- 관련 회귀 테스트와 최신 change ref의 fresh-context 적대 검증이 통과한다.
