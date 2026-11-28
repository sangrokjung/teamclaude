import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const HOUR = 3600_000;

function makeAccounts(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `a${i}`, type: 'oauth', accessToken: `tok-${i}`, refreshToken: 'r', expiresAt: Date.now() + HOUR,
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('a large request holds for its busy home instead of spilling to a free cold account', async () => {
  const am = fleet(2);
  const key = {};
  const first = await am.acquireAccount(null, 1000, null, key);
  assert.equal(first.name, 'a0');
  assert.equal(am.routeVia(key), 'new');

  const pending = am.acquireAccount(null, 1000, null, key, null, null, null, 2000);
  await sleep(30);
  am.releaseAccount(first);
  const second = await pending;
  assert.equal(second.name, 'a0', 'waited for the cache-warm home');
  assert.equal(am.routeVia(key), 'home');
  assert.equal(am.accounts[1].inflight, 0, 'the cold account was never taken');
  am.releaseAccount(second);
});

test('without a hold a request spills at once and keeps its home', async () => {
  const am = fleet(2);
  const key = {};
  const first = await am.acquireAccount(null, 1000, null, key);
  const spill = await am.acquireAccount(null, 1000, null, key);
  assert.equal(spill.name, 'a1');
  assert.equal(am.routeVia(key), 'spill');
  am.releaseAccount(first);
  am.releaseAccount(spill);
  const back = await am.acquireAccount(null, 1000, null, key);
  assert.equal(back.name, 'a0', 'the home is kept across a spill');
  am.releaseAccount(back);
});

test('a hold that runs out falls back to the normal path', async () => {
  const am = fleet(2);
  const key = {};
  const first = await am.acquireAccount(null, 1000, null, key);
  const started = Date.now();
  const second = await am.acquireAccount(null, 1000, null, key, null, null, null, 60);
  assert.equal(second.name, 'a1', 'spilled after the hold');
  assert.ok(Date.now() - started >= 50, 'it did wait for the hold');
  am.releaseAccount(first);
  am.releaseAccount(second);
});

test('a hold that runs out with nothing free and no queue time resolves null', async () => {
  const am = fleet(1);
  const key = {};
  const first = await am.acquireAccount(null, 1000, null, key);
  const second = await am.acquireAccount(null, 0, null, key, null, null, null, 40);
  assert.equal(second, null);
  am.releaseAccount(first);
});

test('when the home is busy a recently used account beats a cold one', async () => {
  const am = fleet(3);
  const key = {};
  const blocker = {};
  const home = await am.acquireAccount(null, 1000, null, key);
  am.releaseAccount(home);
  const busyHome = await am.acquireAccount(null, 1000, null, blocker); // other session takes a0
  assert.equal(busyHome.name, 'a0');
  const spill = await am.acquireAccount(null, 1000, null, key);
  assert.equal(spill.name, 'a1');
  am.releaseAccount(spill);
  // Make a1 the worst cold choice so only the warm memory can pick it.
  am.updateQuota(1, {
    'anthropic-ratelimit-unified-5h-utilization': '0.6',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + HOUR) / 1000)),
  });
  const again = await am.acquireAccount(null, 1000, null, key);
  assert.equal(again.name, 'a1', 'the cache-warm spill account, not cold a2');
  assert.equal(am.routeVia(key), 'warm');
  am.releaseAccount(again);
  am.releaseAccount(busyHome);
});

test('holders per account are capped so an overloaded home spills instead of queuing', async () => {
  const am = fleet(2);
  const k1 = {};
  const k2 = {};
  const first = await am.acquireAccount(null, 1000, null, k1);
  // k2 also homes on a0 (first pick); release so the next k1 hold sees a0 busy.
  am.releaseAccount(first);
  const k2Home = await am.acquireAccount(null, 1000, null, k2);
  assert.equal(k2Home.name, 'a0');
  const holder = am.acquireAccount(null, 1000, null, k1, null, null, null, 2000);
  await sleep(10);
  const k2Again = await am.acquireAccount(null, 1000, null, k2, null, null, null, 2000);
  assert.equal(k2Again.name, 'a1', 'a0 already has a full hold queue (cap 1): spill now');
  am.releaseAccount(k2Home);
  const held = await holder;
  assert.equal(held.name, 'a0');
  am.releaseAccount(held);
  am.releaseAccount(k2Again);
});

test('a released home slot goes to its holder before an earlier ordinary waiter', async () => {
  const am = fleet(1);
  const kOrdinary = {};
  const kHolder = {};
  const owner = await am.acquireAccount(null, 1000, null, kHolder);
  // ordinary waiter (no key) queued first
  const ordinary = am.acquireAccount(null, 1000, null, kOrdinary);
  const holder = am.acquireAccount(null, 1000, null, kHolder, null, null, null, 2000);
  await sleep(5);
  am.releaseAccount(owner);
  const got = await holder;
  assert.equal(got.name, 'a0');
  am.releaseAccount(got);
  const later = await ordinary;
  assert.equal(later.name, 'a0', 'the ordinary waiter still gets the next slot');
  am.releaseAccount(later);
});

test('no hold for an excluded (failover) acquire', async () => {
  const am = fleet(2);
  const key = {};
  const first = await am.acquireAccount(null, 1000, null, key);
  const retry = await am.acquireAccount(new Set([am.accounts[1]]), 0, null, key, null, null, null, 2000);
  assert.equal(retry, null, 'a failover attempt never holds');
  am.releaseAccount(first);
});

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('main conversation and subagents of one session get separate homes; route log hides ids', async () => {
  const served = [];
  const upstream = http.createServer((req, res) => {
    served.push((req.headers['authorization'] || '').replace('Bearer ', ''));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 3);
  measureAll(am);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}`, activeWarmup: false,
  });
  const port = await listen(proxy);
  const sessionId = '259c09b3-071c-46f5-a4c3-2e069497c59f';
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  const call = headers => fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"model":"m"}',
  }).then(r => r.arrayBuffer());
  try {
    await call({ 'x-claude-code-session-id': sessionId });
    const mainHome = served[0];
    await call({ 'x-claude-code-session-id': sessionId, 'x-claude-code-agent-id': 'agent-1' });
    await call({ 'x-claude-code-session-id': sessionId });
    assert.equal(served[2], mainHome, 'main conversation keeps its home');
  } finally {
    console.log = orig;
    upstream.close();
    proxy.close();
  }
  const routes = lines.filter(l => l.includes('[TeamClaude] Route '));
  assert.equal(routes.length, 3);
  assert.match(routes[0], /s=[0-9a-f]{8} g=main acct=#\d via=new held=\d+/);
  assert.match(routes[1], /g=[0-9a-f]{8} acct=#\d via=new/, 'the subagent is a separate key');
  assert.match(routes[2], /g=main acct=#\d via=home/);
  for (const l of routes) {
    assert.ok(!l.includes(sessionId) && !l.includes('agent-1') && !l.includes('tok-'), 'no raw ids or tokens');
  }
});
