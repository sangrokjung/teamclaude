# Codex provider and exact-session recovery runbook

## Summary

An existing Codex TUI does not adopt a new provider when shell configuration
changes. Exit the affected TUI and run `teamcodex codex resume` in the same
cmux terminal. The command reads that surface's exact Codex checkpoint and
launches it through TeamCodex without opening the recent-session selector.

For a TeamCodex-launched process that exits unexpectedly, the wrapper performs
that exact recovery once only when the proxy recorded a one-time receipt for
the same wrapper invocation and exact session. It does not replay an uncertain
HTTP request.

## 2026-08-13 repeated 502 incident

Observed Codex failures included:

```text
HTTP 502
Upstream connection failed after dispatch. Request was not replayed.
Transport channel closed
```

The live TeamCodex supervisor had been running since 2026-08-07 and still held
the old health algorithm in memory. Under 16-core load averages of 119–193, it
counted two HTTP probe timeouts as worker failure and sent SIGKILL. A dispatched
POST then correctly surfaced 502 because replaying it could duplicate inference.
The source already contained self-stall discounting, a 5-second × 3 threshold,
and IPC pong corroboration, but the long-lived daemon had never loaded it.

The recovery has two independent layers:

1. Prevention: restart the daemon during a zero-inflight maintenance window so
   the current supervisor health logic is actually loaded.
2. Continuation: when the Codex child exits, reopen the same saved session once
   under the safety rules below.

There is also a final TUI recovery watchdog for allowlisted transient failures that
leave Codex alive at an empty prompt: the exact post-dispatch no-replay 502,
the TeamCodex tunnel-disconnect 502, the upstream-connection no-replay 502,
the verified-deployment drain 503, the exact upstream-overloaded no-replay 504,
the exact Codex stream-disconnect block
`stream disconnected before completion: error sending request for url` with
its parenthesized localhost `/codex/responses` URL, and the exact warning
`⚠ Selected model is at capacity. Please try a different model.`.
`com.qjc.codex-502-watchdog` runs every
60 seconds. It uses one global cmux tree read plus stable surface UUID resume
bindings; it does not scan the machine-wide process argv table. Local
`kind=codex` and explicitly bound remote `qjc-agent`/`qjc-worker` terminals are
checked, while arbitrary terminal titles are never trusted. A tree failure
revalidates only the last complete UUID cache, and a slow binding or screen read
skips that surface without cancelling the rest of the tick.

On 2026-08-20 a separate external proxy guard caused the tunnel-disconnect
variant by interpreting three normal high-`inflight` samples as a wedge and
running `launchctl kickstart -k`. The restart log and 502 had the same second.
The guard now treats every valid HTTP 200 as healthy regardless of `inflight`;
if status fails but the TCP listener exists, it also preserves the process.
Only three consecutive absent-listener samples may run non-destructive
`launchctl kickstart` without `-k`.

The watchdog submits only when the recent screen has an exact allowlisted
TUI error block. Proxy/stream errors require their marker, failure phrase, and
literal localhost `/codex/responses` URL to fullmatch after joining at most
three wrapped lines. The capacity path instead requires the exact `⚠` warning
and a current `gpt-*` status line; it binds that status into the fingerprint,
does not send `/model`, and does not choose a fallback model.
Every wrapped error line, including its proxy port, is included in the
fingerprint so a later independent failure remains recoverable after cooldown.
An arbitrary suffix or normal output that quotes either status or stream text
is rejected. An empty/default Codex prompt and no intervening output or user
draft are mandatory. A valid localhost proxy port is mandatory for proxy/stream
errors. The exact capacity warning and exact ChatGPT unsupported-model JSON are
the two port-less allowlist paths; both skip only that health probe. A local Codex checkpoint
must be UUIDv7; a remote checkpoint must be nonempty, allowlisted, and present
as the sole target of an exact three-token
`qjc-agent attach <checkpoint>` resume command. Extra arguments, a different
attach target followed by a decoy checkpoint, and other remote command shapes
are rejected. It
verifies the local proxy or the remote worker proxy over SSH,
re-reads the same surface immediately before sending, then re-fetches its
stable resume binding. The surface UUID, checkpoint, and local/remote class must
still exactly match discovery; a lookup error, shell transition, or binding
change is treated as stale without consuming the fingerprint. After that
binding check it reads the screen one final time, so a user draft or new output
that appeared during the lookup also becomes stale. It persists `pending`
before the single send, uses a status-neutral `일시적 모델·프록시 오류`
continuation, and
never enables POST replay. An unrelated generic 502/503/504 is not allowlisted.
cmux stable UUIDs remain the identity and binding key, while the current
`surface:N` ref from the same tree is the only screen-read/send target. The
UUID→ref mapping is checked before the final read and again before send; a ref
change or lookup failure is stale and sends nothing. Inspect errors are logged
as bounded stage codes such as `screen-internal-error`, never screen content,
and never fall back to private Codex history as proof of an empty prompt.
The per-surface cooldown is 120 seconds, so a repeated capacity warning cannot
produce a send storm even though launchd scans every 60 seconds.

