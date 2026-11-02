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
- 증분: 상태는 `~/.local/state/cc-menubar/model-usage.sqlite`. jsonl은 파일별 (inode, size, mtime, 오프셋)을 기억해 붙은 줄만 읽고, 줄이 끝나지 않은 꼬리는 다음 회차로 미룬다. 파일이 줄었거나 inode가 바뀌었거나, 오프셋 바로 앞 4KB 지문이 달라졌으면(같은 inode 재작성) 처음부터 다시 읽는다(중복 키가 막는다). 영수증은 파일 mtime이 바뀐 것만 다시 읽고, `*.codex-{astra,sol}.log` mtime이 바뀌면 같은 run_id의 tokens만 다시 읽는다(실행 수는 그대로). 수집 시작 시각보다 늦게 붙은 줄도 그 회차에 센다(시각으로 거르지 않는다 → 오프셋만 넘어가 누락되는 일이 없다). 상태 형식이 바뀌면(stateVersion) 남은 로그로 다시 모은다.
- 중복 제거: Claude는 `message.id:requestId`, Codex는 `세션 id:시각:누적 토큰`을 키로 한 번만 센다. 영수증은 `run_id`로 한 번만 센다(같은 run_id 사본 여럿 → 1회).
- Hermes: state.db는 세션·모델별 누적값만 준다. 직전 누적값과 관측 시각을 상태 DB에 두고 늘어난 몫만 쌓는다. 늘어난 구간(직전 관측 → 이번 last_seen, 처음 보면 세션 시작 → last_seen)이 하루 안이면 그날로, 자정을 넘으면 호출별 시각이 없어 날마다 나눌 수 없으므로 `undated`로 따로 낸다(일별·기간 합계에 넣지 않는다).
- 구현 루프: 실행(폴더)마다 날짜·라운드 수를 상태 DB에 남긴다. 원장이 지워져도 남긴 집계는 그대로고, 같은 실행의 라운드가 늘면 그 값으로 바꾼다.
- 주기 이력: 메뉴바는 창마다 최근 256개만 남긴다. 수집기는 주기마다 안정 식별자로 상태 DB에 쌓고, 파일이 상한까지 찼는데 가장 오래된 주기를 처음 보면 그 다음 날을 `completeFrom`으로 올린다. 화면은 그 앞 날을 0이 아니라 빗금(모름)으로 그리고 합계 문장에 경계 날짜를 붙인다.
- 보존: 한번 모은 날짜별 합계는 원본 로그가 지워져도 남는다. 기록이 빈 구간은 `coverage`에 밝힌다. Claude는 "수집기 첫 실행일 − cleanupPeriodDays(없으면 30)"의 다음 날부터 온전하다고 본다.
- 출력: `~/.local/state/cc-menubar/model-usage.json`(원자적 쓰기, 0600). 스키마 `schema: 1`:
  - `generatedAt`(ISO), `today`(로컬 날짜), `since`(첫 날짜)
  - `coverage`: `claudeCompleteFrom`, `claudeRetentionDays`, `codexCliLastDay`, `receiptFirstDay`
  - `daily[]`: `date, lane(claude|codex|other), model, source(claude-code|codex-cli|hermes), input, output, cacheRead, cacheWrite, calls`
  - `undated[]`: `lane, model, source, input, output, cacheRead, cacheWrite, calls`(날짜 불명 몫)
  - `receipts`: `audit{jsonFiles, dupRunId, uniqueRuns}`, `daily[]{date, runs, tokens, reviewSec}`
  - `implLoop.daily[]{date, runs, rounds}`
  - `pro200`: `{mid, lo, hi, weeks, samples, excluded}` 또는 null(산출 불가). "Pro 1주(사용률 100%) ≈ 비캐시 토큰" 추정. Codex CLI 응답마다 (resets_at 초, 사용률, 그 응답의 비캐시 토큰)을 남긴다. 같은 계정의 resets_at은 응답마다 몇 초씩 흔들려(실측) 5초 안으로 이어지는 값들을 한 계정의 한 창으로 본다. 창마다 첫 관측 뒤 토큰 ÷ (최고 − 첫 사용률)만 표본이다. 사용률이 5%p 넘게 되돌아가는 창(리셋 시각이 가까운 다른 계정이 섞임)과 변화가 5%p 미만인 창은 뺀다(동시 요청 순서로 생기는 1~3%p 되돌림은 허용). 표본을 ISO 주로 묶어 주마다 합친 값을 내되 표본 토큰이 5천만 미만인 주는 뺀다(이 맥 CLI가 거의 안 쓴 주의 사용률은 다른 소비자 몫). 남은 주 값의 중앙·최소·최대를 쓴다. 표본 창이 3개 미만이면 null. 한계: 같은 계정을 이 맥 밖에서 쓴 몫은 사용률에만 들어가 기준값을 낮춘다.
  - `quotaCycles`: `since`(처음 남은 날), `completeFrom`(온전한 첫날, 잘림이 없었으면 null), `daily[]{date, window(5h|7d), cycles, exhausted}`(Claude 레인)
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
