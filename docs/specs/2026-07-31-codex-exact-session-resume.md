# Codex exact-session resume

Status: Implemented; final runtime/adversarial verification in progress (2026-08-13).

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
  upstream request. An uncertain POST remains non-replayable inside the proxy.
- Managing or terminating Codex processes in other cmux surfaces.
- Guessing a checkpoint from recency, cwd, title, scrollback, or private Codex
  storage when the current invocation did not establish an exact checkpoint.

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
5. Every `run` and `resume` launch rejects configuration that can replace
   `model_provider`, `model_providers.*`, or `chatgpt_base_url`, including all
   Codex-supported short-option spellings (`-c VALUE`, `-cVALUE`, and
   `-c=VALUE`). Alternate
   execution paths (`--remote`, `--remote-auth-token-env`, `--oss`, and
   `--local-provider`) are also rejected instead of forwarded because they
   bypass provider selection entirely. Resume still places the TeamCodex
   overrides after the exact selector and accepted forwarded arguments.
6. A successful exit, a child signal, the conventional cancel status `130`, a
   launch error, a non-proxy child error, and an unchanged/missing/malformed
   current-surface binding remain single-launch exits with no implicit resume.
7. Public help, English/Korean setup docs, architecture notes, and an incident
  runbook explain that provider selection is process-scoped and that
  `source ~/.zshrc` cannot repair a live TUI.
8. Every wrapper invocation creates a random UUIDv4. Codex receives it through
   the supported provider `env_http_headers` setting as
   `X-TeamCodex-Invocation`. The worker strips this local nonce before the
   upstream request, so it never leaves TeamCodex. Codex's official
   configuration reference defines `model_providers.<id>.env_http_headers` as
   HTTP headers populated from environment variables when present.
9. Only an ambiguous unsafe `POST /codex/responses` failure may create a
   recovery receipt. This includes a complete retryable 5xx, transport failure,
   dispatched response/body timeout, response-size rejection, pre-stream SSE
   failure, unclassified post-dispatch error, mid-response SSE abort, and worker
   death before or after response start. The proxy binds the wrapper invocation
   UUID to the exact
   request `prompt_cache_key`, which Codex 0.147.0 was observed to set to the
   session UUID. Missing or malformed values, other endpoints, non-POST
   methods, ordinary child/config/auth failures, and successful requests mint
   no receipt. The proxy never replays that uncertain POST internally.
10. A receipt is held only in supervisor memory, expires after 30 seconds, is
    capped with the receipt map at 1,024 entries, and is consumed once through
    the localhost-only `POST /teamclaude/codex-recovery/consume` endpoint. The
    internal worker response header that carries the exact session to the
    supervisor is stripped from every upstream response status and is never
    exposed to the public client. The supervisor accepts it as receipt authority
    only for an exact `POST /codex/responses` carrying a valid invocation nonce.
11. After an unexpected non-zero Codex exit, TeamCodex may resume **once** only
    when it consumes a receipt for its own invocation and the receipt UUID is:
    - the same explicit UUID already used by `resume SESSION_ID`; or
    - exactly the current cmux Codex binding after the failed new-session
      launch, different from a pre-existing binding. A structurally empty cmux
      surface may acquire its first receipt-matching binding; an unreadable or
      malformed baseline may not.
12. Automatic recovery uses the same provider-enforced `resume SESSION_ID`
   launch path as manual recovery. It never opens a selector, uses `--all` or
   `--last`, reads another surface, or terminates another process.
13. The single retry is a hard per-wrapper budget. If the resumed child also
    exits non-zero, TeamCodex returns that final exit without a loop. A visible
    diagnostic distinguishes automatic recovery from the original launch but
    does not print the checkpoint UUID.
14. Receipt consumption and the post-exit cmux lookup share one strict
    five-second total deadline. An unavailable proxy, expired/missing receipt,
    or untrusted checkpoint fails closed with the original non-zero outcome; it
    does not fall back to direct OpenAI routing.
