import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// An upstream SSE connection that dies MID-STREAM used to end the client's
// response silently truncated (or destroyed) — Claude Code surfaces that as
// "API Error: Connection closed mid-response" and fails the turn without
// retrying. With streamRecovery (default on, anthropic mode) the proxy relays
// whole SSE events only and converts an abnormal end into a well-formed
// retryable `overloaded_error` event, so the client retries by itself.

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

// Streaming-aware client: resolves with everything that arrived and HOW the
// response ended — cleanEnd (proper HTTP termination) vs a killed socket.
function streamPost(port, { onFirstData, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, res => {
      const chunks = [];
      let first = true;
      const settle = extra => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
        ...extra,
      });
      res.on('data', c => {
        chunks.push(c);
        if (first) { first = false; onFirstData?.(req, res); }
      });
      res.once('end', () => settle({ cleanEnd: true }));
      res.once('aborted', () => settle({ cleanEnd: false }));
      res.once('error', err => settle({ cleanEnd: false, error: err }));
    });
    req.once('error', reject);
    req.end(JSON.stringify(body ?? { model: 'claude-fable-5', messages: [{ role: 'user', content: 'hi' }] }));
  });
}

const sseBlocks = body => body.split('\n\n').filter(Boolean);
const lastErrorEvent = body => {
  const blocks = sseBlocks(body);
  const last = blocks[blocks.length - 1];
  if (!last?.startsWith('event: error')) return null;
  return JSON.parse(last.split('\n').find(l => l.startsWith('data: ')).slice(6));
};

test('mid-event socket kill → complete events + injected retryable error, clean end', async () => {
  let requests = 0;
  const upstream = http.createServer((req, res) => {
    requests += 1;
    if (requests > 1) { // follow-up request proves the proxy stayed healthy
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"partial answer"}}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_bl'); // cut mid-event
    setTimeout(() => res.socket.destroy(), 30);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(2), 0.98);
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy);

  try {
    const r = await streamPost(proxyPort);
    assert.equal(r.status, 200);
    assert.equal(r.cleanEnd, true, 'response must END cleanly, not die with the socket');

    const blocks = sseBlocks(r.body);
    assert.equal(blocks.length, 3, `whole events + injected error only, got:\n${r.body}`);
    assert.ok(blocks[0].includes('message_start'));
    assert.ok(blocks[1].includes('"partial answer"'));
    assert.ok(!r.body.includes('"type":"content_bl\n'), 'the cut-off partial event must never reach the client');

    const injected = lastErrorEvent(r.body);
    assert.equal(injected?.type, 'error');
    assert.equal(injected?.error?.type, 'overloaded_error', 'injected error must be client-retryable');

    // A mid-stream network death is not the account's fault.
    assert.ok(am.accounts.every(a => a.status === 'active'), 'no account may be poisoned');

    // The proxy itself must remain fully serviceable (the client will retry).
    const again = await streamPost(proxyPort);
    assert.equal(again.status, 200);
    assert.equal(JSON.parse(again.body).ok, true);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('continuity mode discards a broken partial SSE attempt and returns one complete retry', async () => {
  const complete = 'event: message_start\ndata: {"type":"message_start"}\n\n'
    + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"complete answer"}}\n\n'
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  let requests = 0;
  const upstream = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests === 1) {
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"broken partial"}}\n\n');
      setTimeout(() => res.socket.destroy(), 20);
      return;
    }
    res.end(complete);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(2), 0.98);
  const proxy = startProxy(am, upstreamPort, { continuityMode: true });
  const proxyPort = await listen(proxy);

  try {
    const r = await streamPost(proxyPort);
    assert.equal(r.status, 200);
    assert.equal(r.cleanEnd, true);
    assert.equal(r.body, complete, 'client must receive only the successful transactional attempt');
    assert.ok(!r.body.includes('broken partial'));
    assert.ok(!r.body.includes('overloaded_error'));
    assert.equal(requests, 2);
    assert.ok(am.accounts.every(a => a.status === 'active'));
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('continuity mode retries a broken SSE on the same account after fleet backoff', async () => {
  const previousBase = process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS;
  const previousCap = process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS;
  process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS = '10';
  process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS = '10';

  const complete = 'event: message_start\ndata: {"type":"message_start"}\n\n'
    + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"recovered"}}\n\n'
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  let requests = 0;
  const upstream = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests < 3) {
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"discard me"}}\n\n');
      setTimeout(() => res.socket.destroy(), 10);
      return;
    }
    res.end(complete);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(1), 0.98);
  const proxy = startProxy(am, upstreamPort, { continuityMode: true });
  const proxyPort = await listen(proxy);

  try {
    const r = await streamPost(proxyPort);
    assert.equal(r.status, 200);
    assert.equal(r.cleanEnd, true);
    assert.equal(r.body, complete);
    assert.ok(!r.body.includes('discard me'));
    assert.ok(!r.body.includes('overloaded_error'));
    assert.equal(requests, 3);
  } finally {
    proxy.close();
    upstream.close();
    if (previousBase === undefined) delete process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS;
    else process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS = previousBase;
    if (previousCap === undefined) delete process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS;
    else process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS = previousCap;
  }
});

