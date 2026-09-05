import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// Guards around automatic reset-credit redemption (review round 2, 2026-09-05):
// the account policy honours every eligibility guard, a request spends at most
// one credit, a spent-but-ineffective or indeterminate redemption stops the
// fleet walk, model-quarantined accounts are skipped, a 429 that was already
// in flight when the reset landed cannot undo it, the lagging authoritative
// meter cannot undo it either, the cooldown survives a restart, concurrent
// dead ends share one redemption, and the operator route is loopback-only.

const HOUR = 60 * 60 * 1000;

function listen(server, host = '127.0.0.1') {
  return new Promise(resolve => server.listen(0, host, () => resolve(server.address().port)));
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met before timeout');
}

function externalIPv4() {
  return Object.values(networkInterfaces())
    .flat()
    .find(address => address && (address.family === 'IPv4' || address.family === 4) && !address.internal)?.address;
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
    planType: 'pro',
    ...extra,
  }));
}

function exhaustWeekly(am, resetAt, credits = []) {
  am.accounts.forEach((a, i) => {
    a.quota.unified7d = 1;
    a.quota.unified7dReset = resetAt;
    a.quota.unified5h = 0.1;
    a.quota.unified5hReset = resetAt;
    a.quota.codexResetCredits = credits[i] ?? null;
  });
}

function usagePayload(used, credits) {
  return {
    plan_type: 'pro',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: used,
        limit_window_seconds: 604800,
        reset_after_seconds: 60 * 3600,
        reset_at: Math.floor(Date.now() / 1000) + 60 * 3600,
      },
      secondary_window: null,
    },
    rate_limit_reset_credits: { available_count: credits, applicable_available_count: 0 },
  };
}

function exhaustion429(res) {
  res.writeHead(429, {
    'content-type': 'application/json',
    'retry-after': '60',
    'x-codex-primary-used-percent': '100',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 60 * 3600),
  });
  res.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'pro', resets_at: Math.floor(Date.now() / 1000) + 60 * 3600 } }));
}

function ok200(res) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'response-id', usage: { input_tokens: 1, output_tokens: 1 } }));
}

// Mock ChatGPT backend. `script.responses(n, token, res)` may take over the
// response entirely by returning 'handled'.
function mockUpstream(script = {}) {
  const calls = { responses: [], consume: [], usage: [] };
  const server = http.createServer(async (req, res) => {
    const path = req.url.split('?', 1)[0];
    const token = req.headers.authorization;
    const body = await readBody(req);
    if (path === '/wham/rate-limit-reset-credits/consume') {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* keep null */ }
      calls.consume.push({ token, accountId: req.headers['chatgpt-account-id'], body: parsed });
      const answer = script.consume ? await script.consume(calls.consume.length, token) : { status: 200, body: { code: 'reset', windows_reset: 2 } };
      if (answer === 'hang') return;
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
      return;
    }
    if (path === '/wham/usage') {
      calls.usage.push({ token });
      const answer = script.usage ? script.usage(calls.usage.length, token) : { used: 100, credits: 3 };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(usagePayload(answer.used, answer.credits)));
      return;
    }
    calls.responses.push({ token, path, at: Date.now() });
    const answer = script.responses ? script.responses(calls.responses.length, token, res) : { status: 200 };
    if (answer === 'handled') return;
    if (answer.status === 429) exhaustion429(res);
    else ok200(res);
  });
  return { server, calls };
}

function startProxy(am, upstreamPort, overrides = {}) {
  return createProxyServer(am, {
    provider: 'codex',
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    codexUsageRefresh: false,
    continuityMode: true,
    continuityJitterMs: 0,
    codexResetCredits: true,
    ...overrides,
  });
}

async function postResponses(proxyPort, path = '/codex/responses', model = 'gpt-5.6') {
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: [] }),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  return { status: response.status, headers: response.headers, text, json, elapsedMs: Date.now() - started };
}

