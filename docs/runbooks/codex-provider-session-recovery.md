# Codex provider and exact-session recovery runbook

## Summary

An existing Codex TUI does not adopt a new provider when shell configuration
changes. Exit the affected TUI and run `teamcodex codex resume` in the same
cmux terminal. The command reads that surface's exact Codex checkpoint and
launches it through TeamCodex without opening the recent-session selector.

## Incident

On 2026-07-31, some terminals returned:

```text
You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage ...
```

Other terminals continued normally, including after `source ~/.zshrc`. Process
inspection showed two populations:

- older Codex processes with the default `openai` provider;
- newer processes launched with `model_provider="teamcodex_proxy"`.

Forcing the default provider reproduced the usage-limit failure. Launching the
same request through `teamcodex_proxy` succeeded.

## Root cause

Codex resolves `model_provider` during process startup and keeps it in the TUI
process. Shell startup files affect commands launched afterward; sourcing
`.zshrc` cannot rewrite configuration already loaded by a child process.

The ordinary `codex resume --all` view was also an incomplete recovery index.
During the incident it exposed only a bounded recent set, so older active
conversations were absent. A title or working directory was not unique enough
to choose safely across many cmux tabs.

## Exact recovery

In the affected cmux terminal:

1. Exit the old Codex TUI.
2. Confirm the tab has a Codex binding:

   ```bash
   cmux surface resume get --json
   ```

3. Resume through TeamCodex:

   ```bash
   teamcodex codex resume
   ```

The command accepts only a `kind: "codex"` binding with a UUID
`checkpoint_id`. It invokes the equivalent of:

```bash
teamcodex codex run -- resume SESSION_ID
```

If a trusted binding is unavailable, provide the exact ID:

```bash
teamcodex codex resume SESSION_ID
```

Do not select a merely similar title from `resume --all`. Direct ID resume is
not subject to the recent-list limit.

## Legacy tab with no binding

The automatic command deliberately fails closed. For a pre-hook legacy tab,
an operator can perform a one-time forensic match using all of:

1. the tab's original scrollback and working directory;
2. current and previous cmux session JSON `resumeBinding.checkpointId` values;
3. Codex `history.jsonl`, rollout metadata, and `state_*.sqlite` timestamps.

Resume only when those sources identify one session unambiguously. If they do
not, preserve the terminal and escalate rather than guessing. Private cmux and
Codex schemas are version-specific and are not parsed by TeamCodex's normal
recovery command.

## Prevention

- Start Codex with `teamcodex codex run`, not plain `codex`, when account
  pooling is required.
- In cmux, keep Codex hooks installed. The SessionStart hook records the exact
  checkpoint and the provider arguments used to launch the process.
- Restore a tab through its recorded binding or `teamcodex codex resume`; do
  not treat the recent-session selector as the source of truth.
- TeamCodex appends its provider configuration after forwarded resume options,
  so an ad-hoc `-c model_provider=...` cannot silently replace the proxy route.
- TeamCodex rejects `--remote`, `--remote-auth-token-env`, `--oss`, and
  `--local-provider` on exact resume because those options bypass provider
  configuration instead of overriding it.
- The checkpoint-only cmux lookup runs without direct Codex credential
  environment variables.
- When provider configuration changes, restart or exact-resume existing TUI
  processes. Shell reload is not a migration mechanism.

## Diagnosis

Check the proxy:

```bash
teamcodex codex status
```

Inspect a suspect process. A TeamCodex-backed process includes:

```text
model_provider="teamcodex_proxy"
```

Absence of that argument on an older live process explains why it can hit the
direct account's limit while newer terminals work.

## Failure behavior

`teamcodex codex resume` does not:

- open `resume --all`;
- choose the newest session;
- infer a session from `cwd`;
- terminate or replace another surface;
- replay a failed request.

It exits non-zero without launching Codex when the binding is missing,
malformed, or belongs to another provider.

## Rollback

The change is additive. Existing behavior remains available:

```bash
teamcodex codex run
teamcodex codex run -- resume SESSION_ID
```

If the convenience command must be rolled back, remove the `resume` dispatcher
and `src/codex-session.js`; no config, account, token, database, or cmux state
migration is required.
