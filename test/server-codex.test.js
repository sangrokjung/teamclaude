import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
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

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met before timeout');
}

async function drainRequest(request) {
  for await (const chunk of request) {
    if (chunk.length === 0) continue;
  }
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
      codexUsageRefresh: false,
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

test('Codex continuity never replays a complete upstream 503 POST', async () => {
  let upstreamHits = 0;
  const upstreamHitAt = [];
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    upstreamHits++;
    upstreamHitAt.push(Date.now());
    if (upstreamHits === 1) {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'temporary overload' },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'response-after-recovery' }));
  });
  const upstreamPort = await listen(upstream);
  const manager = new AccountManager([{
    name: 'codex-a',
    provider: 'codex',
    type: 'oauth',
    accessToken: 'pooled-access-token-a',
    accountId: 'workspace-a',
    expiresAt: Date.now() + 3_600_000,
  }, {
    name: 'codex-b',
    provider: 'codex',
    type: 'oauth',
    accessToken: 'pooled-access-token-b',
    accountId: 'workspace-b',
    expiresAt: Date.now() + 3_600_000,
  }]);
  const proxy = createProxyServer(manager, {
    provider: 'codex',
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    codexUsageRefresh: false,
    continuityMode: true,
    continuityMaxSleepMs: 50,
    continuityJitterMs: 0,
  });
  const proxyPort = await listen(proxy);

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', input: [] }),
    });

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5',
      'an ambiguous unsafe overload must tell the client not to retry immediately');
    assert.match((await response.json()).error.message, /Request was not replayed/);
    assert.equal(upstreamHits, 1);
    assert.equal(upstreamHitAt.length, 1);
    assert.ok(manager.accounts[0].dispatchFailureCooldownUntil > Date.now(),
      'the failed account must be skipped by an immediate independent retry');
    assert.ok(manager.accounts.every(account => account.inflight === 0));
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('Codex continuity does not replay a truncated upstream 503 body', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    upstreamHits++;
    if (upstreamHits === 1) {
      res.writeHead(503, {
        'content-type': 'application/json',
        'content-length': '256',
      });
      res.flushHeaders();
      res.write('{"type":"error","error":{"type":"overloaded_error"');
      setImmediate(() => res.destroy());
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'must-not-be-reached' }));
  });
  const upstreamPort = await listen(upstream);
  const manager = new AccountManager([{
    name: 'codex-pro', provider: 'codex', type: 'oauth',
    accessToken: 'pooled-access-token', accountId: 'workspace-123',
    expiresAt: Date.now() + 3_600_000,
  }]);
  const proxy = createProxyServer(manager, {
    provider: 'codex', upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false, codexUsageRefresh: false, continuityMode: true,
    continuityMaxSleepMs: 10, continuityJitterMs: 0,
  });
  const proxyPort = await listen(proxy);

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', input: [] }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error.message, /Request was not replayed/);
    assert.equal(upstreamHits, 1);
    assert.equal(manager.accounts[0].inflight, 0);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('Codex continuity does not replay an unsafe POST after a complete upstream 502', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    upstreamHits++;
    if (upstreamHits === 1) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: 'ambiguous gateway failure' },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'must-not-be-reached' }));
  });
  const upstreamPort = await listen(upstream);
  const manager = new AccountManager([{
    name: 'codex-pro',
    provider: 'codex',
    type: 'oauth',
    accessToken: 'pooled-access-token',
    accountId: 'workspace-123',
    expiresAt: Date.now() + 3_600_000,
  }]);
  const proxy = createProxyServer(manager, {
    provider: 'codex',
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    codexUsageRefresh: false,
    continuityMode: true,
    continuityMaxSleepMs: 10,
    continuityJitterMs: 0,
  });
  const proxyPort = await listen(proxy);

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', input: [] }),
    });

    assert.equal(response.status, 502);
    assert.match((await response.json()).error.message, /Request was not replayed/);
    assert.equal(upstreamHits, 1);
    assert.equal(manager.accounts[0].inflight, 0);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('Codex continuity never replays a complete Cloudflare 507 POST', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    upstreamHits++;
    if (upstreamHits === 1) {
      res.writeHead(507, {
        'content-type': 'text/plain',
        'cf-ray': 'fixture-ray-ICN',
      });
      res.end('exceeded request buffer limit while retrying upstream');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'response-after-buffer-retry' }));
  });
  const upstreamPort = await listen(upstream);
  const manager = new AccountManager([{
    name: 'codex-pro',
    provider: 'codex',
    type: 'oauth',
    accessToken: 'pooled-access-token',
    accountId: 'workspace-123',
    expiresAt: Date.now() + 3_600_000,
  }]);
  const proxy = createProxyServer(manager, {
    provider: 'codex',
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    codexUsageRefresh: false,
    continuityMode: true,
    codexOverloadMaxWaitMs: 100,
    continuityMaxSleepMs: 10,
    continuityJitterMs: 0,
  });
  const proxyPort = await listen(proxy);

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', input: ['large-context-fixture'] }),
    });

    assert.equal(response.status, 507);
    assert.match((await response.json()).error.message, /Request was not replayed/);
    assert.equal(upstreamHits, 1);
    assert.equal(manager.accounts[0].inflight, 0);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('Codex continuity does not replay an unrelated complete 507', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    upstreamHits++;
    if (upstreamHits === 1) {
      res.writeHead(507, {
        'content-type': 'application/json',
        'cf-ray': 'fixture-ray-ICN',
      });
      res.end(JSON.stringify({ error: 'application storage exhausted after dispatch' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'must-not-be-reached' }));
  });
  const upstreamPort = await listen(upstream);
  const manager = new AccountManager([{
    name: 'codex-pro', provider: 'codex', type: 'oauth',
    accessToken: 'pooled-access-token', accountId: 'workspace-123',
    expiresAt: Date.now() + 3_600_000,
  }]);
  const proxy = createProxyServer(manager, {
    provider: 'codex', upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false, codexUsageRefresh: false, continuityMode: true,
    continuityMaxSleepMs: 10, continuityJitterMs: 0,
  });
  const proxyPort = await listen(proxy);

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', input: [] }),
    });
    assert.equal(response.status, 507);
    assert.match((await response.json()).error.message, /Request was not replayed/);
    assert.equal(upstreamHits, 1);
    assert.equal(manager.accounts[0].inflight, 0);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('Codex continuity requires a Cloudflare ray for 507 request-buffer replay', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    upstreamHits++;
    if (upstreamHits === 1) {
      res.writeHead(507, { 'content-type': 'text/plain' });
      res.end('exceeded request buffer limit while retrying upstream');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'must-not-be-reached' }));
  });
  const upstreamPort = await listen(upstream);
  const manager = new AccountManager([{
    name: 'codex-pro', provider: 'codex', type: 'oauth',
    accessToken: 'pooled-access-token', accountId: 'workspace-123',
    expiresAt: Date.now() + 3_600_000,
  }]);
  const proxy = createProxyServer(manager, {
    provider: 'codex', upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false, codexUsageRefresh: false, continuityMode: true,
    continuityMaxSleepMs: 10, continuityJitterMs: 0,
  });
  const proxyPort = await listen(proxy);

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', input: [] }),
    });
    assert.equal(response.status, 507);
    assert.match((await response.json()).error.message, /Request was not replayed/);
    assert.equal(upstreamHits, 1);
    assert.equal(manager.accounts[0].inflight, 0);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('Codex overload deadline cannot enable POST redispatch', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (req, res) => {
    await drainRequest(req);
    upstreamHits++;
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error', error: { type: 'overloaded_error', message: 'persistent overload' },
    }));
  });
  const upstreamPort = await listen(upstream);
  const manager = new AccountManager([{
    name: 'codex-pro', provider: 'codex', type: 'oauth',
    accessToken: 'pooled-access-token', accountId: 'workspace-123',
    expiresAt: Date.now() + 3_600_000,
  }]);
  const proxy = createProxyServer(manager, {
    provider: 'codex', upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false, codexUsageRefresh: false, continuityMode: true,
    codexOverloadMaxWaitMs: 35, continuityMaxSleepMs: 10, continuityJitterMs: 0,
  });
  const proxyPort = await listen(proxy);

  try {
    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', input: [] }),
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(response.status, 503);
    assert.match((await response.json()).error.message, /Request was not replayed/);
    assert.equal(upstreamHits, 1);
    assert.ok(elapsedMs < 500, `no-replay response took ${elapsedMs}ms`);
    assert.equal(manager.accounts[0].inflight, 0);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('Codex POST does not redispatch regardless of Retry-After', async t => {
  const cases = [
    ['delta-seconds', () => '1'],
    ['HTTP-date', () => new Date(Date.now() + 5_000).toUTCString()],
  ];
  for (const [label, retryAfter] of cases) {
    await t.test(label, async () => {
      let upstreamHits = 0;
      const upstream = http.createServer(async (req, res) => {
        await drainRequest(req);
        upstreamHits++;
        res.writeHead(503, {
          'content-type': 'application/json', 'retry-after': retryAfter(),
        });
        res.end(JSON.stringify({
          type: 'error', error: { type: 'overloaded_error', message: 'persistent overload' },
        }));
      });
      const upstreamPort = await listen(upstream);
      const manager = new AccountManager([{
        name: 'codex-pro', provider: 'codex', type: 'oauth',
        accessToken: 'pooled-access-token', accountId: 'workspace-123',
        expiresAt: Date.now() + 3_600_000,
      }]);
      const proxy = createProxyServer(manager, {
        provider: 'codex', upstream: `http://127.0.0.1:${upstreamPort}`,
        activeWarmup: false, codexUsageRefresh: false, continuityMode: true,
        codexOverloadMaxWaitMs: 35, continuityMaxSleepMs: 1_000,
        continuityJitterMs: 0,
      });
      const proxyPort = await listen(proxy);
      try {
        const startedAt = Date.now();
        const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.6', input: [] }),
        });
        const elapsedMs = Date.now() - startedAt;
        assert.equal(response.status, 503);
        assert.equal(upstreamHits, 1);
        assert.match((await response.json()).error.message, /Request was not replayed/);
        assert.ok(elapsedMs < 500, `${label} no-replay response took ${elapsedMs}ms`);
        assert.equal(manager.accounts[0].inflight, 0);
      } finally {
        await Promise.all([closeServer(proxy), closeServer(upstream)]);
      }
    });
  }
});

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
    codexUsageRefresh: false,
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

