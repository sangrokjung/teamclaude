import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRepo } from './helpers/git-fixture.js';
import { CloudHandoffNotStopped } from '../src/cloud-handoff.js';
import {
  CLOUD_SIDECAR_LOG_PREFIX,
  fleetExhaustionVerdict,
  isTeamclaudeRunSupervisor,
  parseProcessEnvOutput,
  parsePsOutput,
  resolveSupervisorSessionId,
  runCloudSidecar,
  sessionIdFromArgv,
} from '../src/cloud-sidecar.js';

const SESSION_A = '0a1b2c3d-1111-4222-8333-444455556666';
const SESSION_B = '1b2c3d4e-2222-4333-9444-555566667777';
const SESSION_C = '2c3d4e5f-3333-4444-a555-666677778888';
const NODE = '/opt/node/bin/node';
const ENTRY = '/opt/teamclaude/src/index.js';
const BIN_ENTRY = '/opt/teamclaude/src/teamclaude.js';
const TRUSTED = [ENTRY, BIN_ENTRY];
const CONFIG_PATH = '/cfg/teamclaude.json';
const NOW = Date.parse('2026-10-16T03:00:00Z');
const CUTOFF = '2026-10-15T00:00:00Z';
const LSTART_OLD = 'Tue Oct 14 09:00:00 2026';
const LSTART_NEW = 'Fri Oct 16 09:00:00 2026';
const HOUR = 3_600_000;

// ── parsing ─────────────────────────────────────────────────

test('parsePsOutput reads pid, ppid, lstart and the full command line', () => {
  const text = [
    '  101     1 Tue Oct 14 09:00:00 2026     /opt/node/bin/node /opt/teamclaude/src/index.js run --resume x',
    '  202   101 Wed Oct  1 07:05:09 2026     claude --resume x',
    'garbage line',
    '',
  ].join('\n');
  const rows = parsePsOutput(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    pid: 101,
    ppid: 1,
    lstart: 'Tue Oct 14 09:00:00 2026',
    startedAtMs: new Date('Tue Oct 14 09:00:00 2026').getTime(),
    command: '/opt/node/bin/node /opt/teamclaude/src/index.js run --resume x',
  });
  assert.equal(rows[1].pid, 202);
  assert.equal(rows[1].ppid, 101);
  assert.equal(rows[1].lstart, 'Wed Oct  1 07:05:09 2026');
  assert.ok(Number.isFinite(rows[1].startedAtMs));
  assert.equal(rows[1].command, 'claude --resume x');
});

test('isTeamclaudeRunSupervisor matches only node running a trusted entry with the run subcommand', () => {
  assert.equal(isTeamclaudeRunSupervisor(`${NODE} ${ENTRY} run`, TRUSTED), true);
  assert.equal(isTeamclaudeRunSupervisor(`${NODE} ${ENTRY} run --resume ${SESSION_A}`, TRUSTED), true);
  assert.equal(isTeamclaudeRunSupervisor(`node ${BIN_ENTRY} run -c`, TRUSTED), true);
  assert.equal(isTeamclaudeRunSupervisor(`${NODE} ${ENTRY} codex run`, TRUSTED), false);
  assert.equal(isTeamclaudeRunSupervisor(`${NODE} ${ENTRY} server`, TRUSTED), false);
  assert.equal(isTeamclaudeRunSupervisor(`${NODE} ${ENTRY} runner`, TRUSTED), false);
  assert.equal(isTeamclaudeRunSupervisor(`/bin/zsh -c ${NODE} ${ENTRY} run`, TRUSTED), false);
  assert.equal(isTeamclaudeRunSupervisor('claude --resume x', TRUSTED), false);
  assert.equal(isTeamclaudeRunSupervisor('', TRUSTED), false);
  // Same suffix, different install: another app is never a target.
  assert.equal(isTeamclaudeRunSupervisor(`${NODE} /srv/other-app/src/index.js run`, TRUSTED), false);
  assert.equal(isTeamclaudeRunSupervisor(`${NODE} /srv/other-app/teamclaude.js run`, TRUSTED), false);
  assert.equal(isTeamclaudeRunSupervisor(`${NODE} ${ENTRY} run`, []), false);
  assert.equal(isTeamclaudeRunSupervisor(`${NODE} ${ENTRY} run`), false);
});