function captureLogs() {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => { lines.push(args.join(' ')); };
  console.error = (...args) => { lines.push(args.join(' ')); };
  return { lines, restore: () => { console.log = originalLog; console.error = originalError; } };
}

async function withProxy(am, script, overrides, run) {
  const { server: upstream, calls } = mockUpstream(script);
  const upstreamPort = await listen(upstream);
  const proxy = startProxy(am, upstreamPort, overrides);
  const proxyPort = await listen(proxy);
  const logs = captureLogs();
  try {
    await run({ proxyPort, calls, logs, upstreamPort });
  } finally {
    logs.restore();
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
}

test('account policy honours reserve, cooldown and an unknown credit count (no consume, fail-fast body)', async () => {
  const cases = [
    { label: 'reserve', credits: 1, overrides: { codexResetCreditsReserve: 1 }, lastAt: null },
    { label: 'cooldown', credits: 3, overrides: {}, lastAt: Date.now() - 60_000 },
    { label: 'unknown', credits: null, overrides: {}, lastAt: null },
  ];
  for (const c of cases) {
    const am = new AccountManager(makeCodexAccounts(1));
    am.accounts[0].quota.codexResetCredits = c.credits;
    am.accounts[0].quota.codexResetCreditLastAt = c.lastAt;
    await withProxy(am, { responses: () => ({ status: 429 }) }, { codexResetCreditsPolicy: 'account', ...c.overrides },
      async ({ proxyPort, calls }) => {
        const r = await postResponses(proxyPort);
        assert.equal(r.status, 429, `${c.label}: ${r.text}`);
        assert.equal(r.json?.error?.type, 'usage_limit_reached', `${c.label}: Codex-native body`);
        assert.equal(calls.consume.length, 0, `${c.label}: no consume`);
        assert.ok(r.elapsedMs < 3000, `${c.label}: answered in ${r.elapsedMs}ms`);
      });
  }
});

test('account policy: a reset that the backend does not honour spends ONE credit and ends in the Codex-native 429', async () => {
  const am = new AccountManager(makeCodexAccounts(1));
  am.accounts[0].quota.codexResetCredits = 3;
  await withProxy(am, { responses: () => ({ status: 429 }) }, { codexResetCreditsPolicy: 'account' },
    async ({ proxyPort, calls, logs }) => {
      const r = await postResponses(proxyPort);
      assert.equal(r.status, 429, r.text);
      assert.equal(r.json?.error?.type, 'usage_limit_reached', r.text);
      assert.doesNotMatch(r.text, /All accounts throttled/, 'legacy backstop body must not leak');
      assert.equal(calls.consume.length, 1, 'exactly one credit');
      assert.equal(am.accounts[0].quota.codexResetCredits, 2);
      assert.ok(calls.responses.length >= 2 && calls.responses.length <= 3, `upstream saw ${calls.responses.length} attempts`);
      assert.ok(logs.lines.some(l => l.includes('throttling')), 'second 429 throttles normally');
      assert.ok(r.elapsedMs < 3000, `answered in ${r.elapsedMs}ms`);
    });
});

test('fleet policy: one credit per request even when the reset account keeps answering 429', async () => {
  const am = new AccountManager(makeCodexAccounts(3));
  exhaustWeekly(am, Date.now() + 60 * HOUR, [3, 3, 3]);
  await withProxy(am, { responses: () => ({ status: 429 }) }, {},
    async ({ proxyPort, calls }) => {
      const r = await postResponses(proxyPort);
      assert.equal(r.status, 429, r.text);
      assert.equal(r.json?.error?.type, 'usage_limit_reached', r.text);
      assert.equal(calls.consume.length, 1, 'a single fleet pass per request');
      const stamped = am.accounts.filter(a => a.quota.codexResetCreditLastAt != null);
      assert.equal(stamped.length, 1, 'only the redeemed account carries a cooldown stamp');
      const second = await postResponses(proxyPort);
      assert.equal(second.status, 429);
      assert.equal(calls.consume.length, 2, 'the next request may try the next account (the first is cooling down)');
      assert.notEqual(calls.consume[1].token, calls.consume[0].token);
    });
});

test('fleet policy: "reset" with windows_reset 0 spends the credit, stops the walk, and fails fast', async () => {
  const am = new AccountManager(makeCodexAccounts(2));
  exhaustWeekly(am, Date.now() + 60 * HOUR, [3, 3]);
  await withProxy(am, { consume: () => ({ status: 200, body: { code: 'reset', windows_reset: 0 } }) }, {},
    async ({ proxyPort, calls, logs }) => {
      const r = await postResponses(proxyPort);
      assert.equal(r.status, 429, r.text);
      assert.equal(r.json?.error?.type, 'usage_limit_reached');
      assert.equal(calls.consume.length, 1, 'the second account is NOT tried after a spent credit');
      assert.equal(calls.responses.length, 0, 'nothing was dispatched on a still-full account');
      const spent = am.accounts.find(a => a.quota.codexResetCreditLastOutcome === 'reset_no_windows');
      assert.ok(spent, 'outcome recorded');
      assert.equal(spent.quota.codexResetCredits, 2, 'count decremented (the credit is gone)');
      assert.equal(spent.quota.unified7d, 1, 'meter untouched');
      assert.ok(logs.lines.some(l => l.includes('SPENT') && l.includes('windows_reset=0')), logs.lines.join('\n'));
    });
});

test('fleet policy: an indeterminate consume (timeout) stops the walk and triggers an authoritative refresh', async () => {
  const am = new AccountManager(makeCodexAccounts(2));
  let usageCalls = 0;
  await withProxy(am, {
    consume: () => 'hang',
    usage: () => { usageCalls += 1; return { used: 100, credits: 3 }; },
  }, { codexUsageRefresh: true, warmupIntervalMs: 0, codexResetCreditsTimeoutMs: 100 },
  async ({ proxyPort, calls }) => {
    await waitFor(() => am.accounts.every(a => a.quota.codexUsageAt != null));
    const polledBefore = usageCalls;
    const r = await postResponses(proxyPort);
    assert.equal(r.status, 429, r.text);
    assert.equal(r.json?.error?.type, 'usage_limit_reached');
    assert.equal(calls.consume.length, 1, 'no second account after a possibly-spent credit');
    const attempted = am.accounts.find(a => a.quota.codexResetCreditLastOutcome === 'timeout');
    assert.ok(attempted, 'timeout recorded');
    assert.equal(attempted.quota.codexResetCredits, 3, 'count left alone until the meter says otherwise');
    await waitFor(() => usageCalls > polledBefore, 4000);
    const refreshed = calls.usage.filter(u => u.token === `Bearer ${attempted.credential}`).length;
    assert.ok(refreshed >= 2, 'the attempted account was re-polled');
  });
});

test('fleet policy: a model-quarantined account is skipped; a fully quarantined fleet redeems nothing', async () => {
  const am = new AccountManager(makeCodexAccounts(2));
  exhaustWeekly(am, Date.now() + 60 * HOUR, [3, 3]);
  am.accounts[0].quota.unified7dReset = Date.now() + 70 * HOUR; // would otherwise rank first
  am.markModelUnsupported(am.accounts[0], 'gpt-5.6');
  await withProxy(am, {}, {}, async ({ proxyPort, calls }) => {
    const r = await postResponses(proxyPort);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(calls.consume.map(c => c.token), ['Bearer tok-1'], 'only the account that can serve the model');
    assert.deepEqual(calls.responses.map(c => c.token), ['Bearer tok-1']);
    assert.equal(am.accounts[0].quota.codexResetCredits, 3, 'quarantined account untouched');
  });

  const all = new AccountManager(makeCodexAccounts(2));
  exhaustWeekly(all, Date.now() + 60 * HOUR, [3, 3]);
  for (const a of all.accounts) all.markModelUnsupported(a, 'gpt-5.6');
  await withProxy(all, {}, {}, async ({ proxyPort, calls }) => {
    const r = await postResponses(proxyPort);
    assert.equal(r.status, 429, r.text);
    assert.equal(calls.consume.length, 0, 'a fleet-wide model quarantine is not a quota problem');
  });
});

test('a 429 dispatched before the reset landed is ignored and retried instead of undoing the reset', async () => {
  const am = new AccountManager(makeCodexAccounts(1, { maxConcurrent: 3 }));
  am.accounts[0].quota.unified7d = 0.5;
  am.accounts[0].quota.unified7dReset = Date.now() + 60 * HOUR;
  am.accounts[0].quota.codexResetCredits = 3;
  const held = new Map();
  let releaseSecond = null;
  const bothArrived = new Promise(resolve => { releaseSecond = resolve; });
  await withProxy(am, {
    responses: (n, _token, res) => {
      if (n === 1 || n === 2) {
        held.set(n, res);
        if (held.size === 2) {
          exhaustion429(held.get(1)); // R1 is rejected first → reset → R1 retries as #3
          releaseSecond();
        }
        return 'handled';
      }
      if (n === 3) {
        ok200(res);
        // Only now (after the reset) does R2's stale 429 land.
        setTimeout(() => exhaustion429(held.get(2)), 20);
        return 'handled';
      }
      return { status: 200 };
    },
  }, {}, async ({ proxyPort, calls, logs }) => {
    const r1 = postResponses(proxyPort);
    const r2 = postResponses(proxyPort);
    await bothArrived;
    const [a, b] = await Promise.all([r1, r2]);
    assert.equal(a.status, 200, a.text);
    assert.equal(b.status, 200, b.text);
    assert.equal(calls.consume.length, 1, 'one credit for the whole episode');
    assert.equal(am.accounts[0].quota.unified7d, 0, 'the stale 429 did not re-mark the account');
    assert.equal(am.accounts[0].status, 'active');
    assert.equal(am.accounts[0].rateLimitedUntil, null);
    assert.ok(logs.lines.some(l => l.includes('dispatched before its reset credit')), logs.lines.join('\n'));
    assert.equal(calls.responses.length, 4, 'R1, R2, R1 retry, R2 retry');
  });
});

test('a lagging authoritative meter (still 100% right after the reset) cannot trigger a second credit', async () => {
  const am = new AccountManager(makeCodexAccounts(2));
  await withProxy(am, {
    usage: () => ({ used: 100, credits: 3 }), // backend keeps reporting the stale window
  }, { codexUsageRefresh: true, warmupIntervalMs: 0 }, async ({ proxyPort, calls }) => {
    await waitFor(() => am.accounts.every(a => a.quota.codexUsageAt != null));
    am.accounts[1].quota.unified7dReset = Date.now() + 70 * HOUR; // codex-1 ranks first
    const first = await postResponses(proxyPort);
    assert.equal(first.status, 200, first.text);
    assert.equal(calls.consume.length, 1);
    const reset = am.accounts[1];
    assert.equal(calls.consume[0].token, 'Bearer tok-1');
    const polls = calls.usage.filter(u => u.token === 'Bearer tok-1').length;
    await waitFor(() => calls.usage.filter(u => u.token === 'Bearer tok-1').length > polls, 4000);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(reset.quota.unified7d, 0, 'grace window: the stale 100% did not re-mark the reset account');
    const second = await postResponses(proxyPort);
    assert.equal(second.status, 200, second.text);
    assert.equal(calls.consume.length, 1, 'no credit spent on the other account');
    assert.deepEqual(calls.responses.map(c => c.token), ['Bearer tok-1', 'Bearer tok-1']);
  });
});

test('restart: the cooldown and the credit count survive the quota snapshot; a legacy snapshot yields unknown', async () => {
  const before = new AccountManager(makeCodexAccounts(1));
  exhaustWeekly(before, Date.now() + 60 * HOUR, [3]);
  before.accounts[0].quota.codexResetCreditLastAt = Date.now() - 60_000;
  before.accounts[0].quota.codexResetCreditLastOutcome = 'reset';
  const snapshot = JSON.parse(JSON.stringify(before.exportQuotaState()));
  const after = new AccountManager(makeCodexAccounts(1));
  after.importQuotaState(snapshot);
  assert.equal(after.accounts[0].quota.codexResetCredits, 3);
  assert.equal(after.accounts[0].quota.codexResetCreditLastOutcome, 'reset');
  await withProxy(after, {}, {}, async ({ proxyPort, calls }) => {
    const r = await postResponses(proxyPort);
    assert.equal(r.status, 429, r.text);
    assert.equal(calls.consume.length, 0, 'still inside the restored cooldown');
  });

  const legacy = new AccountManager(makeCodexAccounts(1));
  legacy.importQuotaState([{ name: 'codex-0', accountUuid: null, quota: { unified7d: 1, unified7dReset: Date.now() + 60 * HOUR, unified5h: 0.1, unified5hReset: Date.now() + HOUR } }]);
  assert.equal(legacy.accounts[0].quota.unified7d, 1, 'legacy snapshot matched by name');
  assert.equal(legacy.accounts[0].quota.codexResetCredits, null);
  assert.equal(legacy.accounts[0].quota.codexResetCreditsConsumed, 0);
  await withProxy(legacy, {}, {}, async ({ proxyPort, calls, logs }) => {
    const r = await postResponses(proxyPort);
    assert.equal(r.status, 429, r.text);
    assert.equal(calls.consume.length, 0, 'unknown count → never redeem');
    assert.ok(logs.lines.some(l => l.includes('no eligible account') && l.includes('codex-0:credits-unknown')), logs.lines.join('\n'));
    await postResponses(proxyPort);
    assert.equal(logs.lines.filter(l => l.includes('no eligible account')).length, 1, 'the no-candidate line is throttled');
  });
});

test('concurrent dead ends share one redemption', async () => {
  const am = new AccountManager(makeCodexAccounts(2, { maxConcurrent: 5 }));
  exhaustWeekly(am, Date.now() + 60 * HOUR, [0, 3]);
  await withProxy(am, {
    consume: async () => { await new Promise(resolve => setTimeout(resolve, 50)); return { status: 200, body: { code: 'reset', windows_reset: 2 } }; },
  }, {}, async ({ proxyPort, calls }) => {
    const results = await Promise.all(Array.from({ length: 5 }, () => postResponses(proxyPort)));
    for (const r of results) assert.equal(r.status, 200, r.text);
    assert.equal(calls.consume.length, 1, 'single-flight + cooldown: one credit for five waiters');
    assert.equal(calls.responses.length, 5);
  });
});

test('status advertises the automatic policy; anthropic mode does not', async () => {
  const am = new AccountManager(makeCodexAccounts(1));
  await withProxy(am, {}, { codexResetCreditsPolicy: 'account', codexResetCreditsReserve: 2 }, async ({ proxyPort }) => {
    const status = await (await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/status`)).json();
    assert.deepEqual(status.resetCredits, { enabled: true, policy: 'account', cooldownMs: 1800000, reserve: 2 });
  });
  const claude = new AccountManager([{ name: 'acct-0', type: 'oauth', accessToken: 'tok-0', refreshToken: 'r-0', expiresAt: Date.now() + HOUR }]);
  await withProxy(claude, {}, { provider: 'anthropic' }, async ({ proxyPort }) => {
    const status = await (await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/status`)).json();
    assert.ok(!('resetCredits' in status));
  });
});

