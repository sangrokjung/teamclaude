# TeamClaude account reauthentication

## Problem

An Anthropic OAuth account can remain in TeamClaude after its refresh grant is
revoked or its organization access is blocked. Rotation cannot repair that
credential, and replacing it through a broad import can target the wrong row
when account names changed or another process edited the config concurrently.

## Goal

Add a fail-closed `teamclaude reauth <name> [--account-uuid UUID]` flow that
replaces credentials only after the newly authenticated profile proves it is
the selected existing account.

## Non-goals

- Do not reauthenticate API-key or Codex-provider accounts.
- Do not enable a disabled account or bypass organization access policy.
- Do not expose credentials through status, logs, README examples, or review evidence.
- Do not change account selection, quota, or dependencies.
- The menu-bar button implementation remains in its separate app repository;
  this repository owns the UUID-pinned CLI contract it invokes.

## Requirements

1. Select exactly one existing account by UUID when supplied; otherwise select
   a unique name-only account.
2. Reject stale UUID/name pairs, ambiguous names, disabled accounts,
   subscription-disabled accounts, and non-Anthropic OAuth accounts before
   starting OAuth.
3. Require complete OAuth credentials and a verified profile. UUID-bearing
   accounts must match the returned UUID; legacy accounts without UUID may
   match the profile email case-insensitively.
4. Validate the same identity against freshly read disk config inside
   `atomicConfigUpdate`, preserving unrelated concurrent edits and routing fields.
5. Cancellation or any validation failure must leave config byte-identical.
6. After a successful write, request a live server reload and provide the
   existing restart fallback when live reload is unavailable.
7. Persist the narrowly classified subscription-disabled state so the CLI can
   reject the actual runtime-blocked account before OAuth and preserve that
   quarantine across reload/restart. Expose only the safe error reason in status.
8. A successful reauthentication removes `importFrom`; otherwise reload or
   restart would prefer the old credential file over the new embedded tokens.

## Acceptance criteria

- Targeted tests pass selection, mismatch, legacy, cancellation, atomic-write,
  routing-preservation, provider boundary, subscription-state persistence,
  stale credential source, and stale/missing UUID CLI cases.
- The stale-UUID CLI scenario exits 1 before OAuth and leaves the config bytes unchanged.
- `node src/index.js help` exposes `reauth <name>` and both READMEs document the
  UUID-pinned command, the app's `재인증 필요` action, and credential-safe status guidance.
- `git diff --check`, changed-file ESLint, and the full test suite/CI pass.
- Independent goal, QA, code-quality, security, and context review lanes find no blocker.

## Risks and security boundaries

- A name can be reused by another account. UUID pinning is therefore the
  authoritative identity when available, and name is an additional stale-row check.
- OAuth completes before the final disk write. The atomic updater repeats every
  identity and eligibility check so a concurrent edit cannot redirect credentials.
- Tokens stay inside the config writer and are never included in status or log output.
- `subscriptionDisabled: true` contains no credential or user data. It is written
  only from the exact structured organization-access 403 and cleared when fresh
  external credentials are installed.

## Rollout

1. Merge the CLI, tests, and README contract through a reviewed PR.
2. The menu-bar app invokes the command with both account name and UUID.
3. Operators can use `teamclaude status` after reauthentication to confirm recovery.

## Rollback

Revert the reauthentication commit. No config/schema migration is required;
existing accounts and credentials remain readable by the previous version.

## Verification

- RED: the baseline has no `src/reauth.js`, command dispatch, test, or README action.
- GREEN: targeted Node tests, CLI help, stale-UUID byte-preservation QA, ESLint,
  full qgate test run or GitHub CI, and exact-SHA independent review.