test('sessionIdFromArgv classifies argv as absent, valid, ambiguous or forked', () => {
  const run = rest => sessionIdFromArgv(`${NODE} ${ENTRY} run ${rest}`.trim());
  assert.deepEqual(run(`--session-id ${SESSION_A}`), { kind: 'valid', sessionId: SESSION_A });
  assert.deepEqual(run(`--resume ${SESSION_A} continue`), { kind: 'valid', sessionId: SESSION_A });
  assert.deepEqual(run(`-r ${SESSION_A}`), { kind: 'valid', sessionId: SESSION_A });
  assert.deepEqual(run(`--resume=${SESSION_A}`), { kind: 'valid', sessionId: SESSION_A });
  assert.deepEqual(run(`--resume ${SESSION_A} --session-id ${SESSION_A}`), { kind: 'valid', sessionId: SESSION_A });
  assert.deepEqual(run(''), { kind: 'absent', sessionId: null });
  assert.deepEqual(run('--continue'), { kind: 'absent', sessionId: null });
  assert.deepEqual(run('--model opus'), { kind: 'absent', sessionId: null });
  // A selector without a UUID, or two different IDs, cannot be trusted.
  assert.deepEqual(run('--resume not-a-uuid'), { kind: 'ambiguous', sessionId: null });
  assert.deepEqual(run('--resume'), { kind: 'ambiguous', sessionId: null });
  assert.deepEqual(run('-r'), { kind: 'ambiguous', sessionId: null });
  assert.deepEqual(run('--session-id=nope'), { kind: 'ambiguous', sessionId: null });
  assert.deepEqual(run(`--resume ${SESSION_A} --session-id ${SESSION_B}`), { kind: 'ambiguous', sessionId: null });
  // A forked resume runs under a NEW session ID.
  assert.deepEqual(run(`--resume ${SESSION_A} --fork-session`), { kind: 'forked', sessionId: null });
  assert.deepEqual(run('--fork-session'), { kind: 'forked', sessionId: null });
});

// ── exhaustion verdict ──────────────────────────────────────

function blockedAccount(overrides = {}) {
  return {
    enabled: true,
    status: 'active',
    usable: false,
    creditBacked: false,
    rateLimitedUntil: null,
    quota: {
      unified5h: 0.4,
      unified5hReset: NOW + HOUR,
      unified7d: 1,
      unified7dReset: NOW + 5 * HOUR,
    },
    ...overrides,
  };
}

function exhaustedStatus(accounts = [blockedAccount(), blockedAccount({
  quota: { unified5h: 1, unified5hReset: NOW + 2 * HOUR, unified7d: 0.2, unified7dReset: NOW + 90 * HOUR },
})]) {
  return {
    switchThreshold: 0.98,
    usableCount: accounts.filter(a => a.usable).length,
    totalCount: accounts.length,
    accounts,
  };
}

test('fleetExhaustionVerdict reports the earliest account recovery when nothing is usable', () => {
  const verdict = fleetExhaustionVerdict(exhaustedStatus(), NOW);
  assert.equal(verdict.exhausted, true);
  assert.equal(verdict.earliestRecoveryMs, NOW + 2 * HOUR);
});

test('fleetExhaustionVerdict uses the latest blocker per account and ignores parked accounts', () => {
  const status = exhaustedStatus([
    blockedAccount({
      quota: { unified5h: 1, unified5hReset: NOW + HOUR, unified7d: 1, unified7dReset: NOW + 9 * HOUR },
    }),
    blockedAccount({
      quota: { unified5h: 0.1, unified7d: 0.1 },
      rateLimitedUntil: new Date(NOW + 3 * HOUR).toISOString(),
      status: 'throttled',
    }),
    blockedAccount({ status: 'error', quota: {} }),
    blockedAccount({ enabled: false, usable: false, quota: {} }),
  ]);
  const verdict = fleetExhaustionVerdict(status, NOW);
  assert.equal(verdict.exhausted, true);
  assert.equal(verdict.earliestRecoveryMs, NOW + 3 * HOUR);
});

