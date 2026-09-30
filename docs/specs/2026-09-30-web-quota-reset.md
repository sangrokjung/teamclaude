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
- 저장된 template 모델의 modelWeekly 전용 소진도 재확인한다. 다른 모델 template로 그 제한을 임의 해제하지 않는다.
- 미래 rateLimitedUntil은 존중하며 만료 후 다음 warm-up 주기에 재확인한다.
- 복원된 모델 전용 template은 하위 모델의 새 template으로 교체되어도 재확인용으로 보존한다. 일반 quota는 최신 template으로 재측정한다.
- 보존 template은 quota snapshot에도 함께 저장해 재시작 후에도 모델별 재확인을 이어간다.

## Plan / Test
1. 로컬 HTTP fixture로 live/stored 100% → 외부 0% 재현 테스트를 먼저 작성한다.
2. server.js에 기존 warmupAccount(force)를 재사용하는 bounded 재확인 경로를 연결한다.
3. recovery·genuine429·비활성 계정·종료·설정 회귀, lint와 구문 검사 및 기존 targeted suite를 실행한다.
4. Claude Opus 독립 검토 후 동일 source의 운영 3456 QA, PR/필수 CI/머지를 수행한다.

## Rollback
운영 원본 파일을 백업하고 인증 drain 뒤 server.js만 교체한다. 문제가 있으면 백업본을 복원하고 같은 절차로 재시작한다.

## Verification
PR #41 병합 완료(9560285). 기존 5개 웹 리셋 회귀와 provisional/부분 측정 관련 표적 7개 통과.

추가 적대 조사에서 modelWeekly 전용 소진 누락과 미래 throttle 중 probe 가능성을 발견해 보완했다. 모델 일치·불일치 및 throttle 유지·만료 회귀를 추가했다.

2026-09-30 최초 Claude Opus 호출은 실제 `All 17 accounts exhausted` 응답으로 실패했다. Codex 보조 검토 후 격리 canary에서 실제 재측정으로 가용 계정 0→2 복귀를 확인했다. CLI wrapper가 canary 주소를 덮어써 같은 장애로 재호출되는 문제를 확인하고 기존 vendor 실행 파일과 인증으로 Opus 검증을 수행했다.

Opus는 복원된 Fable template이 하위 모델로 교체될 때 modelWeekly 재확인이 사라지는 경로를 지적했다. 해당 template을 메모리에 별도 보존하고 회귀 테스트를 추가했다. 최신 교차 검증/운영 반영은 아래 실행 기록으로 갱신한다.
