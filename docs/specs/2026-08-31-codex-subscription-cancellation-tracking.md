# Codex subscription cancellation tracking

## Approval and scope

- Classification: L. Authentication and account-eligibility state changes are security-sensitive.
- Approval: the user explicitly requested implementation, adversarial review, README update, and GitHub merge on 2026-08-31.
- Baseline: merged PR #9 at `8b998e5993058b01aa12d1c05f174b2e814ca336` in an isolated worktree.

## Goal

Track user-declared Codex subscription cancellations without removing accounts that remain usable, and distinguish these operator-visible states:

1. cancellation scheduled, account still usable;
2. cancellation effective date reached, account still usable or not yet rechecked;
3. subscription ended after a terminal auth failure consistent with the declared cancellation;
4. ordinary authentication/refresh error unrelated to the declared effective date;
5. Anthropic organization policy denial (`oauth_not_allowed_for_organization`).

The initial operator metadata applies to `sesileo98`, `testacountqjc`, and `test981110`; `test981110` remains usable through 2026-09-06 KST, so its effective instant is 2026-09-07 00:00 KST.

## Evidence and decision

- OpenAI exposes the current `chatgpt_plan_type` in OAuth claims and `plan_type` in the internal WHAM usage response, but there is no public cancellation-scheduled or active-until contract.
- Two declared-cancelled accounts returned live WHAM HTTP 200 with `plan_type=pro`. Therefore current plan type cannot discover a scheduled cancellation.
- A 401 or token-refresh failure alone is ambiguous. It may mean expiry, token revocation, account mismatch, entitlement loss, or a transient upstream failure.
- A declared cancellation provides the missing context. Only a terminal authentication failure, currently HTTP 401 or HTTP 400 `invalid_grant` from Codex token refresh, can be classified as `subscription-ended`; network errors, timeouts, 5xx, and malformed success responses preserve the existing state. The terminal failure is classified as ended only when the declared end has passed or no end date was supplied. Before a known future end it stays an ordinary auth/refresh error. Once inferred as ended, a later authentication label in the same upstream-401/terminal-refresh flow cannot overwrite `subscription-ended`.
- A later valid WHAM usage response or successful inference is stronger evidence than the inference and reopens the account while retaining the cancellation declaration. A non-streaming inference proves success only with a parsed Responses object whose `id` is non-empty, `object` is `response`, and `status` is `completed`; empty, malformed, failed, or incomplete HTTP 2xx bodies are not recovery evidence. A streaming inference proves success only with `response.completed`; failure/incomplete/error terminals and `[DONE]` alone are not recovery evidence.
- The existing exact Anthropic 403 remains a separate organization-policy state and is never relabeled as payment cancellation.

## Data contract

Config accounts may contain credential-free metadata:

```json
{
  "subscriptionCancellation": {
    "status": "scheduled",
    "recordedAt": "2026-08-31T00:00:00.000Z",
    "endsAt": "2026-09-06T15:00:00.000Z"
  }
}
```

When runtime evidence completes the transition, `status` becomes `ended` and the record adds `endedAt` plus `evidence: "auth-failure-after-cancellation"`. No tokens, auth headers, or upstream response bodies enter this object.

The credential-free status API returns:

```json
{
  "subscription": {
    "state": "active | cancellation-scheduled | end-date-reached | ended",
    "endsAt": "ISO timestamp or null",
    "recordedAt": "ISO timestamp or null",
    "endedAt": "ISO timestamp or null",
    "evidence": "safe enum or null"
  }
}
```

## Behavior and acceptance criteria

1. `teamcodex codex subscription cancel <account> [--ends-on YYYY-MM-DD] [--account-uuid UUID]` records a cancellation without disabling the account; both `--flag value` and `--flag=value` forms preserve the same fail-closed identity/date semantics.
2. `--ends-on` means usable through that local calendar date; the stored UTC instant is next-day local midnight.
3. `teamcodex codex subscription clear <account> [--account-uuid UUID]` removes the declaration and reopens an account parked only as `subscription-ended`.
4. Account matching uses the full configured name, full email, or exact email localpart. Prefix matching is forbidden, so `sesileo98` cannot select `sesileo981110`; `--account-uuid` optionally pins that selected identity.
5. Before a known future end, terminal 401/refresh failure uses `auth-revoked`/`refresh-failed` and does not claim subscription end, even when the access token is expiring but still valid. A token-refresh network error, timeout, 5xx, or malformed success is non-terminal and does not change the account or subscription state.
6. After the effective instant, or for a declared cancellation with unknown end, a terminal auth failure persists `subscription-ended` and excludes the account from rotation. A pre-end auth error is reclassified only after the boundary passes and a fresh terminal failure is observed.
7. A valid Codex usage response or successful inference after that inference changes the cancellation record back to `scheduled`, clears the runtime error, and persists recovery. Non-streaming inference requires a parsed Responses object with a non-empty `id`, `object: "response"`, and `status: "completed"`; empty, malformed, failed, incomplete, or completed-looking bodies without an id preserve the ended state. Streaming inference requires `response.completed`; `response.failed`, `response.incomplete`, `error`, and `[DONE]` alone preserve the ended state.
8. WHAM network/non-2xx/parse failure alone never marks a subscription ended.
9. CLI status, accounts output, TUI, and `/teamclaude/status` distinguish cancellation scheduled/end-date reached/ended from authentication and organization-policy errors.
10. Token refresh/import/reauth and disk-to-memory sync preserve the metadata unless the operator runs `subscription clear`.
11. Status/config output never adds credentials or raw vendor error bodies.
12. Existing routing, reauthentication, quota, and organization-policy behavior remains green with zero runtime dependencies.

