# 웹 리셋 후 소진 계정 재확인

Intent: ../intents/2026-09-30-web-quota-reset.md

## Goal
완전 측정된 소진 계정도 외부 리셋 후 최소 probe를 통해 자동 복귀한다.

## Non-goals
인증 정책 변경, 실제 리셋권 소비, Codex reset 정책 변경, 별도 quota reserve 기능.
기본 브랜치 이식은 PR #41의 snapshot provisional 정책과 PR #44의 재측정을 함께 포함한다.

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
PR #41 병합 완료(9560285). PR #44에서 modelWeekly 재확인과 복원 template 영속화를 보완했다(64a7ab0).

추가 적대 조사에서 modelWeekly 전용 소진 누락과 미래 throttle 중 probe 가능성을 발견해 보완했다. 모델 일치·불일치 및 throttle 유지·만료 회귀를 추가했다.

2026-09-30 최초 Claude Opus 호출은 실제 `All 17 accounts exhausted` 응답으로 실패했다. Codex 보조 검토 후 격리 canary에서 실제 재측정으로 가용 계정 0→2 복귀를 확인했다. CLI wrapper가 canary 주소를 덮어써 같은 장애로 재호출되는 문제를 확인하고 기존 vendor 실행 파일과 인증으로 Opus 검증을 수행했다.

Opus는 복원된 Fable template이 하위 모델로 교체될 때 modelWeekly 재확인이 사라지는 경로를 지적했다. 해당 template을 메모리에 별도 보존하고 회귀 테스트를 추가했다. 최신 교차 검증/운영 반영은 아래 실행 기록으로 갱신한다.

### 최종 실행 기록 (2026-09-30)
- 기본 브랜치 이식본에서 `node --test --test-concurrency=1 test/account-manager.test.js test/warmup.test.js test/web-quota-reset.test.js`: 98/98 통과. `npx eslint src/ test/`, `node --check src/account-manager.js`, `node --check src/index.js`, `node --check src/server.js`, `git diff --check` 통과. 별도 build 단계 없음. 전체 suite는 qgate에 제출했으나 호스트 부하로 결과 대기 중이다.
- 최신 운영 PR #44에 대한 Claude Opus(`claude-opus-5-5`) 최종 적대 검토는 APPROVE였다. 기본 브랜치 이식본에 대한 재검토 호출은 Claude 주간 한도(`You've hit your weekly limit`, 2026-10-05 리셋)로 실패해 이 이식본의 교차 벤더 상태는 UNVERIFIED로 유지한다.
- 운영 설치본의 `src/server.js`만 백업 후 교체. SHA256 `66ea858be5a45b535e9b07d78625f7ba0f5f639de6582a62e16f415a4afd333a`. PR 전체 소스를 덮어쓰지 않고 기존 운영 기능을 유지했다.
- drain activeRequests=0 후 listener/launchd PID `10882` 일치, 총 17개 중 가용 0→2 복구, 두 계정 weekly=0 확인.
- 운영 `POST /v1/messages` 실제 QA: HTTP 200, model `claude-opus-5-5`, text `OK`.
- 후속 PR: https://github.com/sangrokjung/teamclaude/pull/44 (PR #41과 동일 base).

### 기본 브랜치 후속 적대 검토 (2026-10-01)
- Codex 대체 검토가 provisional+rejected 429, 미래 throttle 복원/자동 probe 우회, 실제 model snapshot 재시작, stale quota 기반 retry-after 결함을 발견해 수정했다.
- rejected 429에서만 유효한 utilization 초과값을 1로 정규화하며 모델 소진은 모델 범위로 유지한다. 미래 throttle은 복원하고 일반 자동 probe의 공통 제외 조건을 적용했다. 수동 R과 구독 전용 복구는 별도 경로를 유지한다.
- model quota 숫자 대신 재측정할 label을 snapshot에 보존한다. 보존 template을 startup probe와 model top-up에서 사용한다. public status의 `quotaPendingWindows`는 라우팅/대기시간 계산의 미검증 window를 나타낸다.
- 핵심 회귀 HTTP/단위 테스트 107/107 통과. 확대 145건 실행에서는 55ms deadline을 쓰는 기존 model-fallback 2건이 dispatch timeout으로 502를 반환했다. 동일 model-fallback suite 단독 실행은 12/12 통과했다. 테스트의 429 기대를 502로 완화하거나 제품의 unsafe POST timeout 처리를 변경하지 않았다.
- Claude Opus 재검토는 결과 JSON/오류 출력이 없는 장기 무응답으로 종료했다. Codex `reset_revision_adversarial`은 최신 수정에서 추가 HIGH/CRITICAL 기능 결함을 확정하지 못했으나 교차 벤더 승인이 아니므로 UNVERIFIED다. 최신 CI 및 Claude 검토 전 머지하지 않는다.
