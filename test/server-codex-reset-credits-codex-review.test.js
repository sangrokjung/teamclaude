import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { codexResetCreditEligibility } from '../src/codex-reset-credits.js';

// Cross-model (Codex) adversarial review, 2026-09-05: the reset-credit ledger
// must survive a crash between the consume POST and the next periodic quota
// snapshot; the consistency fences must hold for BOTH the 5h and the 7d
// meter; the operator route and the automatic dead end must share one
// redemption; the loopback fence must ignore forwarded-for style headers.

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

function exhaustBoth(am, resetAt, credits = []) {
  am.accounts.forEach((a, i) => {
    a.quota.unified7d = 1;
    a.quota.unified7dReset = resetAt;
    a.quota.unified5h = 1;
    a.quota.unified5hReset = Date.now() + 2 * HOUR;
    a.quota.codexResetCredits = credits[i] ?? null;
  });
}

// Exhaustion 429 carrying BOTH meters at 100% (the 5h window is the
// secondary one in the live header set).
function exhaustion429Both(res) {
  res.writeHead(429, {
    'content-type': 'application/json',
    'retry-after': '60',
    'x-codex-primary-used-percent': '100',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 60 * 3600),
    'x-codex-secondary-used-percent': '100',
    'x-codex-secondary-window-minutes': '300',
    'x-codex-secondary-reset-at': String(Math.floor(Date.now() / 1000) + 2 * 3600),
  });
  res.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'pro', resets_at: Math.floor(Date.now() / 1000) + 60 * 3600 } }));
}

function ok200Both(res, used = '100') {
  res.writeHead(200, {
    'content-type': 'application/json',
    'x-codex-primary-used-percent': used,
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 60 * 3600),
    'x-codex-secondary-used-percent': used,
    'x-codex-secondary-window-minutes': '300',
    'x-codex-secondary-reset-at': String(Math.floor(Date.now() / 1000) + 2 * 3600),
  });
  res.end(JSON.stringify({ id: 'response-id', usage: { input_tokens: 1, output_tokens: 1 } }));
}

function usagePayloadBoth(used, credits) {
  const now = Math.floor(Date.now() / 1000);
  return {
    plan_type: 'pro',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: used, limit_window_seconds: 604800, reset_after_seconds: 60 * 3600, reset_at: now + 60 * 3600 },
      secondary_window: { used_percent: used, limit_window_seconds: 18000, reset_after_seconds: 2 * 3600, reset_at: now + 2 * 3600 },
    },
    rate_limit_reset_credits: { available_count: credits, applicable_available_count: 0 },
  };
}

function mockUpstream(script = {}) {
  const calls = { responses: [], consume: [], usage: [] };
  const server = http.createServer(async (req, res) => {
    const path = req.url.split('?', 1)[0];
    const token = req.headers.authorization;
    const body = await readBody(req);
    if (path === '/wham/rate-limit-reset-credits/consume') {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* keep null */ }
      calls.consume.push({ token, body: parsed });
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
      res.end(JSON.stringify(usagePayloadBoth(answer.used, answer.credits)));
      return;
    }
    calls.responses.push({ token, path });
    const answer = script.responses ? script.responses(calls.responses.length, token, res) : { status: 200 };
    if (answer === 'handled') return;
    if (answer.status === 429) exhaustion429Both(res);
    else ok200Both(res, answer.used ?? '1');
  });
  return { server, calls };
}

function startProxy(am, upstreamPort, overrides = {}, hooks = {}) {
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
  }, hooks);
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

