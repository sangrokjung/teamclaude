import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCmuxSessionRescuer,
  rescueCmuxSessionsOnce,
  resolveCmuxBinary,
  resolveRecoveryWindowId,
  stopExistingSessionProcess,
} from '../src/cmux-session-rescue.js';
import {
  claimSessionOnce,
  claimSessionLease,
  inspectClaudeProcess,
  inspectClaudeProcessTree,
  readPrivateJson,
  resolveCmuxSessionId,
  releaseSessionClaim,
  releaseSessionLease,
  sameClaudeProcess,
  unresolvedRecoverableApiErrorState,
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

function fleetExhaustedRecord(cwd, retryAfterSeconds, timestamp = new Date().toISOString()) {
  return JSON.stringify({
    type: 'assistant',
    cwd,
    timestamp,
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    error: 'rate_limit_error',
    message: {
      role: 'assistant',
      content: [{
        type: 'text',
        text: `API Error: Server is temporarily limiting requests (not your usage limit) · All 17 accounts exhausted. Retry in ${retryAfterSeconds}s.`,
      }],
    },
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
    pidStartSeconds: 1785419997,
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
    pid: fx.session.pid,
    cwd: fx.cwd,
    environmentValid: true,
    executablePath: fx.executablePath,
    launchArgv: [fx.executablePath, '--session-id', SESSION_ID],
    processIdentity: '12345:Mon Jul 30 23:00:00 2026',
    processStartedAt: fx.session.startedAt - 3,
    command: `${fx.executablePath} --session-id ${SESSION_ID}`,
    surfaceId: SURFACE_ID,
    agentLaunchKind: 'claude',
    supervised: false,
    ...overrides,
  };
}

function resolverProcessInfo(fx, overrides = {}) {
  return {
    ...processInfo(fx),
    cwd: fx.session.launchCommand.workingDirectory,
    command: '/opt/teamcodex/src/index.js run -- --resume named-session',
    launchCwd: fx.session.launchCommand.workingDirectory,
    launchArgv: [fx.session.launchCommand.executablePath],
    teamClaudeBin: '/usr/local/bin/claude-vendor',
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

test('resolves an ID-less Claude launch only from the matching owner session', async t => {
  const fx = await fixture(t);
  // Claude's live cwd can differ from the launcher cwd after an in-session
  // directory change; ownership is bound to launch cwd and process identity.
  fx.session.cwd = join(fx.root, 'session-current-cwd');
  await mkdir(fx.session.cwd);
  await writeFile(fx.storePath, JSON.stringify(fx.store));
  assert.equal(await resolveCmuxSessionId({
    storePath: fx.storePath,
    surfaceId: fx.session.surfaceId,
    pid: fx.session.pid,
    cwd: fx.session.launchCommand.workingDirectory,
    inspectProcess: async () => resolverProcessInfo(fx),
  }), SESSION_ID);
  assert.equal(await resolveCmuxSessionId({
    storePath: fx.storePath,
    surfaceId: fx.session.surfaceId,
    pid: fx.session.pid + 1,
    cwd: fx.session.cwd,
    inspectProcess: async () => ({ alive: false }),
  }), null);

  assert.equal(await resolveCmuxSessionId({
    storePath: fx.storePath,
    surfaceId: fx.session.surfaceId,
    pid: fx.session.pid,
    cwd: fx.session.launchCommand.workingDirectory,
    inspectProcess: async () => resolverProcessInfo(fx, {
      launchCwd: join(fx.root, 'other'),
    }),
  }), null);
  assert.equal(await resolveCmuxSessionId({
    storePath: fx.storePath,
    surfaceId: fx.session.surfaceId,
    pid: fx.session.pid,
    cwd: join(fx.root, 'other-caller'),
    inspectProcess: async () => resolverProcessInfo(fx),
  }), null);
  assert.equal(await resolveCmuxSessionId({
    storePath: fx.storePath,
    surfaceId: fx.session.surfaceId,
    pid: fx.session.pid,
    cwd: fx.session.launchCommand.workingDirectory,
    inspectProcess: async () => resolverProcessInfo(fx, {
      command: '/usr/bin/claude --resume named-session',
    }),
  }), null);
  assert.equal(await resolveCmuxSessionId({
    storePath: fx.storePath,
    surfaceId: fx.session.surfaceId,
    pid: fx.session.pid,
    cwd: fx.session.launchCommand.workingDirectory,
    inspectProcess: async () => resolverProcessInfo(fx, {
      launchArgv: ['/tmp/other-claude'],
    }),
  }), null);
  assert.equal(await resolveCmuxSessionId({
    storePath: fx.storePath,
    surfaceId: fx.session.surfaceId,
    pid: fx.session.pid,
    cwd: fx.session.cwd,
    inspectProcess: async () => resolverProcessInfo(fx, { surfaceId: OTHER_SESSION_ID }),
  }), null);
  assert.equal(await resolveCmuxSessionId({
    storePath: fx.storePath,
    surfaceId: fx.session.surfaceId,
    pid: fx.session.pid,
    cwd: join(fx.root, 'other'),
    inspectProcess: async () => resolverProcessInfo(fx),
  }), null);
  const withoutPidStart = structuredClone(fx.store);
  delete withoutPidStart.sessions[SESSION_ID].pidStartSeconds;
  await writeFile(fx.storePath, JSON.stringify(withoutPidStart));
  assert.equal(await resolveCmuxSessionId({
    storePath: fx.storePath,
    surfaceId: fx.session.surfaceId,
    pid: fx.session.pid,
    cwd: fx.session.cwd,
    inspectProcess: async () => resolverProcessInfo(fx),
  }), null);
});

test('resolves the recovery window before stopping the old process', async t => {
  const fx = await fixture(t);
  fx.session.pid = 999999;
  fx.store.sessions[SESSION_ID].pid = fx.session.pid;
  await writeFile(fx.storePath, JSON.stringify(fx.store));
  let stops = 0;
  let stopped = false;
  const launched = [];
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    inspectProcess: async () => (stopped ? { alive: false } : processInfo(fx, {
      pid: fx.session.pid,
      processRole: 'legacy-native',
      legacyEnvironmentValid: true,
      nativeExecutableTrusted: true,
      launchArgv: null,
      command: `${fx.executablePath} --resume ${SESSION_ID}`,
    })),
    resolveRecoveryWindow: async () => 'window:captured-before-stop',
    stopProcess: async () => {
      stops += 1;
      stopped = true;
      return true;
    },
    launchRecoveryWorkspace: async request => {
      launched.push(request);
    },
  });

  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 1, failed: 0 });
  assert.equal(stops, 1);
  assert.equal(launched[0].windowId, 'window:captured-before-stop');
});

test('does not stop a session when its recovery window cannot be resolved', async t => {
  const fx = await fixture(t);
  let stops = 0;
  let launches = 0;
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    inspectProcess: async () => processInfo(fx),
    resolveRecoveryWindow: async () => {
      throw new Error('surface disappeared');
    },
    stopProcess: async () => {
      stops += 1;
      return true;
    },
    launchRecoveryWorkspace: async () => {
      launches += 1;
    },
  });

  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 0, failed: 0 });
  assert.equal(stops, 0);
  assert.equal(launches, 0);
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

test('accepts a verified TeamClaude child when cmux stores the supervisor PID', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cmux-child-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  const wrapper = join(root, 'claude');
  const vendor = join(root, 'claude-vendor');
  const nativeDir = join(root, 'versions');
  const native = join(nativeDir, '2.1.289');
  await mkdir(nativeDir, { recursive: true });
  await mkdir(cwd);
  await Promise.all([
    writeFile(wrapper, '#!/bin/sh\n', { mode: 0o755 }),
    writeFile(vendor, '#!/bin/sh\n', { mode: 0o755 }),
    writeFile(native, '#!/bin/sh\n', { mode: 0o755 }),
  ]);
  const processStartedAt = Date.now() / 1000;
  const session = {
    sessionId: SESSION_ID,
    surfaceId: SURFACE_ID,
    pid: 54321,
    startedAt: processStartedAt + 1,
    cwd,
    launchCommand: { executablePath: wrapper },
  };
  const launcherCommand = {
    alive: true,
    command: `${process.execPath} /tmp/teamcodex/src/index.js run -- --session-id ${SESSION_ID}`,
    environmentValid: true,
    executablePath: process.execPath,
    cwd,
    launchArgv: [wrapper],
    processIdentity: '54321:Mon Jul 30 23:00:00 2026',
    surfaceId: SURFACE_ID,
    supervised: false,
    teamClaudeBin: vendor,
  };
  const info = {
    alive: true,
    command: `${native} --session-id ${SESSION_ID}`,
    cwd,
    environmentValid: true,
    executablePath: native,
    launchArgv: [native, '--session-id', SESSION_ID],
    processIdentity: '54322:Mon Jul 30 23:00:01 2026',
    processStartedAt,
    surfaceId: SURFACE_ID,
    supervised: true,
    processRole: 'teamclaude-child',
    nativeExecutableTrusted: true,
    parentPid: 54321,
    teamClaudeBin: vendor,
    launcherCommand,
    launcherProcessIdentity: launcherCommand.processIdentity,
  };

  assert.equal(await sameClaudeProcess(session, info, wrapper), true);
  assert.equal(await sameClaudeProcess(session, {
    ...info,
    command: native + ' -c',
    launchArgv: [native, '-c'],
  }, wrapper), true);
  assert.equal(
    await sameClaudeProcess(session, {
      ...info,
      teamClaudeBin: `${vendor}-other`,
    }, wrapper),
    false,
  );
});

test('accepts a legacy native Claude PID when the registry stores the child directly', async t => {
  const fx = await fixture(t);
  const native = join(fx.root, 'native-claude');
  await writeFile(native, '#!/bin/sh\n', { mode: 0o755 });
  fx.session.launchCommand.executablePath = native;
  const info = processInfo(fx, {
    processRole: 'legacy-native',
    environmentValid: false,
    legacyEnvironmentValid: true,
    executablePath: native,
    launchArgv: null,
    command: `${native} --settings '{}' --resume ${SESSION_ID}`,
    nativeExecutableTrusted: true,
  });
  assert.equal(await sameClaudeProcess(fx.session, info, fx.executablePath), true);
  const wrapperSession = {
    ...fx.session,
    launchCommand: { ...fx.session.launchCommand, executablePath: fx.executablePath },
  };
  assert.equal(
    await sameClaudeProcess(wrapperSession, {
      ...info,
      environmentValid: true,
      legacyEnvironmentValid: true,
      launchArgv: [fx.executablePath, '--permission-mode', 'bypassPermissions'],
    }, fx.executablePath),
    true,
  );
});

