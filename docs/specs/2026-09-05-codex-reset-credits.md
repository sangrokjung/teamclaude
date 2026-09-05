# Codex rate-limit reset credits — automatic redemption (2026-09-05)

## Status (2026-09-05)

- Scope: M (new module + 3 source files + 2 test files; request-path contract
  extension on the fleet-exhausted branch). Spec written before code.
- Branch `feat/codex-reset-credits-20260905`, cut from the production lineage
  `prod/codex-usage-limit-fail-fast-20260905` (= live artifact `adea84fd…`).
- Operator request (2026-09-05): "teamcodex에서 Codex 사용량이 전부 사용되면
  리셋 쿠폰을 자동으로 사용해서 계속 진행하게" — when the Codex pool is out
  of usage, redeem the ChatGPT *rate-limit reset credit* (the "Full reset"
  entry the Codex CLI shows under `/usage`) automatically instead of failing.
- Review round 1 (commit `0c27bd2`, independent 3-lens adversarial workflow +
  2 refuters per finding + completeness critic, maker ≠ checker):
  REQUEST_CHANGES ×3. Confirmed defects fixed in round 2: account policy
  bypassed every eligibility guard; a 429 dispatched before the reset landed
  re-marked the account and could burn a second credit; indeterminate
  (timeout/5xx) outcomes let the fleet walk spend another credit; a
  model-quarantined account could be reset for nothing; the account-policy
  retry chain could end in the legacy "All accounts throttled" body; the
  1.5 s authoritative refresh could revert a lagging meter to 100%; the
  operator route's loopback fence was dead under the production supervisor
  (worker only sees loopback); `reset` with `windows_reset: 0` was applied
  as a full reset; the no-candidate dead end was silent;
  `codexResetCreditsTimeoutMs` was undocumented. Coverage gaps closed:
  restart snapshot import, non-loopback 403 (worker + supervisor),
  concurrency, and the "reset not honoured" bound.
- Review round 2 (commit `a912a0a`, 2 fresh lenses + 2 refuters per finding):
  all 11 round-1 fixes confirmed to hold; 3 residual defects fixed in round 3:
  the account-policy redemption did not count as the request's single pass
  (a second credit could be spent at the following dead end — 2 per request,
  not unbounded; live config uses the fleet policy so no production
  exposure); the fleet walk kept spending after a concurrent operator/other
  reset had already resolved the dead end (now yields when any account is
  usable/capped). Tests added for both.
- Review round 3 (commit `2f89c60`, 2 fresh lenses + refuters): production
  (fleet) path traced regression-free; 4 residual items on non-default
  configurations fixed in round 4: the account-path redemption charged the
  request's pass only on `reset` (now on any outcome that may have spent —
  `reset`, `reset_no_windows`, indeterminate); the "dead end resolved?"
  yield used a pool-wide view instead of the request's credential-type scope
  (now a caller-supplied predicate); with `codexResetCreditsCooldownMs: 0`
  the account policy could redeem again after a fleet pass (now gated on the
  request's pass budget); a grace-held authoritative poll was reported as a
  failed refresh (now counts as recognized). Tests added for all four.
- Review round 4 (commit `8701da7`, 2 lenses): **APPROVE / APPROVE**. Two
  low items applied in round 5 (`acf07c9`): a fleet walk that found no
  eligible candidate no longer charges the request's pass (a later
  account-policy redemption may still be its first spend), and accepted
  (non-429) responses inside the post-reset grace no longer fold their
  lagging `x-codex-*` meter (third consistency fence, see Goal 4).
- Review round 5 (commit `acf07c9`): production lens APPROVE; one medium
  regression on `codexResetCreditsCooldownMs: 0` fixed in round 6: the pass
  is now charged by ANY real backend attempt (even a definite no-spend
  answer), and left unspent only when the walk never reached the backend —
  otherwise the wait loop could re-POST consume on every iteration. Also: a
  held header fold still records the request in the usage counters.
