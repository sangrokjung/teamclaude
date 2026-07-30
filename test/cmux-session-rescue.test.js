import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCmuxSessionRescuer,
  rescueCmuxSessionsOnce,
} from '../src/cmux-session-rescue.js';

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
  const session = {
    sessionId: SESSION_ID,
    surfaceId: SURFACE_ID,
    workspaceId: '44444444-4444-4444-8444-444444444444',
    pid: 12345,
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
    executablePath: fx.executablePath,
    surfaceId: SURFACE_ID,
    supervised: false,
    ...overrides,
  };
}

test('adopts active unresolved Login expired session once', async t => {
  const fx = await fixture(t);
  const terminated = [];
  const sent = [];
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    configPath: '/tmp/teamclaude config.json',
    inspectProcess: async () => processInfo(fx),
    terminateProcess: async pid => {
      terminated.push(pid);
      return true;
    },
    sendResume: async request => {
      sent.push(request);
    },
  });

  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 1, failed: 0 });
  assert.deepEqual(terminated, [12345]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].surfaceId, SURFACE_ID);
  assert.equal(
    sent[0].command,
    `cd -- '${fx.cwd.replaceAll("'", "'\"'\"'")}' && TEAMCLAUDE_CONFIG='/tmp/teamclaude config.json' '/usr/local/bin/node' '/opt/teamclaude/src/index.js' run -- --resume '${SESSION_ID}' continue`,
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
      name: 'process belongs to another surface',
      inspect: fx => processInfo(fx, { surfaceId: OTHER_SESSION_ID }),
    },
    {
      name: 'process is already supervised',
      inspect: fx => processInfo(fx, { supervised: true }),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async t => {
      const fx = await fixture(t);
      await scenario.mutate?.(fx);
      let terminations = 0;
      let sends = 0;
      await rescueCmuxSessionsOnce({
        storePath: fx.storePath,
        transcriptRoot: fx.transcriptRoot,
        nodePath: '/usr/local/bin/node',
        scriptPath: '/opt/teamclaude/src/index.js',
        inspectProcess: async () => scenario.inspect?.(fx) || processInfo(fx),
        terminateProcess: async () => {
          terminations += 1;
          return true;
        },
        sendResume: async () => {
          sends += 1;
        },
      });
      assert.equal(terminations, 0);
      assert.equal(sends, 0);
    });
  }
});

test('coalesces concurrent rescue scans and never adopts the same process twice', async t => {
  const fx = await fixture(t);
  let terminations = 0;
  let sends = 0;
  const rescuer = createCmuxSessionRescuer({
    enabled: true,
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    inspectProcess: async () => processInfo(fx),
    terminateProcess: async () => {
      terminations += 1;
      return true;
    },
    sendResume: async () => {
      sends += 1;
    },
    log() {},
  });
  t.after(() => rescuer.stop());

  const [first, second] = await Promise.all([rescuer.scanNow(), rescuer.scanNow()]);
  const third = await rescuer.scanNow();

  assert.equal(first, second);
  assert.equal(first.rescued, 1);
  assert.equal(third.rescued, 0);
  assert.equal(terminations, 1);
  assert.equal(sends, 1);
});

test('bounds cmux relaunch retries after the blocked process exits', async t => {
  const fx = await fixture(t);
  let sends = 0;
  const result = await rescueCmuxSessionsOnce({
    storePath: fx.storePath,
    transcriptRoot: fx.transcriptRoot,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/teamclaude/src/index.js',
    inspectProcess: async () => processInfo(fx),
    terminateProcess: async () => true,
    sendResume: async () => {
      sends += 1;
      throw new Error('cmux unavailable');
    },
  });

  assert.equal(sends, 3);
  assert.deepEqual(result, { scanned: 1, candidates: 1, rescued: 0, failed: 1 });
});
