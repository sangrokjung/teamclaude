# Transparent Claude Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make plain `claude` enter TeamClaude recovery automatically and keep the exact Claude session recoverable across usage-credit, timeout, and non-terminal auto-mode classifier failures.

**Architecture:** Add an idempotent installer for a canonical `~/.local/bin/claude` wrapper plus a `claude-vendor` shim that resolves the newest native Claude binary at each invocation. The wrapper invokes `teamcodex run` with that explicit shim path. Add a nested-supervision guard in the CLI, exact structured usage/timeout classifiers, UUID-confirmed account rotation, and bounded safety-classifier recovery.

**Tech Stack:** Node.js 18+ built-ins, ES modules, zsh wrapper, Node test runner.

---

## File map

- Create `src/claude-wrapper.js`: render, install, inspect, and uninstall the transparent wrapper and update-safe vendor shim without runtime dependencies.
- Modify `src/index.js`: expose `install-claude-wrapper`, `uninstall-claude-wrapper`, and reject nested supervised launch recursion.
- Create `test/claude-wrapper.test.js`: isolated-HOME installer, argv, vendor resolution, idempotency, backup, and rollback tests.
- Modify `test/run-env.test.js`: nested launcher recursion and explicit vendor regression tests.
- Modify `test/claude-recovery.test.js`: exact usage/timeout classification, UUID-confirmed rotation, and bounded auto-mode denial recovery.
- Modify `test/run-recovery.test.js`: exercise real launcher UUID rotation and safe continuation argv.
- Modify `src/config.js` and `config.example.json`: expose a separate bounded safety-denial recovery budget.
- Modify `README.md`, `README.ko.md`, and `docs/runbooks/ambiguous-dispatch-502.md`: plain `claude` is normal entry; direct `teamclaude run` is diagnostic only.
- Create `docs/runbooks/transparent-claude-recovery.md`: worker/main installation, legacy-session adoption, verification, and rollback.

### Task 1: Prevent recursive supervised launch

**Files:**
- Modify: `src/index.js:1824-1860`
- Test: `test/run-env.test.js`

- [ ] **Step 1: Write the failing nested-run test**

Add an isolated status server and execute `node src/index.js run` with
`TEAMCLAUDE_SESSION_SUPERVISED=1`. Assert status `75`, one clear error, and zero
vendor invocations.

```js
test('run rejects an inherited supervised marker before spawning Claude', async () => {
  const result = spawnSync(process.execPath, [entry, 'run'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TEAMCLAUDE_SESSION_SUPERVISED: '1',
      TEAMCLAUDE_CLAUDE_BIN: fakeClaude,
      TEAMCLAUDE_CONFIG: configPath,
    },
  });
  assert.equal(result.status, 75);
  assert.match(result.stderr, /nested supervised Claude launch/i);
  await assert.rejects(readFile(invocationLog, 'utf8'), { code: 'ENOENT' });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern='inherited supervised marker' test/run-env.test.js`

Expected: FAIL because current `runCommand()` accepts the marker and spawns Claude.

- [ ] **Step 3: Add the fail-closed guard**

At the start of `runCommand()` before proxy startup or child spawn:

```js
if (process.env.TEAMCLAUDE_SESSION_SUPERVISED === '1') {
  console.error('[TeamClaude] Refusing nested supervised Claude launch; set TEAMCLAUDE_CLAUDE_BIN to the native vendor binary in the outer wrapper.');
  process.exit(75);
}
```

The outer launcher sets this variable only in `childEnv`, after `runCommand()`
has entered, so normal first-level launches remain valid.

- [ ] **Step 4: Run the focused and existing signal/vendor tests**

Run:

```bash
node --test --test-name-pattern='inherited supervised marker|explicit vendor Claude|propagates SIGINT' test/run-env.test.js
```

Expected: all selected tests PASS; vendor spawn count remains one.

- [ ] **Step 5: Commit**

```bash
git add src/index.js test/run-env.test.js
git commit -m "fix: reject recursive Claude supervision"
```

### Task 2: Install a transparent, update-safe Claude wrapper

**Files:**
- Create: `src/claude-wrapper.js`
- Modify: `src/index.js:87-130`
- Create: `test/claude-wrapper.test.js`

- [ ] **Step 1: Write failing installer tests**

Use a temporary HOME with native binaries under
`.local/share/claude/versions/2.1.225` and `2.1.226`. Tests must assert:

```js
const result = await installClaudeWrapper({ home: root, teamcodexBin });
assert.equal(result.installed, true);
assert.match(await readFile(join(root, '.local/bin/claude'), 'utf8'), /TEAMCLAUDE_CLAUDE_BIN/);
assert.match(await readFile(join(root, '.local/bin/claude-vendor'), 'utf8'), /teamclaude-vendor-shim:v1/);
assert.equal((await stat(join(root, '.local/bin/claude')).mode & 0o777, 0o755);
```

