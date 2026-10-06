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
  stopExistingSessionProcess,
} from '../src/cmux-session-rescue.js';
import {
  claimSessionOnce,
  inspectClaudeProcess,
  inspectClaudeProcessTree,
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
    command: `/Users/sangrok/.local/share/claude/versions/2.1.289 --resume ${SESSION_ID}`,
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
