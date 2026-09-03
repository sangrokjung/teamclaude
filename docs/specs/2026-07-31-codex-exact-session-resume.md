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
   and forwarded resume arguments, so configuration flags cannot replace the
   provider and cmux preserves the enforced route in its next restore binding.
   Alternate execution paths (`--remote`, `--remote-auth-token-env`, `--oss`,
   and `--local-provider`) are rejected instead of forwarded because they
   bypass `model_provider` selection entirely.
6. Existing `teamcodex codex run` behavior remains a single launch with no
   implicit resume.
7. Public help, English/Korean setup docs, architecture notes, and an incident
   runbook explain that provider selection is process-scoped and that
   `source ~/.zshrc` cannot repair a live TUI.

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
- [x] Resume rejects every Codex CLI option that activates a remote or local
  provider path outside TeamCodex.
- [x] The cmux lookup subprocess does not inherit direct Codex credentials.
- [x] Existing Codex run tests, the full Node test suite, and ESLint pass.
- [x] A real temporary cmux terminal surface shows a TeamCodex-backed resume
  binding after launch.

## Risks

- cmux is optional. The no-ID form must report how to provide `SESSION_ID`
  explicitly when cmux is unavailable.
- Codex may change its session identifier format. The current CLI and cmux
  checkpoints use UUIDs; rejecting unknown formats is safer than resuming the
  wrong conversation.
- The cmux hook owns binding creation. TeamCodex consumes that public binding
  contract and must not parse cmux's private session JSON for normal recovery.

## Verification

- Targeted unit/E2E tests in `test/codex-resume.test.js`.
- Regression test in `test/codex-run.test.js`.
- `npm test`.
- `npm run lint`.
- Manual CLI QA with fake `codex`/`cmux` binaries.
- Manual cmux surface QA using `cmux surface resume get --json`.
- Independent adversarial review against this spec, the diff, and execution
  evidence before merge.
