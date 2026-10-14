import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, makeRepo } from './helpers/git-fixture.js';
import { runClaudeWithRecovery } from '../src/claude-recovery.js';
import { GIT_SHA, JWT, OPAQUE } from './helpers/secret-fixtures.js';

function fakeChild(onKill = null) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = signal => {
    onKill?.(signal);
    if (child.exitCode == null && child.signalCode == null) {
      child.signalCode = signal;
      Promise.resolve().then(() => child.emit('exit', null, signal));
    }
    return true;
  };
  child.finish = (code = 0) => {
    if (child.exitCode != null || child.signalCode != null) return;
    child.exitCode = code;
    child.emit('exit', code, null);
  };
  return child;
}

function fleetExhaustedRecord(cwd, retryAfterSeconds = 3) {
  return JSON.stringify({
    type: 'assistant',
    cwd,
    timestamp: new Date().toISOString(),
    isApiErrorMessage: true,
    error: 'rate_limit_error',
    apiErrorStatus: 429,
    message: {
      role: 'assistant',
      content: [{
        type: 'text',
        text: `API Error: Server is temporarily limiting requests (not your usage limit) · All 4 accounts exhausted. Retry in ${retryAfterSeconds}s.`,
      }],
    },
  });
}

function timeoutRecord(cwd) {
  return JSON.stringify({
    type: 'assistant',
    cwd,
    timestamp: new Date().toISOString(),
    isApiErrorMessage: true,
    error: 'server_error',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Request timed out' }],
    },
  });
}

function userRecord(cwd, text) {
  return JSON.stringify({
    type: 'user',
    cwd,
    gitBranch: 'main',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: text },
  });
}

function statusWithQuota(utilization) {
  return {
    switchThreshold: 0.98,
    accounts: [{
      enabled: true,
      status: 'active',
      quota: {
        unified5h: 0.1,
        unified5hReset: new Date(Date.now() + 60_000).toISOString(),
        unified7d: utilization,
        unified7dReset: new Date(Date.now() + 60_000).toISOString(),
      },
    }],
  };
}

async function setup(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, bare, env } = await makeRepo(root);
  const vendorBin = join(root, 'claude-vendor');
  await writeFile(vendorBin, '#!/bin/sh\nexit 0\n');
  await chmod(vendorBin, 0o755);
  return {
    root,
    repo,
    bare,
    gitEnv: env,
    vendorBin,
    transcriptRoot: join(root, 'transcripts'),
    handoffRoot: join(root, 'handoffs'),
    ledgerPath: join(root, 'ledger.jsonl'),
  };
}

function cloudOptions(ctx, overrides = {}) {
  return {
    vendorBin: ctx.vendorBin,
    gitEnv: ctx.gitEnv,
    loadAccounts: async () => [{
      name: 'cloud-acct',
      type: 'oauth',
      accessToken: 'tok-cloud',
      expiresAt: Date.now() + 3_600_000,
    }],
    creditLookup: async () => ({ remainingDollars: 100, lockedReason: null }),
    ledgerPath: ctx.ledgerPath,
    random: () => 0,
    ...overrides,
  };
}

// First spawn writes a user request plus `errorRecord`; later spawns run
// `later(child, args, count)` (default: exit 0).
function scriptedSpawn(ctx, calls, errorRecord, later = null, userText = '클라우드로 이어서 마무리해') {
  return (args, env) => {
    calls.push({ args: [...args], env: { ...env } });
    const child = fakeChild();
    if (calls.length === 1) {
      const sessionId = args[args.indexOf('--session-id') + 1];
      setTimeout(async () => {
        const dir = join(ctx.transcriptRoot, 'project');
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, `${sessionId}.jsonl`),
          `${userRecord(ctx.repo, userText)}\n${errorRecord(ctx.repo)}\n`,
        );
      }, 10);
    } else if (later) {
      later(child, args, calls.length);
    } else {
      setTimeout(() => child.finish(0), 10);
    }
    return child;
  };
}