15. The empty-prompt watchdog may continue only seven observed transient-failure
    blocks: post-dispatch no-replay 502, TeamCodex tunnel-disconnect 502,
    upstream-connection no-replay 502, verified-deployment drain 503,
    upstream-overloaded no-replay 504, Codex's exact
    `stream disconnected before completion: error sending request for url`
    block, and the exact warning
    `⚠ Selected model is at capacity. Please try a different model.`. The stream
    form must include the parenthesized literal localhost
    `/codex/responses` URL. Every block must fullmatch after joining at most
    three wrapped lines; arbitrary suffixes and normal output that merely quotes
    the error fail closed. Every consumed wrapped line participates in the
    fingerprint, so a later failure on a different proxy port is not permanently
    suppressed as the earlier incident. Capacity recovery additionally requires a current
    `gpt-*` status line, binds that line into the fingerprint, keeps the selected
    model unchanged, and skips only the unavailable proxy-port health probe. A
    local checkpoint must be a valid UUIDv7. A remote
    checkpoint must be nonempty, allowlisted, and exactly the sole target of a
    three-token `qjc-agent attach <checkpoint>` resume command. Extra options,
    decoy occurrences, and other remote command shapes fail closed.
16. A healthy TeamCodex status response is never a process-restart signal,
    regardless of fleet `inflight`. If status is unavailable while the TCP
    listener remains present, the external guard preserves the process. Only
    three consecutive absent-listener samples may issue `launchctl kickstart`
    without `-k`; the guard never replaces a live process.
17. The watchdog keeps the cmux stable surface UUID as its identity, binding,
    fingerprint, and cooldown key, but uses the current `surface:N` ref for
    `read-screen` and `send`. It resolves that mapping from the same official
    tree payload and rechecks it before screen reinspection and immediately
    before send. Any mapping change or lookup error fails closed as stale.

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
- [x] General `codex run` rejects the same provider/base-URL configuration
  overrides before launching a child.
- [x] Compact `-cVALUE` and `-c=VALUE` provider overrides are rejected in both
  `run` and `resume`; Codex 0.147.0 accepts these spellings.
- [x] Resume rejects every Codex CLI option that activates a remote or local
  provider path outside TeamCodex.
- [x] The cmux lookup subprocess does not inherit direct Codex credentials.
- [x] Existing Codex run tests, the full Node test suite, and ESLint pass.
- [x] A real temporary cmux terminal surface shows a TeamCodex-backed resume
  binding after launch.
- [x] A fake Codex child that exits non-zero after replacing the current cmux
  binding is invoked exactly twice; the second invocation is
  `resume SESSION_ID` through `teamcodex_proxy`, and its success becomes the
  wrapper's exit status.
- [x] A second non-zero exit stops after the single recovery attempt.
- [x] Missing, malformed, non-Codex, or unchanged/stale bindings do not launch
  a second child. Signal and status 130 cancellation also remain single-launch.
- [x] A manual `codex resume SESSION_ID` that fails unexpectedly retries only
  the same explicit UUID once, never another binding.
- [x] Real CLI QA and an isolated supervisor QA show that an uncertain POST is
  still sent upstream once while the CLI can reopen the exact saved session.
- [x] Recovery diagnostics omit the exact checkpoint UUID, and an unavailable
  proxy consumes no more than the five-second total readiness budget.
- [x] A non-proxy non-zero child exit does not resume even when another process
  changes the current cmux binding.
- [x] A receipt for a different exact session does not resume the current
  binding, and a receipt cannot be consumed twice.
- [x] The local invocation nonce is stripped before upstream forwarding and
  only the exact responses inference endpoint may mint a receipt.
- [x] A dispatched response timeout mints the same one-time receipt without
  replaying the POST, and forged internal headers are removed from 2xx, 403,
  429, raw relay, and common response forwarding paths.
- [x] Response-size rejection and unclassified post-dispatch failures also mint
  the same receipt while preserving the single upstream dispatch.
- [x] A partial Codex SSE or worker death after response start mints a receipt
  in the supervisor from the original validated identity; a clean terminal SSE
  never does.
- [x] The watchdog accepts the exact stream-disconnect block and its two- and
  three-line URL wraps, rejects an arbitrary suffix and normal-output quotation,
  rejects UUIDv1/v4/v8 local checkpoints, and rejects command-mismatched or
  decoy-token remote checkpoints.
- [x] Healthy high-inflight and status-unavailable-with-listener states cannot
  replace the TeamCodex process; consecutive listener loss starts it without
  `launchctl -k`.
- [x] Stable UUID screen-read failures are eliminated by retaining the current
  cmux ref, while ref changes during recovery suppress every send.