test('does not adopt a legacy native child that still has a TeamClaude supervisor', async () => {
  const supervisorPid = 54321;
  const childPid = 54322;
  const supervisor = {
    alive: true,
    command: '/tmp/teamcodex/src/index.js run -- --session-id ' + SESSION_ID,
    environmentValid: true,
    launchArgv: ['/tmp/teamclaude'],
    teamClaudeBin: '/tmp/teamclaude',
    supervised: false,
    surfaceId: SURFACE_ID,
  };
  const child = {
    alive: true,
    command: `/Users/example/.local/share/claude/versions/2.1.289 --resume ${SESSION_ID}`,
    legacyEnvironmentValid: true,
    nativeExecutableTrusted: true,
    supervised: false,
    surfaceId: SURFACE_ID,
    parentPid: supervisorPid,
    teamClaudeBin: '/tmp/teamclaude',
  };
  const result = await inspectClaudeProcessTree(childPid, SESSION_ID, {
    inspectProcess: async pid => pid === childPid ? child : supervisor,
  });
  assert.equal(result.alive, false);
});

function supervisorProcessInfo(pid) {
  return {
    alive: true,
    pid,
    command: '/tmp/teamcodex/src/index.js run -- --session-id ' + SESSION_ID,
    environmentValid: true,
    launchArgv: ['/tmp/teamclaude'],
    processIdentity: `${pid}:supervisor`,
    surfaceId: SURFACE_ID,
    supervised: false,
    teamClaudeBin: '/tmp/teamclaude',
  };
}

function selectorlessChildInfo(pid, parentPid, version = '2.1.289') {
  const executablePath = `/Users/example/.local/share/claude/versions/${version}`;
  return {
    alive: true,
    pid,
    command: `${executablePath} -c`,
    environmentValid: true,
    launchArgv: [executablePath, '-c'],
    processIdentity: `${pid}:child`,
    surfaceId: SURFACE_ID,
    supervised: true,
    agentLaunchKind: 'claude',
    nativeExecutableTrusted: true,
    parentPid,
    teamClaudeBin: '/tmp/teamclaude',
  };
}

test('fails closed when a supervisor has multiple selectorless Claude children', async () => {
  const supervisorPid = 54321;
  const childA = selectorlessChildInfo(54322, supervisorPid, '2.1.289');
  const childB = selectorlessChildInfo(54323, supervisorPid, '2.1.290');
  const processes = new Map([
    [supervisorPid, supervisorProcessInfo(supervisorPid)],
    [childA.pid, childA],
    [childB.pid, childB],
  ]);
  const result = await inspectClaudeProcessTree(supervisorPid, SESSION_ID, {
    inspectProcess: async pid => processes.get(pid) || { alive: false },
    listDirectChildren: async () => [
      { pid: childA.pid, command: childA.command },
      { pid: childB.pid, command: childB.command },
    ],
  });
  assert.equal(result.alive, false);
});

test('fails closed when the registry points at one of multiple selectorless Claude children', async () => {
  const supervisorPid = 54331;
  const childA = selectorlessChildInfo(54332, supervisorPid, '2.1.289');
  const childB = selectorlessChildInfo(54333, supervisorPid, '2.1.290');
  const processes = new Map([
    [supervisorPid, supervisorProcessInfo(supervisorPid)],
    [childA.pid, childA],
    [childB.pid, childB],
  ]);
  const result = await inspectClaudeProcessTree(childA.pid, SESSION_ID, {
    inspectProcess: async pid => processes.get(pid) || { alive: false },
    listDirectChildren: async () => [
      { pid: childA.pid, command: childA.command },
      { pid: childB.pid, command: childB.command },
    ],
  });
  assert.equal(result.alive, false);
});

test('stops a legacy native process without requiring a parent identity', async t => {
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  await once(child, 'spawn');
  t.after(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
  });
  const result = await stopExistingSessionProcess({
    pid: child.pid,
    processIdentity: 'legacy-process',
    surfaceId: SURFACE_ID,
  }, null, {
    inspectProcess: async pid => ({
      alive: pid === child.pid && child.exitCode == null && child.signalCode == null,
      pid,
      processIdentity: 'legacy-process',
    }),
  });
  assert.equal(result, true);
  if (child.exitCode == null && child.signalCode == null) await once(child, 'exit');
});

async function supervisedProcessFixture(t) {
  const parent = spawn(process.execPath, ['-e', [
    "const {spawn}=require('node:child_process');",
    "const child=spawn('/bin/sleep',['30']);",
    "console.log(child.pid);",
    "setInterval(()=>{},1000);",
  ].join('')], { stdio: ['ignore', 'pipe', 'ignore'] });
  await once(parent, 'spawn');
  const [line] = await once(parent.stdout, 'data');
  const childPid = Number(String(line).trim());
  assert.ok(Number.isInteger(childPid));
  t.after(() => {
    if (parent.exitCode == null && parent.signalCode == null) parent.kill('SIGKILL');
    try { process.kill(childPid, 'SIGKILL'); } catch {}
  });
  return { parent, childPid };
}

test('validates both supervisor and native child before stopping either process', async t => {
  const { parent, childPid } = await supervisedProcessFixture(t);
  const parentPid = parent.pid;
  const identities = new Map([[parentPid, 'supervisor-process'], [childPid, 'native-process']]);
  const inspectProcess = async pid => ({
    alive: (pid === parentPid ? parent.exitCode : null) == null
      && (pid === childPid ? true : pid === parentPid),
    pid,
    processIdentity: identities.get(pid),
    parentPid: pid === childPid ? parentPid : null,
    surfaceId: SURFACE_ID,
  });
  const result = await stopExistingSessionProcess({
    pid: childPid,
    processIdentity: 'native-process',
    parentPid,
    surfaceId: SURFACE_ID,
    launcherProcessIdentity: 'supervisor-process',
  }, parentPid, { inspectProcess });
  assert.equal(result, true);
  if (parent.exitCode == null && parent.signalCode == null) await once(parent, 'exit');
  assert.throws(() => process.kill(childPid, 0));
});

test('does not stop any process when supervisor identity validation fails', async t => {
  const { parent, childPid } = await supervisedProcessFixture(t);
  const parentPid = parent.pid;
  const result = await stopExistingSessionProcess({
    pid: childPid,
    processIdentity: 'native-process',
    parentPid,
    surfaceId: SURFACE_ID,
    launcherProcessIdentity: 'expected-supervisor',
  }, parentPid, {
    inspectProcess: async pid => ({
      alive: true,
      pid,
      processIdentity: pid === childPid ? 'native-process' : 'different-supervisor',
      parentPid: pid === childPid ? parentPid : null,
      surfaceId: SURFACE_ID,
    }),
  });
  assert.equal(result, false);
  assert.equal(parent.exitCode, null);
  assert.equal(childPid > 0, true);
});

test('does not rescue a fleet-exhausted transcript before its server retry deadline', async t => {
  const fx = await fixture(t);
  await writeFile(fx.transcriptPath, `${fleetExhaustedRecord(fx.cwd, 600)}\n`);
  let launches = 0;
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    inspectProcess: async () => processInfo(fx),
    launchRecoveryWorkspace: async () => { launches += 1; },
  });
  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 0, failed: 0 });
  assert.equal(launches, 0);
});

test('does not rescue a process that started after the fleet error', async t => {
  const fx = await fixture(t);
  const errorTimestamp = new Date(Date.now() - 5000).toISOString();
  await writeFile(fx.transcriptPath, `${fleetExhaustedRecord(fx.cwd, 1, errorTimestamp)}\n`);
  fx.session.startedAt = Date.now() / 1000 + 1;
  await writeFile(fx.storePath, JSON.stringify(fx.store));
  const processStartedAt = Date.now() / 1000;
  let stopped = false;
  let launches = 0;
  const info = processInfo(fx, {
    processRole: 'legacy-native',
    environmentValid: false,
    legacyEnvironmentValid: true,
    launchArgv: null,
    nativeExecutableTrusted: true,
    command: `${fx.executablePath} --resume ${SESSION_ID}`,
    processStartedAt,
  });
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    trustedClaudePath: fx.executablePath,
    inspectProcess: async () => (stopped ? { alive: false } : info),
    stopProcess: async () => {
      stopped = true;
      return true;
    },
    launchRecoveryWorkspace: async () => { launches += 1; },
  });
  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 0, failed: 0 });
  assert.equal(launches, 0);
});

test('runs the full legacy rescue path and passes the stop inspector through', async t => {
  const fx = await fixture(t);
  fx.session.pid = 999999;
  await writeFile(fx.storePath, JSON.stringify(fx.store));
  const errorAt = Date.now() - 5000;
  await writeFile(
    fx.transcriptPath,
    `${fleetExhaustedRecord(fx.cwd, 1, new Date(errorAt).toISOString())}\n`,
  );
  fx.session.startedAt = errorAt / 1000 + 1;
  await writeFile(fx.storePath, JSON.stringify(fx.store));
  let stopped = false;
  let stopOptions = null;
  let receivedStopInfo = null;
  let receivedParentPid = 'unset';
  let launches = 0;
  const info = processInfo(fx, {
    pid: fx.session.pid,
    processRole: 'legacy-native',
    environmentValid: false,
    legacyEnvironmentValid: true,
    launchArgv: null,
    nativeExecutableTrusted: true,
    command: `${fx.executablePath} --resume ${SESSION_ID}`,
    processStartedAt: fx.session.startedAt - 1.5,
  });
  const stopInspectProcess = async () => ({ alive: false });
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    trustedClaudePath: fx.executablePath,
    claimRecovery: async () => true,
    inspectProcess: async () => (stopped ? { alive: false } : info),
    stopInspectProcess,
    stopProcess: async (receivedInfo, parentPid, options) => {
      receivedStopInfo = receivedInfo;
      receivedParentPid = parentPid;
      stopOptions = options;
      stopped = true;
      return true;
    },
    launchRecoveryWorkspace: async () => { launches += 1; },
  });
  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 1, failed: 0 });
  assert.equal(launches, 1);
  assert.equal(receivedStopInfo.processRole, 'legacy-native');
  assert.equal(receivedParentPid, null);
  assert.equal(stopOptions.inspectProcess, stopInspectProcess);
});

