# Codex ChatGPT 계정별 모델 호환성 자동 복구

Status: Approved for implementation by the 2026-08-31 incident request.

## Problem

TeamCodex는 여러 ChatGPT OAuth 계정을 회전하지만, Codex upstream의 완결된
`400` 응답이 현재 선택 계정에서 요청 모델을 지원하지 않는다는 exact JSON을
반환해도 일반 오류처럼 그대로 Codex CLI에 전달합니다. 그 결과 다른 계정이나
검증된 대체 모델이 정상이어도 현재 turn이 종료됩니다. 화면까지 도달한 동일
오류는 `codex_502_watchdog.py`의 허용 목록에도 없어 자동 continuation이 없습니다.

## Goal

완결된 exact unsupported-model 거절만 계정·모델 조합에 한정해 임시 격리하되,
거절된 원본 POST는 proxy 안에서 재전송하지 않습니다. 예방 경계를 통과해 TUI가
빈 prompt에 멈춘 경우에는 기존 checkpoint·stale·draft·중복 검사를 유지한 watchdog이
새 recovery turn을 bounded하게 보냅니다. 이 새 POST가 다음 OAuth 계정을 사용하고,
모든 OAuth 계정이 격리된 뒤에는 dispatch 전 검증된 fallback model로 전환합니다.

## Non-goals

- ambiguous transport/5xx 이후의 원본 `POST /codex/responses`를 재전송하지 않습니다.
- API-key 인증, 일반 400/401/403/429, quoted prose, malformed JSON을 호환성 신호로
  해석하지 않습니다.
- Codex 내부의 중단된 계산을 복원한다고 주장하지 않습니다. 저장된 대화에 새 turn을
  append하는 기존 recovery 계약만 유지합니다.
- account entitlement를 공개 model catalog 또는 account 이름으로 추측하지 않습니다.
- source Claude 설정 파일을 수정하지 않습니다.

## Decision and alternatives

1. **선택: proxy account/model quarantine + 새 continuation의 configured fallback.** 계정을
   실제로 선택한 proxy만 account-scoped 거절을 정확히 귀속할 수 있습니다. 다만 완결된
   400 body만으로 upstream의 무실행을 증명할 수 없으므로 원 POST는 그대로 반환합니다.
   durable dedupe를 거친 watchdog의 새 continuation POST만 다음 계정을 사용하며, 전 계정
   격리 시 그 새 요청의 dispatch 전에 fallback을 적용합니다.
2. **기각: 전역 기본 모델을 Terra로 영구 강등.** Sol을 지원하는 계정까지 사용하지 못하며
   계정별 원인을 숨깁니다.
3. **기각: watchdog만 `/model`을 입력.** TUI command와 recovery message의 2단 send 사이에
   race가 생기고, 프록시가 매 요청마다 같은 잘못된 계정을 다시 고를 수 있습니다.
4. **기각: 모든 400 또는 문자열 포함 오류 failover.** malformed request를 계정 전체에
   증폭하고 unsafe 작업을 중복할 수 있습니다.

## Functional requirements

1. provider가 `codex`, 계정이 OAuth, HTTP status가 `400`, body가 단일 JSON object이고
   `detail`이 `The '<request-model>' model is not supported when using Codex with a ChatGPT account.`와
   정확히 일치할 때만 unsupported-model로 분류합니다.
2. 분류된 계정·모델 조합은 bounded TTL 동안 선택에서 제외합니다. 다른 모델과 계정의
   상태·quota·subscription은 변경하지 않습니다. TTL 만료 또는 동일 account/model의 검증된
   Codex 2xx 응답이 재선택 가능 상태로 돌려놓으며, 2xx는 요청 처리 중 생긴 stale marker도
   방어적으로 정리합니다.
3. exact 거절을 받은 원 POST는 다른 OAuth/API-key account나 fallback model로 재전송하지
   않고 해당 400 body/status와 `content-encoding`/`content-length`를 wire-byte-preserving
   반환합니다. 압축된 body는 상한이 있는 inspection copy만 해제해 판별합니다. watchdog이
   보낸 새 continuation POST만 격리되지 않은 다음 OAuth account를 사용합니다.
