import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function unusedPort() {
  const holder = http.createServer();
  const port = await listen(holder);
  await new Promise(resolve => holder.close(resolve));
  return port;
}

async function waitUntil(check, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  throw new Error(message);
}

async function status(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
    return response.ok ? response : null;
  } catch {
    return null;
  }
}

async function readState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function stopChild(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, delay(6500)]);
  if (child.exitCode == null && child.signalCode == null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

test('Codex subscription cancel and clear hot-reload without exposing credentials', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-live-subscription-'));
  const configPath = join(dir, 'teamcodex.json');
  const statePath = join(dir, 'teamcodex.server.json');
  const port = await unusedPort();
  await writeFile(configPath, JSON.stringify({
    provider: 'codex',
    proxy: { port, apiKey: 'test-api-key' },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    codexUsageRefresh: false,
    accounts: [{
      name: 'live-codex@example.com',
      email: 'live-codex@example.com',
      provider: 'codex',
      type: 'oauth',
      accountUuid: 'live-codex-uuid',
      accountId: 'live-codex-uuid',
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      idToken: 'test-id-value',
      expiresAt: Date.now() + 3_600_000,
    }],
  }));
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath, TZ: 'Asia/Seoul' };
  delete env.TEAMCLAUDE_SESSION_SUPERVISED;
  const child = spawn(process.execPath, [entry, 'codex', 'server'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitUntil(() => status(port), 'Codex proxy did not start');
    const initial = await waitUntil(() => readState(statePath), 'server state was not written');
    const cancel = spawnSync(process.execPath, [
      entry, 'codex', 'subscription', 'cancel', 'live-codex', '--ends-on', '2026-09-06',
      '--account-uuid', 'live-codex-uuid',
    ], { encoding: 'utf8', env, timeout: 10_000 });
    assert.equal(cancel.status, 0, cancel.stderr);

    const tracked = await waitUntil(async () => {
      const response = await status(port);
      if (!response) return null;
      const payload = await response.json();
      return payload.accounts[0]?.subscription?.state === 'cancellation-scheduled'
        ? payload : null;
    }, 'live worker did not apply subscription cancellation');
    assert.equal(tracked.accounts[0].subscription.endsAt, '2026-09-06T15:00:00.000Z');
    assert.equal((await readState(statePath)).workerPid, initial.workerPid);
    const publicJson = JSON.stringify(tracked);
    assert.doesNotMatch(publicJson, /test-access-token|test-refresh-token|test-id-value/);
    assert.equal('credential' in tracked.accounts[0], false);
    assert.equal('refreshToken' in tracked.accounts[0], false);

    const clearResult = spawnSync(process.execPath, [
      entry, 'codex', 'subscription', 'clear', 'live-codex',
      '--account-uuid', 'live-codex-uuid',
    ], { encoding: 'utf8', env, timeout: 10_000 });
    assert.equal(clearResult.status, 0, clearResult.stderr);
    await waitUntil(async () => {
      const response = await status(port);
      return response && (await response.json()).accounts[0]?.subscription?.state === 'active';
    }, 'live worker did not clear subscription cancellation');
    assert.equal((await readState(statePath)).workerPid, initial.workerPid);
  } finally {
    await stopChild(child);
    await rm(dir, { recursive: true, force: true });
  }
});