test('passes the TeamClaude supervisor PID when rescuing its native child', async t => {
  const fx = await fixture(t);
  const native = join(fx.root, 'native-claude');
  await writeFile(native, '#!/bin/sh\n', { mode: 0o755 });
  const errorAt = Date.now() - 5000;
  fx.session.startedAt = errorAt / 1000 + 1;
  await writeFile(
    fx.transcriptPath,
    `${fleetExhaustedRecord(fx.cwd, 1, new Date(errorAt).toISOString())}\n`,
  );
  await writeFile(fx.storePath, JSON.stringify(fx.store));
  const supervisorPid = fx.session.pid;
  const childPid = supervisorPid + 1;
  const launcherCommand = {
    pid: supervisorPid,
    alive: true,
    command: `${process.execPath} /tmp/teamcodex/src/index.js run -- --session-id ${SESSION_ID}`,
    environmentValid: true,
    executablePath: process.execPath,
    cwd: fx.cwd,
    launchArgv: [fx.executablePath],
    processIdentity: `${supervisorPid}:supervisor`,
    surfaceId: SURFACE_ID,
    supervised: false,
    teamClaudeBin: fx.executablePath,
  };
  const childInfo = {
    ...processInfo(fx, {
      pid: childPid,
      processIdentity: `${childPid}:child`,
      processStartedAt: fx.session.startedAt - 1.5,
      executablePath: native,
      launchArgv: [native, '--session-id', SESSION_ID],
      command: `${native} --session-id ${SESSION_ID}`,
      supervised: true,
      processRole: 'teamclaude-child',
      nativeExecutableTrusted: true,
      parentPid: supervisorPid,
      teamClaudeBin: fx.executablePath,
      launcherCommand,
      launcherProcessIdentity: launcherCommand.processIdentity,
    }),
  };
  let stopped = false;
  let receivedParentPid = null;
  let launches = 0;
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    trustedClaudePath: fx.executablePath,
    inspectProcess: async () => (stopped ? { alive: false } : childInfo),
    stopProcess: async (info, parentPid) => {
      assert.equal(info.processRole, 'teamclaude-child');
      receivedParentPid = parentPid;
      stopped = true;
      return true;
    },
    launchRecoveryWorkspace: async () => { launches += 1; },
  });
  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 1, failed: 0 });
  assert.equal(receivedParentPid, supervisorPid);
  assert.equal(launches, 1);
});

test('accepts a recreated native child whose supervisor kept the session start time', async t => {
  const fx = await fixture(t);
  const native = join(fx.root, 'native-claude');
  await writeFile(native, '#!/bin/sh\n', { mode: 0o755 });
  const errorAt = Date.now() - 5000;
  fx.session.startedAt = errorAt / 1000 - 2 * 60 * 60;
  await writeFile(
    fx.transcriptPath,
    `${fleetExhaustedRecord(fx.cwd, 1, new Date(errorAt).toISOString())}\n`,
  );
  await writeFile(fx.storePath, JSON.stringify(fx.store));
  const supervisorPid = fx.session.pid;
  const launcherCommand = {
    pid: supervisorPid,
    alive: true,
    command: `${process.execPath} /tmp/teamcodex/src/index.js run -- --session-id ${SESSION_ID}`,
    environmentValid: true,
    executablePath: process.execPath,
    cwd: fx.cwd,
    launchArgv: [fx.executablePath],
    processIdentity: `${supervisorPid}:supervisor`,
    processStartedAt: fx.session.startedAt,
    surfaceId: SURFACE_ID,
    supervised: false,
    teamClaudeBin: fx.executablePath,
  };
  const childInfo = {
    ...processInfo(fx, {
      pid: supervisorPid + 1,
      processIdentity: `${supervisorPid + 1}:child`,
      processStartedAt: errorAt / 1000 - 1,
      executablePath: native,
      launchArgv: [native, '--session-id', SESSION_ID],
      command: `${native} --session-id ${SESSION_ID}`,
      supervised: true,
      processRole: 'teamclaude-child',
      nativeExecutableTrusted: true,
      parentPid: supervisorPid,
      teamClaudeBin: fx.executablePath,
      launcherCommand,
      launcherProcessIdentity: launcherCommand.processIdentity,
    }),
  };
  let stopped = false;
  let launches = 0;
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    trustedClaudePath: fx.executablePath,
    claimRecovery: async () => true,
    inspectProcess: async () => (stopped ? { alive: false } : childInfo),
    stopProcess: async () => {
      stopped = true;
      return true;
    },
    launchRecoveryWorkspace: async () => { launches += 1; },
  });
  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 1, failed: 0 });
  assert.equal(launches, 1);
});

test('does not rescue a TeamClaude child recreated after the fleet error', async t => {
  const fx = await fixture(t);
  const native = join(fx.root, 'native-claude');
  await writeFile(native, '#!/bin/sh\n', { mode: 0o755 });
  const errorAt = Date.now() - 5000;
  fx.session.startedAt = errorAt / 1000 - 2 * 60 * 60;
  await writeFile(
    fx.transcriptPath,
    `${fleetExhaustedRecord(fx.cwd, 1, new Date(errorAt).toISOString())}\n`,
  );
  await writeFile(fx.storePath, JSON.stringify(fx.store));
  const supervisorPid = fx.session.pid;
  const launcherCommand = {
    pid: supervisorPid,
    alive: true,
    command: `${process.execPath} /tmp/teamcodex/src/index.js run -- --session-id ${SESSION_ID}`,
    environmentValid: true,
    executablePath: process.execPath,
    cwd: fx.cwd,
    launchArgv: [fx.executablePath],
    processIdentity: `${supervisorPid}:supervisor`,
    processStartedAt: fx.session.startedAt,
    surfaceId: SURFACE_ID,
    supervised: false,
    teamClaudeBin: fx.executablePath,
  };
  const childInfo = {
    ...processInfo(fx, {
      pid: supervisorPid + 1,
      processIdentity: `${supervisorPid + 1}:child`,
      processStartedAt: errorAt / 1000 + 1,
      executablePath: native,
      launchArgv: [native, '--session-id', SESSION_ID],
      command: `${native} --session-id ${SESSION_ID}`,
      supervised: true,
      processRole: 'teamclaude-child',
      nativeExecutableTrusted: true,
      parentPid: supervisorPid,
      teamClaudeBin: fx.executablePath,
      launcherCommand,
      launcherProcessIdentity: launcherCommand.processIdentity,
    }),
  };
  let stops = 0;
  let launches = 0;
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    trustedClaudePath: fx.executablePath,
    inspectProcess: async () => childInfo,
    stopProcess: async () => { stops += 1; return true; },
    launchRecoveryWorkspace: async () => { launches += 1; },
  });
  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 0, failed: 0 });
  assert.equal(stops, 0);
  assert.equal(launches, 0);
});

test('rescues a fleet-exhausted session after its TeamClaude supervisor exits', async t => {
  const fx = await fixture(t);
  fx.session.pid = 999999;
  const errorAt = Date.now() - 5000;
  await writeFile(
    fx.transcriptPath,
    `${fleetExhaustedRecord(fx.cwd, 1, new Date(errorAt).toISOString())}\n`,
  );
  await writeFile(fx.storePath, JSON.stringify(fx.store));
  let launches = 0;
  let stops = 0;
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    inspectProcess: async () => ({ alive: false }),
    claimRecovery: async () => true,
    stopProcess: async () => { stops += 1; return true; },
    launchRecoveryWorkspace: async () => { launches += 1; },
  });
  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 1, failed: 0 });
  assert.equal(launches, 1);
  assert.equal(stops, 0);
});

test('fails closed when a fleet-exhausted transcript has no trustworthy timestamp', async t => {
  const fx = await fixture(t);
  const record = JSON.parse(fleetExhaustedRecord(fx.cwd, 1));
  delete record.timestamp;
  await writeFile(fx.transcriptPath, `${JSON.stringify(record)}\n`);
  let launches = 0;
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    inspectProcess: async () => processInfo(fx),
    launchRecoveryWorkspace: async () => { launches += 1; },
  });
  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 0, failed: 0 });
  assert.equal(launches, 0);
});

test('does not launch when a replacement process appears after the old process is stopped', async t => {
  const fx = await fixture(t);
  const supervisor = processInfo(fx, {
    command: '/tmp/teamcodex/src/index.js run -- --session-id 99999999-9999-4999-8999-999999999999',
    launchArgv: [fx.executablePath],
    teamClaudeBin: fx.executablePath,
  });
  const child = processInfo(fx, {
    pid: fx.session.pid + 1,
    processRole: 'teamclaude-child',
    supervised: true,
    nativeExecutableTrusted: true,
    launcherCommand: supervisor,
    launcherProcessIdentity: supervisor.processIdentity,
    parentPid: fx.session.pid,
    teamClaudeBin: fx.executablePath,
  });
  let launches = 0;
  let stops = 0;
  assert.equal(await sameClaudeProcess(fx.session, child), true);
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    inspectProcess: async () => child,
    claimRecovery: async () => true,
    stopProcess: async () => { stops += 1; return true; },
    launchRecoveryWorkspace: async () => { launches += 1; },
  });
  assert.equal(stops, 1);
  assert.equal(launches, 0);
  assert.equal(result.rescued, 0);
});

