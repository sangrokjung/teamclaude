import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// Codex-mode fail-fast on fleet-wide quota exhaustion (2026-09-04 incident):
// when every pooled ChatGPT account is out of its WEEKLY window, waiting for
// the continuity deadline cannot help, and the generic rate_limit_error body
// is opaque to the Codex CLI. The proxy must answer at once with the body
// shape the CLI natively understands (error.type "usage_limit_reached",
// resets_at in unix SECONDS, plan_type from the pool).

const HOUR = 60 * 60 * 1000;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

function makeCodexAccounts(n, extra = {}) {
  return Array.from({ length: n }, (_, i) => ({
    name: `codex-${i}`,
    provider: 'codex',
    type: 'oauth',
    accessToken: `tok-${i}`,
    refreshToken: `r-${i}`,
    accountId: `ws-${i}`,
    expiresAt: Date.now() + HOUR,
    ...extra,
  }));
}

function makeAnthropicAccounts(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `acct-${i}`,
    type: 'oauth',
    accessToken: `tok-${i}`,
    refreshToken: `r-${i}`,
    expiresAt: Date.now() + HOUR,
  }));
}

// Seed a fully spent window the way the request path would after a real
// response (quota reset timestamps are epoch milliseconds in memory).
function exhaustWeekly(am, resetAt) {
  for (const a of am.accounts) {
    a.quota.unified7d = 1;
    a.quota.unified7dReset = resetAt;
    a.quota.unified5h = 0.1;
    a.quota.unified5hReset = resetAt;
  }
}

function okUpstream() {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'response-id' }));
  });
}

function startProxy(am, upstreamPort, overrides = {}) {
  return createProxyServer(am, {
    provider: 'codex',
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    continuityMode: true,
    continuityJitterMs: 0,
    ...overrides,
  });
}

async function postResponses(proxyPort, path = '/codex/responses') {
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6', input: [] }),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  return { status: response.status, headers: response.headers, text, json, elapsedMs: Date.now() - started };
}

function captureLogs() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  return { lines, restore: () => { console.log = original; } };
}

