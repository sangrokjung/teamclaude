# 메인 cmux ↔ worker Codex 세션 복구 및 재발 방지 runbook

## 목적

메인 PC의 cmux terminal에서 worker의 Codex를 사용하다가 SSH `Broken pipe`,
Codex process 종료, cmux control timeout이 함께 발생했을 때 기존 대화를 잃거나
완료된 과거 세션을 잘못 재개하지 않고 원래 cmux surface에 정확히 복구한다.

이 문서의 핵심 원칙은 다음 한 문장이다.

> worker tmux가 살아 있다는 사실과 사용자가 원래 cmux 탭에서 작업을 계속할 수
> 있다는 사실은 서로 다른 조건이며, 둘 다 증명되기 전에는 복구 완료가 아니다.

## 2026-08-11 사고에서 확인된 실패 패턴

- worker의 `qjc-codex-*` tmux와 Codex writer는 살아 있었지만 메인 SSH가
  `Broken pipe`로 끊겨 여러 cmux surface가 shell로 돌아갔다.
- 구버전 메인 launcher에는 SSH 재접속 loop가 없어 화면 연결이 자동 복구되지
  않았다.
- 조사 중 일부 과거 UUID가 사용자 의도 확인 없이 재개돼 worker 관리 세션 상한을
  점유했다. 새 tmux가 생겼다는 사실이 복구 성공으로 잘못 계산됐다.
- 메인 로컬 tmux 안의 임시 window에 worker 세션을 attach한 뒤 이를 원래 cmux
  surface 복구로 오판했다. 해당 세션은 살아 있지만 사용자의 원래 cmux 탭에서는
  보이지 않았다.
- 같은 worker tmux에 원래 cmux client와 임시 client가 함께 붙어 중복 client가
  생겼다. Codex writer는 하나였지만 입력 surface가 둘이라 운영 위험이 생겼다.
- `cmux surface resume set`은 `Allow Resume Command?` modal을 띄울 수 있다.
  modal이 열린 동안 `cmux ping`은 `PONG`이어도 `tree`, `read-screen`,
  `debug-terminals`가 timeout되고 cmux CPU가 급증했다.
- worker 세션 수, attached 수, 마지막 `task_complete`만 성공 지표로 사용하면 현재
  cmux binding이 사라진 세션과 명시적으로 재개하려던 누락 세션을 놓친다.

사고 당시 수치는 시점별로 변했으므로 고정 기대값으로 사용하지 않는다. 실제 감사
중에는 worker 20개에 main client 28개가 연결돼 중복 client 8개가 있었고, 별도로
숨은 연결과 live-ready 미충족 세션이 확인됐다.

## 용어와 완료 정의

- **native UUID**: rollout 첫 `session_meta.payload.id`에 기록된 Codex root UUID.
- **worker session**: `qjc-codex-*` 이름의 worker tmux session.
- **writer**: 해당 native rollout 파일을 쓰기 모드로 연 live Codex process.
- **visible main client**: `cmux tree --all --json`에 존재하는 terminal TTY에서
  `qjc-agent attach` 또는 `qjc-agent codex`가 실행되고, worker tmux에 연결된 client.
- **hidden main client**: 메인 로컬 tmux server 아래의 window/pane에만 존재하고
  live cmux tree의 terminal surface로는 노출되지 않은 연결.
- **duplicate client**: 같은 worker tmux에 둘 이상의 main terminal client가 붙은
  상태. writer가 하나여도 중복 client로 판정한다.

복구 완료는 다음을 모두 만족하는 상태다.

1. 보존 대상마다 exact native UUID가 하나로 확정됐다.
2. native UUID마다 writer가 정확히 하나다.
3. worker tmux마다 의도된 visible main client가 정확히 하나다.
4. hidden main client와 duplicate client가 0개다.
5. 사용자가 원래 업무 workspace의 cmux surface에서 해당 TUI를 볼 수 있다.
6. cmux control RPC와 TeamClaude proxy health가 정상이다.

## 절대 금지

1. cmux, Codex, Claude, worker tmux session을 일괄 종료하거나 재시작하지 않는다.
2. title, cwd, 최근 시각만으로 `codex resume` 대상을 고르지 않는다.
3. rollout 첫 `session_meta`와 writer 부재를 확인하기 전에 resume하지 않는다.
4. 감사 inventory를 고정하기 전에 과거 세션을 일괄 resume하지 않는다.
5. 완료된 `codex exec --ephemeral`, QA `/private/tmp`, child agent UUID를 사용자
   세션으로 복구하지 않는다.
6. 중복을 없앤다는 이유로 worker tmux session이나 Codex process를 kill하지 않는다.
   exact duplicate tmux **client만 detach**한다.
7. cmux modal이 열린 동안 `new-surface`, `send`, `surface resume set` 같은 mutation
   RPC를 추가로 보내지 않는다.
8. Accessibility daemon, AppleScript key automation, cmux 강제 종료로 modal을
   해제하지 않는다.
