import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCmuxSessionRescuer,
  rescueCmuxSessionsOnce,
  resolveRecoveryWindowId,
} from '../src/cmux-session-rescue.js';
import {
  claimSessionOnce,
  inspectClaudeProcess,
  sameClaudeProcess,
} from '../src/cmux-session-guards.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const SURFACE_ID = '33333333-3333-4333-8333-333333333333';

function loginExpiredRecord(cwd) {
  return JSON.stringify({
    type: 'assistant',
    cwd,
    isApiErrorMessage: true,
    error: 'authentication_failed',
    message: 'Login expired · Please run /login',
  });
}

function connectionRefusedRecord(cwd) {
  return JSON.stringify({
    type: 'assistant',
    cwd,
    isApiErrorMessage: true,
    error: 'server_error',
    message: 'Unable to connect to API (ConnectionRefused)',
  });
}

function connectionResetRecord(cwd) {
  return JSON.stringify({
    type: 'assistant',
    cwd,
    isApiErrorMessage: true,
    error: 'server_error',
    message: 'Unable to connect to API (ConnectionReset)',
  });
}

function ambiguousDispatchRecord(cwd) {
  return JSON.stringify({
    type: 'assistant',
    cwd,
    isApiErrorMessage: true,
    error: 'server_error',
    apiErrorStatus: 502,
    message: 'API Error: 502 Upstream connection failed after dispatch. Request was not replayed. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (localhost:3456).',
  });
}

function assistantRecord(cwd) {
  return JSON.stringify({
    type: 'assistant',
    cwd,
    message: { role: 'assistant', content: 'recovered' },
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cmux-rescue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transcriptRoot = join(root, 'transcripts');
  const transcriptDir = join(transcriptRoot, 'project');
  const cwd = join(root, "project's workspace");
  const executablePath = join(root, 'claude');
  const transcriptPath = join(transcriptDir, `${SESSION_ID}.jsonl`);
  const storePath = join(root, 'claude-hook-sessions.json');
  await mkdir(transcriptDir, { recursive: true });
  await mkdir(cwd);
  await writeFile(executablePath, '#!/bin/sh\n', { mode: 0o755 });
  await writeFile(transcriptPath, `${loginExpiredRecord(cwd)}\n`);
  await chmod(transcriptPath, 0o600);
  const session = {
    sessionId: SESSION_ID,
    surfaceId: SURFACE_ID,
    workspaceId: '44444444-4444-4444-8444-444444444444',
    pid: 12345,
    startedAt: 1785420000,
    cwd,
    transcriptPath,
    isRestorable: true,
    launchCommand: {
      launcher: 'claude',
      executablePath,
      arguments: [],
      workingDirectory: cwd,
    },
  };
  const store = {
    version: 1,
    sessions: { [SESSION_ID]: session },
    activeSessionsBySurface: {
      [SURFACE_ID]: { sessionId: SESSION_ID, updatedAt: Date.now() / 1000 },
    },
  };
  await writeFile(storePath, JSON.stringify(store));
  await chmod(storePath, 0o600);
  return {
    root,
    transcriptRoot,
    transcriptPath,
    cwd,
    executablePath,
    storePath,
    session,
    store,
  };
}

function processInfo(fx, overrides = {}) {
  return {
    alive: true,
    cwd: fx.cwd,
    environmentValid: true,
    executablePath: fx.executablePath,
    launchArgv: [fx.executablePath, '--session-id', SESSION_ID],
    processIdentity: '12345:Mon Jul 30 23:00:00 2026',
    processStartedAt: fx.session.startedAt - 3,
    command: `${fx.executablePath} --session-id ${SESSION_ID}`,
    surfaceId: SURFACE_ID,
    supervised: false,
    ...overrides,
  };
}

test('adopts active unresolved Login expired session once', async t => {
  const fx = await fixture(t);
  const launched = [];
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    configPath: '/tmp/teamclaude config.json',
    inspectProcess: async () => processInfo(fx),
    launchRecoveryWorkspace: async request => {
      launched.push(request);
    },
  });

  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 1, failed: 0 });
  assert.equal(launched.length, 1);
  assert.equal(launched[0].workspaceId, fx.session.workspaceId);
  assert.equal(launched[0].surfaceId, fx.session.surfaceId);
  assert.equal(launched[0].cwd, fx.cwd);
  assert.equal(
    launched[0].command,
    `cd -- '${fx.cwd.replaceAll("'", "'\"'\"'")}' && TEAMCLAUDE_CONFIG='/tmp/teamclaude config.json' '/usr/local/bin/node' '/opt/teamclaude/src/index.js' run -- --resume '${SESSION_ID}' continue`,
  );
});