- [x] The exact selected-model capacity warning at an empty prompt continues the
  same checkpoint and selected model without a proxy-port probe. Similar text,
  quoted output, a missing `gpt-*` status line, a user draft, duplicate cooldown,
  and every existing stale binding/surface condition send nothing.

## Risks

- cmux is optional. The no-ID form must report how to provide `SESSION_ID`
  explicitly when cmux is unavailable.
- Codex may change its session identifier format. The current CLI and cmux
  checkpoints use UUIDs; rejecting unknown formats is safer than resuming the
  wrong conversation.
- The cmux hook owns binding creation. TeamCodex consumes that public binding
  contract and must not parse cmux's private session JSON for normal recovery.
- Exit status and stderr are not trustworthy recovery classifiers. Recovery
  authority comes only from a nonce-bound proxy receipt created on the
  ambiguous request path; without it every non-zero outcome stays one-shot.
- An old binding in a reused tab must never become recovery authority. The
  receipt match plus before/after UUID comparison is the freshness proof;
  equality fails closed.
- `prompt_cache_key == session_id` is an observed Codex 0.147.0 wire contract,
  not a TeamCodex guess. If Codex changes or omits it, receipt parsing returns
  null and automatic recovery safely stops; manual exact resume remains.
- The stream-disconnect phrase is broader than the TeamCodex-specific status
  lines. The exact TUI marker, parenthesized localhost `/codex/responses` URL,
  full-block match, empty prompt, healthy proxy, stable binding, and final
  screen recheck are all required; weakening any one reopens normal-output
  quotation and wrong-surface submission risk.
- `inflight` is throughput state, not liveness. Treating it as a restart
  threshold interrupts already-dispatched unsafe POSTs and creates the exact
  no-replay 502 this recovery path handles.
- cmux accepts stable UUIDs for resume-binding lookup but some screen/send
  commands require an ephemeral `surface:N` ref. Using the ref without stable
  identity checks risks a reused target, so both values are retained and the
  mapping is checked twice before input.
- The capacity warning has no localhost URL or proxy port. It therefore cannot
  use proxy health as evidence; exact warning text, current `gpt-*` status,
  empty prompt, stable checkpoint/binding/surface, repeated screen reads, and
  the 120-second cooldown are the complete fail-closed boundary. The watchdog
  never sends `/model` or chooses a fallback model.

## Verification

- Targeted unit/E2E tests in `test/codex-resume.test.js`.
- Regression test in `test/codex-run.test.js`.
- `npm test`.
- `npm run lint`.
- Manual CLI QA with fake `codex`/`cmux` binaries.
- Manual cmux surface QA using `cmux surface resume get --json`.
- Independent adversarial review against this spec, the diff, and execution
  evidence before merge.
- `test/codex-run.test.js` RED→GREEN cases for new exact binding, stale binding,
  signal/cancel, and bounded repeated failure.
- `test/codex-recovery.test.js` boundary cases for invocation UUID, session UUID,
  request body, and exact endpoint classification.
- `test/server-supervisor.test.js` integration for nonce/session binding,
  public-header removal, endpoint restriction, and one-time consumption.
- Manual CLI fixture evidence under `.omo/evidence/codex-cli-self-recovery/`.
- Watchdog regression:
  `python3 -m unittest discover -s ~/.codex/tests -p 'test_codex_502_watchdog.py' -v`
  covers the seven exact blocks, including the exact upstream-connection
  no-replay 502 at port `61639`, upstream-overloaded no-replay 504, and
  selected-model capacity, plus suffix/quotation/wrap boundaries,
  UUIDv7/remote checkpoint trust, and send-time TOCTOU checks. Current evidence
  is the current gate-owned capacity review (61/61 in the current runtime).
  `.omo/evidence/codex-502-resilience/sc18-watchdog-binding-green.txt` is the
  prior 51-test baseline. SC16 is the prior
  detector baseline; SC18 adds the UUIDv1/v4/v8 and remote decoy-token
  adversarial closure required by the current acceptance criteria.
- 2026-08-20 incident RED→GREEN evidence is under
  `.omo/evidence/teamcodex-502-self-heal/`: guard 3/3 and watchdog 43/43.
  The incident correlated a destructive high-inflight guard restart with the
  tunnel 502 at the same second; the watchdog then missed the waiting session
  because it passed a stable UUID to `read-screen` instead of its current ref.