- Review round 6 (commit `0865c6c`, 2 lenses): **APPROVE / APPROVE**. Known
  low residual, deliberately not fixed in this release: with the
  non-default combination `codexResetCreditsPolicy: "account"` +
  `codexResetCreditsCooldownMs: 0`, a definite no-spend answer in the 429
  branch does not charge the pass, so the following fleet walk may POST
  consume once more on the same account (bounded at 2 no-spend POSTs per
  account per request, no credit spent, request still fails fast). The
  production config (fleet policy, 30-min cooldown) is not exposed.
- Cross-model review (OpenAI Codex via `codex-reviewer`, read-only, two
  batches): REQUEST_CHANGES — two implementation HIGHs and four test gaps,
  all addressed in round 7:
  1. The exhaustion-429 "safety backstop" (`retryCount >= maxRetries`,
     legacy "All accounts throttled" body) shares `retryCount` with
     non-throttling hops (5xx/auth/stale failovers), so under a 5xx burst it
     could fire on the very 429 that empties the pool and answer before the
     acquisition dead end ever ran the redemption. Fix: the cap yields ONE
     extra recursion while the request's redemption pass is unspent; the pass
     budget bounds it afterwards. Test: stale-429 retry meets a genuine
     post-reset 429 at the cap → Codex-native body, one credit.
  2. The redemption ledger (cooldown stamp, outcome, count) was only
     persisted by the 60 s periodic snapshot and the exit handler (which does
     not run on SIGKILL), so a crash right after the backend consumed a
     credit could let a restart redeem the same account again. Fix: a
     "pending" stamp is written and the host persists the quota snapshot
     BEFORE the consume POST (`hooks.onResetCreditLedger`), and again right
     after the outcome; a restored `pending` stamp is inside the cooldown.
  3. Tests: the three fences and the grace are now exercised with BOTH the 5h
     and the 7d meter at 100%; the operator route and an automatic dead end
     are shown to share one in-flight redemption; forwarded-for style
     headers are shown not to impersonate loopback. (Codex's "rank by most
     exhausted" expectation is not the contract — every candidate is already
     at/over the threshold; ranking is by credits, then latest reset.)

## Incident / motivation

2026-09-05 16:xx KST: five of the six enabled Pro accounts in the TeamCodex
pool sit at `used_percent: 100` on their weekly (10080-minute) window, resets
40–50 hours away; only `current-codex` still serves. Each of those accounts
holds **3 unredeemed "Full reset" credits** (free grants, 30-day expiry), i.e.
17 credits in the pool that nobody redeems because the proxy — not the Codex
CLI — owns the accounts. Since the fail-fast (2026-09-04) the client gets a
clean `usage_limit_reached` 429, but the session still stops.

## Verified upstream contract (openai/codex `main`, fetched 2026-09-05 via `gh api`)

Files: `codex-rs/backend-client/src/client/rate_limit_resets.rs`,
`…/rate_limit_resets_tests.rs`,
`codex-rs/app-server/src/request_processors/account_processor/rate_limit_resets.rs`,
`codex-rs/tui/src/chatwidget/reset_credits.rs`.

- `GET {chatgpt_base}/wham/usage` (ChatGPT path style; `/api/codex/usage` on
  the Codex API path style) carries
  `"rate_limit_reset_credits": {"available_count": N}` next to `rate_limit`,
  `additional_rate_limits`, `plan_type`, … Live 2026-09-05 payloads also carry
  `applicable_available_count` (undocumented; the CLI ignores it, and it read
  `0` on accounts whose next request was rejected with `usage_limit_reached`,
  so it is NOT used as a gate).
- `GET {chatgpt_base}/wham/rate-limit-reset-credits` →
  `{credits: [{id, reset_type: "codex_rate_limits", status:
  "available"|"redeeming"|"redeemed", granted_at, expires_at, title,
  description}], available_count, total_earned_count, …}`.
