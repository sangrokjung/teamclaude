import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createDefaultConfig } from '../src/config.js';
import { createProxyServer } from '../src/server.js';

const SOL = 'gpt-5.6-sol';
const TERRA = 'gpt-5.6-terra';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

function makeAccounts(type = 'oauth') {
  return new AccountManager([
    {
      name: 'a', provider: 'codex', type, accessToken: 'fixture-a',
      expiresAt: Date.now() + 3_600_000, priority: 0,
    },
    {
      name: 'b', provider: 'codex', type, accessToken: 'fixture-b',
      expiresAt: Date.now() + 3_600_000, priority: 1,
    },
  ], 0.98);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function accountName(req) {
  return (req.headers.authorization || '').includes('fixture-a') ? 'a' : 'b';
}

function unsupported(res, model, account = '') {
  res.writeHead(400, {
    'content-type': 'application/json',
    ...(account ? { 'x-fixture-account': account } : {}),
  });
  res.end(JSON.stringify({
    detail: `The '${model}' model is not supported when using Codex with a ChatGPT account.`,
  }));
}

function ok(res, body) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function startProxy(manager, upstreamPort, overrides = {}) {
  return createProxyServer(manager, {
    provider: 'codex',
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    codexUsageRefresh: false,
    sessionAffinity: false,
    ...overrides,
  });
}

function post(port, model = SOL) {
  return fetch(`http://127.0.0.1:${port}/codex/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: [{ role: 'user', content: 'fixture' }] }),
  });
}

function postRaw(port, model = SOL) {
  const body = Buffer.from(JSON.stringify({
    model,
    input: [{ role: 'user', content: 'fixture' }],
  }));
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/codex/responses',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.length),
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

test('exact Codex ChatGPT unsupported-model rejection quarantines the account without replaying the POST', async () => {
  const hits = { a: 0, b: 0 };
  const upstream = http.createServer(async (req, res) => {
    await readJson(req);
    const account = accountName(req);
    hits[account] += 1;
    if (account === 'a') unsupported(res, SOL);
    else ok(res, { account });
  });
  const manager = makeAccounts();
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    proxy = startProxy(manager, upstreamPort);
    const proxyPort = await listen(proxy);
    const response = await post(proxyPort);

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      detail: `The '${SOL}' model is not supported when using Codex with a ChatGPT account.`,
    });
    assert.deepEqual(hits, { a: 1, b: 0 });
    assert.equal(manager.anyUsable(null, SOL), true);
    assert.equal(manager._isAvailable(manager.accounts[0], SOL), false);
    assert.equal(manager._isAvailable(manager.accounts[0], TERRA), true);
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('gzip unsupported-model rejection preserves encoded bytes and headers without replay', async () => {
  const plainBody = Buffer.from(JSON.stringify({
    detail: `The '${SOL}' model is not supported when using Codex with a ChatGPT account.`,
  }));
  const encodedBody = gzipSync(plainBody);
  let hits = 0;
  const upstream = http.createServer(async (req, res) => {
    await readJson(req);
    hits += 1;
    res.writeHead(400, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': String(encodedBody.length),
    });
    res.end(encodedBody);
  });
  const manager = makeAccounts();
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    proxy = startProxy(manager, upstreamPort);
    const proxyPort = await listen(proxy);
    const response = await postRaw(proxyPort);

    assert.equal(response.status, 400);
    assert.equal(response.headers['content-encoding'], 'gzip');
    assert.equal(response.headers['content-length'], String(encodedBody.length));
    assert.deepEqual(response.body, encodedBody);
    assert.equal(hits, 1);
    assert.equal(manager._isAvailable(manager.accounts[0], SOL), false);
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('oversized gzip detail is relayed without model quarantine', async () => {
  const plainBody = Buffer.from(`${JSON.stringify({
    detail: `The '${SOL}' model is not supported when using Codex with a ChatGPT account.`,
  })}${' '.repeat(20_000)}`);
  const encodedBody = gzipSync(plainBody);
  const upstream = http.createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(400, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': String(encodedBody.length),
    });
    res.end(encodedBody);
  });
  const manager = makeAccounts();
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    proxy = startProxy(manager, upstreamPort);
    const proxyPort = await listen(proxy);
    const response = await postRaw(proxyPort);

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, encodedBody);
    assert.equal(manager._isAvailable(manager.accounts[0], SOL), true);
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('oversized identity detail is relayed without model quarantine', async () => {
  const responseBody = Buffer.from(`${JSON.stringify({
    detail: `The '${SOL}' model is not supported when using Codex with a ChatGPT account.`,
  })}${' '.repeat(20_000)}`);
  const upstream = http.createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(400, {
      'content-type': 'application/json',
      'content-length': String(responseBody.length),
    });
    res.end(responseBody);
  });
  const manager = makeAccounts();
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    proxy = startProxy(manager, upstreamPort);
    const proxyPort = await listen(proxy);
    const response = await postRaw(proxyPort);

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, responseBody);
    assert.equal(manager._isAvailable(manager.accounts[0], SOL), true);
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('gzip Codex SSE ends cleanly and releases a keep-alive connection', async () => {
  const event = Buffer.from(
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: { usage: { input_tokens: 1, output_tokens: 1 } },
    })}\n\n`,
  );
  const encodedBody = gzipSync(event);
  const upstream = http.createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'content-encoding': 'gzip',
      'content-length': String(encodedBody.length),
    });
    res.end(encodedBody);
  });
  const manager = makeAccounts();
  manager.accounts[0]._usageAuthStreak = 2;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let proxy;

  const request = ({ port, path, method = 'GET', body }) => new Promise((resolve, reject) => {
    const headers = body == null ? {} : {
      'content-type': 'application/json',
      'content-length': String(body.length),
    };
    const outgoing = http.request({
      host: '127.0.0.1', port, path, method, headers, agent,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => {
        clearTimeout(timer);
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
      response.once('error', reject);
    });
    const timer = setTimeout(() => {
      outgoing.destroy();
      reject(new Error(`${method} ${path} timed out`));
    }, 800);
    outgoing.once('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    outgoing.end(body);
  });

  try {
    const upstreamPort = await listen(upstream);
    proxy = startProxy(manager, upstreamPort);
    const proxyPort = await listen(proxy);
    const body = Buffer.from(JSON.stringify({
      model: SOL,
      input: [{ role: 'user', content: 'fixture' }],
    }));
    const streamed = await request({
      port: proxyPort,
      path: '/codex/responses',
      method: 'POST',
      body,
    });
    const status = await request({ port: proxyPort, path: '/teamclaude/status' });

    assert.equal(streamed.status, 200);
    assert.equal(streamed.headers['content-encoding'], 'gzip');
    assert.equal(streamed.headers['content-length'], String(encodedBody.length));
    assert.deepEqual(streamed.body, encodedBody);
    assert.equal(status.status, 200);
    assert.equal(manager.accounts[0]._usageAuthStreak, undefined);
    assert.equal(typeof manager.accounts[0].lastSuccessfulAt, 'string');
  } finally {
    agent.destroy();
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('a fresh recovery turn uses the next compatible OAuth account', async () => {
  const hits = { a: 0, b: 0 };
  const upstream = http.createServer(async (req, res) => {
    await readJson(req);
    const account = accountName(req);
    hits[account] += 1;
    if (account === 'a') unsupported(res, SOL);
    else ok(res, { account });
  });
  const manager = makeAccounts();
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    proxy = startProxy(manager, upstreamPort);
    const proxyPort = await listen(proxy);

    const rejected = await post(proxyPort);
    assert.equal(rejected.status, 400);
    await rejected.text();
    const recovered = await post(proxyPort);

    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), { account: 'b' });
    assert.deepEqual(hits, { a: 1, b: 1 });
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('fresh recovery turns quarantine the Sol fleet before pre-dispatch Terra fallback', async () => {
  const attempts = [];
  const logs = [];
  const originalLog = console.log;
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    const account = accountName(req);
    attempts.push(`${account}:${body.model}`);
    if (body.model === SOL) unsupported(res, SOL);
    else ok(res, { model: body.model });
  });
  const manager = makeAccounts();
  let proxy;

  try {
    console.log = (...args) => logs.push(args.join(' '));
    const upstreamPort = await listen(upstream);
    proxy = startProxy(manager, upstreamPort, { modelFallbacks: { [SOL]: [TERRA] } });
    const proxyPort = await listen(proxy);
    const first = await post(proxyPort);
    assert.equal(first.status, 400);
    await first.text();
    const second = await post(proxyPort);
    assert.equal(second.status, 400);
    await second.text();
    const recovered = await post(proxyPort);

    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), { model: TERRA });
    assert.deepEqual(attempts, [`a:${SOL}`, `b:${SOL}`, `a:${TERRA}`]);
    assert.ok(logs.some(line => line.includes(
      `[TeamClaude] codex-model-fallback: ${SOL} → ${TERRA}`,
    )));
  } finally {
    console.log = originalLog;
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('temporary account throttling keeps the requested Codex model', async () => {
  const attempts = [];
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    attempts.push(body.model);
    ok(res, { model: body.model });
  });
  const manager = makeAccounts();
  const recoverAt = Date.now() + 60;
  for (const account of manager.accounts) {
    account.status = 'throttled';
    account.rateLimitedUntil = recoverAt;
  }
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    proxy = startProxy(manager, upstreamPort, {
      modelFallbacks: { [SOL]: [TERRA] },
      continuityMode: true,
      continuityMaxWaitMs: 500,
      continuityMaxSleepMs: 10,
      continuityJitterMs: 0,
    });
    const proxyPort = await listen(proxy);
    const response = await post(proxyPort);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { model: SOL });
    assert.deepEqual(attempts, [SOL]);
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('successful Codex response clears a model quarantine recorded in flight', async () => {
  const manager = makeAccounts();
  const upstream = http.createServer(async (req, res) => {
    await readJson(req);
    manager.markModelUnsupported(manager.accounts[0], SOL, 60_000);
    ok(res, { model: SOL });
  });
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    proxy = startProxy(manager, upstreamPort);
    const proxyPort = await listen(proxy);
    const response = await post(proxyPort);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { model: SOL });
    assert.equal(manager.accounts[0].unsupportedModels.has(SOL), false);
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('all exact rejections without fallback preserve each upstream 400 without replay', async () => {
  const attempts = [];
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    const account = accountName(req);
    attempts.push(`${account}:${body.model}`);
    unsupported(res, body.model, account);
  });
  const manager = makeAccounts();
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    proxy = startProxy(manager, upstreamPort);
    const proxyPort = await listen(proxy);
    const first = await post(proxyPort);
    assert.equal(first.status, 400);
    assert.equal(first.headers.get('x-fixture-account'), 'a');
    assert.deepEqual(await first.json(), {
      detail: `The '${SOL}' model is not supported when using Codex with a ChatGPT account.`,
    });
    const second = await post(proxyPort);
    assert.equal(second.status, 400);
    assert.equal(second.headers.get('x-fixture-account'), 'b');
    await second.text();
    const exhausted = await post(proxyPort);
    assert.equal(exhausted.status, 429);
    await exhausted.text();
    assert.deepEqual(attempts, [`a:${SOL}`, `b:${SOL}`]);
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('fully quarantined model dead-ends return promptly without dispatch', async t => {
  for (const scenario of [
    { name: 'no fallback chain', quarantined: [SOL], modelFallbacks: {} },
    { name: 'exhausted fallback chain', quarantined: [SOL, TERRA], modelFallbacks: { [SOL]: [TERRA] } },
  ]) {
    await t.test(scenario.name, async () => {
      let hits = 0;
      const upstream = http.createServer(async (req, res) => {
        await readJson(req);
        hits += 1;
        ok(res, { unexpected: true });
      });
      const manager = makeAccounts();
      for (const account of manager.accounts) {
        for (const model of scenario.quarantined) {
          manager.markModelUnsupported(account, model, 60_000);
        }
      }
      let proxy;

      try {
        const upstreamPort = await listen(upstream);
        proxy = startProxy(manager, upstreamPort, {
          modelFallbacks: scenario.modelFallbacks,
          continuityMode: true,
          continuityMaxWaitMs: 700,
          continuityMaxSleepMs: 50,
          continuityJitterMs: 0,
        });
        const proxyPort = await listen(proxy);
        const startedAt = Date.now();
        const response = await post(proxyPort);
        const elapsedMs = Date.now() - startedAt;

        assert.equal(response.status, 429);
        const retryAfter = Number(response.headers.get('retry-after'));
        assert.ok(retryAfter >= 59 && retryAfter <= 60, `unexpected retry-after ${retryAfter}`);
        await response.text();
        assert.ok(elapsedMs < 300, `model dead-end waited ${elapsedMs}ms`);
        assert.equal(hits, 0);
        assert.deepEqual(manager.accounts.map(account => account.inflight), [0, 0]);
      } finally {
        await Promise.all([close(proxy), close(upstream)]);
      }
    });
  }
});

test('expired account resets never revive a model-quarantined fleet', () => {
  const manager = makeAccounts();
  for (const account of manager.accounts) {
    account.status = 'exhausted';
    account.quota.unified5hReset = Date.now() - 1;
    manager.markModelUnsupported(account, SOL, 60_000);
  }

  assert.equal(manager.getActiveAccount(null, SOL), null);
  assert.deepEqual(manager.accounts.map(account => account.status), ['exhausted', 'exhausted']);
});

test('mixed-pool OAuth model dead-ends keep the POST isolated and expose its quarantine TTL', async () => {
  const hits = { oauth: 0, apiKey: 0 };
  const upstream = http.createServer(async (req, res) => {
    await readJson(req);
    const isOauth = (req.headers.authorization || '').includes('fixture-oauth');
    hits[isOauth ? 'oauth' : 'apiKey'] += 1;
    if (isOauth) unsupported(res, SOL);
    else ok(res, { account: 'api-key' });
  });
  const manager = new AccountManager([
    {
      name: 'oauth', provider: 'codex', type: 'oauth', accessToken: 'fixture-oauth',
      expiresAt: Date.now() + 3_600_000, priority: 0,
    },
    {
      name: 'api-key', provider: 'codex', type: 'api_key', apiKey: 'fixture-api-key',
      expiresAt: Date.now() + 3_600_000, priority: 1,
    },
  ], 0.98);
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    proxy = startProxy(manager, upstreamPort, { modelFallbacks: {} });
    const proxyPort = await listen(proxy);
    const response = await post(proxyPort);

    assert.equal(response.status, 400);
    await response.text();
    const deadEnd = await post(proxyPort);
    assert.equal(deadEnd.status, 429);
    const retryAfter = Number(deadEnd.headers.get('retry-after'));
    assert.ok(retryAfter >= 1_799 && retryAfter <= 1_800, `unexpected retry-after ${retryAfter}`);
    await deadEnd.text();
    assert.deepEqual(hits, { oauth: 1, apiKey: 0 });
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('fresh recovery remains in the OAuth pool when API-key priority is higher', async () => {
  const hits = [];
  const upstream = http.createServer(async (req, res) => {
    await readJson(req);
    const authorization = req.headers.authorization || '';
    if (authorization.includes('fixture-oauth-a')) {
      hits.push('oauth-a');
      unsupported(res, SOL);
    } else if (authorization.includes('fixture-api-key')) {
      hits.push('api-key');
      ok(res, { account: 'api-key' });
    } else {
      hits.push('oauth-b');
      ok(res, { account: 'oauth-b' });
    }
  });
  const manager = new AccountManager([
    {
      name: 'oauth-a', provider: 'codex', type: 'oauth', accessToken: 'fixture-oauth-a',
      expiresAt: Date.now() + 3_600_000, priority: 0,
    },
    {
      name: 'api-key', provider: 'codex', type: 'api_key', apiKey: 'fixture-api-key',
      priority: 1,
    },
    {
      name: 'oauth-b', provider: 'codex', type: 'oauth', accessToken: 'fixture-oauth-b',
      expiresAt: Date.now() + 3_600_000, priority: 2,
    },
  ], 0.98);
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    proxy = startProxy(manager, upstreamPort);
    const proxyPort = await listen(proxy);
    const rejected = await post(proxyPort);
    await rejected.text();
    const recovered = await post(proxyPort);

    assert.equal(rejected.status, 400);
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), { account: 'oauth-b' });
    assert.deepEqual(hits, ['oauth-a', 'oauth-b']);
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('Codex POST 401 and 429 responses remain single-dispatch across mixed credentials', async t => {
  for (const status of [401, 429]) {
    for (const firstType of ['oauth', 'apikey']) {
      await t.test(`${status}-${firstType}`, async () => {
        const secondType = firstType === 'oauth' ? 'apikey' : 'oauth';
        let hits = 0;
        const upstream = http.createServer(async (req, res) => {
          await readJson(req);
          hits += 1;
          if (hits === 1) {
            res.writeHead(status, {
              'content-type': 'application/json',
              ...(status === 429 ? { 'retry-after': '1' } : {}),
            });
            res.end(JSON.stringify({ detail: `fixture-${status}` }));
          } else {
            ok(res, { replayed: true });
          }
        });
        const manager = new AccountManager([
          {
            name: 'first', provider: 'codex', type: firstType,
            ...(firstType === 'oauth'
              ? { accessToken: 'fixture-first', expiresAt: Date.now() + 3_600_000 }
              : { apiKey: 'fixture-first' }),
            priority: 0,
          },
          {
            name: 'second', provider: 'codex', type: secondType,
            ...(secondType === 'oauth'
              ? { accessToken: 'fixture-second', expiresAt: Date.now() + 3_600_000 }
              : { apiKey: 'fixture-second' }),
            priority: 1,
          },
        ], 0.98);
        let proxy;

        try {
          const upstreamPort = await listen(upstream);
          proxy = startProxy(manager, upstreamPort, {
            continuityMode: false,
            rateLimitFailovers: 1,
          });
          const proxyPort = await listen(proxy);
          const response = await post(proxyPort);

          assert.equal(response.status, status);
          const responseBody = await response.text();
          if (status === 429) {
            assert.deepEqual(JSON.parse(responseBody), { detail: `fixture-${status}` });
          }
          assert.equal(hits, 1);
        } finally {
          await Promise.all([close(proxy), close(upstream)]);
        }
      });
    }
  }
});

test('completed Codex 429 fails over once within the OAuth credential pool', async () => {
  const hits = [];
  const upstream = http.createServer(async (req, res) => {
    await readJson(req);
    const account = accountName(req);
    hits.push(account);
    if (account === 'a') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ detail: 'fixture-429' }));
    } else {
      ok(res, { account });
    }
  });
  const manager = makeAccounts();
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    proxy = startProxy(manager, upstreamPort, {
      continuityMode: false,
      rateLimitFailovers: 1,
    });
    const proxyPort = await listen(proxy);
    const response = await post(proxyPort);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { account: 'b' });
    assert.deepEqual(hits, ['a', 'b']);
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('completed Anthropic POST 429 safely fails over to another account', async () => {
  let hits = 0;
  const upstream = http.createServer(async (req, res) => {
    await readJson(req);
    hits += 1;
    if (hits === 1) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
    } else {
      ok(res, { replayed: true });
    }
  });
  const manager = new AccountManager([
    { name: 'a', provider: 'anthropic', type: 'api_key', apiKey: 'fixture-a', priority: 0 },
    { name: 'b', provider: 'anthropic', type: 'api_key', apiKey: 'fixture-b', priority: 1 },
  ], 0.98);
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    proxy = createProxyServer(manager, {
      provider: 'anthropic',
      upstream: `http://127.0.0.1:${upstreamPort}`,
      activeWarmup: false,
      sessionAffinity: false,
      continuityMode: false,
      rateLimitFailovers: 1,
    });
    const proxyPort = await listen(proxy);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fixture-model', messages: [] }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { replayed: true });
    assert.equal(hits, 2);
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('generic, mismatched, malformed, and API-key 400 responses never fail over', async t => {
  const cases = [
    {
      name: 'generic',
      body: JSON.stringify({ detail: 'invalid input' }),
      contentType: 'application/json',
      accountType: 'oauth',
    },
    {
      name: 'model-mismatch',
      body: JSON.stringify({
        detail: `The '${TERRA}' model is not supported when using Codex with a ChatGPT account.`,
      }),
      contentType: 'application/json',
      accountType: 'oauth',
    },
    { name: 'malformed', body: '{"detail":', contentType: 'application/json', accountType: 'oauth' },
    {
      name: 'quoted-prose',
      body: `operator quoted: ${JSON.stringify({
        detail: `The '${SOL}' model is not supported when using Codex with a ChatGPT account.`,
      })}`,
      contentType: 'text/plain',
      accountType: 'oauth',
    },
    {
      name: 'api-key',
      body: JSON.stringify({
        detail: `The '${SOL}' model is not supported when using Codex with a ChatGPT account.`,
      }),
      contentType: 'application/json',
      accountType: 'api_key',
    },
    {
      name: 'unsafe-model-slug',
      body: JSON.stringify({
        detail: "The 'gpt-5.6-sol\nforged' model is not supported when using Codex with a ChatGPT account.",
      }),
      contentType: 'application/json',
      accountType: 'oauth',
      requestModel: 'gpt-5.6-sol\nforged',
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let hits = 0;
      const upstream = http.createServer(async (req, res) => {
        await readJson(req);
        hits += 1;
        res.writeHead(400, { 'content-type': scenario.contentType });
        res.end(scenario.body);
      });
      const manager = makeAccounts(scenario.accountType);
      let proxy;

      try {
        const upstreamPort = await listen(upstream);
        proxy = startProxy(manager, upstreamPort, { modelFallbacks: { [SOL]: [TERRA] } });
        const proxyPort = await listen(proxy);
        const response = await post(proxyPort, scenario.requestModel || SOL);
        await response.text();

        assert.equal(response.status, 400);
        assert.equal(hits, 1);
      } finally {
        await Promise.all([close(proxy), close(upstream)]);
      }
    });
  }
});

test('model compatibility quarantine is model-scoped and expires lazily', () => {
  const manager = makeAccounts();
  const account = manager.accounts[0];

  manager.markModelUnsupported(account, SOL, 60_000);
  assert.equal(manager._isAvailable(account, SOL), false);
  assert.equal(manager._isAvailable(account, TERRA), true);

  account.unsupportedModels.set(SOL, Date.now() - 1);
  assert.equal(manager._isAvailable(account, SOL), true);
  assert.equal(account.unsupportedModels.has(SOL), false);
});

test('model compatibility quarantine sweeps expired entries and remains bounded', () => {
  const manager = makeAccounts();
  const account = manager.accounts[0];

  account.unsupportedModels.set('expired-model', Date.now() - 1);
  for (let index = 0; index < 100; index += 1) {
    manager.markModelUnsupported(account, `fixture-model-${index}`, 60_000);
  }

  assert.equal(account.unsupportedModels.has('expired-model'), false);
  assert.ok(account.unsupportedModels.size <= 64, `quarantine grew to ${account.unsupportedModels.size}`);
  assert.equal(account.unsupportedModels.has('fixture-model-99'), true);
});

test('model-scoped quota headers remain bounded under label churn', () => {
  const manager = makeAccounts();
  const account = manager.accounts[0];

  for (let index = 0; index < 100; index += 1) {
    manager.updateQuota(account, {
      [`anthropic-ratelimit-unified-7d_fixture_${index}-utilization`]: '0.5',
    });
  }

  assert.ok(Object.keys(account.quota.modelWeekly).length <= 64);
  assert.equal(account.quota.modelWeekly['7d_fixture_99'].utilization, 0.5);
});

test('new Codex configs include the verified Sol to Terra fallback', () => {
  const previous = process.env.TEAMCLAUDE_PROVIDER;
  process.env.TEAMCLAUDE_PROVIDER = 'codex';
  try {
    assert.deepEqual(createDefaultConfig().modelFallbacks, { [SOL]: [TERRA] });
  } finally {
    if (previous === undefined) delete process.env.TEAMCLAUDE_PROVIDER;
    else process.env.TEAMCLAUDE_PROVIDER = previous;
  }
});

test('runtime-added Codex accounts support model quarantine and status snapshots', () => {
  const manager = makeAccounts();
  const index = manager.addAccount({
    name: 'runtime', provider: 'codex', type: 'oauth', accessToken: 'runtime-token',
    expiresAt: Date.now() + 3_600_000,
  });

  assert.equal(manager.markModelUnsupported(index, SOL, 60_000), true);
  assert.equal(manager._isAvailable(manager.accounts[index], SOL), false);
  assert.deepEqual(manager.getStatus().accounts[index].unsupportedModels, [SOL]);
});

test('status omits stable account identities unless a trusted internal caller opts in', async () => {
  const manager = new AccountManager([{
    name: 'operator@example.test', provider: 'codex', type: 'oauth',
    accountUuid: 'stable-account-uuid', accessToken: 'fixture-token',
    expiresAt: Date.now() + 3_600_000,
  }], 0.98);

  const publicStatus = manager.getStatus();
  assert.equal('currentAccountUuid' in publicStatus, false);
  assert.equal('accountUuid' in publicStatus.accounts[0], false);

  const internalStatus = manager.getStatus({ includeIdentity: true });
  assert.equal(internalStatus.currentAccountUuid, 'stable-account-uuid');
  assert.equal(internalStatus.accounts[0].accountUuid, 'stable-account-uuid');

  const proxy = startProxy(manager, 1, { proxy: { apiKey: 'fixture-proxy-key' } });
  try {
    const proxyPort = await listen(proxy);
    const publicResponse = await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/status`);
    const publicBody = await publicResponse.json();
    assert.equal('currentAccountUuid' in publicBody, false);
    assert.equal('accountUuid' in publicBody.accounts[0], false);

    const spoofedResponse = await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/status`, {
      headers: { 'x-teamcodex-status-identity': '1' },
    });
    const spoofedBody = await spoofedResponse.json();
    assert.equal('currentAccountUuid' in spoofedBody, false);
    assert.equal('accountUuid' in spoofedBody.accounts[0], false);

    const internalResponse = await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/status`, {
      headers: {
        'x-api-key': 'fixture-proxy-key',
        'x-teamcodex-status-identity': '1',
      },
    });
    const internalBody = await internalResponse.json();
    assert.equal(internalBody.currentAccountUuid, 'stable-account-uuid');
    assert.equal(internalBody.accounts[0].accountUuid, 'stable-account-uuid');
  } finally {
    await close(proxy);
  }
});

test('Codex streaming request logs contain metadata only and omit bodies, identity, and unlisted headers', async () => {
  const logDir = await mkdtemp(join(tmpdir(), 'teamcodex-model-compat-log-'));
  const accessToken = 'opaque-credential-marker';
  const accountId = 'stable-chatgpt-account-id';
  const accountName = 'operator@example.test';
  const upstreamRequestId = 'upstream-request-id-fixture';
  const promptEmail = 'prompt-user@example.test';
  const promptToken = 'prompt-secret-token-fixture';
  const responseEmail = 'response-user@example.test';
  const auditToken = 'x-audit-token-fixture';
  const auditAccount = 'x-audit-account-fixture';
  const upstream = http.createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-request-id': upstreamRequestId,
      'x-audit-token': auditToken,
      'x-audit-email': responseEmail,
      'x-audit-account': auditAccount,
    });
    res.end(`event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: { output: [{ text: responseEmail }] },
    })}\n\n`);
  });
  const manager = new AccountManager([{
    name: accountName, provider: 'codex', type: 'oauth',
    accessToken, accountId, accountUuid: accountId,
    expiresAt: Date.now() + 3_600_000,
  }], 0.98);
  let proxy;

  try {
    const upstreamPort = await listen(upstream);
    proxy = startProxy(manager, upstreamPort, { logDir });
    const proxyPort = await listen(proxy);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses?token=query-secret`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-audit-email': promptEmail,
      },
      body: JSON.stringify({
        model: SOL,
        input: [{ role: 'user', content: `${promptEmail} ${promptToken}` }],
      }),
    });
    await response.text();
    for (let i = 0; i < 100 && (await readdir(logDir)).length === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const files = await readdir(logDir);
    assert.equal(files.length, 1);
    const log = await readFile(join(logDir, files[0]), 'utf8');
    for (const forbidden of [
      accessToken, accountId, accountName, upstreamRequestId,
      promptEmail, promptToken, responseEmail, auditToken, auditAccount, 'query-secret',
    ]) {
      assert.doesNotMatch(log, new RegExp(forbidden));
    }
    assert.doesNotMatch(log, /^(?:=== REQUEST BODY|=== RESPONSE BODY)/m);
    assert.doesNotMatch(log, /^\s*(authorization|chatgpt-account-id|x-request-id|x-audit-\w+):/im);
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
    await rm(logDir, { recursive: true, force: true });
  }
});
