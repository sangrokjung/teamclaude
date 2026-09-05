import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { atomicConfigUpdate } from '../src/config.js';

const SUBSCRIPTION_DISABLED_ERROR = {
  type: 'permission_error',
  message: 'OAuth authentication is currently not allowed for this organization.',
  details: { error_code: 'oauth_not_allowed_for_organization' },
};

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met before timeout');
}

function accounts() {
  return new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'tok-a', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
}

async function postMessage(proxyPort) {
  return fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [] }),
  });
}

test('a subscription-disabled 403 quarantines the OAuth account and switches', async () => {
  const hits = { a: 0, b: 0 };
  const upstream = http.createServer((req, res) => {
    const account = (req.headers.authorization || '').includes('tok-a') ? 'a' : 'b';
    hits[account]++;
    res.writeHead(account === 'a' ? 403 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(account === 'a'
      ? { type: 'error', error: SUBSCRIPTION_DISABLED_ERROR }
      : { ok: true, account }));
  });
  const upstreamPort = await listen(upstream);
  const am = accounts();
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await postMessage(proxyPort);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, account: 'b' });
    assert.deepEqual(hits, { a: 1, b: 1 });
    assert.equal(am.accounts[0].status, 'error');
    assert.equal(am.accounts[0]._errorFromRefresh, false);

    // The status payload must say WHY the account is out and who can serve now.
    const status = am.getStatus();
    const acctA = status.accounts.find(x => x.name === 'a');
    const acctB = status.accounts.find(x => x.name === 'b');
    assert.equal(acctA.errorReason, 'subscription-disabled');
    assert.equal(acctA.usable, false);
    assert.equal(acctB.errorReason, null);
    assert.equal(acctB.usable, true);
    assert.equal(status.usableCount, 1);
    assert.equal(status.totalCount, 2);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('all subscription-disabled accounts return the final original 403', async () => {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    const account = (req.headers.authorization || '').includes('tok-a') ? 'a' : 'b';
    hits.push(account);
    res.writeHead(403, {
      'content-type': 'application/json',
      'x-denied-account': account,
    });
    res.end(JSON.stringify({
      type: 'error',
      error: SUBSCRIPTION_DISABLED_ERROR,
      deniedAccount: account,
    }));
  });
  const upstreamPort = await listen(upstream);
  const am = accounts();
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await postMessage(proxyPort);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('x-denied-account'), 'b');
    assert.equal((await res.json()).deniedAccount, 'b');
    assert.deepEqual(hits, ['a', 'b']);
    assert.ok(am.accounts.every(account => account.status === 'error'));
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

// Mirrors the onAccountFlag persistence wiring in index.js serverCommand:
// flag changes are written through atomicConfigUpdate so concurrent writers
// aren't clobbered. Returns a getter for the latest write promise so tests can
// await the async best-effort persistence before asserting on the file.
function wireFlagPersistence(am) {
  let last = Promise.resolve();
  am.onAccountFlag((account, disabled) => {
    last = atomicConfigUpdate(cfg => {
      const acct = cfg.accounts.find(x => x.name === account.name);
      if (!acct) return;
      if (disabled) acct.subscriptionDisabled = true;
      else delete acct.subscriptionDisabled;
    });
    return last;
  });
  return () => last;
}