test('fleetExhaustionVerdict is not exhausted or is uncertain otherwise', () => {
  assert.equal(fleetExhaustionVerdict(null, NOW).exhausted, false);
  assert.equal(fleetExhaustionVerdict({}, NOW).exhausted, false);
  assert.equal(fleetExhaustionVerdict(exhaustedStatus([]), NOW).exhausted, false);
  const usable = exhaustedStatus([blockedAccount(), blockedAccount({ usable: true })]);
  assert.equal(fleetExhaustionVerdict(usable, NOW).exhausted, false);
  const credit = exhaustedStatus([blockedAccount({ creditBacked: true })]);
  assert.equal(fleetExhaustionVerdict(credit, NOW).exhausted, false);
  // Unusable with no explaining future window (e.g. a reset that just passed).
  const unexplained = exhaustedStatus([blockedAccount(), blockedAccount({
    quota: { unified5h: 1, unified5hReset: NOW - 1000 },
  })]);
  assert.equal(fleetExhaustionVerdict(unexplained, NOW).exhausted, false);
  // Only parked accounts: nothing recovers on a known clock.
  const parked = exhaustedStatus([blockedAccount({ status: 'error', quota: {} })]);
  assert.equal(fleetExhaustionVerdict(parked, NOW).exhausted, false);
});

// ── session lookup ─────────────────────────────────────────

test('resolveSupervisorSessionId finds the lease or store session bound to the supervisor pid', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-sidecar-lease-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storePath = join(root, 'claude-hook-sessions.json');
  const leaseDir = `${storePath}.recovery-leases`;
  await mkdir(leaseDir, { recursive: true, mode: 0o700 });
  const startedAtMs = new Date(LSTART_OLD).getTime();
  const writePrivate = async (path, value) => {
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    await chmod(path, 0o600);
  };
  await writePrivate(join(leaseDir, SESSION_A), {
    version: 1, pid: 4242, processStartSeconds: startedAtMs / 1000, nonce: 'n1', createdAt: NOW,
  });
  await writePrivate(join(leaseDir, SESSION_B), {
    version: 1, pid: 5151, processStartSeconds: startedAtMs / 1000, nonce: 'n2', createdAt: NOW,
  });
  await writePrivate(join(leaseDir, 'not-a-session'), { version: 1, pid: 4242 });

  assert.equal(await resolveSupervisorSessionId({ storePath, pid: 4242, startedAtMs }), SESSION_A);
  // Same pid, different process start: a recycled pid is not the owner.
  assert.equal(await resolveSupervisorSessionId({
    storePath, pid: 4242, startedAtMs: startedAtMs + 60_000,
  }), null);
  assert.equal(await resolveSupervisorSessionId({ storePath, pid: 9999, startedAtMs }), null);

  await writePrivate(storePath, {
    sessions: {
      [SESSION_C]: { sessionId: SESSION_C, pid: 7070, pidStartSeconds: startedAtMs / 1000 },
    },
  });
  assert.equal(await resolveSupervisorSessionId({ storePath, pid: 7070, startedAtMs }), SESSION_C);

  // Two different sessions bound to one pid are ambiguous.
  await writePrivate(storePath, {
    sessions: {
      [SESSION_C]: { sessionId: SESSION_C, pid: 4242, pidStartSeconds: startedAtMs / 1000 },
    },
  });
  assert.equal(await resolveSupervisorSessionId({ storePath, pid: 4242, startedAtMs }), null);
});

// ── runCloudSidecar ─────────────────────────────────────────

function supervisor(pid, { lstart = LSTART_OLD, args = `--resume ${SESSION_A}`, ppid = 1 } = {}) {
  return {
    pid,
    ppid,
    lstart,
    startedAtMs: new Date(lstart).getTime(),
    command: `${NODE} ${ENTRY} run ${args}`.trim(),
  };
}

