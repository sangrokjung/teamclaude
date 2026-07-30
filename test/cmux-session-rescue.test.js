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
    processIdentity: '12345:Mon Jul 30 23:00:00 2026',
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
  assert.equal(launched[0].cwd, fx.cwd);
  assert.equal(
    launched[0].command,
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
        inspectProcess: async () => scenario.inspect?.(fx) || processInfo(fx),
        launchRecoveryWorkspace: async () => {
          launches += 1;
        },
      });
      assert.equal(launches, 0);
    });
  }
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
