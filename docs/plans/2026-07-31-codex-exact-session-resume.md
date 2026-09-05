# Codex exact-session resume implementation plan

## Tasks

1. [x] Add failing tests for explicit-ID resume, current-cmux-surface resume, and
   fail-closed behavior when no trustworthy binding exists.
   - Verifier: targeted `node --test test/codex-resume.test.js` fails for the
     missing command/behavior.
2. [x] Add a zero-dependency Codex session boundary that parses the public
   `cmux surface resume get --json` response.
   - Verifier: parser tests accept only a Codex UUID checkpoint.
3. [x] Route `teamcodex codex resume` through the existing Codex run launcher.
   - Verifier: fake Codex receives exactly one provider-configured
     `resume SESSION_ID` invocation.
4. [x] Document the incident, process-scoped provider behavior, exact recovery
   command, missing-binding fallback, and rollback.
   - Verifier: public help, English/Korean README, architecture notes, and the
     runbook agree on command syntax and fail-closed semantics.
5. [x] Run targeted tests, the complete test suite, ESLint, and a real cmux
   surface smoke test.
   - Verifier: all commands exit 0 and the surface binding contains the exact
     checkpoint plus TeamCodex provider override.
6. [ ] Run independent adversarial review, synchronize task documents, then
   commit, push, open a PR, wait for CI, and merge to `master`.
   - Verifier: reviewer PASS is bound to the reviewed commit; GitHub reports
     the PR merged and local `master` matches `origin/master`.
7. [x] Add failing-first tests for bounded automatic recovery after an
   unexpected child exit: new current-surface UUID resumes once; stale,
   missing, malformed, signal, cancel-130, and repeated failure fail closed.
   - Verifier: old single-spawn implementation fails the new exact recovery
     assertion while existing success/cancel characterization stays green.
8. [x] Replace the Codex one-shot spawn branch with the smallest sequential
   recovery controller that captures the pre-launch binding, accepts only a
   nonce/session-bound proxy receipt matching a newly established or explicit
   exact UUID, shares a fixed five-second deadline, and performs one
   provider-enforced resume.
   - Verifier: targeted RED becomes GREEN and invocation logs contain no
     selector, recency, cwd, or alternate-provider path.
9. [x] Correct supervisor documentation and runbook guidance: unsafe POST is
   never replayed, live daemon must actually load the health protection, and
   exact-session recovery occurs at the CLI layer.
   - Verifier: spec, runbook, README/CLAUDE architecture notes and integration
     test state the same boundary.
10. [ ] Run isolated real-surface CLI/supervisor QA, qgate full regression,
    ESLint, cleanup, then fresh-context adversarial review until APPROVE.
    - Verifier: evidence artifacts bind happy, fail-closed, regression and
      reviewer verdict to the current diff.
11. [x] Close adversarial routing/privacy/deadline blockers: validate provider
    configuration for both run and resume, redact checkpoint UUIDs from the
    retry diagnostic, and cap readiness probes plus sleeps to five seconds.
    - Verifier: `test/codex-run.test.js` and `test/codex-resume.test.js` contain
      mutation-sensitive RED→GREEN cases for all three boundaries.
12. [x] Replace binding-only attribution with a structured recovery receipt.
    - Verifier: parser/provider mutation proof, unrelated-child error and
      receipt-mismatch wrapper tests, and supervisor one-time consume test.
13. [x] Close receipt boundary leaks: strip the invocation nonce before
    upstream forwarding and permit receipt minting only for the exact responses
    inference endpoint.
    - Verifier: both new assertions fail before the fix and pass afterward;
      impacted Codex suite passes 41/41 with ESLint and diff check clean.
14. [x] Cover every ambiguous unsafe responses failure and remove forged
    internal receipt headers across all response statuses.
    - Verifier: dispatched timeout, response-size, unclassified error, and
      forged 429 tests fail before the fix, then pass with the 5xx/non-POST
      boundaries.
    - Verifier: supervisor partial-SSE integration consumes the receipt once,
      while the clean terminal follow-up returns 404 from the consume endpoint.
15. [ ] Run qgate full regression, isolated CLI/HTTP real-surface QA, deploy the
    verified supervisor at zero inflight, and obtain fresh unconditional
    adversarial approval.
    - Verifier: evidence artifacts and reviewer verdict bind to the current
      change reference; live status returns 200 after PID/start-time change.