test('codex: weekly exhaustion beyond the continuity budget fails fast with a usage_limit_reached body', async () => {
  const upstream = okUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeCodexAccounts(2, { planType: 'pro' }));
  const resetAt = Date.now() + 60 * HOUR;
  exhaustWeekly(am, resetAt);
  const proxy = startProxy(am, upstreamPort); // continuityMaxWaitMs = default (15 min)
  const proxyPort = await listen(proxy);
  const logs = captureLogs();
  try {
    const r = await postResponses(proxyPort);
    assert.equal(r.status, 429, r.text);
    assert.ok(r.elapsedMs < 3000, `answered in ${r.elapsedMs}ms, expected fail-fast`);
    assert.equal(r.json?.error?.type, 'usage_limit_reached', r.text);
    assert.equal(r.json.error.plan_type, 'pro');
    assert.equal(typeof r.json.error.resets_at, 'number');
    assert.ok(Number.isInteger(r.json.error.resets_at), 'resets_at must be an integer (unix seconds)');
    const expectedSeconds = Math.floor(resetAt / 1000);
    assert.ok(Math.abs(r.json.error.resets_at - expectedSeconds) <= 10,
      `resets_at ${r.json.error.resets_at} not within 10s of ${expectedSeconds}`);
    assert.match(r.json.error.message, /2 accounts/);
    assert.match(r.json.error.message, /TeamCodex/);
    const retryAfter = Number(r.headers.get('retry-after'));
    assert.ok(retryAfter > 59 * 3600 && retryAfter <= 60 * 3600 + 10, `retry-after ${retryAfter}`);
    assert.equal(logs.lines.filter(l => l.includes('waiting')).length, 0, 'no polling sleep before failing fast');
  } finally {
    logs.restore();
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('codex: plan_type is omitted when the pool does not know its plan', async () => {
  const upstream = okUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeCodexAccounts(2));
  exhaustWeekly(am, Date.now() + 60 * HOUR);
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const r = await postResponses(proxyPort);
    assert.equal(r.status, 429, r.text);
    assert.equal(r.json?.error?.type, 'usage_limit_reached', r.text);
    assert.ok(!('plan_type' in r.json.error), 'plan_type must be omitted, not guessed');
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('codex: a reset inside the continuity budget still waits and succeeds once the window rolls over', async () => {
  const upstream = okUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeCodexAccounts(1, { planType: 'pro' }));
  am.accounts[0].quota.unified5h = 1;
  am.accounts[0].quota.unified5hReset = Date.now() + 150;
  const proxy = startProxy(am, upstreamPort, { continuityMaxSleepMs: 10, continuityMaxWaitMs: 5000 });
  const proxyPort = await listen(proxy);
  try {
    const r = await postResponses(proxyPort);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json?.id, 'response-id');
    assert.ok(r.elapsedMs >= 100 && r.elapsedMs < 4000, `elapsed ${r.elapsedMs}ms`);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('anthropic: the same exhaustion keeps the rate_limit_error body', async () => {
  const upstream = okUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAnthropicAccounts(2));
  exhaustWeekly(am, Date.now() + 60 * HOUR);
  const proxy = startProxy(am, upstreamPort, { provider: 'anthropic' });
  const proxyPort = await listen(proxy);
  try {
    const r = await postResponses(proxyPort, '/v1/messages');
    assert.equal(r.status, 429, r.text);
    assert.ok(r.elapsedMs < 3000, `answered in ${r.elapsedMs}ms`);
    assert.deepEqual(r.json, {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: `All 2 accounts exhausted. Retry in ${r.headers.get('retry-after')}s.`,
      },
    });
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('codex: a merely capped pool (quota fine) keeps the generic 429, never usage_limit_reached', async () => {
  let releaseFirst;
  const firstDone = new Promise(resolve => { releaseFirst = resolve; });
  const upstream = http.createServer((req, res) => {
    firstDone.then(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'response-id' }));
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeCodexAccounts(1, { planType: 'pro', maxConcurrent: 1 }));
  const proxy = startProxy(am, upstreamPort, {
    continuityMaxSleepMs: 10,
    continuityMaxWaitMs: 300,
    overflowQueueTimeoutMs: 20,
  });
  const proxyPort = await listen(proxy);
  try {
    const first = postResponses(proxyPort);
    await new Promise(resolve => setTimeout(resolve, 30)); // let #1 take the only slot
    assert.equal(am.accounts[0].inflight, 1);
    const second = await postResponses(proxyPort);
    assert.equal(second.status, 429, second.text);
    assert.equal(second.json?.error?.type, 'rate_limit_error', second.text);
    assert.equal(second.json.type, 'error');
    assert.notEqual(second.json.error.type, 'usage_limit_reached');
    releaseFirst();
    const r1 = await first;
    assert.equal(r1.status, 200, r1.text);
  } finally {
    releaseFirst();
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('codex: legacy mode (continuityMaxWaitMs 0) keeps the bounded polling and the generic body', async () => {
  const upstream = okUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeCodexAccounts(2, { planType: 'pro' }));
  exhaustWeekly(am, Date.now() + 60 * HOUR);
  const proxy = startProxy(am, upstreamPort, { continuityMaxWaitMs: 0, continuityMaxSleepMs: 10 });
  const proxyPort = await listen(proxy);
  const logs = captureLogs();
  try {
    const r = await postResponses(proxyPort);
    assert.equal(r.status, 429, r.text);
    assert.equal(r.json?.error?.type, 'rate_limit_error', r.text);
    assert.equal(r.json.type, 'error');
    assert.match(r.json.error.message, /^All 2 accounts exhausted\. Retry in \d+s\.$/);
    const waits = logs.lines.filter(l => l.includes('No eligible capacity')).length;
    assert.equal(waits, 6, 'TEAMCLAUDE_OVERLOAD_RETRIES default bounds the legacy polling');
  } finally {
    logs.restore();
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});
