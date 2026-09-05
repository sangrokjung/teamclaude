import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import {
  applyCodexResetCreditOutcome,
  codexResetCreditEligibility,
  codexResetCreditsEndpoint,
  consumeCodexResetCredit,
  isCodexAccountExhausted,
  normalizeCodexResetCreditsConfig,
  parseCodexResetCreditsAvailable,
  rankCodexResetCreditCandidates,
} from '../src/codex-reset-credits.js';

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

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : null;
}

function codexAccount(overrides = {}) {
  return {
    name: 'codex-0',
    provider: 'codex',
    type: 'oauth',
    credential: 'tok-0',
    accountId: 'ws-0',
    enabled: true,
    status: 'active',
    rateLimitedUntil: null,
    quota: {
      unified5h: 0.1,
      unified7d: 1,
      unified5hReset: Date.now() + HOUR,
      unified7dReset: Date.now() + 60 * HOUR,
      unifiedStatus: null,
      codexResetCredits: 3,
      codexResetCreditLastAt: null,
      codexResetCreditLastOutcome: null,
      codexResetCreditsConsumed: 0,
    },
    ...overrides,
  };
}

test('endpoint derivation strips the trailing /codex like codexUsageEndpoint', () => {
  assert.equal(
    codexResetCreditsEndpoint('https://chatgpt.com/backend-api/codex'),
    'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
  );
  assert.equal(
    codexResetCreditsEndpoint('https://chatgpt.com/backend-api/codex/', { consume: true }),
    'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
  );
  assert.equal(
    codexResetCreditsEndpoint('http://127.0.0.1:4321?x=1#y', { consume: true }),
    'http://127.0.0.1:4321/wham/rate-limit-reset-credits/consume',
  );
});

test('config normalization: off by default, codex-only, sane bounds', () => {
  assert.deepEqual(normalizeCodexResetCreditsConfig({}, 'codex'), {
    enabled: false, policy: 'fleet', cooldownMs: 1800000, reserve: 0, timeoutMs: 10000,
  });
  assert.equal(normalizeCodexResetCreditsConfig({ codexResetCredits: true }, 'anthropic').enabled, false);
  const custom = normalizeCodexResetCreditsConfig({
    codexResetCredits: true,
    codexResetCreditsPolicy: 'account',
    codexResetCreditsCooldownMs: -5,
    codexResetCreditsReserve: 2,
    codexResetCreditsTimeoutMs: 250,
  }, 'codex');
  assert.deepEqual(custom, { enabled: true, policy: 'account', cooldownMs: 0, reserve: 2, timeoutMs: 250 });
  assert.equal(normalizeCodexResetCreditsConfig({ codexResetCreditsPolicy: 'bogus' }).policy, 'fleet');
  assert.equal(normalizeCodexResetCreditsConfig({ codexResetCreditsReserve: 1.5 }).reserve, 0);
});

test('available_count is parsed from wham/usage; absent or invalid → null', () => {
  assert.equal(parseCodexResetCreditsAvailable({ rate_limit_reset_credits: { available_count: 3 } }), 3);
  assert.equal(parseCodexResetCreditsAvailable({ rate_limit_reset_credits: { available_count: 0 } }), 0);
  assert.equal(parseCodexResetCreditsAvailable({}), null);
  assert.equal(parseCodexResetCreditsAvailable({ rate_limit_reset_credits: { available_count: '3' } }), null);
  assert.equal(parseCodexResetCreditsAvailable({ rate_limit_reset_credits: { available_count: -1 } }), null);
  assert.equal(parseCodexResetCreditsAvailable(null), null);
});

test('AccountManager.updateCodexUsage folds the credit count and stamps it', () => {
  const am = new AccountManager([{
    name: 'codex-0', provider: 'codex', type: 'oauth', accessToken: 'tok-0', refreshToken: 'r-0',
    accountId: 'ws-0', expiresAt: Date.now() + HOUR,
  }]);
  const before = Date.now();
  am.updateCodexUsage(am.accounts[0], {
    rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 3600 } },
    rate_limit_reset_credits: { available_count: 3, applicable_available_count: 0 },
  });
  assert.equal(am.accounts[0].quota.codexResetCredits, 3);
  assert.ok(am.accounts[0].quota.codexResetCreditsAt >= before);
  assert.equal(am.accounts[0].quota.unified7d, 1);
  am.updateCodexUsage(am.accounts[0], { rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604800 } } });
  assert.equal(am.accounts[0].quota.codexResetCredits, null, 'a payload without the field resets the cache to unknown');
});

