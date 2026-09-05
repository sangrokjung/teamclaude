import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// Automatic redemption of Codex "Full reset" rate-limit reset credits
// (docs/specs/2026-09-05-codex-reset-credits.md). The pool is weekly-exhausted
// (the 2026-09-04/05 incident shape); instead of failing fast, the proxy must
// POST /wham/rate-limit-reset-credits/consume on an exhausted account that
// still holds credits, fold the "reset" locally, and serve the request.

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

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met before timeout');
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

// Mock ChatGPT backend: /codex/responses (+ /responses), the consume endpoint,
// and wham/usage. `script` lets a test shape each answer.
function mockUpstream(script = {}) {
  const calls = { responses: [], consume: [], usage: [] };
  const server = http.createServer(async (req, res) => {
    const path = req.url.split('?', 1)[0];
    const token = req.headers.authorization;
    const body = await readBody(req);
    if (path === '/wham/rate-limit-reset-credits/consume') {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* keep null */ }
      calls.consume.push({ token, accountId: req.headers['chatgpt-account-id'], body: parsed, method: req.method });
      const answer = script.consume ? script.consume(calls.consume.length, req) : { status: 200, body: { code: 'reset', windows_reset: 2 } };
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
      return;
    }
    if (path === '/wham/usage') {
      calls.usage.push({ token });
      const answer = script.usage ? script.usage(calls.usage.length, req) : { used: 100, credits: 3 };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        plan_type: 'pro',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: answer.used,
            limit_window_seconds: 604800,
            reset_after_seconds: 60 * 3600,
            reset_at: Math.floor(Date.now() / 1000) + 60 * 3600,
          },
          secondary_window: null,
        },
        rate_limit_reset_credits: { available_count: answer.credits, applicable_available_count: 0 },
      }));
      return;
    }
    calls.responses.push({ token, path });
    const answer = script.responses ? script.responses(calls.responses.length, token) : { status: 200 };
    if (answer.status === 429) {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '60',
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-window-minutes': '10080',
        'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 60 * 3600),
      });
      res.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'pro', resets_at: Math.floor(Date.now() / 1000) + 60 * 3600 } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'response-id', usage: { input_tokens: 1, output_tokens: 1 } }));
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

