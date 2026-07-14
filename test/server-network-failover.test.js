import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// Pre-stream transient network errors (fetch failed / ECONNRESET) used to
// destroy the client connection outright — surfacing as "Response stalled
// mid-stream" in Claude Code — even though the request body is still buffered
// and another account's connection path may be perfectly healthy (2026-07-14).
// They must fail over across accounts like a 5xx instead.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function makeAccounts(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `acct-${i}`,
    type: 'oauth',
    accessToken: `tok-${i}`,
    refreshToken: `r-${i}`,
    expiresAt: Date.now() + 3600_000,
  }));
}

function startProxy(am, upstreamPort, overrides = {}) {
  return createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    ...overrides,
  });
}

function post(port, model = 'claude-fable-5') {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  });
}

test('pre-stream network error fails over to another account and succeeds', async () => {
  const authsSeen = [];
  const upstream = http.createServer((req, res) => {
    const auth = req.headers['authorization'] || '';
    authsSeen.push(auth);
    if (auth.includes('tok-0')) {
      req.socket.destroy(); // RST before any response bytes — "fetch failed"/ECONNRESET
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(2), 0.98);
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy);

  try {
    const res = await post(proxyPort);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.ok(authsSeen.length >= 2, `expected failover dispatch, saw ${authsSeen.length}`);
    // A network blip must not poison the account (per-request exclusion only).
    assert.ok(am.accounts.every(a => a.status === 'active'));
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('network error on every account → connection closes (bounded, no account poisoned)', async () => {
  let hits = 0;
  const upstream = http.createServer((req) => {
    hits++;
    req.socket.destroy();
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(makeAccounts(2), 0.98);
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy);

  try {
    await assert.rejects(() => post(proxyPort)); // client socket destroyed → fetch rejects
    assert.ok(hits <= 3, `expected bounded dispatches, got ${hits}`);
    assert.ok(am.accounts.every(a => a.status === 'active'));
  } finally {
    proxy.close();
    upstream.close();
  }
});
