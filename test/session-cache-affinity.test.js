import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, promptCacheTtlMs } from '../src/server.js';

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

// Routed acquire for model 'm' (warm memory is per model); returns { account, via }.
function acquire(am, key, { timeoutMs = 1000, exclude = null, model = 'm' } = {}) {
  return am.acquireAccountRouted(exclude, timeoutMs, null, key, model, null, exclude);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

test('when the home is busy a recently used account beats a cold one', async () => {
  const am = fleet(3);
  const key = {};
  const blocker = {};
  const home = await acquire(am, key);
  am.releaseAccount(home.account);
  const busyHome = await acquire(am, blocker); // another session takes a0
  assert.equal(busyHome.account.name, 'a0');
  const spill = await acquire(am, key);
  assert.equal(spill.account.name, 'a1');
  am.noteCacheUse(key, spill.account, HOUR); // its inference succeeded: a1 holds the cache
  am.releaseAccount(spill.account);
  // Make a1 the worst cold choice so only the warm memory can pick it.
  am.updateQuota(1, {
    'anthropic-ratelimit-unified-5h-utilization': '0.6',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + HOUR) / 1000)),
  });
  const again = await acquire(am, key);
  assert.equal(again.account.name, 'a1', 'the cache-warm spill account, not cold a2');
  assert.equal(again.via, 'warm');
  am.releaseAccount(again.account);
  am.releaseAccount(busyHome.account);
});

test('an expired warm account is not preferred over a cold one', async () => {
  const am = fleet(3);
  const key = {};
  const blocker = {};
  const home = await acquire(am, key);
  am.releaseAccount(home.account);
  const busyHome = await acquire(am, blocker);
  const spill = await acquire(am, key);
  am.noteCacheUse(key, spill.account, 2); // a 2 ms cache: expires right away
  am.releaseAccount(spill.account);
  am.updateQuota(1, {
    'anthropic-ratelimit-unified-5h-utilization': '0.6',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + HOUR) / 1000)),
  });
  await sleep(5);
  const again = await acquire(am, key);
  assert.equal(again.account.name, 'a2', 'normal use-or-lose order, no stale warm preference');
  assert.equal(again.via, 'spill');
  am.releaseAccount(again.account);
  am.releaseAccount(busyHome.account);
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

test('an account is warm only after a recorded cache use, never just from being assigned', async () => {
  const am = fleet(3);
  const key = {};
  const blocker = {};
  const home = await acquire(am, key);
  am.releaseAccount(home.account);
  const busyHome = await acquire(am, blocker);
  const spill = await acquire(am, key); // assigned, but (say) answered 400: no noteCacheUse
  am.releaseAccount(spill.account);
  assert.deepEqual(am._warmList(key), []);
  am.updateQuota(1, {
    'anthropic-ratelimit-unified-5h-utilization': '0.6',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + HOUR) / 1000)),
  });
  const again = await acquire(am, key);
  assert.equal(again.account.name, 'a2', 'no warm preference without a cache');
  am.releaseAccount(again.account);
  am.releaseAccount(busyHome.account);
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

test('codex accounts take no part in warm memory', async () => {
  const am = new AccountManager(makeAccounts(2, { provider: 'codex' }), 0.98, 0, 1);
  measureAll(am);
  const key = {};
  const first = await acquire(am, key);
  am.noteCacheUse(key, first.account, HOUR);
  assert.deepEqual(am._warmList(key), [], 'nothing remembered for a codex account');
  am.releaseAccount(first.account);
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

test('promptCacheTtlMs reads the longest cache_control TTL, 0 without breakpoints', () => {
  assert.equal(promptCacheTtlMs(null), 0);
  assert.equal(promptCacheTtlMs({ messages: [{ role: 'user', content: 'hi' }] }), 0);
  assert.equal(promptCacheTtlMs({ system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }] }), 5 * 60_000);
  assert.equal(promptCacheTtlMs({
    system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } }] }],
  }), HOUR);
});

test('the proxy records a cache use only for a 2xx cache-building inference, keyed per model', async () => {
  let status = 200;
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(status === 200 ? '{"ok":true}' : '{"type":"error","error":{"type":"invalid_request_error","message":"x"}}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  measureAll(am);
  const notes = [];
  const orig = am.noteCacheUse.bind(am);
  am.noteCacheUse = (key, account, ttl) => { notes.push({ key, account: account.name, ttl }); orig(key, account, ttl); };
  const proxy = createProxyServer(am, {
    proxy: { apiKey: `fixture-${randomUUID()}` }, upstream: `http://127.0.0.1:${upstreamPort}`, activeWarmup: false,
  });
  const port = await listen(proxy);
  const headers = { 'content-type': 'application/json', 'x-claude-code-session-id': randomUUID() };
  const cached = model => JSON.stringify({
    model, messages: [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } }] }],
  });
  const post = body => fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers, body })
    .then(r => r.arrayBuffer());
  const lines = [];
  const log = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    await post(cached('model-a'));
    await post(JSON.stringify({ model: 'model-a', messages: [] })); // no breakpoint: builds no cache
    await post(cached('model-b'));
    status = 400;
    await post(cached('model-a'));
  } finally {
    console.log = log;
    upstream.close();
    proxy.close();
  }
  assert.equal(notes.length, 2, 'only the two cache-building 2xx calls were recorded');
  assert.equal(notes[0].ttl, HOUR);
  assert.notEqual(notes[0].key, notes[1].key, 'a different model is a different key (separate cache)');
  const routes = lines.filter(l => l.includes('[TeamClaude] Route '));
  assert.match(routes[2], /via=new/, 'model-b starts its own key');
  assert.match(routes[3], /via=home/, 'model-a keeps its home');
});
