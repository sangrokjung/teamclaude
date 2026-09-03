# Codex subscription cancellation tracking plan

## Decision record

- Use operator-declared `subscriptionCancellation` metadata because Codex does not expose a supported cancellation-scheduled contract.
- Treat plan claims, WHAM failure, 429, and unrelated 403 as insufficient evidence.
- Infer `subscription-ended` only from a terminal authentication failure after a declared end date, or when the declaration has no known date. Codex refresh HTTP 401 and HTTP 400 `invalid_grant` are terminal; network errors, timeouts, 5xx, and malformed success responses are not.
- Require a valid Codex usage response or successful inference to recover a false ended inference. Non-streaming inference requires a parsed Responses object with a non-empty `id`, `object: "response"`, and `status: "completed"`; empty, malformed, failed, or incomplete HTTP 2xx bodies are not entitlement proof. Streaming inference requires `response.completed`; failure/incomplete/error terminals and `[DONE]` alone are not entitlement proof.
- Keep the existing Anthropic structured `subscription-disabled` classification separate.

## Tasks and dependencies

1. Add RED coverage for exact selector matching, local-date semantics, state validation, auth boundary classification, success recovery, and serialized persistence.
2. Implement the pure metadata model in `src/subscription.js`.
3. Wire AccountManager state transitions and atomic metadata persistence.
4. Wire 401, refresh-failure, completed usage/inference success, status API, CLI, and TUI surfaces.
5. Update both READMEs and `config.codex.example.json` with the public command and state contract.
6. Verify targeted tests, actual CLI/API/TUI surfaces, syntax, lint, and the full test suite.
7. Bind the debugging audit and five independent adversarial review lanes to the exact final commit SHA.
8. Apply the three operator declarations with exact selectors, then publish through a reviewed GitHub PR.

## Rollout

1. Keep existing 3456/3457 runtimes untouched during QA; use a throwaway config and port.
2. Merge the feature PR after all SHA-bound gates pass.
3. Run the subscription commands against the actual Codex config and reload/restart the Codex proxy with the merged build.
4. Confirm the credential-free status surface shows two unknown-date cancellations and one date-bound cancellation.

## Rollback

- Data: run `teamcodex codex subscription clear <account>` for each tracked account. This removes only cancellation metadata.
- Code: revert the feature commit. Older versions ignore the new config property.
- Safety: never remove or overwrite access tokens, refresh tokens, account UUIDs, priorities, or enablement flags during metadata rollback.

## Observability and runbook

- CLI/TUI labels: `canceling`, `sub due`, `sub ended`, plus the existing auth reason labels.
- API: `/teamclaude/status` exposes only the normalized credential-free `subscription` snapshot.
- If a scheduled account fails auth before its known end, use the reauthentication path; do not label it ended.
- If a due or unknown-date cancellation reaches `subscription-ended`, keep it excluded until a valid usage response, a completed non-stream Responses object, or streaming `response.completed` proves it usable, or the operator clears the declaration.
- If quota/WHAM/plan signals disagree, preserve the existing state and rely on terminal auth or completed success evidence.

## Verification contract

- Targeted commands: subscription unit/CLI tests, AccountManager auth/persistence tests, server 401/Codex tests, supervisor hot reload, status CLI, and TUI tests.
- Surface commands: real `teamcodex codex subscription` against throwaway config; real proxy plus `curl -i`; xterm.js-rendered TUI capture.
- Regression commands: `node --check` for changed JS, `npm run lint`, and `npm test` through the heavy-work qgate.
- Final result: targeted 117/117 and full 648/648, including expiring-token terminal refresh classification, combined upstream-401/terminal-refresh preservation, streaming success-terminal separation, non-streaming completed-object validation, stale-reset exclusion, equals-form CLI flags, and transient failures that preserve existing account/subscription state.
- Approval: debugging runtime audit plus goal, QA, code, security, and context review lanes must all return unconditional PASS for the same full commit SHA.
