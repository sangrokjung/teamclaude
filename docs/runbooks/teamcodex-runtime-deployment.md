# TeamCodex runtime deployment runbook

## Summary

Production does **not** run this repo checkout. The launchd service
`com.qjc.teamcodex` executes a frozen, content-addressed artifact under
`~/.local/share/teamcodex-runtime/artifacts/<sha256>/`, staged by
`teamcodex_runtime_deployer.py` (`~/.local/bin`, machine-local). This runbook
documents the artifact format, how to identify the artifact that is running, the
normal automatic deploy path (Path A), the manual staging path used on
2026-09-01 (Path B), the manual rollout path used on 2026-09-05 (Path C), the
two known deployer defects, verification, and rollback.

## Which artifact is live

Merging a commit does not deploy it. Resolve what is running by hash, never by
branch name.

Use `GET`, not `HEAD`. The status fast path is gated on `req.method === 'GET'`,
so a `curl -I` falls through to the proxy path, is forwarded upstream, comes back
without the hash header, and burns a pooled upstream request doing it.

```bash
curl -s -D - -o /dev/null http://127.0.0.1:3457/teamclaude/status \
  | grep -i x-teamcodex-source-hash
```

To identify the source of that hash, reproduce it from a candidate commit: sort
`src/*.js` by filename, then sha256 the concatenation of `(filename\0content\0)`
for each file. That is `runtime_source_hash` in the deployer. On 2026-09-05 this
procedure identified commit `182cd3b` as the source of the then-live artifact.

Two corroborating reads, useful when the header is missing or you suspect the
plist and the running process disagree:

```bash
/usr/libexec/PlistBuddy -c 'Print :ProgramArguments' \
  ~/Library/LaunchAgents/com.qjc.teamcodex.plist
python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.codex/state/teamcodex-runtime-deployer.json")))["active_hash"])'
```

The plist's second program argument is the artifact's `src/index.js` path, so
its parent directory is the artifact's `src/` and the artifact tree is one level
above that. To ask a behavioural question about
the running build instead of a version question, grep that tree directly, for
example:

```bash
ART=$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' \
  ~/Library/LaunchAgents/com.qjc.teamcodex.plist)
grep -c usage_limit_reached "$(dirname "$ART")/server.js"
```

## Artifact format

- **Content-addressed hash**: sort `src/*.js` by filename, then sha256 the
  concatenation of `(filename\0content\0)` for each file
  (`runtime_source_hash` in the deployer).
- **Layout**: `<hash>/src/*.js` plus a `package.json` containing
  `{"name": "teamcodex", "type": "module"}`.
- **Read-only lock**: files `444`, directories `555`. The deployer validates
  ownership, rejects symlinks and non-regular files, and re-verifies the
  hash of the materialized tree before use.

## Known deployer defects (measured 2026-09-05)

Both defects live in `teamcodex_runtime_deployer.py`, so they affect Path A and
any Path B cycle that reuses the deployer's own `replace_launchd_job`. Path C
below corrects both.

| # | Defect | Symptom |
|---|---|---|
| 1 | **The drain fence is rejected.** The live runtime gates `POST`/`DELETE /teamclaude/deployment/drain` on the local lifecycle id **and** `x-api-key`. The deployer sends only the lifecycle id. | `HTTP 403` on the drain call, so the deploy proceeds without ever fencing admission |
| 2 | **`bootstrap` races the teardown.** `replace_launchd_job` issues `launchctl bootstrap` immediately after `bootout`. launchd is still tearing the old job down, so the bootstrap fails, and the rollback bootstrap fails the same way. | `target bootstrap failed and rollback was not healthy`, and **no service running** |

Defect 2 is the same "bootout-orphaned" class the launchd bootout runbook
covers. On 2026-09-05 it took the service down for about five minutes until the
cron server guard revived it. If you hit it mid-deploy, recover with
`launchctl bootstrap` per the
[launchd bootout recovery runbook](./teamcodex-launchd-bootout-recovery.md), then
redeploy through Path C rather than retrying the same path.

## Path A: automatic deploy (canonical)

`teamcodex_runtime_deployer.py` runs under launchd every 30s:

1. Computes the candidate hash from
   `SOURCE_ROOT=~/projects/teamclaude`.