test('adopts an active unresolved ConnectionRefused session once', async t => {
  const fx = await fixture(t);
  await writeFile(fx.transcriptPath, `${connectionRefusedRecord(fx.cwd)}\n`);
  const launched = [];
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    configPath: '/tmp/teamclaude config.json',
    inspectProcess: async () => processInfo(fx),
    launchRecoveryWorkspace: async request => {
      launched.push(request);
    },
  });

  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 1, failed: 0 });
  assert.equal(launched.length, 1);
  assert.match(launched[0].command, new RegExp(`--resume '${SESSION_ID}' continue$`));
});

test('reopens an active unresolved ConnectionReset session without resending the last prompt', async t => {
  const fx = await fixture(t);
  await writeFile(fx.transcriptPath, `${connectionResetRecord(fx.cwd)}\n`);
  const launched = [];
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    configPath: '/tmp/teamclaude config.json',
    inspectProcess: async () => processInfo(fx),
    launchRecoveryWorkspace: async request => {
      launched.push(request);
    },
  });

  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 1, failed: 0 });
  assert.equal(launched.length, 1);
  assert.match(launched[0].command, new RegExp(`--resume '${SESSION_ID}'$`));
});

test('reopens an active unresolved ambiguous-dispatch 502 without resending the last prompt', async t => {
  const fx = await fixture(t);
  await writeFile(fx.transcriptPath, `${ambiguousDispatchRecord(fx.cwd)}\n`);
  const launched = [];
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    configPath: '/tmp/teamclaude config.json',
    inspectProcess: async () => processInfo(fx),
    launchRecoveryWorkspace: async request => {
      launched.push(request);
    },
  });

  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 1, failed: 0 });
  assert.equal(launched.length, 1);
  assert.match(launched[0].command, new RegExp(`--resume '${SESSION_ID}'$`));
});

test('resolves the recovery window from the verified live surface only', () => {
  const workspaceId = '44444444-4444-4444-8444-444444444444';
  const otherWorkspaceId = '55555555-5555-4555-8555-555555555555';
  const tree = {
    windows: [
      {
        id: 'window:1',
        workspaces: [{
          id: workspaceId,
          panes: [{ surfaces: [{ id: SURFACE_ID }] }],
        }],
      },
      {
        id: 'window:2',
        workspaces: [{
          id: otherWorkspaceId,
          panes: [{ surfaces: [{ id: OTHER_SESSION_ID }] }],
        }],
      },
    ],
  };

  assert.equal(
    resolveRecoveryWindowId(tree, { surfaceId: SURFACE_ID, workspaceId }),
    'window:1',
  );
  assert.equal(
    resolveRecoveryWindowId(tree, {
      surfaceId: SURFACE_ID,
      workspaceId: otherWorkspaceId,
    }),
    null,
  );
  tree.windows[1].workspaces[0].panes[0].surfaces[0].id = SURFACE_ID;
  assert.equal(
    resolveRecoveryWindowId(tree, { surfaceId: SURFACE_ID, workspaceId }),
    null,
  );
});