test('fleet policy: a quota dead end redeems one credit on the best account and serves the request', async () => {
  const { server: upstream, calls } = mockUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeCodexAccounts(2));
  exhaustWeekly(am, Date.now() + 60 * HOUR, [0, 3]); // codex-0 has no credits, codex-1 has 3
  const proxy = startProxy(am, upstreamPort, { codexResetCredits: true });
  const proxyPort = await listen(proxy);
  const logs = captureLogs();
  try {
    const r = await postResponses(proxyPort);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json?.id, 'response-id');
    assert.ok(r.elapsedMs < 3000, `served in ${r.elapsedMs}ms`);
    assert.equal(calls.consume.length, 1, 'exactly one redemption');
    assert.equal(calls.consume[0].token, 'Bearer tok-1', 'the account WITH credits redeems');
    assert.equal(calls.consume[0].accountId, 'ws-1');
    assert.equal(calls.consume[0].method, 'POST');
    assert.match(calls.consume[0].body.redeem_request_id, /^[0-9a-f-]{36}$/);
    assert.ok(!('credit_id' in calls.consume[0].body), 'plain Full reset sends no credit_id');
    assert.deepEqual(calls.responses.map(c => c.token), ['Bearer tok-1'], 'served by the reset account');
    const reset = am.accounts[1];
    assert.equal(reset.quota.codexResetCredits, 2);
    assert.equal(reset.quota.unified7d, 0);
    assert.equal(reset.quota.codexResetCreditsConsumed, 1);
    assert.equal(reset.quota.codexResetCreditLastOutcome, 'reset');
    assert.equal(am.accounts[0].quota.unified7d, 1, 'the creditless account is untouched');
    assert.ok(logs.lines.some(l => l.includes('[TeamCodex] Reset credit redeemed on "codex-1"')), logs.lines.join('\n'));
    assert.equal(logs.lines.filter(l => l.includes('failing fast')).length, 0, 'no fail-fast when a credit worked');
  } finally {
    logs.restore();
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('fleet policy: nothing_to_reset falls through to the fail-fast 429 and the cooldown blocks a retry', async () => {
  const { server: upstream, calls } = mockUpstream({
    consume: () => ({ status: 200, body: { code: 'nothing_to_reset', windows_reset: 0 } }),
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeCodexAccounts(2));
  exhaustWeekly(am, Date.now() + 60 * HOUR, [3, 3]);
  const proxy = startProxy(am, upstreamPort, { codexResetCredits: true });
  const proxyPort = await listen(proxy);
  const logs = captureLogs();
  try {
    const first = await postResponses(proxyPort);
    assert.equal(first.status, 429, first.text);
    assert.equal(first.json?.error?.type, 'usage_limit_reached', 'existing Codex-native body survives');
    assert.ok(first.elapsedMs < 3000, `answered in ${first.elapsedMs}ms`);
    assert.equal(calls.consume.length, 2, 'every eligible candidate was tried once (both hold credits)');
    assert.equal(calls.responses.length, 0);
    for (const a of am.accounts) {
      assert.equal(a.quota.codexResetCreditLastOutcome, 'nothing_to_reset');
      assert.equal(a.quota.codexResetCredits, 3, 'count untouched on nothing_to_reset');
      assert.equal(a.quota.unified7d, 1);
    }
    const second = await postResponses(proxyPort);
    assert.equal(second.status, 429, second.text);
    assert.equal(calls.consume.length, 2, 'cooldown: no further redemption attempts');
    assert.ok(logs.lines.some(l => l.includes('NOT applied') && l.includes('nothing_to_reset')));
  } finally {
    logs.restore();
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('default (codexResetCredits off): zero redemption calls, fail-fast unchanged', async () => {
  const { server: upstream, calls } = mockUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeCodexAccounts(2));
  exhaustWeekly(am, Date.now() + 60 * HOUR, [3, 3]);
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy);
  try {
    const r = await postResponses(proxyPort);
    assert.equal(r.status, 429, r.text);
    assert.equal(r.json?.error?.type, 'usage_limit_reached');
    assert.equal(calls.consume.length, 0);
    assert.equal(am.accounts[0].quota.codexResetCredits, 3);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('fleet policy: while another account can serve, no credit is spent', async () => {
  const { server: upstream, calls } = mockUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeCodexAccounts(2));
  exhaustWeekly(am, Date.now() + 60 * HOUR, [3, 3]);
  am.accounts[1].quota.unified7d = 0.2; // codex-1 still healthy
  const proxy = startProxy(am, upstreamPort, { codexResetCredits: true });
  const proxyPort = await listen(proxy);
  try {
    const r = await postResponses(proxyPort);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(calls.responses.map(c => c.token), ['Bearer tok-1']);
    assert.equal(calls.consume.length, 0, 'rotation wins over redemption');
    assert.equal(am.accounts[0].quota.codexResetCredits, 3);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('account policy: an exhaustion 429 redeems on that account and retries it in place', async () => {
  const { server: upstream, calls } = mockUpstream({
    responses: n => ({ status: n === 1 ? 429 : 200 }),
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeCodexAccounts(1));
  am.accounts[0].quota.codexResetCredits = 3; // count known from a prior wham/usage poll
  const proxy = startProxy(am, upstreamPort, { codexResetCredits: true, codexResetCreditsPolicy: 'account' });
  const proxyPort = await listen(proxy);
  const logs = captureLogs();
  try {
    const r = await postResponses(proxyPort);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json?.id, 'response-id');
    assert.deepEqual(calls.responses.map(c => c.token), ['Bearer tok-0', 'Bearer tok-0'], '429 then retry on the same account');
    assert.equal(calls.consume.length, 1);
    assert.equal(calls.consume[0].token, 'Bearer tok-0');
    assert.equal(am.accounts[0].status, 'active', 'never throttled');
    assert.equal(am.accounts[0].quota.codexResetCredits, 2);
    assert.ok(logs.lines.some(l => l.includes('429-exhausted')), logs.lines.join('\n'));
    assert.equal(logs.lines.filter(l => l.includes('throttling')).length, 0);
  } finally {
    logs.restore();
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('fleet policy: an exhaustion 429 on the last healthy account still throttles first, then redeems at the dead end', async () => {
  const { server: upstream, calls } = mockUpstream({
    responses: n => ({ status: n === 1 ? 429 : 200 }),
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeCodexAccounts(1));
  am.accounts[0].quota.codexResetCredits = 3;
  const proxy = startProxy(am, upstreamPort, { codexResetCredits: true });
  const proxyPort = await listen(proxy);
  const logs = captureLogs();
  try {
    const r = await postResponses(proxyPort);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(calls.responses.map(c => c.token), ['Bearer tok-0', 'Bearer tok-0']);
    assert.equal(calls.consume.length, 1);
    assert.ok(logs.lines.some(l => l.includes('throttling')), 'fleet policy keeps the throttle-and-switch step');
    assert.ok(logs.lines.some(l => l.includes('fleet-exhausted')), logs.lines.join('\n'));
    assert.equal(am.accounts[0].status, 'active', 'the reset lifted the throttle');
    assert.equal(am.accounts[0].rateLimitedUntil, null);
  } finally {
    logs.restore();
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('consume endpoint failure (HTTP 500) falls through to the existing 429 and stamps the cooldown', async () => {
  const { server: upstream, calls } = mockUpstream({
    consume: () => ({ status: 500, body: { error: { message: 'backend down' } } }),
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeCodexAccounts(1));
  exhaustWeekly(am, Date.now() + 60 * HOUR, [3]);
  const proxy = startProxy(am, upstreamPort, { codexResetCredits: true });
  const proxyPort = await listen(proxy);
  try {
    const r = await postResponses(proxyPort);
    assert.equal(r.status, 429, r.text);
    assert.equal(r.json?.error?.type, 'usage_limit_reached');
    assert.equal(calls.consume.length, 1);
    assert.equal(am.accounts[0].quota.codexResetCreditLastOutcome, 'http_500');
    assert.equal(am.accounts[0].quota.codexResetCredits, 3);
    assert.ok(am.accounts[0].quota.codexResetCreditLastAt > 0);
    assert.equal(am.accounts[0].quota.unified7d, 1);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('reserve: the last credits are kept when codexResetCreditsReserve says so', async () => {
  const { server: upstream, calls } = mockUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeCodexAccounts(1));
  exhaustWeekly(am, Date.now() + 60 * HOUR, [1]);
  const proxy = startProxy(am, upstreamPort, { codexResetCredits: true, codexResetCreditsReserve: 1 });
  const proxyPort = await listen(proxy);
  try {
    const r = await postResponses(proxyPort);
    assert.equal(r.status, 429, r.text);
    assert.equal(calls.consume.length, 0);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('anthropic provider ignores codexResetCredits entirely', async () => {
  const { server: upstream, calls } = mockUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{
    name: 'acct-0', type: 'oauth', accessToken: 'tok-0', refreshToken: 'r-0', expiresAt: Date.now() + HOUR,
  }]);
  exhaustWeekly(am, Date.now() + 60 * HOUR, [3]);
  const proxy = startProxy(am, upstreamPort, { provider: 'anthropic', codexResetCredits: true });
  const proxyPort = await listen(proxy);
  try {
    const r = await postResponses(proxyPort, '/v1/messages');
    assert.equal(r.status, 429, r.text);
    assert.equal(r.json?.error?.type, 'rate_limit_error');
    assert.equal(calls.consume.length, 0);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('realistic flow: the startup wham/usage poll learns the count, a reset is followed by a refresh', async () => {
  let usageState = { used: 100, credits: 3 };
  const { server: upstream, calls } = mockUpstream({
    usage: () => usageState,
    consume: () => { usageState = { used: 0, credits: 2 }; return { status: 200, body: { code: 'reset', windows_reset: 2 } }; },
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeCodexAccounts(1));
  const proxy = startProxy(am, upstreamPort, { codexResetCredits: true, codexUsageRefresh: true, warmupIntervalMs: 0 });
  const proxyPort = await listen(proxy);
  try {
    await waitFor(() => am.accounts[0].quota.codexUsageAt != null);
    assert.equal(am.accounts[0].quota.unified7d, 1, 'startup poll folded the exhausted window');
    assert.equal(am.accounts[0].quota.codexResetCredits, 3, 'startup poll folded the credit count');
    const r = await postResponses(proxyPort);
    assert.equal(r.status, 200, r.text);
    assert.equal(calls.consume.length, 1);
    assert.equal(am.accounts[0].quota.codexResetCredits, 2, 'local decrement right after the reset');
    const usageCallsAfterReset = calls.usage.length;
    await waitFor(() => calls.usage.length > usageCallsAfterReset, 3000);
    await waitFor(() => am.accounts[0].quota.codexResetCreditsAt > am.accounts[0].quota.codexResetCreditLastAt, 3000);
    assert.equal(am.accounts[0].quota.unified7d, 0, 'authoritative refresh confirms the reset');
    assert.equal(am.accounts[0].quota.codexResetCredits, 2, 'authoritative refresh agrees with the local decrement');
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('operator endpoint: POST /teamclaude/codex/reset-credit?account=<name> redeems on demand', async () => {
  let consumeCode = 'reset';
  const { server: upstream, calls } = mockUpstream({
    consume: () => ({ status: 200, body: { code: consumeCode, windows_reset: consumeCode === 'reset' ? 2 : 0 } }),
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeCodexAccounts(1));
  am.accounts[0].quota.unified7d = 0.5; // NOT exhausted: the operator path ignores eligibility
  am.accounts[0].quota.codexResetCredits = 1;
  const proxy = startProxy(am, upstreamPort); // automatic redemption OFF — the operator path still works
  const proxyPort = await listen(proxy);
  const base = `http://127.0.0.1:${proxyPort}/teamclaude/codex/reset-credit`;
  try {
    const ok = await fetch(`${base}?account=codex-0`, { method: 'POST', headers: { 'x-api-key': 'k' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), {
      account: 'codex-0', reset: true, outcome: 'reset', resetCredits: 0, unified5h: 0, unified7d: 0,
    });
    assert.equal(calls.consume.length, 1);

    consumeCode = 'no_credit';
    const conflict = await fetch(`${base}?account=codex-0`, { method: 'POST', headers: { 'x-api-key': 'k' } });
    assert.equal(conflict.status, 409, 'non-reset outcome is a conflict, not an error');
    const body = await conflict.json();
    assert.equal(body.reset, false);
    assert.equal(body.outcome, 'no_credit');
    assert.equal(calls.consume.length, 2, 'the operator path ignores the automatic cooldown');

    const unknown = await fetch(`${base}?account=nope`, { method: 'POST', headers: { 'x-api-key': 'k' } });
    assert.equal(unknown.status, 404);
    const wrongMethod = await fetch(`${base}?account=codex-0`, { method: 'GET', headers: { 'x-api-key': 'k' } });
    assert.equal(wrongMethod.status, 405);
    await wrongMethod.text();
    const withBody = await fetch(`${base}?account=codex-0`, { method: 'POST', headers: { 'x-api-key': 'k', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(withBody.status, 400);
    await withBody.text();
    const badKey = await fetch(`${base}?account=codex-0`, { method: 'POST', headers: { 'x-api-key': 'wrong' } });
    assert.equal(badKey.status, 401, 'the proxy API key is required even from loopback');
    await badKey.text();
    assert.equal(calls.consume.length, 2, 'rejected requests never reach the backend');
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('status surfaces the credit ledger through the quota snapshot', async () => {
  const { server: upstream } = mockUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeCodexAccounts(1));
  exhaustWeekly(am, Date.now() + 60 * HOUR, [3]);
  const proxy = startProxy(am, upstreamPort, { codexResetCredits: true });
  const proxyPort = await listen(proxy);
  try {
    await postResponses(proxyPort);
    const status = await (await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/status`)).json();
    const q = status.accounts[0].quota;
    assert.equal(q.codexResetCredits, 2);
    assert.equal(q.codexResetCreditsConsumed, 1);
    assert.equal(q.codexResetCreditLastOutcome, 'reset');
    assert.ok(!('name' in status.accounts[0]), 'identity redaction unchanged');
    const exported = am.exportQuotaState()[0].quota;
    assert.equal(exported.codexResetCredits, 2, 'the ledger rides on the persisted quota snapshot');
    assert.equal(exported.codexResetCreditLastOutcome, 'reset');
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});