test('rechecks the stopped PID immediately before launching a recovery workspace', async t => {
  const fx = await fixture(t);
  const supervisor = processInfo(fx, {
    command: '/tmp/teamcodex/src/index.js run -- --session-id 99999999-9999-4999-8999-999999999999',
    launchArgv: [fx.executablePath],
    teamClaudeBin: fx.executablePath,
  });
  const child = processInfo(fx, {
    pid: fx.session.pid + 1,
    processRole: 'teamclaude-child',
    supervised: true,
    nativeExecutableTrusted: true,
    launcherCommand: supervisor,
    launcherProcessIdentity: supervisor.processIdentity,
    parentPid: fx.session.pid,
    teamClaudeBin: fx.executablePath,
  });
  const replacement = { ...child, processIdentity: '12346:replacement' };
  let inspections = 0;
  let launches = 0;
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    inspectProcess: async () => {
      inspections += 1;
      if (inspections <= 4) return child;
      if (inspections === 5) return { alive: false };
      return replacement;
    },
    claimRecovery: async () => true,
    stopProcess: async () => true,
    launchRecoveryWorkspace: async () => { launches += 1; },
  });
  assert.equal(launches, 0);
  assert.equal(result.rescued, 0);
});

test('does not launch when the stopped PID is reused by an unrelated process', async t => {
  const fx = await fixture(t);
  const unrelated = spawn('/bin/sleep', ['10'], { stdio: 'ignore' });
  t.after(() => unrelated.kill());
  await once(unrelated, 'spawn');
  fx.session.pid = unrelated.pid;
  fx.store.sessions[SESSION_ID].pid = unrelated.pid;
  await writeFile(fx.storePath, JSON.stringify(fx.store));
  const supervisor = processInfo(fx, {
    command: '/tmp/teamcodex/src/index.js run -- --session-id 99999999-9999-4999-8999-999999999999',
    launchArgv: [fx.executablePath],
    teamClaudeBin: fx.executablePath,
  });
  const child = processInfo(fx, {
    pid: unrelated.pid + 1,
    processRole: 'teamclaude-child',
    supervised: true,
    nativeExecutableTrusted: true,
    launcherCommand: supervisor,
    launcherProcessIdentity: supervisor.processIdentity,
    parentPid: unrelated.pid,
    teamClaudeBin: fx.executablePath,
  });
  let inspections = 0;
  let launches = 0;
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    inspectProcess: async () => {
      inspections += 1;
      return inspections <= 4 ? child : { alive: false };
    },
    claimRecovery: async () => true,
    stopProcess: async () => true,
    launchRecoveryWorkspace: async () => { launches += 1; },
  });
  assert.equal(launches, 0);
  assert.equal(result.rescued, 0);
});

test('rechecks the transcript after claiming before launching a recovery workspace', async t => {
  const fx = await fixture(t);
  await writeFile(fx.transcriptPath, `${fleetExhaustedRecord(fx.cwd, 1, new Date(Date.now() - 5000).toISOString())}\n`);
  let launches = 0;
  let claims = 0;
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    inspectProcess: async () => processInfo(fx),
    claimRecovery: async () => {
      claims += 1;
      await writeFile(fx.transcriptPath, `${fleetExhaustedRecord(fx.cwd, 1, new Date(Date.now() - 5000).toISOString())}\n${assistantRecord(fx.cwd)}\n`);
      return true;
    },
    launchRecoveryWorkspace: async () => { launches += 1; },
  });
  assert.equal(claims, 1);
  assert.equal(launches, 0);
  assert.equal(result.rescued, 0);
});

test('does not launch when the retry deadline moves forward after stopping', async t => {
  const fx = await fixture(t);
  fx.session.pid = 999999;
  await writeFile(fx.storePath, JSON.stringify(fx.store));
  await writeFile(fx.transcriptPath, `${fleetExhaustedRecord(fx.cwd, 1, new Date(Date.now() - 5000).toISOString())}\n`);
  let stopped = false;
  let launches = 0;
  const info = processInfo(fx, {
    pid: fx.session.pid,
    processRole: 'legacy-native',
    environmentValid: false,
    legacyEnvironmentValid: true,
    nativeExecutableTrusted: true,
    launchArgv: null,
    command: `${fx.executablePath} --resume ${SESSION_ID}`,
  });
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    inspectProcess: async () => (stopped ? { alive: false } : info),
    claimRecovery: async () => true,
    stopProcess: async () => {
      stopped = true;
      await writeFile(
        fx.transcriptPath,
        `${fleetExhaustedRecord(fx.cwd, 600, new Date().toISOString())}\n`,
      );
      return true;
    },
    launchRecoveryWorkspace: async () => { launches += 1; },
  });
  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 0, failed: 0 });
  assert.equal(launches, 0);
});

test('retries a stopped session after a transient deadline extension', async t => {
  const fx = await fixture(t);
  fx.session.pid = 999999;
  await writeFile(fx.storePath, JSON.stringify(fx.store));
  const expiredRecord = () => fleetExhaustedRecord(
    fx.cwd,
    1,
    new Date(Date.now() - 5000).toISOString(),
  );
  await writeFile(fx.transcriptPath, expiredRecord() + '\n');
  let stopped = false;
  let launches = 0;
  const attempted = new Set();
  const info = processInfo(fx, {
    pid: fx.session.pid,
    processRole: 'legacy-native',
    environmentValid: false,
    legacyEnvironmentValid: true,
    nativeExecutableTrusted: true,
    launchArgv: null,
    command: fx.executablePath + ' --resume ' + SESSION_ID,
  });
  const options = {
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    attempted,
    inspectProcess: async () => (stopped ? { alive: false } : info),
    stopProcess: async () => {
      stopped = true;
      await writeFile(
        fx.transcriptPath,
        fleetExhaustedRecord(fx.cwd, 600, new Date().toISOString()) + '\n',
      );
      return true;
    },
    launchRecoveryWorkspace: async () => { launches += 1; },
  };

  const first = await rescueCmuxSessionsOnce(options);
  assert.deepEqual(first, { scanned: 1, candidates: 1, rescued: 0, failed: 0 });
  assert.equal(launches, 0);
  assert.equal(attempted.has(SESSION_ID), false);

  await writeFile(fx.transcriptPath, expiredRecord() + '\n');
  const second = await rescueCmuxSessionsOnce(options);
  assert.deepEqual(second, { scanned: 1, candidates: 1, rescued: 1, failed: 0 });
  assert.equal(launches, 1);
});

test('launches from captured metadata when the stop hook removes the registry entry', async t => {
  const fx = await fixture(t);
  fx.session.pid = 999999;
  fx.store.sessions[SESSION_ID].pid = fx.session.pid;
  await writeFile(fx.storePath, JSON.stringify(fx.store));
  await writeFile(
    fx.transcriptPath,
    fleetExhaustedRecord(fx.cwd, 1, new Date(Date.now() - 5000).toISOString()) + '\n',
  );
  let stopped = false;
  let launches = 0;
  const info = processInfo(fx, {
    pid: fx.session.pid,
    processRole: 'legacy-native',
    environmentValid: false,
    legacyEnvironmentValid: true,
    nativeExecutableTrusted: true,
    launchArgv: null,
    command: fx.executablePath + ' --resume ' + SESSION_ID,
  });
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    readStore: async storePath => {
      if (stopped) throw new Error('registry removed by SessionEnd');
      return readPrivateJson(storePath);
    },
    inspectProcess: async () => (stopped ? { alive: false } : info),
    claimRecovery: async () => true,
    stopProcess: async () => {
      stopped = true;
      await writeFile(fx.storePath, JSON.stringify({
        version: 1,
        sessions: {},
        activeSessionsBySurface: {},
      }));
      return true;
    },
    launchRecoveryWorkspace: async () => { launches += 1; },
  });
  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 1, failed: 0 });
  assert.equal(launches, 1);
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

test('cleans a claim it created when publication fails before ownership returns', async t => {
  const fx = await fixture(t);
  const claimPath = join(`${fx.storePath}.recovery-claims`, SESSION_ID);
  let syncCalls = 0;

  await assert.rejects(
    claimSessionOnce(fx.storePath, SESSION_ID, {
      syncDirectory: async handle => {
        await handle.sync();
        syncCalls += 1;
        if (syncCalls === 1) throw new Error('claim publication failed');
      },
    }),
    /claim publication failed/,
  );
  await assert.rejects(readFile(claimPath), { code: 'ENOENT' });
  assert.equal(syncCalls, 2);
});

test('releases only the recovery claim inode it acquired', async t => {
  const fx = await fixture(t);
  const claimPath = join(`${fx.storePath}.recovery-claims`, SESSION_ID);
  const replacementPath = `${claimPath}.replacement`;
  const claim = await claimSessionOnce(fx.storePath, SESSION_ID);
  assert.equal(typeof claim.dev, 'number');
  assert.equal(typeof claim.ino, 'number');

  await rename(claimPath, replacementPath);
  await writeFile(claimPath, 'replacement\n', { mode: 0o600 });
  assert.equal(await releaseSessionClaim(fx.storePath, SESSION_ID, claim), false);
  const replacement = await open(claimPath, 'r');
  await replacement.close();
});

test('transient actor lease is separate from permanent replay claim', async t => {
  const fx = await fixture(t);
  const lease = await claimSessionLease(fx.storePath, SESSION_ID);
  assert.equal(typeof lease.dev, 'number');
  assert.equal(await claimSessionLease(fx.storePath, SESSION_ID), false);
  assert.equal(await releaseSessionLease(fx.storePath, SESSION_ID, lease), true);
  assert.equal(await releaseSessionLease(fx.storePath, SESSION_ID, lease), false);

  await claimSessionOnce(fx.storePath, SESSION_ID);
  const laterLease = await claimSessionLease(fx.storePath, SESSION_ID);
  assert.equal(typeof laterLease.dev, 'number');
  await releaseSessionLease(fx.storePath, SESSION_ID, laterLease);
});

test('retries an inconclusive rescuer lease release on the next scan', async t => {
  const fx = await fixture(t);
  const pendingLeases = new Map([[SESSION_ID, { dev: 7, ino: 9 }]]);
  let releaseCalls = 0;
  let launches = 0;
  const options = {
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    pendingLeases,
    releaseLease: async () => {
      releaseCalls += 1;
      return releaseCalls === 1 ? null : true;
    },
    inspectProcess: async () => processInfo(fx),
    claimLease: async () => ({ dev: 11, ino: 12 }),
    launchRecoveryWorkspace: async () => { launches += 1; },
  };

  const first = await rescueCmuxSessionsOnce(options);
  assert.equal(first.rescued, 0);
  assert.equal(launches, 0);
  assert.equal(pendingLeases.has(SESSION_ID), true);

  const second = await rescueCmuxSessionsOnce(options);
  assert.equal(second.rescued, 1);
  assert.equal(launches, 1);
  assert.equal(pendingLeases.has(SESSION_ID), false);
});

