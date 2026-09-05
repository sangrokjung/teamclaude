# Claude fleet exhaustion auto-resume plan

Spec: `docs/specs/2026-08-29-claude-fleet-exhaustion-auto-resume.md`

## Scope

- 변경: `src/claude-recovery.js`, `test/claude-recovery.test.js`, README, 이 spec/plan
- 비변경: Claude source config/hooks, proxy 429 계산, account selection, config schema, OAuth flow

## Tasks

1. [x] 정확한 오류가 generic `limit`으로 분류되고 서버 지시 시간이 유실되는 현재 runtime 동작을 확인합니다.
2. [x] classifier 및 harness 회귀 테스트를 red로 추가합니다.
3. [x] exact fleet-exhaustion retry delay와 same-session continuation을 최소 변경으로 구현합니다.
4. [x] targeted test와 실제 CLI fixture를 통과시킵니다.
5. [x] 변경 파일 lint, 타깃 suite, 실제 CLI fixture와 독립 코드 검토를 통과시킵니다.
6. [x] README와 이 plan의 Verification을 최종 실행 결과로 동기화합니다.
7. [x] provider 환경을 격리하고 부하 게이트 전체 suite를 다시 통과시킵니다.
8. [x] 추가 content block 및 late transcript race를 적대적으로 재현·수정하고 fresh review를 완료합니다.

## Verification

| Surface | Command/scenario | Expected |
|---|---|---|
| Red/green | `node --test test/claude-recovery.test.js` | 신규 exact-delay test가 수정 전 실패, 수정 후 통과 |
| CLI | fake `claude` + real `node src/index.js run` | 지정 대기 후 동일 UUID에 `continue`로 재실행 |
| Regression | `npm test` | 기존 Claude/proxy/Codex 동작 통과 |
| Static | `npm run lint` | exit 0 |
| Adversarial | spec/diff/evidence checker | blocking finding 없음 |

## Results

- provider 환경을 제거한 `node --test --test-concurrency=1 test/claude-recovery.test.js
  test/run-recovery.test.js` — 42/42 통과
- `node --test --test-concurrency=1 --test-reporter=tap --test-name-pattern='real run waits for a fleet-exhaustion retry hint before resuming Claude' test/run-recovery.test.js`
  — 실제 `node src/index.js run` 진입점 fixture 통과. 1초 대기 후 같은 UUID에
  `--resume <session-id> continue` 호출을 확인했습니다.
- qgate 직렬 전체 suite — 600/600 통과
- gate-owned 독립 review — 현재 shared checkout의 다른 세션 변경이 이번 scope에
  섞여 `unattributed-mutation`으로 UNVERIFIED. 구현·targeted QA 결과와 별개로
  authoritative APPROVE receipt는 발급되지 않았습니다.
- fresh Codex code review — CRITICAL/HIGH 발견 없이 APPROVE. 보고서:
  `.omo/evidence/fleet_resume_codex_review-code-review.md`
- 2026-08-30 현재 전역 `teamcodex@1.3.3` 설치본에는 저장소의 다른 미배포 기능을
  덮어쓰지 않고 `src/claude-recovery.js`의 fleet-exhaustion 분류·대기·동일 세션
  재개 hunk만 병합했습니다. 실제 wrapper가 호출하는 설치본 `src/index.js run` fixture에서
  1초 대기 후 같은 UUID에 `--resume <session-id> continue`가 호출됐습니다.
- 사용자 오류의 줄바꿈 포함 원문은 설치본에서 `fleet_exhausted`, `13671초`,
  `13671000ms`로 판정됐습니다. 실제 설정은 `autoResumeClaude: true`, retry budget 3회,
  16계정으로 확인했습니다.
- 최신 타깃 재검증:
  `env -u TEAMCLAUDE_PROVIDER -u TEAMCLAUDE_SESSION_SUPERVISED node --test --test-concurrency=1 --test-name-pattern='fleet exhaustion|real run waits for a fleet-exhaustion' test/claude-recovery.test.js test/run-recovery.test.js`
  — 3/3 통과. `npx --yes eslint src/claude-recovery.js test/claude-recovery.test.js test/run-recovery.test.js`
  — 통과. 설치본 `node --check` 및 동일 ESLint 설정도 통과했습니다.
- 최신 결합 타깃 suite는 42/42 통과했습니다. 앞선 `Login expired` fixture 1건 실패는
  Codex 세션의 `TEAMCLAUDE_PROVIDER=codex`가 자식 환경에 섞인 테스트 오염이었고,
  `env -u TEAMCLAUDE_PROVIDER -u TEAMCLAUDE_SESSION_SUPERVISED`로 격리해 해소했습니다.
