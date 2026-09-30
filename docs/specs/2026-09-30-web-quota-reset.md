# 웹 리셋 후 소진 계정 재확인

Intent: ../intents/2026-09-30-web-quota-reset.md

## Goal
완전 측정된 소진 계정도 외부 리셋 후 최소 probe를 통해 자동 복귀한다.

## Non-goals
기존 PR #41의 snapshot provisional 정책, 인증 수정, 실제 리셋권 소비, Codex 변경.

## Acceptance
- 정상 template 확보·복원 직후와 기존 warm-up 주기(기본 5분)에 소진 계정을 재측정한다.
- 실제 200 또는 기존 규칙상 authoritative 429만 quota에 반영한다. 실제 429는 계속 소진으로 유지한다.
- disabled/error/auth-revoked/subscription-disabled/inflight/이미 probe 중인 계정은 제외한다.
- 기존 token refresh 소유권과 activeWarmup:false, startup-only 설정을 유지한다.
- account별 최소 1분, 기본 5분 간격으로 probe를 제한하고 종료 후 전송하지 않는다.

## Plan / Test
1. 로컬 HTTP fixture로 live/stored 100% → 외부 0% 재현 테스트를 먼저 작성한다.
2. server.js에 기존 warmupAccount(force)를 재사용하는 bounded 재확인 경로를 연결한다.
3. recovery·genuine429·비활성 계정·종료·설정 회귀, lint와 구문 검사 및 기존 targeted suite를 실행한다.
4. Claude Opus 독립 검토 후 동일 source의 운영 3456 QA, PR/필수 CI/머지를 수행한다.

## Rollback
운영 원본 파일을 백업하고 인증 drain 뒤 server.js만 교체한다. 문제가 있으면 백업본을 복원하고 같은 절차로 재시작한다.

## Verification
진행 중.