16. [x] Close watchdog checkpoint trust and stream-disconnect evidence gaps.
    - Verifier: local None/empty/non-UUID/UUIDv1/v4/v8 and remote command
      mismatch/decoy token return no candidate; exact stream and 2/3-line wraps
      match; arbitrary suffix and normal-output quotation do not.
      `sc18-watchdog-binding-green.txt` records 38/38, py_compile, and a
      complete live dry-run with trusted local/remote candidates.
17. [x] Remove the external guard's high-inflight destructive restart policy.
    - Verifier: `test_teamcodex_proxy_guard.py` proves status 200 and a live
      listener never invoke launchctl, while three absent-listener samples
      invoke one `kickstart` without `-k`.
18. [x] Preserve stable cmux identity while targeting the current surface ref.
    - Verifier: watchdog RED→GREEN retains `id` plus `surface:N`, reads/sends
      only through the ref, rechecks the mapping twice, and suppresses send
      when the ref changes; all 43 watchdog tests pass.
19. [x] Run isolated post-dispatch tunnel-disconnect QA, qgate regression,
    live launchd/rollback verification, and two independent adversarial lanes.
    - Verifier: `.omo/evidence/teamcodex-502-self-heal/` contains upstream POST
    count 1, unchanged proxy PID, continuation count 1, cleanup receipt,
    rollback hashes, and two unconditional approvals.
20. [x] Extend the exact-session watchdog for the selected-model capacity
    warning without automatic model switching.
    - Verifier: exact/near-match/quotation/user-draft/model-status tests,
      proxy-probe bypass, duplicate cooldown, existing TOCTOU tests, live
      dry-run, and a gate-owned fresh checker all pass.

## Verification log

- Red: `node --test test/codex-resume.test.js` failed because `resume` was an
  unknown command.
- Targeted: `node --test test/codex-resume.test.js test/codex-run.test.js
  test/codex-session.test.js test/codex.test.js` passed 13/13 after the
  resume-argument ordering, alternate-route, and cmux credential-boundary
  fixes.
- Full: `qgate.py run --slot heavy -- npm test` passed 412/412 on the final
  `fork/master`-based branch.
- Lint: `npx --yes eslint .` exited 0. (`npm run lint` could not locate a local
  ESLint binary; no dependency was added.)
- Package surface: `npm pack --dry-run --json` included
  `src/codex-session.js`.
- Manual cmux QA: a temporary surface supplied a synthetic checkpoint; the cmux
  wrapper captured `resume SESSION_ID` followed by
  `model_provider="teamcodex_proxy"`. A live agent-hook binding with that same
  ordering preserved the TeamCodex provider in its public restore command.
- Manual CLI QA: source entrypoint invocations with `--remote` and `--oss`
  both exited 1 before launching Codex and identified the provider-routing
  bypass.
- Independent review at `75b7fb1` found that forwarded options could replace
  the provider and that the cmux lookup inherited direct Codex credentials.
  Both were fixed and locked by CLI/subprocess regression tests before the
  final review SHA.
- Security review at `33700e5` found that Codex alternate execution flags
  bypassed `model_provider` despite the final override. Resume now rejects
  remote/local provider flags, with each accepted spelling covered by the
  CLI regression test.
- A later adversarial parser pass confirmed Codex 0.147.0 also accepts compact
  `-cVALUE` and `-c=VALUE`. Both `run` and `resume` now normalize those forms
  before checking protected provider/base-URL keys, with RED→GREEN CLI tests.
- Housekeeping scan: `info`, 0 sensitive hits. Existing untracked `.omo/`
  remained untouched.
- Receipt boundary mutation: breaking the invocation validator and deleting
  `env_http_headers` produced 2/2 expected failures; restoring the production
  behavior passed 7/7 parser/provider tests.
- Receipt lifecycle RED: the local invocation nonce reached upstream and an
  unrelated POST minted a receipt. The fix strips the nonce, restricts minting
  to `/codex/responses`, and passes the two integration scenarios.
- Current impacted run: 41/41 Codex wrapper/session/proxy tests pass; impacted
  ESLint and `git diff --check` exit 0.
- Receipt-path adversarial RED: a dispatched response timeout returned 502
  without a recovery session header, and a forged upstream 429 header reached
  the public client. GREEN centralizes locally minted receipt headers, strips
  the internal header from every forwarding loop, limits supervisor acceptance
  to exact responses POSTs, and passes the current impacted suite 68/68.
- Security v3 RED: response-size rejection and an unclassified post-dispatch
  error each returned 502 without a receipt. GREEN routes both through the same
  exact POST/path/nonce/session helper; no request replay was added.
