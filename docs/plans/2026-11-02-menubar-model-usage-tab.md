# Plan: 메뉴바 "모델" 탭
- Spec: docs/specs/2026-11-02-menubar-model-usage-tab.md
- STATUS: APPROVED (대표 2026-11-03 승인, 변경 규모 L등급. 적대 검증 6라운드 REQUEST_CHANGES 잔여 지적은 대표 결정으로 후속 이슈 처리)

## Task 1: 수집기 (TDD)
- `menubar/Tests/test_model_usage_collector.py`: 증분(두 번째 실행 읽은 바이트 0, 줄 덧붙임만 읽음, 끝나지 않은 줄 보류), Claude 중복 제거, 영수증 run_id 중복 제거, Codex 누적 토큰 증분, 기록 공백(coverage), 개인정보 미포함.
- `scripts/model-usage-collector.py`: sqlite 상태, jsonl 증분 리더, 출처별 집계, Pro 200 추정, 풀 status 읽기, 원자적 쓰기, `--install`.

## Task 2: 표시 로직 (Swift, main.swift 없이 컴파일)
- `menubar/Sources/ModelUsage.swift`: JSON 파싱, 기간·지표 계산, 출처 합계·주별, 날짜별 쌓기, 모델 합계, Pro 환산, 공백 판정.
- `menubar/Tests/ModelUsageTests.swift`.

## Task 3: 탭 화면
- `menubar/Sources/ModelUsageTabView.swift`: 그리기·세그먼트 클릭·높이.
- `DashboardTab.model`, L10n 한/영, `StatusMenuDashboardView`에 모델 탭 문서, AppDelegate 로더(백그라운드 읽기), 스냅샷 픽스처 `modelUsage` 경로, QA 키 6.

## Task 4: 문서·테스트 갱신
- `menubar/DESIGN.md`(탭 6개), README 영/한, run-tests 연결, 스냅샷 로케일 테스트.

## 완료 조건
spec A1–A6. 커밋까지(PR·머지·운영 설치는 메인 세션).