test('lease creation records the same process-start clock used for owner checks', async t => {
  const fx = await fixture(t);
  let inspections = 0;
  const inspectProcessStart = async () => {
    inspections += 1;
    return 123.5;
  };
  const lease = await claimSessionLease(fx.storePath, SESSION_ID, { inspectProcessStart });
  const owner = await readPrivateJson(
    join(`${fx.storePath}.recovery-leases`, SESSION_ID),
  );
  assert.equal(owner.processStartSeconds, 123.5);
  assert.equal(inspections, 1);
  await releaseSessionLease(fx.storePath, SESSION_ID, lease);
});

test('stale transient lease is reclaimed only after its owner is gone', async t => {
  const fx = await fixture(t);
  const leaseDir = `${fx.storePath}.recovery-leases`;
  await mkdir(leaseDir, { mode: 0o700 });
  await writeFile(
    join(leaseDir, SESSION_ID),
    JSON.stringify({ version: 1, pid: 99999999, processStartSeconds: 1, nonce: 'stale-owner' }),
    { mode: 0o600 },
  );

  const lease = await claimSessionLease(fx.storePath, SESSION_ID);
  assert.equal(typeof lease.dev, 'number');
  assert.equal(await releaseSessionLease(fx.storePath, SESSION_ID, lease), true);
});

test('a live lease owner is retained when process start inspection fails', async t => {
  const fx = await fixture(t);
  const leaseDir = `${fx.storePath}.recovery-leases`;
  await mkdir(leaseDir, { mode: 0o700 });
  await writeFile(
    join(leaseDir, SESSION_ID),
    JSON.stringify({ version: 1, pid: process.ppid, processStartSeconds: 1, nonce: 'live-owner' }),
    { mode: 0o600 },
  );

  const lease = await claimSessionLease(fx.storePath, SESSION_ID, {
    inspectProcessStart: async pid => (pid === process.pid ? 123 : null),
  });
  assert.equal(lease, false);
  const retained = await open(join(leaseDir, SESSION_ID), 'r');
  await retained.close();
});

test('concurrent stale lease reclaim has one winner and preserves the winner lease', async t => {
  const fx = await fixture(t);
  const leaseDir = `${fx.storePath}.recovery-leases`;
  await mkdir(leaseDir, { mode: 0o700 });
  await writeFile(
    join(leaseDir, SESSION_ID),
    JSON.stringify({ version: 1, pid: process.pid, processStartSeconds: 1, nonce: 'stale-owner' }),
    { mode: 0o600 },
  );

  const inspectProcessStart = async () => 123;
  const [first, second] = await Promise.all([
    claimSessionLease(fx.storePath, SESSION_ID, { inspectProcessStart }),
    claimSessionLease(fx.storePath, SESSION_ID, { inspectProcessStart }),
  ]);
  const winners = [first, second].filter(Boolean);
  assert.equal(winners.length, 1);
  assert.equal(
    await claimSessionLease(fx.storePath, SESSION_ID, { inspectProcessStart }),
    false,
  );
  assert.equal(await releaseSessionLease(fx.storePath, SESSION_ID, winners[0]), true);
});

test('a crashed reclaim claimant does not strand the transient lease', async t => {
  const fx = await fixture(t);
  const leaseDir = `${fx.storePath}.recovery-leases`;
  await mkdir(leaseDir, { mode: 0o700 });
  await writeFile(
    join(leaseDir, SESSION_ID),
    JSON.stringify({ version: 1, pid: 99999999, processStartSeconds: 1, nonce: 'stale-owner' }),
    { mode: 0o600 },
  );
  await writeFile(
    join(leaseDir, `${SESSION_ID}.reclaim-lock`),
    JSON.stringify({ version: 1, pid: 99999999, processStartSeconds: 1, nonce: 'stale-lock' }),
    { mode: 0o600 },
  );

  const lease = await claimSessionLease(fx.storePath, SESSION_ID);
  assert.equal(typeof lease.dev, 'number');
  assert.equal(await releaseSessionLease(fx.storePath, SESSION_ID, lease), true);
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

test('releases a permanent claim when a pre-launch verification throws', async t => {
  const fx = await fixture(t);
  const attempted = new Set();
  let claimReleases = 0;
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    attempted,
    inspectProcess: async () => processInfo(fx, {
      processRole: 'legacy-native',
      legacyEnvironmentValid: true,
      nativeExecutableTrusted: true,
      launchArgv: null,
      command: `${fx.executablePath} --resume ${SESSION_ID}`,
    }),
    claimLease: async () => ({ dev: 1, ino: 1 }),
    releaseLease: async () => true,
    claimRecovery: async () => ({ dev: 2, ino: 2 }),
    releaseRecovery: async () => {
      claimReleases += 1;
      return true;
    },
    stopProcess: async () => {
      throw new Error('transient pre-launch verification failure');
    },
    launchRecoveryWorkspace: async () => {
      throw new Error('launch must not be reached');
    },
  });

  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 0, failed: 1 });
  assert.equal(claimReleases, 1);
  assert.equal(attempted.has(SESSION_ID), false);
});

test('releases the permanent claim before the transient lease on retry', async t => {
  const fx = await fixture(t);
  const attempted = new Set();
  const order = [];
  let claimReleased = false;
  let leaseReleased = false;

  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    attempted,
    inspectProcess: async () => processInfo(fx, {
      processRole: 'legacy-native',
      legacyEnvironmentValid: true,
      nativeExecutableTrusted: true,
      launchArgv: null,
      command: `${fx.executablePath} --resume ${SESSION_ID}`,
    }),
    claimLease: async () => ({ dev: 1, ino: 1 }),
    releaseLease: async () => {
      order.push('lease');
      assert.equal(claimReleased, true);
      leaseReleased = true;
      return true;
    },
    claimRecovery: async () => ({ dev: 2, ino: 2 }),
    releaseRecovery: async () => {
      order.push('claim');
      assert.equal(leaseReleased, false);
      claimReleased = true;
      return true;
    },
    stopProcess: async () => {
      throw new Error('transient pre-launch verification failure');
    },
    launchRecoveryWorkspace: async () => {
      throw new Error('launch must not be reached');
    },
  });

  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 0, failed: 1 });
  assert.deepEqual(order, ['claim', 'lease']);
  assert.equal(attempted.has(SESSION_ID), false);
});

test('retries a failed permanent-claim release before releasing its lease', async t => {
  const fx = await fixture(t);
  const attempted = new Set();
  const pendingLeases = new Map();
  const pendingClaims = new Map();
  let claimReleases = 0;
  let leaseReleases = 0;
  let stopped = false;

  const options = {
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    attempted,
    pendingLeases,
    pendingClaims,
    inspectProcess: async () => processInfo(fx, {
      processRole: 'legacy-native',
      legacyEnvironmentValid: true,
      nativeExecutableTrusted: true,
      launchArgv: null,
      command: `${fx.executablePath} --resume ${SESSION_ID}`,
    }),
    claimLease: async () => ({ dev: 1, ino: 1, nonce: 'lease' }),
    releaseLease: async () => {
      leaseReleases += 1;
      assert.equal(claimReleases, 2);
      return true;
    },
    claimRecovery: async () => ({ dev: 2, ino: 2 }),
    releaseRecovery: async () => {
      claimReleases += 1;
      if (claimReleases === 1) throw new Error('temporary claim-store failure');
      return true;
    },
    stopProcess: async () => {
      if (!stopped) throw new Error('pre-launch verification failure');
      return true;
    },
    launchRecoveryWorkspace: async () => {},
  };

  const first = await rescueCmuxSessionsOnce(options);
  assert.deepEqual(first, { scanned: 1, candidates: 1, rescued: 0, failed: 1 });
  assert.equal(claimReleases, 1);
  assert.equal(leaseReleases, 0);
  assert.equal(pendingClaims.has(SESSION_ID), true);
  assert.equal(pendingLeases.has(SESSION_ID), true);

  await writeFile(fx.transcriptPath, `${loginExpiredRecord(fx.cwd)}\n${assistantRecord(fx.cwd)}\n`);
  stopped = true;
  const second = await rescueCmuxSessionsOnce(options);
  assert.deepEqual(second, { scanned: 1, candidates: 0, rescued: 0, failed: 0 });
  assert.equal(claimReleases, 2);
  assert.equal(leaseReleases, 1);
  assert.equal(pendingClaims.has(SESSION_ID), false);
  assert.equal(pendingLeases.has(SESSION_ID), false);
});

test('treats a definitive missing permanent claim as releasable before its lease', async t => {
  const fx = await fixture(t);
  const attempted = new Set();
  const pendingClaims = new Map();
  let leaseReleases = 0;

  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    attempted,
    pendingClaims,
    inspectProcess: async () => processInfo(fx, {
      processRole: 'legacy-native',
      legacyEnvironmentValid: true,
      nativeExecutableTrusted: true,
      launchArgv: null,
      command: `${fx.executablePath} --resume ${SESSION_ID}`,
    }),
    claimLease: async () => ({ dev: 1, ino: 1, nonce: 'lease' }),
    releaseLease: async () => {
      leaseReleases += 1;
      return true;
    },
    claimRecovery: async () => ({ dev: 2, ino: 2 }),
    releaseRecovery: async () => false,
    stopProcess: async () => {
      throw new Error('pre-launch verification failure');
    },
    launchRecoveryWorkspace: async () => {},
  });

  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 0, failed: 1 });
  assert.equal(leaseReleases, 1);
  assert.equal(pendingClaims.has(SESSION_ID), false);
  assert.equal(attempted.has(SESSION_ID), false);
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

// A fleet-exhaustion record without a usable timestamp must still yield a
// bounded retry deadline: the transcript's modification time stands in, so
// automatic recovery is never parked forever.
test('a fleet-exhaustion record without a timestamp falls back to the transcript mtime', async t => {
  const fx = await fixture(t);
  const record = JSON.parse(fleetExhaustedRecord(fx.cwd, 60));
  delete record.timestamp;
  await writeFile(fx.transcriptPath, `${JSON.stringify(record)}\n`);
  const past = new Date(Date.now() - 3600_000);
  await utimes(fx.transcriptPath, past, past);
  const state = await unresolvedRecoverableApiErrorState(fx.transcriptPath, fx.transcriptRoot, SESSION_ID);
  assert.equal(state.kind, 'fleet_exhausted');
  assert.ok(Number.isFinite(state.timestampMs), 'a deadline anchor exists');
  assert.ok(Math.abs(state.timestampMs - past.getTime()) < 2000, 'anchored at the transcript mtime');
  assert.equal(state.eventTimestampMs, null, 'the record itself carries no event timestamp');
});