test('cloud fallback off keeps the fleet wait-and-resume path unchanged', async t => {
  const ctx = await setup(t, 'teamclaude-cloud-off-');
  const calls = [];
  const waits = [];
  const result = await runClaudeWithRecovery({
    claudeArgs: [],
    childEnv: {},
    config: { autoResumeClaude: true, claudeAutoResumeBackoffMs: 0 },
    cwd: ctx.repo,
    transcriptRoot: ctx.transcriptRoot,
    handoffRoot: ctx.handoffRoot,
    pollIntervalMs: 5,
    fetchStatus: async () => statusWithQuota(0.99),
    wait: async ms => waits.push(ms),
    spawnClaude: scriptedSpawn(ctx, calls, cwd => fleetExhaustedRecord(cwd, 3)),
    launchCodex: async () => { throw new Error('unexpected Codex handoff'); },
    launchCloud: async () => { throw new Error('cloud fallback is off'); },
    cloudHandoff: cloudOptions(ctx),
    log() {},
  });
  assert.equal(result.status, 0);
  assert.deepEqual(waits, [3000]);
  assert.equal(calls.length, 2);
  await assert.rejects(stat(ctx.ledgerPath));
});

test('fleet exhaustion hands the session to a cloud session and ends the local session', async t => {
  const ctx = await setup(t, 'teamclaude-cloud-success-');
  const calls = [];
  const logs = [];
  const claimed = [];
  let launch = null;
  let launches = 0;
  const result = await runClaudeWithRecovery({
    claudeArgs: [],
    childEnv: { ANTHROPIC_BASE_URL: 'http://localhost:3456', TEAMCLAUDE_SESSION_SUPERVISED: '1' },
    config: {
      autoResumeClaude: true,
      claudeAutoResumeBackoffMs: 0,
      cloudFallbackOnExhaustion: true,
      codexFallbackOnExhaustion: true,
    },
    cwd: ctx.repo,
    transcriptRoot: ctx.transcriptRoot,
    handoffRoot: ctx.handoffRoot,
    pollIntervalMs: 5,
    fetchStatus: async () => statusWithQuota(0.99),
    claimRecoveryOnce: async sessionId => {
      claimed.push(sessionId);
      return { dev: 1, ino: 1 };
    },
    wait: async () => { throw new Error('must not wait for the fleet'); },
    spawnClaude: scriptedSpawn(ctx, calls, cwd => fleetExhaustedRecord(cwd, 3600)),
    launchCodex: async () => { throw new Error('cloud runs before the Codex fallback'); },
    launchCloud: async request => {
      launches += 1;
      launch = request;
      return { status: 0, signal: null };
    },
    cloudHandoff: cloudOptions(ctx),
    log: message => logs.push(message),
  });

  assert.deepEqual(result, { status: 0, signal: null });
  assert.equal(calls.length, 1);
  assert.equal(launches, 1);
  const sessionId = calls[0].args[calls[0].args.indexOf('--session-id') + 1];
  assert.deepEqual(claimed, [sessionId]);
  assert.equal(launch.cwd, ctx.repo);
  assert.equal(launch.vendorBin, ctx.vendorBin);
  assert.equal(launch.args[0], '--cloud');
  assert.match(launch.args[1], /클라우드로 이어서 마무리해/);
  const branch = `teamclaude-handoff/${sessionId.slice(0, 8)}-`;
  assert.ok(launch.args[1].includes(branch));
  assert.deepEqual(launch.env, { CLAUDE_CODE_OAUTH_TOKEN: 'tok-cloud' });

  const ledger = JSON.parse((await readFile(ctx.ledgerPath, 'utf8')).trim());
  assert.equal(ledger.sessionId, sessionId);
  assert.equal(ledger.account, 'cloud-acct');
  assert.ok(ledger.branch.startsWith(branch));
  assert.ok(git(ctx.bare, ctx.gitEnv, 'rev-parse', `refs/heads/${ledger.branch}`));
  assert.ok(logs.includes(
    `[TeamClaude] Claude fleet exhausted; handed session ${sessionId} to a cloud session on cloud-acct (branch ${ledger.branch}).`,
  ));
  assert.equal(logs.some(line => line.includes('tok-cloud') || line.includes('마무리해')), false);
});

test('a short proxy throttle without confirmed quota exhaustion does not open a cloud session', async t => {
  const ctx = await setup(t, 'teamclaude-cloud-short-throttle-');
  const calls = [];
  const waits = [];
  const result = await runClaudeWithRecovery({
    claudeArgs: [],
    childEnv: {},
    config: {
      autoResumeClaude: true,
      claudeAutoResumeBackoffMs: 0,
      cloudFallbackOnExhaustion: true,
    },
    cwd: ctx.repo,
    transcriptRoot: ctx.transcriptRoot,
    handoffRoot: ctx.handoffRoot,
    pollIntervalMs: 5,
    fetchStatus: async () => statusWithQuota(0.5),
    wait: async ms => waits.push(ms),
    spawnClaude: scriptedSpawn(ctx, calls, cwd => fleetExhaustedRecord(cwd, 3)),
    launchCodex: async () => { throw new Error('unexpected Codex handoff'); },
    launchCloud: async () => { throw new Error('a 3s throttle must not reach the cloud'); },
    cloudHandoff: cloudOptions(ctx),
    log() {},
  });
  assert.equal(result.status, 0);
  assert.deepEqual(waits, [3000]);
  await assert.rejects(stat(ctx.ledgerPath));
});

