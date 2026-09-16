// After an upstream failure is passed through WITHOUT replay (the "no hidden
// duplicate execution" invariant, see server-529.test.js), the client retries by
// itself — Codex CLI reconnects up to 5 times. Before this change every one of
// those retries landed on the same account: connection affinity pinned the
// socket and the sticky primary pinned new sockets, so an account-specific
// upstream fault produced five identical failures ("stream disconnected before
// completion … request ID …", 2026-09-16). These tests pin the steer-away:
// the failing account is softly avoided for `upstreamFailureAvoidMs` and the
// connection's affinity is dropped, so the very next request on the SAME
// keep-alive socket is served by another account — while the pass-through
// itself (no replay, no poisoning) is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const HOUR = 3600_000;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closeAll(...servers) {
  for (const s of servers) {
    try { s.closeAllConnections?.(); s.close(); } catch { /* already closed */ }
  }
}

function accounts(extra = {}) {
  return ['a', 'b'].map(n => ({
    name: n,
    type: 'oauth',
    accessToken: `tok-${n}`,
    refreshToken: 'r',
    expiresAt: Date.now() + HOUR,
    ...extra,
  }));
}

// Mark every account measured with `a` strictly preferred (soonest weekly
// reset). Without this, cold-start warm-up round-robins the two requests across
// the accounts by itself and would mask what the test is about.
function measure(am) {
  const now = Date.now();
  am.accounts.forEach((acc, i) => {
    acc.quota.unified5h = 0.1;
    acc.quota.unified5hReset = now + HOUR;
    acc.quota.unified7d = 0.1;
    acc.quota.unified7dReset = now + (i + 1) * HOUR;
  });
  return am;
}

function tokenOf(req) {
  const auth = req.headers['authorization'] || '';
  return auth.replace(/^Bearer\s+/i, '');
}

// One keep-alive socket, requests issued strictly one after another — the
// shape of a CLI reconnect burst. Returns the response plus the local port so
// the test can prove both requests really shared the connection.
function keepAliveClient() {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const send = (port, path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({
      agent, host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
    }, res => {
      // Capture the port while the socket is still attached: on 'end' a
      // keep-alive agent has already detached it (res.socket === null).
      const localPort = res.socket?.localPort ?? null;
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        text: Buffer.concat(chunks).toString('utf8'),
        localPort,
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
  return { send, destroy: () => agent.destroy() };
}

test('anthropic: 503 after an unsafe POST is passed through unreplayed, and the same connection\'s retry lands on the other account', async () => {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    const tok = tokenOf(req);
    hits.push(tok);
    if (tok === 'tok-a') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'server_overloaded', message: 'at capacity' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, served_by: tok }));
  });
  const upstreamPort = await listen(upstream);
  const am = measure(new AccountManager(accounts(), 0.98));
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}`, activeWarmup: false,
  });
  const proxyPort = await listen(proxy);
  const client = keepAliveClient();
  try {
    const body = JSON.stringify({ model: 'x', messages: [] });
    const first = await client.send(proxyPort, '/v1/messages', body);
    assert.equal(first.status, 503, 'the unsafe POST is surfaced, not replayed');
    assert.deepEqual(hits, ['tok-a'], 'exactly one upstream attempt — no hidden replay');
    assert.equal(am.accounts[0].status, 'active', 'no poisoning');

    const retry = await client.send(proxyPort, '/v1/messages', body);
    assert.equal(retry.localPort, first.localPort, 'the retry reused the keep-alive socket (affinity key)');
    assert.equal(retry.status, 200);
    assert.deepEqual(hits, ['tok-a', 'tok-b'], 'the client retry is steered to the other account');
    assert.equal(JSON.parse(retry.text).served_by, 'tok-b');
  } finally {
    client.destroy();
    closeAll(proxy, upstream);
  }
});

test('codex: an upstream in-stream error terminal is relayed verbatim, and the reconnect on the same socket is served by the other account', async () => {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    const tok = tokenOf(req);
    hits.push(tok);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created"}\n\n');
    if (tok === 'tok-a') {
      // The Codex backend's own failure shape: the stream ends with an error event.
      res.end('event: error\ndata: {"type":"error","message":"An error occurred while processing your request. Please include the request ID 7339907b in your message."}\n\n');
      return;
    }
    res.end('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
  });
  const upstreamPort = await listen(upstream);
  const am = measure(new AccountManager(accounts({ provider: 'codex', accountId: 'ws-1' }), 0.98));
  const proxy = createProxyServer(am, {
    provider: 'codex', upstream: `http://127.0.0.1:${upstreamPort}`, activeWarmup: false, codexUsageRefresh: false,
  });
  const proxyPort = await listen(proxy);
  const client = keepAliveClient();
  try {
    const body = JSON.stringify({ model: 'gpt-5', stream: true, input: [] });
    const headers = { accept: 'text/event-stream' };
    const first = await client.send(proxyPort, '/codex/responses', body, headers);
    assert.equal(first.status, 200);
    assert.match(first.text, /request ID 7339907b/, 'the upstream error event reaches the client untouched');
    assert.deepEqual(hits, ['tok-a'], 'nothing is replayed inside the proxy');
    assert.equal(am.accounts[0].status, 'active', 'no poisoning');

    const retry = await client.send(proxyPort, '/codex/responses', body, headers);
    assert.equal(retry.localPort, first.localPort, 'the reconnect reused the keep-alive socket');
    assert.equal(retry.status, 200);
    assert.match(retry.text, /response\.completed/);
    assert.deepEqual(hits, ['tok-a', 'tok-b'], 'the reconnect is steered away from the failing account');
  } finally {
    client.destroy();
    closeAll(proxy, upstream);
  }
});

test('codex: a single-account pool keeps serving the retry on its only account (never "no account")', async () => {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    hits.push(tokenOf(req));
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'server_overloaded' } }));
  });
  const upstreamPort = await listen(upstream);
  const am = measure(new AccountManager(accounts({ provider: 'codex', accountId: 'ws-1' }).slice(0, 1), 0.98));
  const proxy = createProxyServer(am, {
    provider: 'codex', upstream: `http://127.0.0.1:${upstreamPort}`, activeWarmup: false, codexUsageRefresh: false,
  });
  const proxyPort = await listen(proxy);
  const client = keepAliveClient();
  try {
    const body = JSON.stringify({ model: 'gpt-5', stream: true, input: [] });
    const first = await client.send(proxyPort, '/codex/responses', body);
    const retry = await client.send(proxyPort, '/codex/responses', body);
    assert.equal(first.status, 503);
    assert.equal(retry.status, 503, 'soft avoidance falls back to the only account instead of a proxy-side 429');
    assert.deepEqual(hits, ['tok-a', 'tok-a']);
    assert.equal(am.accounts[0].inflight, 0, 'slots are released');
  } finally {
    client.destroy();
    closeAll(proxy, upstream);
  }
});

test('upstreamFailureAvoidMs: 0 disables steering (retry sticks to the same account as before)', async () => {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    hits.push(tokenOf(req));
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const am = measure(new AccountManager(accounts(), 0.98));
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}`, activeWarmup: false, upstreamFailureAvoidMs: 0,
  });
  const proxyPort = await listen(proxy);
  const client = keepAliveClient();
  try {
    const body = JSON.stringify({ model: 'x', messages: [] });
    await client.send(proxyPort, '/v1/messages', body);
    await client.send(proxyPort, '/v1/messages', body);
    assert.deepEqual(hits, ['tok-a', 'tok-a'], 'legacy behavior when the knob is off');
  } finally {
    client.destroy();
    closeAll(proxy, upstream);
  }
});