test('malformed fleet-exhaustion timestamps fall back to the transcript mtime', async t => {
  const fx = await fixture(t);
  const past = new Date(Date.now() - 3600_000);
  for (const timestamp of [-1, 1791600000000.5, Number.MAX_VALUE, 0, 'not a date']) {
    const record = JSON.parse(fleetExhaustedRecord(fx.cwd, 60));
    record.timestamp = timestamp;
    await writeFile(fx.transcriptPath, `${JSON.stringify(record)}\n`);
    await utimes(fx.transcriptPath, past, past);
    const state = await unresolvedRecoverableApiErrorState(fx.transcriptPath, fx.transcriptRoot, SESSION_ID);
    assert.ok(Math.abs(state.timestampMs - past.getTime()) < 2000, `timestamp ${timestamp}`);
    assert.equal(state.eventTimestampMs, null, `no event timestamp for ${timestamp}`);
  }
});

test('the unresolved-error state exposes the record event identity', async t => {
  const fx = await fixture(t);
  const at = Date.now() - 5000;
  const record = JSON.parse(fleetExhaustedRecord(fx.cwd, 60, new Date(at).toISOString()));
  await writeFile(fx.transcriptPath, `${JSON.stringify({ ...record, uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })}\n`);
  let state = await unresolvedRecoverableApiErrorState(fx.transcriptPath, fx.transcriptRoot, SESSION_ID);
  assert.equal(state.eventTimestampMs, at);
  assert.equal(state.timestampMs, at);
  assert.equal(state.eventId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await writeFile(fx.transcriptPath, `${JSON.stringify({ ...record, uuid: 'not-a-uuid' })}\n`);
  state = await unresolvedRecoverableApiErrorState(fx.transcriptPath, fx.transcriptRoot, SESSION_ID);
  assert.equal(state.eventId, null, 'only a valid uuid identifies the event');
});

// The unresolved-error scan reads a bounded tail; an error record that straddles
// the start of that window must still be read whole, not dropped as a partial
// line (non-conversation records after it do not resolve it).
test('an error record straddling the tail window is still seen as unresolved', async t => {
  const fx = await fixture(t);
  const error = fleetExhaustedRecord(fx.cwd, 60);
  const filler = `${JSON.stringify({ type: 'system', subtype: 'note', content: 'x'.repeat(200) })}\n`;
  // Put the error record so it begins before the last 256 KiB and ends inside it.
  const fillerCount = Math.floor((256 * 1024 - Math.floor(error.length / 2)) / filler.length);
  await writeFile(fx.transcriptPath, `${error}\n${filler.repeat(fillerCount)}`);
  const state = await unresolvedRecoverableApiErrorState(fx.transcriptPath, fx.transcriptRoot, SESSION_ID);
  assert.equal(state?.kind, 'fleet_exhausted');
});

// The look-back is bounded: a final record far larger than the window is a
// conversation record, so an older error before it counts as resolved instead
// of the scan reading back through megabytes on every rescue pass.
test('a huge final record resolves an older error without unbounded look-back', async t => {
  const fx = await fixture(t);
  const huge = `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'z'.repeat(8 * 1024 * 1024) } })}\n`;
  await writeFile(fx.transcriptPath, `${fleetExhaustedRecord(fx.cwd, 60)}\n${huge}`);
  const started = Date.now();
  const state = await unresolvedRecoverableApiErrorState(fx.transcriptPath, fx.transcriptRoot, SESSION_ID);
  assert.equal(state, null, 'the error is resolved by the conversation record after it');
  assert.ok(Date.now() - started < 1000, 'bounded work');
});

// A claim covers one recoverable error event: the same event is never
// launched twice (even with a fresh in-memory attempt set, as after a
// supervisor restart), but a NEW fleet exhaustion in the same session is
// rescued again instead of being blocked forever by the first claim.
test('recovery claims are per error event: a later exhaustion of the same session is rescued again', async t => {
  const fx = await fixture(t);
  fx.session.pid = 999999;
  const firstErrorAt = Date.now() - 5000;
  fx.session.startedAt = firstErrorAt / 1000 + 1;
  await writeFile(fx.storePath, JSON.stringify(fx.store));
  await writeFile(fx.transcriptPath, `${fleetExhaustedRecord(fx.cwd, 1, new Date(firstErrorAt).toISOString())}\n`);
  let launches = 0;
  const run = () => rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    trustedClaudePath: fx.executablePath,
    inspectProcess: async () => ({ alive: false }),
    stopProcess: async () => true,
    launchRecoveryWorkspace: async () => { launches += 1; },
  });

  assert.equal((await run()).rescued, 1, 'first event rescued');
  assert.equal((await run()).rescued, 0, 'the same event is not launched twice');
  assert.equal(launches, 1);

  const secondErrorAt = Date.now() - 3000;
  await writeFile(fx.transcriptPath, `${fleetExhaustedRecord(fx.cwd, 1, new Date(secondErrorAt).toISOString())}\n`);
  assert.equal((await run()).rescued, 1, 'a new exhaustion event is rescued again');
  assert.equal(launches, 2);

  // Two distinct error records written in the same millisecond are still two
  // events: the record uuid tells them apart.
  const sameAt = new Date(Date.now() - 2000).toISOString();
  const withUuid = uuid => JSON.stringify({ ...JSON.parse(fleetExhaustedRecord(fx.cwd, 1, sameAt)), uuid });
  await writeFile(fx.transcriptPath, `${withUuid('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')}\n`);
  assert.equal((await run()).rescued, 1, 'first same-millisecond event');
  await writeFile(fx.transcriptPath, `${withUuid('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')}\n`);
  assert.equal((await run()).rescued, 1, 'second same-millisecond event with another uuid');
  assert.equal((await run()).rescued, 0, 'and that event is not launched twice');
  assert.equal(launches, 4);
});

// A permanent session-level claim (the Codex handoff written by the launcher,
// or a claim left by an earlier per-session rescuer) blocks every later event
// of that session: Codex owns it, so Claude must never be replayed.
test('a session-level handoff claim blocks rescuing any later error event', async t => {
  const fx = await fixture(t);
  fx.session.pid = 999999;
  const errorAt = Date.now() - 5000;
  fx.session.startedAt = errorAt / 1000 + 1;
  await writeFile(fx.storePath, JSON.stringify(fx.store));
  const record = JSON.parse(fleetExhaustedRecord(fx.cwd, 1, new Date(errorAt).toISOString()));
  await writeFile(fx.transcriptPath, `${JSON.stringify({ ...record, uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })}\n`);
  assert.ok(await claimSessionOnce(fx.storePath, SESSION_ID));
  let launches = 0;
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    trustedClaudePath: fx.executablePath,
    inspectProcess: async () => ({ alive: false }),
    stopProcess: async () => true,
    launchRecoveryWorkspace: async () => { launches += 1; },
  });
  assert.equal(result.rescued, 0);
  assert.equal(launches, 0);
});

// Every recheck stage must confirm the SAME error event: if the transcript
// moves on to another event while the rescue is being verified, this pass
// must not launch under the first event's claim.
test('a rescue whose error event changes during verification does not launch', async t => {
  const fx = await fixture(t);
  fx.session.pid = 999999;
  const firstAt = Date.now() - 5000;
  fx.session.startedAt = firstAt / 1000 + 1;
  await writeFile(fx.storePath, JSON.stringify(fx.store));
  await writeFile(fx.transcriptPath, `${fleetExhaustedRecord(fx.cwd, 1, new Date(firstAt).toISOString())}\n`);
  let reads = 0;
  let launches = 0;
  await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    trustedClaudePath: fx.executablePath,
    readStore: async path => {
      reads += 1;
      // The fourth read happens after the claim; a new error lands just then.
      if (reads === 4) {
        await writeFile(fx.transcriptPath, `${fleetExhaustedRecord(fx.cwd, 1, new Date(Date.now() - 4000).toISOString())}\n`);
      }
      return readPrivateJson(path);
    },
    inspectProcess: async () => ({ alive: false }),
    stopProcess: async () => true,
    launchRecoveryWorkspace: async () => { launches += 1; },
  });
  assert.ok(reads >= 4, 'the post-claim registry read happened');
  assert.equal(launches, 0);
});

test('event-keyed recovery claims accept only a uuid or positive millisecond event', async t => {
  const fx = await fixture(t);
  for (const key of [`${SESSION_ID}@1791600000000`, `${SESSION_ID}@aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`]) {
    const claim = await claimSessionOnce(fx.storePath, key);
    assert.ok(claim, key);
    assert.equal(await claimSessionOnce(fx.storePath, key), false, `${key} is claimed once`);
    assert.equal(await releaseSessionClaim(fx.storePath, key, claim), true);
  }
  for (const key of [`${SESSION_ID}@`, `${SESSION_ID}@0`, `${SESSION_ID}@-1`, `${SESSION_ID}@../x`, `not-a-session@1`]) {
    await assert.rejects(claimSessionOnce(fx.storePath, key), /Invalid recovery/, key);
  }
});

// A launch that provably ran nothing (e.g. cmux not installed yet) releases
// the claim and lease so the same event is retried once cmux is available; an
// ambiguous failure keeps the claim (covered by the no-replay tests).
test('a launch that ran nothing is retried on a later pass', async t => {
  const fx = await fixture(t);
  fx.session.pid = 999999;
  const errorAt = Date.now() - 5000;
  fx.session.startedAt = errorAt / 1000 + 1;
  await writeFile(fx.storePath, JSON.stringify(fx.store));
  await writeFile(fx.transcriptPath, `${fleetExhaustedRecord(fx.cwd, 1, new Date(errorAt).toISOString())}\n`);
  let attempts = 0;
  const attempted = new Set();
  const run = () => rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    trustedClaudePath: fx.executablePath,
    attempted,
    inspectProcess: async () => ({ alive: false }),
    stopProcess: async () => true,
    launchRecoveryWorkspace: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('Unable to resolve the cmux executable.');
        error.recoveryNotLaunched = true;
        throw error;
      }
    },
  });
  assert.deepEqual(await run(), { scanned: 1, candidates: 1, rescued: 0, failed: 1 });
  assert.deepEqual(await run(), { scanned: 1, candidates: 1, rescued: 1, failed: 0 });
  assert.equal(attempts, 2);
});