4. 같은 모델의 모든 eligible OAuth 계정이 이전의 독립적인 exact 거절로 격리된 상태에서
   새 continuation POST가 들어오면 `modelFallbacks`의 다음 모델로 request body와
   content-length를 dispatch 전에 갱신합니다. chain이 없거나 소진된 terminal dead-end는
   continuity deadline을 기다리지 않고
   upstream dispatch 없이 즉시 429를 반환하며, `retry-after`는 가장 이른 격리 TTL 만료를
   반영합니다.
5. 운영 fallback은 같은 provider와 인증 경계의 actual minimal run에서 성공한
   `gpt-5.6-terra`만 `gpt-5.6-sol`의 1차 대상으로 사용합니다.
6. generic 400, 다른 model의 detail, extra/quoted text, malformed/oversized body, API-key account는
   failover 0회이고 원 응답을 반환합니다.
7. watchdog은 TUI의 exact unsupported JSON block과 빈 prompt만 허용하며, 기존 checkpoint,
   stable surface, user draft, semantic blocker, cooldown, circuit-open, pending-before-send 검사를
   그대로 적용합니다. 원본 HTTP request는 replay하지 않습니다.
8. Codex request log에는 query, request/response/stream body, raw error stack, token, email,
   stable account ID, request ID, 임의 upstream header를 기록하지 않습니다. URL path와
   allowlisted metadata header만 남기며 계정은 `pool-<runtime index>` opaque ref로 표기합니다. 공개 status는
   stable account ID를 생략하고, 기존 Claude recovery만 `localhost + proxy API key + explicit
   identity header`를 모두 만족한 내부 호출로 ID 포함 snapshot을 받습니다.
9. watchdog diagnostic log 쓰기가 실패해도 scan과 recovery 판단은 계속합니다. durable
   state/lock 초기화나 저장이 실패하면 recovery는 제출하지 않고 해당 tick을 exit 0으로
   defer합니다. 어느 저장 실패도 launchd watchdog의 nonzero 종료를 만들 수 없습니다.
10. Codex request의 첫 dispatch에서 정한 OAuth/API-key 인증 유형은 그 request 전체에
    고정합니다. OAuth unsupported-model 격리가 존재하는 fresh continuation도 OAuth pool만
    사용합니다. 완결된 generic 429는 upstream이 요청을 명시적으로 거절한 증거이므로 같은
    인증 유형 안에서 기존 bounded failover 계약을 유지하되, OAuth/API-key 경계를 넘지 않습니다.
11. upstream model-scoped quota label은 길이와 account별 entry 수를 각각 64로 제한하고,
    만료 sweep 뒤에도 상한이면 가장 오래된 entry를 제거해 장기 프로세스 메모리를 제한합니다.
12. 명시적 account/model quota exhaustion이 아닌 완결된 `POST` 429도 bounded account failover와
    continuity의 대상입니다. 반면 timeout, 5xx, transport error, incomplete stream처럼 dispatch
    결과가 애매한 POST는 다른 account로 내부 재전송하지 않고 502 또는 원 응답을 반환합니다.
13. raw OAuth relay와 supervisor worker relay는 요청·응답 양쪽에서 표준 hop-by-hop header와
    `Proxy-Connection`을 제거합니다. `Connection`에 지목된 동적 header 제거 계약도 유지합니다.
14. raw transport가 encoded Codex SSE를 전달할 때 압축 bytes를 text usage parser에 넣지 않습니다.
    encoded body와 `content-encoding`/`content-length`를 그대로 끝까지 전송하고 keep-alive socket을
    정상 해제합니다. 별도의 bounded decompression observer만 terminal event를 확인해 완결된 inference를
    account success로 반영하고, supervisor는 압축 bytes를 `SseFramer`에 누적하지 않습니다.

## Acceptance criteria

- 첫 OAuth account가 exact Sol 400인 fixture에서 첫 POST는 400이고 upstream hit는 `a:1,b:0`입니다.
  watchdog과 동등한 새 POST는 둘째 account의 200을 받아 총 hit가 `a:1,b:1`입니다.
- 모든 account가 각각 독립된 새 Sol POST에서 exact 400을 반환한 뒤 다음 새 POST의 Terra
  fallback이 200이면 각 account/model 조합은 한 번을 넘지 않습니다.
- 같은 Sol 요청을 바로 반복하면 TTL 격리 account는 재선택되지 않습니다. TTL 만료 또는
  Sol 2xx 뒤 다시 eligible합니다.
