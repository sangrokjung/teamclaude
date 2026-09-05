---
status: APPROVED
created: 2026-08-13
approved_by: user
scope: "TeamCodex CRITICAL/HIGH security, retry, session, lifecycle, and resource-boundary hardening without live-daemon rollout"
restate: |
  Fix the nine confirmed audit boundaries with failing-first tests and isolated
  runtime QA while leaving every protected live TeamClaude/TeamCodex session
  and main/worker connection unchanged.
acceptance_criteria:
  - id: AC1
    desc: "Nine audited boundaries are mutation-sensitive and pass targeted tests after the minimum fixes"
    verifier: "node --test test/server-codex.test.js test/server-supervisor.test.js test/codex-run.test.js test/codex-resume.test.js test/status-cli.test.js"
    status: pending
    parent: null
  - id: AC2
    desc: "The complete Node regression suite passes through the local heavy-load gate"
    verifier: "python3 ~/.claude/scripts/qgate.py run --slot heavy -- npm test"
    status: pending
    parent: null
  - id: AC3
    desc: "Package and static-analysis surfaces pass without a new runtime dependency"
    verifier: "npm pack --dry-run --json && npx --yes eslint ."
    status: pending
    parent: null
  - id: AC4
    desc: "Protected live processes and listeners retain their exact identities"
    verifier: "ps -p 1473,62652,44183,13629 -o pid=,ppid=,stat=,command= && lsof -nP -iTCP:3456 -sTCP:LISTEN && lsof -nP -iTCP:3457 -sTCP:LISTEN"
    status: pending
    parent: null
  - id: AC5
    desc: "Five fresh non-fork review lanes approve the exact final change reference"
    verifier: "MANUAL: review ledger contains PASS for goal, QA, code quality, security, and context lanes at the same final change reference"
    status: pending
    parent: null
constraints:
  - "Never signal, stop, restart, reload, or replace protected PID 1473, 62652, 44183, or 13629"
  - "Never bind to or send adversarial traffic through protected port 3456 or 3457"
  - "Use throwaway config, OS-assigned loopback ports, fake credentials, and owned child processes only"
  - "Preserve all pre-existing dirty worktree changes and zero runtime dependencies"
  - "Run heavy/full tests only through qgate"
out_of_scope:
  - "Live daemon rollout or remote-worker reconfiguration"
  - "Commit, push, PR, merge, publish, or deployment"
  - "Unrelated refactoring"
impact:
  files_changed: 9
  core_logic_changed: true
  hard_gate_required: true
related_artifacts:
  - "docs/specs/2026-08-13-teamcodex-adversarial-hardening.md"
  - ".omo/evidence/teamcodex-adversarial-hardening-20260813/"
---

# TeamCodex adversarial hardening implementation plan

## Safety gate

The user approved fixing the audited issues but explicitly prohibited any live
session or remote-worker interruption. Implementation is source-only. PID
`1473`, `62652`, `44183`, `13629` and ports `3456`, `3457` are protected.

## Tasks

1. [x] Pin the branch, dirty fingerprint, live PID/port identity, L-grade scope,
   rollout, rollback, and cleanup contract.
2. [x] Add a failing test for Codex unsafe POST 5xx replay, observe RED, apply
   method-gated retry, and observe GREEN.
3. [x] Add a failing external-bind/empty-key test, observe RED, fail closed at
   startup, and observe GREEN.
4. [x] Add failing API-origin and redirect credential tests, observe RED,
   constrain the destination/redirect behavior, and observe GREEN.
5. [x] Add a failing request-log mode test, observe RED, create with
   `0600`, and observe GREEN.
6. [x] Add failing explicit-resume prompt and selector-conflict tests, observe
   RED, separate exact recovery identity from one-shot payload, validate the
   selector grammar, and observe GREEN.
7. [x] Add a failing pre-ready worker deadline test, observe RED, add bounded
   waiter failure and cleanup, and observe GREEN.
8. [x] Add failing concurrent response/spool aggregate-budget tests, observe
   RED, add shared reservation/release accounting, and observe GREEN.
