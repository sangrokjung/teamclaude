import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRepo } from './helpers/git-fixture.js';
import { CloudHandoffNotStopped } from '../src/cloud-handoff.js';
import { unresolvedExhaustionErrorState } from '../src/cmux-session-guards.js';
import {
  CLOUD_SIDECAR_LOG_PREFIX,
  fleetExhaustionVerdict,
  isTeamclaudeRunSupervisor,
  parsePsOutput,
  provesDefaultPool,
  resolveSupervisorLease,
  runCloudSidecar,
} from '../src/cloud-sidecar.js';

const SESSION_A = '0a1b2c3d-1111-4222-8333-444455556666';
const SESSION_B = '1b2c3d4e-2222-4333-9444-555566667777';
const SESSION_C = '2c3d4e5f-3333-4444-a555-666677778888';
const NODE = '/opt/node/bin/node';
const ENTRY = '/opt/teamclaude/src/index.js';
const BIN_ENTRY = '/opt/teamclaude/src/teamclaude.js';
const TRUSTED = [ENTRY, BIN_ENTRY];
const HOME_DIR = '/home/user';
const NOW = Date.parse('2026-10-16T03:00:00Z');
const CUTOFF = '2026-10-15T00:00:00Z';
const LSTART_OLD = 'Tue Oct 14 09:00:00 2026';
const LSTART_NEW = 'Fri Oct 16 09:00:00 2026';
const HOUR = 3_600_000;
const SUPERVISOR_LEASE = Object.freeze({
  sessionId: '0a1b2c3d-1111-4222-8333-444455556666',
  pid: 4242,
  processStartSeconds: new Date('Tue Oct 14 09:00:00 2026').getTime() / 1000,
  nonce: 'lease-nonce-1',
});

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

test('resolveSupervisorLease names the session only from the lease the supervisor itself holds', async t => {
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
  const lease = (pid, nonce, start = startedAtMs / 1000) => ({
    version: 1, pid, processStartSeconds: start, nonce, createdAt: NOW,
  });
  const resolve = (pid, at = startedAtMs) => resolveSupervisorLease({ storePath, pid, startedAtMs: at });
  // The legacy fleet_exhausted path holds claimSessionLease() — owner =
  // the supervisor's own pid + process start — for the whole wait.
  await writePrivate(join(leaseDir, SESSION_A), lease(4242, 'n1'));
  // A rescuer (another process) holding a lease is NOT a supervisor lease.
  await writePrivate(join(leaseDir, SESSION_B), lease(5151, 'n2'));
  await writePrivate(join(leaseDir, 'not-a-session'), lease(4242, 'n3'));

  assert.deepEqual(await resolve(4242), {
    sessionId: SESSION_A, pid: 4242, processStartSeconds: startedAtMs / 1000, nonce: 'n1',
  });
  assert.equal((await resolve(4242, startedAtMs + 1500))?.sessionId, SESSION_A, 'within the 2s start tolerance');
  // Same pid, different process start: a recycled pid is not the owner.
  assert.equal(await resolve(4242, startedAtMs + 60_000), null);
  // A supervisor whose session is leased by the rescuer has no lease of its own.
  assert.equal(await resolve(9999), null);

  // The hook session store is never consulted: a matching record without a
  // lease does not make a target.
  await writePrivate(storePath, {
    sessions: { [SESSION_C]: { sessionId: SESSION_C, pid: 7070, pidStartSeconds: startedAtMs / 1000 } },
  });
  assert.equal(await resolve(7070), null);

  // A lease without a nonce cannot be re-verified later.
  await writePrivate(join(leaseDir, SESSION_C), { version: 1, pid: 6060, processStartSeconds: startedAtMs / 1000 });
  assert.equal(await resolve(6060), null);

  // Two leases held by one supervisor are ambiguous.
  await writePrivate(join(leaseDir, SESSION_C), lease(4242, 'n4'));
  assert.equal(await resolve(4242), null);
});

// ── runCloudSidecar ─────────────────────────────────────────