test('exhaustion: throttle with a future rateLimitedUntil, or the manager verdict', () => {
  const now = Date.now();
  assert.equal(isCodexAccountExhausted(codexAccount({ status: 'throttled', rateLimitedUntil: now + 1000 }), { now }), true);
  assert.equal(isCodexAccountExhausted(codexAccount({ status: 'throttled', rateLimitedUntil: now - 1000 }), { now }), false);
  assert.equal(isCodexAccountExhausted(codexAccount(), { now, isExhausted: () => true }), true);
  assert.equal(isCodexAccountExhausted(codexAccount(), { now, isExhausted: () => false }), false);
  assert.equal(isCodexAccountExhausted(codexAccount(), { now }), false);
});

test('eligibility reasons cover every automatic-redemption guard', () => {
  const now = Date.now();
  const opts = { now, cooldownMs: 1000, reserve: 0, isExhausted: () => true };
  assert.deepEqual(codexResetCreditEligibility(codexAccount(), opts), { eligible: true, reason: 'ok' });
  assert.equal(codexResetCreditEligibility(codexAccount({ provider: 'anthropic' }), opts).reason, 'not-codex-oauth');
  assert.equal(codexResetCreditEligibility(codexAccount({ type: 'api' }), opts).reason, 'not-codex-oauth');
  assert.equal(codexResetCreditEligibility(codexAccount({ enabled: false }), opts).reason, 'disabled');
  assert.equal(codexResetCreditEligibility(codexAccount({ status: 'error' }), opts).reason, 'error');
  assert.equal(codexResetCreditEligibility(codexAccount({ authRevoked: true }), opts).reason, 'auth-revoked');
  assert.equal(codexResetCreditEligibility(codexAccount({ credential: null }), opts).reason, 'no-credential');
  const unknown = codexAccount(); unknown.quota.codexResetCredits = null;
  assert.equal(codexResetCreditEligibility(unknown, opts).reason, 'credits-unknown');
  const zero = codexAccount(); zero.quota.codexResetCredits = 0;
  assert.equal(codexResetCreditEligibility(zero, opts).reason, 'no-credits');
  const one = codexAccount(); one.quota.codexResetCredits = 1;
  assert.equal(codexResetCreditEligibility(one, { ...opts, reserve: 1 }).reason, 'reserved');
  const cooling = codexAccount(); cooling.quota.codexResetCreditLastAt = now - 500;
  assert.equal(codexResetCreditEligibility(cooling, opts).reason, 'cooldown');
  assert.equal(codexResetCreditEligibility(cooling, { ...opts, cooldownMs: 0 }).reason, 'ok', 'cooldown 0 disables the guard');
  assert.equal(codexResetCreditEligibility(codexAccount(), { ...opts, isExhausted: () => false }).reason, 'not-exhausted');
});

test('candidates: most credits first, then latest weekly reset, then pool order; ineligible dropped', () => {
  const now = Date.now();
  const a = codexAccount({ name: 'a' }); a.quota.codexResetCredits = 1; a.quota.unified7dReset = now + 10 * HOUR;
  const b = codexAccount({ name: 'b' }); b.quota.codexResetCredits = 3; b.quota.unified7dReset = now + 10 * HOUR;
  const c = codexAccount({ name: 'c' }); c.quota.codexResetCredits = 3; c.quota.unified7dReset = now + 50 * HOUR;
  const d = codexAccount({ name: 'd', enabled: false }); d.quota.codexResetCredits = 9;
  const e = codexAccount({ name: 'e' }); e.quota.codexResetCredits = 3; e.quota.unified7dReset = now + 50 * HOUR;
  const ranked = rankCodexResetCreditCandidates([a, b, c, d, e], { now, cooldownMs: 0, isExhausted: () => true });
  assert.deepEqual(ranked.map(x => x.name), ['c', 'e', 'b', 'a']);
  assert.deepEqual(rankCodexResetCreditCandidates(null, {}), []);
});

test('applying outcomes: reset clears usage + throttle and decrements; no_credit zeroes; others only stamp', () => {
  const now = Date.now();
  const acct = codexAccount({ status: 'throttled', rateLimitedUntil: now + 60_000 });
  assert.equal(applyCodexResetCreditOutcome(acct, { code: 'reset', windowsReset: 2 }, now), true);
  assert.equal(acct.quota.unified5h, 0);
  assert.equal(acct.quota.unified7d, 0);
  assert.equal(acct.quota.codexResetCredits, 2);
  assert.equal(acct.quota.codexResetCreditsConsumed, 1);
  assert.equal(acct.quota.codexResetCreditLastAt, now);
  assert.equal(acct.quota.codexResetCreditLastOutcome, 'reset');
  assert.equal(acct.status, 'active');
  assert.equal(acct.rateLimitedUntil, null);

  const nothing = codexAccount();
  assert.equal(applyCodexResetCreditOutcome(nothing, { code: 'nothing_to_reset' }, now), false);
  assert.equal(nothing.quota.unified7d, 1, 'usage untouched');
  assert.equal(nothing.quota.codexResetCredits, 3, 'count untouched');
  assert.equal(nothing.quota.codexResetCreditLastOutcome, 'nothing_to_reset');
  assert.equal(nothing.quota.codexResetCreditLastAt, now, 'cooldown stamped even without a reset');

  const none = codexAccount();
  assert.equal(applyCodexResetCreditOutcome(none, { code: 'no_credit' }, now), false);
  assert.equal(none.quota.codexResetCredits, 0);

  const failed = codexAccount();
  assert.equal(applyCodexResetCreditOutcome(failed, { code: 'http_500', error: 'boom' }, now), false);
  assert.equal(failed.quota.codexResetCreditLastOutcome, 'http_500');
  assert.equal(applyCodexResetCreditOutcome(null, { code: 'reset' }, now), false);
});

