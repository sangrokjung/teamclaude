import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeInfo, formatUptime } from '../src/runtime-info.js';

const T0 = Date.parse('2026-09-22T00:00:00.000Z');

test('runtimeInfo derives the artifact hash prefix from a deployer entry path', () => {
  const sha = 'eeb99bae2f5d54785f73f611bf45714f292c8d29e3823f19839e1f9a56085163';
  const info = runtimeInfo({
    env: {
      TEAMCLAUDE_SUPERVISOR_STARTED_AT: String(T0 - 60_000),
      TEAMCLAUDE_WORKER_RESTARTS: '3',
      TEAMCLAUDE_WORKER_LAST_RESTART_AT: String(T0 - 5_000),
      TEAMCLAUDE_WORKER_LAST_RESTART_REASON: 'health-check',
    },
    entry: `/opt/runtime/artifacts/${sha}/src/index.js`,
    now: T0 + 65 * 60_000,
    workerStartedAt: T0,
    packageVersion: '1.3.0',
  });
  assert.deepEqual(info, {
    version: '1.3.0',
    artifact: 'eeb99bae2f5d',
    entry: `/opt/runtime/artifacts/${sha}/src/index.js`,
    workerStartedAt: '2026-09-22T00:00:00.000Z',
    supervisorStartedAt: '2026-09-21T23:59:00.000Z',
    uptimeMs: 65 * 60_000,
    workerRestarts: 3,
    lastWorkerRestartAt: '2026-09-21T23:59:55.000Z',
    lastWorkerRestartReason: 'health-check',
  });
});

test('runtimeInfo without supervisor env reports nulls, not NaN', () => {
  const info = runtimeInfo({ env: {}, entry: '/usr/lib/node_modules/teamcodex/src/index.js', now: T0 + 1000, workerStartedAt: T0, packageVersion: null });
  assert.equal(info.artifact, null);
  assert.equal(info.version, null);
  assert.equal(info.workerRestarts, null);
  assert.equal(info.lastWorkerRestartAt, null);
  assert.equal(info.lastWorkerRestartReason, null);
  assert.equal(info.supervisorStartedAt, null);
  assert.equal(info.uptimeMs, 1000);
});

test('formatUptime picks the two most significant units', () => {
  assert.equal(formatUptime(7 * 60_000), '7m');
  assert.equal(formatUptime(65 * 60_000), '1h 05m');
  assert.equal(formatUptime((3 * 24 + 2) * 3_600_000 + 15 * 60_000), '3d 02h');
  assert.equal(formatUptime(-5), '0m');
});