- `POST {chatgpt_base}/wham/rate-limit-reset-credits/consume` with JSON
  `{"redeem_request_id": "<idempotency key>", "credit_id"?: "<id>"}` →
  `{"code": "reset"|"nothing_to_reset"|"no_credit"|"already_redeemed",
  "credit": {...}, "windows_reset": <int>}`. The CLI sends a fresh
  idempotency key per redemption and omits `credit_id` for "Full reset".
- The CLI only ever redeems on explicit user confirmation (`/usage` → "Full
  reset" picker); there is no auto-redeem upstream. This proxy feature is the
  operator-side equivalent of that confirmation, applied by policy.
- Live probe 2026-09-05 (account at 100% weekly): `POST /codex/responses` →
  `429 {"error":{"type":"usage_limit_reached","message":"The usage limit has
  been reached","plan_type":"pro","resets_at":…,"resets_in_seconds":…}}` with
  `x-codex-primary-used-percent: 100` and no
  `x-codex-rate-limit-reached-type` header. `isExhausted()` already classifies
  this via the folded utilization (`switchThreshold` 1.0 in production).

## Goal

1. **Track credits.** `updateCodexUsage` folds
   `rate_limit_reset_credits.available_count` into
   `quota.codexResetCredits` (integer ≥ 0, `null` when absent/invalid) with a
   freshness stamp `quota.codexResetCreditsAt`. Surfaced through
   `getStatus()` (quota spread) and `teamcodex status`.
2. **Redeem automatically, by policy** (`codexResetCredits: true`):
   - `codexResetCreditsPolicy: "fleet"` (default): only when the request has
     **no usable and no capped account** (the quota dead end that today
     fails fast) — redeem on the best exhausted candidate, then re-acquire.
     Credits are the scarce resource; while another account can serve,
     rotation wins.
   - `codexResetCreditsPolicy: "account"`: additionally, on an upstream 429
     classified as account exhaustion, redeem on THAT account and retry the
     same request on it before throttling/switching.
3. **Never loop or burn credits blindly.** Guards applied by BOTH policies
   (`codexResetCreditEligibility`): single-flight per account,
   `codexResetCreditsCooldownMs` (default 30 min) after ANY attempt,
   `codexResetCreditsReserve` (keep N credits per account), the credit count
   must be known (a never-polled account is never redeemed), only accounts
   the proxy considers exhausted (throttled with a future `rateLimitedUntil`,
   or `isExhausted()`), and never an account quarantined for the requested
   model (`canServe`). **One fleet pass per request**: if the reset account
   still 429s afterwards the request fails fast instead of walking the pool.
   The pass is charged by any walk that actually reached the backend (reset,
   spent-no-reset, indeterminate, or a definite no-spend answer) and by an
   account-policy attempt with a spend-capable outcome; a walk that found no
   eligible candidate leaves it unspent so a later 429-branch redemption can
   still be the request's first spend.
   The fleet walk stops after any outcome that may have spent a credit
   (`reset` with `windows_reset: 0`, or an indeterminate timeout/network/5xx
   answer); it only moves on after a definite no-spend answer
   (`nothing_to_reset`, `no_credit`, `already_redeemed`, 4xx). The account
   policy retries an account at most once per request, and that retry does
   not count toward `maxRetries`, so a second 429 still ends in the
   Codex-native body.
4. **Apply the outcome locally at once.** `code === "reset"` (with
   `windows_reset` absent or > 0) clears the account's unified 5h/7d
   utilization to 0, lifts a throttle, decrements the cached credit count,
   stamps `codexResetCreditResetAt`, and schedules an authoritative
   `wham/usage` refresh (1.5 s later — after EVERY attempt, so an
   indeterminate answer is reconciled too). `reset` with `windows_reset: 0`
   decrements the count and stamps the cooldown but leaves meters/throttle
   alone (`reset_no_windows`). `no_credit` zeroes the cached count;
   `nothing_to_reset` / `already_redeemed` / HTTP / network failures only
   stamp the cooldown. Two consistency fences protect a fresh reset: a
   response to a request dispatched BEFORE `codexResetCreditResetAt` neither
   folds its `x-codex-*` meter nor throttles on 429 (the request is retried),
   and for `CODEX_RESET_CREDIT_GRACE_MS` (2 min) an authoritative payload may
   not RAISE the meter — a reset that genuinely failed still throttles the
   account through a real post-reset 429. Third fence (round 5): inside the
   same grace an ACCEPTED (non-429) response's `x-codex-*` meter is not
   folded either (the request is still counted), because the header path may
   RAISE and the authoritative poll could then no longer lower it; a 429 is
   always folded — the rejection is the evidence that the reset did not take.
5. **Operator trigger.** `POST /teamclaude/codex/reset-credit?account=<name>`
   (local-only, proxy API key when configured, body-free — mirrors
   `/teamclaude/rotate`) redeems on demand regardless of the automatic
   policy/eligibility (explicit operator intent), still single-flight. The
   loopback fence lives in the supervisor (`src/index.js`) as well as the
   worker, because the worker only ever sees the supervisor's loopback
   connection.
6. **Observability.** `GET /teamclaude/status` carries `resetCredits:
   {enabled, policy, cooldownMs, reserve}`; `teamcodex status` prints a
   `Reset credits:` line per account (or `unknown` while enabled but not yet
   polled); a dead end with no eligible candidate logs one throttled
   `[TeamCodex] Reset credit: no eligible account (<name>:<reason>, …)` line.

## Non-goals

- The Anthropic provider is untouched (`codexResetCredits` is ignored unless
  `provider: "codex"`).
- No `credit_id` selection: "Full reset" is the only reset type today and the
  backend picks the credit. No purchase of paid resets
  (`immediate_reset_purchase_eligible` is never acted on).
- No TUI column (status JSON + `teamcodex status` line only).
- No change to the fail-fast/usage_limit_reached body when redemption is off,
  not eligible, or fails — that path stays byte-identical.
- Quota-snapshot persistence of the new fields rides on the existing
  `exportQuotaState` (whole `quota` object); no new file.

## Acceptance

- `updateCodexUsage` with `{rate_limit_reset_credits:{available_count:3}}` →
  `quota.codexResetCredits === 3`; absent → `null`; non-integer → `null`.
- Fleet policy, 2 codex accounts both weekly-exhausted (reset 60 h out), one
  with `codexResetCredits: 3`: `POST /codex/responses` → the proxy POSTs
  `/wham/rate-limit-reset-credits/consume` exactly once on that account with
  `Bearer <its token>` + `chatgpt-account-id`, JSON `{redeem_request_id:
  <uuid>}` (no `credit_id`), then serves the request → `200`, in < 3 s;
  `quota.codexResetCredits === 2`, `unified7d === 0`, a
  `[TeamCodex] Reset credit redeemed` log line.
- Account policy with `reserve: 1` + 1 credit, or inside the cooldown, or
  with an unknown count → zero consume calls, fail-fast body.
- Upstream keeps answering 429 after a `reset` → exactly one consume per
  request (both policies), final body `usage_limit_reached`, never the legacy
  "All accounts throttled" text.
- `reset` with `windows_reset: 0`, or a consume timeout → exactly one consume
  call (the second candidate is not tried), count/cooldown recorded, fail-fast.
- One of two exhausted accounts quarantined for the model → the consume lands
  on the other; a fully quarantined fleet redeems nothing.
- Two requests in flight on the last healthy account: the 429 that was
  dispatched before the reset landed is retried, not throttled; one credit
  for the episode; the account stays at 0%.
- The backend still reports 100% on the refresh 1.5 s after the reset → the
  account stays routable and the next request spends no second credit.
- A restored quota snapshot inside the cooldown → zero consume calls; a
  legacy snapshot without the ledger fields → `credits-unknown`, never
  redeemed, one throttled no-candidate log line.
- Five concurrent requests at the dead end → five `200`s, one consume.
- `resetCredits` block present in codex status, absent in Anthropic status.
- `nothing_to_reset` → one consume call, then the existing fail-fast
  `usage_limit_reached` 429; a second request within the cooldown makes NO
  further consume call.
- `codexResetCredits: false` (default) → zero consume calls, fail-fast
  unchanged.
- Fleet policy with one usable account → zero consume calls; the usable
  account serves.
- Account policy: upstream 429 (`x-codex-primary-used-percent: 100`) on A
  with credits → consume on A → retry on A → `200`; upstream sees A, A.
- Consume endpoint 500 / network error → no reset, cooldown stamped, request
  falls through to the existing 429 path.
- `codexResetCreditsReserve: 1` with 1 credit → not eligible.
- Operator endpoint: local POST with key → 200 + outcome JSON; non-local →
  403 at the worker AND at the supervisor; wrong key → 401; unknown account →
  404; non-reset outcome → 409.
- Anthropic provider with `codexResetCredits: true` → never calls consume.

## Test

```bash
cd /Users/sangrok/.claude/worktrees/teamclaude-reset-credits-20260905
node --test --test-concurrency=1 \
  test/codex-reset-credits.test.js test/codex-reset-credits-outcomes.test.js \
  test/server-codex-reset-credits.test.js test/server-codex-reset-credits-guards.test.js \
  test/server-codex-usage-limit.test.js test/server-codex.test.js test/server-429.test.js \
  test/server-model-fallback.test.js test/account-manager.test.js test/config.test.js \
  test/concurrency.test.js test/codex-resume.test.js test/server-rotation.test.js \
  test/server-codex-model-compatibility.test.js test/server-codex-auto-detect.test.js \
  test/server-midstream.test.js
node --test --test-name-pattern "fences the operator" test/server-supervisor.test.js
npx eslint src/ test/codex-reset-credits*.test.js test/server-codex-reset-credits*.test.js
```

Round 2 evidence (2026-09-05): the 16-file set above = 331 pass / 0 fail;
supervisor fence 1/1; eslint clean. Three pre-existing supervisor tests
(`teamclaude run starts a missing proxy`, `CLI remove reloads…`, `live
account removal lowers…`) fail identically on the untouched production
lineage in this environment and are unrelated.

## Deployment note

Production runs a frozen artifact approved by hash (`teamcodex_runtime_deployer.py`).
`SOURCE_ROOT` (`~/projects/teamclaude`) holds another lineage with uncommitted
work, so this change ships via the runbook's **Path B** (manual staging from
`git archive` of the reviewed commit, using the deployer's own
materialize/validate functions), then the plist is repointed, the service
cycled, verified, and the approved-hash file updated. Live config
`~/.config/teamcodex.json` gains `codexResetCredits: true` (fleet policy).

**Deployed 2026-09-05 19:55 KST** — live artifact
`6b538222f002b0f43efa799566085b20b09ae4424a5a012994ceab69de9a7425` (source
commit `0865c6c`), rolled out with `scripts/teamcodex-manual-rollout.py`
(idle wait → drain → bootout/bootstrap → verify → approve); rollback target
`adea84fd…` kept as last-good. Live evidence: `GET /teamclaude/status` reports
`x-teamcodex-source-hash: 6b538222…`, `resetCredits: {enabled: true, policy:
"fleet", cooldownMs: 1800000, reserve: 0}` and a `codexResetCredits` count per
account from the startup poll; an operator redemption on one weekly-exhausted
account answered `{"reset":true,"outcome":"reset","resetCredits":2}` with
`windows_reset=1`, the backend's own `wham/usage` then showed `used_percent: 0`
and `available_count: 2`, the account rejoined rotation (usable 1 → 2 of 8),
and a real `POST /codex/responses` through the proxy completed with `200`.