9. [x] Add failing forged/stale/reused lifecycle PID tests, observe RED, bind
   destructive actions to process identity, and observe GREEN.
10. [x] Run the affected test suites and syntax diagnostics, fixing only
    regressions caused by this task.
11. [x] Execute throwaway CLI/HTTP manual QA for all nine boundaries; capture
    redacted evidence and remove every owned PID, listener, config, and temp
    path.
12. [ ] Queue the full suite through `qgate`, run lint/package checks, and bind
    results to the final exact source fingerprint.
13. [ ] Launch five fresh non-fork `review-work` lanes in parallel. Fix and
    rerun affected lanes until all pass.
14. [ ] Reconfirm protected PID/port identity and remote-worker connectivity,
    close the verification log, and leave live daemons untouched.

## Verification log

- Baseline 2026-08-13: protected PIDs `1473`, `62652`, `44183`, `13629` alive;
  listeners `*:3457` and `*:3456` owned by the corresponding supervisors.
- Unsafe POST RED: one Codex `/responses` POST reached the local upstream four
  times after 503. GREEN: the same isolated fixture reached it once and passed
  through 503; the adjacent unsafe 529 regression also passed.
- Empty-key RED: no startup validator existed and prior isolated HTTP QA reached
  status without authentication. GREEN: startup now rejects missing/empty keys
  before creating the public listener; targeted test and syntax checks pass.
- API-origin RED: absolute URL reached a local sink and a cross-origin redirect
  was followed to 200. GREEN: only a single-slash relative path is accepted and
  redirects are returned without following; both isolated CLI tests pass.
- Request-log RED: runtime mode was `0644`. GREEN: files are created with
  explicit `0600`; the capped SSE log test passes without truncating clients.
- Resume RED: positional prompt reached both recovery children and conflicting
  `--last --all` launched Codex. GREEN: retry retains only recognized option
  prefix and exact UUID; selectors fail before launch. Codex suite 21/21 PASS.
- Pre-ready RED: an early request waited until delayed worker readiness and
  returned 200. GREEN: waiter deadline returns 503 within the configured bound,
  cleans its reservation, and the supervisor serves 200 after readiness.
- Aggregate-budget RED: concurrent retained spool/response copies exceeded the
  configured process cap. GREEN: shared response, auxiliary, and log
  reservations reject over-cap work and release on finish/close/error.
- Lifecycle RED: legacy/forged state could reach signal intent. GREEN:
  missing/stale/reused/birth-mismatched identity fails closed before signal.
- OAuth raw-relay RED: 307/308 followed the cross-origin `Location` and resent
  the refresh-token POST body. GREEN: manual redirects return 307/308 with the
  original `Location`; isolated sink hits remain `0`.
- Non-SSE log RED: request and response bodies were pretty-stringified into
  unbounded duplicate strings and an asynchronous flush escaped the shared
  response budget. GREEN: each body log is capped at 16 KiB, written section by
  section with `0600`, and its reservation remains held until flush `finally`.
- Continuation targeted boundary run: `3/3 PASS`; prior affected suite at the
  same source state: `107/107 PASS`.
- Continuation static/package: `node --check`, offline cached ESLint on changed
  files, `git diff --check`, and `npm pack --dry-run --json` all PASS.
- Continuation isolated HTTP QA: OAuth 307/308 sink hits `0`; non-SSE response
  unchanged with a 33,378-byte `0600` log; pending flush `502`, after release
  `200`; every owned listener/temp directory removed.
- Immutable generation-4 snapshot manifest `4e17d500…`: snapshot targeted
  `107/107 PASS` and snapshot HTTP QA PASS with teardown.
- Full suite queued exactly once through qgate ticket
  `1786679979919127000-7360` with label
  `teamcodex-hardening-v4-4e17d500-full-suite`.
- Exact-snapshot code, security, context/history, and fresh hands-on QA lanes
  PASS. Goal/constraints waits for the full-suite qgate result.
- Full-suite qgate remains pending because the machine-wide gate is closed;
  no bypass was used.