test('Codex proxy removes deprecated prompt_cache_retention before forwarding', async () => {
  let upstreamRequest;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    upstreamRequest = {
      contentLength: req.headers['content-length'],
      body: JSON.parse(body.toString()),
      bodyBytes: body.length,
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'response-id' }));
  });
  const upstreamPort = await listen(upstream);
  const manager = new AccountManager([{
    name: 'codex-pro',
    provider: 'codex',
    type: 'oauth',
    accessToken: 'pooled-access-token',
    accountId: 'workspace-123',
    expiresAt: Date.now() + 3_600_000,
  }]);
  const proxy = createProxyServer(manager, {
    provider: 'codex',
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    codexUsageRefresh: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-sol',
        input: [],
        prompt_cache_retention: '24h',
      }),
    });
    await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamRequest.body, {
      model: 'gpt-5.6-sol',
      input: [],
    });
    assert.equal(Number(upstreamRequest.contentLength), upstreamRequest.bodyBytes);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('Codex proxy strips a forged internal recovery header from upstream', async () => {
  const sessionId = '01900000-0000-7000-8000-000000000034';
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-teamcodex-recovery-session': sessionId,
    });
    res.end('{}');
  });
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    const manager = new AccountManager([{
      name: 'codex-pro',
      provider: 'codex',
      type: 'oauth',
      accessToken: 'pooled-access-token',
      expiresAt: Date.now() + 3_600_000,
    }]);
    proxy = createProxyServer(manager, {
      provider: 'codex',
      upstream: `http://127.0.0.1:${upstreamPort}`,
      activeWarmup: false,
      codexUsageRefresh: false,
    });
    const proxyPort = await listen(proxy);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', input: [], prompt_cache_key: sessionId }),
    });
    await response.arrayBuffer();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-teamcodex-recovery-session'), null);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('Codex proxy strips a forged internal recovery header from 403 and 429 responses', async () => {
  const forgedSessionId = '01900000-0000-7000-8000-000000000035';
  const upstream = http.createServer((req, res) => {
    const status = req.url.includes('status=429') ? 429 : 403;
    res.writeHead(status, {
      'content-type': 'application/json',
      'retry-after': '1',
      'x-teamcodex-recovery-session': forgedSessionId,
    });
    res.end(JSON.stringify({ error: { message: `fixture ${status}` } }));
  });
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    const manager = new AccountManager([{
      name: 'codex-pro',
      provider: 'codex',
      type: 'oauth',
      accessToken: 'pooled-access-token',
      expiresAt: Date.now() + 3_600_000,
    }]);
    proxy = createProxyServer(manager, {
      provider: 'codex',
      upstream: `http://127.0.0.1:${upstreamPort}`,
      activeWarmup: false,
      codexUsageRefresh: false,
      rateLimitFailovers: 0,
    });
    const proxyPort = await listen(proxy);

    for (const status of [403, 429]) {
      const response = await fetch(
        `http://127.0.0.1:${proxyPort}/codex/responses?status=${status}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.6', input: [] }),
        },
      );
      await response.arrayBuffer();
      assert.equal(response.status, status);
      assert.equal(
        response.headers.get('x-teamcodex-recovery-session'),
        null,
        `an upstream ${status} must not forge an internal recovery receipt`,
      );
    }
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('Codex quota headers classify a primary weekly window by its actual length', () => {
  const manager = new AccountManager([{
    name: 'codex-pro',
    provider: 'codex',
    type: 'oauth',
    accessToken: 'pooled-access-token',
  }]);

  manager.updateQuota(0, {
    'x-codex-primary-used-percent': '41',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-reset-at': '1900600000',
    'x-codex-secondary-used-percent': '17',
    'x-codex-secondary-window-minutes': '300',
    'x-codex-secondary-reset-at': '1900000100',
  });

  assert.equal(manager.accounts[0].quota.unified5h, 0.17);
  assert.equal(manager.accounts[0].quota.unified7d, 0.41);
  assert.equal(manager.accounts[0].quota.unified5hReset, 1_900_000_100_000);
  assert.equal(manager.accounts[0].quota.unified7dReset, 1_900_600_000_000);
});

test('Codex response headers cannot regress wham-measured usage within a live window', () => {
  const manager = new AccountManager([{
    name: 'codex-pro',
    provider: 'codex',
    type: 'oauth',
    accessToken: 'pooled-access-token',
  }]);
  const futureSec = Math.floor(Date.now() / 1000) + 6 * 24 * 3600;

  // Authoritative wham/usage refresh: the account's binding weekly meter is at 89%.
  manager.updateCodexUsage(0, {
    rate_limit: {
      primary_window: {
        used_percent: 89,
        limit_window_seconds: 604800,
        reset_at: futureSec,
      },
    },
  });
  assert.equal(manager.accounts[0].quota.unified7d, 0.89);
  assert.equal(manager.accounts[0].quota.unified7dReset, futureSec * 1000);

  // Live incident (2026-08-05): a forwarded response's x-codex headers report a
  // DIFFERENT meter (a promo/model-scoped limit at 0%) for the same still-live
  // window, and every request stamped the account back to 0 within seconds of
  // each wham refresh. A header write that would LOWER a live window is a
  // different meter talking — it must not clobber utilization OR reset.
  manager.updateQuota(0, {
    'x-codex-primary-used-percent': '0',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-reset-at': String(futureSec + 2),
  });
  assert.equal(manager.accounts[0].quota.unified7d, 0.89);
  assert.equal(manager.accounts[0].quota.unified7dReset, futureSec * 1000);

  // Genuine same-meter growth still applies live.
  manager.updateQuota(0, {
    'x-codex-primary-used-percent': '92',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-reset-at': String(futureSec),
  });
  assert.equal(manager.accounts[0].quota.unified7d, 0.92);

  // The authoritative wham path may lower a live window (early reset upstream).
  manager.updateCodexUsage(0, {
    rate_limit: {
      primary_window: {
        used_percent: 3,
        limit_window_seconds: 604800,
        reset_at: futureSec + 604800,
      },
    },
  });
  assert.equal(manager.accounts[0].quota.unified7d, 0.03);
  assert.equal(manager.accounts[0].quota.unified7dReset, (futureSec + 604800) * 1000);

  // Once the stored window has EXPIRED, a lower header value is a legitimate
  // rollover and applies again.
  manager.accounts[0].quota.unified7dReset = Date.now() - 1000;
  manager.updateQuota(0, {
    'x-codex-primary-used-percent': '1',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-reset-at': String(futureSec + 604800),
  });
  assert.equal(manager.accounts[0].quota.unified7d, 0.01);
  assert.equal(manager.accounts[0].quota.unified7dReset, (futureSec + 604800) * 1000);
});

test('Codex usage refresh tracks live account changes and coalesces concurrent fan-outs', async () => {
  const requests = [];
  let blockNextA = false;
  let releaseBlockedA;
  let blockedA = Promise.resolve();
  const upstream = http.createServer(async (req, res) => {
    if (req.url !== '/backend-api/wham/usage') {
      res.writeHead(404).end();
      return;
    }
    requests.push({
      authorization: req.headers.authorization,
      accountId: req.headers['chatgpt-account-id'],
    });
    const accountA = req.headers.authorization === 'Bearer access-a';
    if (accountA && blockNextA) {
      blockNextA = false;
      await blockedA;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(accountA ? {
      rate_limit: {
        primary_window: {
          used_percent: 42,
          limit_window_seconds: 604800,
          reset_at: 1_900_600_000,
        },
      },
      additional_rate_limits: [
        {
          limit_name: 'sora',
          rate_limit: {
            primary_window: {
              used_percent: 91,
              limit_window_seconds: 18000,
              reset_at: 1_900_000_050,
            },
          },
        },
        {
          limit_name: 'codex',
          rate_limit: {
            primary_window: {
              used_percent: 12,
              limit_window_seconds: 18000,
              reset_at: 1_900_000_100,
            },
          },
        },
      ],
    } : {
      rate_limit: {
        primary_window: {
          used_percent: 23,
          limit_window_seconds: 18000,
          reset_at: 1_900_000_200,
        },
        secondary_window: {
          used_percent: 63,
          limit_window_seconds: 604800,
          reset_at: 1_900_700_000,
        },
      },
    }));
  });
  const upstreamPort = await listen(upstream);
  const manager = new AccountManager([
    {
      name: 'codex-a',
      provider: 'codex',
      type: 'oauth',
      accessToken: 'access-a',
      accountId: 'workspace-a',
    },
    {
      name: 'codex-b',
      provider: 'codex',
      type: 'oauth',
      accessToken: 'access-b',
      accountId: 'workspace-b',
    },
  ]);
  const proxy = createProxyServer(manager, {
    provider: 'codex',
    upstream: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
    activeWarmup: false,
    warmupIntervalMs: 0,
  });
  await listen(proxy);

  try {
    await waitFor(() => requests.length === 2
      && manager.accounts.every(account => account.quota.unified7d != null));
    assert.deepEqual(requests, [
      { authorization: 'Bearer access-a', accountId: 'workspace-a' },
      { authorization: 'Bearer access-b', accountId: 'workspace-b' },
    ]);
    assert.equal(manager.accounts[0].quota.unified5h, 0.12);
    assert.equal(manager.accounts[0].quota.unified7d, 0.42);
    assert.equal(manager.accounts[1].quota.unified5h, 0.23);
    assert.equal(manager.accounts[1].quota.unified7d, 0.63);

    blockNextA = true;
    blockedA = new Promise(resolve => { releaseBlockedA = resolve; });
    const refreshes = [proxy.refreshQuotaAll(), proxy.refreshQuotaAll()];
    await waitFor(() => requests.length === 4);
    manager.addAccount({
      name: 'codex-c',
      provider: 'codex',
      type: 'oauth',
      accessToken: 'access-c',
      accountId: 'workspace-c',
    });
    releaseBlockedA();
    assert.deepEqual(await Promise.all(refreshes), [
      { targets: 3, measured: 3 },
      { targets: 3, measured: 3 },
    ]);
    assert.equal(manager.accounts[2].quota.unified5h, 0.23);
    assert.equal(requests.length, 7);

    manager.removeAccount(manager.accounts.find(account => account.name === 'codex-b').index);
    assert.deepEqual(await proxy.refreshQuotaAll(), { targets: 2, measured: 2 });
    assert.deepEqual(manager.accounts.map(account => account.name), ['codex-a', 'codex-c']);
    assert.equal(requests.length, 9);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('Codex usage refresh isolates invalid responses without changing prior quota or status', async () => {
  const requests = [];
  const upstream = http.createServer((req, res) => {
    requests.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer access-b') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{invalid');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      rate_limit: {
        primary_window: {
          used_percent: 31,
          limit_window_seconds: 604800,
          reset_at: 1_900_600_000,
        },
      },
    }));
  });
  const upstreamPort = await listen(upstream);
  const manager = new AccountManager([
    { name: 'codex-a', provider: 'codex', type: 'oauth', accessToken: 'access-a' },
    { name: 'codex-b', provider: 'codex', type: 'oauth', accessToken: 'access-b' },
  ]);
  manager.updateCodexUsage(1, {
    rate_limit: {
      primary_window: {
        used_percent: 9,
        limit_window_seconds: 604800,
        reset_at: 1_900_500_000,
      },
    },
  });
  const proxy = createProxyServer(manager, {
    provider: 'codex',
    upstream: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
    activeWarmup: false,
    warmupIntervalMs: 0,
  });
  await listen(proxy);

  try {
    await waitFor(() => requests.length === 2 && manager.accounts[0].quota.unified7d === 0.31);
    assert.equal(manager.accounts[1].quota.unified7d, 0.09);
    assert.equal(manager.accounts[1].status, 'active');
    assert.deepEqual(await proxy.refreshQuotaAll(), { targets: 2, measured: 1 });
    assert.equal(manager.accounts[1].quota.unified7d, 0.09);
    assert.equal(manager.accounts[1].status, 'active');
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

// Shared harness for the active fast-lane tests: one upstream that serves both
// the codex inference path and /wham/usage, with a mutable usage payload and a
// failure switch, plus a proxy wired for codex usage refresh (periodic timer
// off so only the startup fan-out and the fast lane can hit wham).
async function startCodexFastLaneHarness(extraConfig = {}) {
  const wham = { hits: 0, fail: false, usedPercent: 42 };
  const upstream = http.createServer((req, res) => {
    if (req.url === '/backend-api/wham/usage') {
      wham.hits++;
      if (wham.fail) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        rate_limit: {
          primary_window: {
            used_percent: wham.usedPercent,
            limit_window_seconds: 604800,
            reset_at: Math.floor(Date.now() / 1000) + 6 * 24 * 3600,
          },
        },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'response-id', usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const upstreamPort = await listen(upstream);
  const manager = new AccountManager([{
    name: 'codex-pro',
    provider: 'codex',
    type: 'oauth',
    accessToken: 'access-a',
    accountId: 'workspace-a',
    expiresAt: Date.now() + 3_600_000,
  }]);
  const proxy = createProxyServer(manager, {
    provider: 'codex',
    upstream: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
    activeWarmup: false,
    warmupIntervalMs: 0,
    ...extraConfig,
  });
  const proxyPort = await listen(proxy);
  const sendRequest = async () => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', input: [] }),
    });
    await response.text();
    return response.status;
  };
  const close = () => Promise.all([closeServer(proxy), closeServer(upstream)]);
  return { wham, manager, proxy, sendRequest, close };
}

test('Codex fast lane refreshes wham/usage after a completed request once the stamp is stale', async () => {
  const h = await startCodexFastLaneHarness();
  try {
    // Startup fan-out measures the account and stamps freshness.
    await waitFor(() => h.wham.hits === 1 && h.manager.accounts[0].quota.unified7d === 0.42);
    const account = h.manager.accounts[0];
    assert.equal(typeof account.quota.codexUsageAt, 'number');
    assert.equal(typeof h.manager.getStatus().accounts[0].quota.codexUsageAt, 'number');

    // The stamp survives a snapshot round-trip (restart persistence).
    const snapshot = h.manager.exportQuotaState();
    assert.equal(snapshot[0].quota.codexUsageAt, account.quota.codexUsageAt);
    const restored = new AccountManager([{
      name: 'codex-pro', provider: 'codex', type: 'oauth', accessToken: 'access-a',
    }]);
    restored.importQuotaState(snapshot);
    assert.equal(restored.accounts[0].quota.codexUsageAt, account.quota.codexUsageAt);

    // Stale stamp + fresh upstream number → a completed request re-measures.
    account.quota.codexUsageAt = Date.now() - 120_000;
    h.wham.usedPercent = 55;
    const before = Date.now();
    assert.equal(await h.sendRequest(), 200);
    await waitFor(() => h.wham.hits === 2 && account.quota.unified7d === 0.55);
    assert.ok(account.quota.codexUsageAt >= before);

    // A second request inside codexUsageActiveMs does NOT hit wham again.
    assert.equal(await h.sendRequest(), 200);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(h.wham.hits, 2);
  } finally {
    await h.close();
  }
});

test('Codex fast-lane failure leaves the client response intact and retries on the next completed request', async () => {
  const h = await startCodexFastLaneHarness();
  try {
    await waitFor(() => h.wham.hits === 1 && h.manager.accounts[0].quota.unified7d === 0.42);
    const account = h.manager.accounts[0];

    h.wham.fail = true;
    account.quota.codexUsageAt = Date.now() - 120_000;
    assert.equal(await h.sendRequest(), 200); // client response unaffected
    await waitFor(() => h.wham.hits === 2);
    assert.equal(account.quota.unified7d, 0.42); // failed refresh changed nothing

    // The failed attempt did not stamp freshness, so the stamp is still past
    // TTL and the next completed request retries at once.
    assert.equal(await h.sendRequest(), 200);
    await waitFor(() => h.wham.hits === 3);

    // Recovery: next completed request re-measures successfully.
    h.wham.fail = false;
    h.wham.usedPercent = 61;
    assert.equal(await h.sendRequest(), 200);
    await waitFor(() => h.wham.hits === 4 && account.quota.unified7d === 0.61);
    assert.ok(Date.now() - account.quota.codexUsageAt < 5_000);
  } finally {
    await h.close();
  }
});

test('codexUsageActiveMs: 0 disables the fast lane while startup refresh stays on', async () => {
  const h = await startCodexFastLaneHarness({ codexUsageActiveMs: 0 });
  try {
    await waitFor(() => h.wham.hits === 1 && h.manager.accounts[0].quota.unified7d === 0.42);
    h.manager.accounts[0].quota.codexUsageAt = Date.now() - 600_000;
    assert.equal(await h.sendRequest(), 200);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(h.wham.hits, 1);
  } finally {
    await h.close();
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

test('Codex proxy never replays an unsafe responses POST after an upstream 502', async () => {
  let upstreamHits = 0;
  let upstreamInvocation;
  const invocationId = '01900000-0000-4000-8000-000000000030';
  const sessionId = '01900000-0000-7000-8000-000000000031';
  const upstream = http.createServer((_req, res) => {
    upstreamHits += 1;
    upstreamInvocation = _req.headers['x-teamcodex-invocation'];
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'overloaded after dispatch' } }));
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
      upstream: `http://127.0.0.1:${upstreamPort}`,
      activeWarmup: false,
      codexUsageRefresh: false,
      continuityMode: true,
      continuityMaxSleepMs: 10,
    });
    const proxyPort = await listen(proxy);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-teamcodex-invocation': invocationId,
      },
      body: JSON.stringify({
        model: 'gpt-5.6',
        input: [],
        prompt_cache_key: sessionId,
      }),
    });
    await response.arrayBuffer();

    assert.equal(response.status, 502);
    assert.equal(upstreamHits, 1, 'an ambiguous Codex POST must never be replayed internally');
    assert.equal(upstreamInvocation, undefined, 'the local recovery nonce must not leave the proxy');
    assert.equal(response.headers.get('x-teamcodex-recovery-session'), sessionId);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('Codex proxy issues a recovery receipt when an unsafe responses POST times out after dispatch', async () => {
  let upstreamHits = 0;
  let upstreamClosed = false;
  const invocationId = '01900000-0000-4000-8000-000000000036';
  const sessionId = '01900000-0000-7000-8000-000000000037';
  const upstream = http.createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"partial":');
    res.once('close', () => { upstreamClosed = true; });
  });
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    const manager = new AccountManager([{
      name: 'codex-pro',
      provider: 'codex',
      type: 'oauth',
      accessToken: 'pooled-access-token',
      expiresAt: Date.now() + 3_600_000,
    }]);
    proxy = createProxyServer(manager, {
      provider: 'codex',
      upstream: `http://127.0.0.1:${upstreamPort}`,
      activeWarmup: false,
      codexUsageRefresh: false,
      upstreamResponseTimeoutMs: 40,
    });
    const proxyPort = await listen(proxy);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-teamcodex-invocation': invocationId,
      },
      body: JSON.stringify({
        model: 'gpt-5.6',
        input: [],
        prompt_cache_key: sessionId,
      }),
    });
    await response.arrayBuffer();

    assert.equal(response.status, 502);
    assert.equal(upstreamHits, 1, 'an ambiguous timed-out POST must not be replayed internally');
    assert.equal(response.headers.get('x-teamcodex-recovery-session'), sessionId);
    await waitFor(() => upstreamClosed, 500);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('Codex timeout cools the failed account before the next unsafe POST', async () => {
  const authsSeen = [];
  let upstreamHits = 0;
  let primaryClosed = false;
  const firstInvocationId = '01900000-0000-4000-8000-000000000042';
  const firstSessionId = '01900000-0000-7000-8000-000000000043';
  const upstream = http.createServer((req, res) => {
    const authorization = req.headers.authorization;
    authsSeen.push(authorization);
    upstreamHits += 1;
    if (authorization === 'Bearer primary-access-token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"partial":');
      res.once('close', () => { primaryClosed = true; });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'healthy-secondary-response' }));
  });
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    const manager = new AccountManager([{
      name: 'codex-primary',
      provider: 'codex',
      type: 'oauth',
      accessToken: 'primary-access-token',
      expiresAt: Date.now() + 3_600_000,
    }, {
      name: 'codex-secondary',
      provider: 'codex',
      type: 'oauth',
      accessToken: 'secondary-access-token',
      expiresAt: Date.now() + 3_600_000,
    }], 0.98, 0);
    const measuredAt = Date.now() + 3_600_000;
    for (const account of manager.accounts) {
      account.quota.unified5h = 0.1;
      account.quota.unified5hReset = measuredAt;
      account.quota.unified7d = 0.1;
      account.quota.unified7dReset = measuredAt;
    }
    manager.currentIndex = 0;
    proxy = createProxyServer(manager, {
      provider: 'codex',
      upstream: `http://127.0.0.1:${upstreamPort}`,
      activeWarmup: false,
      codexUsageRefresh: false,
      upstreamResponseTimeoutMs: 40,
    });
    const proxyPort = await listen(proxy);
    const first = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-teamcodex-invocation': firstInvocationId,
      },
      body: JSON.stringify({
        model: 'gpt-5.6',
        input: [],
        prompt_cache_key: firstSessionId,
      }),
    });
    await first.arrayBuffer();

    assert.equal(first.status, 502);
    assert.equal(upstreamHits, 1, 'an ambiguous timed-out POST must not be replayed internally');
    assert.deepEqual(authsSeen, ['Bearer primary-access-token']);
    assert.equal(first.headers.get('x-teamcodex-recovery-session'), firstSessionId);
    assert.equal(first.headers.get('retry-after'), '5', 'the client must not retry a timeout immediately');
    assert.equal(manager.accounts[0].inflight, 0, 'the timed-out account slot must be released');
    await waitFor(() => primaryClosed, 500);

    const second = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6', input: [] }),
    });

    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { id: 'healthy-secondary-response' });
    assert.deepEqual(authsSeen, [
      'Bearer primary-access-token',
      'Bearer secondary-access-token',
    ], 'the next client request must avoid the temporarily unhealthy account');
    assert.ok(manager.accounts.every(account => account.status === 'active'));
    await waitFor(() => manager.accounts.every(account => account.inflight === 0), 500);
    manager.accounts[0].dispatchFailureCooldownUntil = Date.now() - 1;
    manager.currentIndex = 0;
    assert.equal(manager.getActiveAccount(), manager.accounts[0], 'the cooldown must expire without changing account health');
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('Codex unsafe SSE mid-stream transport failure cools the failed account before a retry', async () => {
  const authsSeen = [];
  let primaryAttempts = 0;
  const upstream = http.createServer((req, res) => {
    const authorization = req.headers.authorization || '';
    authsSeen.push(authorization);
    if (authorization === 'Bearer codex-primary' && primaryAttempts++ === 0) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: response.output_text.delta\ndata: {"delta":"partial"}\n\n');
      setTimeout(() => res.socket.destroy(), 20);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, authorization }));
  });
  let proxy;

  const request = port => new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: '127.0.0.1',
      port,
      path: '/codex/responses',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, response => {
      const chunks = [];
      const settle = extra => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString(),
        ...extra,
      });
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => settle({ cleanEnd: true }));
      response.once('aborted', () => settle({ cleanEnd: false }));
      response.once('error', error => settle({ cleanEnd: false, error: error.message }));
    });
    outgoing.once('error', reject);
    outgoing.end(JSON.stringify({ model: 'gpt-5.6', input: [] }));
  });

  try {
    const upstreamPort = await listen(upstream);
    const manager = new AccountManager([
      {
        name: 'codex-primary', provider: 'codex', type: 'oauth',
        accessToken: 'codex-primary', accountId: 'workspace-primary',
        expiresAt: Date.now() + 3_600_000, priority: 0,
      },
      {
        name: 'codex-secondary', provider: 'codex', type: 'oauth',
        accessToken: 'codex-secondary', accountId: 'workspace-secondary',
        expiresAt: Date.now() + 3_600_000, priority: 1,
      },
    ], 0.98, 0);
    const measuredAt = Date.now() + 3_600_000;
    for (const account of manager.accounts) {
      account.quota.unified5h = 0.1;
      account.quota.unified5hReset = measuredAt;
      account.quota.unified7d = 0.1;
      account.quota.unified7dReset = measuredAt;
    }
    manager.currentIndex = 0;
    proxy = createProxyServer(manager, {
      provider: 'codex',
      upstream: `http://127.0.0.1:${upstreamPort}`,
      activeWarmup: false,
      codexUsageRefresh: false,
      sessionAffinity: false,
    });
    const proxyPort = await listen(proxy);

    const first = await request(proxyPort);
    assert.equal(first.status, 200);
    assert.match(first.body, /response\.output_text\.delta/);
    assert.equal(first.cleanEnd, true);
    assert.ok(manager.accounts[0].dispatchFailureCooldownUntil > Date.now(),
      'an unsafe Codex stream transport failure after headers must cool its account');

    const second = await request(proxyPort);
    assert.equal(second.status, 200);
    assert.deepEqual(authsSeen, [
      'Bearer codex-primary',
      'Bearer codex-secondary',
    ], 'the immediate retry must avoid the account whose stream died');
    assert.match(second.body, /"ok":true/);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('Codex unsafe SSE clean truncation cools the failed account before a retry', async () => {
  const authsSeen = [];
  let upstreamAttempts = 0;
  const upstream = http.createServer((req, res) => {
    const authorization = req.headers.authorization || '';
    authsSeen.push(authorization);
    upstreamAttempts += 1;
    if (upstreamAttempts === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: response.output_text.delta\ndata: {"delta":"partial"}\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, authorization }));
  });
  let proxy;

  const request = port => new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: '127.0.0.1',
      port,
      path: '/codex/responses',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString(),
        cleanEnd: true,
      }));
      response.once('aborted', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString(),
        cleanEnd: false,
      }));
      response.once('error', error => reject(error));
    });
    outgoing.once('error', reject);
    outgoing.end(JSON.stringify({ model: 'gpt-5.6', input: [] }));
  });

  try {
    const upstreamPort = await listen(upstream);
    const manager = new AccountManager([
      {
        name: 'codex-primary', provider: 'codex', type: 'oauth',
        accessToken: 'codex-primary', accountId: 'workspace-primary',
        expiresAt: Date.now() + 3_600_000, priority: 0,
      },
      {
        name: 'codex-secondary', provider: 'codex', type: 'oauth',
        accessToken: 'codex-secondary', accountId: 'workspace-secondary',
        expiresAt: Date.now() + 3_600_000, priority: 1,
      },
    ], 0.98, 0);
    const measuredAt = Date.now() + 3_600_000;
    for (const account of manager.accounts) {
      account.quota.unified5h = 0.1;
      account.quota.unified5hReset = measuredAt;
      account.quota.unified7d = 0.1;
      account.quota.unified7dReset = measuredAt;
    }
    manager.currentIndex = 0;
    proxy = createProxyServer(manager, {
      provider: 'codex',
      upstream: `http://127.0.0.1:${upstreamPort}`,
      activeWarmup: false,
      codexUsageRefresh: false,
      sessionAffinity: false,
    });
    const proxyPort = await listen(proxy);

    const first = await request(proxyPort);
    assert.equal(first.status, 200);
    assert.equal(first.cleanEnd, true);
    assert.match(first.body, /response\.output_text\.delta/);
    assert.ok(manager.accounts[0].dispatchFailureCooldownUntil > Date.now(),
      'a clean non-terminal Codex stream must cool the account');
    assert.equal(manager.accounts[0].inflight, 0);

    const second = await request(proxyPort);
    assert.equal(second.status, 200);
    assert.deepEqual(authsSeen, [
      'Bearer codex-primary',
      'Bearer codex-secondary',
    ], 'the immediate next turn must avoid the account with a truncated stream');
    assert.match(second.body, /"ok":true/);
    assert.ok(manager.accounts.every(account => account.inflight === 0));
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('Codex unsafe gzip SSE clean truncation cools the failed account before a retry', async () => {
  const authsSeen = [];
  const compressed = gzipSync(Buffer.from(
    'event: response.output_text.delta\ndata: {"delta":"partial"}\n\n',
  ));
  const upstream = http.createServer((req, res) => {
    const authorization = req.headers.authorization || '';
    authsSeen.push(authorization);
    if (authorization === 'Bearer codex-primary') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'content-encoding': 'gzip',
        'content-length': String(compressed.length),
      });
      res.end(compressed);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, authorization }));
  });
  let proxy;

  const request = port => new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: '127.0.0.1',
      port,
      path: '/codex/responses',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.once('error', reject);
    });
    outgoing.once('error', reject);
    outgoing.end(JSON.stringify({ model: 'gpt-5.6', input: [] }));
  });

  try {
    const upstreamPort = await listen(upstream);
    const manager = new AccountManager([
      {
        name: 'codex-primary', provider: 'codex', type: 'oauth',
        accessToken: 'codex-primary', accountId: 'workspace-primary',
        expiresAt: Date.now() + 3_600_000, priority: 0,
      },
      {
        name: 'codex-secondary', provider: 'codex', type: 'oauth',
        accessToken: 'codex-secondary', accountId: 'workspace-secondary',
        expiresAt: Date.now() + 3_600_000, priority: 1,
      },
    ], 0.98, 0);
    const measuredAt = Date.now() + 3_600_000;
    for (const account of manager.accounts) {
      account.quota.unified5h = 0.1;
      account.quota.unified5hReset = measuredAt;
      account.quota.unified7d = 0.1;
      account.quota.unified7dReset = measuredAt;
    }
    manager.currentIndex = 0;
    proxy = createProxyServer(manager, {
      provider: 'codex',
      upstream: `http://127.0.0.1:${upstreamPort}`,
      activeWarmup: false,
      codexUsageRefresh: false,
      sessionAffinity: false,
    });
    const proxyPort = await listen(proxy);

    const first = await request(proxyPort);
    const cooldownUntil = manager.accounts[0].dispatchFailureCooldownUntil || 0;
    const second = await request(proxyPort);
    assert.equal(first.status, 200);
    assert.equal(first.headers['content-encoding'], 'gzip');
    assert.equal(first.headers['content-length'], String(compressed.length));
    assert.equal(first.headers['retry-after'], undefined,
      'a partially delivered raw stream must not gain Retry-After');
    assert.deepEqual(first.body, compressed, 'the proxy must relay the exact compressed bytes');
    assert.ok(cooldownUntil > Date.now(),
      'a clean non-terminal compressed Codex stream must cool the account');
    assert.equal(manager.accounts[0].inflight, 0);

    assert.equal(second.status, 200);
    assert.deepEqual(authsSeen, [
      'Bearer codex-primary',
      'Bearer codex-secondary',
    ], 'the immediate next turn must avoid the account with a truncated compressed stream');
    assert.match(second.body.toString(), /"ok":true/);
    assert.ok(manager.accounts.every(account => account.inflight === 0));
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('Codex gzip SSE terminal response preserves raw bytes without cooldown', async () => {
  const payload = Buffer.from(
    'event: response.output_text.delta\ndata: {"delta":"ok"}\n\n'
      + 'event: response.completed\ndata: {"type":"response.completed"}\n\n',
  );
  const compressed = gzipSync(payload);
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'content-encoding': 'gzip',
      'content-length': String(compressed.length),
      'x-codex-test': 'terminal',
    });
    res.end(compressed);
  });
  let proxy;
  try {
    const upstreamPort = await listen(upstream);
    const manager = new AccountManager([{
      name: 'codex-terminal', provider: 'codex', type: 'oauth',
      accessToken: 'codex-terminal', accountId: 'workspace-terminal',
      expiresAt: Date.now() + 3_600_000,
    }]);
    proxy = createProxyServer(manager, {
      provider: 'codex',
      upstream: `http://127.0.0.1:${upstreamPort}`,
      activeWarmup: false,
      codexUsageRefresh: false,
      sessionAffinity: false,
    });
    const proxyPort = await listen(proxy);
    const response = await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1', port: proxyPort,
        path: '/codex/responses', method: 'POST',
        headers: { 'content-type': 'application/json' },
      }, incoming => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.once('end', () => resolve({ headers: incoming.headers, body: Buffer.concat(chunks) }));
      });
      request.once('error', reject);
      request.end(JSON.stringify({ model: 'gpt-5.6', input: [] }));
    });
    assert.equal(response.headers['content-encoding'], 'gzip');
    assert.equal(response.headers['content-length'], String(compressed.length));
    assert.deepEqual(response.body, compressed);
    assert.equal(manager.accounts[0].dispatchFailureCooldownUntil || 0, 0,
      'a terminal compressed stream must not cool the account');
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('Codex proxy issues a recovery receipt when an unsafe responses POST exceeds the response limit', async () => {
  let upstreamHits = 0;
  const invocationId = '01900000-0000-4000-8000-000000000038';
  const sessionId = '01900000-0000-7000-8000-000000000039';
  const upstream = http.createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: 'x'.repeat(2048) }));
  });
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    const manager = new AccountManager([{
      name: 'codex-pro',
      provider: 'codex',
      type: 'oauth',
      accessToken: 'pooled-access-token',
      expiresAt: Date.now() + 3_600_000,
    }]);
    proxy = createProxyServer(manager, {
      provider: 'codex',
      upstream: `http://127.0.0.1:${upstreamPort}`,
      activeWarmup: false,
      codexUsageRefresh: false,
      maxResponseBytes: 1024,
    });
    const proxyPort = await listen(proxy);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-teamcodex-invocation': invocationId,
      },
      body: JSON.stringify({
        model: 'gpt-5.6',
        input: [],
        prompt_cache_key: sessionId,
      }),
    });
    await response.arrayBuffer();

    assert.equal(response.status, 502);
    assert.equal(upstreamHits, 1, 'an oversized response must not replay an ambiguous POST');
    assert.equal(response.headers.get('x-teamcodex-recovery-session'), sessionId);
    assert.equal(response.headers.get('retry-after'), '5',
      'an ambiguous oversized response must not trigger an immediate client retry');
    assert.ok(manager.accounts[0].dispatchFailureCooldownUntil > Date.now(),
      'the completed-but-unusable response path must briefly skip this account');
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
});

