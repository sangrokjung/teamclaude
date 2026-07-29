import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const EXECUTOR_MODEL = 'claude-opus-4-8';
const ADVISOR_MODEL = 'claude-fable-5';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function makeAccounts() {
  const expiresAt = Date.now() + 3_600_000;
  return [
    { name: 'A', type: 'oauth', credential: 'a', expiresAt, priority: 0 },
    { name: 'B', type: 'oauth', credential: 'b', expiresAt, priority: 1 },
  ];
}

function advisorBody(extra = {}) {
  return {
    model: EXECUTOR_MODEL,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{
      type: 'advisor_20260301',
      name: 'advisor',
      model: ADVISOR_MODEL,
    }],
    ...extra,
  };
}

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  return {
    json: JSON.parse(raw.toString()),
    contentLength: req.headers['content-length'],
    bytes: raw.length,
  };
}

function postBody(port, body, signal = undefined) {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

function startProxy(accountManager, upstreamPort, routed, overrides = {}) {
  return createProxyServer(accountManager, {
    apiKey: 'k',
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    sessionAffinity: false,
    ...overrides,
  }, {
    onRequestRouted: (_reqId, detail) => routed.push(detail.account),
  });
}

function seedFableQuota(account, utilization) {
  account.quota.modelWeekly['7d_oi'] = {
    utilization,
    reset: Date.now() + 86_400_000,
  };
}

function ok200(res, body = { ok: true }) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function modelWeekly429(res) {
  res.writeHead(429, {
    'retry-after': '60',
    'anthropic-ratelimit-unified-7d_oi-utilization': '1',
    'anthropic-ratelimit-unified-7d_oi-reset': String(Math.floor(Date.now() / 1000) + 86_400),
    'content-type': 'application/json',
  });
  res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
}

function bare429(res) {
  res.writeHead(429, { 'retry-after': '60', 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
}

test('PIN: advisor decoys outside root tools do not affect top-level routing', async () => {
  const seen = [];
  const routed = [];
  const upstream = http.createServer(async (req, res) => {
    seen.push((await readRequest(req)).json);
    ok200(res);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(), 0.98);
  seedFableQuota(am.accounts[0], 1);
  seedFableQuota(am.accounts[1], 0.25);
  const proxy = startProxy(am, upstreamPort, routed);
  const proxyPort = await listen(proxy);

  try {
    const body = {
      model: EXECUTOR_MODEL,
      messages: [{
        role: 'user',
        content: JSON.stringify({
          type: 'advisor_20260301',
          model: ADVISOR_MODEL,
        }),
      }],
      metadata: {
        advisor: {
          type: 'advisor_20260301',
          model: ADVISOR_MODEL,
        },
      },
      tools: [{
        type: 'custom_tool',
        model: EXECUTOR_MODEL,
        input_schema: {
          type: 'object',
          properties: {
            advisor: {
              type: 'advisor_20260301',
              model: ADVISOR_MODEL,
            },
          },
        },
      }],
    };
    const res = await postBody(proxyPort, body);
    await res.text();

    assert.equal(res.status, 200);
    assert.deepEqual(routed, ['A']);
    assert.deepEqual(seen, [body]);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('advisor nested Fable routes to a Fable-ready account without fallback', async () => {
  const seen = [];
  const routed = [];
  const upstream = http.createServer(async (req, res) => {
    seen.push((await readRequest(req)).json);
    ok200(res);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(), 0.98);
  seedFableQuota(am.accounts[0], 1);
  seedFableQuota(am.accounts[1], 0.25);
  const proxy = startProxy(am, upstreamPort, routed, {
    modelFallbacks: { [ADVISOR_MODEL]: [EXECUTOR_MODEL] },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await postBody(proxyPort, advisorBody());
    await res.text();

    assert.equal(res.status, 200);
    const pairs = seen.map(body => [body.model, body.tools[0].model]);
    assert.deepEqual(routed, ['B'], `observed=${JSON.stringify({ routed, pairs })}`);
    assert.deepEqual(pairs, [
      [EXECUTOR_MODEL, ADVISOR_MODEL],
    ], `observed=${JSON.stringify({ routed, pairs })}`);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('cached advisor Fable exhaustion rewrites only the nested model before continuity wait', async () => {
  const seen = [];
  const routed = [];
  const upstream = http.createServer(async (req, res) => {
    seen.push(await readRequest(req));
    ok200(res);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(), 0.98);
  for (const account of am.accounts) seedFableQuota(account, 1);
  const proxy = startProxy(am, upstreamPort, routed, {
    modelFallbacks: { [ADVISOR_MODEL]: [EXECUTOR_MODEL] },
    continuityMode: true,
    continuityMaxWaitMs: 60_000,
    continuityMaxSleepMs: 60_000,
    continuityJitterMs: 0,
  });
  const proxyPort = await listen(proxy);
  const abort = new AbortController();
  let timeout = null;

  try {
    timeout = setTimeout(() => abort.abort(new Error('fallback entered continuity wait')), 250);
    let res;
    try {
      res = await postBody(proxyPort, advisorBody(), abort.signal);
    } catch (err) {
      if (abort.signal.aborted) assert.fail('fallback entered continuity wait');
      throw err;
    }
    clearTimeout(timeout);
    timeout = null;
    await res.text();

    assert.equal(res.status, 200);
    assert.deepEqual(routed, ['A']);
    const pairs = seen.map(({ json }) => [json.model, json.tools[0].model]);
    assert.deepEqual(pairs, [
      [EXECUTOR_MODEL, EXECUTOR_MODEL],
    ], `observed=${JSON.stringify({ routed, pairs })}`);
    assert.equal(seen[0].contentLength, String(seen[0].bytes));
  } finally {
    if (timeout) clearTimeout(timeout);
    abort.abort();
    proxy.close();
    upstream.close();
  }
});

test('live labeled advisor Fable exhaustion fails over then rewrites only the nested model', async () => {
  const seen = [];
  const routed = [];
  const upstream = http.createServer(async (req, res) => {
    const request = await readRequest(req);
    seen.push(request);
    if (request.json.tools[0].model === ADVISOR_MODEL) {
      modelWeekly429(res);
    } else {
      ok200(res);
    }
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(), 0.98);
  const proxy = startProxy(am, upstreamPort, routed, {
    modelFallbacks: { [ADVISOR_MODEL]: [EXECUTOR_MODEL] },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await postBody(proxyPort, advisorBody());
    await res.text();

    const pairs = seen.map(({ json }) => [json.model, json.tools[0].model]);
    assert.equal(res.status, 200, `observed=${JSON.stringify({ routed, pairs })}`);
    assert.deepEqual(routed.slice(0, 2), ['A', 'B']);
    assert.equal(routed.length, 3);
    assert.deepEqual(pairs, [
      [EXECUTOR_MODEL, ADVISOR_MODEL],
      [EXECUTOR_MODEL, ADVISOR_MODEL],
      [EXECUTOR_MODEL, EXECUTOR_MODEL],
    ]);
    assert.equal(seen[2].contentLength, String(seen[2].bytes));
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('bare advisor 429 stays nested Fable through bounded failover and recovery', async () => {
  const seen = [];
  const routed = [];
  const upstream = http.createServer(async (req, res) => {
    seen.push((await readRequest(req)).json);
    if (seen.length <= 2) bare429(res);
    else ok200(res);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(), 0.98);
  const proxy = startProxy(am, upstreamPort, routed, {
    modelFallbacks: { [ADVISOR_MODEL]: [EXECUTOR_MODEL] },
    continuityMode: true,
    continuityMaxWaitMs: 500,
    continuityMaxSleepMs: 10,
    continuityJitterMs: 0,
    rateLimitFailovers: 1,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await postBody(proxyPort, advisorBody());
    await res.text();

    assert.equal(res.status, 200);
    assert.equal(seen.length, 3);
    assert.deepEqual(routed.slice(0, 2), ['A', 'B']);
    assert.ok(seen.length < 20);
    assert.ok(seen.every(body =>
      body.model === EXECUTOR_MODEL && body.tools[0].model === ADVISOR_MODEL));
    assert.ok(am.accounts.every(account => account.status === 'active'));
  } finally {
    proxy.close();
    upstream.close();
  }
});
