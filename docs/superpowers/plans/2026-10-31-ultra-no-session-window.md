# Ultra 5시간 한도 없음 대응 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 5시간 창 없이 주간 창만 받는 Claude 구독 계정(검증된 Ultra)을 프록시가 사실로 기록하고, 반복 프로브를 멈추고, CLI·TUI·메뉴바가 "5시간 한도 없음"으로 보여 준다.

**Architecture:** `quota.sessionWindowStated`(null|true|false) 하나를 프록시가 응답 헤더로 기록·스냅샷에 저장하고, 측정 판정(`_fullyMeasured`)과 표시만 이 플래그를 읽는다. 계정 선택은 지금처럼 실제 측정값으로만 막는다. 메뉴바는 상태 응답의 플래그를 읽어 세션 칸을 "없음"으로 바꾸고, 가용 판정·미측정 경고·소진 예측에서 세션을 뺀다.

**Tech Stack:** Node 18+ ESM(의존성 0, `node:test`), Swift/AppKit 메뉴바(`menubar/run-tests.sh`).

**Spec:** `docs/specs/2026-10-31-ultra-session-and-api-credits.md` A1~A6 (B파트는 별도 계획)

## Global Constraints

- 런타임 의존성 추가 금지(`package.json` `dependencies` 불변).
- 새 전역을 쓰면 `eslint.config.js` globals에 추가. `npm run lint` 통과.
- 계정 선택은 플래그가 아니라 측정값으로만 막는다(A5). 플래그는 측정 판정·표시에만 쓴다.
- API 키 계정과 Codex 계정의 동작은 바꾸지 않는다.
- 메뉴바 문구는 `L10n.t(한국어, 영어)` 한 쌍으로: "5시간 한도 없음" / "No 5-hour limit", 짧은 표기 "없음" / "None".
- 공개 저장소: 테스트 픽스처에 실제 계정 이름·이메일 금지(`a0`, `ultra-1` 같은 가짜 이름).

## Review Focus

1. 5h 헤더 없이 7d만 오는 **429 rejected** 응답: 플래그를 false로 바꾸면 안 된다(주간 소진 거절일 뿐). Task 1 테스트로 고정.
2. 플래그 false 상태에서 5h 헤더가 다시 오는 계정(검증 해제·롤백): true로 돌아가고 막대가 다시 나와야 한다. Task 1·3 테스트.
3. 옛 스냅샷·손으로 고친 스냅샷의 `sessionWindowStated: "false"`(문자열) 같은 값: null로 정리돼야 한다. Task 1 테스트.
4. 플래그 false + 주간 98% 이상: 메뉴바에서 "가득"으로 보여야지 "사용 가능"이 되면 안 된다. Task 3 테스트.
5. 구버전 프록시(필드 없음)에 붙은 새 메뉴바: 지금 동작과 같아야 한다(필드 없음 = null). Task 3 테스트.

---

### Task 1: 프록시가 5시간 창 유무를 기록하고 측정 판정에 반영

**Files:**
- Modify: `src/account-manager.js` (`emptyQuota` ~L91, `updateQuota` ~L1647, `_isNearQuota` ~L1506, `_fullyMeasured` ~L1101, `importQuotaState` ~L2592)
- Modify: `src/server.js:3639`, `src/server.js:1504` (호출부에 상태 코드 전달)
- Test: `test/claude-session-window.test.js` (새 파일)

**Interfaces:**
- Produces: `quota.sessionWindowStated: boolean | null` (상태 응답·스냅샷에 그대로 실림. `getStatus`와 `exportQuotaState`는 이미 `...a.quota`를 펼치므로 추가 작업 없음)
- Produces: `updateQuota(accountOrIndex, headers, { status } = {})`: `status`는 숫자 HTTP 상태, 생략 가능(생략 시 플래그를 false로 바꾸지 않음)