test('an ambiguous launch failure keeps the event claim', async t => {
  const fx = await fixture(t);
  fx.session.pid = 999999;
  const errorAt = Date.now() - 5000;
  fx.session.startedAt = errorAt / 1000 + 1;
  await writeFile(fx.storePath, JSON.stringify(fx.store));
  await writeFile(fx.transcriptPath, `${fleetExhaustedRecord(fx.cwd, 1, new Date(errorAt).toISOString())}\n`);
  let attempts = 0;
  const run = () => rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    trustedClaudePath: fx.executablePath,
    attempted: new Set(),
    inspectProcess: async () => ({ alive: false }),
    stopProcess: async () => true,
    launchRecoveryWorkspace: async () => {
      attempts += 1;
      const error = new Error('cmux timed out');
      error.code = 'ETIMEDOUT';
      throw error;
    },
  });
  assert.equal((await run()).failed, 1);
  assert.equal((await run()).failed, 0, 'the claimed event is not relaunched');
  assert.equal(attempts, 1);
});

test('a claim swapped in between the check and the removal is restored, not deleted', async t => {
  const fx = await fixture(t);
  const claimDir = `${fx.storePath}.recovery-claims`;
  const claimPath = join(claimDir, SESSION_ID);
  const claim = await claimSessionOnce(fx.storePath, SESSION_ID);
  const released = await releaseSessionClaim(fx.storePath, SESSION_ID, claim, {
    afterCheck: async () => {
      await rename(claimPath, `${claimPath}.old`);
      await writeFile(claimPath, 'another recovery\n', { mode: 0o600 });
    },
  });
  assert.equal(released, false);
  assert.equal(await readFile(claimPath, 'utf8'), 'another recovery\n', 'the other claim survives');
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual((await readdir(claimDir)).filter(name => name.includes('releasing')), [],
    'no detached claim is left behind');
});

// A legacy native process without launch-argv metadata is judged on its ps
// command alone; it must never throw out of the rescue loop.
test('legacy native process without launch argv is matched by command and never throws', async t => {
  const fx = await fixture(t);
  const native = join(fx.root, 'native-claude');
  await writeFile(native, '#!/bin/sh\n', { mode: 0o755 });
  fx.session.launchCommand.executablePath = native;
  const base = {
    processRole: 'legacy-native',
    environmentValid: false,
    legacyEnvironmentValid: true,
    executablePath: native,
    launchArgv: null,
    nativeExecutableTrusted: true,
  };
  for (const command of [
    `${native} --resume ${SESSION_ID}`,
    `${native} --session-id ${SESSION_ID}`,
    `${native} --settings '{}'`,
  ]) {
    assert.equal(await sameClaudeProcess(fx.session, processInfo(fx, { ...base, command }), fx.executablePath), true, command);
  }
  const other = '00000000-0000-4000-8000-000000000000';
  assert.equal(
    await sameClaudeProcess(fx.session, processInfo(fx, { ...base, command: `${native} --resume ${other}` }), fx.executablePath),
    false,
  );
});

// A fleet-exhausted session is parked and later relaunched with --resume, so
// its process can start hours or days after the registry entry. That window is
// only safe because identity is still pinned by the exact session selector,
// the surface, and the expected process identity.
test('a later relaunch is adopted only while selector, surface and identity still match', async t => {
  const fx = await fixture(t);
  const later = fx.session.startedAt + 3 * 24 * 60 * 60;
  const relaunched = processInfo(fx, { processStartedAt: later });
  assert.equal(await sameClaudeProcess(fx.session, relaunched, fx.executablePath), true, 'resumed days later');

  const other = '00000000-0000-4000-8000-000000000000';
  const wrongSelector = processInfo(fx, {
    processStartedAt: later,
    command: relaunched.command.replace(SESSION_ID, other),
    launchArgv: relaunched.launchArgv.map(a => a.replace(SESSION_ID, other)),
  });
  assert.equal(await sameClaudeProcess(fx.session, wrongSelector, fx.executablePath), false, 'another session');
  assert.equal(
    await sameClaudeProcess(fx.session, { ...relaunched, surfaceId: 'other-surface' }, fx.executablePath),
    false,
    'another surface',
  );
  assert.equal(
    await sameClaudeProcess(fx.session, relaunched, fx.executablePath, 'expected-identity-that-differs'),
    false,
    'a pinned process identity that differs',
  );
  assert.equal(
    await sameClaudeProcess(fx.session, processInfo(fx, { processStartedAt: fx.session.startedAt + 8 * 24 * 60 * 60 }), fx.executablePath),
    false,
    'beyond the 7-day window',
  );
});

// The supervisor is recognised by its run entry point wherever it is
// installed, not by one fixed package directory name.
test('supervisor detection follows the run entry point across install paths', async () => {
  const supervisorPid = 54321;
  const childPid = 54322;
  const child = {
    alive: true,
    command: `/Users/example/.local/share/claude/versions/2.1.289 --resume ${SESSION_ID}`,
    legacyEnvironmentValid: true,
    nativeExecutableTrusted: true,
    supervised: false,
    surfaceId: SURFACE_ID,
    parentPid: supervisorPid,
    teamClaudeBin: '/tmp/teamclaude',
  };
  const adopted = async command => (await inspectClaudeProcessTree(childPid, SESSION_ID, {
    inspectProcess: async pid => pid === childPid ? child : {
      alive: true,
      command,
      environmentValid: true,
      launchArgv: ['/tmp/teamclaude'],
      teamClaudeBin: '/tmp/teamclaude',
      supervised: false,
      surfaceId: SURFACE_ID,
    },
  })).alive;
  for (const command of [
    '/usr/bin/node /tmp/teamcodex/src/index.js run -- x',
    '/usr/bin/node /opt/teamclaude/src/index.js run -- x',
    '/usr/bin/node /srv/checkout/src/teamclaude.js run',
    '/opt/homebrew/bin/node /usr/local/lib/node_modules/@karpeleslab/teamclaude/src/index.js run',
  ]) {
    assert.equal(await adopted(command), false, `a supervised child is not a legacy native: ${command}`);
  }
  for (const command of [
    '/usr/bin/node /opt/teamclaude/src/index.js status',
    '/usr/bin/node /srv/other/index.js run',
    '/usr/bin/node /srv/checkout/src/index.jsx run',
  ]) {
    assert.equal(await adopted(command), true, `not a supervisor: ${command}`);
  }
});

test('a process whose cwd could not be read is never treated as the session process', async t => {
  const fx = await fixture(t);
  assert.equal(await sameClaudeProcess(fx.session, processInfo(fx, { cwd: null }), fx.executablePath), false);
});

// Only the kernel's view of the cwd counts. When lsof cannot report it, the
// PWD / launch-cwd values in the (caller-controlled) environment must not stand
// in, so the identity check fails closed.
test('process inspection never takes the cwd from the environment', async t => {
  const binDir = await mkdtemp(join(tmpdir(), 'teamclaude-no-lsof-'));
  t.after(() => rm(binDir, { recursive: true, force: true }));
  await symlink('/bin/ps', join(binDir, 'ps'));
  // A non-platform binary, so `ps eww` shows its (forged) environment.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    env: { PWD: '/Users/example/forged', CMUX_AGENT_LAUNCH_CWD: '/Users/example/forged' },
    stdio: 'ignore',
  });
  t.after(() => child.kill('SIGKILL'));
  await once(child, 'spawn');
  const originalPath = process.env.PATH;
  process.env.PATH = binDir;
  let info;
  try {
    info = await inspectClaudeProcess(child.pid);
  } finally {
    process.env.PATH = originalPath;
  }
  assert.equal(info.alive, true);
  assert.equal(info.cwd, null, 'no lsof: the cwd is unknown, not PWD');
});

// The ps fallback must consider every direct child of the supervisor, not
// only the first few: the session's child may sit anywhere in the table.
test('the ps fallback finds the session child beyond the first 64 direct children', async () => {
  const supervisorPid = 54401;
  const target = { ...selectorlessChildInfo(54401 + 70, supervisorPid) };
  target.command = `${target.command} --resume ${SESSION_ID}`;
  target.launchArgv = [...target.launchArgv, '--resume', SESSION_ID];
  const other = '00000000-0000-4000-8000-000000000000';
  const table = [];
  for (let i = 1; i < 70; i += 1) {
    table.push({ pid: supervisorPid + i, ppid: supervisorPid, command: `/usr/bin/sleep --resume ${other}` });
  }
  table.push({ pid: target.pid, ppid: supervisorPid, command: target.command });
  const result = await inspectClaudeProcessTree(supervisorPid, SESSION_ID, {
    inspectProcess: async pid => (pid === supervisorPid ? supervisorProcessInfo(supervisorPid)
      : pid === target.pid ? target : { alive: false }),
    listDirectChildren: async () => { throw new Error('ps -p argument list too long'); },
    listProcessTable: async () => table,
  });
  assert.equal(result.pid, target.pid);
});

// The ps fallback adopts only DIRECT children: a matching grandchild behind a
// shell or wrapper was not launched by this supervisor.
test('the ps fallback never adopts a grandchild of the supervisor', async () => {
  const supervisorPid = 54501;
  const wrapper = { pid: 54502, ppid: supervisorPid, command: '/bin/sh -c claude' };
  const grandchild = { ...selectorlessChildInfo(54503, wrapper.pid) };
  grandchild.command = `${grandchild.command} --resume ${SESSION_ID}`;
  grandchild.launchArgv = [...grandchild.launchArgv, '--resume', SESSION_ID];
  let inspectedGrandchild = false;
  const result = await inspectClaudeProcessTree(supervisorPid, SESSION_ID, {
    inspectProcess: async pid => {
      if (pid === supervisorPid) return supervisorProcessInfo(supervisorPid);
      if (pid === grandchild.pid) {
        inspectedGrandchild = true;
        return grandchild;
      }
      return { alive: false };
    },
    listDirectChildren: async () => { throw new Error('pgrep failed'); },
    listProcessTable: async () => [
      wrapper,
      { pid: grandchild.pid, ppid: wrapper.pid, command: grandchild.command },
    ],
  });
  assert.equal(result.alive, false);
  assert.equal(inspectedGrandchild, false);
});

