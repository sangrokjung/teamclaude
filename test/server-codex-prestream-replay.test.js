// Codex-mode pre-output stream replay (B2, qjc fork).
//
// A codex `POST /codex/responses` whose HTTP 200 SSE stream fails BEFORE any
// output-bearing frame (only `response.created` / `response.in_progress` /
// pings so far, then `response.failed` with a capacity code, an `error` event,
// or a dead stream) is replayed through the same failover/backoff loop B1 uses.
// Once an output-bearing frame is staged the legacy live passthrough applies,
// and when the budget is spent the client receives exactly the legacy bytes.
// Anthropic mode is untouched (streamRecovery tests in server-midstream.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, classifyCodexSseFrame } from '../src/server.js';

const ENV_KEYS = [
  'TEAMCLAUDE_OVERLOAD_RETRIES', 'TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS',
  'TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS', 'TEAMCODEX_OVERLOAD_HOLD_MS',
  'CODEX_PRESTREAM_STAGE_MAX_MS',
];
// Fast, bounded defaults: 2 fleet backoffs of ~50ms, 5s hold cap.
const FAST_ENV = {
  TEAMCLAUDE_OVERLOAD_RETRIES: '2',
  TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS: '50',
  TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS: '60',
  TEAMCODEX_OVERLOAD_HOLD_MS: '5000',
};

function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  return fn().finally(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met before timeout');
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function drainRequest(request) {
  for await (const chunk of request) {
    if (chunk.length === 0) continue;
  }
}

function codexManager(names) {
  return new AccountManager(names.map(name => ({
    name,
    provider: 'codex',
    type: 'oauth',
    accessToken: `pooled-access-token-${name}`,
    accountId: `workspace-${name}`,
    expiresAt: Date.now() + 3_600_000,
  })));
}

function codexProxy(manager, upstreamPort) {
  return createProxyServer(manager, {
    provider: 'codex',
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    codexUsageRefresh: false,
  });
}

function snapshotAccounts(manager) {
  return manager.accounts.map(account => ({
    status: account.status,
    errorReason: account.errorReason ?? null,
    rateLimitedUntil: account.rateLimitedUntil ?? null,
  }));
}

// Count the peer's soft-avoid hook without changing what it does.
function countUpstreamFailures(manager) {
  let calls = 0;
  const original = manager.noteUpstreamFailure.bind(manager);
  manager.noteUpstreamFailure = (...args) => { calls += 1; return original(...args); };
  return () => calls;
}

const CREATED = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n';
const IN_PROGRESS = 'event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"resp_1"}}\n\n';
const PING = ': ping\n\n';
const DELTA = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n';
const COMPLETED = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n';
const failedFrame = code => `event: response.failed\ndata: ${JSON.stringify({
  type: 'response.failed',
  response: { id: 'resp_1', status: 'failed', error: code ? { code, message: 'The server is currently overloaded.' } : null },
})}\n\n`;
const ERROR_NO_CODE = 'event: error\ndata: {"type":"error","message":"An error occurred while processing your request. request ID: abc"}\n\n';

function sse(res, frames, headers = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
  for (const frame of frames) res.write(frame);
  res.end();
}

const count = (text, needle) => text.split(needle).length - 1;

async function postResponses(proxyPort, path = '/codex/responses') {
  const response = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6', input: [], stream: true }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
}

// (a) created + in_progress then `response.failed` (server_is_overloaded) is
// replayed on the other account; the client sees ONE response.created and the
// successful stream. No account state moves and the soft-avoid hook is silent.
test('codex pre-output response.failed (server_is_overloaded) is replayed onto another account', () => withEnv(FAST_ENV, async () => {
  let hits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    hits += 1;
    if (hits === 1) sse(res, [CREATED, IN_PROGRESS, failedFrame('server_is_overloaded')]);
    else sse(res, [CREATED, DELTA, COMPLETED]);
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-a', 'codex-b']);
  const before = snapshotAccounts(manager);
  const failures = countUpstreamFailures(manager);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const response = await postResponses(proxyPort);
    assert.equal(response.status, 200);
    assert.equal(hits, 2);
    assert.equal(count(response.text, 'event: response.created'), 1, 'exactly one response.created');
    assert.equal(count(response.text, 'event: response.failed'), 0, 'the failed attempt never reaches the client');
    assert.ok(response.text.includes(DELTA));
    assert.ok(response.text.includes(COMPLETED));
    assert.equal(failures(), 0, 'a replayed attempt must not trigger the soft-avoid hook');
    assert.deepEqual(snapshotAccounts(manager), before);
    for (const account of manager.accounts) assert.equal(account.status, 'active');
  } finally {
    await closeServer(proxy);
    await closeServer(upstream);
  }
}));

