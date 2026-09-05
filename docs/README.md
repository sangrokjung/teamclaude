# Documentation index

Everything under `docs/` is written for whoever operates this proxy next. Start
with the runbook that matches your symptom; read the spec only when you need to
know why the code behaves that way.

Some documents are in Korean, some in English. Each entry below is in the
language of its file.

## What lives where

| Directory | Contents |
|---|---|
| [`specs/`](specs/) | One file per behavior change: goal, non-goals, acceptance criteria, the verified upstream contract it depends on, and the evidence that closed it. Named `YYYY-MM-DD-<topic>.md` |
| [`plans/`](plans/) | The implementation plan paired with a spec of the same date and topic: scope, explicit non-scope, task checklist |
| [`runbooks/`](runbooks/) | Symptom-first operational procedures. Read-only diagnosis first, recovery second, prevention last |
| [`evidence/`](evidence/) | Frozen excerpts with source SHA-256 hashes, so an independent reviewer can check a claim without pulling whole files into a review bundle |
| [`agent-handoffs/`](agent-handoffs/) | State handed from one agent session to the next: goal, current conclusion, what was verified, what was deliberately not touched. `current.md` is the live one |
| [`assets/`](assets/) | Images referenced by the READMEs (hero, dashboard screenshot) |

Operational context for the production deployment is summarized in the
[README's Operations section](../README.md#operations).

## Runbooks

| Runbook | Open this when… |
|---|---|
| [codex-pool-exhaustion](runbooks/codex-pool-exhaustion.md) | Every Codex turn dies with `exceeded retry limit, last status: 429 Too Many Requests`, or `usableCount` is `0` on the status endpoint |
| [teamcodex-runtime-deployment](runbooks/teamcodex-runtime-deployment.md) | You are deploying, verifying, or rolling back the frozen production artifact, or need to identify which commit produced the artifact that is running |
| [teamcodex-launchd-bootout-recovery](runbooks/teamcodex-launchd-bootout-recovery.md) | Nothing answers on port 3457 and clients report `Connection failed: error sending request`; the service was booted out of the launchd domain and needs `bootstrap`, not `kickstart` |
| [ambiguous-dispatch-502](runbooks/ambiguous-dispatch-502.md) | Claude Code shows `502 Upstream connection failed after dispatch. Request was not replayed.` and you need to know whether the request reached upstream |
| [claude-subscription-disabled](runbooks/claude-subscription-disabled.md) | Claude Code exits with a 403 and `oauth_not_allowed_for_organization`, and you need to tell an organization block apart from a quota problem |
| [subscription-and-agent-session-recovery](runbooks/subscription-and-agent-session-recovery.md) | An account shows `usable:false`, or a qjc-agent session refuses to start, before concluding that the subscription is the cause |
| [codex-provider-session-recovery](runbooks/codex-provider-session-recovery.md) | A running Codex TUI did not pick up the proxy provider, or a TeamCodex-launched Codex process exited and the exact session has to be resumed without the recent-session picker |
| [main-worker-codex-session-recovery](runbooks/main-worker-codex-session-recovery.md) | An SSH `Broken pipe` between the main cmux and a worker's Codex dropped surfaces back to a shell, and the original conversation must be restored in its original tab |
| [cmux-renderer-session-recovery](runbooks/cmux-renderer-session-recovery.md) | The cmux renderer or a surface/PTY mapping misbehaves and you need non-destructive diagnosis that never kills a live session |

## Conventions

- A spec and its plan share a date and topic
  (`specs/2026-08-30-account-reauthentication.md` pairs with
  `plans/2026-08-30-account-reauthentication.md`).
- Specs record evidence as the exact command that produced it, with pass/fail
  counts, not a summary claim.
- Runbooks lead with the symptom string an operator will actually see, and
  separate read-only diagnosis from anything that mutates state.
- Nothing in this directory contains account addresses, tokens, or proxy API
  keys. Use placeholders such as `account-a@example.com` when adding examples.
