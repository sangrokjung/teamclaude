# Spec — 401 cascade guard (one bad request must not park the fleet)

Status: implemented
Date: 2026-09-05
Area: `src/server.js` (`forwardRequest` 401 handler)
Severity: incident-driven (most of a production pool parked at once)

## Incident

2026-09-05, a production pool lost most of its usable accounts within seconds.
Each of them was marked `status='error'`, `errorReason='auth-rejected'`, all
sharing the same `lastUsed` minute. The daemon log shows what happened: a SINGLE
request walked the failover chain and every account it touched answered 401.

```
401 on "<account-1>" — forcing token refresh and retrying
Token refreshed for account "<account-1>"        ← the refresh SUCCEEDED
401 on "<account-1>" — auth failed, marking account error
Switched to account "<account-2>" (current unavailable)
... identical block, account after account ...
Model fallback: claude-opus-5 → claude-sonnet-5 (no usable account)
```

Post-incident probe (a sample of the parked accounts, same OAuth headers the
proxy sends): `POST https://api.anthropic.com/v1/messages` returned
**200 OK on every one**. The credentials were never bad. The 401s were a
transient upstream condition, and the pool stayed crippled for ~1.5h because a
request-path auth error is deliberately not self-healing (only `reauth`,
re-import, or a restart clears it). Recovery required a daemon restart.

## Problem

The 401 handler treats every 401 as **account-scoped** evidence:

> "a 401 on a still-valid token is account-level rejection evidence"

That inference holds for ONE account. It does not hold when the SAME request is
rejected by account after account: at that point the shared variable is the
request, not the credential. The current code has no notion of request-scoped
rejection, so a single poisoned request can park an unbounded number of
accounts — the whole fleet, in the worst case.

## Goal

A 401 that repeats across accounts within one request must be attributed to the
request, not to the accounts.

## Non-goals

- Detecting WHICH property of the request upstream rejected. Out of scope.
- Changing what the client sees. A request that no account will serve still ends
  in the existing `401 … All accounts failed authentication.` response.
- Persisting anything. `status`/`errorReason` stay in-memory, as today.
- Touching the 403 (subscription-disabled), 429, or 5xx paths.

## Design

Request-scoped cascade detection with retroactive un-parking.

1. `ctx.auth401` (a `Set` of account objects) records every account whose 401 is
   **unexplained** — i.e. the account was not already parked when the 401 came
   back. It joins `tried429`/`tried5xx` in `excludeForSelect`, so a non-parked
   401 account is still never re-selected inside the same request (the old code
   got that exclusion for free from parking; without it, skipping the park would
   loop). An account that arrives already `error` needs no exclusion — its
   status removes it from selection — and must not be counted (see 6).
2. The first 401 parks its account exactly as before (single revoked account —
   the common, correct case).
3. When the SECOND distinct account answers 401 in the same request
   (`AUTH_401_CASCADE_THRESHOLD = 2`), the handler declares a cascade:
   - it un-parks the accounts THIS request parked, and
   - it parks no further account for the rest of the request.
4. Un-parking is guarded by ownership plus observable state. Each park stamps
   `account._authParkSeq` with a process-monotonic sequence, and the rollback
   restores an account only if that stamp is still this request's AND the
   account still reads exactly as this request wrote it (`status === 'error'`,
   `errorReason === 'auth-rejected'`, `_errorFromRefresh === false`). A later
   park stamps its own sequence, and `updateAccountTokens` (re-import / login)
   heals the status outright — both outrank the revert.

   Credential *generation* deliberately does not gate the rollback (Codex
   review, 2026-09-05). The background `refreshLapsedTokens` sweep bumps the
   generation but only heals accounts whose error came from a refresh failure,
   so an `auth-rejected` park survives it untouched. Gating on the generation
   would therefore skip the rollback whenever a sweep happened to land between
   the park and the cascade, stranding an account whose credentials had just
   been proven good — reproducing this spec's own outage in a narrow window.
5. Independent evidence is never discarded. An account already in `error` when
   the 401 arrives (typically `refresh-failed`, set by `ensureTokenFresh`) is
   neither relabeled nor un-parked during a cascade: the token endpoint rejected
   it on its own, which is account-scoped evidence that does not depend on this
   request. Keeping the `refresh-failed` label also keeps `_errorFromRefresh`
   true, which is what lets the token-refresh sweep heal the account later.
