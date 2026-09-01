# TeamCodex launchd bootout recovery runbook

## Summary

The production TeamCodex proxy runs as the launchd service `com.qjc.teamcodex`
on port 3457. If the service is booted **out of the launchd domain** (not
merely crashed), launchd's `KeepAlive` cannot restart it, the port-3457
listener disappears, every pooled account shows as offline, and Codex CLI
clients surface:

```text
Reconnecting... waiting for network
Connection failed: error sending request
```

Recovery is `launchctl bootstrap`, not `kickstart`: a booted-out service does
not exist in the domain, so `kickstart` fails every time with
`Could not find service`. Since 2026-09-01 the machine-local proxy guard
performs this bootstrap automatically as a fallback; this runbook covers
manual diagnosis and recovery, and the guard's remaining blind spot.

## Incident (2026-08-31 → 2026-09-01)

Timeline per the guard log (`~/.codex/log/teamcodex-proxy-guard.log`):

- **08-31 22:37–22:39**: first bootout signature: the guard observes the
  3457 listener missing and its `launchctl kickstart` fails with
  `Could not find service` (22:39). The actor that ran the bootout was never
  identified; worktree development sessions were running deploy/server-cycle
  work at the same time. From here on a **dev server intermittently occupied
  port 3457**, so the guard's listener probe flapped back to "healthy"
  (22:40, and repeatedly overnight) and the outage stayed hidden.
- **08-31 23:59 / 09-01 00:08–00:09 / 01:34**: further short
  `Could not find service` episodes, each masked again by the squatter
  within minutes.
- **09-01 morning (08:33 onward)**: the squatting dev process died for good;
  the outage became continuously visible (`start-failed` every minute, all
  accounts offline, Codex CLI reconnect loops).
- **09-01 ~11:50**: manual `launchctl bootstrap` restored the service (the
  guard's `start-failed` lines run through 11:49:32 and the first healthy
  probe is 11:50:32).

### Why three layers of protection all failed

1. **`teamcodex_proxy_guard.py`** (launchd, 60s interval) only attempted
   `launchctl kickstart`. A booted-out service is not in the domain, so the
   kickstart failed with `Could not find service` every minute: the guard
   detected the outage but could not repair it.
2. **`teamcodex_runtime_deployer.py`** only logged `unverified-runtime`. By
   design it takes no action outside an approved deployment.
3. **tunnel-reviver** owns only the tunnel port; port 3457 is out of scope.

## Diagnosis

Run in order:

1. Is anything listening on 3457, and is it *ours*?

   ```bash
   lsof -nP -iTCP:3457 -sTCP:LISTEN
   ```

2. Is the service registered in the launchd domain?

   ```bash
   launchctl print gui/501/com.qjc.teamcodex
   ```

   `Could not find service` means the service is booted out. This is the
   bootout state, not a crash loop.

3. Guard log signature: repeated `start-failed` lines mean the guard sees
   the outage but (pre-fallback) could not fix it:

   ```bash
   tail -50 ~/.codex/log/teamcodex-proxy-guard.log
   ```

4. For the deployer, check its **own log's mtime first**, because the traceback in
   the launchd `.err` file may be stale and mislead the investigation:

   ```bash
   ls -l ~/.codex/log/teamcodex-runtime-deployer.log
   tail -20 ~/.codex/log/teamcodex-runtime-deployer.log
   ```

## Recovery

```bash
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.qjc.teamcodex.plist
```

**Caution:** a bootstrap issued immediately after a bootout can fail with
`rc=5 "Input/output error"` because launchd is still tearing the service
down. Wait a few seconds and retry; the retry succeeds (measured 2026-09-01
15:45).

Then verify:

```bash
launchctl print gui/501/com.qjc.teamcodex   # registered, has a PID
lsof -nP -iTCP:3457 -sTCP:LISTEN            # listener owned by the service
curl -s http://127.0.0.1:3457/teamclaude/status | head -c 200
```

## Prevention (built 2026-09-01)

`teamcodex_proxy_guard.py` (`~/.local/bin`, a machine-local script outside
this repo) gained a **bootstrap fallback**:

- When `launchctl kickstart` fails with `rc=113` or a stderr containing
  `could not find service`, the guard runs
  `launchctl bootstrap gui/<uid> <plist>` itself.
- A bootstrap result of `rc=5` or an "already" stderr is treated as a
  **benign race** (another actor such as the deployer or the cron guard
  restored the service first) and logged as success.
- `TimeoutExpired` is caught on both the kickstart and the bootstrap.
- Env overrides for testing: `TEAMCODEX_GUARD_LABEL`,
  `TEAMCODEX_GUARD_PLIST`.
- Trigger condition: the listener must be absent for **3 consecutive
  samples** (60s period), and starts respect a **900s cooldown**.
- The successful repair logs the event `bootstrapped`.

## Residual limitation (backlog)

If a foreign process that answers a TeamClaude-shaped `/teamclaude/status`
squats on port 3457, the guard reads the port as healthy and the absence of
the real production service stays hidden; there is no identity check or
alert on the listener's owner (this is exactly what masked the 2026-08-31 → 09-01
outage overnight). The recovery chain is closed only for the case where the
squatter dies: if the service is registered, `KeepAlive` restarts it in
~3 s; if it is booted out, the guard fallback restores it in ~3–4 minutes.
