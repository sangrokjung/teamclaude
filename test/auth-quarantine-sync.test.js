import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function unusedPort() {
  const holder = http.createServer();
  await new Promise(resolve => holder.listen(0, '127.0.0.1', resolve));
  const { port } = holder.address();
  await new Promise(resolve => holder.close(resolve));
  return port;
}

async function waitFor(read, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (value) return value;
    await delay(25);
  }
  throw new Error(message);
}

async function status(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, {
      headers: { 'x-teamcodex-status-identity': '1' },
    });
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

async function stop(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    delay(5000).then(() => {
      if (child.exitCode == null) child.kill('SIGKILL');
      return once(child, 'exit');
    }),
  ]);
}

test('SIGHUP does not replace a revoked legacy account with a same-name imported UUID', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-auth-sync-'));
  const configPath = join(dir, 'config.json');
  const statePath = join(dir, 'config.server.json');
  const port = await unusedPort();
  const now = Date.now();
  const legacy = {
    name: 'legacy@example.com',
    type: 'oauth',
    provider: 'anthropic',
    accountUuid: null,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: now + 3600_000,
    authRevoked: true,
    authRevokedAt: now - 1000,
  };
  const config = accounts => ({
    provider: 'anthropic',
    proxy: { port, apiKey: 'test-key' },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    tokenRefreshIntervalMs: 0,
    accounts,
  });
  await writeFile(configPath, JSON.stringify(config([legacy])));

  const child = spawn(process.execPath, [entry, 'server'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_PROVIDER: 'anthropic' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });

  try {
    const initial = await waitFor(() => status(port), 'proxy did not start');
    assert.equal(initial.accounts[0].errorReason, 'auth-revoked');
    const state = await waitFor(async () => {
      try { return JSON.parse(await readFile(statePath, 'utf8')); } catch { return null; }
    }, 'proxy worker state was not written');

    const foreignImport = {
      ...legacy,
      accountUuid: 'other-account-uuid',
      accessToken: 'other-access',
      refreshToken: 'other-refresh',
      source: 'import',
      authVerifiedAt: Date.now(),
      authVerifiedAccountUuid: 'other-account-uuid',
    };
    await writeFile(configPath, JSON.stringify(config([foreignImport])));
    process.kill(state.workerPid, 'SIGHUP');

    const reloaded = await waitFor(async () => {
      const current = await status(port);
      return output.includes('Applied account config without restarting the worker') ? current : null;
    }, 'proxy did not apply the account reload');
    assert.equal(reloaded.accounts[0].errorReason, 'auth-revoked');
    assert.equal(reloaded.accounts[0].usable, false);
    assert.doesNotMatch(output, /Refreshed credentials for "legacy@example\.com"/,
      'the unverified credential must not replace the live legacy account');
  } finally {
    await stop(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test('startup does not resolve importFrom for a quarantined legacy account', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-auth-startup-'));
  const configPath = join(dir, 'config.json');
  const port = await unusedPort();
  const now = Date.now();
  const legacy = {
    name: 'legacy@example.com',
    type: 'oauth',
    provider: 'anthropic',
    accountUuid: null,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: now + 3600_000,
    authRevoked: true,
    authRevokedAt: now - 1000,
    importFrom: join(dir, 'missing-credentials.json'),
  };
  await writeFile(configPath, JSON.stringify({
    provider: 'anthropic',
    proxy: { port, apiKey: 'test-key' },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    tokenRefreshIntervalMs: 0,
    accounts: [legacy],
  }));

  const child = spawn(process.execPath, [entry, 'server'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_PROVIDER: 'anthropic' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  try {
    const current = await waitFor(() => status(port), 'proxy did not start with a quarantined legacy credential');
    assert.equal(current.accounts[0].errorReason, 'auth-revoked');
    assert.equal(current.accounts[0].usable, false);
    assert.doesNotMatch(output, /Failed to import "legacy@example\.com"/,
      'startup must not read importFrom for a quarantined legacy row');
  } finally {
    await stop(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test('startup keeps a tokenless quarantined legacy account visible', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-auth-startup-empty-'));
  const configPath = join(dir, 'config.json');
  const port = await unusedPort();
  await writeFile(configPath, JSON.stringify({
    provider: 'anthropic',
    proxy: { port, apiKey: 'test-key' },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    tokenRefreshIntervalMs: 0,
    accounts: [{
      name: 'legacy@example.com',
      type: 'oauth',
      provider: 'anthropic',
      accountUuid: null,
      authRevoked: true,
      authRevokedAt: Date.now() - 1000,
      importFrom: join(dir, 'missing-credentials.json'),
    }],
  }));

  const child = spawn(process.execPath, [entry, 'server'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_PROVIDER: 'anthropic' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const current = await waitFor(() => status(port), 'proxy did not retain a tokenless quarantined account');
    assert.equal(current.accounts.length, 1);
    assert.equal(current.accounts[0].errorReason, 'auth-revoked');
    assert.equal(current.accounts[0].usable, false);
  } finally {
    await stop(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid_grant persistence conflict does not install an unverified foreign disk credential', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-auth-persist-race-'));
  const configPath = join(dir, 'config.json');
  const preloadPath = join(dir, 'delayed-invalid-grant.cjs');
  const refreshStartedPath = join(dir, 'refresh-started');
  const refreshReleasePath = join(dir, 'refresh-release');
  const port = await unusedPort();
  const now = Date.now();
  let upstreamPort;
  const primary = {
    name: 'primary@example.com',
    type: 'oauth',
    provider: 'anthropic',
    accountUuid: 'uuid-primary',
    accessToken: 'original-access',
    refreshToken: 'original-refresh',
    expiresAt: now - 1000,
  };
  const config = account => ({
    provider: 'anthropic',
    proxy: { port, apiKey: 'test-key' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    tokenRefreshIntervalMs: 0,
    continuityMode: false,
    accounts: [account],
  });
  const upstream = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = upstream.address().port;
  await writeFile(configPath, JSON.stringify(config(primary)));
  await writeFile(preloadPath, `
const { existsSync } = require('node:fs');
const { writeFile } = require('node:fs/promises');
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url) !== 'https://platform.claude.com/v1/oauth/token') {
    return originalFetch(url, options);
  }
  await writeFile(process.env.TEAMCLAUDE_AUTH_RACE_STARTED, 'started');
  while (!existsSync(process.env.TEAMCLAUDE_AUTH_RACE_RELEASE)) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return new Response('{"error":"invalid_grant"}', {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
};
`);

  const child = spawn(process.execPath, ['--require', preloadPath, entry, 'server'], {
    env: {
      ...process.env,
      TEAMCLAUDE_CONFIG: configPath,
      TEAMCLAUDE_PROVIDER: 'anthropic',
      TEAMCLAUDE_AUTH_RACE_STARTED: refreshStartedPath,
      TEAMCLAUDE_AUTH_RACE_RELEASE: refreshReleasePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  try {
    await waitFor(() => status(port), 'proxy did not start for persistence race');
    const request = fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', messages: [] }),
    });
    await waitFor(
      () => readFile(refreshStartedPath, 'utf8').then(() => true).catch(() => false),
      'OAuth refresh did not reach the delayed invalid_grant boundary',
    );

    const foreign = {
      ...primary,
      accessToken: 'foreign-access',
      refreshToken: 'foreign-refresh',
      expiresAt: now + 7200_000,
      source: 'import',
    };
    await writeFile(configPath, JSON.stringify(config(foreign)));
    await writeFile(refreshReleasePath, 'release');

    const response = await request;
    await response.text();
    assert.equal(response.status, 401);
    const current = await waitFor(async () => {
      const value = await status(port);
      return value?.accounts[0]?.errorReason === 'auth-revoked' ? value : null;
    }, 'invalid_grant did not leave the live account quarantined');
    assert.equal(current.accounts[0].usable, false);
    assert.doesNotMatch(output, /Updated tokens for account "primary@example\.com"/,
      'an unverified foreign disk credential must never be installed into the live account');

    const saved = JSON.parse(await readFile(configPath, 'utf8')).accounts[0];
    assert.equal(saved.authRevoked, true, 'the disk conflict must be re-quarantined');
  } finally {
    await stop(child);
    await new Promise(resolve => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