test('consume: POSTs the upstream contract (auth, account id, idempotency key) and maps the body', async () => {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    seen.push({ url: req.url, method: req.method, headers: req.headers, body: await readJson(req) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'reset', credit: { id: 'credit-1' }, windows_reset: 2 }));
  });
  const port = await listen(upstream);
  try {
    const outcome = await consumeCodexResetCredit({
      account: codexAccount(),
      upstream: `http://127.0.0.1:${port}/codex`,
      redeemRequestId: 'redeem-123',
    });
    assert.deepEqual(outcome, {
      ok: true, code: 'reset', windowsReset: 2, status: 200, redeemRequestId: 'redeem-123', error: null,
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].url, '/wham/rate-limit-reset-credits/consume');
    assert.equal(seen[0].headers.authorization, 'Bearer tok-0');
    assert.equal(seen[0].headers['chatgpt-account-id'], 'ws-0');
    assert.equal(seen[0].headers['content-type'], 'application/json');
    assert.deepEqual(seen[0].body, { redeem_request_id: 'redeem-123' }, 'no credit_id for a plain Full reset');

    const byId = await consumeCodexResetCredit({
      account: codexAccount(), upstream: `http://127.0.0.1:${port}`, redeemRequestId: 'redeem-456', creditId: 'credit-9',
    });
    assert.equal(byId.ok, true);
    assert.deepEqual(seen[1].body, { redeem_request_id: 'redeem-456', credit_id: 'credit-9' });

    const auto = await consumeCodexResetCredit({ account: codexAccount(), upstream: `http://127.0.0.1:${port}` });
    assert.match(auto.redeemRequestId, /^[0-9a-f-]{36}$/, 'a fresh UUID idempotency key per attempt');
    assert.notEqual(seen[2].body.redeem_request_id, seen[1].body.redeem_request_id);
  } finally {
    await closeServer(upstream);
  }
});

test('consume: non-reset codes, HTTP errors, garbage bodies and timeouts never throw', async () => {
  let mode = 'nothing';
  const upstream = http.createServer(async (req, res) => {
    await readJson(req);
    if (mode === 'nothing') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'nothing_to_reset', windows_reset: 0 }));
    } else if (mode === 'http') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'backend unavailable' } }));
    } else if (mode === 'garbage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('not json');
    } else if (mode === 'weird') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'brand_new_code' }));
    } else if (mode === 'hang') {
      // never answer; the caller's timeout must fire
    }
  });
  const port = await listen(upstream);
  const upstreamUrl = `http://127.0.0.1:${port}/codex`;
  try {
    const nothing = await consumeCodexResetCredit({ account: codexAccount(), upstream: upstreamUrl });
    assert.equal(nothing.ok, false);
    assert.equal(nothing.code, 'nothing_to_reset');
    assert.equal(nothing.windowsReset, 0);

    mode = 'http';
    const failed = await consumeCodexResetCredit({ account: codexAccount(), upstream: upstreamUrl });
    assert.deepEqual([failed.ok, failed.code, failed.status, failed.error], [false, 'http_503', 503, 'backend unavailable']);

    mode = 'garbage';
    const garbage = await consumeCodexResetCredit({ account: codexAccount(), upstream: upstreamUrl });
    assert.equal(garbage.ok, false);
    assert.equal(garbage.code, 'invalid_response');

    mode = 'weird';
    const weird = await consumeCodexResetCredit({ account: codexAccount(), upstream: upstreamUrl });
    assert.equal(weird.ok, false);
    assert.equal(weird.code, 'unknown');
    assert.match(weird.error, /brand_new_code/);

    mode = 'hang';
    const started = Date.now();
    const timeout = await consumeCodexResetCredit({ account: codexAccount(), upstream: upstreamUrl, timeoutMs: 120 });
    assert.equal(timeout.ok, false);
    assert.equal(timeout.code, 'timeout');
    assert.ok(Date.now() - started < 2000, 'timeout bounds the wait');

    const noCred = await consumeCodexResetCredit({ account: codexAccount({ credential: null }), upstream: upstreamUrl });
    assert.equal(noCred.code, 'error');
    assert.match(noCred.error, /credential/);
  } finally {
    await closeServer(upstream);
  }
});