test('a subscription 403 persists subscriptionDisabled and a restart restores the lapsed state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-subflag-'));
  const configPath = join(dir, 'teamclaude.json');
  const prevConfigEnv = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = configPath;
  const baseAccounts = [
    { name: 'a', type: 'oauth', accessToken: 'tok-a', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', expiresAt: Date.now() + 3600_000 },
  ];
  await writeFile(configPath, JSON.stringify({
    provider: 'anthropic',
    proxy: { port: 65031, apiKey: 'k' },
    accounts: baseAccounts,
  }, null, 2));

  // Wire the flag hook BEFORE opening any listener so a missing/failing hook
  // fails the test without stranding open servers.
  const am = new AccountManager(baseAccounts.map(a => ({ ...a })), 0.98);
  const lastFlagWrite = wireFlagPersistence(am);
  const upstream = http.createServer((req, res) => {
    const account = (req.headers.authorization || '').includes('tok-a') ? 'a' : 'b';
    res.writeHead(account === 'a' ? 403 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(account === 'a'
      ? { type: 'error', error: SUBSCRIPTION_DISABLED_ERROR }
      : { ok: true, account }));
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await postMessage(proxyPort);
    assert.equal(res.status, 200);
    await lastFlagWrite();

    // The flag reached the config file (and only for the lapsed account).
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(saved.accounts.find(x => x.name === 'a').subscriptionDisabled, true);
    assert.equal('subscriptionDisabled' in saved.accounts.find(x => x.name === 'b'), false);

    // A "restart": an AccountManager built from the saved config starts the
    // account as a hard subscription error, invisible to refresh-sweep revival.
    const restarted = new AccountManager(saved.accounts, 0.98);
    assert.equal(restarted.accounts[0].status, 'error');
    assert.equal(restarted.accounts[0].errorReason, 'subscription-disabled');
    assert.equal(restarted.accounts[0]._errorFromRefresh, false);
    const status = restarted.getStatus();
    assert.equal(status.accounts.find(x => x.name === 'a').errorReason, 'subscription-disabled');
    assert.equal(status.accounts.find(x => x.name === 'a').usable, false);
    assert.equal(status.usableCount, 1);
  } finally {
    if (prevConfigEnv === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = prevConfigEnv;
    await close(proxy);
    await close(upstream);
    await rm(dir, { recursive: true, force: true });
  }
});

test('a 2xx on a flagged account clears subscriptionDisabled in memory and config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-subclear-'));
  const configPath = join(dir, 'teamclaude.json');
  const prevConfigEnv = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = configPath;
  await writeFile(configPath, JSON.stringify({
    provider: 'anthropic',
    proxy: { port: 65032, apiKey: 'k' },
    accounts: [
      { name: 'a', type: 'oauth', accessToken: 'tok-a', expiresAt: Date.now() + 3600_000, subscriptionDisabled: true },
      { name: 'b', type: 'oauth', accessToken: 'tok-b', expiresAt: Date.now() + 3600_000 },
    ],
  }, null, 2));

  const am = accounts();
  // The config flag can outlive the parked status (e.g. a credential re-import
  // healed the in-memory account while the flag-removal write raced or the
  // operator hand-edited config). A live 2xx is the authoritative all-clear.
  am.accounts[0].subscriptionDisabled = true;
  const lastFlagWrite = wireFlagPersistence(am);
  const upstream = http.createServer((req, res) => {
    const account = (req.headers.authorization || '').includes('tok-a') ? 'a' : 'b';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, account }));
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await postMessage(proxyPort);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, account: 'a' });
    await lastFlagWrite();

    assert.equal(am.accounts[0].subscriptionDisabled, undefined);
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal('subscriptionDisabled' in saved.accounts.find(x => x.name === 'a'), false);
  } finally {
    if (prevConfigEnv === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = prevConfigEnv;
    await close(proxy);
    await close(upstream);
    await rm(dir, { recursive: true, force: true });
  }
});

