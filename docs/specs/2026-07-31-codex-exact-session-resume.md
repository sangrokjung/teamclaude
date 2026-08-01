# Codex exact-session resume

Status: Implemented.

## Problem

Codex fixes `model_provider` when a TUI process starts. Changing the shell
configuration or running `source ~/.zshrc` cannot change a provider already
held by a live process. After moving from the default OpenAI provider to
TeamCodex, an older terminal can therefore keep returning the direct-account
usage-limit error.

The ordinary Codex resume selector is not a reliable recovery index. It shows
only a recent subset, and a user looking at several cmux tabs cannot safely
infer which conversation belongs to the current tab.

## Goal

Provide a deterministic command that resumes the exact Codex conversation
bound to the current cmux surface and always launches it through TeamCodex.

## Non-goals

- Mutating the provider of an already-running Codex process.
- Guessing a session from recency, working directory, scrollback, or the Codex
  SQLite schema when the current surface has no trusted checkpoint.
- Automatically replaying a failed Codex request or changing existing
  `teamcodex codex run` exit behavior.
- Managing or terminating Codex processes in other cmux surfaces.

## Requirements

1. `teamcodex codex resume SESSION_ID [args...]` resumes that exact session
   through the existing TeamCodex provider override.
2. `teamcodex codex resume [args...]` without an ID reads the current cmux
   surface resume binding and uses its Codex `checkpoint_id`.
3. A cmux binding is accepted only when `kind` is `codex` and the checkpoint is
   a valid UUID. Missing, malformed, or non-Codex bindings fail closed without
   launching Codex or opening the recent-session selector.
4. Explicit and cmux-derived session IDs use the same launch path as
   `teamcodex codex run`, including removal of direct API credential
   environment variables. The cmux checkpoint lookup also receives no direct
   Codex credential variables.
5. For `resume`, TeamCodex provider overrides follow the exact session selector
   and forwarded resume arguments, so user flags cannot replace the provider
   and cmux preserves the enforced route in its next restore binding. Options
   that replace the transport or provider route (`--remote`,
   `--remote-auth-token-env`, `--oss`, and `--local-provider`) fail closed
   before either cmux or Codex is launched. The same common launch guard covers
   the legacy `teamcodex codex run -- resume ...` form and rejects direct
   overrides of `model_provider`, the TeamCodex provider definition, and
   `chatgpt_base_url`, including quoted keys and dotted provider descendants.
6. Existing `teamcodex codex run` behavior remains a single launch with no
   implicit resume.
7. Public help, English/Korean setup docs, architecture notes, and an incident
   runbook explain that provider selection is process-scoped and that
   `source ~/.zshrc` cannot repair a live TUI.
8. When TeamCodex is launched from an existing Codex process, its child does
   not run cmux hooks against the inherited parent surface. A top-level launch
   remains hook-enabled and records its own checkpoint normally.

## Acceptance criteria

- [x] An explicit session ID reaches the Codex child as `resume SESSION_ID`.
- [x] With no explicit ID, a fake cmux binding outside the recent-session list
  resumes its exact checkpoint.
- [x] A missing or invalid binding exits non-zero and does not invoke Codex.
- [x] Provider overrides still include `model_provider="teamcodex_proxy"` and the
  configured proxy URL.
- [x] Resume bindings preserve the provider override after the session ID.
- [x] Forwarded resume configuration cannot override the final TeamCodex
  provider selection.
- [x] Transport/provider-routing options exit non-zero without invoking cmux or
  Codex through both the dedicated resume command and the legacy run alias.
- [x] Quoted, dotted, equals-form, and escaped route-configuration keys fail
  closed before config loading or child launch.
- [x] The cmux lookup subprocess does not inherit direct Codex credentials.
- [x] Existing Codex run tests, the full Node test suite, and ESLint pass.
- [x] A real temporary cmux terminal surface shows a TeamCodex-backed resume
  binding after launch.
- [x] A real nested TeamCodex probe leaves the parent surface checkpoint and
  restore command unchanged.

## Risks

- cmux is optional. The no-ID form must report how to provide `SESSION_ID`
  explicitly when cmux is unavailable.
- Codex may change its session identifier format. The current CLI and cmux
  checkpoints use UUIDs; rejecting unknown formats is safer than resuming the
  wrong conversation.
- The cmux hook owns binding creation. TeamCodex consumes that public binding
  contract and must not parse cmux's private session JSON for normal recovery.
- A nested child can inherit `CMUX_SURFACE_ID`; it must opt out through the
  public `CMUX_CODEX_HOOKS_DISABLED` contract instead of clearing unrelated
  cmux environment state.

## Alternatives

- Clearing every `CMUX_*` variable from a nested child would also prevent the
  overwrite, but it discards unrelated terminal integration state.
- Repairing bindings only after a probe is reactive and can lose the exact
  checkpoint when the parent ID is no longer known.
- Disabling Codex hooks globally prevents overwrite but also removes the
  trusted checkpoint needed for exact resume.

## Decision

Use cmux's public `CMUX_CODEX_HOOKS_DISABLED=1` switch only when the TeamCodex
launcher inherited `CMUX_CODEX_PID`. Keep top-level launches unchanged. Use the
package's declared `teamcodex` binary consistently in public Codex docs.

## Migration and rollout

No data or config migration is required. Merge the launcher and docs, install
the resulting `teamcodex` package, route future `codex` shell invocations
through `teamcodex codex run --`, then exact-resume each already-running plain
Codex TUI through its trusted cmux checkpoint.

## Rollback

Remove the conditional child environment assignment to restore the previous
launcher behavior. Existing sessions and account data remain valid; a cmux
binding overwritten during rollback must be repaired with a known exact
checkpoint rather than selected by recency.

## Observability and runbook

The TeamCodex proxy status and process arguments distinguish proxy-backed from
plain Codex requests. `cmux surface resume get --json` must show the same parent
checkpoint before and after a nested probe. Operational diagnosis and recovery
commands are maintained in
`docs/runbooks/codex-provider-session-recovery.md`.

## Verification

- Targeted unit/E2E tests in `test/codex-resume.test.js`.
- Regression test in `test/codex-run.test.js`.
- `npm test`.
- `npm run lint`.
- Manual CLI QA with fake `codex`/`cmux` binaries.
- Manual cmux surface QA using `cmux surface resume get --json`.
- Manual nested Codex QA comparing the parent binding before and after the
  child exits.
- Independent adversarial review against this spec, the diff, and execution
  evidence before merge.
