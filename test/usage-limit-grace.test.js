import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { importCredentials } from '../src/oauth.js';
import { applyOAuthUpsert, claudePlanType } from '../src/account-upsert.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Usage-limit grace: when an account hits its 5-hour limit, Anthropic grants a
// fixed allotment from the weekly limit so the in-progress task can finish
// (Pro: once a week; Max/Team Premium: every 5-hour limit). The server decides
// whether a request is covered, so once every account is session-capped the
// proxy must still forward to a session-only-capped account instead of
// answering 429 itself.

const HOUR = 3600_000;

function makeAccounts(n, extra = {}) {
  return Array.from({ length: n }, (_, i) => ({
    name: `acct-${i}`,
    type: 'oauth',
    accessToken: `tok-${i}`,
    refreshToken: `r-${i}`,
    expiresAt: Date.now() + HOUR,
    ...extra,
  }));
}

function quotaHeaders({ u5h, u7d, status = 'allowed', r5h = Date.now() + HOUR, r7d = Date.now() + 72 * HOUR }) {
  return {
    'anthropic-ratelimit-unified-5h-utilization': String(u5h),
    'anthropic-ratelimit-unified-7d-utilization': String(u7d),
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor(r5h / 1000)),
    'anthropic-ratelimit-unified-7d-reset': String(Math.floor(r7d / 1000)),
    'anthropic-ratelimit-unified-status': status,
  };
}

function sessionCapped(am, account, u7d = 0.4) {
  am.updateQuota(account, quotaHeaders({ u5h: 1, u7d }));
}

test('every account session-capped → acquireAccount still returns a grace account', async () => {
  const am = new AccountManager(makeAccounts(2));
  for (const a of am.accounts) sessionCapped(am, a);
  assert.ok(am.accounts.every(a => !am._isAvailable(a)), 'nothing is normally usable');
  const got = await am.acquireAccount();
  assert.ok(got, 'grace lane must hand out an account');
  assert.equal(got.inflight, 1);
  am.releaseAccount(got);
});

test('a normally usable account wins over the grace lane', async () => {
  const am = new AccountManager(makeAccounts(2));
  sessionCapped(am, am.accounts[0]);
  am.updateQuota(am.accounts[1], quotaHeaders({ u5h: 0.2, u7d: 0.3 }));
  const got = await am.acquireAccount();
  assert.equal(got, am.accounts[1]);
});

test('grace prefers the connection home account (the task being finished)', async () => {
  const am = new AccountManager(makeAccounts(3));
  const conn = {};
  for (const a of am.accounts) am.updateQuota(a, quotaHeaders({ u5h: 0.2, u7d: 0.3 }));
  const home = await am.acquireAccount(null, 0, null, conn);
  am.releaseAccount(home);
  // Lower weekly use elsewhere must not pull the task off its home account.
  for (const a of am.accounts) sessionCapped(am, a, a === home ? 0.8 : 0.1);
  const got = await am.acquireAccount(null, 0, null, conn);
  assert.equal(got, home);
});

test('without a home, grace picks the account with the most weekly headroom', async () => {
  const am = new AccountManager(makeAccounts(3));
  sessionCapped(am, am.accounts[0], 0.7);
  sessionCapped(am, am.accounts[1], 0.2);
  sessionCapped(am, am.accounts[2], 0.5);
  const got = await am.acquireAccount();
  assert.equal(got, am.accounts[1]);
});

test('weekly-exhausted accounts get no grace', async () => {
  const am = new AccountManager(makeAccounts(2));
  for (const a of am.accounts) am.updateQuota(a, quotaHeaders({ u5h: 1, u7d: 1 }));
  assert.equal(await am.acquireAccount(), null);
});

