# TeamCodex runtime deployment runbook

## Summary

Production does **not** run this repo checkout. The launchd service
`com.qjc.teamcodex` executes a frozen, content-addressed artifact under
`~/.local/share/teamcodex-runtime/artifacts/<sha256>/`, staged by
`teamcodex_runtime_deployer.py` (`~/.local/bin`, machine-local). This runbook
documents the artifact format, the normal automatic deploy path (Path A), the
manual staging path used on 2026-09-01 (Path B), verification, and rollback.

## Artifact format

- **Content-addressed hash**: sort `src/*.js` by filename, then sha256 the
  concatenation of `(filename\0content\0)` for each file
  (`runtime_source_hash` in the deployer).
- **Layout**: `<hash>/src/*.js` plus a `package.json` containing
  `{"name": "teamcodex", "type": "module"}`.
- **Read-only lock**: files `444`, directories `555`. The deployer validates
  ownership, rejects symlinks and non-regular files, and re-verifies the
  hash of the materialized tree before use.

## Path A: automatic deploy (canonical)

`teamcodex_runtime_deployer.py` runs under launchd every 30s:

1. Computes the candidate hash from
   `SOURCE_ROOT=/Users/sangrok/projects/teamclaude`.
2. If the candidate matches
   `~/.codex/state/teamcodex-runtime-approved.sha256` (the operator's
   approval token), it decides to restart: drain, stage the artifact,
   `bootout`/`bootstrap` the service, then verify the new runtime.
3. On verification failure it rolls back to `rollback_hash` and records
   `failed_hash`; that hash is refused for redeploy until approval is
   re-issued.
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
   import importlib.util, sys
   spec = importlib.util.spec_from_file_location(
       "dep", "/Users/sangrok/.local/bin/teamcodex_runtime_deployer.py")
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

4. **Cycle the service**:

   ```bash
   launchctl bootout gui/501/com.qjc.teamcodex
   launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.qjc.teamcodex.plist
   ```

   If the bootstrap returns `rc=5` ("Input/output error"), launchd is still
   tearing down; retry after a few seconds (see the
   [launchd bootout recovery runbook](./teamcodex-launchd-bootout-recovery.md)).

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

## Rollback

Restore the plist backup, then `bootout`/`bootstrap` the service. A mismatch
where the deployer state file
(`~/.codex/state/teamcodex-runtime-deployer.json`) `active_hash` still points
at the old version is harmless: the deployer treats the mismatch as
`unapproved` and only watches.

## Deployment record (2026-09-01)

- Commit `9fa69ad` (auto-detect + hardening) staged as artifact
  `b1b53d80e8ad5d898a30650f3a8d0e5d74d2cfe100350ec062f93383d68dd772`
  via Path B.
- Service started 15:46 KST.
- Verified live: 8 accounts, subscription ledger showing 4 entries,
  `inflight` observed at 10 under real traffic.
