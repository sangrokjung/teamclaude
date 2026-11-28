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

// Routed acquire for model 'm' (warm memory is per model); returns { account, via }.
function acquire(am, key, { timeoutMs = 1000, holdMs = 0, exclude = null, model = 'm' } = {}) {
  return am.acquireAccountRouted(exclude, timeoutMs, null, key, model, null, exclude, holdMs);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('a large request holds for its busy home instead of spilling to a free cold account', async () => {
  const am = fleet(2);
  const key = {};
  const first = await acquire(am, key);
  assert.equal(first.account.name, 'a0');
  assert.equal(first.via, 'new');

  const pending = acquire(am, key, { holdMs: 2000 });
  await sleep(30);
  am.releaseAccount(first.account);
  const second = await pending;
  assert.equal(second.account.name, 'a0', 'waited for the cache-warm home');
  assert.equal(second.via, 'home');
  assert.equal(am.accounts[1].inflight, 0, 'the cold account was never taken');
  am.releaseAccount(second.account);
});

test('without a hold a request spills at once and keeps its home', async () => {
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

test('a hold that runs out falls back to the normal path', async () => {
  const am = fleet(2);
  const key = {};
  const first = await acquire(am, key);
  const started = Date.now();
  const second = await acquire(am, key, { holdMs: 60 });
  assert.equal(second.account.name, 'a1', 'spilled after the hold');
  assert.equal(second.via, 'spill');
  assert.ok(Date.now() - started >= 50, 'it did wait for the hold');
  am.releaseAccount(first.account);
  am.releaseAccount(second.account);
});

test('a hold that runs out with nothing free and no queue time resolves null', async () => {
  const am = fleet(1);
  const key = {};
  const first = await acquire(am, key);
  const second = await acquire(am, key, { timeoutMs: 0, holdMs: 40 });
  assert.equal(second.account, null);
  am.releaseAccount(first.account);
});

test('the hold spends the caller deadline instead of extending it', async () => {
  const am = fleet(1);
  const key = {};
  const first = await acquire(am, key);
  const started = Date.now();
  // queue budget 80 ms, hold 10 s: the whole wait must end near 80 ms.
  const second = await acquire(am, key, { timeoutMs: 80, holdMs: 10_000 });
  const waited = Date.now() - started;
  assert.equal(second.account, null);
  assert.ok(waited < 1000, `waited ${waited}ms, the deadline is 80ms`);
  // A slot freed after the deadline must not be handed to the expired request.
  am.releaseAccount(first.account);
  assert.equal(am.accounts[0].inflight, 0);
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

test('no hold for a home whose cache has expired', async () => {
  const am = fleet(2);
  const key = {};
  const first = await acquire(am, key);
  am.affinityWarmTtlMs = 1; // the home's last use is now older than the cache TTL
  await sleep(5);
  const started = Date.now();
  const second = await acquire(am, key, { holdMs: 2000 });
  assert.equal(second.account.name, 'a1', 'spilled at once: nothing warm to wait for');
  assert.ok(Date.now() - started < 500);
  am.releaseAccount(first.account);
  am.releaseAccount(second.account);
});

test('holders per account are capped so an overloaded home spills instead of queuing', async () => {
  const am = fleet(2);
  const k1 = {};
  const k2 = {};
  const first = await acquire(am, k1);
  am.releaseAccount(first.account);
  const k2Home = await acquire(am, k2); // k2 also homes on a0
  assert.equal(k2Home.account.name, 'a0');
  const holder = acquire(am, k1, { holdMs: 2000 });
  await sleep(10);
  const k2Again = await acquire(am, k2, { holdMs: 2000 });
  assert.equal(k2Again.account.name, 'a1', 'a0 already has a full hold queue (cap 1): spill now');
  am.releaseAccount(k2Home.account);
  const held = await holder;
  assert.equal(held.account.name, 'a0');
  am.releaseAccount(held.account);
  am.releaseAccount(k2Again.account);
});

test('holders never jump the queue: an earlier ordinary waiter gets the freed slot first', async () => {
  const am = fleet(1);
  const kHolder = {};
  const owner = await acquire(am, kHolder);
  const ordinary = acquire(am, {}); // ordinary waiter queued first
  const holder = acquire(am, kHolder, { holdMs: 2000 });
  await sleep(5);
  am.releaseAccount(owner.account);
  const first = await ordinary;
  assert.equal(first.account.name, 'a0', 'FIFO: the earlier waiter is served first');
  am.releaseAccount(first.account);
  const second = await holder;
  assert.equal(second.account.name, 'a0', 'the holder gets the next slot');
  am.releaseAccount(second.account);
});

test('a holder past its wait budget is not handed a slot by the drain', async () => {
  const am = fleet(1);
  const key = {};
  const owner = await acquire(am, key);
  const holder = acquire(am, key, { timeoutMs: 5000, holdMs: 5000 });
  await sleep(5);
  assert.equal(am._waiters.length, 1);
  am._waiters[0].deadlineAt = Date.now() - 1; // the budget ran out before its timer fired
  am.releaseAccount(owner.account);
  const got = await holder;
  assert.equal(got.account, null);
  assert.equal(am.accounts[0].inflight, 0, 'the freed slot was not consumed');
});

test('warm memory is per model: a side call on another model warms nothing for the main prompt', async () => {
  const am = fleet(3);
  const key = {};
  const home = await acquire(am, key);                       // a0 home, model m
  const side = await acquire(am, key, { model: 'side' });   // spills to a1 on another model
  assert.equal(side.account.name, 'a1');
  am.releaseAccount(side.account);
  assert.deepEqual(am._warmList(key, 'm').map(w => w.account.name), ['a0']);
  assert.deepEqual(am._warmList(key, 'side').map(w => w.account.name), ['a1']);
  assert.deepEqual(am._warmList(key, null), [], 'no model, no warm accounts');
  am.releaseAccount(home.account);
});

test('no hold for an excluded (failover) acquire', async () => {
  const am = fleet(2);
  const key = {};
  const first = await acquire(am, key);
  const retry = await acquire(am, key, { timeoutMs: 0, holdMs: 2000, exclude: new Set([am.accounts[1]]) });
  assert.equal(retry.account, null, 'a failover attempt never holds');
  am.releaseAccount(first.account);
});

test('codex accounts take no part in warm memory', async () => {
  const am = new AccountManager(makeAccounts(2, { provider: 'codex' }), 0.98, 0, 1);
  measureAll(am);
  const key = {};
  const first = await acquire(am, key);
  assert.deepEqual(am._warmList(key, 'm'), [], 'nothing remembered for a codex account');
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

test('a large session request reaches the hold through the proxy (256 KiB boundary)', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const served = [];
  const upstream = http.createServer(async (req, res) => {
    served.push(req.headers['authorization']);
    if (served.length === 1) await gate; // keep the home's only slot busy
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(2), 0.98, 0, 1);
  measureAll(am);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: `fixture-${randomUUID()}` }, upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false, affinityHoldMs: 3000,
  });
  const port = await listen(proxy);
  const session = { 'content-type': 'application/json', 'x-claude-code-session-id': randomUUID() };
  const big = JSON.stringify({ model: 'm', pad: 'x'.repeat(300 * 1024) });
  const small = JSON.stringify({ model: 'side-model' }); // side calls use another model
  const post = body => fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: session, body })
    .then(r => r.arrayBuffer());
  const until = async (cond, what) => {
    for (let i = 0; i < 400 && !cond(); i++) await sleep(5);
    assert.ok(cond(), `timed out waiting for ${what}`);
  };
  try {
    const first = post(big);
    await until(() => served.length === 1, 'the first request upstream');
    await post(small); // small: never holds, spills to the other account at once
    assert.equal(served.length, 2);
    assert.notEqual(served[1], served[0], 'a small request does not hold');
    const bigReq = post(big); // large: holds for the busy home
    await until(() => am._waiters.some(w => w.hold), 'the large request to hold');
    assert.equal(served.length, 2, 'the holder was not sent to a cold account');
    release();
    await first;
    await bigReq;
    assert.equal(served[2], served[0], 'the large request went to its home');
  } finally {
    release();
    upstream.close();
    proxy.close();
  }
});