- [ ] **Step 1: 실패하는 테스트 작성** (`test/claude-session-window.test.js`, `AccountManager`를 OAuth 계정 1개로 만들고 `updateQuota` 직접 호출)
  - `weekly-only success sets flag false`: 200, 헤더 `unified-7d-utilization: '0.4'`, `-7d-reset: <미래초>`, `unified-status: 'allowed'` → `sessionWindowStated === false`, `_fullyMeasured(a) === true`.
  - `5h header sets flag true`: 200 + 5h·7d 헤더 → `true`.
  - `rejected 429 keeps flag`: 플래그 null에서 429, 7d만, `unified-status: 'rejected'` → `null` 그대로.
  - `error without headers keeps flag`: 플래그 false에서 500, 헤더 없음 → `false` 그대로.
  - `status omitted never sets false`: `updateQuota(a, {7d헤더})`(세 번째 인자 없음) → `null`.
  - `5h returns after false`: false 뒤 200 + 5h 헤더 → `true`.
  - `lingering 5h cleared when flag false`: `unified5h = 0`, `unified5hReset = null`, 플래그 false → `_isNearQuota` 호출 뒤 `unified5h === null`.
  - `apikey and codex untouched`: `type: 'apikey'` 계정에 7d만 200 → 플래그 `null`.
  - `snapshot round-trip`: export → 새 매니저 import → `false` 유지. import에 `"false"`(문자열) → `null`.
  - `warm-up skips weekly-only`: 플래그 false·7d 완전 측정 계정은 `needsPartialRemeasure(a) === false`.
- [ ] **Step 2: 실패 확인**: Run: `node --test test/claude-session-window.test.js` / Expected: FAIL(필드 없음)
- [ ] **Step 3: 구현**
  - `emptyQuota()`에 `sessionWindowStated: null` 추가(주석: 2026-10-30 Ultra, 플래그는 표시·프로브 전용).
  - `updateQuota`: 세 번째 인자 `{ status }`. `account.type === 'oauth'`이고 provider가 codex가 아닐 때만: 5h utilization 또는 reset 헤더가 있으면 true. 없고, 7d utilization 헤더가 있고, `Number.isInteger(status) && status < 400`이고, `unified-status !== 'rejected'`이면 false. 그 밖은 그대로.
  - `_isNearQuota`: 5h 만료 정리 블록 옆에, `q.sessionWindowStated === false && q.unified5h != null && (q.unified5hReset == null || now >= q.unified5hReset)`이면 `unified5h`·`unified5hReset`을 null로.
  - `_fullyMeasured`(OAuth): 7d 완전 + (5h 완전 **또는** `sessionWindowStated === false`).
  - `importQuotaState`: `sessionWindowStated: typeof s.quota.sessionWindowStated === 'boolean' ? s.quota.sessionWindowStated : null`.
  - `server.js:3639` → `updateQuota(account, ..., { status: upstreamRes.status })`, `server.js:1504` → `{ status: res.status }`.
- [ ] **Step 4: 통과 확인**: Run: `node --test test/claude-session-window.test.js test/warmup.test.js test/account-manager.test.js` / Expected: PASS
- [ ] **Step 5: Commit**: `git add src/account-manager.js src/server.js test/claude-session-window.test.js && git commit -m "fix(quota): 5시간 창 없는 Ultra 계정을 기록하고 반복 프로브를 멈춘다"`

### Task 2: CLI status와 TUI 표시

**Files:**
- Modify: `src/index.js:3024-3026` (status 명령의 Session 줄)
- Modify: `src/tui.js:1018-1022` (OAuth 행의 Ses 막대)
- Test: `test/claude-session-window.test.js`에 추가(렌더 함수가 export돼 있지 않으면 `test/tui-*.test.js` 기존 패턴을 따름)

**Interfaces:**
- Consumes: Task 1의 `quota.sessionWindowStated`

- [ ] **Step 1: 실패하는 테스트**
  - CLI: `sessionWindowStated: false`, `unified7d: 0.4`인 상태 → 출력 줄에 `Session:  no 5h limit`이 있고 `Weekly: 40.0% used`가 있다. 기존 계정(플래그 null, 5h 0.1)은 지금 문자열 그대로.
  - TUI: 같은 계정 행에서 Ses 칸 대신 `Ses none`(막대 없음)이 그려지고, 너비 계산이 다른 행과 같다(행 길이 동일).
- [ ] **Step 2: 실패 확인**: Run: `node --test <해당 테스트 파일>` / Expected: FAIL
- [ ] **Step 3: 구현**: CLI는 `q.sessionWindowStated === false`면 `ses = 'no 5h limit'`. TUI는 `r1 = null`이고 막대 자리에 `none`을 같은 폭으로 패딩.
- [ ] **Step 4: 통과 확인**: Run: `npm test` / Expected: 전체 PASS, `npm run lint` 오류 0
- [ ] **Step 5: Commit**: `git commit -m "feat(status): 5시간 한도 없는 계정을 CLI·TUI에 표시"`

### Task 3: 메뉴바 Claude 표시·가용 판정