test('a rejected session-capped response spends grace until the 5h window resets', async () => {
  const am = new AccountManager(makeAccounts(1));
  const [a] = am.accounts;
  const r5h = Date.now() + HOUR;
  am.updateQuota(a, quotaHeaders({ u5h: 1, u7d: 0.4, status: 'rejected', r5h }));
  assert.ok(am._tryAcquire(), 'updateQuota alone must not spend grace (could be model-scoped)');
  am.releaseAccount(a);
  am.noteGraceRefused(a);
  assert.equal(await am.acquireAccount(), null, 'server refused grace — do not retry it');
  // Window rolls over → fresh 5h budget, account is usable normally again.
  a.quota.unified5hReset = Date.now() - 1;
  assert.equal(await am.acquireAccount(), a);
});

test('a still-running throttle blocks the grace lane', async () => {
  const am = new AccountManager(makeAccounts(1));
  const [a] = am.accounts;
  sessionCapped(am, a);
  am.markRateLimited(a, 60);
  assert.equal(await am.acquireAccount(), null);
});

test('excluded accounts are not reused through the grace lane', async () => {
  const am = new AccountManager(makeAccounts(2));
  for (const a of am.accounts) sessionCapped(am, a);
  const got = await am.acquireAccount(new Set([am.accounts[0]]));
  assert.equal(got, am.accounts[1]);
  am.releaseAccount(got);
  assert.equal(await am.acquireAccount(new Set(am.accounts)), null);
});

test('grace respects the concurrency cap', async () => {
  const am = new AccountManager(makeAccounts(1), 0.98, 300_000, 1);
  sessionCapped(am, am.accounts[0]);
  const first = await am.acquireAccount();
  assert.ok(first);
  assert.equal(await am.acquireAccount(), null);
  am.releaseAccount(first);
});

test('a capped normal account queues instead of spending grace', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 300_000, 1);
  am.updateQuota(am.accounts[0], quotaHeaders({ u5h: 0.2, u7d: 0.3 }));
  sessionCapped(am, am.accounts[1]);
  const held = await am.acquireAccount();
  assert.equal(held, am.accounts[0]);
  // Normal account is merely at its cap: the next request must wait for it,
  // not burn the session-capped account's weekly grace.
  assert.equal(am._tryAcquire(), null);
  // The capacity checks must agree with that selection: nothing immediately
  // usable, but a capped slot to wait on (keeps continuity FIFO waits intact).
  assert.equal(am.anyUsable(), false);
  assert.equal(am.anyCapped(), true);
  am.releaseAccount(held);
});

test('usageLimitGrace=false disables the grace lane', async () => {
  const am = new AccountManager(makeAccounts(1));
  am.usageLimitGrace = false;
  sessionCapped(am, am.accounts[0]);
  assert.equal(await am.acquireAccount(), null);
});

test('codex accounts never use the grace lane', async () => {
  const am = new AccountManager(makeAccounts(1, { provider: 'codex' }));
  sessionCapped(am, am.accounts[0]);
  assert.equal(await am.acquireAccount(), null);
});

test('a request waiting on a busy grace account gets it once the slot frees', async () => {
  const am = new AccountManager(makeAccounts(1), 0.98, 300_000, 1);
  const [a] = am.accounts;
  sessionCapped(am, a);
  const first = await am.acquireAccount();
  assert.equal(first, a);
  assert.equal(am.anyCapped(), true, 'a busy grace account is capacity a freed slot will serve');
  const pending = am.acquireAccount(null, 1000);
  setTimeout(() => am.releaseAccount(first), 10);
  assert.equal(await pending, a);
  am.releaseAccount(a);
});

test('anyUsable sees a grace account so failover does not dead-end early', () => {
  const am = new AccountManager(makeAccounts(2));
  for (const acc of am.accounts) sessionCapped(am, acc);
  assert.equal(am.anyUsable(new Set([am.accounts[0]])), true);
  am.usageLimitGrace = false;
  assert.equal(am.anyUsable(new Set([am.accounts[0]])), false);
});

test('an unmeasured weekly window gets no grace', async () => {
  const am = new AccountManager(makeAccounts(1));
  am.updateQuota(am.accounts[0], {
    'anthropic-ratelimit-unified-5h-utilization': '1',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + HOUR) / 1000)),
  });
  assert.equal(await am.acquireAccount(), null);
});

