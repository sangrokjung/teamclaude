import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function unusedPort() {
  const holder = http.createServer();
  const port = await listen(holder);
  await close(holder);
  return port;
}

async function waitUntil(check, message, timeoutMs = 5000) {
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

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function externalIPv4() {
  return Object.values(networkInterfaces())
    .flat()
    .find(address => address
      && (address.family === 'IPv4' || address.family === 4)
      && !address.internal)?.address;
}

function request({ host = '127.0.0.1', port, path, method = 'GET', headers, body, agent }) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host, port, path, method, headers, agent }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString(),
      }));
      res.once('error', reject);
    });
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

async function stopChild(child) {
  if (child.exitCode != null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, delay(6500)]);
  if (child.exitCode == null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

test('proxy worker crash keeps the listener alive and restarts without ConnectionRefused', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-supervisor-'));
  const configPath = join(dir, 'config.json');
  const statePath = join(dir, 'config.server.json');
  const port = await unusedPort();
  let upstreamHits = 0;
  let upstreamBody = null;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamHits += 1;
    upstreamBody = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'continued' }] }));
  });
  const upstreamPort = await listen(upstream);
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'test-api-key' }],
  }));

  const child = spawn(process.execPath, [entry, 'server'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitUntil(() => status(port), 'proxy did not start');
    const initial = await waitUntil(
      () => readState(statePath),
      'server state was not written',
    );
    assert.equal(initial.pid, child.pid);
    assert.ok(
      Number.isInteger(initial.workerPid),
      'server state must expose a supervised worker PID so a worker crash is distinguishable from a full proxy stop',
    );

    process.kill(initial.workerPid, 'SIGKILL');
    const payload = { model: 'test-model', messages: [{ role: 'user', content: 'continue' }] };
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200, 'the supervisor listener must hold the request until a replacement worker is ready');
    assert.equal((await response.json()).content[0].text, 'continued');
    assert.equal(upstreamHits, 1);
    assert.deepEqual(upstreamBody, payload);
    await waitUntil(
      () => !isPidAlive(initial.workerPid),
      'crashed worker remained alive',
    );

    const recovered = await waitUntil(async () => {
      const next = await readState(statePath);
      return next?.workerPid !== initial.workerPid ? next : null;
    }, 'replacement worker was not recorded');
    assert.equal(recovered.pid, child.pid);
    assert.ok(isPidAlive(recovered.workerPid));
    assert.equal(child.exitCode, null, 'the supervisor process must survive a worker crash');
  } finally {
    await stopChild(child);
    await close(upstream);
    await rm(dir, { recursive: true, force: true });
  }
});