test('a failed cloud precondition falls back to the fleet wait path', async t => {
  const ctx = await setup(t, 'teamclaude-cloud-precondition-');
  const calls = [];
  const waits = [];
  const result = await runClaudeWithRecovery({
    claudeArgs: [],
    childEnv: {},
    config: {
      autoResumeClaude: true,
      claudeAutoResumeBackoffMs: 0,
      cloudFallbackOnExhaustion: true,
    },
    cwd: ctx.repo,
    transcriptRoot: ctx.transcriptRoot,
    handoffRoot: ctx.handoffRoot,
    pollIntervalMs: 5,
    fetchStatus: async () => statusWithQuota(0.5),
    wait: async ms => waits.push(ms),
    spawnClaude: scriptedSpawn(ctx, calls, cwd => fleetExhaustedRecord(cwd, 3)),
    launchCodex: async () => { throw new Error('unexpected Codex handoff'); },
    launchCloud: async () => { throw new Error('no credit account, no launch'); },
    cloudHandoff: cloudOptions(ctx, {
      creditLookup: async () => ({ remainingDollars: 0, lockedReason: null }),
    }),
    log() {},
  });
  assert.equal(result.status, 0);
  assert.deepEqual(waits, [3000]);
  assert.equal(calls.length, 2);
  await assert.rejects(stat(ctx.ledgerPath));
});

test('a failed cloud launch falls back to the wait path and is attempted once per session', async t => {
  const ctx = await setup(t, 'teamclaude-cloud-launch-fail-');
  const calls = [];
  const waits = [];
  let launches = 0;
  const result = await runClaudeWithRecovery({
    claudeArgs: [],
    childEnv: {},
    config: {
      autoResumeClaude: true,
      claudeAutoResumeBackoffMs: 0,
      claudeFleetExhaustionMaxRetries: 1,
      cloudFallbackOnExhaustion: true,
    },
    cwd: ctx.repo,
    transcriptRoot: ctx.transcriptRoot,
    handoffRoot: ctx.handoffRoot,
    pollIntervalMs: 5,
    fetchStatus: async () => statusWithQuota(0.5),
    wait: async ms => waits.push(ms),
    spawnClaude: scriptedSpawn(ctx, calls, cwd => fleetExhaustedRecord(cwd, 3600), (child, args) => {
      // The resumed child hits fleet exhaustion again, then exits by itself.
      const sessionId = args[args.indexOf('--resume') + 1];
      setTimeout(async () => {
        await appendFile(
          join(ctx.transcriptRoot, 'project', `${sessionId}.jsonl`),
          `${fleetExhaustedRecord(ctx.repo, 5)}\n`,
        );
        setTimeout(() => child.finish(7), 60);
      }, 10);
    }),
    launchCodex: async () => { throw new Error('unexpected Codex handoff'); },
    launchCloud: async () => {
      launches += 1;
      return { status: 1, signal: null };
    },
    cloudHandoff: cloudOptions(ctx),
    log() {},
  });
  assert.equal(launches, 1);
  assert.deepEqual(waits, [3600000]);
  assert.equal(calls.length, 2);
  assert.equal(result.status, 7);
  await assert.rejects(stat(ctx.ledgerPath));
});

