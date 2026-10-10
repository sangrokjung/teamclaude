# Plan: 운영 런타임과 저장소 계보 정렬

STATUS: APPROVED (2026-10-09 대표 승인)
Intent: [2026-10-09-align-production-runtime](../intents/2026-10-09-align-production-runtime.md)
등급: L (9개+ 파일, 400줄+, 비가역 운영 배포 포함)

## 현황 (2026-10-09 측정)

운영 `src/`와 `qjc/resilient-routing`(691911b) 차이는 8개 파일 약 1,180줄이다. `account-manager.js`는 이미 같다.

### 운영에만 있는 것 (저장소로 옮길 대상)

| ID | 내용 | 파일 |
|---|---|---|
| A | 계정 전부 소진 시 cmux 세션 보존·복구(8커밋 묶음) | claude-recovery.js, cmux-process-guard.js, cmux-session-guards.js, cmux-session-rescue.js, config.js 기본값 1줄, 테스트 2개 |
| B | 한도 근처 계정의 오래된 사용량 재측정(`recheckStaleNearQuota`, 재측정 템플릿 영속화) | server.js |
| C | Claude Code `quota_check` 프로브에 빠진 system 마커 보정(`quotaProbeRepaired`) | server.js |
| D | 재전송 불가 요청은 SSE 헤더 지연을 하지 않음(`replaySafe`) | server.js |
| E | 런타임 진입점 판정에 소스 디렉터리 index.js·teamclaude.js 허용, 자식 환경에 `TEAMCLAUDE_PROVIDER`, 상태 프로브 30초 | index.js |
| F | Codex 감독 환경 변수 우회 8줄 | claude-wrapper.js |

### 저장소에만 있는 것 (유지, 정렬 뒤 처음 운영 반영)

| ID | 내용 |
|---|---|
| G | SSE 사용량 버퍼를 바이트 경계로 분할(9/8 응답 미종료 사고 수정) |
| H | Codex 응답에 Content-Type이 없을 때 SSE 판정(Codex 전용, Claude 풀 무영향) |
| I | 감독 상태 파일 신원 검증 강화, lsof pid 파싱 엄격화, 날짜 로캘 고정 |

## 단계

1. **A 이식**: 8커밋을 이 브랜치로 cherry-pick. README·docs 변경분은 공개 경계 스윕(내부 경로·머신명·계정 식별자) 후 포함. 충돌은 저장소 쪽 최신 코드를 기준으로 해소.
2. **B~F 이식**: 운영 파일과의 차이를 기능 단위 커밋으로 옮긴다. 저장소 쪽 G·H·I는 되돌리지 않는다. B·C·D·E는 각각 회귀 테스트를 추가한다(TDD: 운영 동작을 단언하는 실패 테스트 먼저).
3. **검증**: `npm run lint`, 대상 테스트, 전체 `npm test`를 기준선(691911b) 실패 목록과 대조, 해시 핀 게이트. Codex astra 교차 검증(L 등급이라 독립 2레인: astra + `--fallback-run` 또는 두 번째 독립 리뷰). CI 통과 후 머지.
4. **배포**: 운영 `src/`를 백업한 뒤 머지 커밋의 `src/`로 교체. 감독 활성 요청 0일 때 워커만 교체(기존 swap 절차). 감독 쪽 변경(E·I)은 다음 무중단 가능 시점에 감독 재시작으로 반영하며, 그 시점은 활성 요청 0 + 사전 공지 후.
5. **라이브 확인**: 운영 `src/` 해시가 머지 커밋과 일치, 새 워커 기동 시각, `/teamclaude/status` 정상, 교체 후 1시간 오류 로그가 교체 전 수준.

## 인수 기준

- 머지 커밋 `src/`와 운영 `src/`의 `diff -r`가 비어 있다(백업 파일 제외).
- A~F 각각에 대응 테스트가 있고 통과한다. G·H·I 기존 테스트가 통과한다.
- 전체 테스트 실패 목록이 기준선과 같거나 줄었다.
- 공개 경계 grep 스윕에서 걸리는 것이 없다.

## 범위 밖

- 미머지 PR #45(사용량 재확인 최종판)·#46·#51의 처리. 정렬 뒤 각 PR을 새 기준에 맞춰 재평가한다.
- Codex 풀(3457) 배포.

## 롤백

- 배포 전 운영 `src/` 전체를 날짜 백업 폴더에 복사한다. 문제가 생기면 백업을 되돌리고 같은 swap 절차로 워커를 교체한다.
- 저장소 쪽은 머지 커밋 revert.