test('cleanly exited proxy worker restarts without closing the public listener', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-supervisor-clean-exit-'));
  const configPath = join(dir, 'config.json');
  const statePath = join(dir, 'config.server.json');
  const port = await unusedPort();
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'test-api-key' }],
  }));

  const child = spawn(process.execPath, [entry, 'server'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitUntil(() => status(port), 'proxy did not start');
    const initial = await waitUntil(() => readState(statePath), 'server state was not written');

    process.kill(initial.workerPid, 'SIGINT');
    await waitUntil(
      () => !isPidAlive(initial.workerPid),
      'cleanly exited worker remained alive',
    );

    const response = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200,
      'the supervisor listener must hold requests while a cleanly exited worker is replaced');

    const recovered = await waitUntil(async () => {
      const next = await readState(statePath);
      return next?.workerPid !== initial.workerPid ? next : null;
    }, 'replacement worker was not recorded');
    assert.equal(recovered.pid, child.pid);
    assert.ok(isPidAlive(recovered.workerPid));
    assert.equal(child.exitCode, null,
      'the supervisor process must survive a clean worker exit');
  } finally {
    await stopChild(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test('unresponsive proxy worker is replaced while the public listener stays available', { timeout: 15000 }, async t => {
  if (process.platform === 'win32') {
    t.skip('SIGSTOP is not available on Windows');
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-supervisor-health-'));
  const configPath = join(dir, 'config.json');
  const statePath = join(dir, 'config.server.json');
  const port = await unusedPort();
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    workerHealthIntervalMs: 50,
    workerHealthTimeoutMs: 100,
    workerHealthFailureThreshold: 2,
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'test-api-key' }],
  }));

  const child = spawn(process.execPath, [entry, 'server'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stoppedWorkerPid = null;

  try {
    await waitUntil(() => status(port), 'proxy did not start');
    const initial = await waitUntil(() => readState(statePath), 'server state was not written');
    stoppedWorkerPid = initial.workerPid;
    process.kill(stoppedWorkerPid, 'SIGSTOP');

    const response = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, {
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 200,
      'the supervisor must recover a hung worker before Claude Code exhausts its retries');

    const recovered = await waitUntil(async () => {
      const next = await readState(statePath);
      return next?.workerPid !== stoppedWorkerPid ? next : null;
    }, 'unresponsive worker was not replaced');
    assert.ok(isPidAlive(recovered.workerPid));
    assert.equal(child.exitCode, null, 'the public listener must survive worker recovery');
  } finally {
    if (stoppedWorkerPid && isPidAlive(stoppedWorkerPid)) {
      try { process.kill(stoppedWorkerPid, 'SIGKILL'); } catch {}
    }
    await stopChild(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test('supervisor preserves proxy API-key authentication for remote clients', { timeout: 15000 }, async t => {
  const host = externalIPv4();
  if (!host) {
    t.skip('no non-loopback IPv4 interface is available');
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-supervisor-auth-'));
  const configPath = join(dir, 'config.json');
  const port = await unusedPort();
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-remote-auth' },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'test-api-key' }],
  }));

  const child = spawn(process.execPath, [entry, 'server'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitUntil(() => status(port), 'proxy did not start');
    const unauthenticated = await request({
      host,
      port,
      path: '/teamclaude/status',
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(JSON.parse(unauthenticated.body).error.type, 'authentication_error');

    const authenticated = await request({
      host,
      port,
      path: '/teamclaude/status',
      headers: { 'x-api-key': 'tc-remote-auth' },
    });
    assert.equal(authenticated.status, 200);
    assert.equal(JSON.parse(authenticated.body).accounts.length, 1);
  } finally {
    await stopChild(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test('supervisor preserves worker session affinity for a public keep-alive connection', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-supervisor-affinity-'));
  const configPath = join(dir, 'config.json');
  const port = await unusedPort();
  const served = [];
  const reset = String(Math.floor((Date.now() + 60 * 60 * 1000) / 1000));
  const upstream = http.createServer((req, res) => {
    served.push(req.headers['x-api-key']);
    res.writeHead(200, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-5h-reset': reset,
    });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    reevalIntervalMs: 1,
    accounts: [
      { name: 'api-a', type: 'apikey', apiKey: 'account-a' },
      { name: 'api-b', type: 'apikey', apiKey: 'account-b' },
    ],
  }));

  const child = spawn(process.execPath, [entry, 'server'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const call = () => request({
    port,
    path: '/v1/messages',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    agent,
  });

  try {
    await waitUntil(() => status(port), 'proxy did not start');
    await call();
    await call();
    await call();
    await delay(5);
    await call();
    await call();

    assert.equal(new Set(served.slice(0, 2)).size, 2, 'cold-start warm-up must measure both accounts');
    assert.equal(served.length, 5);
    assert.ok(
      served.slice(2).every(key => key === served[2]),
      'all measured turns on one public keep-alive socket must retain one worker account',
    );
  } finally {
    agent.destroy();
    await stopChild(child);
    await close(upstream);
    await rm(dir, { recursive: true, force: true });
  }
});

test('teamclaude run starts a missing proxy before launching Claude Code', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-run-autostart-'));
  const configPath = join(dir, 'config.json');
  const fakeClaude = join(dir, 'claude');
  const port = await unusedPort();
  await writeFile(fakeClaude, `#!/usr/bin/env node
const response = await fetch(process.env.ANTHROPIC_BASE_URL + '/teamclaude/status');
const body = await response.json();
console.log(JSON.stringify({ ok: response.ok, accounts: body.accounts.length }));
`);
  await chmod(fakeClaude, 0o755);
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'test-api-key' }],
  }));

  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    TEAMCLAUDE_CONFIG: configPath,
  };

  try {
    const result = spawnSync(process.execPath, [entry, 'run'], {
      encoding: 'utf8',
      env,
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { ok: true, accounts: 1 });
  } finally {
    spawnSync(process.execPath, [entry, 'stop'], {
      encoding: 'utf8',
      env,
      timeout: 10000,
    });
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI remove reloads the live worker while preserving the public supervisor', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-live-remove-'));
  const configPath = join(dir, 'config.json');
  const statePath = join(dir, 'config.server.json');
  const port = await unusedPort();
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    accounts: [
      { name: 'keep', type: 'apikey', apiKey: 'key-a' },
      { name: 'remove-me', type: 'apikey', apiKey: 'key-b' },
    ],
  }));
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
  const child = spawn(process.execPath, [entry, 'server'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitUntil(() => status(port), 'proxy did not start');
    const initial = await waitUntil(() => readState(statePath), 'server state was not written');

    const result = spawnSync(process.execPath, [entry, 'remove', 'remove-me'], {
      encoding: 'utf8',
      env,
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);

    const reloaded = await waitUntil(async () => {
      const response = await status(port);
      if (!response) return null;
      const body = await response.json();
      const state = await readState(statePath);
      return body.accounts.length === 1
        ? { body, state }
        : null;
    }, 'live worker did not apply the removed account', 8000);

    assert.equal(reloaded.state.pid, initial.pid, 'public supervisor PID must stay stable');
    assert.equal(reloaded.state.pid, child.pid);
    assert.equal(reloaded.state.workerPid, initial.workerPid,
      'account-only reload must preserve the worker and active connections');
    assert.deepEqual(reloaded.body.accounts.map(account => account.name), ['keep']);

    const removeLast = spawnSync(process.execPath, [entry, 'remove', 'keep'], {
      encoding: 'utf8',
      env,
      timeout: 10_000,
    });
    assert.equal(removeLast.status, 0, removeLast.stderr);
    await waitUntil(async () => {
      const response = await status(port);
      if (!response) return false;
      return (await response.json()).accounts.length === 0;
    }, 'last account removal was not applied live');
    const unavailable = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [] }),
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(unavailable.status, 429, 'zero-account proxy must fail promptly, not hang');
    assert.equal((await readState(statePath)).workerPid, initial.workerPid);
  } finally {
    await stopChild(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test('live account removal lowers the supervisor admission cap', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-live-capacity-'));
  const configPath = join(dir, 'config.json');
  const port = await unusedPort();
  let upstreamHits = 0;
  const upstream = http.createServer(() => {
    upstreamHits += 1;
  });
  const upstreamPort = await listen(upstream);
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    maxConcurrentPerAccount: 1,
    overflowQueueMaxDepth: 0,
    accounts: [
      { name: 'keep', type: 'apikey', apiKey: 'key-a' },
      { name: 'remove-me', type: 'apikey', apiKey: 'key-b' },
    ],
  }));
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
  const child = spawn(process.execPath, [entry, 'server'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const firstAbort = new AbortController();
  let firstRequest = null;

  try {
    await waitUntil(() => status(port), 'proxy did not start');
    const removed = spawnSync(process.execPath, [entry, 'remove', 'remove-me'], {
      encoding: 'utf8',
      env,
      timeout: 10_000,
    });
    assert.equal(removed.status, 0, removed.stderr);
    await waitUntil(async () => {
      const response = await status(port);
      return response && (await response.json()).accounts.length === 1;
    }, 'live worker did not apply the removed account', 8000);

    firstRequest = fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [] }),
      signal: firstAbort.signal,
    }).catch(() => null);
    await waitUntil(() => upstreamHits === 1, 'first request did not reach upstream');

    const rejected = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [] }),
      signal: AbortSignal.timeout(2000),
    });
    const body = await rejected.json();
    assert.equal(rejected.status, 429);
    assert.equal(body.error?.message, 'Proxy supervisor queue is full');
    assert.equal(upstreamHits, 1, 'the rejected request must not reach the worker or upstream');
  } finally {
    firstAbort.abort();
    await firstRequest;
    await stopChild(child);
    await close(upstream);
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI api uses the live proxy for relative paths instead of refreshing an expired token itself', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-live-api-'));
  const configPath = join(dir, 'config.json');
  const port = await unusedPort();
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    accounts: [{
      name: 'expired',
      type: 'oauth',
      accessToken: 'expired-access',
      refreshToken: 'must-not-be-used-by-cli',
      expiresAt: Date.now() - 60_000,
    }],
  }));
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
  const child = spawn(process.execPath, [entry, 'server'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitUntil(() => status(port), 'proxy did not start');
    const result = spawnSync(process.execPath, [entry, 'api', '/teamclaude/status'], {
      encoding: 'utf8',
      env,
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.accounts.length, 1);
    assert.equal(body.accounts[0].name, 'expired');

    const listed = spawnSync(process.execPath, [entry, 'accounts'], {
      encoding: 'utf8',
      env,
      timeout: 10_000,
    });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /token refresh managed by running proxy/);
    const persisted = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(persisted.accounts[0].refreshToken, 'must-not-be-used-by-cli',
      'accounts/api CLI must not rotate the running worker credential');
  } finally {
    await stopChild(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test('accounts does not attach a stale profile identity after a concurrent re-import', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-profile-cas-'));
  const configPath = join(dir, 'config.json');
  const preloadPath = join(dir, 'mock-profile.mjs');
  const startedPath = join(dir, 'profile-started');
  const releasePath = join(dir, 'profile-release');
  const port = await unusedPort();
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    accounts: [{
      name: 'same-name',
      type: 'oauth',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() + 3_600_000,
    }],
  }));
  await writeFile(preloadPath, `
import { existsSync, writeFileSync } from 'node:fs';
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input).includes('/api/oauth/profile')) {
    writeFileSync(${JSON.stringify(startedPath)}, '1');
    while (!existsSync(${JSON.stringify(releasePath)})) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return new Response(JSON.stringify({
      account: { uuid: 'old-uuid', email: 'old@example.invalid' },
      organization: { name: 'old-org' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};
`);
  const env = {
    ...process.env,
    TEAMCLAUDE_CONFIG: configPath,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${preloadPath}`.trim(),
  };
  const listing = spawn(process.execPath, [entry, 'accounts'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let listingStderr = '';
  listing.stderr.on('data', chunk => { listingStderr += chunk; });
  const listingExit = once(listing, 'exit');

  try {
    await waitUntil(async () => {
      try { await readFile(startedPath); return true; } catch { return false; }
    }, 'profile request did not start');

    const moduleUrl = new URL('../src/config.js', import.meta.url).href;
    const writer = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import { atomicConfigUpdate } from ${JSON.stringify(moduleUrl)};
      await atomicConfigUpdate(config => {
        const account = config.accounts.find(item => item.name === 'same-name');
        account.accessToken = 'new-access';
        account.refreshToken = 'new-refresh';
        account.accountUuid = 'new-uuid';
      });
    `], {
      encoding: 'utf8',
      env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
      timeout: 10_000,
    });
    assert.equal(writer.status, 0, writer.stderr);
    await writeFile(releasePath, '1');
    const [listingCode] = await listingExit;
    assert.equal(listingCode, 0, listingStderr);

    const final = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(final.accounts[0].accessToken, 'new-access');
    assert.equal(final.accounts[0].accountUuid, 'new-uuid',
      'old profile UUID must not be attached to the replacement credential');
  } finally {
    if (listing.exitCode == null) listing.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});
