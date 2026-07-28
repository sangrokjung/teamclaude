import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function startProxy(am, upstreamPort, overrides = {}) {
  return createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false, // isolate 529 failover from background warm-up probes
    ...overrides,
  });
}

function overloaded529(res) {
  res.writeHead(529, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
}

test('529 after an unsafe POST is not replayed on another account', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits += 1;
    const auth = req.headers['authorization'] || '';
    if (auth.includes('tok-a')) overloaded529(res);
    else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy);

  try {
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    const elapsed = Date.now() - started;
    assert.equal(res.status, 529);
    assert.equal(upstreamHits, 1, 'an upstream-accepted POST must not be replayed internally');
    assert.ok(elapsed < 2000, `expected immediate passthrough, took ${elapsed}ms`);
    assert.ok(am.accounts.every(a => a.status !== 'throttled' && a.status !== 'error'),
      `expected no account poisoned, got ${am.accounts.map(a => a.status).join(',')}`);
  } finally {
    proxy.close();
    upstream.close();
  }
});

// When EVERY account is overloaded (genuine 529 incident), the proxy must back
// off and retry the whole fleet a bounded number of times, then — only after the
// budget is spent — surface the 529. It must not hang forever and must not
// poison accounts. Backoff timings are shrunk via env so the test stays fast.
test('all accounts 529 → bounded backoff retries, then passes 529 through (no hang, no poison)', async () => {
  process.env.TEAMCLAUDE_OVERLOAD_RETRIES = '2';
  process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS = '50';
  process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS = '60';

  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    overloaded529(res);
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, { method: 'GET' });
    await res.text();
    assert.equal(res.status, 529);                                  // surfaced only after backoff budget spent
    // 2 accounts × (1 initial fleet sweep + 2 backoff-retry sweeps) = 6 hits; allow slack.
    assert.ok(upstreamHits >= 2 && upstreamHits <= 10, `expected bounded retries, got ${upstreamHits}`);
    assert.ok(am.accounts.every(a => a.status !== 'throttled' && a.status !== 'error'),
      `expected no account poisoned, got ${am.accounts.map(a => a.status).join(',')}`);
  } finally {
    proxy.close();
    upstream.close();
    delete process.env.TEAMCLAUDE_OVERLOAD_RETRIES;
    delete process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS;
    delete process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS;
  }
});

test('continuity mode retries within the finite 529 budget and returns eventual success', async () => {
  process.env.TEAMCLAUDE_OVERLOAD_RETRIES = '2';
  process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS = '10';
  process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS = '10';

  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits += 1;
    if (upstreamHits <= 2) {
      overloaded529(res);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = startProxy(am, upstreamPort, { continuityMode: true });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(res.status, 200, 'recovery within the retry budget must stay transparent');
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(upstreamHits, 3, 'the request must remain inside the proxy until upstream recovers');
    assert.equal(am.accounts[0].status, 'active');
  } finally {
    proxy.close();
    upstream.close();
    delete process.env.TEAMCLAUDE_OVERLOAD_RETRIES;
    delete process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS;
    delete process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS;
  }
});

test('continuity mode bounds persistent 529 retries and releases the request', async () => {
  const previousRetries = process.env.TEAMCLAUDE_OVERLOAD_RETRIES;
  const previousBase = process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS;
  const previousCap = process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS;
  process.env.TEAMCLAUDE_OVERLOAD_RETRIES = '2';
  process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS = '10';
  process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS = '10';

  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits += 1;
    overloaded529(res);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a', type: 'api', credential: 'test-credential' },
  ], 0.98);
  const proxy = startProxy(am, upstreamPort, { continuityMode: true });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'GET',
      signal: AbortSignal.timeout(1000),
    });
    await res.text();
    assert.equal(res.status, 529);
    assert.equal(upstreamHits, 3, 'one initial attempt plus two continuity retries');
    assert.equal(am.accounts[0].inflight, 0, 'the bounded request must release its account slot');
  } finally {
    proxy.close();
    upstream.close();
    if (previousRetries === undefined) delete process.env.TEAMCLAUDE_OVERLOAD_RETRIES;
    else process.env.TEAMCLAUDE_OVERLOAD_RETRIES = previousRetries;
    if (previousBase === undefined) delete process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS;
    else process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS = previousBase;
    if (previousCap === undefined) delete process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS;
    else process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS = previousCap;
  }
});

// Codex P2 regression: TEAMCLAUDE_OVERLOAD_RETRIES=0 must actually DISABLE the
// proxy-held backoff retries (an operator escape hatch during an incident). An
// explicit 0 is falsy, so `parseInt(...) || 6` used to silently fall back to 6 —
// envInt()'s Number.isFinite guard fixes that. With 0 the request still fails over
// across accounts once, then passes the 529 straight through with NO backoff sleep.
test('TEAMCLAUDE_OVERLOAD_RETRIES=0 disables backoff — failover sweep then immediate passthrough', async () => {
  process.env.TEAMCLAUDE_OVERLOAD_RETRIES = '0';
  // Make a default-6 fallback obvious if the knob were ignored: each backoff would
  // sleep ≥1s, so honoring 0 keeps this well under that.
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    overloaded529(res);
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy);

  try {
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, { method: 'GET' });
    await res.text();
    const elapsed = Date.now() - started;
    assert.equal(res.status, 529);                                  // surfaced — retries disabled
    assert.ok(elapsed < 900, `expected no backoff sleep with retries=0, took ${elapsed}ms`);
    assert.equal(upstreamHits, 2, `expected one failover sweep (no backoff rounds), got ${upstreamHits}`);
    assert.ok(am.accounts.every(a => a.status !== 'throttled' && a.status !== 'error'),
      `expected no account poisoned, got ${am.accounts.map(a => a.status).join(',')}`);
  } finally {
    proxy.close();
    upstream.close();
    delete process.env.TEAMCLAUDE_OVERLOAD_RETRIES;
  }
});
