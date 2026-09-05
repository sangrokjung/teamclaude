import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { CLAUDE_CODE_SYSTEM_MARKER } from '../src/byok.js';

// The BYOK surface (config.byok) normalizes a third-party client's request for
// upstream. The invariant that matters more than the feature: traffic on the
// existing paths must be untouched, byte for byte, because a changed `system`
// block changes the prompt-cache key for every Claude Code session.

const BYOK_KEY = 'byok-test-secret-0123456789';

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

function byokEnabled(extra = {}) {
  return { byok: { enabled: true, apiKey: BYOK_KEY, minUsableAccounts: 0, ...extra } };
}

// Sends the path verbatim (no client-side dot-segment resolution).
function rawRequest(port, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

// An upstream that records every request it sees and answers 200.
function recordingUpstream(seen, respond) {
  return http.createServer(async (req, res) => {
    seen.push({ url: req.url, headers: { ...req.headers }, body: await readRawBody(req) });
    if (respond) return respond(res, seen.length);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
}

async function withProxy(t, { accounts = 1, overrides = {}, respond = null } = {}) {
  const seen = [];
  const upstream = recordingUpstream(seen, respond);
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(accounts), 0.98);
  const proxy = startProxy(am, upstreamPort, overrides);
  const port = await listen(proxy);
  t.after(() => new Promise(r => proxy.close(r)));
  t.after(() => new Promise(r => upstream.close(r)));
  return { seen, port };
}

// macOS has no spare loopback alias to bind (127.0.0.2 is EADDRNOTAVAIL), so the
// non-local branch is exercised by invoking the server's request listener with a
// synthetic socket. This is the only way to cover a path that a loopback client
// can never reach — and it is the path the supervisor's own auth would guard in
// production.
function dispatchWithRemoteAddress(server, { url, method = 'POST', headers = {}, remoteAddress }) {
  const handler = server.listeners('request')[0];
  const req = new Readable({ read() { this.push(null); } });
  req.url = url;
  req.method = method;
  req.headers = { 'content-type': 'application/json', ...headers };
  req.socket = { remoteAddress };

  const res = new EventEmitter();
  res.headersSent = false;
  res.destroyed = false;
  res.statusCode = null;
  res.headers = null;
  res.body = null;
  res.writeHead = (code, sent) => {
    res.statusCode = code;
    res.headers = sent;
    res.headersSent = true;
    return res;
  };
  res.end = (payload) => {
    res.body = payload ?? null;
    res.emit('finish');
    return res;
  };
  return Promise.resolve(handler(req, res)).then(() => res, () => res);
}

// --- C1/C2: existing traffic is untouched ----------------------------------

test('a claude code request is forwarded byte-identical while byok is enabled', async (t) => {
  const { seen, port } = await withProxy(t, { overrides: byokEnabled() });
  const payload = JSON.stringify({
    model: 'claude-sonnet-5',
    system: [{ type: 'text', text: 'existing preamble' }],
    messages: [{ role: 'user', content: 'hi' }],
  });

  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://example.com' },
    body: payload,
  });

  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/v1/messages');
  assert.equal(seen[0].body.toString(), payload, 'body bytes must be unchanged');
  assert.equal(seen[0].headers.origin, 'https://example.com', 'non-byok headers are untouched');
  assert.equal(JSON.parse(seen[0].body.toString()).system.length, 1, 'no marker injected');
});

test('the byok path is inert when the config is absent', async (t) => {
  const { seen, port } = await withProxy(t);
  const res = await fetch(`http://127.0.0.1:${port}/byok/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', messages: [] }),
  });
  assert.equal(res.status, 200);
  assert.equal(seen[0].url, '/byok/v1/messages', 'path is forwarded verbatim, not canonicalized');
  assert.equal(JSON.parse(seen[0].body.toString()).system, undefined);
});

test('byok stays disabled when enabled without an api key', async (t) => {
  const { seen, port } = await withProxy(t, {
    overrides: { byok: { enabled: true } },
  });
  const res = await fetch(`http://127.0.0.1:${port}/byok/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [] }),
  });
  assert.equal(res.status, 200);
  assert.equal(seen[0].url, '/byok/v1/messages');
});

// --- the surface itself ----------------------------------------------------

test('a byok request is canonicalized, marker-injected, and origin-scrubbed', async (t) => {
  const { seen, port } = await withProxy(t, { overrides: byokEnabled() });
  const res = await fetch(`http://127.0.0.1:${port}/byok/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': BYOK_KEY,
      origin: 'https://app.example.com',
      referer: 'https://app.example.com/chat',
    },
    body: JSON.stringify({ model: 'claude-sonnet-5', system: 'You are Aside.', messages: [] }),
  });

  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/v1/messages');
  assert.equal(seen[0].headers.origin, undefined);
  assert.equal(seen[0].headers.referer, undefined);
  const body = JSON.parse(seen[0].body.toString());
  assert.ok(body.system.startsWith(CLAUDE_CODE_SYSTEM_MARKER));
  assert.ok(body.system.includes('You are Aside.'));
  assert.equal(seen[0].headers['content-length'], String(seen[0].body.length));
});

test('a byok request without the byok key is rejected', async (t) => {
  const { seen, port } = await withProxy(t, { overrides: byokEnabled() });
  const res = await fetch(`http://127.0.0.1:${port}/byok/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [] }),
  });
  assert.equal(res.status, 401);
  assert.equal(seen.length, 0, 'upstream must never see an unauthenticated byok request');
});

