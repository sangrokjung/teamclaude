import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const HOUR = 3600_000;

// One-off credentials per run (never fixed literals in fixtures).
function makeAccounts(n, extra = {}) {
  return Array.from({ length: n }, (_, i) => ({
    name: `a${i}`, type: 'oauth', accessToken: `fixture-${randomUUID()}`, refreshToken: `fixture-${randomUUID()}`,
    expiresAt: Date.now() + HOUR, ...extra,
  }));
}

function measureAll(am, util = 0.1) {
  const now = Date.now();
  am.accounts.forEach((_, i) => am.updateQuota(i, {
    'anthropic-ratelimit-unified-5h-utilization': String(util),
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + HOUR) / 1000)),
  }));
}

// cap 1 per account, re-evaluation off: every decision is affinity / hold.
function fleet(n) {
  const am = new AccountManager(makeAccounts(n), 0.98, 0, 1);
  measureAll(am);
  return am;
}

// Routed acquire; returns { account, via }.
function acquire(am, key, { timeoutMs = 1000, exclude = null, model = 'm' } = {}) {
  return am.acquireAccountRouted(exclude, timeoutMs, null, key, model, null, exclude);
}


test('a busy home spills the request at once and stays the home', async () => {
  const am = fleet(2);
  const key = {};
  const first = await acquire(am, key);
  const spill = await acquire(am, key);
  assert.equal(spill.account.name, 'a1');
  assert.equal(spill.via, 'spill');
  am.releaseAccount(first.account);
  am.releaseAccount(spill.account);
  const back = await acquire(am, key);
  assert.equal(back.account.name, 'a0', 'the home is kept across a spill');
  am.releaseAccount(back.account);
});

test('routed acquire returns a fresh result and queued requests keep their own reason', async () => {
  const am = fleet(1);
  const k1 = {};
  const k2 = {};
  const owner = await acquire(am, k1);
  const q1 = acquire(am, k1);
  const q2 = acquire(am, k2);
  am.releaseAccount(owner.account);
  const r1 = await q1;
  assert.equal(r1.via, 'home');
  am.releaseAccount(r1.account);
  const r2 = await q2;
  assert.equal(r2.via, 'new', 'each request reports how IT was routed');
  assert.notEqual(r1, r2);
  am.releaseAccount(r2.account);
});

test('route reason is home/bypass, not spill, when warm-up bypasses affinity', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-utilization': '0.1',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + HOUR) / 1000)),
  });
  // a1 stays unmeasured → a warm-up target → affinity is bypassed.
  const key = {};
  const first = await acquire(am, key);
  assert.equal(first.account.name, 'a1');
  assert.equal(first.via, 'bypass');
  const second = await acquire(am, key);
  assert.equal(second.account.name, 'a1');
  assert.equal(second.via, 'home', 'same account as the home is not a spill');
  am.releaseAccount(first.account);
  am.releaseAccount(second.account);
});

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('main conversation and subagents get separate keys; every request is route-logged without ids', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  measureAll(am);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: `fixture-${randomUUID()}` }, upstream: `http://127.0.0.1:${upstreamPort}`, activeWarmup: false,
  });
  const port = await listen(proxy);
  const sessionId = randomUUID();
  const agentId = `agent-${randomUUID().slice(0, 8)}`;
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  const call = headers => fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"model":"m"}',
  }).then(r => r.arrayBuffer());
  try {
    await call({ 'x-claude-code-session-id': sessionId });
    await call({ 'x-claude-code-session-id': sessionId, 'x-claude-code-agent-id': agentId });
    await call({ 'x-claude-code-session-id': sessionId });
    await call({});
    // count_tokens builds no prompt cache: it must not use (or refresh) the session key.
    await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': sessionId },
      body: '{"model":"m"}',
    }).then(r => r.arrayBuffer());
  } finally {
    console.log = orig;
    upstream.close();
    proxy.close();
  }
  const routes = lines.filter(l => l.includes('[TeamClaude] Route '));
  assert.equal(routes.length, 5, 'one line per request, header-less included');
  assert.match(routes[4], /s=- g=- /, 'count_tokens is not session-keyed');
  assert.match(routes[0], /s=[0-9a-f]{8} g=main acct=#\d via=new held=\d+/);
  assert.match(routes[1], /g=[0-9a-f]{8} acct=#\d via=new/, 'the subagent is a separate key');
  assert.match(routes[2], /g=main acct=#\d via=home/);
  assert.match(routes[3], /s=- g=- acct=#\d via=/);
  const secrets = [sessionId, agentId, ...am.accounts.map(a => a.credential || a.accessToken)];
  for (const l of routes) {
    for (const v of secrets) assert.ok(!l.includes(v), 'no raw ids or tokens in the route log');
  }
});

test('each model of a session is its own key; the advisor model does not change the key', async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  measureAll(am);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: `fixture-${randomUUID()}` }, upstream: `http://127.0.0.1:${upstreamPort}`, activeWarmup: false,
  });
  const port = await listen(proxy);
  const headers = { 'content-type': 'application/json', 'x-claude-code-session-id': randomUUID() };
  const post = body => fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body) })
    .then(r => r.arrayBuffer());
  const lines = [];
  const log = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    await post({ model: 'model-a', messages: [] });
    await post({ model: 'model-b', messages: [] });
    await post({ model: 'model-a', messages: [], tools: [{ type: 'advisor_20260101', name: 'advisor', model: 'model-x' }] });
    await post({ model: 'model-a', messages: [] });
  } finally {
    console.log = log;
    upstream.close();
    proxy.close();
  }
  const routes = lines.filter(l => l.includes('[TeamClaude] Route '));
  assert.equal(routes.length, 4);
  assert.match(routes[0], /via=new/);
  assert.match(routes[1], /via=new/, 'model-b is a separate key (separate cache)');
  assert.match(routes[2], /via=home/, 'an advisor tool does not change the cache key');
  assert.match(routes[3], /via=home/);
});
