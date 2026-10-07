import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, isNewUserTurn } from '../src/server.js';

// Session reserve: once every usable account's 5-hour window is within
// `sessionReserve` of the switch threshold, the last slice of the fleet's
// session quota is kept for work already in progress. A request that starts a
// new turn (the last user message is typed text) is answered locally; a
// continuation (the last user message carries a tool_result) still flows, so
// an agent loop is never cut off mid-change.

const HOUR = 3600_000;

function makeAccounts(n, extra = {}) {
  return Array.from({ length: n }, (_, i) => ({
    name: `acct-${i}`,
    type: 'oauth',
    accessToken: `tok-${i}`,
    refreshToken: `r-${i}`,
    expiresAt: Date.now() + HOUR,
    ...extra,
  }));
}

function measure(am, account, u5h, r5h = Date.now() + HOUR, u7d = 0.3) {
  am.updateQuota(account, {
    'anthropic-ratelimit-unified-5h-utilization': String(u5h),
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor(r5h / 1000)),
    'anthropic-ratelimit-unified-7d-utilization': String(u7d),
    'anthropic-ratelimit-unified-7d-reset': String(Math.floor((Date.now() + 72 * HOUR) / 1000)),
    'anthropic-ratelimit-unified-status': 'allowed',
  });
}

test('isNewUserTurn: typed text starts a turn, a tool_result continues one', () => {
  const body = messages => Buffer.from(JSON.stringify({ model: 'm', messages }));
  assert.equal(isNewUserTurn(body([{ role: 'user', content: 'hi' }])), true);
  assert.equal(isNewUserTurn(body([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])), true);
  assert.equal(isNewUserTurn(body([
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
  ])), false);
  assert.equal(isNewUserTurn(Buffer.from('not json')), false, 'fail open');
  assert.equal(isNewUserTurn(body([])), false);
  assert.equal(isNewUserTurn(body([{ role: 'assistant', content: 'prefill' }])), false);
});

test('sessionReserveUntil: in reserve only when every usable account is inside it', () => {
  const am = new AccountManager(makeAccounts(2));
  const r0 = Date.now() + 2 * HOUR;
  const r1 = Date.now() + HOUR;
  measure(am, am.accounts[0], 0.95, r0);
  measure(am, am.accounts[1], 0.5, r1);
  assert.equal(am.sessionReserveUntil(0.05), null, 'one account still has headroom');
  measure(am, am.accounts[1], 0.94, r1);
  assert.equal(am.sessionReserveUntil(0.05), Math.floor(r1 / 1000) * 1000, 'soonest 5h reset');
  assert.equal(am.sessionReserveUntil(0), null, 'reserve 0 disables');
});

test('sessionReserveUntil: grace-only accounts count as in reserve; unmeasured ones as headroom', () => {
  const am = new AccountManager(makeAccounts(2));
  measure(am, am.accounts[0], 1);
  assert.equal(am.sessionReserveUntil(0.05), null, 'unmeasured account has headroom');
  measure(am, am.accounts[1], 0.99);
  assert.ok(am.sessionReserveUntil(0.05) > Date.now());
});

test('sessionReserveUntil: an unusable fleet is not a reserve decision', () => {
  const am = new AccountManager(makeAccounts(1));
  measure(am, am.accounts[0], 1, Date.now() + HOUR, 1); // weekly spent too
  assert.equal(am.sessionReserveUntil(0.05), null);
  const am2 = new AccountManager(makeAccounts(1, { provider: 'codex' }));
  measure(am2, am2.accounts[0], 0.97);
  assert.equal(am2.sessionReserveUntil(0.05), null, 'codex accounts are out of scope');
});

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function post(port, messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 1, messages });
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const NEW_TURN = [{ role: 'user', content: 'start something new' }];
const CONTINUATION = [
  { role: 'user', content: 'do it' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
];

async function withProxy(am, overrides, fn) {
  let hits = 0;
  const upstream = http.createServer((req, res) => {
    hits += 1;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    continuityMode: false,
    ...overrides,
  });
  const port = await listen(proxy);
  try {
    await fn(port, () => hits);
  } finally {
    proxy.close();
    upstream.close();
  }
}

test('in reserve: a new turn is answered locally with the reset time, a continuation is forwarded', async () => {
  const am = new AccountManager(makeAccounts(2));
  for (const a of am.accounts) measure(am, a, 0.95);
  await withProxy(am, {}, async (port, hits) => {
    const blocked = await post(port, NEW_TURN);
    assert.equal(blocked.status, 429);
    assert.equal(hits(), 0);
    const ra = Number(blocked.headers['retry-after']);
    assert.ok(ra > 3000 && ra <= 3600, `retry-after tracks the 5h reset, got ${ra}`);
    const err = JSON.parse(blocked.body);
    assert.equal(err.error.type, 'rate_limit_error');
    assert.match(err.error.message, /reserve/i);
    const cont = await post(port, CONTINUATION);
    assert.equal(cont.status, 200);
    assert.equal(hits(), 1);
  });
});

test('outside the reserve a new turn is forwarded', async () => {
  const am = new AccountManager(makeAccounts(2));
  measure(am, am.accounts[0], 0.95);
  measure(am, am.accounts[1], 0.5);
  await withProxy(am, {}, async (port, hits) => {
    assert.equal((await post(port, NEW_TURN)).status, 200);
    assert.equal(hits(), 1);
  });
});

test('sessionReserve: 0 turns the gate off', async () => {
  const am = new AccountManager(makeAccounts(1));
  measure(am, am.accounts[0], 0.95);
  await withProxy(am, { sessionReserve: 0 }, async (port, hits) => {
    assert.equal((await post(port, NEW_TURN)).status, 200);
    assert.equal(hits(), 1);
  });
});