9. terminal 전체 scrollback을 출력하지 않는다. 필요한 마지막 화면만 제한된 줄
   수로 읽고 시크릿을 출력하지 않는다.
10. 사용자가 메인 PC에서 복사할 수 없는 상황이면 shell 명령 복사를 요구하지
    않는다. 사용자 입력이 꼭 필요하면 메모장에 전달하거나 클릭 한 번으로 제한한다.

## 0단계: mutation 동결과 시점 고정

복구를 시작하기 전에 다른 복구 실행자를 멈추고 같은 시각의 inventory를 만든다.
읽기 전용 감사 중 다른 실행자가 attach/resume/detach하면 기존 수치는 폐기하고 다시
캡처한다.

반드시 함께 기록할 항목:

- 메인 `cmux tree --all --json`, `cmux debug-terminals`
- 메인 cmux current/previous session JSON과 closed-item history
- 메인 `qjc-agent`/SSH process의 PID, PPID, TTY, command
- 메인 로컬 tmux session/window/client 목록
- worker `qjc-codex-*` tmux session/client 목록
- 각 native rollout의 첫 `session_meta`, 파일 크기, open writer PID
- worker state의 `native_session_id`, `canonical_session_id`, `status`

`cmux tree`와 process 목록은 반드시 TTY로 연결한다. worker tmux의
`session_attached=1`만으로는 그 client가 cmux에 보이는지 알 수 없다.

## 1단계: 세션을 원인별로 분류

각 후보를 아래 중 하나로만 분류한다.

| 분류 | 증거 | 기본 처리 |
|---|---|---|
| direct reaped | reaper receipt와 종료 시각, 기존 writer 소멸 | exact UUID 단일 resume 검토 |
| SSH display disconnected | worker tmux/writer 생존, main shell에 `Broken pipe` | 기존 worker tmux exact attach |
| normal completion | 명시적 사용자 종료와 더 늦은 close/repurpose | 자동 resume 금지 |
| wrongly resumed during audit | 사고 후 생성 시각, 원 lifecycle/사용자 의도 불일치 | 성공 수에서 제외, 자동 kill 금지 |
| new session after incident | 사고 시점 이후 새 native UUID | 복구 대상과 분리 |
| ephemeral/QA/child | `--ephemeral`, temp cwd, parent agent metadata | 복구 대상에서 제외 |
| unknown | 증거 충돌 또는 exact root 불명 | 보존하고 사용자 판정 대기 |

`task_complete`는 보조 신호일 뿐이다. current/previous cmux SSOT가 surface를 계속
보존하거나 사용자의 exact resume 시도가 확인되면 완료 이벤트만으로 폐기하지 않는다.

## 2단계: cmux modal과 고CPU 대응

다음 조합이면 cmux process를 죽이지 말고 modal을 의심한다.

- `cmux ping`은 `PONG`
- `cmux tree --all --json`, `read-screen`, `debug-terminals`는 timeout
- cmux CPU가 비정상적으로 높음
- process sample에 `ControlCommandCoordinator.handle` → `NSAlert.runModal`

처리 순서:

1. 모든 cmux mutation RPC 전송을 중단한다.
2. 사용자에게 cmux의 작은 확인창을 직접 `Esc` 또는 `취소`하도록 요청한다.
3. 확인창이 resume-command 승인 창이면 자동 승인을 선택하지 않는다. 기본은
   `Keep Manual`이다.
4. modal 해제 뒤 `tree`, `debug-terminals`, 제한된 `read-screen`을 다시 실행한다.
5. topology와 PID가 modal 전후 동일한지 확인한 뒤 복구를 계속한다.

`cmux surface resume set`은 live 복구와 분리된 유지보수 작업으로 취급한다. 기존
binding 교체는 modal을 띄울 수 있으므로 대량 복구 루프 안에서 호출하지 않는다.
영구 binding이 필요하면 사용자가 화면 앞에 있는 별도 maintenance window에서 한
surface씩 설정하고 즉시 RPC 정상 여부를 확인한다.

## 3단계: 살아 있는 worker session을 원래 surface로 이동

SSH만 끊긴 세션은 resume하지 않는다. 기존 worker tmux를 exact name으로 attach한다.

1. 원래 cmux surface가 shell 상태이고 TTY가 live인지 확인한다.
2. worker session의 writer=1, client=1인지 확인한다.
3. 원래 surface에서 `qjc-agent attach <exact-worker-session>`을 실행한다.
4. worker client가 일시적으로 2개가 된 것을 확인한다.
5. 새 client의 main TTY가 원래 cmux surface TTY와 일치하는지 확인한다.
6. 기존 hidden/temporary client의 exact worker TTY만 detach한다.
7. worker session이 `attached=1`, writer=1로 돌아왔는지 확인한다.

detach 전후 invariant:

```text
before: exact session, attached=2, writer=1, visible client=1, hidden client=1
action: hidden client TTY 하나만 tmux detach-client
after:  exact session, attached=1, writer=1, visible client=1, hidden client=0
```

