import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// config.modelFallbacks: when the fleet is out of quota for the requested
// model, the proxy rewrites the request to the configured fallback model(s)
// and retries, instead of surfacing the 429 (2026-07-13 — 11/14 accounts had
// 7d_oi at 1.0 and every claude-fable-5 request was passed through as 429).

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function makeAccounts(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `acct-${i}`,
    type: 'oauth',
    accessToken: `tok-${i}`,
    refreshToken: `r-${i}`,
    expiresAt: Date.now() + 3600_000,
  }));
}

function startProxy(am, upstreamPort, overrides = {}) {
  return createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false, // isolate fallback behavior from background probes
    ...overrides,
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function post(port, model) {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  });
}

// A bare 429 — no quota headers. This is what an account with an unmeasured
// weekly window returns on a model-tier exhaustion: the proxy can only
// classify it as "global" and, pre-fallback, passed it through to the client.
function bare429(res) {
  res.writeHead(429, { 'retry-after': '60', 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
}

// A model-tier exhaustion 429 that upstream labels with the 7d_oi weekly
// window (utilization 1.0) — the account stays usable for other models.
function modelWeekly429(res) {
  res.writeHead(429, {
    'retry-after': '60',
    'anthropic-ratelimit-unified-7d_oi-utilization': '1',
    'anthropic-ratelimit-unified-7d_oi-reset': String(Math.floor(Date.now() / 1000) + 86400),
    'content-type': 'application/json',
  });
  res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
}

function ok200(res, body = { ok: true }) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// The production shape of 2026-07-13: every account answers a bare 429 for
// fable (unlabeled model-tier exhaustion → classified "global"), while opus
// still serves. The fallback must rewrite the request instead of passing the
// 429 through.
test('unlabeled fleet-wide 429 → falls back to the configured model and succeeds', async () => {
  const modelsSeen = [];
  const upstream = http.createServer(async (req, res) => {
    const body = await readJsonBody(req);
    modelsSeen.push(body.model);
    if (body.model === 'claude-fable-5') bare429(res);
    else ok200(res, { ok: true, served: body.model });
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(2), 0.98);
  const proxy = startProxy(am, upstreamPort, {
    modelFallbacks: { 'claude-fable-5': ['claude-opus-4-8'] },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await post(proxyPort, 'claude-fable-5');
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.served, 'claude-opus-4-8');
    // Both accounts tried on fable, then the fallback dispatch on opus.
    assert.deepEqual(modelsSeen.slice(0, 2), ['claude-fable-5', 'claude-fable-5']);
    assert.equal(modelsSeen[modelsSeen.length - 1], 'claude-opus-4-8');
    // A bare 429 must not have poisoned any account.
    assert.ok(am.accounts.every(a => a.status === 'active'));
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('labeled Fable 7d_oi exhaustion → falls back to Opus and succeeds', async () => {
  const attempts = [];
  const upstream = http.createServer(async (req, res) => {
    const body = await readJsonBody(req);
    attempts.push({ model: body.model, authorization: req.headers.authorization });
    if (body.model === 'claude-fable-5') modelWeekly429(res);
    else ok200(res, { ok: true, served: body.model });
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(2), 0.98);
  const proxy = startProxy(am, upstreamPort, {
    modelFallbacks: { 'claude-fable-5': ['claude-opus-4-8', 'claude-sonnet-5'] },
    continuityMode: true,
    rateLimitFailovers: 0,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await post(proxyPort, 'claude-fable-5');
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.served, 'claude-opus-4-8');
    assert.deepEqual(attempts.slice(0, 2).map(a => a.model), ['claude-fable-5', 'claude-fable-5']);
    assert.equal(new Set(attempts.slice(0, 2).map(a => a.authorization)).size, 2);
    assert.equal(attempts[attempts.length - 1].model, 'claude-opus-4-8');
    assert.ok(!attempts.some(a => a.model === 'claude-sonnet-5'));
    assert.ok(am.accounts.every(a => a.quota.modelWeekly['7d_oi']?.utilization === 1));
    // 7d_oi exhaustion is model-scoped: accounts stay active (not throttled).
    assert.ok(am.accounts.every(a => a.status === 'active'));
  } finally {
    proxy.close();
    upstream.close();
  }
});

// When the whole chain is exhausted too, the pre-existing behavior must be
// preserved: bounded retries, 429 to the client, no account state mutation.
test('chain exhausted → 429 passes through with bounded upstream hits', async () => {
  let hits = 0;
  const upstream = http.createServer(async (req, res) => {
    await readJsonBody(req);
    hits++;
    bare429(res);
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(2), 0.98);
  const proxy = startProxy(am, upstreamPort, {
    modelFallbacks: { 'claude-fable-5': ['claude-opus-4-8'] },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await post(proxyPort, 'claude-fable-5');
    await res.text();
    assert.equal(res.status, 429);
    // ≤ 2 accounts × 2 models, no unbounded recursion.
    assert.ok(hits <= 4, `expected bounded retries, got ${hits}`);
    assert.ok(am.accounts.every(a => a.status === 'active'));
  } finally {
    proxy.close();
    upstream.close();
  }
});

// No modelFallbacks configured → behavior is byte-for-byte the old one: the
// 429 passes through and the request is never rewritten.
test('no modelFallbacks config → 429 passes through, model never rewritten', async () => {
  const modelsSeen = [];
  const upstream = http.createServer(async (req, res) => {
    const body = await readJsonBody(req);
    modelsSeen.push(body.model);
    bare429(res);
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(2), 0.98);
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy);

  try {
    const res = await post(proxyPort, 'claude-fable-5');
    await res.text();
    assert.equal(res.status, 429);
    assert.ok(modelsSeen.every(m => m === 'claude-fable-5'));
  } finally {
    proxy.close();
    upstream.close();
  }
});

// Claude Code may name the model with a client-side bracket suffix
// ("claude-fable-5[1m]"); the API knows no such IDs, so the fallback lookup
// must match the suffix-stripped config entry.
test('bracket-suffixed model matches its suffix-stripped fallback entry', async () => {
  const modelsSeen = [];
  const upstream = http.createServer(async (req, res) => {
    const body = await readJsonBody(req);
    modelsSeen.push(body.model);
    if (body.model === 'claude-opus-4-8') ok200(res, { ok: true, served: body.model });
    else bare429(res);
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(2), 0.98);
  const proxy = startProxy(am, upstreamPort, {
    modelFallbacks: { 'claude-fable-5': ['claude-opus-4-8'] },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await post(proxyPort, 'claude-fable-5[1m]');
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.served, 'claude-opus-4-8');
    assert.equal(modelsSeen[modelsSeen.length - 1], 'claude-opus-4-8');
  } finally {
    proxy.close();
    upstream.close();
  }
});