function supervisor(pid, { lstart = LSTART_OLD, args = '', ppid = 1 } = {}) {
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
    selfEnv: { HOME: HOME_DIR, PATH: '/usr/bin' },
    // The fence re-reads the supervisor lease and the session transcript.
    readLease: async () => ({ ...SUPERVISOR_LEASE }),
    transcriptBlocked: async () => true,
    resolvePath: async path => path,
    readProcessEnvText: async (pid, proc) => `${proc.command} PATH=/usr/bin HOME=${HOME_DIR} TEAMCLAUDE_PROVIDER=anthropic`,
    listProcesses: async () => processes.map(p => ({ ...p })),
    listProcessesSync: () => processes.map(p => ({ ...p })),
    fetchStatus: async () => exhaustedStatus(),
    readCwd: async () => '/work/project',
    resolveSupervisorLease: async () => ({ ...SUPERVISOR_LEASE }),
    claimOnce: async sessionId => {
      calls.push(['claim', sessionId]);
      return { dev: 1, ino: 2 };
    },
    releaseClaim: async (sessionId, claim) => {
      calls.push(['release', sessionId, claim]);
      return true;
    },
    // Every signal is recorded as 'signal'; only SIGTERM counts as a kill
    // (and ends the fake process).
    kill: async (pid, signal) => {
      calls.push(['signal', pid, signal]);
      if (signal !== 'SIGTERM') return;
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

test('runCloudSidecar skips a supervisor that holds no unique recovery lease (e.g. not under cmux)', async () => {
  const h = harness({ deps: { resolveSupervisorLease: async () => null } });
  await runCloudSidecar(h.deps);
  assertNoSideEffects(h);
  assert.equal(h.count('attempt'), 0);
});

test('runCloudSidecar takes the session from the supervisor lease and never from argv', async () => {
  const seen = [];
  const h = harness({
    // A prompt that mentions --resume, and a different resume ID, change nothing.
    processes: [supervisor(4242, { args: `--resume ${SESSION_B} fix --resume ${SESSION_C} please` })],
    deps: {
      resolveSupervisorLease: async ({ pid, startedAtMs }) => {
        seen.push([pid, startedAtMs]);
        return { ...SUPERVISOR_LEASE };
      },
    },
  });
  await runCloudSidecar(h.deps);
  assert.deepEqual(seen, [[4242, new Date(LSTART_OLD).getTime()]]);
  assert.deepEqual(h.calls.find(call => call[0] === 'claim'), ['claim', SESSION_A]);
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
    assert.equal(h.count('signal'), 0, 'no signal at all');
    assert.deepEqual(h.calls.find(call => call[0] === 'release'), ['release', SESSION_A, { dev: 1, ino: 2 }]);
    assert.equal(result.handoffs, 0);
  }
});

test('runCloudSidecar keeps the claim and does not launch when the supervisor survives SIGTERM', async () => {
  const h = harness({
    deps: {
      kill: async (pid, signal) => {
        h.calls.push(['signal', pid, signal]);
        if (signal === 'SIGTERM') h.calls.push(['kill', pid, signal]);
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

test('runCloudSidecar never touches a supervisor that may belong to another pool', async () => {
  for (const env of [
    `PATH=/usr/bin HOME=${HOME_DIR} TEAMCLAUDE_CONFIG=/cfg/other.json`,
    `PATH=/usr/bin HOME=${HOME_DIR} TEAMCLAUDE_PROVIDER=codex`,
    `PATH=/usr/bin HOME=${HOME_DIR} XDG_CONFIG_HOME=/xdg`,
    // Environment not visible (another uid): only argv comes back.
    '',
  ]) {
    const h = harness({
      deps: { readProcessEnvText: async (pid, proc) => `${proc.command}${env ? ` ${env}` : ''}` },
    });
    await runCloudSidecar(h.deps);
    assertNoSideEffects(h);
    assert.equal(h.count('attempt'), 0, env);
  }
  for (const readProcessEnvText of [async () => null, async () => {
    throw new Error('ps failed');
  }]) {
    const h = harness({ deps: { readProcessEnvText } });
    await runCloudSidecar(h.deps);
    assert.equal(h.count('attempt'), 0);
  }
});

test('runCloudSidecar is a no-op unless the sidecar itself runs the default Claude pool', async () => {
  for (const selfEnv of [
    { HOME: HOME_DIR, TEAMCLAUDE_CONFIG: '/cfg/teamclaude.json' },
    { HOME: HOME_DIR, TEAMCLAUDE_CONFIG: '' },
    { HOME: HOME_DIR, XDG_CONFIG_HOME: '/xdg' },
    { HOME: HOME_DIR, TEAMCLAUDE_PROVIDER: 'codex' },
  ]) {
    const h = harness({ deps: { selfEnv } });
    await runCloudSidecar(h.deps);
    assertNoSideEffects(h);
    assert.equal(h.count('attempt'), 0, JSON.stringify(Object.keys(selfEnv)));
  }
  for (const selfEnv of [{ HOME: HOME_DIR, TEAMCLAUDE_PROVIDER: 'anthropic' }, {}]) {
    const ok = harness({ deps: { selfEnv } });
    await runCloudSidecar(ok.deps);
    assert.equal(ok.count('launch'), 1);
  }
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

// ── default-pool proof from the raw ps -wwE text ────────────

test('provesDefaultPool accepts only a provable default-config, same-HOME Claude process', () => {
  const cmd = `${NODE} ${ENTRY} run`;
  const ok = text => provesDefaultPool(text, cmd).ok;
  assert.equal(ok(`${cmd} PATH=/usr/bin HOME=${HOME_DIR} SHELL=/bin/zsh`), true);
  assert.equal(ok(`${cmd} PATH=/usr/bin HOME=${HOME_DIR}`), true);
  assert.equal(ok(`${cmd} HOME=${HOME_DIR} TEAMCLAUDE_PROVIDER=anthropic PATH=/usr/bin`), true);
  assert.equal(ok(`${cmd} HOME=${HOME_DIR} TEAMCLAUDE_PROVIDER=anthropic`), true);
  // A space inside an unrelated value is irrelevant.
  assert.equal(ok(`${cmd} PS1=a b HOME=${HOME_DIR}`), true);
});

test('provesDefaultPool rejects any config override key anywhere in the text', () => {
  const cmd = `${NODE} ${ENTRY} run`;
  const ok = text => provesDefaultPool(text, cmd).ok;
  assert.equal(ok(`${cmd} HOME=${HOME_DIR} TEAMCLAUDE_CONFIG=/cfg/teamclaude.json`), false);
  // A NAME=-shaped tail on a space-containing path cannot hide the key.
  assert.equal(ok(`${cmd} HOME=${HOME_DIR} TEAMCLAUDE_CONFIG=/cfg/teamclaude.json archive/POOL=b.json`), false);
  // A fake key inside another value (or in argv) still disqualifies.
  assert.equal(ok(`${cmd} NOTE=xTEAMCLAUDE_CONFIG=/cfg/a.json HOME=${HOME_DIR}`), false);
  assert.equal(ok(`${cmd} --note TEAMCLAUDE_CONFIG=/cfg/a.json HOME=${HOME_DIR}`), false);
  assert.equal(ok(`${cmd} HOME=${HOME_DIR} XDG_CONFIG_HOME=/xdg`), false);
});

test('provesDefaultPool admits TEAMCLAUDE_PROVIDER only as one exact anthropic entry', () => {
  const cmd = `${NODE} ${ENTRY} run`;
  const ok = text => provesDefaultPool(text, cmd).ok;
  assert.equal(ok(`${cmd} HOME=${HOME_DIR} TEAMCLAUDE_PROVIDER=codex`), false);
  assert.equal(ok(`${cmd} HOME=${HOME_DIR} TEAMCLAUDE_PROVIDER=anthropicx`), false);
  assert.equal(ok(`${cmd} HOME=${HOME_DIR} TEAMCLAUDE_PROVIDER=`), false);
  assert.equal(ok(`${cmd} HOME=${HOME_DIR} NOTE=TEAMCLAUDE_PROVIDER=anthropic`), false);
  assert.equal(ok(`${cmd} HOME=${HOME_DIR} TEAMCLAUDE_PROVIDER=anthropic TEAMCLAUDE_PROVIDER=codex`), false);
});

test('provesDefaultPool does not judge HOME but requires a visible environment', () => {
  const cmd = `${NODE} ${ENTRY} run`;
  const ok = text => provesDefaultPool(text, cmd).ok;
  // HOME is not judged from text: the supervisor lease being in the
  // sidecar's own store (under its own homedir) is the evidence instead.
  assert.equal(ok(`${cmd} PATH=/usr/bin HOME=/home/other`), true);
  assert.equal(ok(`${cmd} JAVA_HOME=/opt/java HOME=${HOME_DIR} HOME=x`), true);
  assert.equal(ok(`${cmd} PATH=/usr/bin`), true);
  // No visible environment, or text that is not this command line.
  assert.equal(ok(cmd), false);
  assert.equal(ok(`${cmd} `), false);
  assert.equal(ok(`${cmd} stray`), false);
  assert.equal(ok(`other command PATH=/usr/bin`), false);
  assert.equal(ok(''), false);
  assert.equal(ok(null), false);
  assert.equal(provesDefaultPool(`${cmd} PATH=/usr/bin`, '').ok, false);
});

// ── SIGSTOP fence around the final check ───────────────────

function signals(h) {
  return h.calls.filter(call => call[0] === 'signal').map(call => call[2]);
}

test('runCloudSidecar fences the final check with SIGSTOP and sends STOP, TERM, CONT in order', async () => {
  const h = harness();
  const result = await runCloudSidecar(h.deps);
  assert.equal(result.handoffs, 1);
  assert.deepEqual(signals(h), ['SIGSTOP', 'SIGTERM', 'SIGCONT']);
  const order = h.calls
    .filter(call => ['claim', 'signal', 'launch'].includes(call[0]))
    .map(call => (call[0] === 'signal' ? call[2] : call[0]));
  assert.deepEqual(order, ['claim', 'SIGSTOP', 'SIGTERM', 'SIGCONT', 'launch']);
});

test('runCloudSidecar sends no signal when a child appears during the final status fetch', async () => {
  let calls = 0;
  const h = harness();
  h.deps.fetchStatus = async () => {
    calls += 1;
    if (calls === 2) {
      h.processes.push({ pid: 5000, ppid: 4242, lstart: LSTART_OLD, startedAtMs: 0, command: 'claude' });
    }
    return exhaustedStatus();
  };
  const result = await runCloudSidecar(h.deps);
  assert.equal(calls, 2);
  assert.equal(h.count('launch'), 0);
  assert.deepEqual(signals(h), []);
  assert.deepEqual(h.calls.find(call => call[0] === 'release'), ['release', SESSION_A, { dev: 1, ino: 2 }]);
  assert.equal(result.handoffs, 0);
});

test('runCloudSidecar sends no signal at all when the pid was reused during the final status fetch', async () => {
  let calls = 0;
  const h = harness();
  h.deps.fetchStatus = async () => {
    calls += 1;
    if (calls === 2) h.processes[0] = supervisor(4242, { lstart: 'Thu Oct 15 11:00:00 2026' });
    return exhaustedStatus();
  };
  await runCloudSidecar(h.deps);
  assert.deepEqual(signals(h), []);
  assert.equal(h.count('launch'), 0);
  assert.equal(h.count('release'), 1);
});

test('runCloudSidecar checks synchronously after the status fetch, then stops at once', async () => {
  const order = [];
  const h = harness();
  const fetchStatus = h.deps.fetchStatus;
  h.deps.fetchStatus = async () => {
    order.push('status');
    return fetchStatus();
  };
  const listSync = h.deps.listProcessesSync;
  h.deps.listProcessesSync = () => {
    order.push('ps-sync');
    return listSync();
  };
  const kill = h.deps.kill;
  h.deps.kill = async (pid, signal) => {
    order.push(signal);
    return kill(pid, signal);
  };
  await runCloudSidecar(h.deps);
  // scan status, final status, sync check, STOP, check under STOP, TERM, CONT
  assert.deepEqual(order, ['status', 'status', 'ps-sync', 'SIGSTOP', 'ps-sync', 'SIGTERM', 'SIGCONT']);
});

test('runCloudSidecar resumes with SIGCONT when the check under SIGSTOP fails', async () => {
  const h = harness();
  const kill = h.deps.kill;
  h.deps.kill = async (pid, signal) => {
    // A child spawned in the last instant before the freeze.
    if (signal === 'SIGSTOP') {
      h.processes.push({ pid: 5000, ppid: 4242, lstart: LSTART_OLD, startedAtMs: 0, command: 'claude' });
    }
    return kill(pid, signal);
  };
  await runCloudSidecar(h.deps);
  assert.equal(h.count('kill'), 0);
  assert.deepEqual(signals(h), ['SIGSTOP', 'SIGCONT']);
  assert.equal(h.count('release'), 1);
});

test('runCloudSidecar always sends SIGCONT after SIGSTOP, even when the check throws', async () => {
  let lists = 0;
  const h = harness();
  const list = h.deps.listProcessesSync;
  h.deps.listProcessesSync = () => {
    lists += 1;
    // 1: before SIGSTOP, 2: the check under SIGSTOP.
    if (lists === 2) throw new Error('ps failed');
    return list();
  };
  await runCloudSidecar(h.deps);
  assert.equal(h.count('kill'), 0);
  assert.deepEqual(signals(h), ['SIGSTOP', 'SIGCONT']);
  assert.equal(h.count('release'), 1);
});

test('runCloudSidecar sends nothing else when SIGSTOP itself fails', async () => {
  const h = harness();
  const kill = h.deps.kill;
  h.deps.kill = async (pid, signal) => {
    if (signal === 'SIGSTOP') {
      h.calls.push(['signal', pid, signal]);
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    }
    return kill(pid, signal);
  };
  await runCloudSidecar(h.deps);
  assert.deepEqual(signals(h), ['SIGSTOP']);
  assert.equal(h.count('release'), 1);
});

// ── fence: lease ownership and transcript state ─────────────

test('runCloudSidecar aborts under SIGSTOP when the lease changed hands during preparation', async () => {
  for (const lease of [
    { ...SUPERVISOR_LEASE, pid: 5151, nonce: 'rescuer-nonce' },
    { ...SUPERVISOR_LEASE, nonce: 'lease-nonce-2' },
    { ...SUPERVISOR_LEASE, processStartSeconds: SUPERVISOR_LEASE.processStartSeconds + 60 },
    null,
  ]) {
    const h = harness({ deps: { readLease: async () => lease } });
    const result = await runCloudSidecar(h.deps);
    assert.equal(h.count('kill'), 0, JSON.stringify(lease));
    assert.equal(h.count('launch'), 0);
    assert.deepEqual(signals(h), ['SIGSTOP', 'SIGCONT']);
    assert.deepEqual(h.calls.find(call => call[0] === 'release'), ['release', SESSION_A, { dev: 1, ino: 2 }]);
    assert.equal(result.handoffs, 0);
  }
  const throwing = harness({
    deps: {
      readLease: async () => {
        throw new Error('EACCES');
      },
    },
  });
  await runCloudSidecar(throwing.deps);
  assert.equal(throwing.count('kill'), 0);
  assert.deepEqual(signals(throwing), ['SIGSTOP', 'SIGCONT']);
});

test('runCloudSidecar re-reads the lease of the session it claimed', async () => {
  const seen = [];
  const h = harness({
    deps: {
      readLease: async sessionId => {
        seen.push(sessionId);
        return { ...SUPERVISOR_LEASE };
      },
    },
  });
  await runCloudSidecar(h.deps);
  assert.deepEqual(seen, [SESSION_A]);
  assert.equal(h.count('launch'), 1);
});

test('runCloudSidecar never stops a session whose transcript moved on after the error', async () => {
  for (const verdict of [false, null, undefined]) {
    const h = harness({ deps: { transcriptBlocked: async () => verdict } });
    await runCloudSidecar(h.deps);
    assert.equal(h.count('kill'), 0);
    assert.equal(h.count('launch'), 0);
    assert.equal(h.count('attempt'), 0, 'checked before any snapshot or push');
  }
  // The transcript moves on while the handoff is being prepared.
  let checks = 0;
  const h = harness({
    deps: {
      transcriptBlocked: async () => {
        checks += 1;
        return checks === 1;
      },
    },
  });
  await runCloudSidecar(h.deps);
  assert.equal(checks, 2);
  assert.equal(h.count('kill'), 0);
  assert.equal(h.count('launch'), 0);
  assert.deepEqual(signals(h), ['SIGSTOP', 'SIGCONT']);
  assert.equal(h.count('release'), 1);

  const throwing = harness();
  let calls = 0;
  throwing.deps.transcriptBlocked = async () => {
    calls += 1;
    if (calls === 2) throw new Error('unreadable');
    return true;
  };
  await runCloudSidecar(throwing.deps);
  assert.equal(throwing.count('kill'), 0);
  assert.deepEqual(signals(throwing), ['SIGSTOP', 'SIGCONT']);
});

test('runCloudSidecar proceeds while the transcript still ends in the unresolved exhaustion error', async () => {
  const seen = [];
  const h = harness({
    deps: {
      transcriptBlocked: async sessionId => {
        seen.push(sessionId);
        return true;
      },
    },
  });
  const result = await runCloudSidecar(h.deps);
  assert.deepEqual(seen, [SESSION_A, SESSION_A]);
  assert.equal(result.handoffs, 1);
  assert.deepEqual(signals(h), ['SIGSTOP', 'SIGTERM', 'SIGCONT']);
});

test('unresolvedExhaustionErrorState is set only while an exhaustion error is the last word', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-sidecar-transcript-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'project');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${SESSION_A}.jsonl`);
  const write = async records => {
    await writeFile(path, `${records.map(r => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  };
  const user = text => ({ type: 'user', message: { role: 'user', content: text } });
  const assistant = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const fleetExhausted = {
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'rate_limit_error',
    apiErrorStatus: 429,
    message: {
      role: 'assistant',
      content: [{
        type: 'text',
        text: 'API Error: Server is temporarily limiting requests (not your usage limit) · All 4 accounts exhausted. Retry in 7200s.',
      }],
    },
  };
  const usageLimit = {
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'rate_limit',
    apiErrorStatus: 429,
    message: {
      role: 'assistant',
      content: [{
        type: 'text',
        text: "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.",
      }],
    },
  };
  const loginExpired = {
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'authentication_failed',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Login expired · Please run /login' }] },
  };
  const blocked = async () => Boolean(await unresolvedExhaustionErrorState(path, root, SESSION_A));

  await write([user('일 해 줘'), assistant('네'), fleetExhausted]);
  assert.equal(await blocked(), true, 'unresolved fleet exhaustion');
  await write([user('일 해 줘'), assistant('네'), usageLimit]);
  assert.equal(await blocked(), true, 'unresolved usage limit');
  await write([user('일 해 줘'), fleetExhausted, user('계속'), assistant('진행합니다')]);
  assert.equal(await blocked(), false, 'conversation continued after the error');
  await write([user('일 해 줘'), assistant('완료')]);
  assert.equal(await blocked(), false, 'no error at all');
  await write([user('일 해 줘'), loginExpired]);
  assert.equal(await blocked(), false, 'a non-exhaustion error does not count');
  assert.equal(Boolean(await unresolvedExhaustionErrorState(join(dir, 'missing.jsonl'), root, SESSION_A)), false);
});