test('general quota exhaustion tries the cloud first, then the Codex fallback when the cloud is unavailable', async t => {
  const ctx = await setup(t, 'teamclaude-cloud-codex-');
  let codexHandoff = null;
  let cloudLaunches = 0;
  const calls = [];
  const result = await runClaudeWithRecovery({
    claudeArgs: [],
    childEnv: {},
    config: {
      autoResumeClaude: true,
      claudeAutoResumeMaxRetries: 1,
      claudeAutoResumeBackoffMs: 0,
      cloudFallbackOnExhaustion: true,
      codexFallbackOnExhaustion: true,
    },
    cwd: ctx.repo,
    transcriptRoot: ctx.transcriptRoot,
    handoffRoot: ctx.handoffRoot,
    pollIntervalMs: 5,
    claimRecoveryOnce: async () => ({ dev: 1, ino: 1 }),
    fetchStatus: async () => statusWithQuota(0.99),
    spawnClaude: (args, env) => {
      const child = scriptedSpawn(ctx, calls, timeoutRecord)(args, env);
      setTimeout(() => child.finish(9), 80);
      return child;
    },
    launchCodex: async handoff => {
      codexHandoff = handoff;
      return { status: 0, signal: null };
    },
    launchCloud: async () => {
      cloudLaunches += 1;
      return { status: 0, signal: null };
    },
    cloudHandoff: cloudOptions(ctx, { vendorBin: null }),
    log() {},
  });
  assert.equal(result.status, 0);
  assert.equal(cloudLaunches, 0);
  assert.ok(codexHandoff?.path);
  assert.match(await readFile(codexHandoff.path, 'utf8'), /클라우드로 이어서 마무리해/);
});

// Secret-shaped strings that must never reach the cloud prompt, and the
// look-alikes (git SHA, UUID, paths) that must survive redaction.
const PROMPT_JWT = JWT;
const PROMPT_AUTH_VALUE = ['tok_live_', 'abc123DEF456ghi'].join('');
const PROMPT_OPAQUE = OPAQUE;
const PROMPT_SHA = GIT_SHA;
const PROMPT_UUID_RUN = 'session-0a1b2c3d-1111-4222-8333-444455556666';
const PROMPT_PATH = 'src/components/dashboard2/widgets/AccountUsageTable3.tsx';

test('the cloud prompt redacts JWTs, Authorization values, and long opaque tokens but keeps SHAs, UUIDs, and paths', async t => {
  const ctx = await setup(t, 'teamclaude-cloud-redact-');
  const calls = [];
  let launch = null;
  const userText = [
    '배포 이어서 해줘',
    `jwt ${PROMPT_JWT}`,
    `Authorization: Token ${PROMPT_AUTH_VALUE}`,
    `opaque ${PROMPT_OPAQUE}`,
    `commit ${PROMPT_SHA}`,
    `${PROMPT_UUID_RUN} 확인`,
    `edit ${PROMPT_PATH}`,
  ].join('\n');
  await runClaudeWithRecovery({
    claudeArgs: [],
    childEnv: {},
    config: {
      autoResumeClaude: true,
      claudeAutoResumeBackoffMs: 0,
      cloudFallbackOnExhaustion: true,
    },
    cwd: ctx.repo,
    transcriptRoot: ctx.transcriptRoot,
    handoffRoot: ctx.handoffRoot,
    pollIntervalMs: 5,
    fetchStatus: async () => statusWithQuota(0.99),
    claimRecoveryOnce: async () => ({ dev: 1, ino: 1 }),
    wait: async () => { throw new Error('must not wait for the fleet'); },
    spawnClaude: scriptedSpawn(ctx, calls, cwd => fleetExhaustedRecord(cwd, 3600), null, userText),
    launchCodex: async () => { throw new Error('unexpected Codex handoff'); },
    launchCloud: async request => {
      launch = request;
      return { status: 0, signal: null };
    },
    cloudHandoff: cloudOptions(ctx),
    log() {},
  });
  const prompt = launch.args[1];
  assert.match(prompt, /배포 이어서 해줘/);
  for (const secret of [PROMPT_JWT, PROMPT_AUTH_VALUE, PROMPT_OPAQUE]) {
    assert.equal(prompt.includes(secret), false, secret);
  }
  assert.equal(prompt.includes(PROMPT_JWT.slice(0, 20)), false);
  for (const kept of [PROMPT_SHA, PROMPT_UUID_RUN, PROMPT_PATH]) {
    assert.ok(prompt.includes(kept), kept);
  }
});

