import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const template = { model: 'claude-fable-5', version: '2023-06-01' };
const headers = value => ({
  'content-type': 'application/json',
  'anthropic-ratelimit-unified-status': value >= 1 ? 'rejected' : 'allowed',
  ...Object.fromEntries(['5h', '7d', '7d_oi'].flatMap(window => [
    [`anthropic-ratelimit-unified-${window}-utilization`, String(value)],
    [`anthropic-ratelimit-unified-${window}-reset`, String(Math.floor(Date.now() / 1000) + 3600)],
  ])),
});
async function waitFor(predicate) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await delay(10); }
  assert.ok(predicate(), 'expected state was not observed');
}
async function fixture(t, { count = 1, response = 0, config = {} } = {}) {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(response >= 1 ? 429 : 200, headers(response));
    res.end('{"ok":true}');
  });
  const port = await listen(upstream);
  const manager = new AccountManager(Array.from({ length: count }, (_, i) => ({
    name: `fixture-${i}`, type: 'oauth', accessToken: `fixture-token-${i}`,
    expiresAt: Date.now() + 3600000,
  })));
  for (const account of manager.accounts) manager.updateQuota(account, headers(1));
  const proxy = createProxyServer(manager, {
    upstream: `http://127.0.0.1:${port}`, warmupIntervalMs: 20, subscriptionRecheckIntervalMs: 0, ...config,
  });
  const proxyPort = await listen(proxy);
  t.after(() => Promise.all([close(proxy), close(upstream)]));
  return { manager, proxy, proxyPort, seen };
}

test('web reset: a complete future snapshot recovers on template restoration', async t => {
  const { manager, proxy, proxyPort, seen } = await fixture(t, { config: { warmupIntervalMs: 0 } });
  assert.equal(manager.getStatus().usableCount, 0);
  proxy.importProbeTemplate(template);
  await waitFor(() => manager.getStatus().usableCount === 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body.max_tokens, 1);
  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: template.model, max_tokens: 1, messages: [{ role: 'user', content: 'actual request' }] }),
  });
  assert.equal(response.status, 200);
  await response.text();
});

test('web reset: periodic recheck recovers a later reset without restarting', async t => {
  const { manager, proxy, seen } = await fixture(t);
  manager.updateQuota(0, headers(0));
  proxy.importProbeTemplate(template);
  await delay(40);
  assert.equal(seen.length, 0);
  manager.updateQuota(0, headers(1));
  await waitFor(() => manager.getStatus().usableCount === 1);
  assert.equal(seen.length, 1);
});

test('web reset: genuine exhaustion stays blocked and probes are paced', async t => {
  const { manager, proxy, seen } = await fixture(t, { response: 1.01 });
  proxy.importProbeTemplate(template);
  await waitFor(() => seen.length > 0);
  await delay(100);
  assert.equal(seen.length, 1);
  assert.equal(manager.getStatus().usableCount, 0);
  assert.equal(manager.accounts[0].quota.unified7d, 1);
});

test('web reset: model-scoped exhaustion is rechecked with the restored model template', async t => {
  const { manager, proxy, seen } = await fixture(t, { config: { warmupIntervalMs: 0 } });
  manager.updateQuota(0, headers(0));
  manager.accounts[0].quota.modelWeekly['7d_oi'] = {
    utilization: 1,
    reset: Date.now() + 3600_000,
  };
  proxy.importProbeTemplate(template);
  await waitFor(() => manager.accounts[0].quota.modelWeekly['7d_oi']?.utilization === 0);
  assert.equal(seen.length, 1);
});

test('web reset: a future account throttle is respected by stale-quota recheck', async t => {
  const { manager, proxy, seen } = await fixture(t, { config: { warmupIntervalMs: 0 } });
  manager.markRateLimited(0, 60);
  proxy.importProbeTemplate(template);
  await delay(100);
  assert.equal(seen.length, 0);
  assert.equal(manager.accounts[0].status, 'throttled');
});

test('web reset: stale quota recovers after the throttle expires', async t => {
  const { manager, proxy, seen } = await fixture(t);
  manager.markRateLimited(0, 60);
  proxy.importProbeTemplate(template);
  await delay(60);
  assert.equal(seen.length, 0);
  manager.accounts[0].rateLimitedUntil = Date.now() - 1;
  await waitFor(() => manager.getStatus().usableCount === 1);
  assert.equal(seen.length, 1);
});

test('web reset: unrelated model template does not probe a model-only limit', async t => {
  const { manager, proxy, seen } = await fixture(t);
  manager.updateQuota(0, headers(0));
  manager.accounts[0].quota.modelWeekly['7d_oi'] = {
    utilization: 1, reset: Date.now() + 3600_000,
  };
  proxy.importProbeTemplate({ ...template, model: 'claude-sonnet-5' });
  await delay(100);
  assert.equal(seen.length, 0);
  assert.equal(manager.isModelExhausted(0, template.model), true);
  assert.equal(manager.isModelExhausted(0, 'claude-sonnet-5'), false);
});

test('web reset: a lower-tier request cannot discard the restored Fable recheck template', async t => {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    seen.push(parsed.model);
    const h = headers(0);
    if (parsed.model === 'claude-sonnet-5') {
      delete h['anthropic-ratelimit-unified-7d_oi-utilization'];
      delete h['anthropic-ratelimit-unified-7d_oi-reset'];
    }
    res.writeHead(200, h);
    res.end('{"ok":true}');
  });
  const port = await listen(upstream);
  const manager = new AccountManager([{ name: 'fixture-0', type: 'oauth', accessToken: 'token', expiresAt: Date.now() + 3600000 }]);
  manager.updateQuota(0, headers(0));
  const proxy = createProxyServer(manager, { upstream: `http://127.0.0.1:${port}`, warmupIntervalMs: 20 });
  const proxyPort = await listen(proxy);
  t.after(() => Promise.all([close(proxy), close(upstream)]));
  proxy.importProbeTemplate(template);
  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 1, messages: [{ role: 'user', content: 'lower tier' }] }),
  });
  await response.text();
  manager.accounts[0].quota.modelWeekly['7d_oi'] = { utilization: 1, reset: Date.now() + 3600000 };
  await waitFor(() => seen.filter(model => model === template.model).length >= 1);
  assert.equal(seen[0], 'claude-sonnet-5');
  assert.equal(seen.at(-1), template.model);
  assert.equal(proxy.exportProbeTemplate().model, 'claude-sonnet-5');
  assert.equal(proxy.exportProbeTemplate()._staleRecheckTemplate.model, template.model);
});

test('web reset: disabled, errored, busy, revoked and expired accounts are not probed', async t => {
  const { manager, proxy, seen } = await fixture(t, { count: 6 });
  Object.assign(manager.accounts[0], { enabled: false });
  Object.assign(manager.accounts[1], { status: 'error' });
  Object.assign(manager.accounts[2], { inflight: 1 });
  Object.assign(manager.accounts[3], { authRevoked: true });
  Object.assign(manager.accounts[4], { expiresAt: Date.now() - 1 });
  Object.assign(manager.accounts[5], { _warming: true });
  proxy.importProbeTemplate(template);
  await delay(100);
  assert.equal(seen.length, 0);
});

test('web reset: activeWarmup false and close stop background probes', async t => {
  const disabled = await fixture(t, { config: { activeWarmup: false } });
  assert.equal(disabled.proxy.importProbeTemplate(template), false);
  const stopped = await fixture(t);
  stopped.proxy.importProbeTemplate(template);
  await close(stopped.proxy);
  await delay(60);
  assert.equal(disabled.seen.length, 0);
  assert.equal(stopped.seen.length, 0);
});
