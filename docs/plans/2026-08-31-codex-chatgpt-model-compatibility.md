# Codex ChatGPT 계정별 모델 호환성 자동 복구 plan

Spec: `docs/specs/2026-08-31-codex-chatgpt-model-compatibility.md`

## Scope

- 변경: `src/server.js`, `src/account-manager.js`, `src/config.js`, config example,
  proxy/watchdog tests, Codex recovery runbook, 운영 runtime/config/watchdog.
- 비변경: ambiguous POST replay 계약, Claude provider 동작, OAuth credential 내용,
  source Claude 설정, unrelated dirty worktree.

## Tasks

1. [x] 공식 catalog와 동일 TeamCodex provider의 Sol/Terra minimal run을 대조했습니다.
2. [x] exact error가 generic 400 pass-through이고 watchdog allowlist 밖임을 확인했습니다.
3. [x] proxy exact-classifier/account failover/fallback tests를 failing-first로 고정했습니다.
4. [x] account/model TTL 격리, max-64 sweep, 새 continuation의 bounded fallback을 구현했습니다.
5. [x] watchdog exact detection과 fail-closed negatives를 failing-first 후 구현했습니다.
6. [x] gzip wire fidelity, credential-type sticky, quota label max-64 blocker를 수정하고
   targeted Node 55/55를 통과했습니다.
7. [x] provider-independent unsafe POST 429 no-replay, raw/supervisor `Proxy-Connection`
   strip, gzip SSE keep-alive 회귀를 RED→GREEN으로 수정하고 targeted Node 30/30과 syntax를
   통과했습니다.
8. [ ] targeted tests, syntax/lint, 격리 HTTP/CLI manual QA를 통과시킵니다.
9. [ ] qgate full regression, rollback, secret scan, production dry-run을 통과시킵니다.
10. [ ] zero-inflight verified deployment와 운영 config의 원자 변경을 완료합니다.
11. [ ] fresh 독립 적대 검토 5개 lane의 blocker를 모두 해결합니다.
12. [ ] spec/plan/runbook/evidence를 최종 실행 결과와 hash로 동기화합니다.

## Verification matrix

| Surface | Scenario | Binary expected |
|---|---|---|
| Proxy RED/GREEN | exact Sol 400 on account A | status 400, A one hit, POST replay zero |
| New continuation | first account quarantined, next POST | account B 200, A/B one hit |
| Fallback | independent Sol turns quarantine fleet, next Terra 200 | status 200, unique attempts |
| TTL | repeated request before/after expiry | quarantined then eligible |
| Negative | malformed/quoted/mismatch/API-key/generic 400 | failover 0, 400 preserved |
| Encoded rejection | gzip exact 400 | encoded bytes/encoding/length exact, quarantine yes |
| Encoded stream | gzip Codex SSE then same-agent status | raw bytes/headers exact, stream end, status 200 |
| Credential boundary | mixed OAuth/API-key 401/429 and fresh recovery | request type sticky, cross-type hits zero |
| Unsafe 429 | Anthropic/Codex POST generic 429 | upstream hit one, original 429 preserved |
| Hop-by-hop | raw OAuth + supervisor request/response | Proxy-Connection absent at both boundaries |
| Quota metadata | 100 unique model-weekly labels | retained entries <=64 |
| No replay | 502/503/504/stream abort POST | original upstream POST one hit |
| Watchdog | exact JSON + empty prompt | one recovery turn, duplicate zero |
| Watchdog negative | draft/stale/binding/quoted/UNVERIFIED | submitted zero |
| Runtime | real provider Sol and Terra minimal exec | both exit 0 |
| Operations | dry-run/launchd/source hash/config | submit 0, exit 0, expected hash |
| Rollback/security | staged restore + secret scan | hash/syntax match, leaks zero |
| Runtime-added account | addAccount → quarantine → status | no exception, model slug visible |
| Status identity | public/spoofed/authenticated local status | IDs absent/absent/present |
| Log/state failure | unwritable watchdog log/state + proxy metadata log | state failure submits zero/exit 0, sensitive values absent |
| Adversarial | independent code/security-runtime lanes | CRITICAL/HIGH zero |

## Evidence

- RED: model compatibility Node 18개 중 7개 실패, watchdog variants 15개 중 1개 error.
- GREEN: source targeted Node 123/123, watchdog core 87/87, variants 15/15,
  pre-blocker candidate 18/18, prior blocker regression 55/55, latest targeted 30/30,
  changed runtime syntax PASS.
- 적대 검토가 pre-blocker candidate hash `86ca9517…c47ec3f`에서 gzip fidelity,
  mixed credential failover, unbounded quota label을 차단했고 모두 수정했습니다. 이 hash는
  배포하지 않으며 최종 candidate hash는 검증 후 기록합니다.
- qgate r2: full `1788175295615034000-36079`, lint
  `1788175295594598000-36064`, watchdog `1788175295615113000-36078` (result pending).