test('operator endpoint: a non-loopback caller is refused before any backend call', async t => {
  const host = externalIPv4();
  if (!host) {
    t.skip('no non-loopback IPv4 interface is available');
    return;
  }
  const { server: upstream, calls } = mockUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeCodexAccounts(1));
  am.accounts[0].quota.codexResetCredits = 3;
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy, '0.0.0.0');
  try {
    const remote = await fetch(`http://${host}:${proxyPort}/teamclaude/codex/reset-credit?account=codex-0`, {
      method: 'POST', headers: { 'x-api-key': 'k' },
    });
    assert.equal(remote.status, 403);
    assert.equal((await remote.json()).error.type, 'permission_error');
    assert.equal(calls.consume.length, 0);
    const local = await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/codex/reset-credit?account=codex-0`, {
      method: 'POST', headers: { 'x-api-key': 'k' },
    });
    assert.equal(local.status, 200);
    await local.text();
    assert.equal(calls.consume.length, 1);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('account policy with a second exhausted account: an unhonoured reset still spends only ONE credit', async () => {
  const am = new AccountManager(makeCodexAccounts(2));
  am.accounts[0].quota.codexResetCredits = 3; // healthy, serves first
  am.accounts[1].quota.unified7d = 1;
  am.accounts[1].quota.unified7dReset = Date.now() + 60 * HOUR;
  am.accounts[1].quota.unified5h = 0.1;
  am.accounts[1].quota.unified5hReset = Date.now() + HOUR;
  am.accounts[1].quota.codexResetCredits = 3;
  await withProxy(am, { responses: () => ({ status: 429 }) }, { codexResetCreditsPolicy: 'account' },
    async ({ proxyPort, calls }) => {
      const r = await postResponses(proxyPort);
      assert.equal(r.status, 429, r.text);
      assert.equal(r.json?.error?.type, 'usage_limit_reached', r.text);
      assert.deepEqual(calls.consume.map(c => c.token), ['Bearer tok-0'], 'the account-path redemption is the request\'s single pass');
      assert.equal(am.accounts[1].quota.codexResetCredits, 3, 'the exhausted account keeps its credits');
      assert.ok(r.elapsedMs < 3000, `answered in ${r.elapsedMs}ms`);
    });
});

test('fleet walk yields to an account that became routable while a no-spend attempt was in flight', async () => {
  const am = new AccountManager(makeCodexAccounts(3));
  exhaustWeekly(am, Date.now() + 60 * HOUR, [3, 2, 2]); // ranks codex-0 first, then codex-1, codex-2
  let releaseFirst = null;
  const firstInFlight = new Promise(resolve => { releaseFirst = resolve; });
  let unblockFirst = null;
  const firstMayAnswer = new Promise(resolve => { unblockFirst = resolve; });
  await withProxy(am, {
    consume: async (n, token) => {
      if (token === 'Bearer tok-0') {
        releaseFirst();
        await firstMayAnswer;
        return { status: 200, body: { code: 'nothing_to_reset', windows_reset: 0 } };
      }
      return { status: 200, body: { code: 'reset', windows_reset: 2 } };
    },
  }, {}, async ({ proxyPort, calls }) => {
    const pending = postResponses(proxyPort);
    await firstInFlight;
    // The operator resets codex-1 while codex-0's (slow, no-spend) attempt is in flight.
    const operator = await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/codex/reset-credit?account=codex-1`, {
      method: 'POST', headers: { 'x-api-key': 'k' },
    });
    assert.equal(operator.status, 200, await operator.text());
    unblockFirst();
    const r = await pending;
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(calls.consume.map(c => c.token), ['Bearer tok-0', 'Bearer tok-1'], 'codex-2 is never charged');
    assert.deepEqual(calls.responses.map(c => c.token), ['Bearer tok-1'], 'served by the account the operator reset');
    assert.equal(am.accounts[2].quota.codexResetCredits, 2);
  });
});