precondition이 하나라도 다르면 detach하지 않는다. 특히 `tmux kill-session`,
`kill-pane`, `kill <codex-pid>`는 이 절차에 없다.

## 4단계: worker writer가 없는 exact session 복구

다음 조건을 모두 만족할 때만 새 writer 하나를 만든다.

1. 첫 `session_meta.payload.id`가 대상 native UUID와 정확히 일치한다.
2. main과 worker transcript가 모두 있으면 크기/hash가 일치한다.
3. 양쪽 rollout open writer가 0개다.
4. source workspace와 worker route가 exact하게 결정된다.
5. 같은 canonical UUID의 live worker tmux가 없다.
6. QA, ephemeral, child-agent session이 아니다.
7. worker resource gate와 관리 세션 상한에 여유가 있다.

transcript가 worker에 없으면 main의 안전한 import 경로를 먼저 사용한다. 복사 뒤 첫
metadata와 파일 무결성을 다시 검증한다. `codex resume <UUID>`에는 자동 prompt를
덧붙이지 않는다.

worker는 첫 main client가 붙기 전 agent 시작을 기다릴 수 있다. detached tmux가
존재한다는 이유만으로 writer가 시작됐다고 보고하지 않는다. 실제 `running` state와
writer=1을 확인해야 한다.

## 5단계: visible surface와 hidden local tmux 구분

다음 두 조건이 모두 있어야 visible 복구다.

- `cmux tree --all --json`의 surface에 main terminal TTY가 존재한다.
- 그 TTY의 foreground process가 exact `qjc-agent`/SSH chain으로 worker tmux에
  연결된다.

main 로컬 tmux server의 pane TTY 아래에서만 `qjc-agent attach`가 보이면 hidden
연결이다. window title이 원래 cmux tab과 같아도 visible 복구로 세지 않는다. hidden
연결을 임시 접근 경로로 사용했다면 exact cmux surface가 연결된 뒤 client만
detach한다.

## 6단계: 완료 게이트

아래 검증이 모두 통과하기 전에는 “전체 복구 완료”라고 말하지 않는다.

- [ ] `cmux ping`, `tree`, `debug-terminals`, 제한된 `read-screen`이 timeout 없이 응답
- [ ] cmux PID가 유지되고 modal/`NSAlert.runModal` block이 없음
- [ ] 보존 대상 전체가 `direct reaped / SSH disconnected / completed / wrongly resumed / new / unknown`으로 분류됨
- [ ] 보존 대상마다 exact native UUID와 main surface ref/TTY가 기록됨
- [ ] native rollout writer가 각각 정확히 1개
- [ ] worker tmux client가 대상마다 정확히 1개
- [ ] visible main client가 대상마다 1개, hidden client 0개
- [ ] duplicate client 0개, duplicate writer 0개
- [ ] 조사 중 잘못 resume된 세션을 성공 수에 포함하지 않음
- [ ] worker 관리 세션 상한이 실제 누락 복구를 막지 않음
- [ ] TeamClaude proxy `3456`과 `3457` status가 HTTP 200
- [ ] 새 `qjc-agent` 연결의 SSH 재접속 loop가 배포본에서 활성
- [ ] reaper는 기본 dry-run이며 보호 session을 apply 대상으로 잡지 않음
- [ ] 전체 terminal scrollback, credential, token을 증거에 출력하지 않음

최종 수치는 한 시점의 immutable snapshot에서 계산한다. 감사 중 topology가 바뀌면
이 게이트를 처음부터 다시 실행한다.

## 지속적 재발 방지

- 메인 launcher는 SSH exit 255에서 같은 `QJC_CLIENT_ATTACH_ID`와 exact worker
  session으로 재접속하고, 신호 종료나 정상 tmux detach에서는 loop를 끝낸다.
- worker는 session name뿐 아니라 native/canonical UUID와 transcript 첫 metadata를
  검증한다.
- reaper는 기본 dry-run을 유지하고 apply 시점에도 attached/activity/canonical
  identity를 원자적으로 재검증한다.
- transcript 크기 guard는 실제 운영 상한과 fixture/test 상한을 동기화한다.
- 정기 감사에서는 worker session 수가 아니라 `visible surface ↔ main TTY ↔ worker
  client ↔ native UUID ↔ writer` 1:1 관계를 확인한다.
- cmux resume-command binding과 GUI approval은 무인 자동화하지 않는다.
- 복구 도중 생성된 임시 surface/local tmux window/client는 별도 ledger에 기록하고,
  exact 원본 연결이 검증된 뒤 client만 정리한다.

## 관련 문서

- [cmux renderer 및 agent session 안전 복구](./cmux-renderer-session-recovery.md)
- [Codex provider and exact-session recovery](./codex-provider-session-recovery.md)
- [Claude Code post-dispatch 502 대응](./ambiguous-dispatch-502.md)