// (a') an `error` event with no code (the backend's generic failure) is a
// capacity failure too — single account, so recovery goes through the backoff.
test('codex pre-output error event without a code is replayed after the fleet backoff', () => withEnv(FAST_ENV, async () => {
  let hits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    hits += 1;
    if (hits === 1) sse(res, [CREATED, PING, ERROR_NO_CODE]);
    else sse(res, [CREATED, DELTA, COMPLETED]);
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-solo']);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const response = await postResponses(proxyPort);
    assert.equal(response.status, 200);
    assert.equal(hits, 2);
    assert.equal(count(response.text, 'event: response.created'), 1);
    assert.equal(count(response.text, 'event: error'), 0);
    assert.ok(response.text.includes(COMPLETED));
    assert.equal(manager.accounts[0].status, 'active');
  } finally {
    await closeServer(proxy);
    await closeServer(upstream);
  }
}));

// (b) every attempt fails pre-output: after the bounded budget the client gets
// EXACTLY the legacy bytes (200 + staged frames + the failure frame, once each),
// the soft-avoid hook fires once, and no account is throttled or errored.
test('codex pre-output failure on every account exhausts the budget, then passes the legacy stream through', () => withEnv(FAST_ENV, async () => {
  let hits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    hits += 1;
    sse(res, [CREATED, IN_PROGRESS, failedFrame('slow_down')]);
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-a', 'codex-b']);
  const before = snapshotAccounts(manager);
  const failures = countUpstreamFailures(manager);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const response = await postResponses(proxyPort);
    assert.equal(response.status, 200);
    // 2 accounts × (1 initial round + 2 fleet backoffs)
    assert.equal(hits, 6);
    assert.equal(response.text, CREATED + IN_PROGRESS + failedFrame('slow_down'));
    assert.equal(failures(), 1, 'the soft-avoid hook fires exactly once, on the final passthrough');
    assert.deepEqual(snapshotAccounts(manager), before);
  } finally {
    await closeServer(proxy);
    await closeServer(upstream);
  }
}));

// (c) an output-bearing frame already went live: the later failure is relayed
// as before (no replay, one hit) and the soft-avoid hook fires once.
test('codex failure after response.output_text.delta keeps the legacy passthrough', () => withEnv(FAST_ENV, async () => {
  let hits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    hits += 1;
    sse(res, [CREATED, DELTA, failedFrame('server_is_overloaded')]);
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-a', 'codex-b']);
  const failures = countUpstreamFailures(manager);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const response = await postResponses(proxyPort);
    assert.equal(response.status, 200);
    assert.equal(hits, 1);
    assert.equal(response.text, CREATED + DELTA + failedFrame('server_is_overloaded'));
    assert.equal(failures(), 1);
  } finally {
    await closeServer(proxy);
    await closeServer(upstream);
  }
}));

