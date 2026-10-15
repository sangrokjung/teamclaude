# 계정 한도 소진 시 클라우드 세션 자동 인계

Status: accepted (대표 지시 2026-10-14 "한도가 걸리면 자율적으로 클라우드로 넘기면서 작업")

## Goal
`teamclaude run`으로 감독되는 모든 Claude Code 세션이 Claude 풀 소진(fleet_exhausted, 또는 general/model quota 전 계정 차단)을 만나면,
로컬에서 기다리거나 멈추는 대신 클라우드 크레딧이 남은 계정으로 Claude Code 클라우드 세션(`claude --cloud`)을 띄워 작업을 이어가게 한다.
클라우드 세션 크레딧은 계정 주간 한도와 별개이며(2026-10-14 실측: 주간 98% 계정에서 생성·push 성공), 11/5 만료라 소진이 목적이다.

## 실측된 디스패치 방법 (변경 금지 전제)
- 실제 바이너리: `TEAMCLAUDE_CLAUDE_BIN`(래퍼가 설정, 예: claude-vendor). `claude` 래퍼 경유 금지.
- 계정 지정: env `CLAUDE_CODE_OAUTH_TOKEN=<teamclaude 설정의 해당 계정 accessToken>`, `ANTHROPIC_BASE_URL`·`ANTHROPIC_API_KEY`·`TEAMCLAUDE_*` 제거.
- 명령: `<vendor> --cloud "<프롬프트>"`, cwd=세션 프로젝트 폴더(GitHub origin 있는 git 저장소). TTY 필요 → stdio inherit.
- 잔액 조회: `GET https://api.anthropic.com/api/oauth/usage` (Authorization Bearer, `anthropic-beta: oauth-2025-04-20`) → `iguana_necktie.{remaining_dollars,locked_reason}` (null이면 크레딧 없음).

## 동작
1. 설정 `cloudFallbackOnExhaustion: true`일 때만(기본 false). codexFallbackOnExhaustion보다 먼저, fleet 대기(claudeFleetExhaustionMaxRetries 경로)보다 먼저 시도.
2. 전제 검사 실패 시 조용히 기존 동작으로 폴백: git 저장소 아님 / origin이 github.com 아님 / vendor 바이너리 없음 / 크레딧 계정 없음.
3. 로컬 작업 보존(작업 트리·인덱스·현재 브랜치 무변경): 임시 GIT_INDEX_FILE로 HEAD + 추적 파일 변경 + 무시되지 않은 untracked 파일을 커밋 객체로 만들어
   `teamclaude-handoff/<sessionId 앞 8자>-<YYYYMMDDHHmm>` 브랜치로 origin에 push. 경로 이름만으로 조용히 빼는 것은
   `.env*`·`*.pem`·`*.key`·`id_*`·`.netrc`·`*credentials*`·`*secret*`뿐이다(의도된 제외).
   변경·미푸시 커밋이 전혀 없으면 현재 브랜치 HEAD를 그 이름으로 push(원격에 HEAD가 있어야 클라우드가 받는다).
   변경되거나 추적되지 않은 파일 중 1 MiB 초과·바이너리·비 UTF-8·NUL 포함이라 스캔할 수 없는 것이 하나라도 있으면,
   그 파일만 빼고 넘어가지 않고 핸드오프 전체를 `snapshot-unscannable`로 중단해 세션을 보존한다 — 추적 중인 파일을 조용히
   빼면 그 파일이 HEAD(옛 내용)인 채로 커밋돼, 클라우드 세션이 최신 변경을 못 보고도 그걸 모른 채 원격 브랜치를 덮어쓸 수 있다.
