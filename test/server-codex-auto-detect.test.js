import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// Automatic subscription-termination detection (no operator declaration):
// the codex usage poll doubles as a credential health check. Only HTTP 401/403
// on /wham/usage are terminal auth evidence; a streak of them escalates to a
// forced refresh + confirm re-poll, and a confirmed failure parks the account.
// A later valid usage poll success heals the accounts THIS feature parked
// (and subscription-ended ones) — never a request-path park.

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

// One upstream serving /wham/usage with a mutable status switch, plus a stubbed
// auth.openai.com token endpoint (mutable outcome + hit counter). The startup
// usage fan-out is awaited and its counters cleared, so each test drives polls
// deterministically via proxy.refreshQuotaAll().
async function startAutoDetectHarness(extraConfig = {}, accountOverrides = {}) {
  const wham = { hits: 0, status: 200, usedPercent: 42 };
  const token = { hits: 0, status: 200, invalidGrant: true };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (String(input) === 'https://auth.openai.com/oauth/token') {
      token.hits++;
      if (token.status === 200) {
        return Promise.resolve(new globalThis.Response(JSON.stringify({
          access_token: `fresh-access-${token.hits}`,
          refresh_token: 'fresh-refresh',
          expires_in: 3600,
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(new globalThis.Response(
        JSON.stringify({ error: token.invalidGrant ? 'invalid_grant' : 'server_error' }),
        { status: token.status, headers: { 'content-type': 'application/json' } },
      ));
    }
    return originalFetch(input, init);
  };
  const upstream = http.createServer((req, res) => {
    if (req.url === '/backend-api/wham/usage') {
      wham.hits++;
      // A per-hit plan wins over the sticky status switch (race-free scripting
      // of "N failures, then healthy" inside a single escalation pass).
      const status = wham.plan?.length ? wham.plan.shift() : wham.status;
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'denied' }));
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
    res.end(JSON.stringify({ id: 'response-id', object: 'response', status: 'completed' }));
  });
  const upstreamPort = await listen(upstream);
  const manager = new AccountManager([{
    name: 'codex-pro',
    provider: 'codex',
    type: 'oauth',
    accessToken: 'access-a',
    refreshToken: 'refresh-a',
    accountId: 'workspace-a',
    expiresAt: Date.now() + 3_600_000,
    ...accountOverrides,
  }]);
  const persisted = [];
  manager.onAccountMetadata((_account, metadata) => persisted.push(metadata));
  const proxy = createProxyServer(manager, {
    provider: 'codex',
    upstream: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
    activeWarmup: false,
    warmupIntervalMs: 0,
    codexUsageActiveMs: 0,
    ...extraConfig,
  });
  const proxyPort = await listen(proxy);
  // Settle the startup fan-out, then reset the counters.
  await proxy.refreshQuotaAll();
  wham.hits = 0;
  token.hits = 0;
  return {
    wham,
    token,
    manager,
    persisted,
    proxyPort,
    account: manager.accounts[0],
    poll: () => proxy.refreshQuotaAll(),
    close: async () => {
      globalThis.fetch = originalFetch;
      await Promise.all([closeServer(proxy), closeServer(upstream)]);
    },
  };
}

test('terminal poll failures below the threshold change nothing', async () => {
  const h = await startAutoDetectHarness();
  try {
    h.wham.status = 401;
    await h.poll();
    await h.poll();
    assert.equal(h.account.status, 'active');
    assert.equal(h.token.hits, 0); // no escalation yet
    assert.equal(h.wham.hits, 2);
  } finally {
    await h.close();
  }
});

test('a terminal streak plus a terminal refresh parks the account, and a valid poll heals it', async () => {
  const h = await startAutoDetectHarness();
  try {
    h.token.status = 400; // invalid_grant → terminal refresh failure
    h.wham.status = 401;
    await h.poll();
    await h.poll();
    await h.poll();
    assert.equal(h.account.status, 'error');
    assert.equal(h.account.errorReason, 'refresh-failed');
    assert.equal(h.token.hits, 1); // exactly one forced refresh
    assert.equal(h.wham.hits, 3); // parked at the refresh step — no confirm re-poll
    assert.equal(h.manager.getStatus().accounts[0].errorReason, 'refresh-failed');
    assert.equal(h.manager.getActiveAccount(), null); // out of rotation

    // A parked account stays a poll target but never re-escalates.
    await h.poll();
    assert.equal(h.token.hits, 1);
    assert.equal(h.account.status, 'error');

    // Recovery: a valid usage poll success brings it back automatically.
    h.wham.status = 200;
    h.wham.usedPercent = 55;
    await h.poll();
    assert.equal(h.account.status, 'active');
    assert.equal(h.account.errorReason, undefined);
    assert.equal(h.account.quota.unified7d, 0.55);

    // Re-park: a fresh streak re-applies the same rule (no extra cooldown).
    h.wham.status = 401;
    await h.poll();
    await h.poll();
    await h.poll();
    assert.equal(h.account.status, 'error');
    assert.equal(h.account.errorReason, 'refresh-failed');
    assert.equal(h.token.hits, 2);
  } finally {
    await h.close();
  }
});

test('refresh success followed by a terminal confirm re-poll parks as auth-revoked', async () => {
  const h = await startAutoDetectHarness();
  try {
    h.wham.status = 401;
    await h.poll();
    await h.poll();
    await h.poll(); // escalation: refresh (200) → confirm re-poll (401)
    assert.equal(h.account.status, 'error');
    assert.equal(h.account.errorReason, 'auth-revoked');
    assert.equal(h.token.hits, 1);
    assert.equal(h.wham.hits, 4); // 3 streak polls + 1 confirm re-poll
    assert.equal(h.account.credential, 'fresh-access-1'); // refresh really applied

    // Auto-recovery on a later valid poll (resubscription).
    h.wham.status = 200;
    await h.poll();
    assert.equal(h.account.status, 'active');
    assert.equal(h.account.errorReason, undefined);
  } finally {
    await h.close();
  }
});

test('a healthy confirm re-poll cancels the escalation without parking', async () => {
  const h = await startAutoDetectHarness();
  try {
    // Script exactly three 401s: the escalating third poll still sees 401, but
    // the confirm re-poll after the successful refresh sees a healthy 200.
    h.wham.plan = [401, 401, 401];
    await h.poll();
    await h.poll();
    await h.poll();
    assert.equal(h.account.status, 'active');
    assert.equal(h.token.hits, 1);

    // The escalation consumed the streak: 2 more 401s do not re-escalate.
    h.wham.status = 401;
    await h.poll();
    await h.poll();
    assert.equal(h.token.hits, 1);
    assert.equal(h.account.status, 'active');
  } finally {
    await h.close();
  }
});

test('non-terminal poll failures (5xx/429) never escalate or park', async () => {
  const h = await startAutoDetectHarness();
  try {
    h.wham.status = 500;
    await h.poll();
    await h.poll();
    await h.poll();
    await h.poll();
    h.wham.status = 429;
    await h.poll();
    await h.poll();
    await h.poll();
    assert.equal(h.account.status, 'active');
    assert.equal(h.token.hits, 0);
  } finally {
    await h.close();
  }
});

test('a successful poll resets the terminal streak', async () => {
  const h = await startAutoDetectHarness();
  try {
    h.token.status = 400;
    h.wham.status = 401;
    await h.poll();
    await h.poll();
    h.wham.status = 200;
    await h.poll(); // success → streak reset
    h.wham.status = 401;
    await h.poll();
    await h.poll();
    assert.equal(h.account.status, 'active');
    assert.equal(h.token.hits, 0);
    await h.poll(); // third consecutive terminal failure → escalates now
    assert.equal(h.token.hits, 1);
    assert.equal(h.account.status, 'error');
  } finally {
    await h.close();
  }
});

test('a completed inference resets the terminal poll streak (serving accounts are never quarantined by poll-only 403s)', async () => {
  const h = await startAutoDetectHarness();
  try {
    // Two terminal polls: one short of the escalation threshold.
    h.wham.status = 403;
    await h.poll();
    await h.poll();
    // A completed inference on the SAME backend is positive auth evidence —
    // stronger than usage-endpoint 403s (which may be endpoint-scoped: WAF
    // rule, contract change, plan/scope policy). It must reset the streak.
    const response = await fetch(`http://127.0.0.1:${h.proxyPort}/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5', input: 'hello' }),
    });
    assert.equal(response.status, 200);
    await response.text();
    // Two more terminal polls: only 2 since the success → still no escalation.
    await h.poll();
    await h.poll();
    assert.equal(h.account.status, 'active');
    assert.equal(h.token.hits, 0); // no forced refresh ever happened
    // A third consecutive failure with no interleaved success escalates as usual.
    await h.poll();
    assert.equal(h.token.hits, 1);
  } finally {
    await h.close();
  }
});

test('codexAuthFailureThreshold: 1 escalates on the first terminal failure', async () => {
  const h = await startAutoDetectHarness({ codexAuthFailureThreshold: 1 });
  try {
    h.token.status = 400;
    h.wham.status = 401;
    await h.poll();
    assert.equal(h.account.status, 'error');
    assert.equal(h.account.errorReason, 'refresh-failed');
    assert.equal(h.token.hits, 1);
  } finally {
    await h.close();
  }
});

test('403 counts as terminal auth evidence like 401', async () => {
  const h = await startAutoDetectHarness({ codexAuthFailureThreshold: 1 });
  try {
    h.token.status = 400;
    h.wham.status = 403;
    await h.poll();
    assert.equal(h.account.status, 'error');
    assert.equal(h.account.errorReason, 'refresh-failed');
  } finally {
    await h.close();
  }
});

test('a declared due cancellation delegates the park to subscription-ended and reopens on success', async () => {
  const now = Date.now();
  const h = await startAutoDetectHarness({}, {
    subscriptionCancellation: {
      status: 'scheduled',
      recordedAt: new Date(now - 3_600_000).toISOString(),
      endsAt: new Date(now - 1).toISOString(),
    },
  });
  try {
    h.token.status = 400;
    h.wham.status = 401;
    await h.poll();
    await h.poll();
    await h.poll();
    assert.equal(h.account.status, 'error');
    assert.equal(h.account.errorReason, 'subscription-ended');
    assert.equal(h.account.subscriptionCancellation.status, 'ended');
    assert.equal(h.persisted.at(-1)?.status, 'ended');

    // Valid usage success reopens: ended → scheduled, account active again.
    h.wham.status = 200;
    await h.poll();
    assert.equal(h.account.status, 'active');
    assert.equal(h.account.subscriptionCancellation.status, 'scheduled');
    assert.equal(h.persisted.at(-1)?.status, 'scheduled');
  } finally {
    await h.close();
  }
});

test('a request-path auth park is NOT healed by a poll success (existing rules pinned)', async () => {
  const h = await startAutoDetectHarness();
  try {
    // Simulate the server 401 handler parking the account (no poll involvement).
    h.manager.markAuthenticationError(h.account, 'auth-revoked');
    assert.equal(h.account.status, 'error');
    h.wham.status = 200;
    await h.poll();
    assert.equal(h.account.status, 'error');
    assert.equal(h.account.errorReason, 'auth-revoked');
  } finally {
    await h.close();
  }
});

// --- AccountManager-level contract for the quarantine cause tag ---

function codexManager() {
  return new AccountManager([{
    name: 'codex-pro', provider: 'codex', type: 'oauth',
    accessToken: 'access-a', expiresAt: Date.now() + 3_600_000,
  }]);
}

test('markAccountSuccess heals only a poll-quarantined error', () => {
  const mgr = codexManager();
  const account = mgr.accounts[0];
  account.status = 'error';
  account.errorReason = 'auth-revoked';
  account._errorFromUsagePoll = true;
  mgr.markAccountSuccess(account);
  assert.equal(account.status, 'active');
  assert.equal(account.errorReason, undefined);
  assert.equal(account._errorFromUsagePoll, undefined);

  // Untagged (request-path) parks stay parked.
  account.status = 'error';
  account.errorReason = 'auth-revoked';
  mgr.markAccountSuccess(account);
  assert.equal(account.status, 'error');
  assert.equal(account.errorReason, 'auth-revoked');
});

test('markAccountSuccess resets the usage-poll auth streak', () => {
  const mgr = codexManager();
  const account = mgr.accounts[0];
  account._usageAuthStreak = 2;
  mgr.markAccountSuccess(account);
  assert.equal(account._usageAuthStreak ?? 0, 0);
});

test('a request-path re-park clears a stale poll-quarantine tag', () => {
  const mgr = codexManager();
  const account = mgr.accounts[0];
  account._errorFromUsagePoll = true; // stale tag from an earlier quarantine
  mgr.markAuthenticationError(account, 'auth-revoked');
  assert.equal(account.status, 'error');
  // The request-path park must not have become poll-healable.
  mgr.markAccountSuccess(account);
  assert.equal(account.status, 'error');
  assert.equal(account.errorReason, 'auth-revoked');
});
