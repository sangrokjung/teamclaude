import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const SUBSCRIPTION_DISABLED_ERROR = {
  type: 'permission_error',
  message: 'OAuth authentication is currently not allowed for this organization.',
  details: { error_code: 'oauth_not_allowed_for_organization' },
};

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function accounts() {
  return new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
}

async function postMessage(proxyPort) {
  return fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [] }),
  });
}

test('a subscription-disabled 403 quarantines the OAuth account and switches', async () => {
  const hits = { a: 0, b: 0 };
  const upstream = http.createServer((req, res) => {
    const account = (req.headers.authorization || '').includes('tok-a') ? 'a' : 'b';
    hits[account]++;
    res.writeHead(account === 'a' ? 403 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(account === 'a'
      ? { type: 'error', error: SUBSCRIPTION_DISABLED_ERROR }
      : { ok: true, account }));
  });
  const upstreamPort = await listen(upstream);
  const am = accounts();
  const flagEvents = [];
  am.onAccountFlag((account, disabled) => flagEvents.push([account.name, disabled]));
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await postMessage(proxyPort);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, account: 'b' });
    assert.deepEqual(hits, { a: 1, b: 1 });
    assert.equal(am.accounts[0].status, 'error');
    assert.equal(am.accounts[0]._errorFromRefresh, false);
    assert.equal(am.accounts[0].subscriptionDisabled, true);
    assert.equal(am.accounts[0].errorReason, 'subscription-disabled');
    assert.deepEqual(flagEvents, [['a', true]]);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('subscription-disabled persistence completes before failover and graceful close', async () => {
  const hits = { a: 0, b: 0 };
  const upstream = http.createServer((req, res) => {
    const account = (req.headers.authorization || '').includes('tok-a') ? 'a' : 'b';
    hits[account]++;
    res.writeHead(account === 'a' ? 403 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(account === 'a'
      ? { type: 'error', error: SUBSCRIPTION_DISABLED_ERROR }
      : { ok: true, account }));
  });
  const upstreamPort = await listen(upstream);
  const am = accounts();
  let releasePersistence;
  let persistenceStartedResolve;
  const persistenceStarted = new Promise(resolve => { persistenceStartedResolve = resolve; });
  am.onAccountFlag(() => new Promise(resolve => {
    releasePersistence = resolve;
    persistenceStartedResolve();
  }));
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const response = postMessage(proxyPort);
    await persistenceStarted;
    const closing = close(proxy);
    assert.deepEqual(hits, { a: 1, b: 0 });
    releasePersistence();
    const res = await response;
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, account: 'b' });
    proxy.closeIdleConnections?.();
    await closing;
  } finally {
    if (proxy.listening) await close(proxy);
    await close(upstream);
  }
});

test('stable config reads repeat when a subscription flag changes during the read', async () => {
  const am = accounts();
  let diskDisabled = false;
  let reads = 0;
  am.onAccountFlag((_account, disabled) => new Promise(resolve => {
    setImmediate(() => {
      diskDisabled = disabled;
      resolve();
    });
  }));

  const snapshot = await am.readAfterAccountFlagWrites(async () => {
    reads++;
    const value = diskDisabled;
    if (reads === 1) am.setSubscriptionDisabled(am.accounts[0], true);
    return value;
  });

  assert.equal(snapshot, true);
  assert.equal(reads, 2);
});

test('a failed subscription flag write prevents a stale config reload', async () => {
  const am = accounts();
  am.onAccountFlag(() => Promise.reject(new Error('disk unavailable')));
  am.setSubscriptionDisabled(am.accounts[0], true);

  await assert.rejects(
    am.readAfterAccountFlagWrites(async () => ({ accounts: [] })),
    /disk unavailable/,
  );
  assert.equal(am.accounts[0].subscriptionDisabled, true);
  assert.equal(am.accounts[0].status, 'error');
});

test('stable config reads retain a pending flag write after account removal', async () => {
  const am = accounts();
  let releasePersistence;
  let persistenceStartedResolve;
  const persistenceStarted = new Promise(resolve => { persistenceStartedResolve = resolve; });
  am.onAccountFlag(() => new Promise(resolve => {
    releasePersistence = resolve;
    persistenceStartedResolve();
  }));
  const removed = am.accounts[0];
  am.setSubscriptionDisabled(removed, true);
  await persistenceStarted;
  am.removeAccount(removed.index);

  let readStarted = false;
  const snapshot = am.readAfterAccountFlagWrites(async () => {
    readStarted = true;
    return { accounts: [] };
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readStarted, false);
  releasePersistence();
  assert.deepEqual(await snapshot, { accounts: [] });
});

test('all subscription-disabled accounts return the final original 403', async () => {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    const account = (req.headers.authorization || '').includes('tok-a') ? 'a' : 'b';
    hits.push(account);
    res.writeHead(403, {
      'content-type': 'application/json',
      'x-denied-account': account,
    });
    res.end(JSON.stringify({
      type: 'error',
      error: SUBSCRIPTION_DISABLED_ERROR,
      deniedAccount: account,
    }));
  });
  const upstreamPort = await listen(upstream);
  const am = accounts();
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await postMessage(proxyPort);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('x-denied-account'), 'b');
    assert.equal((await res.json()).deniedAccount, 'b');
    assert.deepEqual(hits, ['a', 'b']);
    assert.ok(am.accounts.every(account => account.status === 'error'));
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('a 403 without the structured error code passes through without poisoning the pool', async () => {
  const hits = { a: 0, b: 0 };
  const original = {
    type: 'error',
    error: {
      type: 'permission_error',
      message: 'Your organization has disabled Claude subscription access for Claude Code.',
    },
  };
  const upstream = http.createServer((req, res) => {
    const account = (req.headers.authorization || '').includes('tok-a') ? 'a' : 'b';
    hits[account]++;
    res.writeHead(account === 'a' ? 403 : 200, {
      'content-type': 'application/json',
      'x-original-response': 'yes',
    });
    res.end(JSON.stringify(account === 'a' ? original : { ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = accounts();
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await postMessage(proxyPort);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('x-original-response'), 'yes');
    assert.deepEqual(await res.json(), original);
    assert.deepEqual(hits, { a: 1, b: 0 });
    assert.ok(am.accounts.every(account => account.status === 'active'));
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