6. **Only unexplained 401s count toward the threshold** (adversarial review,
   2026-09-05). An account already parked by its own evidence has a 401 that is
   already explained without blaming the request, so counting it would inflate
   the tally: in a fleet that merely contains one degraded account, the NEXT
   account — whose 401 is genuinely unexplained — would trip the guard and
   escape parking, staying in rotation and invisible in `teamclaude status`.
   Reproduced before the fix; covered by a test with that visit order.

### Why threshold 2

Two accounts rejecting one request is already stronger evidence about the
request than about the credentials: the accounts are independent, the request is
not. The cost of the two possible mistakes is asymmetric.

- False "cascade" (two genuinely revoked accounts back to back): they are not
  parked this time. The request still fails over to a healthy account, and the
  next request that hits one of them alone parks it normally. Cost: a few wasted
  failovers.
- False "account bad" (what happens today): up to N accounts parked for hours
  until a human notices and restarts. Cost: an outage. Observed.

### Failover is unchanged

A cascade does not abort the request. It keeps failing over exactly as before,
so a request that IS servable (e.g. two revoked accounts and a healthy third)
still succeeds. Only the parking side effect is suppressed.

## Acceptance criteria

1. Every account answering 401 to one request → **zero** accounts parked, client
   still gets 401, and no account is retried more than the existing
   refresh-retry allows.
2. One account 401s, another serves → the 401 account is still parked
   (`status='error'`, `errorReason='auth-rejected'`) and the client gets 200.
   (Existing regression test must keep passing unchanged.)
3. During a cascade, an account that was already `error`/`refresh-failed` before
   the request stays `error` and keeps its reason.
4. During a cascade, an account parked earlier in the SAME request is restored
   to its previous status and `errorReason`.
5. A cascade emits one operator-visible log line naming the count, so the
   condition is diagnosable from the daemon log.
6. A degraded account visited FIRST does not buy the next account immunity: a
   single unexplained 401 still parks its account even when an already-parked
   account was visited before it.
7. The literal incident shape — forced refresh succeeds, the retried request is
   rejected again, across accounts — parks nobody, and each account is charged
   exactly its one post-refresh retry.
8. A request nobody authenticates fails fast (asserted under the default 15-min
   continuity deadline), it does not sit in the capacity wait.
9. A background token refresh landing between the park and the cascade does not
   block the rollback.

## Verification

- `node --test test/server-401.test.js` (new cascade cases + existing cases)
- `node --test` full suite
- `npx eslint src/ test/`
- Independent adversarial review (maker ≠ checker) + cross-model review (Codex)

## Ordering requirement for any "promote a 401 to persistent revocation" change

If a change is added that promotes a 401 to a PERSISTED revocation
(`setAuthRevoked(..., persist)`) — for example on the grounds that the token
generation actually advanced before the second 401 — it must be evaluated
**after** the cascade check, and must not fire while `ctx.authCascade` is set.

This is not hypothetical. In the incident above every account returned its
second 401 immediately after a *successful* refresh, so a fresh-token promotion
rule would have matched all of them. The parks were in-memory, which is why a
daemon restart recovered the pool in seconds; persisted revocations would have
survived the restart and required a manual re-login per account. A rule meant to
catch one genuinely revoked account would have converted a transient upstream
condition into a fleet-wide lockout.

Promote only when the 401 is unexplained by the request — i.e. outside a cascade.

## Follow-ups raised by review (deliberately NOT in this change)

Both reviewers approved the change and each left one item outside its scope.
Recorded here so they are not lost:

- **MEDIUM, pre-existing.** The final relabel branch (`else if (account.authRevoked !== true && account.expiresAt && …)`) overwrites whatever `errorReason` an account already had. Under genuine concurrency — another request calling `setSubscriptionDisabled` on an account while this request's already-dispatched call to it returns 401 — it rewrites `'subscription-disabled'` to `'auth-rejected'` while the persistent `subscriptionDisabled` flag stays true. The account then falls out of `recheckSubscriptionDisabled()`'s targets and is stranded until re-import or restart. Unchanged context in this diff (verified against the base commit), reproduced by the reviewer. Fix separately: never let this branch overwrite an `errorReason` that some other path owns.
- **LOW, hygiene.** `updateAccountTokens`' healing path clears `status`/`errorReason`/`_errorFromRefresh` but not a leftover `_authParkSeq`. Inert — the rollback guard's own `status !== 'error'` check blocks any later restore regardless — so it is stale state, not a bug.

## Rollback

Single-file, additive change. Reverting the commit restores the previous
behavior; nothing is persisted, so no migration or cleanup is involved.
