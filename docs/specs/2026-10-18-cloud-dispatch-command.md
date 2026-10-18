# `teamclaude cloud-dispatch` — 작업을 클라우드 세션에 먼저 보내기

- Intent: docs/intents/2026-10-18-cloud-first-dispatch.md

Status: accepted
관련: `docs/specs/2026-10-14-cloud-handoff-on-exhaustion.md` (PR #66)

## 목표
하네스가 큰 작업을 시작할 때 한 번 호출해 "클라우드로 보냈는가 / 로컬에서 하라"를 종료 코드로 받는다.

## 동작
`teamclaude cloud-dispatch [--cwd DIR] [--base REF] [--dry-run] [--task-file FILE|-] [--] TASK`

0. 인자 검증: 지시문은 `--task-file`(파일·stdin, 32KiB+1바이트까지만 읽음)과 위치 인자 중 한 곳에서만 받는다. 값 없는 플래그·모르는 플래그·두 출처 동시 지정은 `bad-arguments`로 거부한다. macOS가 아니면 `platform-unsupported`(런처가 BSD `script` 인자를 쓴다).
1. 지시문 검증: 비었거나 32KiB 초과, 시크릿 포함(`textHasSecret`)이면 보내지 않는다.
2. vendor 바이너리(`TEAMCLAUDE_CLAUDE_BIN` → `cloudClaudeBin` → `cloudSidecarClaudeBin`) 확인.
3. 저장소 검사(`inspectHandoffRepo`): git 저장소, origin이 github.com, HEAD 존재.
4. 폴더 신뢰 확인: Claude Code 설정(`$CLAUDE_CONFIG_DIR` 또는 홈의 `.claude.json`)에 저장소 루트 자체가 신뢰로 기록돼 있어야 한다. 처음 보는 폴더는 `--cloud`가 신뢰 확인 창에서 멈춰 링크 없이 시간 초과되기 때문이다(실측 2026-10-18: 5분 대기 후 불확실). git 저장소 안에서는 상위 폴더의 신뢰가 넘어오지 않으므로 정확히 그 폴더만 본다. 읽기 전용이다.
5. 크레딧 계정 선택(`findCloudAccount`): 디스크 설정을 다시 읽고, 비활성(`enabled: false`) 계정을 빼고, 크레딧 $1 이상·잠금 없음 계정 중 하나. 조회가 끝나지 않으면 보내지 않는다.
6. `--dry-run`이면 고른 계정만 보고 끝낸다.
7. 시작 커밋을 `teamclaude-handoff/<id>-<시각>` 브랜치로 push한다. `--base REF`가 있으면 그 커밋 그대로(작업 트리 무시, 새 작업의 기본), 없으면 HEAD에 미커밋 변경을 얹은 스냅샷(`pushHandoffSnapshot`, 진행 중이던 작업을 넘길 때). 두 경로 모두 push 전 시크릿 스캔을 거치고, 사용자 브랜치·인덱스·작업 트리는 건드리지 않는다. `-`로 시작하거나 없는 ref는 `base-not-found`.
8. `script -q <임시파일> <vendor> --cloud <지시문>`으로 세션 생성(TTY 필요, 5분 제한). 런처 출력의 `Resume with: claude --teleport session_<id>` 줄 전체가 일치할 때만 세션 생성으로 인정하고(실측 출력 2.1.302), 보낸 지시문에 있던 id는 제외한다. 임시파일은 지운다.
9. 원장 `~/.config/teamclaude-cloud-handoffs.jsonl`에 `source: "dispatch"`로 기록(토큰 미기록).

지시문은 "브랜치에서 작업하고 같은 브랜치에 push, 기본 브랜치 대상 PR, 머지 금지"를 붙인다.

## 종료 코드 계약
| exit | 뜻 |
|---|---|
| 0 | 세션 생성됨: 런처가 Resume 줄을 출력함(종료 코드와 무관) |
| 3 | 보내지 않음: 인자 오류·비 macOS·지시문 문제·vendor 없음·저장소 부적격·폴더 미신뢰·크레딧 없음·조회 미완·스냅샷/push 실패·런처 미기동 |
| 4 | 불확실: 런처는 돌았지만 링크가 없음(오류 종료·시그널·타임아웃·예외) — 로컬 중복 실행 금지 |

세션 존재를 증명하는 것은 출력된 링크뿐이다. 종료 코드 0이나 1만으로는 서버가 세션을 만들었는지 알 수 없다.
원장 기록이 실패해도 결과는 exit 0이고 `ledgerRecorded: false`로 알린다.

stdout은 JSON 한 줄(`ok`, `exit`, `reason`, `account`, `branch`, `url`)이다.

## 전송 경계 (인계·디스패치 공통, 교차 검증으로 보강)
- origin은 fetch·push URL이 각각 하나이고 서로 같아야 하며, 그 URL에 다시 적용될 `insteadOf`·`pushInsteadOf` 규칙(빈 접두사 포함)이 없어야 한다. 확인한 URL을 스캔(`ls-remote`)과 push에 그대로 쓰고, push 직전에 재작성 규칙을 다시 확인한다. 실행 도중 같은 사용자 프로세스가 git 설정을 고의로 바꾸는 경우는 위협 모델 밖이다(사이드카와 동일).
- 스냅샷은 처음 확인한 HEAD에 고정한다(조회 중 커밋이 생겨도 변경이 빠지지 않음).
- 스캐너는 새로 나가는 blob·tree(파일명)·commit·tag 객체를 모두 텍스트로 검사하고, `GIT_NO_REPLACE_OBJECTS=1`로 저장된 원본만 읽는다. push는 `--no-follow-tags --recurse-submodules=no`로 브랜치 하나만 보낸다.
- 서명 커밋: 서명 base64가 토큰처럼 보여 아직 push하지 않은 서명 커밋은 `snapshot-secret`으로 거부된다(로컬 진행). 서명 블록 예외는 구조 검사만으로는 우회가 입증돼 두지 않는다. `--base origin/<기본 브랜치>`는 이미 원격에 있는 커밋이라 검사 대상이 없어 영향이 없다.

## 범위 밖
- 클라우드 세션 결과 회수·머지 자동화(하네스 규칙이 PR을 보고 로컬에서 처리).
- Linux `script` 인자 순서(런처는 macOS 전용, 사이드카와 동일).

## 검증
- `test/cloud-dispatch.test.js`: 성공·원장, 크레딧 없음, 조회 미완, 시크릿, 부적격 입력 4종, dry-run, 실행 결과(링크 유무 분기), 비활성 계정, 원장 실패, 폴더 미신뢰, 신뢰 판정, 프롬프트, 링크 추출, 실제 pty 실행.
- 운영 실측(2026-10-18): 신뢰 폴더 실제 디스패치 exit 0·링크 회수, 미신뢰 폴더는 수정 전 5분 대기 후 exit 4 → 수정 후 즉시 exit 3.
- 운영: `--dry-run`으로 계정 선택 확인, 시험 저장소로 실제 1건 디스패치.
