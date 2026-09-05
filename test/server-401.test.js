import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Regression (adversarial review): a 401 (auth failure / revoked token) must
// fail the account out and switch — not get retried as a warm-up target,
// which would route repeated 401s to the client. Account 'a' has no refresh
// token, so the proxy can't refresh it: it must mark 'a' error and switch to
// the healthy account 'b' after a single 401.
test('a 401 marks the account error and switches, without repeated 401s', async () => {
  let aHits = 0;
  const upstream = http.createServer((req, res) => {
    const auth = req.headers['authorization'] || '';
    if (auth.includes('tok-a')) {
      aHits++;
      res.writeHead(401, { 'content-type': 'application/json' }); // no rate-limit headers
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', expiresAt: Date.now() + 3600_000 }, // no refreshToken → can't refresh
    { name: 'b', type: 'oauth', accessToken: 'tok-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false, // isolate 401 failover from background warm-up probes
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 200);                  // switched to the healthy account
    assert.equal(aHits, 1, `revoked account must not be retried, got ${aHits} hits`);
    assert.equal(am.accounts[0].status, 'error');   // failed out → excluded from rotation + warm-up
  } finally {
    proxy.close();
    upstream.close();
  }
});

// When every account fails auth, the proxy surfaces a 401 to the client
// (bounded — no infinite retry).
test('all accounts failing auth → returns 401 to the client', async () => {
  let hits = 0;
  const upstream = http.createServer((_req, res) => {
    hits++;
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false, // isolate 401 failover from background warm-up probes
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 401);
    assert.ok(hits >= 1 && hits <= 4, `expected bounded retries, got ${hits}`);
    // Cascade guard (2026-09-05 incident): a 401 that repeats across accounts is
    // evidence about the REQUEST, so the fleet must stay in rotation. Before the
    // guard this asserted the opposite — one bad request parked every account.
    assert.ok(am.accounts.every(a => a.status !== 'error'),
      `no account may be parked by a request-scoped 401, got ${JSON.stringify(am.accounts.map(a => [a.name, a.status]))}`);
  } finally {
    proxy.close();
    upstream.close();
  }
});

// Cascade guard — regression for the 2026-09-05 outage: ONE request walked the
// failover chain, every account answered 401, and all 9 it touched were parked
// with 'auth-rejected'. A direct probe afterwards proved those credentials were
// still valid. Two independent accounts rejecting the same request is evidence
// about the request; the fleet must stay in rotation.
// Spec: docs/specs/2026-09-05-auth-401-cascade-guard.md
test('a 401 cascade across the fleet parks nobody and does not loop', async () => {
  const hits = new Map();
  const upstream = http.createServer((req, res) => {
    const auth = req.headers['authorization'] || '';
    hits.set(auth, (hits.get(auth) || 0) + 1);
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', expiresAt: Date.now() + 3600_000 },
    { name: 'c', type: 'oauth', accessToken: 'tok-c', expiresAt: Date.now() + 3600_000 },
    { name: 'd', type: 'oauth', accessToken: 'tok-d', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const startedAt = Date.now();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    const text = await res.text();
    // Continuity deadline mode is ON by default (continuityMaxWaitMs = 15min).
    // If the fleet-wide "everyone failed auth" checks stopped counting a
    // non-parked 401 account, this request would sit in the capacity wait
    // instead — surfacing as a multi-minute hang rather than a clear failure.
    assert.ok(Date.now() - startedAt < 5_000,
      `a request nobody authenticates must fail fast, took ${Date.now() - startedAt}ms`);
    assert.equal(res.status, 401, 'a request nobody authenticates still surfaces 401, not a 429 backoff');
    assert.match(text, /stay in rotation/, 'the client message must not send the operator re-logging in');
    assert.deepEqual(
      am.accounts.filter(a => a.status === 'error').map(a => a.name),
      [],
      'one bad request must not park any account',
    );
    for (const [auth, count] of hits) {
      assert.equal(count, 1, `${auth} was retried ${count}× — a non-parked 401 account must still be excluded`);
    }
  } finally {
    proxy.close();
    upstream.close();
  }
});

// The FIRST 401 of a request still parks its account (a genuinely revoked
// account must be caught). When a second account then rejects the same request,
// that inference is retracted — including for the already-parked one.
test('a cascade restores the account the same request parked', async () => {
  const upstream = http.createServer((req, res) => {
    const auth = req.headers['authorization'] || '';
    if (auth.includes('tok-c')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', expiresAt: Date.now() + 3600_000 },
    { name: 'c', type: 'oauth', accessToken: 'tok-c', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 200, 'the request must still fail over to the account that serves it');
    assert.equal(am.accounts[0].status, 'active', 'the first 401 park must be rolled back by the cascade');
    assert.equal(am.accounts[0].errorReason ?? null, null, 'the rolled-back account must not keep an error reason');
    assert.equal(am.accounts[1].status, 'active');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// A failed token refresh is the account's OWN evidence — it does not depend on
// the request — so an ongoing cascade must neither revive it nor relabel it
// ('auth-rejected' would also cost it the refresh-sweep self-healing that
// `_errorFromRefresh` buys). The cascade here is created by the two accounts
// with UNEXPLAINED 401s; the refresh-failed one is visited afterwards.
test('a cascade leaves a refresh-failed account parked with its own reason', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', expiresAt: Date.now() + 3600_000 }, // unexplained 401 (no refresh)
    { name: 'b', type: 'oauth', accessToken: 'tok-b', expiresAt: Date.now() + 3600_000 }, // unexplained 401 → trips the cascade
    { name: 'c', type: 'oauth', accessToken: 'tok-c', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }, // its own refresh fails
  ], 0.98);
  // Only the 401-triggered FORCED refresh is stubbed; the pre-dispatch
  // freshness check is a no-op here (the tokens are an hour from expiry),
  // exactly as the real ensureTokenFresh behaves.
  am.ensureTokenFresh = async (account, force) => {
    if (!force || account.name !== 'c') return;
    account.status = 'error';           // refresh endpoint rejected it
    account.errorReason = 'refresh-failed';
    account._errorFromRefresh = true;
  };
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 401);
    assert.equal(am.accounts[0].status, 'active', 'the request-scoped park must be rolled back');
    assert.equal(am.accounts[1].status, 'active', 'the account that tripped the cascade must not be parked');
    assert.equal(am.accounts[2].status, 'error', 'a failed refresh is account-scoped evidence, keep it parked');
    assert.equal(am.accounts[2].errorReason, 'refresh-failed', 'the cascade must not relabel it auth-rejected');
    assert.equal(am.accounts[2]._errorFromRefresh, true, 'and must not strip its refresh-sweep self-healing');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// Adversarial review 2026-09-05: the cascade tally must ignore accounts that
// arrive already parked by their OWN evidence. Otherwise a fleet that merely
// contains one degraded account (common) inflates the count, and the next
// account — genuinely revoked, with no refresh to fall back on — trips the
// guard and stays in rotation, invisible in `teamclaude status`.
test('an account parked by its own failed refresh does not count toward the cascade', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    // visited FIRST, and parks itself: its forced refresh fails
    { name: 'refresh-broken', type: 'oauth', accessToken: 'tok-r', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    // visited SECOND, unambiguous: no refresh to try, 401 on a valid token
    { name: 'revoked', type: 'oauth', accessToken: 'tok-u', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  am.ensureTokenFresh = async (account, force) => {
    if (!force || account.name !== 'refresh-broken') return;
    account.status = 'error';
    account.errorReason = 'refresh-failed';
    account._errorFromRefresh = true;
  };
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 401);
    assert.equal(am.accounts[0].status, 'error', 'the refresh-broken account stays parked on its own evidence');
    assert.equal(am.accounts[1].status, 'error',
      'a single unexplained 401 must still park its account even when a degraded account was visited first');
    assert.equal(am.accounts[1].errorReason, 'auth-rejected');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// The literal incident shape: the forced refresh SUCCEEDS and the retried
// request is rejected again. That is the path the 2026-09-05 outage took
// ("Token refreshed for account …" immediately followed by another 401).
test('a cascade of refresh-succeeded-then-401 accounts parks nobody', async () => {
  const hits = new Map();
  const upstream = http.createServer((req, res) => {
    const auth = req.headers['authorization'] || '';
    hits.set(auth, (hits.get(auth) || 0) + 1);
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'c', type: 'oauth', accessToken: 'tok-c', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  let refreshes = 0;
  am.ensureTokenFresh = async (_account, force) => { if (force) refreshes++; }; // refresh succeeds, status untouched
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 401);
    assert.ok(refreshes >= 2, `each rejected account must get its one forced refresh, got ${refreshes}`);
    assert.deepEqual(
      am.accounts.filter(a => a.status === 'error').map(a => a.name),
      [],
      'a successful refresh followed by another 401 across accounts is request-scoped — park nobody',
    );
    for (const [auth, count] of hits) {
      assert.equal(count, 2, `${auth} got ${count} hits — expected the original plus one post-refresh retry`);
    }
  } finally {
    proxy.close();
    upstream.close();
  }
});

// Codex review 2026-09-05: the background `refreshLapsedTokens` sweep bumps
// `_credentialGeneration` but deliberately does NOT heal an 'auth-rejected'
// park (it only heals `_errorFromRefresh` accounts). If the rollback were
// gated on the credential generation, a sweep landing between the park and the
// cascade would strand a freshly-refreshed, perfectly valid account in the
// parked state — the very outage this guard exists to prevent.
test('a background token refresh between the park and the cascade does not block the rollback', async () => {
  let sweptDuringRequest = false;
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const upstream = http.createServer((req, res) => {
    // While serving the SECOND account, simulate exactly what the sweep does to
    // the already-parked first account: new credentials, generation bumped,
    // park left in place because `_errorFromRefresh` is false.
    if ((req.headers['authorization'] || '').includes('tok-b') && !sweptDuringRequest) {
      const parkedAccount = am.accounts[0];
      parkedAccount._credentialGeneration = (parkedAccount._credentialGeneration || 0) + 1;
      parkedAccount.expiresAt = Date.now() + 7200_000;
      sweptDuringRequest = true;
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
  });
  const upstreamPort = await listen(upstream);
  am.ensureTokenFresh = async () => {}; // forced refresh succeeds, status untouched
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 401);
    assert.ok(sweptDuringRequest, 'the simulated sweep must actually have run mid-request');
    assert.equal(am.accounts[0].status, 'active',
      'a credential refresh must not strand the parked account — the rollback owns that park');
    assert.equal(am.accounts[0].errorReason ?? null, null);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('revocation observed during token refresh never dispatches upstream', async () => {
  let hits = 0;
  const upstream = http.createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{
    name: 'revoked',
    type: 'oauth',
    provider: 'anthropic',
    accessToken: 'tok-revoked',
    refreshToken: 'refresh',
    expiresAt: Date.now() + 3600_000,
  }], 0.98);
  const originalEnsure = am.ensureTokenFresh.bind(am);
  am.ensureTokenFresh = async account => {
    am.setAuthRevoked(account, true, false);
    return originalEnsure(account);
  };
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 401);
    assert.equal(hits, 0);
  } finally {
    proxy.close();
    upstream.close();
  }
});
