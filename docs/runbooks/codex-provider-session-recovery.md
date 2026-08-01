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

On 2026-08-01, the same route split appeared as:

```text
exceeded retry limit, last status: 429 Too Many Requests
```

The proxy and account pool completed a real request successfully. The affected
TUI had been launched by a shell alias that resolved `codex` directly to the
official binary, so that process never reached TeamCodex.

## Root cause

Codex resolves `model_provider` during process startup and keeps it in the TUI
process. Shell startup files affect commands launched afterward; sourcing
`.zshrc` cannot rewrite configuration already loaded by a child process.

The ordinary `codex resume --all` view was also an incomplete recovery index.
During the incident it exposed only a bounded recent set, so older active
conversations were absent. A title or working directory was not unique enough
to choose safely across many cmux tabs.

A nested `codex exec` also inherited the parent Codex process's cmux surface
once and replaced the tab binding with its disposable checkpoint. TeamCodex
now disables cmux hooks only for a child launched from an existing Codex
process (`CMUX_CODEX_PID` is present). Top-level launches remain hook-enabled.

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
- If every interactive `codex` command on the machine must use the pool, make
  that intent explicit in the shell startup file:

  ```zsh
  alias codex='teamcodex codex run --'
  ```

  Remove any later alias that points `codex` back to an official binary path.
  Reloading the shell affects only future processes; exact-resume every TUI
  that was already running.
- In cmux, keep Codex hooks installed. The SessionStart hook records the exact
  checkpoint and the provider arguments used to launch the process.
- Restore a tab through its recorded binding or `teamcodex codex resume`; do
  not treat the recent-session selector as the source of truth.
- TeamCodex appends its provider configuration after forwarded resume options,
  so an ad-hoc `-c model_provider=...` cannot silently replace the proxy route.
- Resume rejects `--remote`, `--remote-auth-token-env`, `--oss`, and
  `--local-provider`, plus direct configuration of `model_provider`, the
  TeamCodex provider definition, and `chatgpt_base_url`, before launching cmux
  or Codex because those options can replace the TeamCodex route. The common
  guard also covers `teamcodex codex run -- resume ...`, quoted TOML keys, and
  dotted provider descendants. TOML escapes are decoded before route-root
  matching: escaped protected roots still fail closed, while unrelated valid
  escaped keys are forwarded to Codex.
- The checkpoint-only cmux lookup runs without direct Codex credential
  environment variables.
- A TeamCodex child launched from inside an existing Codex process receives
  `CMUX_CODEX_HOOKS_DISABLED=1`, so probes and subcommands cannot replace the
  parent tab's checkpoint binding.
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

Check shell resolution separately:

```bash
zsh -ic 'alias codex; whence -a teamcodex'
```

The alias should expand to `teamcodex codex run --`; a direct binary path is a
proxy bypass. Also inspect `cmux surface resume get --json` after any nested
probe. Its `checkpoint_id` and `cwd` must still belong to the parent tab.

## Failure behavior

`teamcodex codex resume` does not:

- open `resume --all`;
- choose the newest session;
- infer a session from `cwd`;
- terminate or replace another surface;
- replay a failed request.

It exits non-zero without launching Codex when the binding is missing,
malformed, or belongs to another provider, or when a route-changing option is
present.

## Rollback

The change is additive. Existing behavior remains available:

```bash
teamcodex codex run
teamcodex codex run -- resume SESSION_ID
```

If the convenience command must be rolled back, remove the `resume` dispatcher
and `src/codex-session.js`; no config, account, token, database, or cmux state
migration is required.
