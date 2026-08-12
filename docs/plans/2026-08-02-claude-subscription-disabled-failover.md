# Claude subscription-disabled account failover plan

Spec: `docs/specs/2026-08-02-claude-subscription-disabled-failover.md`

## Scope

- 변경: `src/server.js`, `test/server-403.test.js`, README/runbook, 이 spec/plan
- 비변경: config schema, OAuth flow, source Claude config, account selection core, dependency 목록

## Tasks

1. [x] 실제 `teamclaude run`에서 placeholder client OAuth로 조직 subscription-disabled 403과 usage 0을 재현하고 active account 불변을 확인합니다.
2. [x] `test/server-403.test.js`에 exact 403 failover, all-disabled original response, unrelated 403 pass-through를 추가하고 red를 기록합니다.
3. [x] `src/server.js`에 bounded JSON classifier와 account 격리/failover를 최소 변경으로 구현합니다.
4. [x] 403 targeted test, 인접 401/429/network/stream regression, ESLint, 전체 suite를 실행합니다.
5. [x] 격리된 temp upstream/config에서 실제 `node src/index.js run -- -p ...` CLI failover를 관찰합니다.
6. [x] README와 runbook에 증상, 자동 격리, 오탐 방지, 수동 우회, 복구/rollback을 동기화합니다.
7. [x] 현재 diff 기준 독립 5-lane 적대적 검토를 수행하고 blocking finding을 수정 후 영향 lane을 재실행합니다.

## Verification

| Surface | Command/scenario | Expected |
|---|---|---|
| Red/green | `node --test test/server-403.test.js` | 수정 전 exact 403 failover test 실패, 수정 후 전부 통과 |
| Adjacent auth | `node --test test/server-401.test.js test/server-403.test.js` | 401 refresh/failover와 403 정밀 분류 모두 통과 |
| Regression | 429/network/stream 관련 targeted tests | 기존 retry safety와 stream 계약 불변 |
| Static | `npx eslint src/ test/` | exit 0 |
| Full | `python3 ~/.claude/scripts/qgate.py run --slot heavy -- npm test` | 모든 test 통과 |
| Manual CLI | temp server + `node src/index.js run -- -p ...` | 첫 account 403 격리 후 건강한 account 응답, credential 노출 없음 |
| Production CLI | 재기동된 port 3456 + 격리 `CLAUDE_CONFIG_DIR`의 `node src/index.js run -- -p ...` | exit 0, `result=OK`, usage nonzero |
| Adversarial | goal/QA/code/security/context 5 lanes | 전부 PASS, timeout/empty는 PASS로 간주하지 않음 |

## Rollout / rollback gate

- Rollout은 위 verification과 5개 lane이 모두 통과한 뒤에만 수행합니다.
- 운영 재시작 전 기존 server PID/status를 기록하고, 재시작 뒤 listener/status/실제 Claude prompt를 확인합니다.
- 회귀 시 문제 account 수동 disable로 우회하고 변경을 reverse-revert합니다. Migration rollback은 없습니다.

## Results

- Red: 전용 403 test 3개 중 exact failover/all-disabled 2개 실패
- Green: 403+401 5/5 PASS
- Targeted regression: qgate 경유 68/68 PASS
- Full regression: qgate 경유 419/419 PASS
- Static: `npx eslint src/ test/` exit 0
- Manual: installed Claude Code 2.1.220 exit 0, `result=OK`, usage nonzero, temp listener residue 0
- Production rollout: PID 39675가 port 3456에서 listen; 격리된 실제 Claude Code one-shot이 exit 0, `terminal_reason=completed`, `result=OK`, input/output usage nonzero
- Adversarial: goal/code/security/QA/context 5개 lane 전부 PASS
- Review ledger: `.omo/evidence/claude-subscription-disabled-failover-review-ledger.md`