2. If the candidate matches
   `~/.codex/state/teamcodex-runtime-approved.sha256` (the operator's
   approval token), it decides to restart, but only once the proxy is idle
   (`inflight == 0` for consecutive 30 s samples; an approved deploy sits in
   a wait state under traffic). The artifact is staged first, then the
   admission fence is applied (a drain when the live runtime exposes a
   lifecycle id, a SIGSTOP fence otherwise), then `bootout`/`bootstrap`,
   then verification of the new runtime.
3. On verification failure it rolls back to `rollback_hash` and records
   `failed_hash`. Re-issuing the same approval does NOT clear that block:
   the deployer must first observe the approval file absent/invalid while
   `failed_hash` matches the source (setting `failed_approval_removed`),
   and only a fresh approval after that removal re-enables the hash. To
   retry a failed hash: delete the approved-hash file, wait one 30 s
   deployer cycle, then write the approval again.
4. While the candidate does not match the approved hash, the deployer only
   logs `unapproved` and takes no action.

## Path B: manual staging (used 2026-09-01)

Use this when `SOURCE_ROOT` cannot be touched, e.g. the main checkout holds
another session's uncommitted work.

1. **Extract the commit to a temporary folder** with `git archive`:

   ```bash
   TMP=$(mktemp -d)
   git -C /path/to/repo archive <commit> | tar -x -C "$TMP"
   ```

2. **Reuse the deployer's own staging/validation/lock code** by importing it
   as a module and calling
   `materialize_approved_artifact(extracted_root, ARTIFACTS_DIR,
   runtime_source_hash(extracted_root))`.

   Python 3.14 caveat: register the module in `sys.modules` **before**
   executing it, or dataclass definitions inside the deployer fail:

   ```python
   import importlib.util, os, sys
   spec = importlib.util.spec_from_file_location(
       "dep", os.path.expanduser("~/.local/bin/teamcodex_runtime_deployer.py"))
   dep = importlib.util.module_from_spec(spec)
   sys.modules["dep"] = dep          # required on py3.14 before exec_module
   spec.loader.exec_module(dep)
   h = dep.runtime_source_hash(extracted_root)
   dep.materialize_approved_artifact(extracted_root, dep.ARTIFACTS_DIR, h)
   ```

3. **Repoint the plist.** Back it up first as
   `com.qjc.teamcodex.plist.pre-<hash8>-<date>`, then edit
   `ProgramArguments` (the `index.js` path) and `WorkingDirectory` to the
   new artifact directory, and validate with `plutil -lint`.

4. **Cycle the service.** This is defect 2 above, so do not chain the two
   commands: wait for the teardown to finish between them, and be prepared to
   retry the bootstrap.

   ```bash
   launchctl bootout gui/501/com.qjc.teamcodex
   until ! launchctl print gui/501/com.qjc.teamcodex >/dev/null 2>&1; do sleep 0.5; done
   launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.qjc.teamcodex.plist
   ```

   A bootstrap that still returns `rc=5` ("Input/output error") means launchd is
   not done; retry every couple of seconds (see the
   [launchd bootout recovery runbook](./teamcodex-launchd-bootout-recovery.md)).
   Until a bootstrap succeeds there is **no service running**, so do not walk
   away from this step. Path C automates exactly this wait-and-retry.

5. **Verification checklist**:
   - `launchctl list` shows a PID for the label.
   - `ps` shows the running argv pointing at the new artifact path.
   - `GET /teamclaude/status` returns 200 with the expected account count.
   - Usage polls succeed (per-account `quota.codexUsageAt` advances).
   - Real traffic flows (`inflight` / `lastUsed` move).
   - Error logs tail clean.

6. **State file updates, in this order**:
   - After the new runtime is stable, write the new hash to
     `~/.codex/state/teamcodex-runtime-approved.sha256`. When `SOURCE_ROOT`
     is later cleaned to that tree, the deployer converges it as current.
   - Update `~/.codex/state/teamcodex-runtime-last-good.sha256` **only after several hours of stability** on
     the new runtime, because it is the rollback destination and must keep
     pointing at a known-good version until then.

## Path C: manual rollout script (used 2026-09-05, preferred over Path B)

`scripts/teamcodex-manual-rollout.py` in this repo deploys an arbitrary commit,
which Path A cannot do because it only ever hashes `SOURCE_ROOT`.

It **imports the deployer's own** materialize, validate, plist, verify and
rollback functions, so artifact validation, hash verification and rollback
semantics are identical to Path A. It overrides only the two pieces from the
defect table: it sends `x-api-key` with the drain request, and it waits for the
launchd teardown before retrying `bootstrap`.