test('rejects stale, resolved, escaped, mismatched, or supervised cmux sessions', async t => {
  const cases = [
    {
      name: 'stale active mapping',
      mutate: async fx => {
        fx.store.activeSessionsBySurface[SURFACE_ID].sessionId = OTHER_SESSION_ID;
        await writeFile(fx.storePath, JSON.stringify(fx.store));
      },
    },
    {
      name: 'conversation continued after Login expired',
      mutate: fx => writeFile(
        fx.transcriptPath,
        `${loginExpiredRecord(fx.cwd)}\n${assistantRecord(fx.cwd)}\n`,
      ),
    },
    {
      name: 'conversation continued after ConnectionRefused',
      mutate: fx => writeFile(
        fx.transcriptPath,
        `${connectionRefusedRecord(fx.cwd)}\n${assistantRecord(fx.cwd)}\n`,
      ),
    },
    {
      name: 'transcript symlink escapes root',
      mutate: async fx => {
        const outside = join(fx.root, 'outside.jsonl');
        await writeFile(outside, `${loginExpiredRecord(fx.cwd)}\n`);
        await rm(fx.transcriptPath);
        await symlink(outside, fx.transcriptPath);
      },
    },
    {
      name: 'transcript symlink redirects within root',
      mutate: async fx => {
        const alternateDir = join(fx.transcriptRoot, 'alternate');
        const alternate = join(alternateDir, `${SESSION_ID}.jsonl`);
        await mkdir(alternateDir);
        await writeFile(alternate, `${loginExpiredRecord(fx.cwd)}\n`);
        await chmod(alternate, 0o600);
        await rm(fx.transcriptPath);
        await symlink(alternate, fx.transcriptPath);
      },
    },
    {
      name: 'store is readable outside the owner',
      mutate: fx => chmod(fx.storePath, 0o644),
    },
    {
      name: 'transcript is readable outside the owner',
      mutate: fx => chmod(fx.transcriptPath, 0o644),
    },
    {
      name: 'same-root transcript belongs to another session',
      mutate: async fx => {
        const otherTranscript = join(
          fx.transcriptRoot,
          'project',
          `${OTHER_SESSION_ID}.jsonl`,
        );
        await writeFile(otherTranscript, `${loginExpiredRecord(fx.cwd)}\n`);
        fx.session.transcriptPath = otherTranscript;
        await writeFile(fx.storePath, JSON.stringify(fx.store));
      },
    },
    {
      name: 'process belongs to another surface',
      inspect: fx => processInfo(fx, { surfaceId: OTHER_SESSION_ID }),
    },
    {
      name: 'process is already supervised',
      inspect: fx => processInfo(fx, { supervised: true }),
    },
    {
      name: 'process selector belongs to another session',
      inspect: fx => processInfo(fx, {
        command: `${fx.executablePath} --resume ${OTHER_SESSION_ID}`,
        launchArgv: [fx.executablePath, '--resume', OTHER_SESSION_ID],
      }),
    },
    {
      name: 'process started too long before the registry session',
      inspect: fx => processInfo(fx, {
        processStartedAt: fx.session.startedAt - 120,
      }),
    },
    {
      name: 'store and process point to an untrusted executable',
      mutate: async fx => {
        fx.otherExecutable = join(fx.root, 'other-claude');
        await writeFile(fx.otherExecutable, '#!/bin/sh\n', { mode: 0o755 });
        fx.session.launchCommand.executablePath = fx.otherExecutable;
        await writeFile(fx.storePath, JSON.stringify(fx.store));
      },
      inspect: fx => processInfo(fx, {
        executablePath: fx.otherExecutable,
        command: `${fx.otherExecutable} --session-id ${SESSION_ID}`,
      }),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async t => {
      const fx = await fixture(t);
      await scenario.mutate?.(fx);
      let launches = 0;
      await rescueCmuxSessionsOnce({
        storePath: fx.storePath,
        transcriptRoot: fx.transcriptRoot,
        nodePath: '/usr/local/bin/node',
        scriptPath: '/opt/teamclaude/src/index.js',
        trustedClaudePath: fx.executablePath,
        inspectProcess: async () => scenario.inspect?.(fx) || processInfo(fx),
        launchRecoveryWorkspace: async () => {
          launches += 1;
        },
      });
      assert.equal(launches, 0);
    });
  }
});

test('uses exact cmux launch argv and environment fields instead of rendered ps text', async t => {
  const fx = await fixture(t);
  const prompt = `CMUX_SURFACE_ID=${SURFACE_ID} --resume ${SESSION_ID}`;
  const args = ['-e', 'setInterval(() => {}, 60_000)', prompt];
  const child = spawn(process.execPath, args, {
    cwd: fx.cwd,
    env: {
      ...process.env,
      CMUX_SURFACE_ID: OTHER_SESSION_ID,
      CMUX_AGENT_LAUNCH_ARGV_B64: Buffer.from(
        [process.execPath, ...args].join('\0'),
      ).toString('base64'),
    },
    stdio: 'ignore',
  });
  await once(child, 'spawn');
  t.after(() => {
    child.kill('SIGTERM');
  });

  const info = await inspectClaudeProcess(child.pid);
  const session = {
    ...fx.session,
    pid: child.pid,
    startedAt: info.processStartedAt + 1,
    cwd: fx.cwd,
    launchCommand: {
      ...fx.session.launchCommand,
      executablePath: process.execPath,
    },
  };

  assert.equal(
    await sameClaudeProcess(session, info, process.execPath),
    false,
  );
});

test('syncs and identity-checks the recovery claim directory before returning', async t => {
  const fx = await fixture(t);
  const claimDir = `${fx.storePath}.recovery-claims`;
  const movedDir = `${claimDir}.moved`;
  let syncCalls = 0;

  await assert.rejects(
    claimSessionOnce(fx.storePath, SESSION_ID, {
      syncDirectory: async handle => {
        syncCalls += 1;
        await handle.sync();
        await rename(claimDir, movedDir);
        await mkdir(claimDir, { mode: 0o700 });
      },
    }),
    /identity changed/i,
  );
  assert.equal(syncCalls, 1);

  const movedClaim = await open(join(movedDir, SESSION_ID), 'r');
  await movedClaim.close();
});

