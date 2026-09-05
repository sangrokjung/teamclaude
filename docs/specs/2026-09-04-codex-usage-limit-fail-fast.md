# Codex usage-limit fail-fast (2026-09-04)

## Status (2026-09-05)

- Scope: M (contract change on the 429 path, 3 source files + 2 test files).
- Implemented on branch `fix/codex-usage-limit-fail-fast` (rebased onto
  `sangrokjung/teamclaude` master `da523e4`).
- Evidence: targeted `node --test` over `server-codex-usage-limit`,
  `server-codex`, `server-429`, `server-model-fallback`, `concurrency`,
  `codex-resume` = 132 pass / 0 fail; `npx eslint src/` clean. The full suite
  was deliberately not run (host under load); the untouched suites do not
  exercise the changed paths.
- Independent adversarial review (maker ≠ checker, two fresh-context lanes:
  Codex-CLI contract, regression safety): APPROVE / APPROVE. Minor notes, not
  blocking: the extra `ctx.continuity.enabled` guard on the codex body is
  redundant with the loop's earlier break; `codexPoolPlanType` correlates the
  soonest account by `name` (cosmetic field only); a pre-existing
  `planType` assignment in `src/index.js` lacks the string guard.
- Deployment: the production daemon runs a frozen runtime artifact approved by
  hash from the main checkout's working tree (`teamcodex_runtime_deployer.py`),
  so landing this on master does NOT deploy it by itself.
- Deployed 2026-09-05 16:05 KST on the production lineage (git `182cd3b`, the
  exact source of the live artifact `85a38c…`) as branch
  `prod/codex-usage-limit-fail-fast-20260905`: cherry-pick of PR #16 plus
  `soonestKnown` (this lineage redacts account names from `getStatus()`, which
  had silently disabled the fail-fast) and a quarantine-aware gate. Live
  artifact `adea84fdb8e172074b011bd9e0aeaa3932c2442998e855514396993546db185b`
  (`x-teamcodex-source-hash`). Rolled out with the deployer's own
  materialize/drain/plist/bootstrap/verify functions; the stock
  `replace_launchd_job` bootstraps immediately after `bootout` and failed
  (launchd teardown race, the "bootout-orphaned" class the server guard
  revives), so the manual rollout waits for the teardown and retries. Evidence
  on this lineage: 16 test files sequential = 342 pass / 0 fail, new file 6/6,
  eslint clean, independent adversarial review APPROVE. Post-deploy: a real
  `codex exec` turn from studio2 through the tunnel completed (exit 0).

## Incident

Every enabled ChatGPT account in the TeamCodex pool (port 3457) hit 100% of its
weekly (10080-minute) window; the resets were ~60 hours away. `forwardRequest`
entered the "No eligible capacity — waiting 30000ms" loop and polled until the
continuity deadline (`continuityMaxWaitMs`, default 15 min), then answered a
generic `429 {"type":"error","error":{"type":"rate_limit_error","message":"All N
accounts exhausted. Retry in Xs."}}`. The Codex CLI (0.148 / 0.153) cannot read
that body: users saw only "exceeded retry limit, last status: 429 Too Many
Requests" after a 15-minute hang.

## Goal

1. **Fail fast when waiting cannot help.** In deadline mode
   (`continuityMaxWaitMs > 0`), when the fleet is blocked by a *known* quota
   reset or throttle (not merely at its concurrency cap, and not the 60s
   "quota-healthy" fallback) and that recovery lies beyond the remaining
   continuity budget, break out of the capacity loop immediately instead of
   sleeping. The request then finalizes exactly as the deadline would have
   (`ctx.failedFast` → a saved upstream 429 is still replayed first).
2. **Codex-native body.** In the final `!account` 429 path, when the provider is
   `codex`, continuity deadline mode is on, and the fleet is quota-exhausted
   (`!anyUsable && !anyCapped`), answer with the shape the Codex CLI renders
   natively:

   ```json
   {"error":{"type":"usage_limit_reached","message":"TeamCodex pool exhausted: all 2 accounts have hit their usage limit. Resets at 2026-09-06T21:15:00.000Z (in 216000s).","plan_type":"pro","resets_at":1788729300}}
   ```

   `resets_at = floor(now/1000) + retryAfter` (unix **seconds**, integer).
   `plan_type` is the soonest-recovering account's `planType`, else the most
   common plan across the eligible pool, and is **omitted** when unknown or not
   one of the spellings the CLI recognizes. The `retry-after` header is kept.

## Non-goals

- The Anthropic provider, the concurrency-capped case, and the all-auth-failed
  401 path keep their existing bodies byte for byte.
- Legacy mode (`continuityMaxWaitMs: 0`) and non-continuity mode are unchanged:
  the `TEAMCLAUDE_OVERLOAD_RETRIES`-bounded polling and the generic body stay.
  The native body is deliberately paired with the deadline-mode fail-fast path
  (the production configuration); widening it is a separate decision.