- 재개 patch 반영 후 qgate 결합 suite를 다시 실행해 42/42, exit 0을 확인했습니다.
- 현재 gate task의 테스트 evidence는 `run-evidence` TAP 경로로 등록됐습니다. shared checkout의
  다른 active scope 때문에 새 goal/security review dispatch는 `scope-conflict` 또는 fixture 내
  인증형 문자열의 보수적 `secret-detected`로 차단되어 authoritative reviewer receipt는 없습니다.
- qgate 전체 suite는 600/600, exit 0입니다. `npx --yes eslint src/
  test/claude-recovery.test.js test/run-recovery.test.js`도 통과했습니다. `npx eslint .`은
  `.omo/evidence`의 외부 minified `xterm.js`까지 검사해 실패했으며 제품 소스와 이번 변경
  테스트에는 lint 오류가 없습니다.
- gate-owned reviewer 재발급은 같은 shared checkout의 다른 active task 때문에
  `scope-conflict`로 차단됐습니다. 기존 fresh Codex 독립 review는 CRITICAL/HIGH 없음으로
  APPROVE했지만 authoritative gate receipt는 계속 발급되지 않은 상태입니다.
- 2026-08-30 postfix 적대 검토에서 HIGH 4건(앞뒤 공백 승인, non-429 generic 재개,
  이름 기반 동일 UUID 회전 승인, `gitBranch` handoff 주입)을 발견해 모두 fail-closed로
  수정했습니다. source와 전역 `teamcodex@1.3.3` 설치본에 동일 classifier/handoff 경계를
  반영했습니다.
- postfix 회귀·실제 CLI 결합 qgate ticket `1788092066515854000-4415` — 45/45 통과,
  ESLint 및 source/설치본 `node --check` exit 0. exact 13671초와 wrapped 원문은
  `fleet_exhausted`; leading/trailing/no-prefix/non-429은 `noAutoResume`으로 직접 관찰했습니다.
- 전체 suite 재실행 ticket `1788091828974028000-59929` — 608개 중 606 통과, 이번 범위와
  무관한 기존 `server-429`·`server-midstream` 타이밍 테스트 2건 실패. 단독 재실행 ticket
  `1788091894231269000-71635`에서도 `server-429` 1건은 재현됐고 `server-midstream`은 통과했습니다.
- gate-owned evidence는 테스트 성공 후 fixture의 인증형 문자열을 보수적으로
  `secret-detected` 처리해 authoritative receipt를 발급하지 못했습니다. gate state는 직접
  수정하거나 우회하지 않았습니다.
- 2026-08-30 추가 fresh 적대 검토에서 HIGH 4건(같은 이름·다른 UUID
  회전 거부, branch 원문 개행 정규화 승인, `Retry\n in`/`Retry\n   in`
  오탐, valid branch 후 invalid branch가 이전 값을 남기는 mixed-metadata fail-open)을
  red 재현 후 수정했습니다. 회전은 UUID+marker로만 판정하고,
  wrapped retry는 줄바꿈 후 정확히 두 칸만 허용하며, branch metadata에
  invalid 값이 하나라도 있으면 전체를 `unknown`으로 처리합니다.
- 최신 red→green에서 추가 `tool_use`/`null`/split `content` block은 수정 전
  `fleet_exhausted`로 승인됐고, 수정 후 `limit` + `noAutoResume`으로 거부됩니다.
  late normal transcript 경쟁 fixture는 수정 전 `spawns=2`로 중복 재개됐고,
  수정 후 `spawns=1`, `waits=0`으로 통과했습니다.
- 최신 핵심 fleet·회전·handoff·실제 CLI 48개 시나리오와 source/tests/설치본
  syntax 및 scoped ESLint가 통과했습니다. 실제 `node src/index.js run` fixture는
  1초 대기 후 동일 session의 `--resume <id> continue`를 관찰했습니다.
- fresh review: goal v4 APPROVE, code v7 APPROVE, security v8 APPROVE,
  context v4 PASS, QA v4 핵심 surface PASS. 보고서는
  `.omo/evidence/claude-fleet-exhaustion-{goal-v4,code-v7,security-v8,context-v4,qa-v4}.md`입니다.
- 보안 v7의 timer overflow REJECT는 수치 오류로 교정했습니다. 7일 상한
  `604800000ms`는 Node timer 최대 `2147483647ms`보다 작아 전역 설치본의
  단일 `setTimeout`이 overflow하지 않습니다.
- 최신 전체 suite qgate ticket `1788095364341128000-3012`는 heavy queue에
  제출됐으나 Chrome/load gate 폐쇄로 실행되지 않았고, turn 종료 전 대기 job을
  취소했습니다. 이번 변경 전 600/600 결과는 유지하되, 이번 content/race 보강
  이후 full suite는 미완료 evidence로 구분합니다.
