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

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met before timeout');
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