**Files:**
- Modify: `menubar/Sources/main.swift:640-700` (행 구성: 플래그 파싱, `TeamClaudeAccountHealth`에 `sessionWindowAbsent: Bool` 전달), `main.swift:254` 근처 구조체 정의, `computeTeamClaudeRetryAfterSeconds`(L512, 플래그 false면 5h 창 제외)
- Modify: `menubar/Sources/TeamClaudeStatusLogic.swift:415-460` (`teamClaudeMeasurementIssue`, `teamClaudeAccountIsUsable`에 `sessionWindowAbsent: Bool = false` 인자)
- Modify: `menubar/Sources/TeamClaudeRowLines.swift`, `menubar/Sources/DashboardOverviewBuilder.swift:110-135` (세션 칸 문구, 세션 소진 예측 생략)
- Modify: `menubar/Sources/L10n.swift` (`sessionNone` "5시간 한도 없음"/"No 5-hour limit", `sessionNoneShort` "없음"/"None")
- Test: `menubar/Tests/TeamClaudeStatusLogicTests.swift`, `menubar/Tests/TeamClaudeRowLinesTests.swift`, `menubar/Tests/DashboardOverviewBuilderTests.swift`, `menubar/Tests/L10nTests.swift`; 픽스처 `menubar/Tests/make_dash_fixture.py`에 weekly-only 계정 1개 추가

**Interfaces:**
- Consumes: 상태 응답 `accounts[].quota.sessionWindowStated`
- Produces: `TeamClaudeAccountHealth.sessionWindowAbsent: Bool`(필드 없음·null·true → false)

- [ ] **Step 1: 실패하는 테스트**
  - `teamClaudeAccountIsUsable(enabled: true, status: "active", sessionPercent: nil, weeklyPercent: 40, fablePercent: 10, thresholdPercent: 98, sessionWindowAbsent: true) == true`; 같은 조건 weekly 99 → false; `sessionWindowAbsent: false`, session nil → false(지금 동작).
  - `teamClaudeMeasurementIssue(..., sessionPercent: nil, weeklyPercent: 40, fablePercent: 10, sessionWindowAbsent: true) == nil`; fable nil이면 `.fableMissing`.
  - 행 문구: 세션 칸이 `L10n.sessionNone`, 리셋 시각 없음. 개요: 세션 소진 예측 없음, 주간 예측은 있음.
  - 재시도 시각: 플래그 false 계정의 남은 5h 값은 계산에 쓰이지 않음.
  - L10n: 두 문구의 한국어·영어.
  - 필드 없는 옛 상태 응답 파싱 → `sessionWindowAbsent == false`.
- [ ] **Step 2: 실패 확인**: Run: `CC_MENUBAR_SKIP_TESTS=0 bash menubar/run-tests.sh` (무거우면 qworker: `python3 ~/.claude/scripts/qworker.py run --sync-dir <워크트리> --label ultra-menubar --wait-seconds 1800 -- bash -c 'bash menubar/run-tests.sh; echo rc=$?'`) / Expected: 새 테스트 FAIL
- [ ] **Step 3: 구현**: 위 Files 순서대로. 판정 규칙: `sessionWindowAbsent`이면 가용은 주간만으로, 미측정 경고에서 세션 누락 제외.
- [ ] **Step 4: 통과 확인**: 같은 명령 / Expected: 전체 PASS, `bash menubar/build.sh` 성공
- [ ] **Step 5: 화면 확인**: 픽스처로 QA 훅 캡처: `python3 menubar/qa.sh run <steps.json>`(개요·Claude 탭). weekly-only 행이 "5시간 한도 없음"이고 손볼 것 목록에 없음을 이미지로 확인. 캡처는 저장소에 넣지 않는다.
- [ ] **Step 6: Commit**: `git commit -m "feat(menubar): 5시간 한도 없는 Ultra 계정 표시와 가용 판정"`

### Task 4: 문서 동기화

**Files:**
- Modify: `CLAUDE.md` Quota tracking 절(5h 없는 Ultra 한 문단), `menubar/README.md`·`menubar/README.ko.md`(표시 설명 한 줄, 있으면), `menubar/DESIGN.md`(새 문구 상태)
- Modify: spec Status·Verification 갱신

- [ ] **Step 1:** 위 문서 수정, sync-docs 스킬 호출.
- [ ] **Step 2: Commit**: `git commit -m "docs: Ultra 5시간 한도 없음 동작 문서화"`