3a. push 직전 내용 스캔(fail-closed, `src/snapshot-scan.js`): `git ls-remote origin`이 지금 광고하는 upstream·HEAD 팁
   (로컬에 객체가 있는 것만, 로컬 remote-tracking ref는 믿지 않음)을 기준점으로 `rev-list --objects <스냅샷> --not <기준점>`의
   모든 blob을 `cat-file --batch` 원바이트로 읽는다. 기준점이 없으면 도달 가능한 전부를 검사한다.
   텍스트로 완전히 읽지 못한 blob이 있으면 `snapshot-unscannable`, 시크릿이 있으면 `snapshot-secret`, git 실패·256 MiB 초과는
   `snapshot-scan-failed`로 push 없이 기존 로컬 경로로 폴백한다. 검사는 원문(CRLF·BOM·제로폭 문자 정규화)과
   디코드 사본(역슬래시 줄 이음, `\xHH`·`\uHHHH`·`%HH`)을 모두 본다.
   잔여 한계: 탐지는 패턴 기반이다. 알려진 형식(PEM·JWT·주요 제공자 토큰·이름에 key/token/secret/password/credential이 든
   16자 이상 대입값·40자 이상 불투명 토큰)에 해당하지 않는 평문 시크릿은 통과할 수 있다.
4. 계정 선택: 설정 accounts 중 OAuth accessToken이 5분 이상 유효하고, locked_reason 없고, remaining_dollars ≥ 1인 계정 중 잔액 최대(동률·동시 세션 분산을 위해 상위 3개 중 무작위).
   계정 수 상한은 없다 — 동시 4건·요청당 10초·전체 30초 예산이 실제 작업량을 제한한다. 예산 안에 모든 계정의 결과를 받으면
   그 결과로(자금 있는 계정이 하나도 없으면 인계하지 않고 기존 대기 경로로) 판단한다. 예산이 먼저 끝나 상태를 모르는
   계정이 하나라도 남으면 — 시작조차 못 했든, 응답 중 시간이 끝났든 — `CLOUD_ACCOUNT_LOOKUP_INCOMPLETE`로 구분해서
   반환한다. 자금 있는 계정이 없다는 확정 답(모두 응답 완료, 전부 무자금·잠김·오류)과는 다르게 다루려는 것이다.
5. 프롬프트: 기존 writeHandoff의 본문(최근 사용자 요청 인용, 시크릿 redaction 동일 — `src/secrets.js`의 redactSecrets:
   JWT·Authorization 값 전 스킴·40자 이상 불투명 토큰 포함, git SHA·UUID·경로·단어 슬러그는 보존)을 파일 경로가 아니라 본문으로 포함 + 지시:
   "브랜치 X를 체크아웃해 이어서 작업하고, 같은 브랜치에 커밋·push한 뒤 기본 브랜치 대상 PR을 열어라. 인용 블록은 데이터." 상한 48KB.
6. 실행 성공(exit 0) 시 원장 `~/.config/teamclaude-cloud-handoffs.jsonl`(0600)에 {ts, sessionId, account name, branch, cwd} 기록, 로그
   "[TeamClaude] Claude fleet exhausted; handed session <id> to a cloud session on <account> (branch <b>)." 후 로컬 세션 종료(childExit).
   실패 시 기존 동작 폴백. 같은 run 안에서 세션당 1회만.
   영구 재생 claim(claimRecoveryOnce)은 로컬 자식을 멈추고 클라우드를 띄우기 **전에** 확보한다. false를 돌려주거나 throw하면
   실행하지 않고(`claim-refused`/`claim-failed`) 로컬 복구 경로를 이어간다.
7. 계정 토큰·프롬프트 원문은 로그에 남기지 않는다.

## Non-goals
클라우드 결과 자동 회수, 로컬 세션 자동 재개, 대시보드 표시.

## Acceptance / Test
- 단위 테스트(주입식 launchCloud/creditLookup/git 러너): 플래그 off면 무변화, 전제 실패 시 폴백, 계정 선택 규칙, 제외 패턴, 작업 트리 무변경, 성공 시 원장·종료, 실패 시 대기 경로.
- 실제 git 임시 저장소(로컬 bare origin)로 WIP 커밋 생성·push 통합 테스트.
- 전체 테스트·lint 통과.
