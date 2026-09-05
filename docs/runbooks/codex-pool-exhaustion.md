# Codex pool exhaustion runbook

## Summary

Codex stops answering and the error is about retries, not about quota. On the
proxy host the Codex CLI ends every turn with `exceeded retry limit, last status: 429
Too Many Requests` (Codex's own error enum is `RetryLimit`, `codex_error_info`
is `response_too_many_failed_attempts`); on a second machine
whose Codex CLI reaches the pool through an SSH tunnel, the same failure looks
like a network problem and gets misfiled as a dead tunnel. The usual cause is
not plumbing: every pooled ChatGPT account is out of weekly quota, the proxy has
no account left to serve with, and before the usage-limit fail-fast shipped it
answered with a body the Codex CLI cannot read. This runbook separates quota
from plumbing in one command, confirms it against the authoritative per-account
usage endpoint, and lists the three things that actually restore service.

Related: [TeamCodex runtime deployment](./teamcodex-runtime-deployment.md) for
which artifact is live and how to roll one out. The alerting that should catch
this before users do is in [Prevention](#prevention).

## Is it quota or plumbing?

Run this first. It is read-only and takes one round trip.

```bash
curl -s http://127.0.0.1:3457/teamclaude/status \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["usableCount"],"/",d["totalCount"])'
```

| Result | Reading | Go to |
|---|---|---|
| `0 / 8` (usable is 0, total is non-zero) | Quota or subscription. The pool has accounts, none can serve right now. | [Confirm with /wham/usage](#confirm-with-the-authoritative-usage-endpoint) |
| `3 / 8` (usable is non-zero) | Not pool exhaustion. The proxy can serve; the failure is elsewhere (tunnel, client config, model). | [Codex provider session recovery](./codex-provider-session-recovery.md) |
| `0 / 0` | The pool has no accounts. Import or log in an account. | [Recovery options](#recovery-options) |
| Connection refused / empty | The proxy is not listening. This is plumbing. | [launchd bootout recovery](./teamcodex-launchd-bootout-recovery.md) |

`usableCount` counts accounts that are enabled, active, un-throttled and under
`switchThreshold`, so `0` means every account is disabled, parked in `error`, or
over its quota threshold. The status endpoint is unauthenticated from localhost
and carries no credentials; account names are redacted unless the caller
presents the proxy api key plus `x-teamcodex-status-identity: 1`.

When the pool is reached through an SSH tunnel, run the same command
against the tunnel's **local** port. Find it first:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep 3457
```

Then substitute that port into the command above. If it answers at all, the
tunnel is alive and the tunnel is not your problem.

## Confirm with the authoritative usage endpoint

The proxy's view can be stale. It polls `GET /wham/usage` at startup, every
`warmupIntervalMs`, and after a forwarded request when the account's data is
older than `codexUsageActiveMs` (default 60 s). A downgraded or expired account
can hold a stale window until a poll succeeds, so confirm against the endpoint
directly.

The script below is read-only: it reads the config, calls `/wham/usage` once per
enabled account, and prints. It writes nothing and never prints a token.

```bash
python3 - <<'PY'
import json, os, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))
path = os.environ.get("TEAMCLAUDE_CONFIG") or os.path.join(
    os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"),
    "teamcodex.json")
cfg = json.load(open(path))

def when(window):
    ts = window.get("reset_at") or window.get("resets_at")
    if ts is None and window.get("reset_after_seconds") is not None:
        ts = datetime.now(timezone.utc).timestamp() + float(window["reset_after_seconds"])
    if ts is None:
        return "?"
    ts = float(ts)
    if ts > 1e12:            # milliseconds
        ts /= 1000.0
    return datetime.fromtimestamp(ts, KST).strftime("%m-%d %H:%M KST")

for a in cfg.get("accounts", []):
    if a.get("enabled") is False:
        print(f'{a.get("name","?"):24} disabled')
        continue
    req = urllib.request.Request(
        "https://chatgpt.com/backend-api/wham/usage",
        headers={"accept": "application/json",
                 "authorization": "Bearer " + (a.get("accessToken") or ""),
                 "chatgpt-account-id": a.get("accountId") or ""})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            body = json.load(r)
    except urllib.error.HTTPError as e:
        print(f'{a.get("name","?"):24} HTTP {e.code} (401/403 = token or subscription, not quota)')
        continue
    except Exception as e:
        print(f'{a.get("name","?"):24} unreachable: {e}')
        continue
    plan = a.get("planType") or "?"
    limit = body.get("rate_limit") or {}
    for key in ("primary_window", "secondary_window"):
        w = limit.get(key)
        if not isinstance(w, dict):
            continue
        minutes = w.get("window_minutes")
        if minutes is None and w.get("limit_window_seconds") is not None:
            minutes = float(w["limit_window_seconds"]) / 60
        print(f'{a.get("name","?"):24} plan={plan:10} window={str(minutes):>7}min '
              f'used={w.get("used_percent")}% resets={when(w)}')
PY
```

Real output from the production pool, names replaced with placeholders:

```text
account-a                plan=pro        window=10080.0min used=8% resets=09-12 15:12 KST
account-b                plan=pro        window=10080.0min used=100% resets=09-07 11:54 KST
account-c                plan=pro        window=10080.0min used=1% resets=09-12 20:00 KST
account-d                plan=pro        window=10080.0min used=100% resets=09-07 11:57 KST
account-e                disabled
account-f                disabled
account-g                plan=free       window=43200.0min used=0% resets=10-05 23:17 KST
account-h                plan=pro        window=10080.0min used=100% resets=09-07 18:42 KST
```

Two shape notes, so a difference is not misread as a broken script. The minutes
print as a float (`10080.0`) whenever upstream omits `window_minutes` and the
script derives it from `limit_window_seconds`. And upstream returned only
`primary_window` for every account in this run, so each account produced one
row; the loop prints a second row only when `secondary_window` is present.

During the 2026-09-04 incident every `10080`-minute row read `used=100%`.

How to read the windows:

| `window_minutes` | Meaning | Proxy models it? |
|---|---|---|
| `300` | 5-hour session window | Yes, as the 5h quota |
| `10080` | 7-day weekly window | Yes, as the 7d quota; this is the scarce resource |
| anything else (e.g. `43200`) | Not a window this proxy understands, and in practice the signature of a downgraded free plan | No, it is ignored |

An account reporting a `43200`-minute window is no longer a subscription
account. It occupies a pool slot and contributes no usable weekly capacity.

A `401` or `403` from this endpoint is never a quota verdict, but it is not
automatically a re-login verdict either. The script reads the token straight out
of the config, so a perfectly healthy account whose stored token simply lapsed
between refresh sweeps answers `401` too. Check that account's `expiresAt` in
the config first:

```bash
python3 - <<'PY'
import json, os
from datetime import datetime, timedelta, timezone
KST = timezone(timedelta(hours=9))
cfg = json.load(open(os.path.expanduser("~/.config/teamcodex.json")))
for a in cfg.get("accounts", []):
    ts = a.get("expiresAt")
    if not ts:
        print(f'{a.get("name","?"):24} no expiry recorded')
        continue
    ts = float(ts) / 1000.0 if float(ts) > 1e12 else float(ts)   # ms or s
    when = datetime.fromtimestamp(ts, KST)
    state = "LAPSED" if when < datetime.now(KST) else "valid"
    print(f'{a.get("name","?"):24} {state:7} {when:%m-%d %H:%M KST}')
PY
```

If `expiresAt` is in the past the token merely lapsed, and the guard's
`CRED_EXPIRED` axis covers it: only a refresh chain that stays broken across 2
consecutive checks warrants re-authentication. If the token is current and the
endpoint still refuses, it is a credential or subscription verdict, so take that
account to
[account reauthentication](../specs/2026-08-30-account-reauthentication.md)
instead of waiting for a reset.

## What the client sees

Two behaviours exist in the wild. Identify which artifact you are on before you
trust the message.

| | Before the fail-fast | After the fail-fast (rolled out 2026-09-05 16:05 KST) |
|---|---|---|
| Proxy behaviour | Polls `No eligible capacity — waiting 30000ms` until `continuityMaxWaitMs` (default 15 min), then answers 429 | Breaks out of the capacity loop as soon as the fleet's soonest known recovery is beyond the remaining continuity budget |
| Body | `{"type":"error","error":{"type":"rate_limit_error","message":"All N accounts exhausted. Retry in Xs."}}` | `{"error":{"type":"usage_limit_reached","message":"…","plan_type":"pro","resets_at":<unix seconds>}}` |
| Codex CLI renders | `exceeded retry limit, last status: 429 Too Many Requests`, after a 15-minute hang | `You've hit your usage limit … Try again at <local time>.`, in seconds |
| Operator cost | The message names nothing; the pool state has to be read out of band | The message names the cause and the reset time |

The Codex CLI only maps `error.type == "usage_limit_reached"` to its native
usage-limit error; `resets_at` is unix **seconds**. `plan_type` is omitted when
the pool's plan is unknown or is not a spelling the CLI recognises, which is
safer than guessing (an unparseable `plan_type` drops the CLI back to the opaque
message). The `retry-after` header is kept in both shapes.

Unchanged by the fail-fast: Anthropic mode, the concurrency-capped 429 (a busy
slot with healthy quota still answers `rate_limit_error`), the
all-accounts-auth-failed 401, legacy continuity mode
(`continuityMaxWaitMs: 0`), and model-fallback ordering.

To resolve which artifact is live, read the hash, not the branch name. Use
`GET`, not `HEAD`: the status fast path is gated on `req.method === 'GET'`, so a
`curl -I` falls through to the proxy path, is forwarded upstream, comes back
without the hash header, and burns a pooled upstream request doing it.

```bash
curl -s -D - -o /dev/null http://127.0.0.1:3457/teamclaude/status \
  | grep -i x-teamcodex-source-hash
```

Compare that hash against the deployment record in the
[deployment runbook](./teamcodex-runtime-deployment.md). The fail-fast first
shipped in artifact `adea84fd…` on 2026-09-05 16:05 KST; a hash absent from that
record has not been through the documented procedure and its behaviour is
unknown.

A single hash cannot stay a durable "has the fix" test, because every later
deploy produces a new one. To answer the question directly, read the artifact
launchd is actually running:

```bash
ART=$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' \
  ~/Library/LaunchAgents/com.qjc.teamcodex.plist)
grep -c usage_limit_reached "$(dirname "$ART")/server.js"
```

A non-zero count means the running artifact carries the fail-fast. `0` means it
predates it. The branch you have checked out is not evidence either way.

## Recovery options

The pool cannot manufacture quota. There are three real moves.

| Option | Action | Cost | Time to effect |
|---|---|---|---|
| Add or renew a subscription account | `teamcodex codex login` (browser flow), then `launchctl kickstart -k gui/501/com.qjc.teamcodex` so the daemon picks the account up | One more ChatGPT subscription, or reinstating a lapsed one | Minutes, bounded by the browser login and the restart |
| Disable a downgraded or cancelled account | `teamcodex codex disable <name>` | None. The account was contributing no usable capacity | Immediate for new requests; in-flight requests on it drain |
| Wait for the weekly reset | Nothing. Read the reset time from the script above | None, but the pool is down until then | Up to 7 days; ~60 h in the 2026-09-04 incident |

Notes:

- The same binary is `teamclaude codex <cmd>` when installed under that name.
  Config `provider: "codex"` or `TEAMCLAUDE_PROVIDER=codex` selects the pool
  (`~/.config/teamcodex.json`, port 3457).
- **Make sure the running server picked the account up.** The CLI asks the live
  server to reload and prints `Applied to the running server without restarting
  active connections.` when it worked. If it prints `The running server does not
  support account-only live reload.` instead, apply it yourself: `R` in the TUI,
  or a restart. The production daemon is headless, so it needs the restart path:
  `launchctl kickstart -k gui/$(id -u)/com.qjc.teamcodex`.
  If that fails with `Could not find service`, the service is missing from the
  launchd domain rather than merely holding old state, and the fix is
  `bootstrap` instead. See the
  [launchd bootout recovery runbook](./teamcodex-launchd-bootout-recovery.md).
- Disabling is the right move for an account that has been downgraded to free or
  whose subscription ended. It stops the account from occupying a slot and
  removes it from the alerting axes that only count enabled accounts. It does
  not free quota, so on its own it does not bring an exhausted pool back.
- Disabled accounts are still monitored. A forced fleet re-measure probes them
  read-only, which refreshes their dashboard row without re-enabling them.

## What does not help

| Action | Why it does not help |
|---|---|
| Restarting the proxy (`teamcodex codex restart`, `launchctl kickstart`) | Quota lives upstream, per ChatGPT account. A restart re-reads the same exhausted accounts. It is only required *after* you add an account. |
| Restarting or reviving the SSH tunnel | The tunnel carries the request to a proxy that answers. A 429 proves the path works end to end. |
| `launchctl bootout` / `bootstrap` of `com.qjc.teamcodex` | That repairs a service missing from the launchd domain. Here the service is up and answering; re-bootstrapping only adds an outage window. |
| Switching model | The 5h and 7d windows are per account, not per model. Every model on an exhausted account draws on the same window. |
| Waiting through the client's retries | With the old artifact the client burns the full continuity deadline and still gets nothing; with the new one it already knows the reset time. |

The first four were checked and ruled out during the 2026-09-04 incident. The
fifth is not a thing you do, it is what happens if you do nothing.

## Prevention

The proxy answers on its port long after its accounts stop being able to serve,
so a liveness probe stays green through a total pool outage. That is exactly how
this incident ran for two days unnoticed. Monitor account health instead, read
from `GET /teamclaude/status`:

- **Weekly pressure** is the early warning: the mean of `accounts[].quota.unified7d`
  across windows whose `unified7dReset` is still in the future. It fires while
  the pool still serves, which is the only window in which adding or renewing a
  subscription prevents an outage rather than ending one. Around 85% is a
  workable trip point.
- **Shrinking pool**: an enabled account with `subscription.state ==
  "cancellation-scheduled"`
  and an `endsAt` inside the next week loses its capacity on a known date.
- **Late warning**: `usableCount` at or below a small floor. By the time it
  fires, the outage is already scheduled; use it to page, not to plan.
- **Parked accounts**: `status == "error"` with an `errorReason` such as
  `subscription-ended`. The proxy cannot self-heal these.

Alert, do not automate. A re-login needs a browser and restarting the proxy kills
live sessions, so both are human decisions. Account names are redacted from the
status payload unless the caller sends the proxy API key together with
`x-teamcodex-status-identity: 1`, so a monitor that reports `?` for every account
is missing those headers, not looking at an empty pool.

A liveness monitor is still worth having for the failure it does cover: a service
missing from the launchd domain (see
[launchd bootout recovery](./teamcodex-launchd-bootout-recovery.md)). It is a
complement to account-health alerting, never a substitute. Throughout this
incident the server was up and had nothing to report.

## Incident record (2026-09-04 / 2026-09-05)

- **09-02 19:54 KST**: the proxy host starts emitting
  `exceeded retry limit, last status: 429 Too Many Requests`. It recurs 45
  times. No alert fires: the only monitor on port 3457 checked server
  liveness, not account health.
- **09-04**: every turn from the tunnelled second machine dies with the
  same line. Pool state: 8 accounts, `usableCount` `0/8`. Six Pro accounts at
  100% of the 10080-minute weekly window, one downgraded to free (a
  43200-minute window the proxy does not model), one with an ended
  subscription. Weekly resets roughly 60 hours out. The proxy log holds 98,727
  `No eligible capacity — waiting 30000ms` lines.
- **09-04**: restart, tunnel revive, launchd bootstrap and model switch are all
  tried and all verified irrelevant. Root cause is the pool, not the path.
- **09-04 / 09-05**: the usage-limit fail-fast is built: break out of the
  capacity loop when the soonest known recovery is past the continuity budget,
  and answer codex-mode quota dead ends with the CLI's native
  `usage_limit_reached` body. Evidence on the production lineage: 16 test files
  run sequentially, 342 pass / 0 fail; eslint clean; independent adversarial
  review APPROVE.
- **09-05 ~16:00 KST**: a first rollout attempt fails. The stock deployer
  bootstraps immediately after `bootout`, launchd is still tearing the old job
  down, and both the bootstrap and the rollback bootstrap fail, leaving no
  service running. The server guard detects the bootout and revives the service;
  the outage lasts about five minutes.
- **09-05 16:05 KST**: artifact
  `adea84fdb8e172074b011bd9e0aeaa3932c2442998e855514396993546db185b`, built from
  `prod/codex-usage-limit-fail-fast-20260905`, rolls out via the manual rollout
  path that waits for the launchd teardown. Verified afterwards by the live
  `x-teamcodex-source-hash` on the proxy host and through the tunnel, and by a
  real `codex exec` turn from the tunnelled machine completing (exit 0, 18 s).

Two lessons are wired back into the system: monitor account health, not just
server liveness (the guard's `WEEKLY_PRESSURE` and `SUB_ENDING` axes), and never
let a dead end reach the client as an unreadable 429 (the fail-fast).