// (d) staging overflow (> 64 KiB of acknowledgement frames) flushes and goes
// live; a failure after that is not replayed.
test('codex staging overflow goes live and is not replayed', () => withEnv(FAST_ENV, async () => {
  const pad = 'x'.repeat(8 * 1024);
  const bigAck = `event: response.in_progress\ndata: ${JSON.stringify({ type: 'response.in_progress', pad })}\n\n`;
  let hits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    hits += 1;
    sse(res, [CREATED, ...Array(10).fill(bigAck), failedFrame('server_is_overloaded')]);
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-a', 'codex-b']);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const response = await postResponses(proxyPort);
    assert.equal(response.status, 200);
    assert.equal(hits, 1);
    assert.equal(count(response.text, 'event: response.in_progress'), 10);
    assert.equal(count(response.text, 'event: response.failed'), 1);
  } finally {
    await closeServer(proxy);
    await closeServer(upstream);
  }
}));

// (e) a compressed stream is out of scope: legacy path, no staging, no replay.
test('codex gzip-encoded stream keeps the legacy path (no staging, no replay)', () => withEnv(FAST_ENV, async () => {
  let hits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
    res.end(gzipSync(Buffer.from(CREATED + failedFrame('server_is_overloaded'))));
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-a', 'codex-b']);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const response = await postResponses(proxyPort);
    assert.equal(response.status, 200);
    assert.equal(hits, 1);
    assert.equal(response.text, CREATED + failedFrame('server_is_overloaded'));
  } finally {
    await closeServer(proxy);
    await closeServer(upstream);
  }
}));

// (f) the client disconnects during the fleet backoff: the wait ends at once
// and the upstream is never hit again.
test('codex client abort during the pre-output backoff stops the replay', () => withEnv({ ...FAST_ENV, TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS: '300', TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS: '300' }, async () => {
  let hits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    hits += 1;
    sse(res, [CREATED, failedFrame('server_is_overloaded')]);
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-solo']);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const request = http.request({
      host: '127.0.0.1', port: proxyPort, path: '/codex/responses', method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    request.on('error', () => {});
    request.on('response', res => res.resume());
    request.end(JSON.stringify({ model: 'gpt-5.6', input: [], stream: true }));
    await waitFor(() => hits === 1);
    await sleep(80); // inside the 300ms backoff
    request.destroy();
    await sleep(700); // well past where the second attempt would have landed
    assert.equal(hits, 1);
    assert.equal(manager.accounts[0].inflight, 0, 'the slot was released');
  } finally {
    await closeServer(proxy);
    await closeServer(upstream);
  }
}));

// (g) a non-transient rejection (usage_limit_reached) is never replayed.
test('codex pre-output response.failed with a non-transient code is passed through', () => withEnv(FAST_ENV, async () => {
  let hits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    hits += 1;
    sse(res, [CREATED, failedFrame('usage_limit_reached')]);
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-a', 'codex-b']);
  const failures = countUpstreamFailures(manager);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const response = await postResponses(proxyPort);
    assert.equal(response.status, 200);
    assert.equal(hits, 1);
    assert.equal(response.text, CREATED + failedFrame('usage_limit_reached'));
    assert.equal(failures(), 1);
  } finally {
    await closeServer(proxy);
    await closeServer(upstream);
  }
}));

// Kill switch shared with B1: TEAMCODEX_OVERLOAD_HOLD_MS=0 disables staging.
test('TEAMCODEX_OVERLOAD_HOLD_MS=0 disables the pre-output replay', () => withEnv({ ...FAST_ENV, TEAMCODEX_OVERLOAD_HOLD_MS: '0' }, async () => {
  let hits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    hits += 1;
    sse(res, [CREATED, failedFrame('server_is_overloaded')]);
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-a', 'codex-b']);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const response = await postResponses(proxyPort);
    assert.equal(response.status, 200);
    assert.equal(hits, 1);
    assert.equal(response.text, CREATED + failedFrame('server_is_overloaded'));
  } finally {
    await closeServer(proxy);
    await closeServer(upstream);
  }
}));

