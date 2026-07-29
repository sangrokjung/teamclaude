import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function observeCodexPath(upstreamPath) {
  const paths = [];
  const upstream = http.createServer((req, res) => {
    paths.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'response-id' }));
  });
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    const manager = new AccountManager([{
      name: 'codex-pro',
      provider: 'codex',
      type: 'oauth',
      accessToken: 'pooled-access-token',
      accountId: 'workspace-123',
      expiresAt: Date.now() + 3_600_000,
    }]);
    proxy = createProxyServer(manager, {
      provider: 'codex',
      upstream: `http://127.0.0.1:${upstreamPort}${upstreamPath}`,
      activeWarmup: false,
    });
    const proxyPort = await listen(proxy);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses?trace=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', input: [] }),
    });
    await response.text();

    return { status: response.status, paths };
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
}

test('Codex proxy with custom-root upstream replaces auth, injects account id, and tracks quota headers', async () => {
  // Given
  let upstreamRequest;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequest = {
      path: req.url,
      authorization: req.headers.authorization,
      accountId: req.headers['chatgpt-account-id'],
      body: JSON.parse(Buffer.concat(chunks).toString()),
    };
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-codex-primary-used-percent': '40',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '1900000100',
      'x-codex-secondary-used-percent': '60',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-at': '1900600000',
    });
    res.end(JSON.stringify({
      id: 'response-id',
      usage: { input_tokens: 12, output_tokens: 5 },
    }));
  });
  const upstreamPort = await listen(upstream);
  const manager = new AccountManager([{
    name: 'codex-pro',
    provider: 'codex',
    type: 'oauth',
    accessToken: 'pooled-access-token',
    refreshToken: 'refresh-token',
    accountId: 'workspace-123',
    accountUuid: 'workspace-123',
    expiresAt: Date.now() + 3_600_000,
  }]);
  const proxy = createProxyServer(manager, {
    provider: 'codex',
    proxy: { apiKey: 'local-proxy-key' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    // When
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-proxy-key',
        'chatgpt-account-id': 'must-not-reach-upstream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-5.6', input: [] }),
    });
    await response.text();

    // Then
    assert.equal(response.status, 200);
    assert.deepEqual(upstreamRequest, {
      path: '/codex/responses',
      authorization: 'Bearer pooled-access-token',
      accountId: 'workspace-123',
      body: { model: 'gpt-5.6', input: [] },
    });
    assert.equal(manager.accounts[0].quota.unified5h, 0.4);
    assert.equal(manager.accounts[0].quota.unified7d, 0.6);
    assert.equal(manager.accounts[0].quota.unified5hReset, 1_900_000_100_000);
    assert.equal(manager.accounts[0].quota.unified7dReset, 1_900_600_000_000);
    assert.equal(manager.accounts[0].usage.totalInputTokens, 12);
    assert.equal(manager.accounts[0].usage.totalOutputTokens, 5);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('Codex proxy avoids duplicating an exact /backend-api/codex upstream segment', async () => {
  const result = await observeCodexPath('/backend-api/codex');

  assert.equal(result.status, 200);
  assert.deepEqual(result.paths, ['/backend-api/codex/responses?trace=1']);
});

test('Codex proxy preserves the public prefix for a similar mycodex upstream segment', async () => {
  const result = await observeCodexPath('/backend-api/mycodex');

  assert.equal(result.status, 200);
  assert.deepEqual(result.paths, ['/backend-api/mycodex/codex/responses?trace=1']);
});

test('Codex proxy avoids a double slash for an exact trailing slash upstream segment', async () => {
  const result = await observeCodexPath('/backend-api/codex/');

  assert.equal(result.status, 200);
  assert.deepEqual(result.paths, ['/backend-api/codex/responses?trace=1']);
});

test('Codex proxy fails an exhausted account over to the next subscription', async () => {
  // Given
  const routed = [];
  const upstream = http.createServer((_req, res) => {
    const token = _req.headers.authorization;
    routed.push({
      token,
      accountId: _req.headers['chatgpt-account-id'],
    });
    if (token === 'Bearer access-a') {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '60',
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 3600),
        'x-codex-rate-limit-reached-type': 'rate_limit_reached',
      });
      res.end(JSON.stringify({ error: { message: 'usage limit reached' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'response-b', usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const upstreamPort = await listen(upstream);
  const manager = new AccountManager([
    {
      name: 'codex-a',
      provider: 'codex',
      type: 'oauth',
      accessToken: 'access-a',
      accountId: 'workspace-a',
      expiresAt: Date.now() + 3_600_000,
    },
    {
      name: 'codex-b',
      provider: 'codex',
      type: 'oauth',
      accessToken: 'access-b',
      accountId: 'workspace-b',
      expiresAt: Date.now() + 3_600_000,
    },
  ]);
  const proxy = createProxyServer(manager, {
    provider: 'codex',
    proxy: { apiKey: 'local-proxy-key' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    // When
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', input: [] }),
    });
    const body = await response.json();

    // Then
    assert.equal(response.status, 200);
    assert.equal(body.id, 'response-b');
    assert.deepEqual(routed, [
      { token: 'Bearer access-a', accountId: 'workspace-a' },
      { token: 'Bearer access-b', accountId: 'workspace-b' },
    ]);
    assert.equal(manager.accounts[0].quota.unified5h, 1);
    assert.equal(manager.accounts[0].status, 'throttled');
  } finally {
    proxy.close();
    upstream.close();
  }
});