Watchdog diagnostics:

```bash
python3 ~/.local/bin/codex_502_watchdog.py --dry-run
python3 ~/.local/bin/codex_502_watchdog.py --status
launchctl print gui/$(id -u)/com.qjc.codex-502-watchdog
tail -40 ~/.codex/log/codex-502-watchdog.log
/usr/bin/python3 ~/.local/bin/teamcodex_proxy_guard.py --dry-run
tail -40 ~/.codex/log/teamcodex-proxy-guard.log
```

Healthy high-load behavior is `discovery_complete=true` with candidate checks
continuing even if `inspect_errors` is non-zero. Repeated `scan-deferred` means
an outer invariant still failed and requires investigation; it is no longer the
normal response to one slow process-table or surface lookup.

Observed production proof on 2026-08-14: the watchdog submitted once to the
verified stable surface at 16:17:03 after the exact 502. The same surface
retained its Codex binding and checkpoint and showed new Codex work/prompt output
after the error. The evidence check was read-only and did not send a second
recovery message. The reduced, non-sensitive receipt is stored at
`.omo/evidence/codex-502-resilience/sc11-live-exact-recovery-green.txt`.

Observed verified-drain proof on 2026-08-14: the same stable surface received
the exact drain 503 and the watchdog submitted once at 16:48:12. Both observed
proxy ports then returned HTTP 200, and the surface retained its Codex binding,
checkpoint, and post-error work markers. Regression evidence is in
`.omo/evidence/codex-502-resilience/sc12-watchdog-drain-503-{red,green}.txt`.

Stream-disconnect and checkpoint trust evidence is in
`.omo/evidence/codex-502-resilience/sc16-watchdog-green.txt`: 38/38 tests cover
the exact stream positive, two- and three-line URL wraps, arbitrary-suffix and
normal-output quotation negatives, UUIDv7 local checkpoints, remote
command/checkpoint binding, and both send-time TOCTOU checks. The same component
completed a production `--dry-run` with 12 trusted candidates, complete
discovery, zero inspect errors, and zero submissions.

Adversarial binding follow-up is in
`.omo/evidence/codex-502-resilience/sc18-watchdog-binding-green.txt`:
UUIDv1/v4/v8 local checkpoints and a remote decoy-token command fail RED before
the fix and pass after it. The current live topology contains three remote tmux
bindings; all three match the exact attach form without exposing their IDs.

The exact upstream-connection 502 variant at
`http://127.0.0.1:61639/codex/responses` has an explicit regression test in the
current 87-test core watchdog suite plus 15 variant tests. The production watchdog matched the
command-compatible fixture once, sent one continuation to the exact
`surface:1`, and suppressed the immediate second tick by fingerprint/cooldown;
the receipt is `.omo/evidence/codex-502-resilience/sc19-live-command-compatible-qa.json`.

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

### ChatGPT account model incompatibility

When a selected ChatGPT OAuth account returns the exact completed response

```text
{"detail":"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."}
```

TeamCodex quarantines only that account/model pair for 30 minutes and returns
that exact 400 without replaying the POST. An already displayed exact error is
handled by the existing watchdog as one new continuation turn. Each new turn
uses the next eligible OAuth account. Once any live OAuth quarantine exists for
the requested model, every fresh Codex request for that model is pinned to the
OAuth pool before account selection and cannot fall through to a mixed-pool
API-key account. After independent turns have quarantined the OAuth fleet, the
public status projection stays credential-free and exposes only the safe
reason, recovery action, and bounded model quarantine metadata. The
following new turn walks the configured `gpt-5.6-sol -> gpt-5.6-terra` fallback
before dispatch. If no OAuth candidate or fallback remains, TeamCodex returns a
prompt 429 whose `retry-after` reflects the earliest quarantine expiry, without
an upstream dispatch. Generic, malformed, quoted, mismatched, API-key, 5xx,
timeout, and interrupted-stream responses never enter this compatibility path.