test('a weekly window without a live reset gets no grace', async () => {
  const am = new AccountManager(makeAccounts(1));
  const [a] = am.accounts;
  am.updateQuota(a, {
    'anthropic-ratelimit-unified-5h-utilization': '1',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + HOUR) / 1000)),
    'anthropic-ratelimit-unified-7d-utilization': '0.4',
  });
  assert.equal(await am.acquireAccount(), null);
});

test('the Claude plan reaches the live account through import and upsert', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'grace-plan-'));
  try {
    const file = join(dir, 'creds.json');
    await writeFile(file, JSON.stringify({ claudeAiOauth: {
      accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + HOUR, subscriptionType: 'Pro',
    } }));
    assert.equal((await importCredentials(file)).planType, 'pro');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const cfg = { accounts: [] };
  applyOAuthUpsert(cfg, { name: 'p', creds: { accessToken: 'a' }, profile: { hasClaudePro: true }, source: 'login' });
  applyOAuthUpsert(cfg, { name: 'm', creds: { accessToken: 'b' }, profile: { hasClaudeMax: true }, source: 'login' });
  applyOAuthUpsert(cfg, { name: 'u', creds: { accessToken: 'c' }, profile: null, source: 'login' });
  assert.deepEqual(cfg.accounts.map(a => a.planType), ['pro', 'max', undefined]);
  const am = new AccountManager(cfg.accounts);
  assert.deepEqual(am.accounts.map(a => a.planType), ['pro', 'max', null]);
});

test('claudePlanType: profile wins, then the imported plan, else null', () => {
  assert.equal(claudePlanType({ planType: 'pro' }, { hasClaudeMax: true }), 'max');
  assert.equal(claudePlanType({}, { hasClaudePro: true }), 'pro');
  assert.equal(claudePlanType({ planType: 'Pro' }, null), 'pro');
  assert.equal(claudePlanType({}, { error: 'x' }), null);
  assert.equal(claudePlanType(null, null), null);
});

test('a known Pro account holds a refused grace until the weekly reset', async () => {
  const am = new AccountManager(makeAccounts(2).map((a, i) => (i === 0 ? { ...a, planType: 'pro' } : a)));
  const [pro, max] = am.accounts;
  const r7d = Date.now() + 72 * HOUR;
  for (const a of am.accounts) {
    am.updateQuota(a, quotaHeaders({ u5h: 1, u7d: 0.4, status: 'rejected', r7d }));
    am.noteGraceRefused(a);
  }
  assert.equal(pro._graceSpentUntil, r7d - (r7d % 1000));
  assert.ok(max._graceSpentUntil < r7d, 'unknown plan keeps the 5-hour cadence');
});

