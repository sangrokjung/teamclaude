# Spec — 상류 실패 후 클라이언트 재시도를 다른 계정으로 돌리기 (upstream-failure steer-away)

- 날짜: 2026-09-16 · 등급: M (계약/흐름 변경, 3파일+테스트) · 대상: 운영 teamcodex 프로즌 런타임 계보(아티팩트 `119e2ead…` src 기준)
- 관련: `test/server-529.test.js`(무재전송 불변식), 메모리 `codex-capacity-watchdog-particle-fix`(근본 원인 = 프록시 503 무재전송), 커밋 `1bc8c2c fix: prevent hidden replay of ambiguous posts`

## 문제

Codex CLI가 `■ stream disconnected before completion: An error occurred while processing your request … request ID …`로 턴을 잃는다(`Reconnecting… 5/5` 뒤). 2026-09-16 22:38~22:52 KST 실측: hub 풀에서 유일하게 usable한 계정(sangrok@)이 상류에서 503(`server_overloaded`)·스트림 중 `error` 이벤트·429 global을 연달아 받았고, 메인·studio2·studio3 모두 같은 문구로 실패했다. `testacountqjc`를 풀에 되돌리자(SIGHUP 리로드) 새 연결의 요청은 즉시 성공했다 → 계정 특정 상류 장애였다.

경로: 프록시는 dispatch 이후의 5xx / 스트림 실패를 **재전송하지 않고 통과**시킨다(중복 실행·과금 방지 불변식). 클라이언트(CLI)는 스스로 최대 5회 재시도하지만, 그 재시도는 ① 같은 keep-alive 소켓 → 연결 affinity가 같은 계정에 고정 ② 새 소켓 → sticky primary가 같은 계정. 즉 실패한 계정에 다섯 번 다시 간다. 5xx는 계정 상태를 바꾸지 않으므로(설계) 회피 장치가 전혀 없었다.

## 결정

무재전송 불변식은 유지한다. 대신 **실패를 통과시킨 계정을 `upstreamFailureAvoidMs`(기본 30s) 동안 부드럽게 회피**하고 **그 연결의 affinity를 끊는다**. 클라이언트의 자체 재시도가 다른 계정에 떨어지게 하는 것이 목적이다.

- 트리거 4곳(server.js): ① RETRYABLE 5xx after unsafe POST dispatch ② 스트림 pre-data 실패 after dispatch ③ 네트워크 오류 after dispatch ④ 상류가 스트림을 `error`/`response.failed` 터미널로 끝낸 경우(프록시 주입 오류 제외)
- `AccountManager.noteUpstreamFailure(account, affinityKey, avoidMs, reason)`: `avoidUntil` 갱신(연장만, 단축 없음), affinity 홈이 그 계정이면 삭제, 최초 1회 로그
- `_tryAcquire`: affinity 홈이 회피 중이면 무시 → 회피 계정을 exclude에 더해 1차 선택(sticky primary 불변) → 실패 시 회피 없이 2차 선택(단일 계정 풀·전부 capped 시 그대로 서빙). 홈 재지정 시 회피 중인 홈은 "usable"로 보지 않아 재시도가 성공한 계정으로 옮겨 앉는다
- `SseFramer.terminalEvent`(구조 파싱·raw 스캔 양쪽) → `streamResponse` outcome.terminalEvent. codex 모드는 recovery가 꺼져 있어도 `terminalObserver`가 채운다
- 상태 필드·영속화 없음(`getStatus`/quota 스냅샷 불변 — 대시보드 소비자 3곳 배선 불필요)

## 비목표

- 프록시 내부 재전송(불변식 변경) — 하지 않음. 필요 시 별도 결정
- 429 global 15분 내부 쿨다운 동작 변경 — 범위 밖(별도 관찰 항목)
- 풀 용량 문제(usable 1/7)는 이 변경으로 해결되지 않는다. 대안 계정이 없으면 이전과 동일하게 실패한다