function harness(overrides = {}) {
  const calls = [];
  const processes = overrides.processes ?? [supervisor(4242)];
  let state = overrides.state ?? {
    observations: {
      [`4242:${LSTART_OLD}`]: { firstChildlessAt: NOW - 5 * 60_000 },
    },
  };
  const deps = {
    config: {
      cloudFallbackOnExhaustion: true,
      cloudSidecarLegacyBefore: CUTOFF,
      switchThreshold: 0.98,
      ...(overrides.config || {}),
    },
    now: () => NOW,
    vendorBin: '/opt/vendor/claude',
    trustedEntries: TRUSTED,
    configPath: CONFIG_PATH,
    resolvePath: async path => path,
    readProcessEnv: async () => ({ HOME: '/home/user', TEAMCLAUDE_CONFIG: CONFIG_PATH }),
    listProcesses: async () => processes.map(p => ({ ...p })),
    fetchStatus: async () => exhaustedStatus(),
    readCwd: async () => '/work/project',
    resolveSessionFromStore: async () => null,
    claimOnce: async sessionId => {
      calls.push(['claim', sessionId]);
      return { dev: 1, ino: 2 };
    },
    releaseClaim: async (sessionId, claim) => {
      calls.push(['release', sessionId, claim]);
      return true;
    },
    kill: async (pid, signal) => {
      calls.push(['kill', pid, signal]);
      const index = processes.findIndex(p => p.pid === pid);
      if (index >= 0) processes.splice(index, 1);
    },
    isAlive: async ({ pid, lstart }) => processes.some(p => p.pid === pid && p.lstart === lstart),
    sleep: async () => {},
    readState: async () => structuredClone(state),
    writeState: async next => {
      state = structuredClone(next);
    },
    buildHandoff: async () => ({ header: '# handoff', sections: ['### User request\n\n> 계속'] }),
    attemptHandoff: async options => {
      calls.push(['attempt', options.sessionId, options.cwd]);
      const claim = await options.claimBeforeLaunch();
      if (!claim) return { ok: false, reason: 'claim-refused', stopped: false };
      try {
        await options.beforeLaunch();
      } catch (error) {
        if (error instanceof CloudHandoffNotStopped) {
          const released = (await options.releaseClaim(claim)) === true;
          return { ok: false, reason: 'launch-failed', stopped: false, claimHeld: !released };
        }
        return { ok: false, reason: 'launch-failed', stopped: true, claimHeld: true };
      }
      const result = await options.launchCloud({
        vendorBin: options.vendorBin, args: ['--cloud', 'prompt'], env: {}, cwd: options.cwd,
      });
      calls.push(['ledgerExtra', options.ledgerExtra]);
      return { ok: true, result, account: 'cloud-acct', branch: 'teamclaude-handoff/x' };
    },
    launchCloud: async request => {
      calls.push(['launch', request.vendorBin, request.cwd]);
      return { status: 0, signal: null };
    },
    log: message => calls.push(['log', message]),
    ...overrides.deps,
  };
  return {
    deps,
    calls,
    processes,
    get state() {
      return state;
    },
    count: kind => calls.filter(call => call[0] === kind).length,
    logs: () => calls.filter(call => call[0] === 'log').map(call => call[1]),
  };
}

function assertNoSideEffects(h) {
  assert.equal(h.count('claim'), 0, 'no claim');
  assert.equal(h.count('kill'), 0, 'no kill');
  assert.equal(h.count('launch'), 0, 'no launch');
}

test('runCloudSidecar hands an exhausted legacy supervisor to a cloud session: claim, SIGTERM, launch', async () => {
  const h = harness();
  const result = await runCloudSidecar(h.deps);
  const order = h.calls.filter(call => ['claim', 'kill', 'launch'].includes(call[0])).map(call => call[0]);
  assert.deepEqual(order, ['claim', 'kill', 'launch']);
  assert.deepEqual(h.calls.find(call => call[0] === 'kill'), ['kill', 4242, 'SIGTERM']);
  assert.deepEqual(h.calls.find(call => call[0] === 'attempt'), ['attempt', SESSION_A, '/work/project']);
  assert.deepEqual(h.calls.find(call => call[0] === 'launch'), ['launch', '/opt/vendor/claude', '/work/project']);
  assert.deepEqual(h.calls.find(call => call[0] === 'ledgerExtra')[1], { source: 'legacy-sidecar' });
  assert.equal(result.handoffs, 1);
  assert.equal(h.logs().every(line => line.startsWith(CLOUD_SIDECAR_LOG_PREFIX)), true);
  assert.equal(Object.keys(h.state.observations).length, 0);
});

test('runCloudSidecar does nothing when the feature is off or the cutoff is missing', async () => {
  for (const config of [
    { cloudFallbackOnExhaustion: false },
    { cloudFallbackOnExhaustion: 'true' },
    { cloudSidecarLegacyBefore: undefined },
    { cloudSidecarLegacyBefore: 'not a date' },
  ]) {
    const h = harness({ config });
    await runCloudSidecar(h.deps);
    assertNoSideEffects(h);
    assert.equal(h.count('attempt'), 0);
  }
});

