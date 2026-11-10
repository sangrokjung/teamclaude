# 막힌 Claude 계정 "다시 확인" (recheck)

- Intent: docs/intents/2026-11-10-claude-access-recheck.md

Status: APPROVED (M등급, 위임 범위 안, 2026-11-10)

## 문제

2026-11-10 메뉴바 "손볼 것"에 한 계정이 `조직차단 · 조직이 구독을 막아 둠 · 재인증으로 풀리지 않음`으로 떠 있었다.
실측(1토큰 요청 + `/api/oauth/profile`) 결과 Anthropic 응답은 403 `oauth_not_allowed_for_organization`, 조직의
`subscription_status`는 `past_due`(결제 연체)였다. 같은 403이 조직 차단과 결제 연체 두 원인을 덮는데 화면은 조직 차단만
말했고, 버튼은 "구독 확인"(기록 대화상자)뿐이었다. 운영 프록시에는 `subscriptionDisabled` 깃발을 자동으로 푸는 경로가
없어, 결제한 뒤에도 사람이 CLI로 깃발을 지워야 했다.

## 목표

- `teamclaude recheck <name> [--account-uuid U] [--json]`: 1토큰 요청으로 지금 접근 가능한지 보고, 403이면 프로필의
  `subscription_status`로 결제 연체(`past_due`·`unpaid`·`incomplete*`)와 조직 차단을 가른다.
  - ok(2xx·429) → `subscriptionDisabled` 해제, 실행 중 서버에 리로드 통지
  - 결제 연체·조직 차단 → 깃발 유지(없으면 설정)
  - 401 → 재인증 안내, 토큰 만료 임박 → 잠시 뒤 재시도 안내, 그 외 → 판단 보류(설정 불변)
  - 종료 코드 0/2/3/4/5/6, `--json`은 outcome 한 줄
- 메뉴바 손볼 것의 접근 차단 계정 버튼을 "다시 확인"(주 버튼)으로 바꾸고, 결과에 따라
  해제 후 표 갱신 / claude.ai 결제 화면 열기 / 재인증 창 열기 / 안내만.
- 상태 라벨 "조직차단" → "접근차단", 사유 문구는 결제 연체 가능성을 함께 말한다.

## 비목표

- 서버가 403을 받아 자동으로 깃발을 세우거나 주기적으로 재확인하는 일(별도 작업).
- status 응답에 결제 상태 필드 추가(소비자 배선 비용 대비 이득이 작다. 결과는 버튼을 누를 때 보인다).
- CLI에서 토큰 갱신(갱신 토큰 체인은 실행 중 서버가 소유한다. 두 갱신 주체는 경쟁한다).

## 검증

- `test/subscription-recheck.test.js`: outcome 분류 11건(2xx·429·401·403+past_due·403+active·403+프로필 실패·
  만료 임박·네트워크·기타 상태·템플릿 재생·설정 변경 규칙·종료 코드).
- `menubar/Tests/TeamClaudeRecheckTests.swift`: CLI 결과→화면 동작, 결제 URL 도메인 제한, 인자 거부, 중복 클릭.
- 실계정 실측: 결제 연체 상태에서 403/past_due 확인, 결제 후 `recheck --json` → `ok`, HTTP 200.
