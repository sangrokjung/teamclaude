// Codex-mode capacity-rejection replay (B1, qjc fork).
//
// A codex `POST /codex/responses` that receives a COMPLETE 503/529 whose body is
// a JSON error object, before any client byte went out, is a backend rejection
// issued before inference. That single shape is replayed through the ordinary
// 5xx failover/backoff loop, bounded by the retry budget and by
// TEAMCODEX_OVERLOAD_HOLD_MS. Everything else keeps the legacy no-replay
// passthrough, and anthropic mode is untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const PINNED_503 = /^Upstream overloaded \(HTTP 503\)\. Request was not replayed\.$/;
const ENV_KEYS = [
  'TEAMCLAUDE_OVERLOAD_RETRIES', 'TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS',
  'TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS', 'TEAMCODEX_OVERLOAD_HOLD_MS',
];
// Fast, bounded defaults for every test: 2 fleet backoffs of ~50ms, 5s hold cap.
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
    quota: JSON.stringify(account.quota ?? null),
    rateLimitedUntil: account.rateLimitedUntil ?? null,
  }));
}

function jsonRejection(res, status = 503, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({
    type: 'error',
    error: { type: 'overloaded_error', message: 'temporary overload' },
  }));
}

function ok200(res) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'response-after-recovery' }));
}

async function postResponses(proxyPort, path = '/codex/responses') {
  const response = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6', input: [] }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) };
}

// (a) A complete JSON 503 fails over to the other account: the client sees the
// 200 from the second upstream hit and no account state moves.
test('codex JSON 503 before any client bytes is replayed onto another account and succeeds', () => withEnv(FAST_ENV, async () => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    upstreamHits++;
    if (upstreamHits === 1) jsonRejection(res, 503, { 'retry-after': '0' });
    else ok200(res);
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-a', 'codex-b']);
  const before = snapshotAccounts(manager);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const response = await postResponses(proxyPort);
    assert.equal(response.status, 200);
    assert.deepEqual(response.json(), { id: 'response-after-recovery' });
    assert.equal(upstreamHits, 2, 'exactly one replay');
    assert.deepEqual(snapshotAccounts(manager), before, 'no account state may change on a capacity replay');
    assert.ok(manager.accounts.every(account => account.inflight === 0));
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
}));

// (a2) Single account: no failover candidate, so the fleet backoff path replays
// the same account after the bounded wait.
test('codex JSON 503 on a single account is replayed after the fleet backoff', () => withEnv(FAST_ENV, async () => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    upstreamHits++;
    if (upstreamHits === 1) jsonRejection(res);
    else ok200(res);
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-only']);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const startedAt = Date.now();
    const response = await postResponses(proxyPort);
    assert.equal(response.status, 200);
    assert.equal(upstreamHits, 2);
    assert.ok(Date.now() - startedAt >= 40, 'the fleet backoff must actually wait');
    assert.ok(manager.accounts[0].status !== 'throttled' && manager.accounts[0].status !== 'error');
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
}));

// (e) 529 with a JSON body is the same shape and gets the same treatment.
test('codex JSON 529 before any client bytes is replayed like a 503', () => withEnv(FAST_ENV, async () => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    upstreamHits++;
    if (upstreamHits === 1) jsonRejection(res, 529);
    else ok200(res);
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-a', 'codex-b']);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const response = await postResponses(proxyPort);
    assert.equal(response.status, 200);
    assert.equal(upstreamHits, 2);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
}));

// (b) Persistent rejection on every account: failover once, back off twice
// (TEAMCLAUDE_OVERLOAD_RETRIES=2), then surface the EXACT legacy passthrough.
test('codex JSON 503 on every account exhausts the bounded budget, then passes the pinned 503 through', () => withEnv(FAST_ENV, async () => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    upstreamHits++;
    jsonRejection(res);
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-a', 'codex-b']);
  const before = snapshotAccounts(manager);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const startedAt = Date.now();
    const response = await postResponses(proxyPort);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(response.status, 503);
    const payload = response.json();
    assert.equal(payload.type, 'error');
    assert.equal(payload.error.type, 'overloaded_error');
    assert.match(payload.error.message, PINNED_503);
    // 2 accounts × (1 initial cycle + 2 backoff cycles) = 6 upstream hits.
    assert.equal(upstreamHits, 6, `bounded: expected 6 hits, got ${upstreamHits}`);
    assert.ok(elapsedMs < 3000, `bounded hold took ${elapsedMs}ms`);
    assert.deepEqual(snapshotAccounts(manager), before, 'no account state may change on a capacity replay');
    assert.ok(manager.accounts.every(account => account.inflight === 0));
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
}));

// (b2) TEAMCODEX_OVERLOAD_HOLD_MS=0 is the kill switch: legacy behavior exactly.
test('TEAMCODEX_OVERLOAD_HOLD_MS=0 disables the codex replay (legacy passthrough, 1 hit)', () => withEnv({ ...FAST_ENV, TEAMCODEX_OVERLOAD_HOLD_MS: '0' }, async () => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    upstreamHits++;
    jsonRejection(res);
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-a', 'codex-b']);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const response = await postResponses(proxyPort);
    assert.equal(response.status, 503);
    assert.match(response.json().error.message, PINNED_503);
    assert.equal(upstreamHits, 1);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
}));