The exact 400 relay preserves compressed wire bytes plus `content-encoding`
and `content-length`; only a bounded inspection copy is decoded. Codex requests
remain in their first OAuth/API-key credential type, and upstream quota-label
metadata is capped at 64 entries per account. This prevents cross-credential
redispatch and unbounded memory growth during repeated malformed responses.

A completed POST 429 is an explicit upstream rejection and may use bounded
same-credential-type account failover. It never crosses the OAuth/API-key boundary.
Timeouts, 5xx responses, transport failures, and incomplete streams remain ambiguous
and never replay an unsafe POST. Raw OAuth and supervisor relays strip
`Proxy-Connection` in both directions. Encoded Codex SSE stays wire-byte-preserving
and skips text usage parsing, so the stream ends and releases its keep-alive connection
instead of blocking the next terminal request.

Status and logs deliberately expose less identity than the routing process:
request logs omit credentials, email-like account names, stable account IDs,
and request IDs. Public status omits stable account UUIDs. Only the existing
Claude recovery client may request identity-bearing status, and only with
localhost origin, the proxy API key, and the explicit internal identity header.
If the watchdog diagnostic log cannot be opened or written, scanning remains
fail-open so the next launchd tick can still recover waiting sessions.

검증 명령:

```bash
node --test --test-concurrency=1 test/server-codex-model-compatibility.test.js
/usr/bin/python3 ~/.codex/tests/test_codex_502_watchdog_variants.py
/usr/bin/python3 ~/.local/bin/codex_502_watchdog.py --dry-run
```

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

## Automatic exact-session continuation

No config flag is required. Each `teamcodex codex run` creates a random
invocation UUID. Codex's provider `env_http_headers` puts it on the local proxy
request; this is a documented custom-provider setting, not an injected private
flag. TeamCodex strips it before forwarding upstream. If the unsafe
`POST /codex/responses` then fails ambiguously, the proxy binds that invocation
UUID to the request's exact `prompt_cache_key` session UUID in a short-lived
memory receipt. Ambiguous failures include a complete retryable 5xx, transport
failure, dispatched response/body timeout, response-size rejection, pre-stream
failure, unclassified post-dispatch error, partial SSE abort, and worker death
before or after response start. Before headers the worker carries the receipt
identity in an internal response header. After headers, the supervisor uses the
original validated nonce/session request identity only when the worker response
aborts before a terminal SSE event. A clean terminal event never creates a
receipt. No path replays the POST.

After an unexpected non-zero exit it resumes once only when all of these are
true:

- the wrapper consumes its own receipt through the localhost-only endpoint;
- the receipt is unexpired, unused, and contains a valid session UUID;
- for a new run, the post-exit current cmux binding exactly matches the receipt
  and differs from any pre-existing binding;
- for explicit resume, the receipt exactly matches the requested UUID;
- receipt consumption and post-exit cmux lookup complete within one five-second
  deadline.

A structurally empty cmux surface may acquire its first receipt-matching
binding. An unreadable, malformed, non-Codex, or invalid-UUID baseline stays
fail-closed. Receipts expire after 30 seconds, are consumed once, and the
in-memory map is capped at 1,024 entries. A proxy-internal recovery header is
removed on every response forwarding path and never returned to the Codex
client. The supervisor accepts that header only on an exact
`POST /codex/responses` with a valid invocation nonce; upstream 2xx/403/429
headers cannot manufacture a receipt.

An explicit `teamcodex codex resume SESSION_ID [args...]` may retry that same
UUID once and preserves its forwarded arguments. The following stop without
automatic continuation:

- success, any signal, or conventional cancel status 130;
- launch failure, unrelated config/auth/usage error, or unavailable proxy;
- missing, expired, already-consumed, or session-mismatched receipt;
- missing, malformed, non-Codex, unreadable, or unchanged binding;
- failure of the one recovery launch.

The wrapper never uses cwd, title, recency, `--all`, `--last`, or another cmux
surface. It does not kill the old process or any other terminal.

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

### ChatGPT 계정별 Codex 모델 거절