- malformed·quoted·model mismatch·API-key·일반 400은 upstream hit 1회, client 400입니다.
- 기존 502/503/504/request-ID/capacity watchdog 시나리오와 POST no-replay tests가 회귀하지 않습니다.
- gzip exact 400은 encoded body와 `content-encoding`/`content-length`가 upstream과 완전히
  일치하고, mixed OAuth/API-key 401/429는 credential type을 넘지 않습니다.
- 같은 credential-type 대체 계정이 있는 완결 429는 bounded failover하며, mixed
  OAuth/API-key만 있는 경우에는 cross-type 재전송 없이 원 429를 반환합니다.
- raw OAuth relay와 supervisor worker 경계는 요청·응답의 `Proxy-Connection`을 모두 제거합니다.
- gzip Codex SSE 뒤 같은 keep-alive agent의 status 요청이 timeout 없이 200이며, SSE encoded
  body와 encoding/length가 upstream과 일치하고 completed inference가 usage-auth failure streak을
  해제합니다.
- production watchdog `--dry-run`은 `submitted=0`, launchd `last exit code=0`입니다.
- 동적 추가 account도 unsupported-model quarantine/status snapshot에서 예외가 없고, 로그 경로가
  read-only/디렉터리여도 watchdog process는 `0`으로 계속합니다.
- 실제 provider 경계의 Sol/Terra 최소 실행과 격리 HTTP proxy QA가 성공합니다.
- rollback artifact restore hash와 syntax check가 일치하고 secret scan은 0건입니다.
- exact commit SHA의 fresh 독립 `review-work` 5개 lane과 debugging runtime audit에서
  CRITICAL/HIGH blocker가 0건입니다.

## Observability

- proxy는 `codex-model-unsupported`와 `codex-model-fallback` decision을 계정 credential 없이
  기록합니다.
- status account에는 현재 TTL이 남은 model slug만 노출하고 만료된 항목은 lazy sweep합니다.
  stable account ID는 인증된 local internal snapshot에만 포함합니다.
- watchdog summary의 기존 `matches/submitted/stale/backoff/circuit_open` 카운터를 재사용합니다.

## Rollout

1. failing-first fixture와 targeted regression을 source checkout에서 통과시킵니다.
2. 현재 source hash를 승인하고 zero-inflight deployment guard를 통해 immutable runtime artifact로
   배포합니다. live request가 있거나 source identity가 바뀌면 배포하지 않습니다.
3. 운영 config에는 검증된 `gpt-5.6-sol -> gpt-5.6-terra` chain만 원자 반영합니다.
4. status/source hash, Sol/Terra smoke, watchdog dry-run과 launchd 상태를 관찰합니다.

## Rollback

- source/runtime: 배포 전 content-addressed last-good artifact로 되돌리고 source hash와 health를
  확인합니다.
- config: 변경 전 owner-only snapshot의 hash를 확인한 뒤 modelFallbacks만 복원합니다.
- watchdog: 변경 전 hash의 owner-only snapshot으로 staged restore 후 `py_compile`과 dry-run을
  확인합니다.
- rollback 중에도 이미 dispatch된 POST는 다시 보내지 않습니다.

## Security and failure boundaries

- body는 기존 `maxResponseBytes`/process budget으로 한정해 읽습니다.
- exact completed 400은 account/model 격리 증거로만 취급합니다. 이것도 upstream 무실행
  증거로 간주하지 않으므로 원 POST를 재전송하지 않습니다. timeout, stream abort, 5xx 역시
  기존 no-replay 경로를 유지합니다.
- account별 격리 `Map`은 삽입 시 만료 항목을 sweep하고 최대 64개를 유지합니다.
- model-scoped weekly quota label도 길이 64, account별 64개로 제한합니다.
- 완결된 generic 429는 bounded failover할 수 있지만 ambiguous 5xx·timeout·transport failure·
  incomplete stream의 unsafe request는 provider와 무관하게 내부 재전송하지 않습니다.
- `Proxy-Connection`은 비표준 hop-by-hop header로 간주해 모든 relay 경계에서 제거합니다.
- encoded Codex SSE의 usage parsing은 best-effort observability보다 byte fidelity와 연결 종료를
  우선해 건너뜁니다.
- 상태 격리는 memory-only TTL입니다. restart 뒤 첫 exact 거절은 다시 관찰할 수 있지만 proxy
  내부에서 투명 전환되며 stale entitlement가 영구 고정되지 않습니다.