// (b3) The hold cap is enforced across cycles, not just per wait: with a cap
// smaller than one backoff the second rejection is passed through at once.
test('codex hold cap ends the replay even while the retry budget is still open', () => withEnv({ ...FAST_ENV, TEAMCLAUDE_OVERLOAD_RETRIES: '6', TEAMCODEX_OVERLOAD_HOLD_MS: '120' }, async () => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    upstreamHits++;
    jsonRejection(res);
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-a', 'codex-b']);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const startedAt = Date.now();
    const response = await postResponses(proxyPort);
    assert.equal(response.status, 503);
    assert.match(response.json().error.message, PINNED_503);
    // Budget alone would allow 2 accounts × 7 cycles = 14 hits; the 120ms cap
    // ends it within 2–3 cycles (the exact hit lands on either the pre-wait
    // clamp or the next cycle's hold check, so the bound is a small range).
    assert.ok(upstreamHits >= 2 && upstreamHits <= 6, `hold cap must stop the loop early, got ${upstreamHits} hits`);
    assert.ok(Date.now() - startedAt < 1000);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
}));

// (c) Non-JSON bodies are ambiguous (CDN/HTML, plain text) → never replayed.
test('codex 503 with an HTML body is not replayed (legacy passthrough)', () => withEnv(FAST_ENV, async () => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    upstreamHits++;
    res.writeHead(503, { 'content-type': 'text/html' });
    res.end('<html><body><h1>503 Service Temporarily Unavailable</h1></body></html>');
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-a', 'codex-b']);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const response = await postResponses(proxyPort);
    assert.equal(response.status, 503);
    assert.match(response.json().error.message, PINNED_503);
    assert.equal(upstreamHits, 1, 'an HTML 503 is ambiguous and must not be replayed');
    assert.ok(manager.accounts.every(account => account.inflight === 0));
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
}));

// (c2) A JSON object without an error/detail key is not a rejection envelope.
test('codex 503 with a JSON body lacking error/detail is not replayed', () => withEnv(FAST_ENV, async () => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    upstreamHits++;
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'draining' }));
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-a', 'codex-b']);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const response = await postResponses(proxyPort);
    assert.equal(response.status, 503);
    assert.match(response.json().error.message, PINNED_503);
    assert.equal(upstreamHits, 1);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
}));

// (c3) Truncated JSON (headers say 256 bytes, socket dies mid-body) → not a
// complete rejection → not replayed, and the read error is contained.
test('codex 503 with a truncated JSON body is not replayed', () => withEnv(FAST_ENV, async () => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    upstreamHits++;
    res.writeHead(503, { 'content-type': 'application/json', 'content-length': '256' });
    res.flushHeaders();
    res.write('{"type":"error","error":{"type":"overloaded_error"');
    setImmediate(() => res.destroy());
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-a', 'codex-b']);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const response = await postResponses(proxyPort);
    assert.equal(response.status, 503);
    assert.match(response.json().error.message, PINNED_503);
    assert.equal(upstreamHits, 1);
    assert.ok(manager.accounts.every(account => account.inflight === 0));
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
}));

// (c4) 502 stays on the legacy path even in codex mode (only 503/529 qualify).
test('codex JSON 502 is still never replayed', () => withEnv(FAST_ENV, async () => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    upstreamHits++;
    jsonRejection(res, 502);
  });
  const upstreamPort = await listen(upstream);
  const manager = codexManager(['codex-a', 'codex-b']);
  const proxy = codexProxy(manager, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const response = await postResponses(proxyPort);
    assert.equal(response.status, 502);
    assert.match(response.json().error.message, /^Upstream overloaded \(HTTP 502\)\. Request was not replayed\.$/);
    assert.equal(upstreamHits, 1);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
}));

// (d) Anthropic mode is byte-for-byte unchanged: an unsafe POST 503 with the
// same JSON body is passed through without replay.
test('anthropic-mode unsafe POST 503 with a JSON body is not replayed (unchanged)', () => withEnv(FAST_ENV, async () => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    upstreamHits++;
    jsonRejection(res);
  });
  const upstreamPort = await listen(upstream);
  const manager = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 },
  ], 0.98);
  const proxy = createProxyServer(manager, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);
  try {
    const startedAt = Date.now();
    const response = await postResponses(proxyPort, '/v1/messages');
    assert.equal(response.status, 503);
    assert.match(response.json().error.message, PINNED_503);
    assert.equal(response.headers.get('x-teamcodex-recovery-session'), null);
    assert.equal(upstreamHits, 1, 'anthropic-mode unsafe POST must never be replayed');
    assert.ok(Date.now() - startedAt < 2000);
    assert.ok(manager.accounts.every(account => account.status !== 'throttled' && account.status !== 'error'));
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
}));