test('coalesces concurrent rescue scans and never adopts the same process twice', async t => {
  const fx = await fixture(t);
  let launches = 0;
  const rescuer = createCmuxSessionRescuer({
    enabled: true,
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    inspectProcess: async () => processInfo(fx),
    launchRecoveryWorkspace: async () => {
      launches += 1;
    },
    log() {},
  });
  t.after(() => rescuer.stop());

  const [first, second] = await Promise.all([rescuer.scanNow(), rescuer.scanNow()]);
  const third = await rescuer.scanNow();

  assert.equal(first, second);
  assert.equal(first.rescued, 1);
  assert.equal(third.rescued, 0);
  assert.equal(launches, 1);
});

test('does not replay an ambiguous recovery workspace launch', async t => {
  const fx = await fixture(t);
  let launches = 0;
  const attempted = new Set();
  const options = {
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    attempted,
    inspectProcess: async () => processInfo(fx),
    launchRecoveryWorkspace: async () => {
      launches += 1;
      throw new Error('cmux unavailable');
    },
  };
  const first = await rescueCmuxSessionsOnce(options);
  const second = await rescueCmuxSessionsOnce(options);

  assert.equal(launches, 1);
  assert.deepEqual(first, { scanned: 1, candidates: 1, rescued: 0, failed: 1 });
  assert.deepEqual(second, { scanned: 1, candidates: 1, rescued: 0, failed: 0 });
});

test('does not replay a claimed session after the supervisor restarts', async t => {
  const fx = await fixture(t);
  let launches = 0;
  const options = {
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    inspectProcess: async () => processInfo(fx),
    launchRecoveryWorkspace: async () => {
      launches += 1;
    },
  };

  await rescueCmuxSessionsOnce({ ...options, attempted: new Set() });
  await rescueCmuxSessionsOnce({ ...options, attempted: new Set() });

  assert.equal(launches, 1);
});

test('does not resume the same session again after its PID changes', async t => {
  const fx = await fixture(t);
  let launches = 0;
  const attempted = new Set();
  const options = {
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    attempted,
    inspectProcess: async pid => processInfo(fx, {
      processIdentity: `${pid}:Mon Jul 30 23:00:00 2026`,
    }),
    launchRecoveryWorkspace: async () => {
      launches += 1;
      throw new Error('cmux result lost');
    },
  };

  await rescueCmuxSessionsOnce(options);
  fx.session.pid = 23456;
  await writeFile(fx.storePath, JSON.stringify(fx.store));
  await rescueCmuxSessionsOnce(options);

  assert.equal(launches, 1);
});

test('rejects process identity or active mapping changes before workspace launch', async t => {
  await t.test('process identity changed', async t => {
    const fx = await fixture(t);
    let inspections = 0;
    let launches = 0;
    await rescueCmuxSessionsOnce({
      storePath: fx.storePath,
      transcriptRoot: fx.transcriptRoot,
      nodePath: '/usr/local/bin/node',
      scriptPath: '/opt/teamclaude/src/index.js',
      inspectProcess: async () => processInfo(fx, {
        processIdentity: inspections++ === 0 ? '12345:first' : '12345:reused',
      }),
      launchRecoveryWorkspace: async () => {
        launches += 1;
      },
    });
    assert.equal(launches, 0);
  });

  await t.test('active surface mapping changed', async t => {
    const fx = await fixture(t);
    let reads = 0;
    let launches = 0;
    const changed = structuredClone(fx.store);
    changed.activeSessionsBySurface[SURFACE_ID].sessionId = OTHER_SESSION_ID;
    await rescueCmuxSessionsOnce({
      storePath: fx.storePath,
      transcriptRoot: fx.transcriptRoot,
      nodePath: '/usr/local/bin/node',
      scriptPath: '/opt/teamclaude/src/index.js',
      readStore: async () => (++reads >= 3 ? changed : fx.store),
      inspectProcess: async () => processInfo(fx),
      launchRecoveryWorkspace: async () => {
        launches += 1;
      },
    });
    assert.equal(launches, 0);
  });

  await t.test('workspace changed', async t => {
    const fx = await fixture(t);
    let reads = 0;
    let launches = 0;
    const changed = structuredClone(fx.store);
    changed.sessions[SESSION_ID].workspaceId = '55555555-5555-4555-8555-555555555555';
    await rescueCmuxSessionsOnce({
      storePath: fx.storePath,
      transcriptRoot: fx.transcriptRoot,
      nodePath: '/usr/local/bin/node',
      scriptPath: '/opt/teamclaude/src/index.js',
      readStore: async () => (++reads >= 3 ? changed : fx.store),
      inspectProcess: async () => processInfo(fx),
      launchRecoveryWorkspace: async () => {
        launches += 1;
      },
    });
    assert.equal(launches, 0);
  });
});