- Security v4 RED: a partial Codex SSE caused headers-sent socket termination
  with no receipt. GREEN makes the supervisor retain the already validated
  request identity and mint only on abnormal response abort before a terminal
  SSE; clean completion remains receipt-free.
- Real surface: a PTY-driven wrapper used an isolated live supervisor/worker and
  503 upstream. Upstream saw one request and no invocation nonce; the wrapper
  reopened the exact session once and exited 0. An unrelated child exit stayed
  at status 7 with one child. QA server, port, and temp directory were removed.
- Watchdog SC16: the expanded suite passed 38/38, including exact
  stream-disconnect positive, 2/3-line wraps, suffix/quotation negatives,
  UUIDv7 local checkpoints, remote command binding, send-time relookup, and
  final-screen TOCTOU. Production `--dry-run` found 12 trusted candidates with
  complete discovery, zero inspect errors, and zero submissions.
- Watchdog SC18 tightened that trust boundary after adversarial review:
  UUIDv1/v4/v8 local checkpoints and a decoy checkpoint placed after a different
  remote attach target now fail. Only exact three-token
  `qjc-agent attach <checkpoint>` bindings are accepted; the 38-test suite and
  production dry-run remain green.
- 2026-08-20 causal proof: `teamcodex_proxy_guard.py` restarted the live proxy
  after three normal high-inflight samples, and its `restarted inflight=14`
  timestamp matched the tunnel-disconnect 502. SC1 now passes 3/3 with no
  destructive `-k`. SC2 exposed a second failure: stable UUID binding lookup
  worked while `read-screen` returned `internal_error`; retaining and twice
  rechecking current `surface:N` turned the watchdog suite from four expected
  failures into 43/43 PASS.
- Final targeted qgate ticket `1787235887861374000-9249` passed guard 3/3,
  watchdog 43/43, runtime resilience 2/2, Codex recovery 16/16, supervisor 2/2,
  midstream no-replay 1/1, `py_compile`, ESLint, and `git diff --check`.
- Isolated HTTP QA ticket `1787235986411304000-23895` reproduced the exact
  post-dispatch tunnel 502 with one upstream POST, unchanged proxy PID, a
  following health 200, one same-session continuation, zero duplicate send on
  the next tick, and complete server/temp-resource cleanup.
- Independent lanes `tunnel_502_code_review` and
  `tunnel_502_safety_review` both returned unconditional `APPROVE` with no
  CRITICAL/HIGH findings. Rollback backups and recorded hashes were verified;
  production rollback was intentionally not executed because the old guard
  contains the incident-causing destructive `kickstart -k` policy.
- Capacity recovery: 61/61 watchdog tests and `py_compile` pass, including
  exact/near-match/quotation/user-draft/model-status/cooldown cases and the
  fresh-checker finding that wrapped proxy ports must participate in the
  fingerprint. Live qgate ticket `1787840631570646000-57208` inspected 15
  trusted surfaces with complete discovery, zero inspect errors, and zero
  submissions. The gate-owned `goal-correctness` lane approved source
  generation 2 at change ref
  `sha256:5b85dad3591d724eb9bacfb4684075e0f763d41148b0f6f1c1eda000d70c5328`.
  A temporary real cmux surface then displayed the exact capacity warning under
  a UUIDv7 Codex resume binding; the production watchdog matched once,
  submitted once, preserved `gpt-5.6-sol`, and sent no `/model` command. The
  workspace and temporary QA directory were removed after observation.
- Upstream-connection 502 regression: the exact
  `Upstream connection failed after dispatch. Request was not replayed.` block
  at `http://127.0.0.1:61639/codex/responses` is explicitly covered by
  `test_exact_upstream_connection_failed_502_at_prompt_matches`. A reversible
  fixture mutation removing only that allowlist entry failed the test (RED),
  while the canonical implementation passed it (GREEN).
- The command-compatible production QA fixture matched port `61639` once,
  submitted one continuation to the exact current surface, and suppressed the
  immediate duplicate scan; no model switch or POST replay occurred. The
  scoped fresh gate-owned `goal-correctness` checker returned unconditional
  `APPROVE` at change ref
  `sha256:6309c5897b131d5514c845b010601cc666a2520dfce221fe146ad96a712ce55e`.
  A real cmux surface could not be created because the existing app sockets
  returned `Connection refused`; no user surface was restarted or mutated.