test('runCloudSidecar does nothing when the fleet is not exhausted or the status is unknown', async () => {
  const cases = [
    async () => exhaustedStatus([blockedAccount({ usable: true })]),
    async () => {
      throw new Error('proxy down');
    },
    async () => null,
    async () => exhaustedStatus([blockedAccount({ quota: { unified5h: 1, unified5hReset: NOW - 5 } })]),
  ];
  for (const fetchStatus of cases) {
    const h = harness({ deps: { fetchStatus } });
    await runCloudSidecar(h.deps);
    assertNoSideEffects(h);
  }
});

test('runCloudSidecar does nothing when the fleet recovers within 10 minutes', async () => {
  const h = harness({
    deps: {
      fetchStatus: async () => exhaustedStatus([blockedAccount({
        quota: { unified5h: 1, unified5hReset: NOW + 9 * 60_000 },
      })]),
    },
  });
  await runCloudSidecar(h.deps);
  assertNoSideEffects(h);
});

test('runCloudSidecar ignores supervisors started at or after the legacy cutoff', async () => {
  const h = harness({
    processes: [supervisor(4242, { lstart: LSTART_NEW })],
    state: { observations: { [`4242:${LSTART_NEW}`]: { firstChildlessAt: NOW - HOUR } } },
  });
  await runCloudSidecar(h.deps);
  assertNoSideEffects(h);
  assert.equal(Object.keys(h.state.observations).length, 0);
});

test('runCloudSidecar ignores a supervisor whose claude child is alive and forgets its observation', async () => {
  const h = harness({
    processes: [supervisor(4242), { pid: 5000, ppid: 4242, lstart: LSTART_OLD, startedAtMs: 0, command: 'claude' }],
  });
  await runCloudSidecar(h.deps);
  assertNoSideEffects(h);
  assert.equal(Object.keys(h.state.observations).length, 0);
});

test('runCloudSidecar needs two childless observations at least 60 seconds apart', async () => {
  const h = harness({ state: {} });
  await runCloudSidecar(h.deps);
  assertNoSideEffects(h);
  assert.deepEqual(h.state.observations, { [`4242:${LSTART_OLD}`]: { firstChildlessAt: NOW } });

  const recent = harness({
    state: { observations: { [`4242:${LSTART_OLD}`]: { firstChildlessAt: NOW - 59_000 } } },
  });
  await runCloudSidecar(recent.deps);
  assertNoSideEffects(recent);
  assert.equal(recent.state.observations[`4242:${LSTART_OLD}`].firstChildlessAt, NOW - 59_000);
});

test('runCloudSidecar drops observations for supervisors that disappeared', async () => {
  const h = harness({
    processes: [],
    state: { observations: { [`4242:${LSTART_OLD}`]: { firstChildlessAt: NOW - HOUR } } },
  });
  await runCloudSidecar(h.deps);
  assert.deepEqual(h.state.observations, {});
});

test('runCloudSidecar skips a supervisor whose session ID cannot be resolved', async () => {
  const h = harness({ processes: [supervisor(4242, { args: '--continue' })] });
  await runCloudSidecar(h.deps);
  assertNoSideEffects(h);
  assert.equal(h.count('attempt'), 0);
});

test('runCloudSidecar falls back to the cmux session bound to the supervisor pid', async () => {
  const seen = [];
  const h = harness({
    processes: [supervisor(4242, { args: '' })],
    deps: {
      resolveSessionFromStore: async ({ pid, startedAtMs }) => {
        seen.push([pid, startedAtMs]);
        return SESSION_B;
      },
    },
  });
  await runCloudSidecar(h.deps);
  assert.deepEqual(seen, [[4242, new Date(LSTART_OLD).getTime()]]);
  assert.deepEqual(h.calls.find(call => call[0] === 'claim'), ['claim', SESSION_B]);
  assert.equal(h.count('launch'), 1);
});

test('runCloudSidecar does nothing without a vendor binary or a readable cwd', async () => {
  for (const deps of [{ vendorBin: null }, { vendorBin: '' }, { readCwd: async () => null }]) {
    const h = harness({ deps });
    await runCloudSidecar(h.deps);
    assertNoSideEffects(h);
  }
});

