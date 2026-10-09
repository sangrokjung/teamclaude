import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// Integration coverage for the clearSendFailure() call site in server.js
// (adversarial review round 4, 2026-10-09): an account cannot be dispatched
// to in the first place while status='error' (every selection path gates on
// _isAvailable), so the only way a real in-flight request's OWN response
// arrives while its account carries a stale send-failed park is the
// concurrent-request race the fix defends against — a second, concurrent
// request on the SAME account (maxConcurrentPerAccount > 1) parks it while
// the first request is still waiting on its own upstream response. These
// tests reproduce that ordering directly: start a request, park the account
// out from under it while the response is held open, then let the response
// land and assert the account ends up in the state the response's own
// evidence supports — not whatever clearSendFailure would naively do from
// the stale tag alone.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function makeAccount(name) {
  return {
    name,
    type: 'oauth',
    accessToken: `tok-${name}`,
    refreshToken: `r-${name}`,
    expiresAt: Date.now() + 3600_000,
  };
}

// Holds the upstream response open until `release()` is called, so the test
// can mutate account state while the proxy's own outbound fetch is still in
// flight. `received` resolves once the proxy's request has actually reached
// this handler (not merely once the client-side fetch() was issued — there
// are several async hops between the two: client fetch -> proxy receives +
// buffers the body -> proxy acquires an account -> proxy's own outbound
// fetch connects here). Synchronizing on THIS, not a fixed number of
// microtask ticks, is what makes the race deterministic.
function heldUpstream(respond) {
  let release;
  let markReceived;
  const released = new Promise(resolve => { release = resolve; });
  const received = new Promise(resolve => { markReceived = resolve; });
  const server = http.createServer(async (req, res) => {
    markReceived();
    await released;
    respond(req, res);
  });
  return { server, release, received };
}

test('a 2xx response heals a concurrently-parked send-failed account', async () => {
  const { server: upstream, release, received } = heldUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([makeAccount('a')], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const reqPromise = fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });

    // Wait for the proxy's own outbound request to actually reach the
    // upstream handler (confirms the account was genuinely dispatched-to
    // while still 'active') before mutating account state out from under it.
    await received;

    // Simulate a concurrent request/poll parking this account for a real
    // transport failure moments before THIS request's own response arrives.
    am.accounts[0].status = 'error';
    am.accounts[0].errorReason = 'send-failed';
    am.accounts[0]._errorFromRefresh = false;
    am.accounts[0]._errorFromSendFailure = true;

    release();
    const res = await reqPromise;
    await res.text();

    assert.equal(res.status, 200);
    assert.equal(am.accounts[0].status, 'active', '2xx evidence must heal the stale send-failed park');
    assert.equal(am.accounts[0].errorReason, undefined);
    assert.equal(am.accounts[0]._errorFromSendFailure, undefined);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('a 401 on the same response does NOT get healed by the stale send-failed tag first', async () => {
  const { server: upstream, release, received } = heldUpstream((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
  });
  const upstreamPort = await listen(upstream);

  // No refreshToken → the proxy can't retry-refresh; a single 401 parks it
  // immediately as auth-revoked, making the final state unambiguous.
  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 'tok-a', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const reqPromise = fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await received;

    am.accounts[0].status = 'error';
    am.accounts[0].errorReason = 'send-failed';
    am.accounts[0]._errorFromRefresh = false;
    am.accounts[0]._errorFromSendFailure = true;

    release();
    const res = await reqPromise;
    await res.text();

    assert.equal(res.status, 401);
    // The 401 handler must win: the account must end up parked for the
    // REAL reason this response proves, not silently healed back to active
    // by the pre-existing send-failed tag's evidence (which predates and
    // says nothing about this response).
    assert.equal(am.accounts[0].status, 'error');
    assert.equal(am.accounts[0].errorReason, 'auth-revoked');
    assert.equal(am.accounts[0]._errorFromSendFailure, undefined);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('an anthropic 403 subscription-disabled on the same response is not pre-empted by the stale tag', async () => {
  const SUBSCRIPTION_DISABLED_ERROR = {
    type: 'permission_error',
    message: 'OAuth authentication is currently not allowed for this organization.',
    details: { error_code: 'oauth_not_allowed_for_organization' },
  };
  const { server: upstream, release, received } = heldUpstream((req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: SUBSCRIPTION_DISABLED_ERROR }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([makeAccount('a')], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const reqPromise = fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await received;

    am.accounts[0].status = 'error';
    am.accounts[0].errorReason = 'send-failed';
    am.accounts[0]._errorFromRefresh = false;
    am.accounts[0]._errorFromSendFailure = true;

    release();
    const res = await reqPromise;
    await res.text();

    assert.equal(res.status, 403);
    assert.equal(am.accounts[0].status, 'error');
    assert.equal(am.accounts[0].errorReason, 'subscription-disabled');
    assert.equal(am.accounts[0]._errorFromSendFailure, undefined);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('a response to a request dispatched BEFORE a newer send-failed park does not clear it', async () => {
  const { server: upstream, release, received } = heldUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([makeAccount('a')], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);
  try {
    const reqPromise = fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await received;
    // Request B fails on the same account AFTER A was dispatched.
    am.markSendFailure(am.accounts[0], Date.now() + 1);
    release();
    const res = await reqPromise;
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(am.accounts[0].errorReason, 'send-failed', 'stale evidence from A must not clear B\'s park');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('a 401 on an API-key account parked send-failed ends as a real auth park, not a cooldown', async () => {
  const { server: upstream, release, received } = heldUpstream((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'k', type: 'apikey', apiKey: 'test-key-a' }], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);
  try {
    const reqPromise = fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await received;
    am.markSendFailure(am.accounts[0], Date.now() - 10);
    release();
    const res = await reqPromise;
    const body = await res.text();
    assert.equal(res.status, 401, body);
    assert.equal(am.accounts[0].status, 'error');
    assert.notEqual(am.accounts[0].errorReason, 'send-failed', 'a 401 must not stay a self-healing cooldown');
    assert.equal(am.accounts[0]._errorFromSendFailure, undefined);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('a malformed 2xx from the codex usage endpoint still lifts a send-failed park', async () => {
  let hits = 0;
  const upstream = http.createServer((req, res) => {
    if (req.url !== '/backend-api/wham/usage') {
      res.writeHead(404).end();
      return;
    }
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('<html>not json');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{
    name: 'c', provider: 'codex', type: 'oauth', accessToken: 'access-c',
  }], 0.98);
  am.markSendFailure(am.accounts[0], Date.now() - 10);
  const proxy = createProxyServer(am, {
    provider: 'codex',
    upstream: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
    activeWarmup: false,
    warmupIntervalMs: 0,
  });
  await listen(proxy);
  try {
    await proxy.refreshQuotaAll();
    assert.ok(hits >= 1);
    assert.equal(am.accounts[0].status, 'active');
    assert.equal(am.accounts[0].errorReason, undefined);
  } finally {
    proxy.close();
    upstream.close();
  }
});