test('noteGraceRefused ignores non-rejected and below-threshold accounts', () => {
  const am = new AccountManager(makeAccounts(2));
  sessionCapped(am, am.accounts[0]); // allowed, not rejected
  am.updateQuota(am.accounts[1], quotaHeaders({ u5h: 0.5, u7d: 0.4, status: 'rejected' }));
  am.noteGraceRefused(am.accounts[0]);
  am.noteGraceRefused(am.accounts[1]);
  assert.equal(am.accounts[0]._graceSpentUntil, undefined);
  assert.equal(am.accounts[1]._graceSpentUntil, undefined);
});

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function post(port, model = 'claude-opus-4-8', path = '/v1/messages') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, max_tokens: 1, messages: [] });
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('proxy forwards to a session-capped account and relays the grace response', async () => {
  let hits = 0;
  const upstream = http.createServer((req, res) => {
    hits += 1;
    req.resume();
    res.writeHead(200, {
      'content-type': 'application/json',
      ...quotaHeaders({ u5h: 1, u7d: 0.45 }),
      'anthropic-ratelimit-unified-grace-5h-utilization': '0.1',
    });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(2));
  for (const a of am.accounts) sessionCapped(am, a);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    continuityMode: false,
  });
  const port = await listen(proxy);
  try {
    const r = await post(port);
    assert.equal(r.status, 200);
    assert.equal(hits, 1);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('with continuity mode on (the default), grace forwards immediately instead of waiting for the 5h reset', async () => {
  let hits = 0;
  const upstream = http.createServer((req, res) => {
    hits += 1;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json', ...quotaHeaders({ u5h: 1, u7d: 0.45 }) });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(1));
  sessionCapped(am, am.accounts[0]);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    continuityMode: true,
    continuityMaxWaitMs: 2000,
    continuityMaxSleepMs: 10,
    continuityJitterMs: 0,
  });
  const port = await listen(proxy);
  try {
    const started = Date.now();
    const r = await post(port);
    assert.equal(r.status, 200);
    assert.equal(hits, 1);
    assert.ok(Date.now() - started < 1000, 'must not sleep toward the 1h reset');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('proxy fails over then surfaces 429 once grace is refused fleet-wide', async () => {
  let hits = 0;
  const upstream = http.createServer((req, res) => {
    hits += 1;
    req.resume();
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': '60',
      ...quotaHeaders({ u5h: 1, u7d: 0.45, status: 'rejected' }),
    });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(2));
  for (const a of am.accounts) sessionCapped(am, a);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    continuityMode: false,
  });
  const port = await listen(proxy);
  try {
    const r = await post(port);
    assert.equal(r.status, 429);
    assert.equal(hits, 2, 'each account offered grace exactly once');
    const again = await post(port);
    assert.equal(again.status, 429);
    assert.equal(hits, 2, 'refused grace is not retried within the same 5h window');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// A Fable rejection on its model-scoped weekly window is not a refusal of the
// account's 5-hour grace: Opus on the same session-capped account must still
// be forwarded.
test('a model-scoped (Fable weekly) rejection does not spend grace for other models', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const { model } = JSON.parse(raw);
      seen.push(model);
      if (/fable/.test(model)) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': '60',
          ...quotaHeaders({ u5h: 1, u7d: 0.4, status: 'rejected' }),
          'anthropic-ratelimit-unified-7d_oi-utilization': '1',
          'anthropic-ratelimit-unified-7d_oi-reset': String(Math.floor((Date.now() + 72 * HOUR) / 1000)),
        });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json', ...quotaHeaders({ u5h: 1, u7d: 0.41 }) });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(1));
  sessionCapped(am, am.accounts[0]);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    continuityMode: false,
  });
  const port = await listen(proxy);
  try {
    const fable = await post(port, 'claude-fable-5');
    assert.equal(fable.status, 429);
    const opus = await post(port, 'claude-opus-4-8');
    assert.equal(opus.status, 200);
    assert.deepEqual(seen, ['claude-fable-5', 'claude-opus-4-8']);
    assert.equal(am.accounts[0]._graceSpentUntil, undefined);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('a Fable weekly rejection on one grace account fails over to another grace account', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      seen.push(auth);
      if (auth.includes('tok-0')) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': '60',
          ...quotaHeaders({ u5h: 1, u7d: 0.2, status: 'rejected' }),
          'anthropic-ratelimit-unified-7d_oi-utilization': '1',
          'anthropic-ratelimit-unified-7d_oi-reset': String(Math.floor((Date.now() + 72 * HOUR) / 1000)),
        });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json', ...quotaHeaders({ u5h: 1, u7d: 0.5 }) });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(2));
  sessionCapped(am, am.accounts[0], 0.2); // most weekly headroom → tried first
  sessionCapped(am, am.accounts[1], 0.5);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    continuityMode: false,
  });
  const port = await listen(proxy);
  try {
    const r = await post(port, 'claude-fable-5');
    assert.equal(r.status, 200);
    assert.equal(seen.length, 2);
    assert.ok(seen[0].includes('tok-0') && seen[1].includes('tok-1'));
  } finally {
    proxy.close();
    upstream.close();
  }
});