## 수용 기준 / 검증

- 기존 `server-529.test.js` 등 무재전송·무독성 테스트 전부 유지
- `test/server-upstream-failure-avoid.test.js`: (a) anthropic 503 통과 후 같은 소켓의 재요청이 다른 계정 (b) codex SSE `error` 터미널 중계 후 같은 소켓 재연결이 다른 계정, 상류 히트 정확히 2회(숨은 재전송 0) (c) 단일 계정 풀은 계속 그 계정으로 서빙(프록시측 429 아님) (d) `upstreamFailureAvoidMs: 0`이면 종전 동작
- `test/account-manager-avoid.test.js`: 회피·만료·단일 계정 폴백·capped 대안 시 폴백·affinity 삭제/재지정·타 연결 불간섭·연장만
- 전체 스위트는 워커(studio3)에서 실행, 독립 적대 리뷰 1레인 후 `teamcodex-manual-rollout.py`로 롤아웃(스트림 카나리 포함)

## 계보 메모 — 기존 "dispatch failure cooldown" 테스트와의 관계

HEAD 테스트 스위트에는 `am.markDispatchFailureCooldown()` / `dispatchFailureCooldownUntil`을 요구하는 테스트 8개("… cools the failed account before a client retry", "dispatch failure cooldown temporarily excludes an account without persisting health state")가 있다. 이 API는 커밋 115e1e7 / 3f59067(하드 쿨다운: 선택·`_recoverSoonest`에서 제외, `getStatus().usable=false`)에서 왔고, 운영 아티팩트로 src를 되돌린 restore 커밋 74e60fc에서 소스만 사라지고 테스트만 남았다. 운영 src(119e2ead)와 master 모두 이 API가 없으므로 그 8개는 베이스 커밋 53dff95에서도 동일하게 실패한다(본 변경과 무관한 기존 불일치).

본 변경이 하드 쿨다운 대신 **소프트 회피**를 택한 이유: 2026-09-16 hub 풀은 usable 1/7이었다. 하드 제외는 단일 usable 계정의 재시도를 프록시 429로 바꿔 놓지만, 소프트 회피는 대안이 있을 때만 옮기고 없으면 종전과 같이 같은 계정으로 재시도한다. 두 계약을 하나로 합치는 일(그 8개 테스트를 살릴지, 폐기할지)은 별도 결정 항목으로 남긴다.

## 검증 기록 (2026-09-16 23:30~00:10 KST, 워커 studio2/3)

- 새 테스트: `account-manager-avoid` 8개 + `server-upstream-failure-avoid` 4개 전부 통과(studio2, node 25.6). 계측 재현 2종(503 통과 후 같은 소켓 재요청 → 다른 계정, codex `error` 터미널 중계 후 재연결 → 다른 계정) 20ms 내 완료, 상류 히트 정확히 [tok-a, tok-b].
- 전체 스위트(파일 단위, 파일당 240s alarm): base(53dff95, studio2) vs patched(1279277, studio3)의 FAIL 집합이 **한 건만 제외하고 동일**. 그 한 건(`server-429 :: stalled unsafe retry returns 502 …`)은 studio3(node 26.3)에서만 나타났고, 같은 호스트(studio2)에서 base·patched를 각 3회 돌리면 결과가 동일(26 ok / 3 notok, 기존 실패 3건만)해 호스트·타이밍 요인으로 판정. `warmup.test.js`는 base·patched 모두 alarm에 걸려 종료(기존 hang).
- 기존 실패 85건은 HEAD 테스트가 운영 아티팩트 src에 없는 기능(auth-revoked 격리·provider-config·Grok·fleet 재개·hard dispatch cooldown 등)을 요구하는 lineage 불일치로, 본 변경과 무관.
- 롤아웃 dry-run: 런타임 검증 OK, 롤백 아티팩트 OK, 스트림 카나리 3/3 PASS(타깃 해시 a0309895…).