test('a persisted subscription access denial is rechecked and auto-heals after an accepted probe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-subrecheck-'));
  const configPath = join(dir, 'teamclaude.json');
  const prevConfigEnv = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = configPath;
  const futureReset = Math.floor(Date.now() / 1000) + 3600;
  const baseAccounts = [
    {
      name: 'a', type: 'oauth', accessToken: 'tok-a',
      expiresAt: Date.now() + 3600_000, subscriptionDisabled: true,
    },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', expiresAt: Date.now() + 3600_000 },
  ];
  await writeFile(configPath, JSON.stringify({
    provider: 'anthropic',
    proxy: { port: 65033, apiKey: 'k' },
    accounts: baseAccounts,
  }, null, 2));

  const am = new AccountManager(baseAccounts.map(a => ({ ...a })), 0.98);
  const lastFlagWrite = wireFlagPersistence(am);
  const hits = { a: 0, b: 0 };
  const upstream = http.createServer((req, res) => {
    const account = (req.headers.authorization || '').includes('tok-a') ? 'a' : 'b';
    hits[account]++;
    res.writeHead(200, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-5h-utilization': '0.01',
      'anthropic-ratelimit-unified-5h-reset': String(futureReset),
      'anthropic-ratelimit-unified-7d-utilization': '0.02',
      'anthropic-ratelimit-unified-7d-reset': String(futureReset),
    });
    res.end(JSON.stringify({ ok: true, account }));
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: true,
    warmupIntervalMs: 20,
    subscriptionRecheckIntervalMs: 20,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await postMessage(proxyPort);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).account, 'b', 'parked account must not serve client traffic');

    await waitFor(() => am.accounts[0].status === 'active' && hits.a >= 1);
    await lastFlagWrite();

    assert.equal(am.accounts[0].subscriptionDisabled, undefined);
    assert.equal(am.accounts[0].errorReason, undefined);
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal('subscriptionDisabled' in saved.accounts.find(x => x.name === 'a'), false);
  } finally {
    if (prevConfigEnv === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = prevConfigEnv;
    await close(proxy);
    await close(upstream);
    await rm(dir, { recursive: true, force: true });
  }
});

test('subscription access recovery does not depend on the periodic quota warm-up timer', async () => {
  const futureReset = Math.floor(Date.now() / 1000) + 3600;
  const hits = { a: 0, b: 0 };
  let denyNextA = false;
  const upstream = http.createServer((req, res) => {
    const account = (req.headers.authorization || '').includes('tok-a') ? 'a' : 'b';
    hits[account]++;
    if (account === 'a' && denyNextA) {
      denyNextA = false;
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: SUBSCRIPTION_DISABLED_ERROR }));
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-5h-utilization': '0.01',
      'anthropic-ratelimit-unified-5h-reset': String(futureReset),
      'anthropic-ratelimit-unified-7d-utilization': '0.02',
      'anthropic-ratelimit-unified-7d-reset': String(futureReset),
    });
    res.end(JSON.stringify({ ok: true, account }));
  });
  const upstreamPort = await listen(upstream);
  const am = accounts();
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: true,
    warmupIntervalMs: 0,
    subscriptionRecheckIntervalMs: 250,
  });
  const proxyPort = await listen(proxy);

  try {
    const first = await postMessage(proxyPort);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).account, 'a');
    await waitFor(() => hits.b >= 1); // initial template fan-out has settled

    denyNextA = true;
    const failedOver = await postMessage(proxyPort);
    assert.equal(failedOver.status, 200);
    assert.equal((await failedOver.json()).account, 'b');
    assert.equal(am.accounts[0].errorReason, 'subscription-disabled');

    await waitFor(() => am.accounts[0].status === 'active' && hits.a >= 3);
    assert.equal(am.accounts[0].subscriptionDisabled, undefined);
    assert.equal(am.accounts[0].errorReason, undefined);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('a 403 without the structured error code passes through without poisoning the pool', async () => {
  const hits = { a: 0, b: 0 };
  const original = {
    type: 'error',
    error: {
      type: 'permission_error',
      message: 'Your organization has disabled Claude subscription access for Claude Code.',
    },
  };
  const upstream = http.createServer((req, res) => {
    const account = (req.headers.authorization || '').includes('tok-a') ? 'a' : 'b';
    hits[account]++;
    res.writeHead(account === 'a' ? 403 : 200, {
      'content-type': 'application/json',
      'x-original-response': 'yes',
    });
    res.end(JSON.stringify(account === 'a' ? original : { ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = accounts();
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await postMessage(proxyPort);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('x-original-response'), 'yes');
    assert.deepEqual(await res.json(), original);
    assert.deepEqual(hits, { a: 1, b: 0 });
    assert.ok(am.accounts.every(account => account.status === 'active'));
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
