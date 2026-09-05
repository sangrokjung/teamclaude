import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const cliPath = process.env.TEAMCLAUDE_TEST_CLI
  || fileURLToPath(new URL('../src/index.js', import.meta.url));

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

async function waitUntilListening(port, child) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited before listening (code ${child.exitCode})`);
    const listening = await new Promise(resolve => {
      const req = http.get({ host: '127.0.0.1', port, path: '/teamclaude/status' }, res => {
        res.resume();
        resolve(true);
      });
      req.once('error', () => resolve(false));
    });
    if (listening) return;
    await delay(25);
  }
  throw new Error('server did not start listening');
}

test('a supervised Claude or Codex session cannot stop or restart its own proxy', async () => {
  const proxyPort = await unusedPort();
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-self-stop-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port: proxyPort, apiKey: 'tc-test' },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'sk-ant-test' }],
  }));
  const child = spawn(process.execPath, [cliPath, 'server'], {
    env: { ...process.env, TEAMCLAUDE_PROVIDER: 'anthropic', TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  try {
    await waitUntilListening(proxyPort, child);
    for (const command of ['stop', 'restart']) {
      const result = spawnSync(process.execPath, [cliPath, command], {
        encoding: 'utf8',
        env: {
          ...process.env,
          TEAMCLAUDE_PROVIDER: 'anthropic',
          TEAMCLAUDE_CONFIG: configPath,
          TEAMCLAUDE_SESSION_SUPERVISED: '1',
        },
      });
      assert.equal(result.status, 1, `${command}: ${result.stderr}`);
      assert.match(result.stderr, /supervised Claude or Codex session/i);
    }
    assert.equal(child.exitCode, null);
    const status = await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/status`);
    assert.equal(status.status, 200);
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
    if (child.exitCode == null && child.signalCode == null) await once(child, 'exit');
    await rm(dir, { recursive: true, force: true });
  }
});

test('SIGTERM exits after a bounded grace period even with an active SSE response', async () => {
  let markUpstreamStarted;
  const upstreamStarted = new Promise(resolve => { markUpstreamStarted = resolve; });
  const upstream = http.createServer((_req, res) => {
    markUpstreamStarted();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"ping"}\n\n');
    const heartbeat = setInterval(() => {
      res.write('data: {"type":"ping"}\n\n');
    }, 100);
    res.once('close', () => clearInterval(heartbeat));
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = await unusedPort();
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-shutdown-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port: proxyPort, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'sk-ant-test' }],
  }));

  const child = spawn(process.execPath, [cliPath, 'server'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  let clientRequest;
  let clientResponse;
  try {
    await waitUntilListening(proxyPort, child);
    clientRequest = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, response => { clientResponse = response; });
    clientRequest.once('error', () => {});
    clientRequest.end(JSON.stringify({ model: 'test-model', messages: [] }));
    await upstreamStarted;

    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server remained alive after the shutdown grace period')), 6500);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    child.kill('SIGTERM');
    const result = await exited;

    assert.deepEqual(result, { code: 0, signal: null }, stderr);
    assert.match(stdout, /Shutting down/);
    assert.match(stderr, /Graceful shutdown timed out; forcing exit/);
  } finally {
    clientRequest?.destroy();
    clientResponse?.destroy();
    if (child.exitCode == null) child.kill('SIGKILL');
    upstream.closeAllConnections?.();
    await close(upstream);
    await rm(dir, { recursive: true, force: true });
  }
});
