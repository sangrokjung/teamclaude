# `teamclaude cloud-feed`: 크레딧 만료 전 자동 공급·자동 머지

- Intent: docs/intents/2026-10-21-cloud-credit-feeder.md

Status: accepted
관련: `docs/specs/2026-10-18-cloud-dispatch-command.md` (PR #68)

## 목표
세션 판단 없이 launchd 주기로 일을 골라 `attemptCloudDispatch`로 보내고, 돌아온 PR을 검증해 머지한다.

## 명령
- `teamclaude cloud-feed run [--dry-run] [--max N]`: 예산 계산 → 후보 수집 → 중복 제외 → N건 디스패치.
- `teamclaude cloud-feed merge [--dry-run] [--max N]`: 보낸 브랜치의 PR을 찾아 CI·교차 검증 후 머지.
- `teamclaude cloud-feed status`: 상태 파일 요약(보냄·머지·대기·건너뜀).
- 설정 `cloudFeed.enabled`가 true가 아니면 run·merge는 아무것도 하지 않는다(킬 스위치).

## 예산(속도 조절)
- 하루 목표 = 남은 크레딧 합 ÷ 만료까지 남은 일수(최소 1일). 만료 시각 `cloudFeed.expiresAt`(기본 2026-11-05T07:59:00Z).
- 그날 처음 실행할 때 크레딧 합을 기록하고, 이후 (기록값 − 현재 합)을 오늘 쓴 금액으로 본다.
- 이번 실행 허용 건수 = min(`perRun`(기본 3), ceil((하루 목표 − 오늘 쓴 금액) ÷ `estCost`(기본 $3))). 0 이하면 보내지 않는다.
- 크레딧 조회가 하나도 안 되면 보내지 않는다.

## 후보(대표 결정 4종, 번갈아 섞음)
1. 이슈: 설정한 GitHub 소유자의 열린 이슈. `no-cloud` 라벨 제외. 키 `issue:<repo>#<n>`.
2. TDL: `os_tasks` status=todo이고 프로젝트에 `github_repo`가 있는 것(읽기 전용 조회). 키 `tdl:<id>`.
3. 리뷰: 열린 PR(디스패치 브랜치 제외). 키 `review:<repo>#<n>@<head>`.
4. 정기 개선: 로컬 클론 저장소마다 주차별로 테스트 보강·보안 점검·리팩터·문서 중 하나. 키 `improve:<repo>:<주>`.
- 저장소는 로컬 클론(설정 `roots`, 기본 `~/qjc-office`, `~/projects` 한 단계)에서 origin이 그 GitHub 저장소이고 Claude Code 신뢰 폴더인 것만 쓴다. 기준은 `origin/<기본 브랜치>`(fetch 후).
- 지시문 끝에 "이 저장소의 코드 변경이 아니면 PR 없이 끝낸다"를 붙인다.

## 중복·실패
- 상태 파일 `~/.config/teamclaude.cloud-feeder.json`(0600)에 키별 결과. exit 0·4는 다시 보내지 않는다. exit 3은 7일 뒤 재시도.

## 머지
- 상태의 exit 0 항목마다 `gh pr list --head <branch>`로 PR을 찾는다. 48시간 동안 없으면 `no-pr`로 닫는다.
- 고객 저장소(이름이 `-ax`로 끝남)는 머지하지 않고 `awaiting-owner`로 남긴다(계약 범위 밖 변경 자동 반영 방지).
- 체크가 하나라도 실패·진행 중이면 기다린다. 체크가 있으면 전부 성공해야 한다.
- `gh pr diff` → `codex-astra-review.sh --diff`로 교차 벤더 검증, APPROVE일 때만 `gh pr merge --merge --match-head-commit <head>`.
- REQUEST_CHANGES는 `changes-requested`로 남긴다(사람 판단).

## 범위 밖
- 머지 후 배포·라이브 확인(저장소별 배포 파이프라인 그대로).
- 클라우드 세션 안에서 하네스 규칙 적용(`--forward-home-settings`).

## 검증
- 단위: 예산 계산, 후보 섞기·중복 제외, 저장소 매핑, 머지 판정 분기.
- 실측: `--dry-run`으로 후보·허용 건수, 실제 run 1회, merge 1회.