// A selectorless child is only the session's process when it is the sole
// Claude child of the supervisor. A sibling that names ANOTHER session makes
// the selectorless one ambiguous, entered either from the supervisor or from
// the registry's child PID.
test('fails closed when a selectorless child has a sibling naming another session', async () => {
  const supervisorPid = 54341;
  const other = '00000000-0000-4000-8000-000000000000';
  const selectorless = selectorlessChildInfo(54342, supervisorPid, '2.1.289');
  const foreign = {
    ...selectorlessChildInfo(54343, supervisorPid, '2.1.290'),
    command: `${selectorlessChildInfo(54343, supervisorPid, '2.1.290').command} --resume ${other}`,
  };
  const processes = new Map([
    [supervisorPid, supervisorProcessInfo(supervisorPid)],
    [selectorless.pid, selectorless],
    [foreign.pid, foreign],
  ]);
  const options = {
    inspectProcess: async pid => processes.get(pid) || { alive: false },
    listDirectChildren: async () => [
      { pid: selectorless.pid, command: selectorless.command },
      { pid: foreign.pid, command: foreign.command },
    ],
  };
  for (const entryPid of [supervisorPid, selectorless.pid]) {
    const result = await inspectClaudeProcessTree(entryPid, SESSION_ID, options);
    assert.equal(result.alive, false, `entered from ${entryPid}`);
  }
  // Without the foreign sibling the selectorless child is still adopted.
  const alone = await inspectClaudeProcessTree(supervisorPid, SESSION_ID, {
    ...options,
    listDirectChildren: async () => [{ pid: selectorless.pid, command: selectorless.command }],
  });
  assert.equal(alone.pid, selectorless.pid);
});

// Between the identity check and the signal, a process may exit and its PID be
// reused. Each PID is re-verified right before SIGTERM, and a PID whose
// identity no longer matches is never signalled.
test('stop re-verifies each PID immediately before signalling it', async t => {
  const childPid = 70001;
  const parentPid = 70002;
  const info = {
    pid: childPid,
    processIdentity: 'child-identity',
    launcherProcessIdentity: 'parent-identity',
    surfaceId: SURFACE_ID,
  };
  let reused = false;
  const inspectProcess = async pid => {
    if (pid === parentPid) return { alive: true, processIdentity: 'parent-identity', surfaceId: SURFACE_ID };
    return reused
      ? { alive: true, processIdentity: 'unrelated-process', parentPid: 1 }
      : { alive: true, processIdentity: 'child-identity', parentPid };
  };
  const signalled = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    if (signal === 0 || signal === undefined) {
      const error = new Error('ESRCH');
      error.code = 'ESRCH';
      throw error;
    }
    signalled.push([pid, signal]);
    // Killing the launcher lets the child exit and its PID be reused.
    if (pid === parentPid) reused = true;
    return true;
  });

  await stopExistingSessionProcess(info, parentPid, { inspectProcess });
  assert.deepEqual(signalled, [[parentPid, 'SIGTERM']], 'the reused child PID was not signalled');
});

test('stop sends nothing when a PID changes identity or cannot be re-inspected before signalling', async t => {
  const childPid = 70011;
  const parentPid = 70012;
  const info = { pid: childPid, processIdentity: 'c', launcherProcessIdentity: 'p', surfaceId: SURFACE_ID };
  const signalled = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    if (signal === 0 || signal === undefined) {
      const error = new Error('ESRCH');
      error.code = 'ESRCH';
      throw error;
    }
    signalled.push([pid, signal]);
    return true;
  });
  for (const failure of ['reused', 'throws']) {
    signalled.length = 0;
    let checks = 0;
    const inspectProcess = async pid => {
      checks += 1;
      // The first two inspections are the initial verification of both PIDs.
      if (checks > 2) {
        if (failure === 'throws') throw new Error('ps failed');
        return { alive: true, processIdentity: 'other', parentPid: 1, surfaceId: SURFACE_ID };
      }
      return pid === parentPid
        ? { alive: true, processIdentity: 'p', surfaceId: SURFACE_ID }
        : { alive: true, processIdentity: 'c', parentPid };
    };
    await stopExistingSessionProcess(info, parentPid, { inspectProcess });
    assert.deepEqual(signalled, [], failure);
  }
});

test('cmux binary resolution never consults PATH and honours only an absolute override', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-cmux-bin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'cmux');
  await writeFile(bin, '#!/bin/sh\n', { mode: 0o755 });
  const plain = join(dir, 'not-executable');
  await writeFile(plain, '', { mode: 0o644 });

  assert.equal(await resolveCmuxBinary({ TEAMCLAUDE_CMUX_BIN: bin }), bin);
  await assert.rejects(resolveCmuxBinary({ TEAMCLAUDE_CMUX_BIN: 'cmux' }), /absolute/);
  await assert.rejects(resolveCmuxBinary({ TEAMCLAUDE_CMUX_BIN: plain }), /absolute path to an executable/);
  // A cmux on PATH alone is never picked up.
  const result = await resolveCmuxBinary({ PATH: dir }).catch(err => err);
  assert.notEqual(result, bin);
});

// 버전별 `claude` argv0 링크로 뜬 Claude 자식도 직접 자식 목록의 사전 필터에서
// selectorless Claude로 세어야 한다. 그래야 세션 지정 자식이 하나 있어도
// 지정 없는 Claude 자식이 둘 이상이면 모호한 것으로 보고 fail-closed 한다.
for (const [label, commandFor] of [
  ['native version path', version => `/Users/example/.local/share/claude/versions/${version} -c`],
  ['teamclaude argv0 link', version => `/Users/example/.local/share/teamclaude/claude-argv0/${version}/claude -c`],
]) {
  test(`direct-child prefilter counts selectorless Claude children launched via the ${label}`, async () => {
    const supervisorPid = 54341;
    const selected = {
      ...selectorlessChildInfo(54344, supervisorPid, '2.1.290'),
      command: `/Users/example/.local/share/teamclaude/claude-argv0/2.1.290/claude --resume ${SESSION_ID}`,
    };
    const processes = new Map([
      [supervisorPid, supervisorProcessInfo(supervisorPid)],
      [selected.pid, selected],
    ]);
    const result = await inspectClaudeProcessTree(supervisorPid, SESSION_ID, {
      inspectProcess: async pid => processes.get(pid) || { alive: false },
      listDirectChildren: async () => [
        { pid: 54342, ppid: supervisorPid, command: commandFor('2.1.289') },
        { pid: 54343, ppid: supervisorPid, command: commandFor('2.1.290') },
        { pid: selected.pid, ppid: supervisorPid, command: selected.command },
      ],
      listProcessTable: async () => [],
    });
    assert.equal(result.alive, false);
  });
}

test('direct-child prefilter still adopts the only Claude child launched via the argv0 link', async () => {
  const supervisorPid = 54351;
  const selected = {
    ...selectorlessChildInfo(54352, supervisorPid, '2.1.290'),
    command: `/Users/example/.local/share/teamclaude/claude-argv0/2.1.290/claude --resume ${SESSION_ID}`,
  };
  const processes = new Map([
    [supervisorPid, supervisorProcessInfo(supervisorPid)],
    [selected.pid, selected],
  ]);
  const result = await inspectClaudeProcessTree(supervisorPid, SESSION_ID, {
    inspectProcess: async pid => processes.get(pid) || { alive: false },
    listDirectChildren: async () => [{ pid: selected.pid, ppid: supervisorPid, command: selected.command }],
    listProcessTable: async () => [],
  });
  assert.equal(result.alive, true);
  assert.equal(result.pid, selected.pid);
});

// vendor 심은 실제로 `exec -a <버전별 claude 링크> <버전 실행 파일>`로 띄운다.
// ps 명령줄 첫 단어가 링크가 되므로, 신뢰 판정은 링크를 realpath로 풀어
// ~/.local/share/claude/versions/<버전>을 가리킬 때만 통과해야 한다.
test('inspectClaudeProcess trusts a native child whose argv0 is the vendor shim link', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-argv0-trust-'));
  const previousHome = process.env.HOME;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  const versionsDir = join(root, '.local', 'share', 'claude', 'versions');
  const linkDir = join(root, '.local', 'share', 'teamclaude', 'claude-argv0');
  await mkdir(versionsDir, { recursive: true });
  // 운영처럼 버전 경로 자체가 일반 실행 파일이어야 realpath가 versions 안에 머문다.
  const native = join(versionsDir, '2.1.290');
  await link(process.execPath, native).catch(() => copyFile(process.execPath, native));
  await chmod(native, 0o755);
  await mkdir(join(linkDir, '2.1.290'), { recursive: true });
  await mkdir(join(linkDir, '2.1.291'), { recursive: true });
  const goodLink = join(linkDir, '2.1.290', 'claude');
  const brokenLink = join(linkDir, '2.1.291', 'claude');
  await symlink(native, goodLink);
  await symlink(join(versionsDir, '2.1.291'), brokenLink);
  process.env.HOME = root;

  const launch = async argv0 => {
    const child = spawn('/bin/zsh', ['-c', 'exec -a "$1" "$2" -e "setInterval(() => {}, 1000)"', 'zsh', argv0, native], {
      stdio: 'ignore',
    });
    await once(child, 'spawn');
    t.after(() => child.kill('SIGKILL'));
    // exec가 끝나 ps에 새 argv0이 보일 때까지 기다린다.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const info = await inspectClaudeProcess(child.pid);
      if (info.executablePath === argv0) return info;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`argv0 never became ${argv0}`);
  };

  const trusted = await launch(goodLink);
  assert.equal(trusted.alive, true);
  assert.equal(trusted.nativeExecutableTrusted, true);

  const untrusted = await launch(brokenLink);
  assert.equal(untrusted.alive, true);
  assert.equal(untrusted.nativeExecutableTrusted, false);
});