```bash
# 1. Stage a commit into a content-addressed artifact and print its hash.
/usr/bin/python3 scripts/teamcodex-manual-rollout.py stage <commit>

# 2. Roll that hash out: wait for idle, drain, back up and repoint the plist,
#    bootout, wait for the teardown, bootstrap with retries, verify, approve.
/usr/bin/python3 scripts/teamcodex-manual-rollout.py rollout <hash>
```

- Use `/usr/bin/python3`, the same interpreter the deployer runs under.
- Only deploy a tree that has passed its tests and an independent review.
- `stage` reuses an existing artifact when the hash already exists, so it is safe
  to re-run.
- `rollout` refuses to start unless the state file's pid is the launchd-managed
  pid and the live runtime entry verifies, and it aborts rather than guessing if
  the proxy never goes idle.
- On verification failure it returns to the previous artifact and exits non-zero.
  If the rollback itself is unhealthy it says so loudly; that is the one case
  that needs hands immediately.
- Run it detached (`nohup … &`) when the host is under memory pressure, so a
  supervisor cannot kill it mid-wait and leave the plist repointed.

Note the difference from Path B step 6: Path C writes the approved hash as soon
as its own verification passes, rather than holding it back for several hours of
observed stability. So run the Path B verification checklist yourself afterwards,
and if the new runtime misbehaves later, roll back by artifact path rather than
trusting `last-good` to still point at the previous version.

## Rollback

Restore the plist backup, then `bootout`/`bootstrap` the service, waiting for the
teardown between the two as in Path B step 4.

CAUTION: before rolling back, check
`~/.codex/state/teamcodex-runtime-approved.sha256` against the hash of
`SOURCE_ROOT`'s current `src/*.js`. The deployer's verdict comes from that
comparison, not from its state file: if `SOURCE_ROOT` still hashes to the
approved value, the 30 s deployer will decide `restart` and redeploy the
artifact you just rolled away from. In that case remove (or change) the
approved-hash file first, then restore the plist. When the hashes already
differ (the usual case with a dirty checkout), the state-file mismatch
(`~/.codex/state/teamcodex-runtime-deployer.json` `active_hash` pointing at
the old version) is harmless: the deployer logs `unapproved` and only
watches.

## Deployment record (2026-09-01)

- Commit `9fa69ad` (auto-detect + hardening) staged as artifact
  `b1b53d80e8ad5d898a30650f3a8d0e5d74d2cfe100350ec062f93383d68dd772`
  via Path B.
- Service started 15:46 KST.
- Verified live: 8 accounts, subscription ledger showing 4 entries,
  `inflight` observed at 10 under real traffic.

## Deployment record (2026-09-05)

- Branch `prod/codex-usage-limit-fail-fast-20260905` (commit `182cd3b` plus the
  usage-limit fail-fast) staged as artifact
  `adea84fdb8e172074b011bd9e0aeaa3932c2442998e855514396993546db185b`.
- Gate before rollout: 342/342 targeted tests, eslint clean, independent
  adversarial review APPROVE.
- **~16:00 KST, first attempt failed.** The stock deployer hit defect 2: the
  target bootstrap and the rollback bootstrap both failed and no service was
  left running. The cron server guard detected the bootout and revived the
  service; the outage lasted about five minutes.
- **16:05 KST, rolled out via Path C**, which waits for the launchd teardown.
- Verified afterwards by the live `x-teamcodex-source-hash` on the proxy host
  and through the SSH tunnel from a second machine, and by a real `codex exec`
  turn from that machine completing (exit 0, 18 s).
- This artifact is the first one carrying the usage-limit fail-fast.
- **18:46 KST, superseded** by artifact
  `6b538222f002b0f43efa799566085b20b09ae4424a5a012994ceab69de9a7425` (the same
  lineage plus reset-credit support), rolled out from a separate session. It
  carries the usage-limit fail-fast as well; confirm with the grep in
  [Which artifact is live](#which-artifact-is-live) rather than assuming.

**Append a record here for every rollout.** These records are the only place
that names a deployed hash, so a live `x-teamcodex-source-hash` that appears in
none of them simply has no record here yet, which is common when two sessions
deploy on the same day. Do not infer behaviour from the absence of a record:
grep the running tree as shown in
[Which artifact is live](#which-artifact-is-live), then append the record.
