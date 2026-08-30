# TeamClaude account reauthentication plan

Spec: `docs/specs/2026-08-30-account-reauthentication.md`

## Scope

- 변경: `src/reauth.js`, `src/index.js`, `src/account-manager.js`,
  `src/server.js`, 관련 test, README 양쪽, 이 spec/plan, `CLAUDE.md`
- 비변경: 계정 선택·quota·dependency, source Claude 설정,
  별도 menu-bar app 저장소

## Tasks

1. [x] 통합 전 기준 브랜치에서 reauth source/test/README 문구 부재를 RED로 기록합니다.
2. [x] UUID 우선 선택, profile 검증, 실패 시 무변경인 순수 reauth 모듈을 구현합니다.
3. [x] CLI dispatch/help와 atomic config update, live reload 연결을 구현합니다.
4. [x] 대상 계정만 갱신, mismatch/cancel/stale UUID/legacy account 회귀 테스트를 추가합니다.
5. [x] README 양쪽에 CLI와 menu-bar app의 `재인증 필요` 사용 절차를 동기화합니다.
6. [x] targeted test, stale-UUID 수동 CLI QA, ESLint, diff check를 실행합니다.
7. [x] 독립 검토에서 발견된 provider/importFrom/subscription/missing-UUID blocker를 RED→GREEN으로 수정합니다.
8. [x] subscription-disabled 저장과 SIGHUP/TUI reload 경합을 재현하고, 저장 완료 대기·stable reread로 수정합니다.
9. [ ] exact commit SHA에 대해 독립 goal/security review와 runtime audit를 완료합니다.
10. [ ] fork PR의 CI를 통과시키고 merge한 뒤 기본 브랜치 반영을 확인합니다.

## Verification

| Surface | Command/scenario | Expected |
|---|---|---|
| RED | baseline에서 `test/reauth.test.js` 실행 및 README 검색 | test/file/command/action 부재 |
| Targeted | `node --test test/reauth.test.js test/server-403.test.js test/account-manager.test.js test/status-cli.test.js test/run-env.test.js` | 모두 PASS |
| Manual CLI | stale UUID가 든 격리 config로 `node src/index.js reauth ...` | exit 1, config byte-identical, OAuth 미실행 |
| Docs/help | README 검토 + `node src/index.js help` | CLI/button/privacy 계약 일치 |
| Static | `git diff --check` + changed-file ESLint | exit 0 |
| Flag persistence race | delayed/failed flag writer + read-during-transition tests | failover 전 저장 완료, stale reload 차단 |
| Regression | qgate `npm test -- --test-concurrency=1` + GitHub CI | available full suite/CI exits 0; if host admission blocks start, record the qgate ticket/result and use the complete targeted suite plus static checks (this repo has no CI workflow) |
| Adversarial | goal/QA/code/security/context exact-SHA lanes | 모두 PASS, CRITICAL/HIGH 없음 |

## Rollout / rollback gate

- rollout은 정확한 SHA 검토와 PR CI가 모두 통과한 뒤에만 수행합니다.
- config/schema migration이 없으므로 rollback은 merge commit revert로 충분합니다.
- 별도 app 저장소의 dirty worktree는 이번 PR에서 수정하지 않습니다.
