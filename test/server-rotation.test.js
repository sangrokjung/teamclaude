import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { buildClaudeRecoveryEnv } from '../src/claude-auth.js';
import { createProxyServer } from '../src/server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

function makeManager(count) {
  return new AccountManager(Array.from({ length: count }, (_, index) => ({
    name: `account-${index}`,
    accountUuid: `uuid-${index}`,
    type: 'oauth',
    accessToken: `fixture-${index}`,
    expiresAt: Date.now() + 60_000,
  })), 0.98, 0);
}

test('loopback rotate endpoint switches active account without persisting config', async t => {
  const accountInputs = [
    {
      name: 'account-a',
      accountUuid: 'uuid-a',
      type: 'oauth',
      accessToken: 'fixture-a',
      expiresAt: Date.now() + 60_000,
      enabled: true,
      priority: 7,
    },
    {
      name: 'account-b',
      accountUuid: 'uuid-b',
      type: 'oauth',
      accessToken: 'fixture-b',
      expiresAt: Date.now() + 60_000,
      enabled: true,
      priority: 9,
    },
  ];
  const beforeConfig = structuredClone(accountInputs);
  const manager = new AccountManager(accountInputs, 0.98, 0);
  manager.currentIndex = 0;
  const server = createProxyServer(manager, {
    proxy: { apiKey: 'fixture-proxy-key' },
    activeWarmup: false,
  });
  t.after(() => close(server));
  const port = await listen(server);

  const before = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
  const beforeStatus = await before.json();
  const response = await fetch(`http://127.0.0.1:${port}/teamclaude/rotate`, {
    method: 'POST',
    headers: { 'x-api-key': 'fixture-proxy-key' },
  });
  const body = await response.json();
  const after = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
  const afterStatus = await after.json();

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), [
    'currentAccount',
    'currentAccountUuid',
    'previousAccount',
    'rotated',
  ]);
  assert.deepEqual(body, {
    rotated: true,
    previousAccount: 'account-a',
    currentAccount: 'account-b',
    currentAccountUuid: 'uuid-b',
  });
  assert.equal(beforeStatus.currentAccount, 'account-a');
  assert.equal(afterStatus.currentAccount, 'account-b');
  assert.deepEqual(accountInputs, beforeConfig);
});

test('rotate endpoint rejects unsafe requests and unavailable fleets', async t => {
  const manager = makeManager(1);
  const server = createProxyServer(manager, {
    proxy: { apiKey: 'fixture-proxy-key' },
    activeWarmup: false,
  });
  t.after(() => close(server));
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}/teamclaude/rotate`;

  const missingKey = await fetch(url, { method: 'POST' });
  assert.equal(missingKey.status, 401);
  assert.equal(manager.currentIndex, 0);

  const headers = { 'x-api-key': 'fixture-proxy-key' };
  const wrongMethod = await fetch(url, { headers });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');

  const withBody = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(withBody.status, 400);

  const noAlternative = await fetch(url, { method: 'POST', headers });
  const body = await noAlternative.json();
  assert.equal(noAlternative.status, 409);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'type']);
  assert.deepEqual(Object.keys(body.error).sort(), ['message', 'type']);
  assert.equal(body.error.type, 'no_alternative_account');
  assert.equal(manager.currentIndex, 0);
});

test('recovery auth pins each session to its rotated account across concurrent rotations', async t => {
  let selectedSecondAccount = false;
  const upstream = http.createServer((req, res) => {
    selectedSecondAccount = req.headers.authorization === 'Bearer fixture-b';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  t.after(() => close(upstream));
  const upstreamPort = await listen(upstream);

  const manager = new AccountManager([
    {
      name: 'account-a',
      accountUuid: 'uuid-a',
      type: 'oauth',
      accessToken: 'fixture-a',
      expiresAt: Date.now() + 60_000,
    },
    {
      name: 'account-b',
      accountUuid: 'uuid-b',
      type: 'oauth',
      accessToken: 'fixture-b',
      expiresAt: Date.now() + 60_000,
    },
  ], 0.98, 0);
  manager.currentIndex = 0;
  const server = createProxyServer(manager, {
    proxy: { apiKey: 'fixture-proxy-key' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  t.after(() => close(server));
  const port = await listen(server);
  const controlHeaders = { 'x-api-key': 'fixture-proxy-key' };

  const firstRotate = await fetch(`http://127.0.0.1:${port}/teamclaude/rotate`, {
    method: 'POST',
    headers: controlHeaders,
  });
  const firstResult = await firstRotate.json();
  const recoveryEnv = buildClaudeRecoveryEnv({
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  }, firstResult.currentAccountUuid);

  const secondRotate = await fetch(`http://127.0.0.1:${port}/teamclaude/rotate`, {
    method: 'POST',
    headers: controlHeaders,
  });
  const secondResult = await secondRotate.json();
  assert.equal(firstResult.currentAccount, 'account-b');
  assert.equal(secondResult.currentAccount, 'account-a');
  assert.equal(manager.currentIndex, 0);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${recoveryEnv.CLAUDE_CODE_OAUTH_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'test-model', messages: [] }),
  });
  await response.text();

  assert.equal(response.status, 200);
  assert.equal(selectedSecondAccount, true);
});

test('loopback malformed recovery marker is rejected before upstream dispatch', async t => {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  t.after(() => close(upstream));
  const upstreamPort = await listen(upstream);

  const manager = makeManager(1);
  const server = createProxyServer(manager, {
    proxy: { apiKey: 'fixture-proxy-key' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  t.after(() => close(server));
  const port = await listen(server);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer teamclaude-local-recovery:***',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'test-model', messages: [] }),
  });

  assert.equal(response.status, 403);
  assert.equal(upstreamHits, 0);
});

test('recovery UUID fails closed if selected account is removed during token refresh', async t => {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  t.after(() => close(upstream));
  const upstreamPort = await listen(upstream);

  const manager = makeManager(2);
  let markRefreshStarted;
  const refreshStarted = new Promise(resolve => {
    markRefreshStarted = resolve;
  });
  let allowRefreshToFinish;
  const refreshMayFinish = new Promise(resolve => {
    allowRefreshToFinish = resolve;
  });
  const ensureTokenFresh = manager.ensureTokenFresh.bind(manager);
  manager.ensureTokenFresh = async account => {
    if (account.accountUuid === 'uuid-1') {
      markRefreshStarted();
      await refreshMayFinish;
    }
    return ensureTokenFresh(account);
  };

  const server = createProxyServer(manager, {
    proxy: { apiKey: 'fixture-proxy-key' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    continuityMode: false,
  });
  t.after(() => close(server));
  const port = await listen(server);
  const recoveryEnv = buildClaudeRecoveryEnv({
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  }, 'uuid-1');

  const responsePromise = fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${recoveryEnv.CLAUDE_CODE_OAUTH_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'test-model', messages: [] }),
  });
  await refreshStarted;
  const selected = manager.accounts.find(account => account.accountUuid === 'uuid-1');
  manager.removeAccount(selected.index);
  allowRefreshToFinish();
  const response = await responsePromise;

  assert.equal(response.status, 409);
  assert.equal(upstreamHits, 0);
});