test('the byok surface answers preflight locally and hides the control plane', async (t) => {
  const { seen, port } = await withProxy(t, { overrides: byokEnabled() });

  const preflight = await fetch(`http://127.0.0.1:${port}/byok/v1/messages`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.ok(preflight.headers.get('access-control-allow-headers'));

  const status = await fetch(`http://127.0.0.1:${port}/byok/teamclaude/status`, {
    headers: { 'x-api-key': BYOK_KEY },
  });
  assert.equal(status.status, 404);
  assert.equal(seen.length, 0);
});

test('byok yields while the pool is below its usable-account floor', async (t) => {
  const { seen, port } = await withProxy(t, {
    overrides: byokEnabled({ minUsableAccounts: 99 }),
  });
  const res = await fetch(`http://127.0.0.1:${port}/byok/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': BYOK_KEY },
    body: JSON.stringify({ model: 'm', messages: [] }),
  });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) >= 1);
  assert.equal(seen.length, 0, 'a paused byok request must not spend upstream quota');
});

test('the byok surface is local-only', async (t) => {
  const seen = [];
  const upstream = recordingUpstream(seen, null);
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(1), 0.98);
  const proxy = startProxy(am, upstreamPort, byokEnabled());
  t.after(() => new Promise(r => upstream.close(r)));

  const res = await dispatchWithRemoteAddress(proxy, {
    url: '/byok/v1/messages',
    headers: { 'x-api-key': BYOK_KEY },
    remoteAddress: '203.0.113.5',
  });

  assert.equal(res.statusCode, 403);
  assert.match(String(res.body), /local-only/);
  assert.equal(seen.length, 0);
});

test('a remote request on the normal path still needs the proxy key', async (t) => {
  const seen = [];
  const upstream = recordingUpstream(seen, null);
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(1), 0.98);
  const proxy = startProxy(am, upstreamPort, byokEnabled());
  t.after(() => new Promise(r => upstream.close(r)));

  const res = await dispatchWithRemoteAddress(proxy, {
    url: '/v1/messages',
    headers: { 'x-api-key': BYOK_KEY },
    remoteAddress: '203.0.113.5',
  });

  assert.equal(res.statusCode, 401, 'the byok key must not authenticate the normal path');
  assert.equal(seen.length, 0);
});

test('the byok surface refuses the oauth relay and dot-segment paths', async (t) => {
  const { seen, port } = await withProxy(t, { overrides: byokEnabled() });

  const oauth = await fetch(`http://127.0.0.1:${port}/byok/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': BYOK_KEY },
    body: JSON.stringify({ grant_type: 'refresh_token' }),
  });
  assert.equal(oauth.status, 404, 'the oauth relay would skip the header scrub');

  // fetch() resolves dot-segments client-side, so the literal path has to be
  // put on the wire by hand — which is exactly what a hostile client would do.
  const traversal = await rawRequest(port, '/byok/../teamclaude/rotate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': BYOK_KEY },
    body: '{}',
  });
  assert.equal(traversal.status, 404);

  const encoded = await rawRequest(port, '/byok/%2e%2e/teamclaude/rotate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': BYOK_KEY },
    body: '{}',
  });
  assert.equal(encoded.status, 404);

  const queryDodge = await rawRequest(port, '/byok/v1/oauth/token?x=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': BYOK_KEY },
    body: '{}',
  });
  assert.equal(queryDodge.status, 404, 'a query string must not dodge the path checks');

  assert.equal(seen.length, 0, 'none of these may reach upstream');
});

// --- isolation from the claude code lane -----------------------------------

test('a byok response never becomes the fleet warm-up probe template', async (t) => {
  const { seen, port } = await withProxy(t, {
    accounts: 3,
    overrides: { ...byokEnabled(), activeWarmup: true },
  });

  const res = await fetch(`http://127.0.0.1:${port}/byok/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': BYOK_KEY },
    body: JSON.stringify({ model: 'claude-sonnet-5', messages: [] }),
  });
  assert.equal(res.status, 200);

  await new Promise(r => setTimeout(r, 200));
  assert.equal(seen.length, 1, 'committing a byok shape would fan probes out to the other accounts');
});

test('a byok 429 does not open the process-global cooldown', async (t) => {
  const { port } = await withProxy(t, {
    accounts: 1,
    overrides: { ...byokEnabled(), continuityMode: true },
    respond: (res) => {
      res.writeHead(429, { 'retry-after': '60', 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
    },
  });

  const startedAt = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/byok/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': BYOK_KEY },
    body: JSON.stringify({ model: 'claude-sonnet-5', messages: [] }),
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(res.status, 429);
  assert.ok(elapsed < 800, `byok must fall straight through, took ${elapsed}ms`);
});

test('status reports byok counters only while the surface is enabled', async (t) => {
  const { port } = await withProxy(t, { overrides: byokEnabled() });

  const off = await withProxy(t, {});
  const offStatus = await (await fetch(`http://127.0.0.1:${off.port}/teamclaude/status`)).json();
  assert.equal(offStatus.byok, null);

  await fetch(`http://127.0.0.1:${port}/byok/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': BYOK_KEY },
    body: JSON.stringify({ model: 'm', messages: [] }),
  });
  const onStatus = await (await fetch(`http://127.0.0.1:${port}/teamclaude/status`)).json();
  assert.equal(onStatus.byok.prefix, '/byok');
  assert.equal(onStatus.byok.admitted, 1);
  assert.equal(onStatus.byok.injected, 1);
  assert.equal(onStatus.byok.inflight, 0, 'the in-flight counter must return to zero');
});
