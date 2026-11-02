# Spec: 메뉴바 "모델" 탭과 모델 사용량 수집기

- Intent: docs/intents/2026-11-02-menubar-model-usage-tab.md
- Plan: docs/plans/2026-11-02-menubar-model-usage-tab.md
- 등급: M (파일 4~8개 신규·수정, 새 데이터 계약)
- 시각 기준: 웹랩 시안 b안 2차 수정본의 패널 탭 구성. 시각 토큰은 `menubar/DESIGN.md`가 정본이다.

## 목표
1. 로컬 기록에서 모델 사용량을 모으는 증분 수집기(`scripts/model-usage-collector.py`, Python 표준 라이브러리만)를 둔다.
2. 메뉴바 패널에 6번째 탭 "모델"(Models)을 더해 수집 결과 JSON만 읽어 그린다.

## 비목표
- 메뉴바 프로세스 안에서 세션 로그를 읽지 않는다(수집기 몫).
- 토큰을 달러로 바꾸지 않는다. 구매 판정·권고 문구를 넣지 않는다.
- 수집기 LaunchAgent를 자동 설치하지 않는다(`--install`을 사람이 실행).
- 프록시·기존 탭·기존 수집기(구독) 동작은 바꾸지 않는다.

## 수집기 계약
- 입력(읽기 전용): Claude Code `~/.claude/projects/**/*.jsonl`·`~/.claude-pure/projects/**/*.jsonl`, Codex `~/.codex/sessions/**/*.jsonl`·`~/.codex/archived_sessions`, 적대 검증 영수증 `~/.claude/cache/codex-review/*.json`(+같은 이름 `*.codex-{astra,sol}.log`의 "tokens used"), 구현 루프 `~/.claude/cache/codex-impl-loop/*/ledger.json`, Hermes `~/.hermes*/state.db`(sqlite 읽기 전용), 메뉴바 주기 이력 `~/.codex/cache/cc-menubar-quota-history-v1.json`, 프록시 status `http://127.0.0.1:3456|3457/teamclaude/status`.
- 증분: 상태는 `~/.local/state/cc-menubar/model-usage.sqlite`. jsonl은 파일별 (inode, size, mtime, 오프셋)을 기억해 붙은 줄만 읽고, 줄이 끝나지 않은 꼬리는 다음 회차로 미룬다. 파일이 줄었거나 inode가 바뀌면 처음부터 다시 읽는다(중복 키가 막는다). 영수증은 파일 mtime이 바뀐 것만 다시 읽는다.
- 중복 제거: Claude는 `message.id:requestId`, Codex는 `세션 id:시각:누적 토큰`을 키로 한 번만 센다. 영수증은 `run_id`로 한 번만 센다(같은 run_id 사본 여럿 → 1회).
- 보존: 한번 모은 날짜별 합계는 원본 로그가 지워져도 남는다. 기록이 빈 구간은 `coverage`에 밝힌다. Claude는 "수집기 첫 실행일 − cleanupPeriodDays(없으면 30)"의 다음 날부터 온전하다고 본다.
- 출력: `~/.local/state/cc-menubar/model-usage.json`(원자적 쓰기, 0600). 스키마 `schema: 1`:
  - `generatedAt`(ISO), `today`(로컬 날짜), `since`(첫 날짜)
  - `coverage`: `claudeCompleteFrom`, `claudeRetentionDays`, `codexCliLastDay`, `receiptFirstDay`
  - `daily[]`: `date, lane(claude|codex|other), model, source(claude-code|codex-cli|hermes), input, output, cacheRead, cacheWrite, calls`
  - `receipts`: `audit{jsonFiles, dupRunId, uniqueRuns}`, `daily[]{date, runs, tokens, reviewSec}`
  - `implLoop.daily[]{date, runs, rounds}`
  - `pro200`: `{mid, lo, hi}` 또는 null(Codex CLI 7일 창 관측으로 낸 "Pro 1주 ≈ 비캐시 토큰" 추정)
  - `quotaCycles`: `since`, `daily[]{date, window(5h|7d), cycles, exhausted}`(Claude 레인)
  - `pools.claude|codex`: `available, threshold, accounts[]{label(C01·X01 순번), util7d, reset7d(ms), usable, enabled}`
- 결과에 넣지 않는 것: 이메일, 계정 이름·UUID, 토큰, 프롬프트·응답 내용, 작업 경로.
- 실행: `python3 scripts/model-usage-collector.py [--out PATH] [--state PATH] [--home PATH] [--since YYYY-MM-DD]`, `--install`은 구독 수집기와 같은 qgate 경유 LaunchAgent(`com.qjc.cc-model-usage`, 1시간)를 만든다.

## 화면 계약 (탭 "모델")
- 조작: 기간 7일·14일·전체, 지표 호출·출력 토큰·전체 토큰. 고른 값은 갱신·재구성 뒤에도 유지한다.
- 큰 숫자 두 칸: Claude(고른 지표, 앞 기간 대비. 앞 기간 기록이 온전하지 않으면 비교하지 않는다고 밝힘), Codex 주당 Pro 200 환산(추정 배지, 범위, CLI 로그가 끊긴 뒤 기간이면 하한 배지).
- 출처별 5줄: Claude Code·Codex CLI(응답), Codex 적대 검증·구현 루프(실행), Hermes(호출). 토큰 없는 구현 루프는 "토큰 없음 · 횟수로만". 줄마다 주별 막대(자기 눈금).
- 날짜별: Claude 지표 막대(모델별 쌓기), Codex 비캐시 토큰 막대(출처별 쌓기). Claude 기록이 빈 날은 빗금, CLI 로그가 끊긴 뒤 날은 빗금(하한).
- 모델별: 상위 6개, 점유율·값·앞 기간 대비.
- 계정 풀 주간 사용률: TeamClaude·TeamCodex 계정별 7일 막대, 98%부터 amber, 라우팅에서 빠진 계정은 흐리게.
- Claude 5시간 소진 이력: 날짜별 주기 수 중 소진 주기 쌓기.
- 기록 공백이 기간에 걸리면 amber 점 경고 한 줄.
- 수집 결과가 없으면 "수집 전" 안내와 실행 명령을 보인다(오류 아님).

## 수용 기준
- A1 수집기는 표준 라이브러리만 쓰고, 두 번째 실행에서 새 줄이 없으면 jsonl 본문을 다시 읽지 않는다(테스트: 읽은 바이트 0).
- A2 Claude 같은 메시지가 두 파일에 있어도 1회, 영수증 run_id 사본 3개도 1회.
- A3 결과 JSON에 이메일·계정 이름·UUID·토큰 문자열이 없다(테스트가 픽스처 값을 grep).
- A4 기록 공백(coverage)이 계산되고 화면이 빗금·경고로 그린다.
- A5 탭 6개, 숫자 키 6, 스냅샷(`--dashboard-snapshot`)에 모델 탭이 그려지고 영어 화면에 한글 0자.
- A6 기존 menubar 테스트 신규 실패 0.

## 검증 방법
- `python3 menubar/Tests/test_model_usage_collector.py`
- `bash menubar/run-tests.sh`(qgate default 슬롯), 스냅샷 `menubar/.build/cc-menubar --dashboard-snapshot <fixture> out.png --tab model`
