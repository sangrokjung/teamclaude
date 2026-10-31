# API 키 크레딧 계층 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anthropic 모드 API 키 계정(`type: 'apikey'`)을 구독 계정 뒤의 유료 계층으로 돌리고, 충전 금액 대비 추정 지출·남은 금액을 기록·표시하며, 크레딧 소진 거절을 감지해 그 키를 영속적으로 빼고 요청은 다음 계정으로 넘긴다.

**Architecture:** 설정 필드(`creditUsd`·`creditSince`·`creditExpiresAt`·`creditExhausted`)는 `config.accounts[]`에 두고, 추정 지출 원장(`quota.apiSpendUsd`·`apiUnpricedTokens`·`apiSpendSince`)은 quota 스냅샷에 둔다. 계층은 기존 Codex 크레딧 계층의 `_creditTier`·정렬 구조를 일반화한다. Claude Code 요청은 `_isAvailable`의 잠금(서빙 가능한 OAuth 계정이 하나라도 있으면 API 키 불가), `/byok` 통로는 정렬 계층 반전(API 키 먼저)으로 구현한다. 단가표는 새 순수 모듈 `src/api-pricing.js`. 거절 감지는 `src/server.js`의 403 처리 바로 뒤(400·402)와 429 처리 안(지출 한도)에 둔다.

**Tech Stack:** Node 18+ ESM(의존성 0, `node:test`), Swift/AppKit 메뉴바(`menubar/run-tests.sh`).

