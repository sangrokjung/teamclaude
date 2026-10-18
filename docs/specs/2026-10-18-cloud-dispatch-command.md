# `teamclaude cloud-dispatch` — 작업을 클라우드 세션에 먼저 보내기

- Intent: docs/intents/2026-10-18-cloud-first-dispatch.md

Status: accepted
관련: `docs/specs/2026-10-14-cloud-handoff-on-exhaustion.md` (PR #66)

## 목표
하네스가 큰 작업을 시작할 때 한 번 호출해 "클라우드로 보냈는가 / 로컬에서 하라"를 종료 코드로 받는다.

## 동작
`teamclaude cloud-dispatch [--cwd DIR] [--dry-run] [--task-file FILE|-] [--] TASK`

1. 지시문 검증: 비었거나 32KiB 초과, 시크릿 포함(`textHasSecret`)이면 보내지 않는다.
2. vendor 바이너리(`TEAMCLAUDE_CLAUDE_BIN` → `cloudClaudeBin` → `cloudSidecarClaudeBin`) 확인.
3. 저장소 검사(`inspectHandoffRepo`): git 저장소, origin이 github.com, HEAD 존재.
4. 크레딧 계정 선택(`findCloudAccount`): 디스크 설정을 다시 읽고, 크레딧 $1 이상·잠금 없음 계정 중 하나. 조회가 끝나지 않으면 보내지 않는다.
5. `--dry-run`이면 고른 계정만 보고 끝낸다.
6. 미커밋 변경을 포함한 스냅샷을 `teamclaude-handoff/<id>-<시각>` 브랜치로 push(`pushHandoffSnapshot`, 시크릿 스캔 포함). 사용자 브랜치·인덱스는 건드리지 않는다.
7. `script -q <임시파일> <vendor> --cloud <지시문>`으로 세션 생성(TTY 필요, 5분 제한). 출력에서 `https://claude.ai/code/...` 링크를 뽑고 임시파일은 지운다.
8. 원장 `~/.config/teamclaude-cloud-handoffs.jsonl`에 `source: "dispatch"`로 기록(토큰 미기록).

지시문은 "브랜치에서 작업하고 같은 브랜치에 push, 기본 브랜치 대상 PR, 머지 금지"를 붙인다.

## 종료 코드 계약
| exit | 뜻 |
|---|---|
| 0 | 세션 생성됨(정상 종료, 또는 비정상 종료라도 세션 링크가 출력됨) |
| 3 | 보내지 않음: 지시문 문제·vendor 없음·저장소 부적격·크레딧 없음·조회 미완·스냅샷/push 실패·생성 실패가 확실함 |
| 4 | 불확실: 시그널 종료·타임아웃·예외 — 로컬 중복 실행 금지 |

stdout은 JSON 한 줄(`ok`, `exit`, `reason`, `account`, `branch`, `url`)이다.

## 범위 밖
- 클라우드 세션 결과 회수·머지 자동화(하네스 규칙이 PR을 보고 로컬에서 처리).
- Linux `script` 인자 순서(런처는 macOS 전용, 사이드카와 동일).

## 검증
- `test/cloud-dispatch.test.js`: 성공·원장, 크레딧 없음, 조회 미완, 시크릿, 부적격 입력 4종, dry-run, 실행 결과 5분기, 프롬프트, 링크 추출, 실제 pty 실행.
- 운영: `--dry-run`으로 계정 선택 확인, 시험 저장소로 실제 1건 디스패치.
