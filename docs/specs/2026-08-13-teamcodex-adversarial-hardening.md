# TeamCodex adversarial hardening

Status: Approved for source-only implementation by the user's 2026-08-13 fix
request. Live rollout is explicitly out of scope.

## Problem

The current audit found trust-boundary, retry, recovery, lifecycle, and
aggregate-resource paths that can expose credentials, duplicate an unsafe
request, repeat a prompt, signal an unrelated process, or wait/grow without a
total bound. The production supervisors and workers are serving active local
and remote sessions, so applying the code to those processes during the fix
would itself violate the availability requirement.

## Goal

Close the confirmed CRITICAL/HIGH boundaries with failing-first tests and
isolated runtime QA while preserving all existing live TeamClaude/TeamCodex
sessions and the main-machine/worker-machine connection.

## Non-goals

- Restarting, reloading, stopping, replacing, or otherwise changing the live
  supervisors/workers on ports `3456` and `3457`.
- Sending adversarial QA traffic through those protected ports.
- Refactoring unrelated routing, account selection, TUI, or recovery code.
- Adding runtime dependencies or changing public provider behavior unrelated
  to the audited boundaries.
- Deploying, publishing, committing, pushing, or merging the fix.

## Requirements

1. An unsafe Codex POST that receives a 5xx response is not internally replayed.
   Replay-safe requests may retain their bounded recovery behavior.
2. A listener reachable beyond loopback cannot become unauthenticated because
   `proxy.apiKey` is empty, missing, or malformed. Startup fails closed before
   accepting traffic.
3. `teamcodex api` sends configured credentials only to a validated trusted
   TeamCodex destination. Absolute URL overrides and redirects cannot carry
   credentials to another origin. The raw OAuth relay also never follows a
   redirect with the client refresh-token POST body.
4. Request-log files are created owner-only (`0600`) without a permissive
   creation window.
5. Automatic recovery of an explicit `codex resume SESSION_ID -- PROMPT`
   never submits `PROMPT` twice. Recovery may reopen the same exact session
   once, but must remove the one-shot prompt payload.
6. Mutually exclusive or ambiguous resume selectors such as `--last --all`
   fail before a child process is launched.
7. Requests that arrive before a worker becomes ready have a configured total
   deadline, release their waiter/buffer reservations, and return a complete
   bounded failure.
8. Buffered upstream response/spool bytes share a process-wide aggregate
   budget. Concurrent responses cannot exceed it, and every completion,
   failure, cancellation, and shutdown releases the reservation. Request-log
   body copies and pending asynchronous log flushes use the same budget and
   stay bounded without changing the client response.
9. Stop/restart/status lifecycle actions bind the state-file PID to a verified
   process birth identity and expected command identity before sending a
   signal. Missing, legacy, stale, reused, or forged identity fails closed.
10. No change may signal or restart protected PID `1473`, `62652`, `44183`, or
    `13629`, bind to protected port `3456`/`3457`, or alter remote-worker
    connection settings.

## Acceptance criteria

- [ ] Each of requirements 1–9 has a mutation-sensitive failing-first test and
  a passing targeted regression after the minimum fix.
- [ ] Throwaway HTTP/CLI QA observes one upstream send for the unsafe POST,
  credential non-disclosure, owner-only logging, bounded readiness, bounded
  aggregate spooling, exact resume without prompt replay, selector rejection,
  and stale lifecycle-state rejection.
- [ ] All throwaway listeners, child processes, configs, and temporary roots
  are removed; no protected PID receives a signal.
- [ ] The full suite runs through `qgate` and passes, or every pre-existing
  failure is separated with unchanged-input evidence.
- [ ] Lint/syntax and package-surface checks pass without adding dependencies.
- [ ] Five fresh non-fork review lanes pass: goal/constraints, hands-on QA,
  code quality, security, and context/history.
- [ ] Protected PIDs and listeners are identical at the final observation, and
  the main/worker connection remains established.

## Alternatives

- Live hot-patching was rejected because it can reload the source beneath
  active sessions and violates the explicit no-interruption constraint.
- Disabling all retry/recovery was rejected because safe GET/429 continuity is
  existing behavior and broader than the audited defect.
- Relying on documentation warnings was rejected because the failures occur at
  executable trust boundaries.

## Decision

Use surgical, boundary-local checks backed by existing zero-dependency
primitives. Implement and validate only in separate processes with throwaway
configuration. Leave the protected daemons on their currently loaded code.

## Migration

No data migration. New lifecycle state fields, if required, must be written
atomically and treat older state as non-authoritative for destructive actions.

## Rollout

This task ends with source and evidence only. A later, separately approved
maintenance action may restart one service at a time after active sessions are
drained and remote-worker health is verified.

## Rollback

Because live processes do not load this diff, runtime rollback is unnecessary.
Source rollback is the exact task diff only; pre-existing dirty changes are not
reverted. Any future rollout rollback restores the prior package and restarts
only during an approved maintenance window.

## Observability

Record redacted test counts, HTTP statuses, upstream hit counts, elapsed
deadlines, aggregate-byte counters, file modes, child argv shapes, process
identity verdicts, cleanup receipts, and protected PID/port snapshots. Never
record credentials, prompt content, or checkpoint UUIDs.

## Runbook

1. Confirm protected PIDs/ports and capture source fingerprint.
2. Run each RED/GREEN test with fake credentials and OS-assigned ports.
3. Run throwaway CLI/HTTP surface QA and close only owned resources.
4. Queue the full suite through `qgate`; do not bypass the load gate.
5. Run five independent reviewers against the final exact change reference.
6. Reconfirm protected process identity and connection state.
7. Do not restart or reload. Report that the fix is present on disk only.

## Risks

- Existing dirty changes touch the same central files. Every patch must be
  anchored to current source and avoid reverting neighboring work.
- A too-broad retry restriction could break safe read recovery; tests must
  separate method safety from status classification.
- A too-small aggregate budget could reject valid traffic; defaults must be
  derived from existing per-response limits and preserve current single-flow
  behavior.
- PID identity is platform-sensitive; verification must use stable birth and
  command evidence already available on supported platforms and fail closed
  when it cannot prove identity.

## Verification

- Targeted Node tests for every requirement.
- Throwaway process CLI/HTTP QA on OS-assigned loopback ports.
- `python3 ~/.claude/scripts/qgate.py run --slot heavy -- npm test`.
- `npm run lint` when the local binary exists; otherwise the repository's
  documented `npx --yes eslint .` path without adding a dependency.
- `npm pack --dry-run --json`.
- Fresh non-fork five-lane `review-work` gate.

### Continuation evidence (2026-08-14)

- OAuth 307/308 isolated HTTP QA returns the redirect and preserves `Location`
  without reaching the cross-origin sink (`sinkHits=0`).
- Non-SSE request/response logs retain at most the bounded prefix, use `0600`,
  and do not alter a 200,013-byte client response.
- A deliberately stalled asynchronous log flush retains its shared-budget
  reservation (competing response `502`) and releases it after completion
  (same response class subsequently `200`).
- Every continuation QA listener used an OS-assigned port; all owned listeners
  and temporary log directories were closed/removed in the QA `finally` path.
