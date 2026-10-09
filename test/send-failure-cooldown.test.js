import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager, SEND_FAILED_COOLDOWN_MS } from '../src/account-manager.js';
import { createProxyServer, isTransientNetworkError } from '../src/server.js';

function makeAccounts(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `acct-${i}`,
    type: 'oauth',
    accessToken: `tok-${i}`,
    refreshToken: `r-${i}`,
    expiresAt: Date.now() + 3600_000,
  }));
}

function aggregate(codes) {
  const err = new AggregateError(codes.map(code => Object.assign(new Error(code), { code })), '');
  return err;
}

test('the 2026-10-08 outage shape (empty-message AggregateError) is classified transient', () => {
  assert.equal(isTransientNetworkError(aggregate(['ENETUNREACH', 'EHOSTUNREACH'])), true);
  assert.equal(isTransientNetworkError(aggregate(['ENETDOWN'])), true);
});

test('real Node AggregateError from a refused connection is classified transient', async () => {
  const err = await new Promise(resolve => {
    const req = http.request('http://localhost:1/', () => {});
    req.on('error', resolve);
    req.end();
  });
  assert.equal(isTransientNetworkError(err), true);
});

test('other socket-level failures seen in the outage log are transient', () => {
  assert.equal(isTransientNetworkError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })), true);
  assert.equal(isTransientNetworkError(new Error('socket hang up')), true);
  assert.equal(
    isTransientNetworkError(new Error('Client network socket disconnected before secure TLS connection was established')),
    true,
  );
  assert.equal(isTransientNetworkError(Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' })), true);
});

test('unrelated errors stay non-transient', () => {
  assert.equal(isTransientNetworkError(new Error('boom')), false);
  assert.equal(isTransientNetworkError(aggregate(['ENETUNREACH', 'EWEIRD'])), false);
  assert.equal(isTransientNetworkError(new AggregateError([], '')), false);
  assert.equal(isTransientNetworkError('ECONNRESET'), false);
});

test('a send-failed park is a cooldown: unavailable inside it, healed after it', () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  const acct = am.accounts[0];

  am.markSendFailure(acct);
  assert.equal(acct.errorReason, 'send-failed');
  assert.equal(am._isAvailable(acct), false);

  acct._sendFailedUntil = Date.now() - 1;
  assert.equal(am._isAvailable(acct), true);
  assert.equal(acct.status, 'active');
  assert.equal(acct.errorReason, undefined);
  assert.equal(acct._sendFailedUntil, undefined);
});

test('markSendFailure sets the documented cooldown length', () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  const now = 1_000_000;
  am.markSendFailure(am.accounts[0], now);
  assert.equal(am.accounts[0]._sendFailedUntil, now + SEND_FAILED_COOLDOWN_MS);
});

test('markSendFailure never overwrites a stricter park, and the cooldown never revives one', () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  const acct = am.accounts[0];
  am.markAuthenticationError(acct, 'auth-revoked');

  am.markSendFailure(acct);
  assert.equal(acct.errorReason, 'auth-revoked');
  assert.equal(acct._errorFromSendFailure, undefined);
  assert.equal(am._isAvailable(acct), false);
  assert.equal(acct.status, 'error');
});

test('a fleet parked only by send failures does not answer "Re-login required"', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamPort = await new Promise(r => upstream.listen(0, '127.0.0.1', () => r(upstream.address().port)));
  const am = new AccountManager(makeAccounts(2), 0.98);
  for (const acct of am.accounts) am.markSendFailure(acct);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    continuity: { enabled: false },
  });
  const proxyPort = await new Promise(r => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    const text = await res.text();
    assert.notEqual(res.status, 401, text);
    assert.doesNotMatch(text, /Re-login required/);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('markSendFailure leaves a throttled or exhausted account untouched', () => {
  for (const status of ['throttled', 'exhausted']) {
    const am = new AccountManager(makeAccounts(1), 0.98);
    const acct = am.accounts[0];
    acct.status = status;
    acct.rateLimitedUntil = Date.now() + 60_000;
    am.markSendFailure(acct);
    assert.equal(acct.status, status);
    assert.equal(acct.errorReason, undefined);
    assert.equal(acct._errorFromSendFailure, undefined);
  }
});

test('evidence older than the park cannot clear it (generation check)', () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  const acct = am.accounts[0];
  am.markSendFailure(acct, 2_000);

  am.clearSendFailure(acct, { evidenceSince: 1_000 });
  assert.equal(acct.errorReason, 'send-failed', 'a response to a request sent before the park is stale evidence');

  am.clearSendFailure(acct, { evidenceSince: 3_000 });
  assert.equal(acct.status, 'active');
});

test('markAccountSuccess no longer drops the send-failed tag (cooldown must still be able to heal)', () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  const acct = am.accounts[0];
  am.markSendFailure(acct);
  am.markAccountSuccess(acct);
  assert.equal(acct._errorFromSendFailure, true);
  acct._sendFailedUntil = Date.now() - 1;
  assert.equal(am._isAvailable(acct), true);
});