async function withProxy(am, script, overrides, run, hooks = {}) {
  const { server: upstream, calls } = mockUpstream(script);
  const upstreamPort = await listen(upstream);
  const proxy = startProxy(am, upstreamPort, overrides, hooks);
  const proxyPort = await listen(proxy);
  try {
    await run({ proxyPort, calls, upstreamPort });
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
}

test('ledger durability: the host is asked to persist the snapshot before the consume POST (pending) and after the outcome', async () => {
  const am = new AccountManager(makeCodexAccounts(1));
  exhaustBoth(am, Date.now() + 60 * HOUR, [3]);
  const ledger = [];
  let releaseConsume = null;
  const consumeHeld = new Promise(resolve => { releaseConsume = resolve; });
  await withProxy(am, {
    consume: async () => { await consumeHeld; return { status: 200, body: { code: 'reset', windows_reset: 2 } }; },
  }, {}, async ({ proxyPort, calls }) => {
    const pending = postResponses(proxyPort);
    await waitFor(() => calls.consume.length === 1);
    // While the POST is in flight the ledger already shows a durable intent.
    assert.deepEqual(ledger, ['pending']);
    assert.equal(am.accounts[0].quota.codexResetCreditLastOutcome, 'pending');
    assert.ok(Date.now() - am.accounts[0].quota.codexResetCreditLastAt < 2000, 'cooldown stamped before the POST');
    releaseConsume();
    const r = await pending;
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(ledger, ['pending', 'reset'], 'outcome persisted right after it landed');
  }, {
    onResetCreditLedger: account => ledger.push(account.quota.codexResetCreditLastOutcome),
  });
});

test('ledger durability: a restored "pending" stamp keeps the account inside its cooldown after a restart', () => {
  const before = new AccountManager(makeCodexAccounts(1));
  exhaustBoth(before, Date.now() + 60 * HOUR, [3]);
  before.accounts[0].quota.codexResetCreditLastAt = Date.now() - 5_000;
  before.accounts[0].quota.codexResetCreditLastOutcome = 'pending';
  const snapshot = JSON.parse(JSON.stringify(before.exportQuotaState()));
  const after = new AccountManager(makeCodexAccounts(1));
  after.importQuotaState(snapshot);
  const verdict = codexResetCreditEligibility(after.accounts[0], {
    cooldownMs: 30 * 60 * 1000,
    isExhausted: a => after.isExhausted(a),
  });
  assert.deepEqual(verdict, { eligible: false, reason: 'pending' }, 'fail-closed until a poll re-reads the count, whatever the cooldown');
});

test('fences hold for BOTH meters: a stale pre-reset 429 and a lagging accepted response carry 5h AND 7d at 100%', async () => {
  const am = new AccountManager(makeCodexAccounts(1, { maxConcurrent: 3 }));
  am.accounts[0].quota.unified7d = 0.5;
  am.accounts[0].quota.unified7dReset = Date.now() + 60 * HOUR;
  am.accounts[0].quota.unified5h = 0.5;
  am.accounts[0].quota.unified5hReset = Date.now() + 2 * HOUR;
  am.accounts[0].quota.codexResetCredits = 3;
  const held = new Map();
  let releaseSecond = null;
  const bothArrived = new Promise(resolve => { releaseSecond = resolve; });
  await withProxy(am, {
    responses: (n, _token, res) => {
      if (n === 1 || n === 2) {
        held.set(n, res);
        if (held.size === 2) {
          exhaustion429Both(held.get(1)); // R1 rejected → reset → R1 retries as #3
          releaseSecond();
        }
        return 'handled';
      }
      if (n === 3) {
        ok200Both(res, '100'); // accepted, but its headers still show the pre-reset 100%
        setTimeout(() => exhaustion429Both(held.get(2)), 20); // R2's stale 429 lands after the reset
        return 'handled';
      }
      return { status: 200 };
    },
  }, {}, async ({ proxyPort, calls }) => {
    const r1 = postResponses(proxyPort);
    const r2 = postResponses(proxyPort);
    await bothArrived;
    const [a, b] = await Promise.all([r1, r2]);
    assert.equal(a.status, 200, a.text);
    assert.equal(b.status, 200, b.text);
    assert.equal(calls.consume.length, 1);
    assert.equal(am.accounts[0].quota.unified7d, 0, '7d meter untouched by the stale 429 and the lagging 200');
    assert.equal(am.accounts[0].quota.unified5h, 0, '5h meter untouched too');
    assert.equal(am.accounts[0].status, 'active');
    assert.equal(calls.responses.length, 4);
  });
});

test('grace holds for BOTH meters on the authoritative poll, then both re-apply after the grace', async () => {
  const am = new AccountManager(makeCodexAccounts(1));
  await withProxy(am, { usage: () => ({ used: 100, credits: 3 }) },
    { codexUsageRefresh: true, warmupIntervalMs: 0 }, async ({ proxyPort, calls }) => {
      await waitFor(() => am.accounts[0].quota.codexUsageAt != null);
      assert.equal(am.accounts[0].quota.unified5h, 1);
      assert.equal(am.accounts[0].quota.unified7d, 1);
      const r = await postResponses(proxyPort);
      assert.equal(r.status, 200, r.text);
      const polls = calls.usage.length;
      await waitFor(() => calls.usage.length > polls, 4000);
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(am.accounts[0].quota.unified7d, 0, '7d held inside the grace');
      assert.equal(am.accounts[0].quota.unified5h, 0, '5h held inside the grace');
      // Past the grace the authoritative meter wins again for both windows.
      am.accounts[0].quota.codexResetCreditResetAt = Date.now() - 200_000;
      am.updateCodexUsage(am.accounts[0], usagePayloadBoth(100, 2));
      assert.equal(am.accounts[0].quota.unified7d, 1);
      assert.equal(am.accounts[0].quota.unified5h, 1);
    });
});

test('the operator route and an automatic dead end share ONE redemption (single-flight across paths)', async () => {
  const am = new AccountManager(makeCodexAccounts(1));
  exhaustBoth(am, Date.now() + 60 * HOUR, [3]);
  let releaseConsume = null;
  const consumeHeld = new Promise(resolve => { releaseConsume = resolve; });
  await withProxy(am, {
    consume: async () => { await consumeHeld; return { status: 200, body: { code: 'reset', windows_reset: 2 } }; },
  }, {}, async ({ proxyPort, calls }) => {
    const auto = postResponses(proxyPort); // automatic dead end → consume in flight
    await waitFor(() => calls.consume.length === 1);
    const operator = fetch(`http://127.0.0.1:${proxyPort}/teamclaude/codex/reset-credit?account=codex-0`, {
      method: 'POST', headers: { 'x-api-key': 'k' },
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(calls.consume.length, 1, 'the operator call joined the in-flight redemption');
    releaseConsume();
    const [r, op] = await Promise.all([auto, operator]);
    assert.equal(r.status, 200, r.text);
    assert.equal(op.status, 200);
    const body = await op.json();
    assert.equal(body.reset, true);
    assert.equal(calls.consume.length, 1, 'exactly one credit for both callers');
    assert.equal(am.accounts[0].quota.codexResetCredits, 2);
  });
});

test('operator route: forwarded-for style headers cannot impersonate loopback', async t => {
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
    const spoofed = await fetch(`http://${host}:${proxyPort}/teamclaude/codex/reset-credit?account=codex-0`, {
      method: 'POST',
      headers: {
        'x-api-key': 'k',
        'x-forwarded-for': '127.0.0.1',
        'x-real-ip': '127.0.0.1',
        forwarded: 'for=127.0.0.1',
      },
    });
    assert.equal(spoofed.status, 403);
    assert.equal((await spoofed.json()).error.type, 'permission_error');
    assert.equal(calls.consume.length, 0);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('the retry backstop yields once to an unspent redemption pass instead of the legacy "All accounts throttled" body', async () => {
  // One account (maxRetries 1). R1 and R2 are in flight on it; R1's 429 resets
  // the account (R1's pass), R2's stale 429 is retried (retryCount 1 == cap),
  // and that retry meets a genuine post-reset 429. Before the fix the cap
  // answered R2 with the legacy body without ever reaching the acquisition
  // dead end; now R2 gets there and ends in the Codex-native fail-fast body.
  const am = new AccountManager(makeCodexAccounts(1, { maxConcurrent: 3 }));
  am.accounts[0].quota.unified7d = 0.5;
  am.accounts[0].quota.unified7dReset = Date.now() + 60 * HOUR;
  am.accounts[0].quota.unified5h = 0.5;
  am.accounts[0].quota.unified5hReset = Date.now() + 2 * HOUR;
  am.accounts[0].quota.codexResetCredits = 3;
  const held = new Map();
  let releaseSecond = null;
  const bothArrived = new Promise(resolve => { releaseSecond = resolve; });
  await withProxy(am, {
    responses: (n, _token, res) => {
      if (n === 1 || n === 2) {
        held.set(n, res);
        if (held.size === 2) { exhaustion429Both(held.get(1)); releaseSecond(); }
        return 'handled';
      }
      if (n === 3) {
        ok200Both(res, '1'); // R1 served after the reset
        setTimeout(() => exhaustion429Both(held.get(2)), 20); // R2's stale 429 lands after the reset
        return 'handled';
      }
      return { status: 429 }; // R2's post-reset retry is genuinely rejected
    },
  }, { continuityMaxWaitMs: 500, continuityMaxSleepMs: 10 }, async ({ proxyPort, calls }) => {
    const r1 = postResponses(proxyPort);
    const r2 = postResponses(proxyPort);
    await bothArrived;
    const [a, b] = await Promise.all([r1, r2]);
    assert.equal(a.status, 200, a.text);
    assert.equal(b.status, 429, b.text);
    assert.equal(b.json?.error?.type, 'usage_limit_reached', b.text);
    assert.doesNotMatch(b.text, /All accounts throttled/, 'legacy backstop body must not pre-empt the dead end');
    assert.equal(calls.consume.length, 1, 'still one credit for the episode');
    assert.equal(calls.responses.length, 4);
  });
});

test('an operator redemption on an account this request cannot use does not capture the automatic pass', async () => {
  // codex-0 is quarantined for the model (operator resets it anyway, slowly);
  // codex-1 is exhausted with credits. The automatic dead end must redeem on
  // codex-1 instead of joining codex-0's in-flight redemption.
  const am = new AccountManager(makeCodexAccounts(2));
  am.accounts[0].quota.unified7d = 1;
  am.accounts[0].quota.unified7dReset = Date.now() + 60 * HOUR;
  am.accounts[0].quota.unified5h = 0.1;
  am.accounts[0].quota.unified5hReset = Date.now() + 2 * HOUR;
  am.accounts[0].quota.codexResetCredits = 3;
  am.markModelUnsupported(am.accounts[0], 'gpt-5.6');
  am.accounts[1].quota.unified7d = 1;
  am.accounts[1].quota.unified7dReset = Date.now() + 60 * HOUR;
  am.accounts[1].quota.unified5h = 0.1;
  am.accounts[1].quota.unified5hReset = Date.now() + 2 * HOUR;
  am.accounts[1].quota.codexResetCredits = 2;
  let releaseOperator = null;
  const operatorHeld = new Promise(resolve => { releaseOperator = resolve; });
  await withProxy(am, {
    consume: async (_n, token) => {
      if (token === 'Bearer tok-0') await operatorHeld;
      return { status: 200, body: { code: 'reset', windows_reset: 2 } };
    },
  }, {}, async ({ proxyPort, calls }) => {
    const operator = fetch(`http://127.0.0.1:${proxyPort}/teamclaude/codex/reset-credit?account=codex-0`, {
      method: 'POST', headers: { 'x-api-key': 'k' },
    });
    await waitFor(() => calls.consume.length === 1);
    const r = await postResponses(proxyPort); // automatic dead end while codex-0's redemption is in flight
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(calls.consume.map(c => c.token), ['Bearer tok-0', 'Bearer tok-1'], 'the automatic pass went to the account that can serve');
    assert.deepEqual(calls.responses.map(c => c.token), ['Bearer tok-1']);
    releaseOperator();
    assert.equal((await operator).status, 200);
  });
});

test('restart with cooldown 0: a restored "pending" stamp blocks redemption until the poll re-reads the count', async () => {
  const before = new AccountManager(makeCodexAccounts(1));
  exhaustBoth(before, Date.now() + 60 * HOUR, [3]);
  before.accounts[0].quota.codexResetCreditLastAt = Date.now() - 5_000;
  before.accounts[0].quota.codexResetCreditLastOutcome = 'pending';
  before.accounts[0].quota.codexResetCreditsAt = Date.now() - 60_000;
  const snapshot = JSON.parse(JSON.stringify(before.exportQuotaState()));
  const restored = new AccountManager(makeCodexAccounts(1));
  restored.importQuotaState(snapshot);
  await withProxy(restored, {}, { codexResetCreditsCooldownMs: 0 }, async ({ proxyPort, calls }) => {
    const r = await postResponses(proxyPort);
    assert.equal(r.status, 429, r.text);
    assert.equal(calls.consume.length, 0, 'fail-closed: no second redemption before the count is reconciled');
  });
  // The authoritative poll re-reads the count (2 left, still 100%) → eligible again.
  const polled = new AccountManager(makeCodexAccounts(1));
  polled.importQuotaState(snapshot);
  await withProxy(polled, { usage: () => ({ used: 100, credits: 2 }) },
    { codexResetCreditsCooldownMs: 0, codexUsageRefresh: true, warmupIntervalMs: 0 }, async ({ proxyPort, calls }) => {
      await waitFor(() => polled.accounts[0].quota.codexResetCreditsAt > polled.accounts[0].quota.codexResetCreditLastAt);
      const r = await postResponses(proxyPort);
      assert.equal(r.status, 200, r.text);
      assert.equal(calls.consume.length, 1, 'a reconciled count allows the (operator-chosen cooldown 0) redemption');
    });
});