test('Codex proxy issues a recovery receipt and retry delay for an unsafe transport failure', async () => {
  const originalFetch = globalThis.fetch;
  const invocationId = '01900000-0000-4000-8000-000000000040';
  const sessionId = '01900000-0000-7000-8000-000000000041';
  let proxy;

  try {
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const manager = new AccountManager([{
      name: 'codex-pro',
      provider: 'codex',
      type: 'oauth',
      accessToken: 'pooled-access-token',
      expiresAt: Date.now() + 3_600_000,
    }]);
    proxy = createProxyServer(manager, {
      provider: 'codex',
      upstream: 'http://127.0.0.1:9',
      activeWarmup: false,
      codexUsageRefresh: false,
    });
    const proxyPort = await listen(proxy);
    const response = await originalFetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-teamcodex-invocation': invocationId,
      },
      body: JSON.stringify({
        model: 'gpt-5.6',
        input: [],
        prompt_cache_key: sessionId,
      }),
    });
    await response.arrayBuffer();

    assert.equal(response.status, 502);
    assert.equal(response.headers.get('x-teamcodex-recovery-session'), sessionId);
    assert.equal(response.headers.get('retry-after'), '5');
    assert.ok(manager.accounts[0].dispatchFailureCooldownUntil > Date.now(),
      'an unsafe transport failure temporarily removes the failed account from selection');
    assert.equal(manager.getStatus().accounts[0].usable, false);
  } finally {
    globalThis.fetch = originalFetch;
    await closeServer(proxy);
  }
});

test('Codex proxy does not mint a recovery receipt for non-POST responses methods', async () => {
  const sessionId = '01900000-0000-7000-8000-000000000032';
  const upstream = http.createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{}');
  });
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    const manager = new AccountManager([{
      name: 'codex-pro',
      provider: 'codex',
      type: 'oauth',
      accessToken: 'pooled-access-token',
      expiresAt: Date.now() + 3_600_000,
    }]);
    proxy = createProxyServer(manager, {
      provider: 'codex',
      upstream: `http://127.0.0.1:${upstreamPort}`,
      activeWarmup: false,
      codexUsageRefresh: false,
    });
    const proxyPort = await listen(proxy);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-teamcodex-invocation': '01900000-0000-4000-8000-000000000033',
      },
      body: JSON.stringify({ prompt_cache_key: sessionId }),
    });
    await response.arrayBuffer();

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-teamcodex-recovery-session'), null);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(upstream)]);
  }
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
    codexUsageRefresh: false,
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