test('continuity mode bounds persistent pre-stream SSE failures', async () => {
  const previousRetries = process.env.TEAMCLAUDE_OVERLOAD_RETRIES;
  const previousBase = process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS;
  const previousCap = process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS;
  process.env.TEAMCLAUDE_OVERLOAD_RETRIES = '2';
  process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS = '10';
  process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS = '10';

  let requests = 0;
  const upstream = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    setTimeout(() => res.socket.destroy(), 5);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(1), 0.98);
  const proxy = startProxy(am, upstreamPort, { continuityMode: true });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
      signal: AbortSignal.timeout(1000),
    });
    await res.text();
    assert.equal(res.status, 529);
    assert.equal(requests, 3, 'one initial stream plus two continuity retries');
    assert.equal(am.accounts[0].inflight, 0, 'the bounded request must release its account slot');
  } finally {
    proxy.close();
    upstream.close();
    if (previousRetries === undefined) delete process.env.TEAMCLAUDE_OVERLOAD_RETRIES;
    else process.env.TEAMCLAUDE_OVERLOAD_RETRIES = previousRetries;
    if (previousBase === undefined) delete process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS;
    else process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS = previousBase;
    if (previousCap === undefined) delete process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS;
    else process.env.TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS = previousCap;
  }
});

test('upstream ends cleanly WITHOUT message_stop → truncation detected, error injected', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    res.end(); // silent truncation: no terminal event, but a "clean" HTTP end
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(1), 0.98);
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy);

  try {
    const r = await streamPost(proxyPort);
    assert.equal(r.cleanEnd, true);
    const blocks = sseBlocks(r.body);
    assert.equal(blocks.length, 2);
    assert.equal(lastErrorEvent(r.body)?.error?.type, 'overloaded_error');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('complete stream passes through byte-identically (odd chunk boundaries) and usage still parses', async () => {
  const full = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":2}}}\n\n'
    + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"안녕하세요"}}\n\n'
    + 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n'
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const upstream = http.createServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const bytes = Buffer.from(full, 'utf8');
    for (let i = 0; i < bytes.length; i += 17) { // deliberately misaligned slices
      res.write(bytes.subarray(i, Math.min(i + 17, bytes.length)));
      await delay(1);
    }
    res.end();
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(1), 0.98);
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy);

  try {
    const r = await streamPost(proxyPort);
    assert.equal(r.cleanEnd, true);
    assert.equal(r.body, full, 'byte fidelity: nothing injected, nothing reordered, nothing lost');
    const usage = am.accounts[0].usage;
    assert.equal(usage.totalInputTokens, 7, 'input + cache tokens folded');
    assert.equal(usage.totalOutputTokens, 7);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('continuity mode spills a large complete SSE transaction and preserves byte fidelity', async () => {
  const largeText = 'x'.repeat(1_100_000);
  const full = 'event: message_start\ndata: {"type":"message_start"}\n\n'
    + `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"${largeText}"}}\n\n`
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(full);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(1), 0.98);
  const proxy = startProxy(am, upstreamPort, { continuityMode: true });
  const proxyPort = await listen(proxy);

  try {
    const r = await streamPost(proxyPort);
    assert.equal(r.cleanEnd, true);
    assert.equal(r.body, full);
    assert.ok(!r.body.includes('overloaded_error'));
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('transactional SSE rejects a response above the configured spool ceiling', async () => {
  const largeText = 'x'.repeat(4096);
  const full = 'event: message_start\ndata: {"type":"message_start"}\n\n'
    + `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"${largeText}"}}\n\n`
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(full);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(1), 0.98);
  const proxy = startProxy(am, upstreamPort, {
    continuityMode: true,
    maxResponseBytes: 1024,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
      signal: AbortSignal.timeout(1000),
    });
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.equal(body.error?.type, 'proxy_error');
    assert.equal(am.accounts[0].inflight, 0, 'the rejected stream must release its account slot');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('death right after headers (only a comment frame flushed) → sole injected error event', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': stream open\n\n'); // headers + comment out, then die before any event
    setTimeout(() => res.socket.destroy(), 30);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(1), 0.98);
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy);

  try {
    const r = await streamPost(proxyPort);
    assert.equal(r.cleanEnd, true);
    assert.equal(lastErrorEvent(r.body)?.error?.type, 'overloaded_error');
    assert.equal(am.accounts[0].status, 'active');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('SSE death before ANY frame → transparent failover: client sees one clean complete stream', async () => {
  const full = 'event: message_start\ndata: {"type":"message_start"}\n\n'
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  let hits = 0;
  const upstream = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (hits === 1) {
      res.flushHeaders?.();
      setTimeout(() => res.socket.destroy(), 30); // die before producing any frame
      return;
    }
    res.end(full);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(2), 0.98);
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy);

  try {
    const r = await streamPost(proxyPort);
    assert.equal(r.status, 200);
    assert.equal(r.cleanEnd, true);
    assert.equal(r.body, full, 'the client must see ONE clean stream from the second account');
    assert.ok(!r.body.includes('overloaded_error'), 'transparent replay — no client-visible error');
    assert.equal(hits, 2);
    assert.ok(am.accounts.every(a => a.status === 'active'));
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('SSE death before ANY frame with no alternate account → proper retryable HTTP 529', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders?.();
    setTimeout(() => res.socket.destroy(), 30);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(1), 0.98);
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy);

  try {
    const r = await streamPost(proxyPort);
    assert.equal(r.status, 529, 'headers were never sent, so a real HTTP retry signal is possible');
    assert.equal(r.cleanEnd, true);
    assert.equal(JSON.parse(r.body).error.type, 'overloaded_error');
    assert.equal(am.accounts[0].status, 'active');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('non-SSE body death mid-read now fails over to another account (headers not yet sent)', async () => {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    hits.push(req.headers['authorization'] || '');
    if (hits.length === 1) {
      // Claim a longer body than we send, then kill: the proxy's body read fails.
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
      res.write('{"partial":');
      setTimeout(() => res.socket.destroy(), 20);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(2), 0.98);
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy);

  try {
    const r = await streamPost(proxyPort);
    assert.equal(r.status, 200);
    assert.equal(r.cleanEnd, true);
    assert.equal(JSON.parse(r.body).ok, true, 'the second account must serve the response');
    assert.equal(hits.length, 2);
    assert.ok(am.accounts.every(a => a.status === 'active'), 'a body-read blip must not poison the account');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('non-SSE response above maxResponseBytes returns 502 without poisoning the account', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: 'x'.repeat(4096) }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(1), 0.98);
  const proxy = startProxy(am, upstreamPort, { maxResponseBytes: 1024 });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.equal(body.error?.type, 'proxy_error');
    assert.equal(am.accounts[0].status, 'active');
    assert.equal(am.accounts[0].inflight, 0, 'the rejected response must release its account slot');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('client disconnect mid-stream: upstream reader cancelled, slot released, no injection crash', async () => {
  let firstRes = null;
  let upstreamClosed = false;
  let requests = 0;
  const upstream = http.createServer((req, res) => {
    requests += 1;
    if (requests > 1) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    firstRes = res;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    const timer = setInterval(() => {
      if (!res.destroyed) res.write('event: ping\ndata: {"type":"ping"}\n\n');
    }, 5);
    res.once('close', () => { upstreamClosed = true; clearInterval(timer); });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(1), 0.98);
  const proxy = startProxy(am, upstreamPort);
  const proxyPort = await listen(proxy);

  try {
    const r = await streamPost(proxyPort, { onFirstData: req => req.destroy() });
    assert.equal(r.cleanEnd, false, 'the CLIENT hung up — nothing to end cleanly');

    // The upstream read must be cancelled and the concurrency slot released.
    const deadline = Date.now() + 3000;
    while ((!upstreamClosed || am.accounts[0].inflight > 0) && Date.now() < deadline) await delay(10);
    assert.equal(upstreamClosed, true, 'upstream stream must be cancelled when the client leaves');
    assert.equal(am.accounts[0].inflight, 0, 'slot must be released');

    const again = await streamPost(proxyPort);
    assert.equal(JSON.parse(again.body).ok, true);
  } finally {
    if (firstRes && !firstRes.destroyed) firstRes.destroy();
    proxy.close();
    upstream.close();
  }
});

test('client disconnect during a buffered continuity stream cancels upstream and releases the slot', async () => {
  let upstreamStarted = false;
  let upstreamClosed = false;
  const upstream = http.createServer((_req, res) => {
    upstreamStarted = true;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    const timer = setInterval(() => {
      if (!res.destroyed) {
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"waiting"}}\n\n');
      }
    }, 5);
    res.once('close', () => {
      upstreamClosed = true;
      clearInterval(timer);
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(1), 0.98, 0, 1);
  const proxy = startProxy(am, upstreamPort, { continuityMode: true });
  const proxyPort = await listen(proxy);
  const ac = new AbortController();

  try {
    const request = fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-fable-5', messages: [] }),
      signal: ac.signal,
    }).catch(() => null);
    const startedDeadline = Date.now() + 2000;
    while ((!upstreamStarted || am.accounts[0].inflight !== 1) && Date.now() < startedDeadline) {
      await delay(5);
    }
    assert.equal(upstreamStarted, true);
    assert.equal(am.accounts[0].inflight, 1);

    ac.abort();
    await request;
    const closedDeadline = Date.now() + 2000;
    while ((!upstreamClosed || am.accounts[0].inflight !== 0) && Date.now() < closedDeadline) {
      await delay(5);
    }
    assert.equal(upstreamClosed, true);
    assert.equal(am.accounts[0].inflight, 0);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('streamRecovery: false keeps the legacy passthrough (no injection, partial bytes relayed)', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_bl'); // cut mid-event
    setTimeout(() => res.socket.destroy(), 30);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(makeAccounts(1), 0.98);
  const proxy = startProxy(am, upstreamPort, { streamRecovery: false });
  const proxyPort = await listen(proxy);

  try {
    const r = await streamPost(proxyPort);
    assert.ok(!r.body.includes('overloaded_error'), 'opt-out must not inject');
    assert.ok(r.body.endsWith('content_bl'), 'legacy mode relays raw bytes as they came');
    assert.equal(r.cleanEnd, true,
      'legacy truncation ends with the graceful FIN the pre-change code produced (no destroy-after-end RST)');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('codex provider keeps the legacy passthrough (no anthropic-shaped injection)', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.output_text.delta\ndata: {"delta":"hi"}\n\n');
    res.write('data: {"partial');
    setTimeout(() => res.socket.destroy(), 30);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{
    name: 'codex-pro',
    provider: 'codex',
    type: 'oauth',
    accessToken: 'pooled-access-token',
    refreshToken: 'refresh-token',
    accountId: 'workspace-123',
    accountUuid: 'workspace-123',
    expiresAt: Date.now() + 3_600_000,
  }]);
  const proxy = createProxyServer(am, {
    provider: 'codex',
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: proxyPort, path: '/codex/responses', method: 'POST',
        headers: { 'content-type': 'application/json' },
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        const settle = cleanEnd => () => resolve({ body: Buffer.concat(chunks).toString(), cleanEnd });
        res.once('end', settle(true));
        res.once('aborted', settle(false));
        res.once('error', settle(false));
      });
      req.once('error', reject);
      req.end(JSON.stringify({ model: 'gpt-5.6', input: 'hi' }));
    });
    assert.ok(!r.body.includes('overloaded_error'), 'codex mode must not receive anthropic-shaped errors');
    assert.ok(r.body.endsWith('{"partial'), 'codex mode relays raw bytes untouched');
  } finally {
    proxy.close();
    upstream.close();
  }
});