Also execute the wrapper against a fake `teamcodex` and assert the captured argv
is `['run', '--', ...originalArgs]`, the vendor env points at `claude-vendor`, a
second install is idempotent, and uninstall atomically restores the original
`claude`. Add `2.1.227` after installation and execute `claude-vendor` again;
the new version must be selected without reinstalling the wrapper.

- [ ] **Step 2: Run installer tests and verify RED**

Run: `node --test test/claude-wrapper.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/claude-wrapper.js`.

- [ ] **Step 3: Implement native vendor discovery and wrapper rendering**

Create a zero-dependency module with explicit paths and atomic rename. The module
validates candidate versions during installation, but the installed vendor shim
must perform the same semantic-version selection on every invocation:

```js
export async function findNewestClaudeVendor(home) {
  const versionsDir = join(home, '.local', 'share', 'claude', 'versions');
  const entries = await readdir(versionsDir, { withFileTypes: true });
  const candidates = await Promise.all(entries
    .filter(entry => entry.isFile())
    .map(async entry => ({
      path: join(versionsDir, entry.name),
      version: entry.name.split('.').map(Number),
      info: await stat(join(versionsDir, entry.name)),
    })));
  return candidates
    .filter(candidate => candidate.info.mode & 0o111)
    .sort(compareSemanticVersionDescending)[0]?.path || null;
}
```

Render two zsh scripts with literal installer signatures, preserved argv, and no
fixed-port pre-probe. `claude-vendor` resolves the latest executable native
version dynamically and rejects its own realpath, non-executable targets, and
symlink loops before `exec`. The transparent wrapper points
`TEAMCLAUDE_CLAUDE_BIN` at that shim, never at itself or a pinned version:

```zsh
#!/bin/zsh
set -eu
# teamclaude-transparent-wrapper:v1
export TEAMCLAUDE_CLAUDE_BIN="/absolute/.local/bin/claude-vendor"
exec "/absolute/teamcodex" run -- "$@"
```

Install order: validate newest vendor and teamcodex executable; write both scripts
to same-directory temporary files with `0o755`; rename them into place. Never
overwrite an unknown regular file or symlink without first renaming it to a
timestamped backup. Uninstall only files bearing the exact signatures, remove
the managed vendor shim, and atomically restore the original `claude` backup.

- [ ] **Step 4: Expose install and uninstall commands**

Add command dispatch and help text:

```js
case 'install-claude-wrapper':
  await installClaudeWrapperCommand();
  break;
case 'uninstall-claude-wrapper':
  await uninstallClaudeWrapperCommand();
  break;
```