`The '<model>' model is not supported when using Codex with a ChatGPT account.`
exact 400은 계정별 entitlement 차이입니다. TeamCodex는 해당 OAuth account/model을
30분간 격리하지만 원 POST를 proxy 내부에서 재전송하지 않습니다. 빈 prompt에 도달한
경우 `com.qjc.codex-502-watchdog`가 durable fingerprint를 먼저 저장하고 새 continuation
turn만 보냅니다. 해당 모델의 유효한 OAuth 격리 기록이 하나라도 생긴 뒤에는 이후의 새
Codex 요청도 계정 선택 전에 OAuth 풀로 고정되어 mixed pool의 API-key account로 넘어가지
않습니다. 모든 OAuth account가 격리됐을 때 dispatch 전에
`gpt-5.6-sol -> gpt-5.6-terra` fallback을 적용하며, 사용할 OAuth 후보와 fallback이 모두
없으면 upstream dispatch 없이 가장 이른 격리 TTL을 `retry-after`로 담은 429를 즉시 반환합니다.

반복 거절도 cooldown/backoff/circuit 범위에서 자동 재개합니다. watchdog state/lock을
쓸 수 없으면 중복 방지를 증명할 수 없으므로 그 tick의 제출은 0건으로 defer하고 exit 0으로
다음 launchd tick을 기다립니다. request log는 Codex에서 path와 allowlisted metadata만 남기며
query, body, raw stack, account identity, credential, 임의 header를 기록하지 않습니다.

확인 명령:

```bash
python3 ~/.local/bin/codex_502_watchdog.py --dry-run
launchctl print gui/$(id -u)/com.qjc.codex-502-watchdog
teamcodex codex status
```

정상 기준은 `submitted=0`인 dry-run, launchd `last exit code=0`, 공개 status에 stable
account identity가 없는 상태입니다.

- Start Codex with `teamcodex codex run`, not plain `codex`, when account
  pooling is required.
- In cmux, keep Codex hooks installed. The SessionStart hook records the exact
  checkpoint and the provider arguments used to launch the process.
- Restore a tab through its recorded binding or `teamcodex codex resume`; do
  not treat the recent-session selector as the source of truth.
- TeamCodex rejects provider/base-URL configuration overrides on both `run` and
  `resume`, including `model_provider`, `model_providers.*`, and
  `chatgpt_base_url` through `-c`/`--config`. This includes `-c VALUE`, compact
  `-cVALUE`, and `-c=VALUE`; Codex accepts all three forms.
- TeamCodex rejects `--remote`, `--remote-auth-token-env`, `--oss`, and
  `--local-provider` because those options bypass provider configuration
  instead of overriding it.
- Automatic recovery logs that a trusted exact session is being reopened but
  does not print its checkpoint UUID. Proxy readiness, including probes and
  cmux lookup, has a strict five-second total budget.
- Exit text and exit status are never used as proof that a request is
  recoverable. Only the nonce/session-bound proxy receipt authorizes the one
  reopen; an unrelated child error cannot trigger it.
- The checkpoint-only cmux lookup runs without direct Codex credential
  environment variables.
- When provider configuration changes, restart or exact-resume existing TUI
  processes. Shell reload is not a migration mechanism.
- A source update does not change an already-running Node supervisor. Compare
  the state-file PID start time with source deployment time, and restart only
  during a zero-inflight maintenance window.
- Health logs from current code say either `failed 3 health checks and does not
  answer IPC` for a true wedge or `worker death is uncorroborated under host
  contention; keeping it` when HTTP/IPC evidence overlaps supervisor stall.
  Continued `failed 2 health checks` proves the old supervisor is still
  running.

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

For the repeated-502 path:

```bash
teamcodex codex status
jq '{pid,workerPid,port,startedAt}' ~/.config/teamcodex.server.json
rg -n 'failed [0-9]+ health checks|host contention|SIGKILL' \
  ~/.config/teamcodex.launchd.error.log
```

If the CLI exits instead of auto-resuming, treat that as the safe outcome. Use
`teamcodex codex resume` manually after confirming the current binding. Do not
manufacture a receipt, copy a different session UUID, or enable POST replay.

Before deploying a supervisor update, wait until the status payload reports no
in-flight work. Restarting the public supervisor while requests are active can
interrupt them. After restart, verify the supervisor PID/start time changed,
`GET /teamclaude/status` returns 200, and the old `failed 2 health checks` line
does not grow.

### 승인된 zero-inflight 자동 배포

`com.qjc.teamcodex-runtime-deployer`가 30초마다 다음을 확인한다.

