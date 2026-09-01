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
   - The streak is in-memory only (restart resets it), resets on any positive
     auth evidence — a 2xx poll, an applied usage payload, or a **completed
     inference** on the same backend (`markAccountSuccess`) — and is *kept*
     (neither grown nor reset) across non-terminal noise: only positive auth
     evidence proves the credential, and a completed inference IS positive
     evidence, so an actively-serving account can never be quarantined by
     usage-endpoint-only 401/403s (WAF rule, endpoint contract change,
     plan/scope policy divergence on `/wham/usage`). Escalating consumes the
     streak, so the poll cadence itself paces re-escalation; no extra cooldown.
   - No new `errorReason` enum value is introduced (external dashboards keep
     rendering); the quarantine is distinguished by the in-memory cause tag
     `_errorFromUsagePoll`, which is never exposed in `getStatus()`.
   - **Exact park attribution.** The escalation's awaits (forced refresh,
     confirm re-poll) are windows in which OTHER paths can park the same
     account. The watchdog claims a park as its own — i.e. tags
     `_errorFromUsagePoll` — only on precise evidence: after the forced
     refresh, only when the park is refresh-caused (`_errorFromRefresh` is
     `true`, reason `refresh-failed` — including the r7 delegation's
     refresh-failed entry); after the confirm re-poll, only its own
     `markAuthenticationError` call, tagged synchronously with no await in
     between. A request-path 401 park (`auth-revoked`, `_errorFromRefresh`
     `false`) landing inside either window is left untouched and keeps its
     stricter healing rules; an account found already parked at the confirm
     step is never re-marked or re-tagged.
   - **Circuit breaker (the pool never empties on poll-only evidence).** Right
     before the confirm-path park, the watchdog asks whether any OTHER account
     is currently available for rotation
     (`AccountManager.hasOtherAvailableAccount`, aligned with the existing
     `_isAvailable` notion: enabled, un-parked, un-throttled, under
     threshold). If parking would leave zero available accounts, the park is
     withheld with a single log line; the streak stays consumed, so the next
     threshold crossing re-judges availability. Rationale: an idle pool has no
     completed inferences to protect the streak, so a usage-endpoint-only
     401/403 outage (WAF rule, endpoint contract change, `/wham/usage` policy
     divergence) would otherwise park the entire fleet within three poll
     cycles (live-fired). Request-path 401 parks and terminal token-refresh
     failures are deliberately NOT breaker-gated: if every account is truly
     revoked, real request traffic (or the token endpoint's `invalid_grant`)
     still parks the last account on genuine evidence, so correctness is
     preserved while poll-only false positives cannot stop the pool.
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

Covered by `test/server-codex-auto-detect.test.js` (18 tests):

- Below-threshold terminal failures and any amount of 5xx/429 change nothing.
- A completed inference through the proxy resets the terminal poll streak
  (unit + integration), so a serving account never escalates on poll-only
  401/403s.
- Streak + terminal refresh parks as `refresh-failed`; streak + refresh success
  + terminal confirm parks as `auth-revoked`; healthy confirm cancels.
- 403 counts like 401; `codexAuthFailureThreshold: 1` escalates immediately.
- A parked account is out of rotation (`getActiveAccount()` → null when alone),
  never re-escalates while parked, and heals on the next valid poll.
- A declared due cancellation ends up `subscription-ended` (persisted) and
  reopens to `scheduled` on success (r7 semantics intact).
- A request-path park survives poll successes (pinned).
- A request-path park landing during the escalation's forced-refresh await is
  not claimed by the watchdog (no `_errorFromUsagePoll` tag) and still
  survives a later poll success.
- The circuit breaker withholds the confirm-path park when no other account is
  available (the account stays `active`, the deferral re-judges on the next
  streak, a valid poll still resets the streak), while a direct request-path
  `markAuthenticationError` may still park that last account.
- `updateAccountTokens` (credential re-import) clears the terminal poll
  streak.

## Rollback

Set `codexAuthFailureThreshold` very high (e.g. `1000000`) to effectively
disable escalation, or revert the feature commits. No config/schema migration
is involved (the cause tag and streak are in-memory only; `errorReason` values
are pre-existing).