The command prints only installed paths and never credential or config values.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
node --test test/claude-wrapper.test.js test/run-env.test.js
npx eslint src/claude-wrapper.js src/index.js test/claude-wrapper.test.js test/run-env.test.js
```

Expected: all tests and ESLint PASS.

- [ ] **Step 6: Commit**

```bash
git add src/claude-wrapper.js src/index.js test/claude-wrapper.test.js
git commit -m "feat: install transparent Claude wrapper"
```

### Task 3: Pin exact and bounded recovery semantics

**Files:**
- Modify: `test/claude-recovery.test.js`
- Modify: `test/run-recovery.test.js`
- Modify: `src/claude-recovery.js:58-729`
- Modify: `src/index.js:1720-1790`
- Modify: `src/config.js`
- Modify: `config.example.json`

- [ ] **Step 1: Add the exact observed tool-denial fixture**

```js
function autoModeUnavailableRecord(cwd) {
  return JSON.stringify({
    type: 'user',
    cwd,
    message: { role: 'user', content: [{
      type: 'tool_result',
      is_error: true,
      content: 'claude-sonnet-5[1m] is temporarily unavailable, so auto mode cannot determine the safety of Bash right now.',
      tool_use_id: 'toolu_test',
    }] },
    toolDenialKind: 'automode-unavailable',
  });
}
```

- [ ] **Step 2: Add exact classifier and near-miss tests**

Usage-credit must require a structured API-error record and one of the observed
complete normalized messages. Timeout must require `error=server_error`, the
observed status when present, and the complete normalized timeout message. Add
ANSI/CRLF/whitespace positive fixtures plus prompt-injection, embedded phrase,
wrong type/status/error, and unknown-suffix negatives. No near-miss may trigger
rotation, resume, or handoff.

- [ ] **Step 3: Require account UUID change for usage recovery**

Record the UUID from `TEAMCLAUDE_RECOVERY_ACCOUNT` before rotation. A rotation is
successful only when `currentAccountUuid` is valid and differs from the previous
UUID. Name-only changes, missing UUIDs, malformed responses, exceptions, and the
same UUID must perform zero resume spawns. A real UUID change resumes the exact
session with `['--resume', sessionId, 'continue']` within the shared bounded retry
budget.

- [ ] **Step 4: Add non-terminal and bounded safety-denial tests**

First test writes the denial followed by normal assistant Read activity and exits
zero. Assert one spawn, no rotation, no Codex handoff, and no resume. Second test
writes denial then structured timeout and exits nonzero. Assert only timeout
recovery runs and the next argv is `['--resume', sessionId]`, without `continue`.

Add an unresolved terminal denial case. It may resume once with a constant safe
continuation that asks Claude to keep working read-only and retry the denied tool
only after the classifier recovers. It must never approve Bash, change permission
mode, rotate accounts, or replay the original tool input. Give this class its own
`claudeSafetyDenialMaxResumes` budget (default `1`, `0` disables it); persistent
denials stop after the budget while preserving the session/transcript.

- [ ] **Step 5: Run tests and preserve fail-safe behavior**

Run:

```bash
node --test --test-name-pattern='usage credit exact|timeout exact|auto mode unavailable|tool denial followed by timeout|UUID rotation' test/claude-recovery.test.js test/run-recovery.test.js
```

Expected: all selected tests PASS. Make only the minimum classifier, monitor,
rotation-verification, and bounded safety-continuation changes. Do not add account
rotation, Codex handoff, Bash permission changes, or generic `continue` for the
safety denial.

- [ ] **Step 6: Commit**

```bash
git add test/claude-recovery.test.js test/run-recovery.test.js src/claude-recovery.js src/index.js src/config.js config.example.json
git commit -m "test: pin auto-mode denial recovery boundary"
```

### Task 4: Document and deploy to worker

**Files:**
- Modify: `README.md`
- Modify: `README.ko.md`
- Modify: `docs/runbooks/ambiguous-dispatch-502.md`
- Create: `docs/runbooks/transparent-claude-recovery.md`

- [ ] **Step 1: Update user-facing entrypoint language**

Replace normal-operation instructions that require `teamclaude run` with:

```text
Run `teamcodex install-claude-wrapper` once. Thereafter use `claude` normally.
`teamclaude run` is a diagnostic bypass for inspecting the launcher itself;
`claude-vendor` is an emergency direct-vendor bypass with no recovery.
```

- [ ] **Step 2: Write the runbook**

Document exact commands for install, `whence -a claude`, parent-chain inspection,
status using the configured API key without printing it, legacy exact-session
resume, checksum comparison, and `uninstall-claude-wrapper` rollback.

- [ ] **Step 3: Install on the worker and verify real paths**

Run:

```bash
node src/index.js install-claude-wrapper
zsh -ic 'whence -v claude'
zsh -lc 'whence -v claude'
claude --version
claude-vendor --version
```

Expected: interactive and login shells resolve the signed wrapper; both version
commands report the same Claude version; the normal command passes through
TeamClaude without recursion.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md README.ko.md docs/runbooks/ambiguous-dispatch-502.md docs/runbooks/transparent-claude-recovery.md
git commit -m "docs: make Claude recovery transparent"
```

### Task 5: Full, adversarial, and main-PC verification

**Files:**
- Verify only; record evidence in `docs/runbooks/transparent-claude-recovery.md` if a durable operational note is needed.

- [ ] **Step 1: Run targeted and full gates**

Run:

```bash
node --test test/claude-wrapper.test.js test/run-env.test.js test/claude-recovery.test.js test/run-recovery.test.js test/server-529.test.js test/server-network-failover.test.js
npm test
npx eslint .
git diff --check
```

Expected: all tests PASS, ESLint PASS, diff check empty.

- [ ] **Step 2: Run adversarial oracles**

Verify wrapper recursion depth `<=1`, vendor spawn exactly once, unsafe upstream
POST hit exactly once, usage rotation changes account UUID, timeout sends no
prompt, safety denial changes no permissions, persistent failures remain within
their budgets, and near-miss transcript text produces no recovery.

- [ ] **Step 3: Deploy to main PC**

Use the authenticated remote channel when available:

```bash
teamcodex install-claude-wrapper
teamclaude restart
claude --version
```

Do not stop the TeamClaude supervisor from inside a supervised Claude session.
If remote execution authentication is unavailable, leave the verified installer
and exact one-command deployment as the only blocker; do not claim main deployment.

- [ ] **Step 4: Verify main-PC symptoms**

In an isolated exact session, inject synthetic usage-credit and timeout records.
Confirm account rotation or UI-only reopen respectively. Confirm the real
`automode-unavailable` tool denial remains in the same running session and Claude
continues read-only work without permission bypass.

- [ ] **Step 5: Final review**

Run independent code-quality and adversarial QA reviews. Resolve every
CRITICAL/HIGH finding, rerun affected gates, and report worker/main deployment
status separately with file paths and evidence.