test('runCloudSidecar never stops the supervisor when the replay claim is refused', async () => {
  const h = harness({
    deps: {
      claimOnce: async sessionId => {
        h.calls.push(['claim', sessionId]);
        return false;
      },
    },
  });
  await runCloudSidecar(h.deps);
  assert.equal(h.count('claim'), 1);
  assert.equal(h.count('kill'), 0);
  assert.equal(h.count('launch'), 0);
});

test('runCloudSidecar does not kill when the re-check before launch finds a changed process, and releases its claim', async () => {
  for (const mutate of [
    processes => processes.push({ pid: 5000, ppid: 4242, lstart: LSTART_OLD, startedAtMs: 0, command: 'claude' }),
    processes => {
      processes[0] = supervisor(4242, { lstart: 'Wed Oct 14 10:00:00 2026' });
    },
    processes => processes.splice(0, 1),
  ]) {
    const h = harness();
    const original = h.deps.claimOnce;
    h.deps.claimOnce = async sessionId => {
      const claim = await original(sessionId);
      mutate(h.processes);
      return claim;
    };
    const result = await runCloudSidecar(h.deps);
    assert.equal(h.count('kill'), 0);
    assert.equal(h.count('launch'), 0);
    assert.deepEqual(h.calls.find(call => call[0] === 'release'), ['release', SESSION_A, { dev: 1, ino: 2 }]);
    assert.equal(result.handoffs, 0);
  }
});

test('runCloudSidecar keeps the claim and does not launch when the supervisor survives SIGTERM', async () => {
  const h = harness({
    deps: {
      kill: async (pid, signal) => {
        h.calls.push(['kill', pid, signal]);
      },
    },
  });
  await runCloudSidecar(h.deps);
  assert.equal(h.count('kill'), 1);
  assert.equal(h.count('launch'), 0);
  assert.equal(h.count('release'), 0);
});

test('runCloudSidecar attempts each childless supervisor once until it changes', async () => {
  const h = harness({
    deps: {
      attemptHandoff: async options => {
        h.calls.push(['attempt', options.sessionId]);
        return { ok: false, reason: 'no-credit-account', stopped: false };
      },
    },
  });
  await runCloudSidecar(h.deps);
  await runCloudSidecar(h.deps);
  assert.equal(h.count('attempt'), 1);
});

test('runCloudSidecar caps handoffs per run at cloudSidecarMaxPerRun (default 4)', async () => {
  const many = Array.from({ length: 6 }, (_, i) => supervisor(4000 + i));
  const observations = Object.fromEntries(many.map(p => [`${p.pid}:${p.lstart}`, { firstChildlessAt: NOW - HOUR }]));
  const h = harness({ processes: many.map(p => ({ ...p })), state: { observations } });
  const result = await runCloudSidecar(h.deps);
  assert.equal(h.count('launch'), 4);
  assert.equal(result.handoffs, 4);

  const capped = harness({
    processes: many.map(p => ({ ...p })),
    state: { observations },
    config: { cloudSidecarMaxPerRun: 2 },
  });
  await runCloudSidecar(capped.deps);
  assert.equal(capped.count('launch'), 2);
  assert.equal(capped.count('attempt'), 2);
});

test('runCloudSidecar drives the real cloud handoff and records source legacy-sidecar in the ledger', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-sidecar-real-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, env } = await makeRepo(root);
  const ledgerPath = join(root, 'ledger.jsonl');
  const h = harness({
    deps: {
      attemptHandoff: undefined,
      readCwd: async () => repo,
      handoffOptions: {
        gitEnv: env,
        binExists: async () => true,
        loadAccounts: async () => [
          { name: 'cloud-acct', type: 'oauth', accessToken: 'tok-cloud', expiresAt: NOW + 10 * HOUR },
        ],
        creditLookup: async () => ({ remainingDollars: 50, lockedReason: null }),
        random: () => 0,
      },
      ledgerPath,
      baseEnv: { PATH: '/usr/bin' },
    },
  });
  delete h.deps.attemptHandoff;
  const result = await runCloudSidecar(h.deps);
  assert.equal(result.handoffs, 1);
  const order = h.calls.filter(call => ['claim', 'kill', 'launch'].includes(call[0])).map(call => call[0]);
  assert.deepEqual(order, ['claim', 'kill', 'launch']);
  const ledger = JSON.parse((await readFile(ledgerPath, 'utf8')).trim());
  assert.equal(ledger.source, 'legacy-sidecar');
  assert.equal(ledger.sessionId, SESSION_A);
  assert.equal(ledger.account, 'cloud-acct');
  assert.equal(JSON.stringify(ledger).includes('tok-cloud'), false);
  assert.equal(h.logs().some(line => line.includes('tok-cloud')), false);
});

