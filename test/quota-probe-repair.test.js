import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { CLAUDE_CODE_SYSTEM_MARKER } from '../src/byok.js';

const HOUR = 3600_000;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function recordingUpstream(seen) {
  return http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    seen.push({ length: req.headers['content-length'], body: raw });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
}

async function withProxy(fn) {
  const seen = [];
  const upstream = recordingUpstream(seen);
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{
    name: 'a0', type: 'oauth', accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + HOUR,
  }], 0.98, 0, 3);
  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}`, warmupIntervalMs: 0 });
  const port = await listen(proxy);
  try {
    await fn({ port, seen, proxy });
  } finally {
    proxy.close();
    upstream.close();
  }
}

function post(port, body, userAgent = 'claude-cli/2.1.300 (external, cli)') {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'user-agent': userAgent },
    body: JSON.stringify(body),
  });
}

const QUOTA_CHECK = { model: 'claude-x', max_tokens: 1, messages: [{ role: 'user', content: 'quota' }] };

// Claude Code's background quota_check omits the system marker an OAuth
// request needs; upstream rejects it. The proxy repairs that exact probe only.
test('the Claude Code quota_check probe gets the system marker it omits', async () => {
  await withProxy(async ({ port, seen, proxy }) => {
    const r = await post(port, QUOTA_CHECK);
    assert.equal(r.status, 200);
    assert.equal(seen.length, 1);
    const sent = JSON.parse(seen[0].body);
    assert.equal(sent.system, CLAUDE_CODE_SYSTEM_MARKER);
    assert.deepEqual(sent.messages, QUOTA_CHECK.messages);
    assert.equal(Number(seen[0].length), Buffer.byteLength(seen[0].body), 'content-length follows the rewritten body');
    assert.equal(proxy.exportProbeTemplate(), null, 'a repaired probe never seeds the warm-up template');
  });
});

test('quota_check repair is scoped to the exact CLI probe shape', async () => {
  const variants = [
    { body: QUOTA_CHECK, ua: 'curl/8' },
    { body: { ...QUOTA_CHECK, system: 'mine' }, ua: undefined },
    { body: { ...QUOTA_CHECK, max_tokens: 2 }, ua: undefined },
    { body: { ...QUOTA_CHECK, stream: true }, ua: undefined },
    { body: { ...QUOTA_CHECK, messages: [{ role: 'user', content: 'hello' }] }, ua: undefined },
  ];
  for (const { body, ua } of variants) {
    await withProxy(async ({ port, seen }) => {
      await post(port, body, ua);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].body, JSON.stringify(body), `untouched: ${JSON.stringify(body)} ua=${ua}`);
    });
  }
});
