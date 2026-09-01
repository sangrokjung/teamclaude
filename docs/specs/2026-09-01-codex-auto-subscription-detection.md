# Codex Auto Subscription Detection (2026-09-01)

## Goal

Without any operator declaration, the codex pool detects a ChatGPT account whose
subscription was cancelled or terminated, removes it from rotation on its own,
and brings it back on its own when the subscription returns. The pool never
stops: only the affected account is parked, and the existing continuity/429
behavior applies when the whole fleet is out.

This layers on top of the declared cancellation tracking
(`docs/specs/2026-08-31-codex-subscription-cancellation-tracking.md`, "r7").
The declared path is unchanged; when a declaration exists and its rules can
classify the failure as `subscription-ended`, this feature delegates to it.

## Evidence rules

1. **Terminal poll evidence.** The periodic `GET /wham/usage` poll doubles as a
   credential health check. Only HTTP **401/403** on the poll are terminal auth
   evidence. Network errors, timeouts, 5xx, 429, and parse failures remain
   non-terminal and mutate no account state (spec r7 rule 8 preserved).
2. **Streak, then confirm.** `codexAuthFailureThreshold` (default 3, min 1)
   consecutive terminal poll failures on one account escalate to: one forced
   token refresh, then (if the account is not already parked by the refresh)
   one confirm re-poll. The account is parked (`status: 'error'`) only when
   the refresh itself fails terminally (401 / `invalid_grant` →
   `refresh-failed` reason via the existing `ensureTokenFresh` path, including
   the r7 delegation to `subscription-ended` when a declared cancellation is
   due) or when the confirm re-poll is terminal again (`auth-revoked`). A
   healthy or inconclusive confirm cancels the escalation without parking.
   - The streak is in-memory only (restart resets it), resets on any 2xx poll,
     and is *kept* (neither grown nor reset) across non-terminal noise: only
     positive auth evidence proves the credential. Escalating consumes the
     streak, so the poll cadence itself paces re-escalation; no extra cooldown.
   - No new `errorReason` enum value is introduced (external dashboards keep
     rendering); the quarantine is distinguished by the in-memory cause tag
     `_errorFromUsagePoll`, which is never exposed in `getStatus()`.
3. **Auto-recovery.** Parked accounts stay poll targets. A valid usage poll
   success (2xx + applied windows → `markAccountSuccess`) automatically
   returns to `active`: accounts tagged `_errorFromUsagePoll` (this feature's
   parks) and `subscription-ended` accounts (r7's existing reopen). A
   request-path auth park (server 401 handler, no tag) is **not** healed by a
   poll success; its existing healing rules (re-import, restart, cause-scoped
   refresh success) are untouched, and a request-path re-park clears any stale
   tag so it cannot become poll-healable.
4. **Re-park.** After recovery, a fresh terminal streak re-applies the same
   rule.

## Acceptance criteria

Covered by `test/server-codex-auto-detect.test.js` (12 tests):

- Below-threshold terminal failures and any amount of 5xx/429 change nothing.
- Streak + terminal refresh parks as `refresh-failed`; streak + refresh success
  + terminal confirm parks as `auth-revoked`; healthy confirm cancels.
- 403 counts like 401; `codexAuthFailureThreshold: 1` escalates immediately.
- A parked account is out of rotation (`getActiveAccount()` → null when alone),
  never re-escalates while parked, and heals on the next valid poll.
- A declared due cancellation ends up `subscription-ended` (persisted) and
  reopens to `scheduled` on success (r7 semantics intact).
- A request-path park survives poll successes (pinned).

## Rollback

Set `codexAuthFailureThreshold` very high (e.g. `1000000`) to effectively
disable escalation, or revert the feature commits. No config/schema migration
is involved (the cause tag and streak are in-memory only; `errorReason` values
are pre-existing).
