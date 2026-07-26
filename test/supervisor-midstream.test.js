import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

// A worker crash while an SSE response is being relayed used to destroy the
// client socket ("Connection closed mid-response" in Claude Code — a dead,
// non-retried turn). The supervisor now relays SSE by whole events and, when
// the worker dies mid-stream, ends the client's response with a well-formed
// retryable `overloaded_error` event; the follow-up retry lands on the
// replacement worker.

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
  if (child.exitCode != null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, delay(6500)]);
  if (child.exitCode == null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

test('client abort before first byte must NOT kill the healthy shared worker', { timeout: 20000 }, async () => {
  // One terminal pressing Esc during the (seconds-long) first-byte wait used to
  // make the supervisor treat its own upstreamReq.destroy() error as a worker
  // death and SIGKILL the shared worker — cutting every other terminal.
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-supervisor-abort-'));
  const configPath = join(dir, 'config.json');
  const statePath = join(dir, 'config.server.json');
  const port = await unusedPort();
  let mode = 'stall';
  const stalled = new Set();
  const upstream = http.createServer((req, res) => {
    if (mode === 'stall') {
      stalled.add(res); // never respond — the client will abort first
      res.once('close', () => stalled.delete(res));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
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
    const initial = await waitUntil(() => readState(statePath), 'server state was not written');

    // Send a request that will sit waiting on upstream first-byte, then abort it.
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    req.on('error', () => {}); // our own abort
    req.end(JSON.stringify({ model: 'test-model', messages: [] }));
    await delay(400); // let it reach the worker and stall upstream
    req.destroy();
    await delay(600); // window in which the old code SIGKILLed the worker

    const after = await readState(statePath);
    assert.equal(after?.workerPid, initial.workerPid,
      'a client abort must not recycle the healthy worker');

    mode = 'ok';
    const retry = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [] }),
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).ok, true);
    assert.equal((await readState(statePath))?.workerPid, initial.workerPid,
      'the same worker must still be serving');
  } finally {
    for (const res of stalled) res.destroy();
    await stopChild(child);
    await close(upstream);
    await rm(dir, { recursive: true, force: true });
  }
});

test('supervised codex worker (env-only provider, provider-less config) keeps legacy passthrough', { timeout: 20000 }, async () => {
  // The worker is forked with plain ['server'] args and only inherits
  // TEAMCLAUDE_PROVIDER — a teamcodex config WITHOUT a "provider" key must
  // still run with codex semantics (no anthropic-shaped error injection).
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-supervisor-sse-'));
  const configPath = join(dir, 'config.json');
  const port = await unusedPort();
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.output_text.delta\ndata: {"delta":"hi"}\n\n');
    res.write('data: {"partial'); // cut mid-event, then die
    setTimeout(() => res.socket.destroy(), 30);
  });
  const upstreamPort = await listen(upstream);
  await writeFile(configPath, JSON.stringify({
    // deliberately NO top-level "provider" key
    proxy: { port, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    accounts: [{
      name: 'codex-pro', provider: 'codex', type: 'oauth',
      accessToken: 'tok', refreshToken: 'r',
      accountId: 'ws-1', accountUuid: 'ws-1',
      expiresAt: Date.now() + 3_600_000,
    }],
  }));

  const child = spawn(process.execPath, [entry, 'server'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_PROVIDER: 'codex' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitUntil(() => status(port), 'proxy did not start');
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/codex/responses', method: 'POST',
        headers: { 'content-type': 'application/json' },
      }, res => {
        const chunks = [];
        const settle = cleanEnd => () => resolve({ body: Buffer.concat(chunks).toString(), cleanEnd });
        res.on('data', c => chunks.push(c));
        res.once('end', settle(true));
        res.once('aborted', settle(false));
        res.once('error', settle(false));
      });
      req.once('error', reject);
      req.end(JSON.stringify({ model: 'gpt-5.6', input: 'hi' }));
    });
    assert.ok(!result.body.includes('overloaded_error'),
      'codex mode must never receive anthropic-shaped injected errors');
    assert.ok(result.body.includes('response.output_text.delta'), 'stream relayed');
  } finally {
    await stopChild(child);
    await close(upstream);
    await rm(dir, { recursive: true, force: true });
  }
});

test('worker SIGKILL mid-SSE → client gets whole events + retryable error event, then recovers', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-supervisor-sse-'));
  const configPath = join(dir, 'config.json');
  const statePath = join(dir, 'config.server.json');
  const port = await unusedPort();

  let requests = 0;
  const upstream = http.createServer((req, res) => {
    requests += 1;
    if (requests > 1) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // First request: stream one whole event, then keep the stream open with
    // pings so the worker is killed unmistakably MID-response.
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    const timer = setInterval(() => {
      if (!res.destroyed) res.write('event: ping\ndata: {"type":"ping"}\n\n');
    }, 20);
    res.once('close', () => clearInterval(timer));
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
    const initial = await waitUntil(() => readState(statePath), 'server state was not written');

    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
        headers: { 'content-type': 'application/json' },
      }, res => {
        const chunks = [];
        let killed = false;
        const settle = cleanEnd => () => resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString(),
          cleanEnd,
        });
        res.on('data', c => {
          chunks.push(c);
          if (!killed) {
            killed = true;
            process.kill(initial.workerPid, 'SIGKILL'); // die mid-relay
          }
        });
        res.once('end', settle(true));
        res.once('aborted', settle(false));
        res.once('error', settle(false));
      });
      req.once('error', reject);
      req.end(JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }));
    });

    assert.equal(result.status, 200);
    assert.equal(result.cleanEnd, true, 'the client response must END cleanly, not die with the worker');
    assert.ok(result.body.includes('message_start'), 'whole events delivered before the crash are kept');
    const blocks = result.body.split('\n\n').filter(Boolean);
    const last = blocks[blocks.length - 1];
    assert.ok(last.startsWith('event: error'), `last frame must be the injected error, got: ${last}`);
    const data = JSON.parse(last.split('\n').find(l => l.startsWith('data: ')).slice(6));
    assert.equal(data.error.type, 'overloaded_error', 'injected error must be client-retryable');

    // The retry (what Claude Code does on overloaded_error) must succeed on the
    // replacement worker — the supervisor listener never went away.
    await waitUntil(async () => {
      const next = await readState(statePath);
      return next?.workerPid && next.workerPid !== initial.workerPid ? next : null;
    }, 'replacement worker was not recorded');
    const retry = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'retry' }] }),
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).ok, true);
    assert.equal(child.exitCode, null, 'the supervisor must survive the worker crash');
  } finally {
    await stopChild(child);
    await close(upstream);
    await rm(dir, { recursive: true, force: true });
  }
});