1. state file PID가 정확히 canonical `src/index.js codex server`인지 검증한다.
2. status의 `x-teamcodex-source-hash`와 디스크 source hash를 비교한다.
3. `~/.codex/state/teamcodex-runtime-approved.sha256`가 현재 사용자 소유의 group/other 권한 없는 regular file이고 현재 source hash와 정확히 같을 때만 후보로 삼는다. symlink receipt는 거부한다. 승인된 `src/*.js`와 고정된 최소 ES module metadata를 `~/.local/share/teamcodex-runtime/artifacts/<sha256>/`에 content-addressed read-only artifact로 만들며 복사 전후 source hash나 기존 artifact metadata가 다르면 중단한다.
4. active public request가 두 번 연속 0일 때 lifecycle ID가 일치하는 local-only `POST /teamclaude/deployment/drain`으로 신규 admission을 봉쇄한다. 응답의 `activeRequests`가 0이어야 bootout한다. drain은 기본 15초 뒤 자동 해제된다. 경쟁 요청이 있으면 `DELETE`로 즉시 풀고 다음 주기로 미룬다. 구형 데몬처럼 active/hash/lifecycle이 없으면 세 번 연속 0을 요구하고, 동일 PID/argv만 20초 뒤 되살리는 detached guard를 먼저 실행한 뒤 supervisor를 `SIGSTOP`하고 established connection 0을 재검증한다. 경쟁 연결이 있거나 검증이 불명확하면 `SIGCONT`하고 중단한다.
5. artifact의 owner, regular-file 구조, symlink 부재, source hash, 고정 metadata를 target과 rollback launch 직전에 다시 확인한다. launchd의 `ProgramArguments`와 `WorkingDirectory`를 exact artifact로 교체하고 새 PID/runtime hash가 승인 hash와 같을 때만 `deployed`로 기록한다. bootout/bootstrap timeout이나 OS 오류도 직전 healthy artifact rollback으로 들어가며 rollback 건강성까지 확인한다.

최초 배포에서 legacy 데몬은 source-hash 헤더가 없어 그 자체를 last-good으로 증명할 수 없다. 이때만 전역 설치본의 `name=teamcodex`, `version=1.3.3`, `type=module`, `bin.teamcodex=src/index.js`와 pinned `src/*.js` bundle hash를 모두 확인한 뒤 immutable rollback artifact를 seed한다. 하나라도 다르면 `rollback-unavailable`로 중단하며 현재 데몬을 건드리지 않는다. 이 artifact로 rollback한 런타임은 hash 헤더가 없으므로 status 200, 새 PID의 exact launchd argv, pinned artifact entry가 모두 일치할 때만 healthy로 인정한다. 그 외 hash-header 부재 런타임에는 이 예외를 적용하지 않는다.

상태 확인:

```bash
launchctl print gui/$(id -u)/com.qjc.teamcodex-runtime-deployer
tail -20 ~/.codex/log/teamcodex-runtime-deployer.log
cat ~/.codex/state/teamcodex-runtime-deployer.json
```

`busy`와 `fence-busy`는 정상 대기이며 진행 중 요청을 중단하지 않는다. `unapproved`는 디스크 source가 바뀌었지만 검증·승인 hash가 갱신되지 않았다는 뜻이다. `rollout-failed` 또는 `restart-unverified`는 같은 승인 hash의 자동 재시도를 잠갔다는 뜻이다. source를 다른 값으로 바꿨다가 되돌려도 잠금은 풀리지 않는다. 승인 파일을 제거한 상태를 deployer 로그의 `unapproved` 한 주기로 확인하고, 원인을 수정·검증·독립 검토한 다음 `save_hash()`로 새로 승인한다. hash를 자동 갱신하지 않는다.

자동 rollout 검증 실패는 직전 healthy immutable artifact로 rollback한다. 수동 롤백은 먼저 deployer를 `bootout`하고 승인 파일을 제거한 뒤 `teamcodex-runtime-last-good.sha256`가 가리키는 artifact의 exact `src/index.js`를 launchd `ProgramArguments`로 복원하고 `com.qjc.teamcodex`만 재기동한다. working tree를 직접 실행하거나 unsafe POST replay를 활성화하지 않는다.

## Failure behavior

`teamcodex codex resume` does not:

- open `resume --all`;
- choose the newest session;
- infer a session from `cwd`;
- terminate or replace another surface;
- replay a failed request or perform more than one exact-session recovery.

It exits non-zero without launching Codex when the binding is missing,
malformed, or belongs to another provider.

## Rollback

The change is additive. Existing behavior remains available:

```bash
teamcodex codex run
teamcodex codex run -- resume SESSION_ID
```

To disable only automatic continuation, restore the one-shot Codex branch in
`runCommand`; manual `teamcodex codex resume` remains available. To roll back
the entire convenience command, remove the `resume` dispatcher and
`src/codex-session.js`. No config, account, token, database, or cmux state
migration is required. Do not enable POST replay as a rollback.