- No change to account selection, quota accounting, or the saved-429 replay
  precedence at deadline finalization.
- `planType` is now carried on the live `AccountManager` account (constructor,
  `addAccount`, `updateAccountTokens`, disk sync) but is **not** added to
  `getStatus()`, no dashboard/CLI/TUI consumer wiring is required.

## Acceptance

- Codex pool, every account `unified7d = 1` with reset ~60h out, default
  `continuityMaxWaitMs` → `POST /codex/responses` answers 429 in < 3s with
  `error.type === "usage_limit_reached"`, `resets_at` within ±10s of the reset,
  `plan_type: "pro"` when the accounts carry `planType: "pro"`, and no polling
  sleep logged.
- `plan_type` is absent when no pooled account has a known plan.
- A reset *inside* the budget (e.g. 150ms with `continuityMaxWaitMs: 5000`) still
  waits and the request succeeds after the window rolls over.
- Anthropic provider with the same exhaustion → unchanged `rate_limit_error`
  body (also fails fast; fail-fast is provider-agnostic, the body is not).
- Codex pool merely capped (slot busy, quota fine) → generic `rate_limit_error`,
  never `usage_limit_reached`.
- Legacy mode (`continuityMaxWaitMs: 0`) → exactly 6 bounded waits (default
  `TEAMCLAUDE_OVERLOAD_RETRIES`) and the generic body.
- Existing regression pins in `test/server-429.test.js` and
  `test/server-model-fallback.test.js` still hold: a sub-second reset within the
  budget waits (millisecond comparison, not whole seconds); bare-429 exclusions
  (60s fallback, no known reset) never fail fast; a saved upstream 429 is still
  replayed at finalization. One pin that asserted the *old* full-deadline sleep
  (`elapsed >= 40`) was relaxed to the upper bound only.

## Test

```bash
cd /private/tmp/teamclaude-codex-usage-limit
node --test test/server-codex-usage-limit.test.js test/server-codex.test.js \
  test/server-429.test.js test/server-model-fallback.test.js test/concurrency.test.js
npx eslint src/ test/server-codex-usage-limit.test.js
```

New cases live in `test/server-codex-usage-limit.test.js` (real `http` upstream on
`127.0.0.1:0`, `AccountManager`, `createProxyServer({ provider: 'codex',
continuityMode: true })`).

## Verified upstream contract (openai/codex, fetched 2026-09-04 via `gh api`)

- `codex-rs/codex-api/src/api_bridge.rs`: on `429 Too Many Requests` the body is
  deserialized as

  ```rust
  struct UsageErrorResponse { error: UsageErrorBody }
  struct UsageErrorBody {
      #[serde(rename = "type")] error_type: Option<String>,
      plan_type: Option<PlanType>,
      resets_at: Option<i64>,
  }
  ```

  and only `error.type == "usage_limit_reached"` maps to
  `CodexErr::UsageLimitReached`; `resets_at` is converted with
  `DateTime::<Utc>::from_timestamp(seconds, 0)` → **unix seconds**. Any other
  429 body falls through to `CodexErr::RetryLimit` ("exceeded retry limit").
  `promo_message`, `rate_limit_reached_type`, and `rate_limits` are read from
  response *headers*, not the body, so the proxy does not need to emit them.
- `codex-rs/protocol/src/error.rs`: `UsageLimitReachedError { plan_type,
  resets_at, rate_limits, promo_message, rate_limit_reached_type }`; its
  `Display` prints "You've hit your usage limit … Try again at <local time>."
  with plan-specific wording for `plus`, `pro`/`prolite`, `free`/`go`, team and
  business plans, and a neutral line for unknown/absent plans.
- `codex-rs/protocol/src/auth.rs`: `PlanType` is `#[serde(untagged)]`
  `Known(KnownPlan) | Unknown(String)`; `KnownPlan` is `rename_all = "lowercase"`
  with explicit renames. Accepted spellings: `free`, `go`, `plus`, `pro`,
  `prolite`, `team`, `self_serve_business_prolite`,
  `self_serve_business_usage_based`, `business`, `ent26`,
  `enterprise_cbp_automation`, `enterprise_cbp_usage_based`, `enterprise` (alias
  `hc`), `edu` (alias `education`), `edu_plus`, `edu_pro`. These match the
  `chatgpt_plan_type` JWT claim that `src/codex.js` stores as `planType`.
- `codex-rs/core/tests/suite/client.rs` fixture:
  `{"error":{"type":"usage_limit_reached","message":"limit reached","resets_at":1704067242,"plan_type":"pro"}}`.
- Local binary check (`@openai/codex-darwin-arm64` vendored `codex`, `strings`):
  contains `struct UsageErrorBody with 3 elements`, `typeplan_typeresets_at`,
  `usage_limit_reached`, and the same lowercase plan spellings, the installed
  CLI parses the shape above.