// B1 diagnostic: a codex 503 that is not replayable says why.
test('codex non-JSON 503 logs the not-replayable reason', () => withEnv(FAST_ENV, async () => {
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    res.writeHead(503, { 'content-type': 'text/html' });
    res.end('<html>Service Unavailable</html>');
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-a']);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    const response = await postResponses(proxyPort);
    assert.equal(response.status, 503);
    assert.ok(lines.some(line => line === '[TeamCodex] 503 not replayable: non-json-body'), lines.join('\n'));
  } finally {
    console.log = originalLog;
    await closeServer(proxy);
    await closeServer(upstream);
  }
}));

// Total staging cap: an upstream that keeps trickling small acknowledgements
// under the idle timeout must not hold the client's headers past the cap. At
// the cap the staged acks are flushed, the stream goes live and continues;
// nothing is replayed and the upstream is kept.
test('codex staging total-time cap goes live with the staged acks and never replays', () => withEnv({ ...FAST_ENV, CODEX_PRESTREAM_STAGE_MAX_MS: '1000' }, async () => {
  let hits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(CREATED);
    const started = Date.now();
    const tick = setInterval(() => {
      if (Date.now() - started >= 1600) {
        clearInterval(tick);
        res.write(DELTA);
        res.end(COMPLETED);
        return;
      }
      res.write(IN_PROGRESS); // every 25ms: far under the idle timeout
    }, 25);
    res.on('close', () => clearInterval(tick));
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-a', 'codex-b']);
  const failures = countUpstreamFailures(manager);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', input: [], stream: true }),
    });
    const headersAfterMs = Date.now() - startedAt; // fetch resolves on headers
    assert.equal(response.status, 200);
    assert.ok(headersAfterMs >= 900 && headersAfterMs < 1500,
      `headers arrived after ${headersAfterMs}ms (cap 1000ms, first upstream output at 1600ms)`);
    const text = await response.text();
    assert.equal(hits, 1);
    assert.equal(count(text, 'event: response.created'), 1);
    assert.ok(count(text, 'event: response.in_progress') >= 20, 'the acks staged before the cap were flushed');
    assert.ok(text.includes(DELTA) && text.includes(COMPLETED), 'the stream continued live after the cap');
    assert.equal(failures(), 0);
    for (const account of manager.accounts) assert.equal(account.status, 'active');
  } finally {
    await closeServer(proxy);
    await closeServer(upstream);
  }
}));

test('classifyCodexSseFrame separates acknowledgements, output and failures', () => {
  assert.deepEqual(classifyCodexSseFrame(': ping'), { kind: 'ack', event: null, code: null });
  assert.deepEqual(classifyCodexSseFrame('event: response.created\ndata: {"type":"response.created"}'), { kind: 'ack', event: 'response.created', code: null });
  assert.deepEqual(classifyCodexSseFrame('data: {"type":"response.in_progress"}'), { kind: 'ack', event: 'response.in_progress', code: null });
  assert.equal(classifyCodexSseFrame('event: response.output_item.added\ndata: {}').kind, 'output');
  assert.equal(classifyCodexSseFrame('event: response.completed\ndata: {"type":"response.completed"}').kind, 'output');
  assert.equal(classifyCodexSseFrame('data: not json').kind, 'output');
  assert.deepEqual(
    classifyCodexSseFrame('event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"server_is_overloaded"}}}'),
    { kind: 'failure', event: 'response.failed', code: 'server_is_overloaded' },
  );
  assert.deepEqual(
    classifyCodexSseFrame('event: error\ndata: {"type":"error","error":{"code":"unauthorized"}}'),
    { kind: 'failure', event: 'error', code: 'unauthorized' },
  );
  assert.deepEqual(
    classifyCodexSseFrame('event: error\ndata: {"type":"error","message":"boom"}'),
    { kind: 'failure', event: 'error', code: null },
  );
});