**Spec:** `docs/specs/2026-10-31-ultra-session-and-api-credits.md` B1~B10 (A파트는 PR #85로 머지됨)

## Global Constraints

- 런타임 의존성 추가 금지. 새 전역을 쓰면 `eslint.config.js` globals에 추가.
- Codex 모드 동작 불변: 새 분기는 모두 `provider === 'anthropic' && type === 'apikey'`로 한정한다. Codex 크레딧 테스트 전량 통과.
- 키 값·키 일부는 상태 응답·CLI·TUI·메뉴바·로그 어디에도 싣지 않는다(테스트로 스캔).
- 추정 잔액은 계정을 막지 않는다. 실제 거절(B7)만 막는다.
- 공개 저장소: 픽스처 키는 `test-key-1` 같은 값, 계정 이름은 `api-1`·`sub-1`.
- 한국어 문서·주석에 줄표 삽입구 금지. 메뉴바 문구는 `L10n.t(한국어, 영어)`.

## Decisions (구현 중 확정)

- **CLI 진입점:** `teamclaude api <path>`는 이미 원시 API 호출 명령이다. 경로 인자가 없거나 첫 인자가 `--`로 시작하면 키 등록(기존 `login --api` 프롬프트)으로 보낸다. 기존 `api <path>` 사용은 그대로 동작하고, `login --api`도 `--credit`·`--expires`를 받는다.
- **소진 표현:** `creditExhausted: { reason, at }` 영속 플래그 + `status: 'error'`, `errorReason: 'credit-exhausted'`(구독 차단 플래그와 같은 방식). 타이머·리셋·`enable`·`_recoverSoonest`·토큰 갱신 어느 것도 되살리지 않는다. `_isAvailable`은 플래그를 따로 한 번 더 본다.
- **요청 단위 "모두 인증 실패" 판정**에서 `credit-exhausted`는 제외한다(전부 소진된 API 키 풀이 "재로그인 필요" 401을 내지 않게).
- **원장 재설정:** `apiSpendSince`가 계정의 `creditSince`와 다르면(스냅샷 복원·설정 재적용) 원장을 0부터 다시 센다.
- **B8:** API 키 계정 요청에 한해 `anthropic-beta`에서 `oauth-`로 시작하는 토큰만 뺀다. 남는 토큰이 없으면 헤더째 뺀다. 실제 키 실측은 운영 반영 단계(대표).
- **단가표:** 출처를 댈 수 있는 모델만 기본값에 넣는다. 모르는 모델은 unpriced. 운영자는 `config.apiPricing`으로 보정.

## Review Focus

1. Codex 크레딧 계층 일반화가 Codex 정렬·잠금 동작을 바꾸지 않는가(기존 `codex-credits` 테스트).
2. OAuth 계정이 동시성 한도로만 꽉 찼을 때 Claude Code 요청이 API 키로 새지 않고 대기하는가.
3. 크레딧 거절 감지 후 같은 키로 재시도하지 않고, 대안이 없으면 기존 429/continuity로 떨어지는가.
4. 재시작·SIGHUP 재적용 뒤에도 소진 플래그가 유지되고, `api-credit` 재설정만 해제하는가.
5. 키 값이 status·CLI·TUI 출력에 없다.

---

### Task 1: 단가표 모듈 `src/api-pricing.js` (B5)

**Files:** Create `src/api-pricing.js`, `test/api-pricing.test.js`

- [ ] RED: 모델 정규화(날짜·`[1m]`·`-v1:0`·`-latest` 접미), 가장 긴 접두 일치(숫자 버전 경계는 넘지 않음: `claude-opus-4`가 `claude-opus-4-8`을 잡지 않음), 비용 손계산 예제(입력·출력·캐시 5분/1시간·읽기, `cache_creation` 분리 필드 우선), 모르는 모델 → `priced: false` + 토큰 합계, `config.apiPricing` 덮어쓰기(부분 입력은 입력 단가 배수로 캐시 단가 보충, 잘못된 값 무시).
- [ ] GREEN: `resolveApiPrice(model, overrides)`, `computeApiCost(usage, model, overrides)` → `{ priced, usd, tokens }`.

### Task 2: 계정 크레딧 상태와 원장 (B1·B4·B6·B9 일부)

**Files:** Modify `src/account-manager.js`, Test `test/api-credit.test.js`

- [ ] RED: 생성자·`addAccount`가 크레딧 필드를 정규화해 읽는다. `creditExhausted` 설정은 `status: 'error'`, `errorReason: 'credit-exhausted'`. `recordApiSpend(account, usage, model)`는 Anthropic API 키 계정에만 쌓는다. 스냅샷 왕복, `creditSince` 변경 시 원장 0. `setCreditExhausted(ref, reason)`·`clearCreditExhausted` 영속 훅(`onAccountCreditFlag`). `_recoverSoonest`·`setEnabled`가 되살리지 않는다. `getStatus()`의 `credit` 블록(키 없음).
- [ ] GREEN.

### Task 3: 유료 계층 선택 (B3)

**Files:** Modify `src/account-manager.js`, Test `test/api-credit-tier.test.js`

- [ ] RED: OAuth 서빙 가능 → API 키 미선택(동시성 한도로 꽉 찬 OAuth도 서빙 가능으로 셈, `acquireAccount`가 대기). OAuth 전부 쿼터 소진·스로틀·비활성·오류 → API 키 선택. 모델별 소진(Fable 주간)이면 원래 모델로 API 키. OAuth 없는 풀 → 지금처럼. `/byok` 범위(`scope.byok`) → API 키 먼저, 없거나 소진이면 OAuth. API 키끼리 만료 임박 → 추정 잔액 적은 순 → 배열 순. Codex 모드 정렬 불변.
- [ ] GREEN: `_isPaidApiKey`, `_anySubscriptionServable`, `_creditTier` 일반화, `_tierCompare`(정렬·`_strictlyPrefer`·동률 판정 공용), `getActiveAccount`의 byok 우회.

### Task 4: 서버 배선 (B4·B7·B8, byok 범위)

**Files:** Modify `src/server.js`, Test `test/server-api-credit.test.js`

- [ ] RED: 비스트리밍·스트리밍 성공 응답이 원장에 쌓인다(응답 모델 기준). 400 `credit balance is too low`·400 `reached your specified API usage limits`·429 `enforced_spend_limit_reached`·402 `billing_error` → 소진 영속 + 다음 계정 재시도, 클라이언트는 오류를 보지 않는다. 대안 없으면 기존 429. 감지되지 않는 400은 그대로 전달. API 키 요청의 `anthropic-beta`에서 `oauth-` 토큰만 빠진다(OAuth 요청은 그대로). byok 요청은 API 키 먼저. `authFailedForRequest`에서 `credit-exhausted` 제외.
- [ ] GREEN.

### Task 5: CLI (B2·B10 CLI)

**Files:** Modify `src/index.js`, Test `test/api-credit-cli.test.js`

- [ ] RED: `api --name N --credit 50 --expires 2026-12-31`(키는 stdin, 출력에 없음)이 설정에 `creditUsd`·`creditSince`·`creditExpiresAt`를 쓴다. `api-credit <name> 50 [--expires ...|none]`은 `creditSince` 갱신·`creditExhausted` 제거, `clear`는 필드 제거. codex 모드 거부. `syncAccountsFromDisk`가 크레딧 필드·소진 플래그 양방향 적용·원장 재설정. 키 교체 시 소진 해제. CLI `status`의 `credit ~$12.30 left of $50.00 (est.)`, `[credit exhausted]`, 만료일, 키 문자열 부재.
- [ ] GREEN. `index.js`에서 서버의 `onAccountCreditFlag` 영속 배선.

### Task 6: TUI (B10 TUI)

**Files:** Modify `src/tui.js`, Test `test/tui.test.js`

- [ ] RED: API 키 행 세 번째 칸에 `$12.3/50`·`out` 같은 짧은 크레딧 표기, 좁은 폭에서는 뒤에 붙인다. 키 문자열 부재.
- [ ] GREEN.

### Task 7: 메뉴바 (B10 메뉴바)

**Files:** Modify `menubar/Sources/*` (상태 디코딩·Claude 탭·개요·L10n), Tests `menubar/Tests/*`

- [ ] RED: 상태의 `credit` 블록 디코딩(없음·null 허용), API 키 계정은 Claude 탭 구독 아래 "API 크레딧" 묶음, 행마다 남은 금액 막대(추정 표기)·만료일·소진 라벨, 개요의 사용 가능 집계 구독/API 분리, 한·영 문구.
- [ ] GREEN.

### Task 8: 마무리

- [ ] `test/test_model_recovery_gate.py`의 `ACCOUNT_MANAGER_SHA256` 핀·`docs/evidence/codex-model-recovery-account-manager.md` SHA 갱신(커밋 136321f 관례).
- [ ] `CLAUDE.md` Account selection·상태 필드 절에 유료 계층·크레딧 블록을 짧게 기록.
- [ ] 원격 워커 전체 테스트·메뉴바 테스트·빌드, lint.
