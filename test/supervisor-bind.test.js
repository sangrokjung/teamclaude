import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

// The supervisor's public listener binds loopback only by default
// (127.0.0.1 and ::1), never the wildcard address. Extra hosts come from
// proxy.bindHosts; an unavailable extra host is skipped, while a loopback bind
// failure keeps the existing startup-failure path.

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = err => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

async function unusedPort() {
  const holder = http.createServer();
  const port = await listenOn(holder, 0, '127.0.0.1');
  await close(holder);
  return port;
}

async function canBind(host) {
  const probe = http.createServer();
  try {
    await listenOn(probe, 0, host);
    await close(probe);
    return true;
  } catch {
    return false;
  }
}

function hasLsof() {
  const result = spawnSync('lsof', ['-v'], { stdio: 'ignore' });
  return !result.error;
}

async function waitUntil(check, message, timeoutMs = 10000) {
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

async function startSupervisor(t, proxyExtra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-supervisor-bind-'));
  const home = join(dir, 'home');
  const configPath = join(dir, 'config.json');
  const port = proxyExtra.port ?? await unusedPort();
  await writeFile(configPath, JSON.stringify({
    proxy: { apiKey: 'tc-test', ...proxyExtra, port },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    codexUsageRefresh: false,
    continuityMode: false,
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'test-api-key' }],
  }));
  const child = spawn(process.execPath, [entry, 'server'], {
    env: {
      ...process.env,
      HOME: home,
      TEAMCLAUDE_PROVIDER: 'anthropic',
      TEAMCLAUDE_CONFIG: configPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { text: '' };
  child.stdout.on('data', chunk => { output.text += chunk; });
  child.stderr.on('data', chunk => { output.text += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => {
    await stopChild(child);
    await rm(dir, { recursive: true, force: true });
  });
  return { child, port, output, exited };
}

test('default bind listens on loopback only', { timeout: 30000 }, async t => {
  if (process.platform === 'win32' || !hasLsof()) {
    t.skip('lsof is not available');
    return;
  }
  const { child, port } = await startSupervisor(t);
  await waitUntil(() => status(port), 'proxy did not start');
  const listing = spawnSync('lsof', ['-nP', '-a', '-p', String(child.pid), '-iTCP', '-sTCP:LISTEN'], {
    encoding: 'utf8',
  }).stdout;
  assert.doesNotMatch(listing, /\*:/, listing);
  assert.match(listing, new RegExp(`127\\.0\\.0\\.1:${port}\\b`), listing);
  if (await canBind('::1')) {
    assert.match(listing, new RegExp(`\\[::1\\]:${port}\\b`), listing);
  }
});

test('skips unavailable host but keeps loopback', { timeout: 30000 }, async t => {
  if (await canBind('100.100.100.100')) {
    t.skip('100.100.100.100 is a local address on this host');
    return;
  }
  const { child, port, output } = await startSupervisor(t, {
    bindHosts: ['127.0.0.1', '100.100.100.100'],
  });
  await waitUntil(() => status(port), `proxy did not start:\n${output.text}`);
  await waitUntil(
    () => output.text.includes('Skipping bind 100.100.100.100'),
    `skip warning was not logged:\n${output.text}`,
  );
  assert.equal(child.exitCode, null);
  assert.ok(await status(port));
});

test('loopback EADDRINUSE keeps existing exit path', { timeout: 30000 }, async t => {
  const holder = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const port = await listenOn(holder, 0, '127.0.0.1');
  t.after(() => close(holder));
  const { output, exited } = await startSupervisor(t, { port });
  const [code] = await Promise.race([
    exited,
    delay(15000).then(() => { throw new Error(`supervisor did not exit:\n${output.text}`); }),
  ]);
  assert.equal(code, 1);
  assert.match(output.text, new RegExp(`Port ${port} is already in use`));
});

test('ipv6 loopback EADDRINUSE fails startup', { timeout: 30000 }, async t => {
  if (!(await canBind('::1'))) {
    t.skip('IPv6 loopback is not available');
    return;
  }
  const holder = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  // Pick a port free on both stacks, then hold it on ::1 only.
  let port;
  for (let attempt = 0; attempt < 20 && port == null; attempt += 1) {
    const candidate = await unusedPort();
    try {
      await listenOn(holder, candidate, '::1');
      port = candidate;
    } catch {
      // try another port
    }
  }
  assert.ok(port, 'could not reserve a ::1 port');
  t.after(() => close(holder));
  const { output, exited } = await startSupervisor(t, { port });
  const [code] = await Promise.race([
    exited,
    delay(15000).then(() => { throw new Error(`supervisor did not exit:\n${output.text}`); }),
  ]);
  assert.notEqual(code, 0);
  assert.match(output.text, new RegExp(`Port ${port} is already in use`));
});

test('wildcard plus same-family loopback starts with LAN bind', { timeout: 30000 }, async t => {
  const { child, port, output } = await startSupervisor(t, {
    bindHosts: ['0.0.0.0', '127.0.0.1'],
    allowLanBind: true,
  });
  await waitUntil(() => status(port), `proxy did not start:\n${output.text}`);
  assert.equal(child.exitCode, null);
  assert.doesNotMatch(output.text, /already in use/);
  assert.ok(await status(port));
});

test('unavailable extra host before a covering wildcard is still skipped', { timeout: 30000 }, async t => {
  if (await canBind('100.100.100.100')) {
    t.skip('100.100.100.100 is a local address on this host');
    return;
  }
  const { child, port, output } = await startSupervisor(t, {
    bindHosts: ['127.0.0.1', '100.100.100.100', '0.0.0.0'],
    allowLanBind: true,
  });
  await waitUntil(() => status(port), `proxy did not start:\n${output.text}`);
  assert.equal(child.exitCode, null);
  assert.ok(await status(port));
});

test('loopback folded into a wildcard is pre-checked for another listener', { timeout: 30000 }, async t => {
  // Where the OS refuses a wildcard bind beside a loopback holder the bind
  // itself fails with EADDRINUSE; where it allows both (BSD), only the
  // pre-check catches the holder. Either way the diagnostic must be the same.
  const holder = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const port = await listenOn(holder, 0, '127.0.0.1');
  t.after(() => close(holder));
  const { output, exited } = await startSupervisor(t, {
    port,
    bindHosts: ['127.0.0.1', '0.0.0.0'],
    allowLanBind: true,
  });
  const [code] = await Promise.race([
    exited,
    delay(15000).then(() => { throw new Error(`supervisor did not exit:\n${output.text}`); }),
  ]);
  assert.equal(code, 1);
  assert.match(output.text, new RegExp(`Port ${port} is already in use`));
});