test('the permanent replay claim is taken before the cloud session launches', async t => {
  const ctx = await setup(t, 'teamclaude-cloud-claim-order-');
  const order = [];
  const result = await runClaudeWithRecovery({
    claudeArgs: [],
    childEnv: {},
    config: {
      autoResumeClaude: true,
      claudeAutoResumeBackoffMs: 0,
      cloudFallbackOnExhaustion: true,
    },
    cwd: ctx.repo,
    transcriptRoot: ctx.transcriptRoot,
    handoffRoot: ctx.handoffRoot,
    pollIntervalMs: 5,
    fetchStatus: async () => statusWithQuota(0.99),
    claimRecoveryOnce: async () => {
      order.push('claim');
      return { dev: 1, ino: 1 };
    },
    wait: async () => { throw new Error('must not wait for the fleet'); },
    spawnClaude: scriptedSpawn(ctx, [], cwd => fleetExhaustedRecord(cwd, 3600)),
    launchCodex: async () => { throw new Error('unexpected Codex handoff'); },
    launchCloud: async () => {
      order.push('launch');
      return { status: 0, signal: null };
    },
    cloudHandoff: cloudOptions(ctx),
    log() {},
  });
  assert.deepEqual(result, { status: 0, signal: null });
  assert.deepEqual(order, ['claim', 'launch']);
});

test('a failed cloud launch releases the permanent replay claim it took', async t => {
  const ctx = await setup(t, 'teamclaude-cloud-claim-release-');
  const released = [];
  const identity = { dev: 7, ino: 9 };
  await runClaudeWithRecovery({
    claudeArgs: [],
    childEnv: {},
    config: {
      autoResumeClaude: true,
      claudeAutoResumeBackoffMs: 0,
      claudeFleetExhaustionMaxRetries: 1,
      cloudFallbackOnExhaustion: true,
    },
    cwd: ctx.repo,
    transcriptRoot: ctx.transcriptRoot,
    handoffRoot: ctx.handoffRoot,
    pollIntervalMs: 5,
    fetchStatus: async () => statusWithQuota(0.99),
    claimRecoveryOnce: async () => identity,
    releaseRecoveryOnce: async (sessionId, claim) => released.push({ sessionId, claim }),
    wait: async () => {},
    spawnClaude: scriptedSpawn(ctx, [], cwd => fleetExhaustedRecord(cwd, 3600)),
    launchCodex: async () => { throw new Error('unexpected Codex handoff'); },
    launchCloud: async () => ({ status: 1, signal: null }),
    cloudHandoff: cloudOptions(ctx),
    log() {},
  });
  assert.equal(released.length, 1);
  assert.deepEqual(released[0].claim, identity);
});

for (const [label, claimRecoveryOnce, reason] of [
  ['refused', async () => false, 'claim-refused'],
  ['failing', async () => { throw new Error('claim store unavailable'); }, 'claim-failed'],
]) {
  test(`a ${label} permanent replay claim keeps the session local without a cloud launch`, async t => {
    const ctx = await setup(t, `teamclaude-cloud-claim-${label}-`);
    const calls = [];
    const waits = [];
    const logs = [];
    let launches = 0;
    let claims = 0;
    const result = await runClaudeWithRecovery({
      claudeArgs: [],
      childEnv: {},
      config: {
        autoResumeClaude: true,
        claudeAutoResumeBackoffMs: 0,
        claudeFleetExhaustionMaxRetries: 1,
        cloudFallbackOnExhaustion: true,
      },
      cwd: ctx.repo,
      transcriptRoot: ctx.transcriptRoot,
      handoffRoot: ctx.handoffRoot,
      pollIntervalMs: 5,
      fetchStatus: async () => statusWithQuota(0.5),
      claimRecoveryOnce: async sessionId => {
        claims += 1;
        return claimRecoveryOnce(sessionId);
      },
      wait: async ms => waits.push(ms),
      spawnClaude: scriptedSpawn(ctx, calls, cwd => fleetExhaustedRecord(cwd, 3600), (child, args) => {
        const sessionId = args[args.indexOf('--resume') + 1];
        setTimeout(async () => {
          await appendFile(
            join(ctx.transcriptRoot, 'project', `${sessionId}.jsonl`),
            `${fleetExhaustedRecord(ctx.repo, 5)}\n`,
          );
          setTimeout(() => child.finish(7), 60);
        }, 10);
      }),
      launchCodex: async () => { throw new Error('unexpected Codex handoff'); },
      launchCloud: async () => {
        launches += 1;
        return { status: 0, signal: null };
      },
      cloudHandoff: cloudOptions(ctx),
      log: message => logs.push(message),
    });
    assert.equal(claims, 1);
    assert.equal(launches, 0);
    assert.deepEqual(waits, [3600000]);
    assert.equal(calls.length, 2);
    assert.equal(result.status, 7);
    await assert.rejects(stat(ctx.ledgerPath));
    assert.ok(logs.some(line => line.includes(`(${reason})`)), logs.join('\n'));
  });
}
