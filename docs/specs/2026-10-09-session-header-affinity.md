# 세션 ID 기반 계정 고정 (prompt cache 보존)

## Goal

같은 Claude Code 세션의 연속 요청을 같은 계정에 보내 prompt cache 재사용률을 높인다.

## 배경 (2026-10-09 실측)

- 대화형 세션 7일치에서 2분 안에 이어진 요청 47,693건 중 6.9%가 캐시를 전혀 재사용하지 못했다. 이 미스가 입력 비용의 약 31%다.
- 간격별 미스율: 2초 미만 5.2%, 5~10초 9.6%, 10초~5분 11~14%. 5초를 넘으면 뛴다.
- 원인: affinity 키가 `req.socket`이다. keep-alive 연결이 끊기면(Node 기본 5초) 같은 세션도 새 연결로 취급되어 use-or-lose 선택으로 다른 계정에 갈 수 있다.
- Claude Code 2.1.295는 `/v1/messages`마다 `x-claude-code-session-id` 헤더를 보낸다(캡처 서버로 확인).

## 변경

`server.js`: `x-claude-code-session-id`가 `^[A-Za-z0-9._:-]{1,128}$`이면 그 세션 ID에 대응하는 키 객체를 affinity 키로 쓴다. 헤더가 없거나 형식이 다르면 지금처럼 `req.socket`을 쓴다. 키 객체는 최근 사용 순 상한 10,000개 Map에 두어 메모리가 무한히 늘지 않게 한다. affinity 판정 규칙(`AccountManager._tryAcquire`)은 바꾸지 않는다.

## Non-goals

- warm-up 중 affinity 해제 규칙 변경. 검토했으나 운영에서 `_isWarmupTarget`은 5시간·주간 창이 모두 비어야 생겨 드물고, 바꾸면 cold-start warm-up이 한 계정에 고정되는 회귀가 생겨(`server-supervisor` 테스트) 제외했다.
- keep-alive 타임아웃 변경(헤더 키로 Claude Code 경로는 해결된다).
- 요청별 계정 로그 추가.
- Codex provider 경로 변경(헤더가 없어 기존 동작 그대로).

## Acceptance

- A1: 같은 세션 헤더의 요청은 연결이 달라도 같은 계정으로 간다. 이때 헤더 없는 새 연결은 다른(더 나은) 계정으로 간다.
- A2: 형식이 잘못된 헤더는 무시되고 요청은 정상 처리된다.
- A3: 키 Map은 상한을 넘지 않고, 가장 오래 안 쓴 키부터 버린다.
- A4: 기존 affinity·warm-up·supervisor 테스트는 그대로 통과한다.

## 위험

- 같은 세션의 병렬 서브에이전트 요청이 home 계정에 먼저 몰린다. 상한(cap)에 닿으면 기존 soft affinity 규칙대로 다른 계정으로 넘친다.

## Test

`test/concurrency.test.js`에 A1·A2·A3 테스트 추가.
