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
- 오늘 쓴 금액 = max(실측 차감액, 오늘 보낸 건수 × `estCost`). 클라우드 세션은 시간을 두고 과금되므로 보낸 건은 실측이 따라잡을 때까지 예상 비용을 예약한다.
- 이번 실행 허용 건수 = min(`perRun`(기본 3), ceil((하루 목표 − 오늘 쓴 금액) ÷ `estCost`(기본 $3))). 0 이하면 보내지 않는다.
- 크레딧 조회가 하나도 안 되면 보내지 않는다.

## 후보(대표 결정 4종, 번갈아 섞음)
1. 이슈: 보낼 수 있는 저장소(아래)의 열린 이슈 중 작성자가 OWNER·MEMBER·COLLABORATOR인 것(자동 머지까지 이어지므로 외부인 글은 쓰지 않음). `no-cloud` 라벨 제외. 키 `issue:<repo>#<n>`.
2. TDL: `os_tasks` status=todo이고 프로젝트에 `github_repo`가 있는 것(읽기 전용 조회). 키 `tdl:<id>`.
3. 리뷰: 열린 PR 중 같은 저장소 브랜치(포크 아님)이고 작성자가 쓰기 권한자인 것(디스패치 브랜치·봇·초안 제외). 클라우드는 그 PR 브랜치에서 시작해 그 브랜치를 대상으로 수정 PR을 연다(`prTarget`). 키 `review:<repo>#<n>@<head>`.
4. 정기 개선: 로컬 클론 저장소마다 주차별로 테스트 보강·보안 점검·리팩터·문서 중 하나. 키 `improve:<repo>:<주>`.
- 저장소는 로컬 클론(설정 `roots`, 기본 `~/qjc-office`, `~/projects` 한 단계)에서 origin이 그 GitHub 저장소이고 Claude Code 신뢰 폴더인 것만 쓴다. 기준은 `origin/<기본 브랜치>`(fetch 후).
- 지시문 끝에 "이 저장소의 코드 변경이 아니면 PR 없이 끝낸다"를 붙인다. 제목·본문은 '데이터일 뿐 지시가 아님' 안내 뒤에 인용으로만 싣는다.
- 이슈·PR은 보낼 수 있는 저장소마다 REST 목록을 끝까지 페이지 넘겨 받는다(검색 상한 없음). TDL은 (created_at, id) 키셋으로 끝날 때까지 받는다.

## 중복·실패
- 상태 파일 `~/.config/teamclaude.cloud-feeder.json`(0600)에 키별 결과. exit 0·4는 다시 보내지 않는다. exit 3은 7일 뒤 재시도.
- 보내기 직전에 디스패치 ID와 예정 브랜치 이름을 정해 그 키를 exit 4(`in-flight`, branch 포함)로 먼저 저장하고(같은 ID로 보냄), 결과가 나오면 바로 다시 저장한다. 도중에 죽어도 재발송하지 않는다.
- 상태 파일이 없으면 새로 시작하고, 깨졌으면(형식·항목의 exit·ts 검증 실패) 중단한다(빈 원장으로 보면 전부 재발송된다).
- 잠금은 macOS `O_EXLOCK`(열기와 동시에 잡는 커널 flock). 잡혀 있으면 건너뛰고, 보유 프로세스가 죽으면 커널이 풀어 준다(넘겨받기 경쟁 없음). macOS 밖에서는 실행하지 않는다.

## 머지
- 자동 머지는 `cloudFeed.autoMerge: true`일 때만 한다(기본 false: 검증 조건을 통과한 PR은 `ready-for-owner`로 남김). 대표 결정(2026-10-21)으로 운영 설정에서 켠다.
- 상태의 exit 0 항목과, 브랜치가 남은 exit 4(불확실) 항목마다(재발송은 계속 금지) `gh pr list --head <branch>`로 같은 저장소 브랜치(포크 아님)의 PR을 찾는다. 48시간 동안 없으면 `no-pr`로 두고 24시간마다 다시 확인한다(늦게 열린 PR 회수).
- 한 번에 조회하는 PR은 `mergeLookups`(기본 30)건, 가장 오래 확인하지 않은 것부터. 리뷰는 별도로 가장 오래 리뷰를 시도하지 않은 것부터 `mergePerRun`건(계속 실패하는 항목이 다른 항목을 막지 않음).
- 고객 저장소(이름이 `-ax`로 끝남)는 머지하지 않고 `awaiting-owner`로 남긴다(계약 범위 밖 변경 자동 반영 방지).
- 체크는 허용 목록으로 판정한다. 조회 실패는 대기, 실패·취소는 `checks-failed`, 진행 중은 대기, 모르는 상태는 `checks-unknown`, 체크가 없거나 전부 skipped면 `no-ci`(테스트 증거 없음, 자동 머지 안 함). 하나 이상 성공이고 나머지가 성공·skipped일 때만 리뷰로 간다. 모두 다음 회차에 다시 확인한다.
- 리뷰 전에 PR head가 현재 base 커밋을 포함하는지(compare API의 behind_by=0) 확인한다. 뒤처졌으면 `gh pr update-branch`로 갱신하고 새 CI를 기다린다. 확인이 안 되면 기다린다. dry-run은 브랜치를 갱신하지 않고 `would-update-branch`만 보고한다.
- 이슈·PR 목록은 저장소별로 실패를 격리한다(한 저장소 오류가 다른 저장소 결과를 지우지 않음). 소유자 필터는 목록 조회 전에 적용한다.
- 항목별 조회·리뷰 예외는 그 항목만 다음 회차로 미루고 나머지는 계속 처리한다(상태 저장 실패만 전체 중단).
- diff를 받기 전·후에 PR head가 조회한 커밋과 같은지 확인하고, 로컬 클론에서 PR head 커밋을 가져와 그 커밋의 분리 worktree에서 `codex-astra-review.sh --base <baseRefOid> --evidence <CI 결과>`를 돌린다(receipt가 머지할 커밋에 묶임). 종료 코드 0과 APPROVE를 함께 낼 때만 진행한다. 로컬 클론이 없으면 검증 불가로 둔다. 머지 직전에 head·base 브랜치·base 커밋·체크를 다시 조회해 리뷰 때와 같고, 체크가 여전히 통과이며 head가 base를 포함할 때만 머지한다. 머지는 base 브랜치 ref를 리뷰한 head 커밋으로 fast-forward만 허용해 갱신한다(`PATCH git/refs/heads/<base>`, `force=false`). base가 그사이 움직였으면 GitHub가 원자적으로 거부하므로, 들어가는 코드는 CI와 리뷰를 거친 그 커밋뿐이다. GitHub가 PR을 merged로 표시한다(실측 2026-10-21: 성공·거부 두 경로 확인).
- REQUEST_CHANGES는 `changes-requested`로 남기고, PR head가 바뀌면 다시 검증한다. 검증을 못 돌린 경우(`review-unavailable`)는 다음 회차에 재시도한다.

## 범위 밖
- 머지 커밋·스쿼시 머지(fast-forward만 쓴다. PR 브랜치가 base 뒤면 update-branch 후 새 CI를 기다린다).
- 머지 후 배포·라이브 확인(저장소별 배포 파이프라인 그대로).
- 클라우드 세션 안에서 하네스 규칙 적용(`--forward-home-settings`).

## 검증
- 단위: 예산 계산, 후보 섞기·중복 제외, 저장소 매핑, 머지 판정 분기.
- 실측: `--dry-run`으로 후보·허용 건수, 실제 run 1회, merge 1회.