// ── pool membership, late re-check, argv classes ───────────

test('runCloudSidecar never touches a supervisor of another pool or with an unreadable environment', async () => {
  for (const env of [
    { HOME: '/home/user', TEAMCLAUDE_CONFIG: '/cfg/other.json' },
    { HOME: '/home/user', TEAMCLAUDE_CONFIG: CONFIG_PATH, TEAMCLAUDE_PROVIDER: 'codex' },
    { HOME: '/home/user', TEAMCLAUDE_CONFIG: CONFIG_PATH, TEAMCLAUDE_PROVIDER: 'something-else' },
    { HOME: '/home/user', TEAMCLAUDE_CONFIG: 'relative/teamclaude.json' },
    { HOME: '/home/other' },
    {},
    null,
  ]) {
    const h = harness({ deps: { readProcessEnv: async () => env } });
    await runCloudSidecar(h.deps);
    assertNoSideEffects(h);
    assert.equal(h.count('attempt'), 0, JSON.stringify(env));
  }
  const throwing = harness({
    deps: {
      readProcessEnv: async () => {
        throw new Error('ps failed');
      },
    },
  });
  await runCloudSidecar(throwing.deps);
  assert.equal(throwing.count('attempt'), 0);
});

test('runCloudSidecar compares config paths by realpath and accepts the default path', async () => {
  const viaLink = harness({
    deps: {
      readProcessEnv: async () => ({ HOME: '/home/user', TEAMCLAUDE_CONFIG: '/link/teamclaude.json' }),
      resolvePath: async path => (path === '/link/teamclaude.json' ? CONFIG_PATH : path),
    },
  });
  await runCloudSidecar(viaLink.deps);
  assert.equal(viaLink.count('launch'), 1);

  const byDefault = harness({
    deps: {
      configPath: '/home/user/.config/teamclaude.json',
      readProcessEnv: async () => ({ HOME: '/home/user' }),
    },
  });
  await runCloudSidecar(byDefault.deps);
  assert.equal(byDefault.count('launch'), 1);

  const byXdg = harness({
    deps: {
      configPath: '/xdg/teamclaude.json',
      readProcessEnv: async () => ({ HOME: '/home/user', XDG_CONFIG_HOME: '/xdg' }),
    },
  });
  await runCloudSidecar(byXdg.deps);
  assert.equal(byXdg.count('launch'), 1);

  // A missing config file (realpath fails) is not proof of membership.
  const unresolved = harness({
    deps: {
      resolvePath: async path => {
        if (path === CONFIG_PATH) throw new Error('ENOENT');
        return path;
      },
    },
  });
  await runCloudSidecar(unresolved.deps);
  assert.equal(unresolved.count('attempt'), 0);
});

test('runCloudSidecar trusts the teamclaude.js bin to be the Claude pool whatever its inherited provider', async () => {
  const h = harness({
    processes: [{ ...supervisor(4242), command: `${NODE} ${BIN_ENTRY} run --resume ${SESSION_A}` }],
    deps: {
      readProcessEnv: async () => ({ HOME: '/home/user', TEAMCLAUDE_CONFIG: CONFIG_PATH, TEAMCLAUDE_PROVIDER: 'codex' }),
    },
  });
  await runCloudSidecar(h.deps);
  assert.equal(h.count('launch'), 1);
});

test('runCloudSidecar ignores another app whose entry merely ends in src/index.js', async () => {
  const other = { ...supervisor(4242), command: `${NODE} /srv/other-app/src/index.js run --resume ${SESSION_A}` };
  const h = harness({ processes: [other] });
  await runCloudSidecar(h.deps);
  assertNoSideEffects(h);
  assert.equal(h.count('attempt'), 0);
  assert.deepEqual(h.state.observations, {});
});

