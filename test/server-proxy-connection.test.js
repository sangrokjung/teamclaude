import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
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

function request({ port, path, method = 'GET', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: '127.0.0.1', port, path, method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.once('error', reject);
    });
    outgoing.once('error', reject);
    outgoing.end(body);
  });
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

test('raw OAuth relay strips Proxy-Connection in both directions', async () => {
  let receivedProxyConnection;
  const upstream = http.createServer((req, res) => {
    receivedProxyConnection = req.headers['proxy-connection'];
    req.resume();
    req.once('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'proxy-connection': 'close',
      });
      res.end('{}');
    });
  });
  const manager = new AccountManager([
    { name: 'a', provider: 'anthropic', type: 'api_key', apiKey: 'fixture-key' },
  ], 0.98);
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    proxy = createProxyServer(manager, {
      provider: 'anthropic',
      upstream: `http://127.0.0.1:${upstreamPort}`,
      activeWarmup: false,
      sessionAffinity: false,
    });
    const proxyPort = await listen(proxy);
    const body = '{}';
    const response = await request({
      port: proxyPort,
      path: '/v1/oauth/token',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'proxy-connection': 'keep-alive',
      },
      body,
    });

    assert.equal(response.status, 200);
    assert.equal(receivedProxyConnection, undefined);
    assert.equal(response.headers['proxy-connection'], undefined);
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('supervisor strips Proxy-Connection at its worker boundary in both directions', {
  timeout: 15000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-supervisor-proxy-connection-'));
  const configPath = join(dir, 'config.json');
  const preloadPath = join(dir, 'observe-supervisor-boundary.mjs');
  const markerPath = join(dir, 'forwarded-header.json');
  const port = await unusedPort();
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  const upstreamPort = await listen(upstream);
  await writeFile(configPath, JSON.stringify({
    provider: 'anthropic',
    proxy: { port, apiKey: 'fixture-proxy-key' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    accounts: [{ name: 'a', type: 'apikey', apiKey: 'fixture-key' }],
  }));
  await writeFile(preloadPath, `
import http from 'node:http';
import { writeFileSync } from 'node:fs';

if (process.env.TEAMCLAUDE_SUPERVISED_WORKER === '1') {
  const writeHead = http.ServerResponse.prototype.writeHead;
  http.ServerResponse.prototype.writeHead = function (...args) {
    this.setHeader('Proxy-Connection', 'close');
    return writeHead.apply(this, args);
  };
} else {
  const request = http.request;
  http.request = function (...args) {
    const options = typeof args[0] === 'object' ? args[0] : args[1];
    if (options?.path === '/v1/messages') {
      writeFileSync(process.env.FORWARDED_HEADER_MARKER, JSON.stringify({
        proxyConnection: options.headers?.['proxy-connection'] ?? null,
      }));
    }
    return request.apply(this, args);
  };
}
`);
  const child = spawn(process.execPath, [entry, 'server'], {
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${preloadPath}`.trim(),
      TEAMCLAUDE_CONFIG: configPath,
      TEAMCLAUDE_PROVIDER: 'anthropic',
      FORWARDED_HEADER_MARKER: markerPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitUntil(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
        return response.ok;
      } catch {
        return false;
      }
    }, 'proxy did not start');
    const body = '{}';
    const response = await request({
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'proxy-connection': 'keep-alive',
      },
      body,
    });
    const observed = JSON.parse(await waitUntil(async () => {
      try {
        return await readFile(markerPath, 'utf8');
      } catch {
        return null;
      }
    }, 'supervisor forwarding marker was not written'));

    assert.equal(response.status, 200);
    assert.equal(observed.proxyConnection, null);
    assert.equal(response.headers['proxy-connection'], undefined);
  } finally {
    await stopChild(child);
    await close(upstream);
    await rm(dir, { recursive: true, force: true });
  }
});