## Out of scope

- Scraping ChatGPT billing pages or browser sessions.
- Treating `plan_type=free`, a missing plan claim, 429, generic 403, or network failure as conclusive subscription termination.
- Automatically cancelling or changing a vendor subscription.
- Editing the separate native menu-bar app repository; this repository owns the shared CLI/TUI/status contract it consumes.

## Alternatives and risks

- Billing-page scraping was rejected because it would require a separate browser session and an unsupported private contract.
- `plan_type` downgrade was rejected because it is a display hint, not proof that entitlement ended.
- Classifying every post-cancellation 401 as ended was rejected because a known future end date must still distinguish token revocation from subscription expiry.
- Risk: an unknown-date declaration treats the first terminal auth failure as ended. Recovery is reversible through a completed Codex response or the explicit clear command.
- Risk: an external writer can remove the metadata. Atomic config updates and live reload preserve unrelated credentials and preference fields, but the config file remains the operator SSOT.
- Risk: a vendor contract change may create a stronger signal. The evidence enum is deliberately narrow so new evidence requires an explicit reviewed code change.

## Execution plan

1. Add failing tests for metadata validation, exact selector behavior, date semantics, dynamic states, auth-before/after-end classification, persistence, and recovery.
2. Implement a small pure subscription module plus AccountManager state/persistence hooks.
3. Wire server success/failure observations, config reload, CLI commands, status output, and TUI display.
4. Document commands and state semantics in both READMEs and the example Codex config.
5. Apply metadata to the three live accounts through an atomic config update and reload the running server.
6. Run targeted tests, full tests, lint, manual CLI/API/TUI QA, then five independent review lanes and a runtime debugging audit.
7. Commit, push, create a PR, and merge only after all blocking gates pass.

## Rollout and rollback

- Rollout: merge code first, install/restart the local TeamCodex runtime, execute the cancellation commands, then verify credential-free status rows.
- Backward compatibility: older binaries ignore the added account metadata. New binaries treat missing metadata as `active`.
- Migration: no bulk migration is required. Only explicitly declared Codex OAuth accounts receive the optional metadata; existing Anthropic, API-key, and undeclared Codex rows are unchanged.
- Rollback code: revert the feature commit. The added config keys remain inert on older code.
- Rollback data: run `teamcodex codex subscription clear <account>` before downgrade, or remove only `subscriptionCancellation` through an atomic config update. Credentials and routing preferences are untouched.
- Failure containment: ambiguous vendor failures remain ordinary auth/usage errors and never automatically become a billing claim without the operator declaration.

## Verification

- RED: new targeted tests fail against the baseline for absent command/module/status state.
- Targeted: 117 subscription module, AccountManager, Codex refresh, server auth/SSE, status CLI, and TUI tests passed, including nested refresh boundary cases, post-boundary reclassification, expiring-token terminal refresh, combined upstream-401/terminal-refresh preservation, streaming success-terminal separation, non-streaming completed-object validation, stale-reset exclusion, equals-form CLI flags, and transient refresh-failure regressions.
- Regression: isolated `npm test` passed 648/648; `npx --yes --package eslint -c 'npm run lint'`, changed-source `node --check`, JSON parse, and `git diff --check` passed.
- Manual: throwaway config exercised cancel, future date, clear, status API, and exact-localpart collision; Chrome rendered the real PTY capture through xterm.js and visually confirmed `canceling`, `sub due`, and `sub ended`.
- Adversarial: goal, hands-on QA, code quality, security, and context-mining lanes plus debugging runtime audit, all bound to the final commit SHA.