test('runCloudSidecar accepts a supervisor whose entry resolves to the trusted install', async () => {
  const linked = { ...supervisor(4242), command: `${NODE} /usr/local/bin/teamclaude run --resume ${SESSION_A}` };
  const h = harness({
    processes: [linked],
    deps: { resolvePath: async path => (path === '/usr/local/bin/teamclaude' ? BIN_ENTRY : path) },
  });
  await runCloudSidecar(h.deps);
  assert.equal(h.count('launch'), 1);
});

test('runCloudSidecar re-checks exhaustion right before SIGTERM and backs off when the fleet recovered', async () => {
  for (const late of [
    async () => exhaustedStatus([blockedAccount({ usable: true })]),
    async () => {
      throw new Error('proxy down');
    },
    async () => exhaustedStatus([blockedAccount({
      quota: { unified5h: 1, unified5hReset: NOW + 20 * 60_000 },
    })]),
  ]) {
    let calls = 0;
    let clock = NOW;
    const h = harness({
      deps: {
        now: () => clock,
        fetchStatus: async () => {
          calls += 1;
          if (calls === 1) return exhaustedStatus();
          return late();
        },
      },
    });
    const original = h.deps.claimOnce;
    h.deps.claimOnce = async sessionId => {
      // Preparation (snapshot, push, credit lookup) takes time.
      clock = NOW + 15 * 60_000;
      return original(sessionId);
    };
    const result = await runCloudSidecar(h.deps);
    assert.equal(calls, 2);
    assert.equal(h.count('kill'), 0);
    assert.equal(h.count('launch'), 0);
    assert.deepEqual(h.calls.find(call => call[0] === 'release'), ['release', SESSION_A, { dev: 1, ino: 2 }]);
    assert.equal(result.handoffs, 0);
  }
});

test('runCloudSidecar skips ambiguous argv even when the store names a session', async () => {
  let storeCalls = 0;
  const h = harness({
    processes: [supervisor(4242, { args: `--resume ${SESSION_A} --session-id ${SESSION_B}` })],
    deps: {
      resolveSessionFromStore: async () => {
        storeCalls += 1;
        return SESSION_A;
      },
    },
  });
  await runCloudSidecar(h.deps);
  assertNoSideEffects(h);
  assert.equal(h.count('attempt'), 0);
  assert.equal(storeCalls, 0);

  const nonUuid = harness({
    processes: [supervisor(4242, { args: '--resume some-title' })],
    deps: { resolveSessionFromStore: async () => SESSION_A },
  });
  await runCloudSidecar(nonUuid.deps);
  assert.equal(nonUuid.count('attempt'), 0);
});

test('runCloudSidecar skips a forked resume even when the store names a session', async () => {
  let storeCalls = 0;
  const h = harness({
    processes: [supervisor(4242, { args: `--resume ${SESSION_A} --fork-session` })],
    deps: {
      resolveSessionFromStore: async () => {
        storeCalls += 1;
        return SESSION_B;
      },
    },
  });
  await runCloudSidecar(h.deps);
  assertNoSideEffects(h);
  assert.equal(h.count('attempt'), 0);
  assert.equal(storeCalls, 0);
});

test('parseProcessEnvOutput keeps only the membership keys and fails closed', () => {
  const command = `${NODE} ${ENTRY} run --resume ${SESSION_A}`;
  const out = `${command} PATH=/usr/bin HOME=/home/user OTHER_TOKEN=opaque TEAMCLAUDE_CONFIG=/cfg/teamclaude.json\n`;
  assert.deepEqual(parseProcessEnvOutput(out, command), {
    HOME: '/home/user',
    TEAMCLAUDE_CONFIG: '/cfg/teamclaude.json',
  });
  // No visible environment (another user's process, or hidden).
  assert.equal(parseProcessEnvOutput(`${command}\n`, command), null);
  // Output that is not this command line.
  assert.equal(parseProcessEnvOutput(`other command HOME=/x\n`, command), null);
  assert.equal(parseProcessEnvOutput(`${command}X HOME=/x`, command), null);
  // A needed key seen twice is ambiguous.
  assert.equal(parseProcessEnvOutput(`${command} HOME=/a HOME=/b`, command), null);
  assert.equal(parseProcessEnvOutput(out, ''), null);
});
