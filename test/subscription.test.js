import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import {
  applySubscriptionCancellation,
  cancellationEndsAt,
  clearSubscriptionCancellation,
  findSubscriptionTarget,
  normalizeSubscriptionCancellation,
  subscriptionSnapshot,
} from '../src/subscription.js';
import { TUI } from '../src/tui.js';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function codexAccount(name, extra = {}) {
  return {
    name,
    email: name.includes('@') ? name : `${name}@example.com`,
    provider: 'codex',
    type: 'oauth',
    accountUuid: `uuid-${name}`,
    accessToken: 'at',
    refreshToken: 'rt',
    ...extra,
  };
}

test('subscription target matching uses exact localparts and rejects prefix collisions', () => {
  const config = { provider: 'codex', accounts: [
    codexAccount('sesileo981110'),
    codexAccount('sesileo98'),
  ] };

  assert.equal(findSubscriptionTarget(config, { selector: 'sesileo98' }).account.name, 'sesileo98');
  assert.throws(
    () => findSubscriptionTarget(config, { selector: 'sesileo9' }),
    /not found/,
  );
  assert.equal(findSubscriptionTarget(config, {
    selector: 'sesileo98',
    expectedAccountUuid: 'uuid-sesileo98',
  }).account.name, 'sesileo98');
});

test('subscription target is Codex OAuth only and UUID mismatches fail closed', () => {
  const config = { provider: 'codex', accounts: [
    codexAccount('pro'),
    { name: 'api', provider: 'codex', type: 'apikey', accountUuid: 'api-uuid' },
  ] };

  assert.throws(() => findSubscriptionTarget(config, {
    selector: 'pro', expectedAccountUuid: 'wrong',
  }), /expected identity/);
  assert.throws(() => findSubscriptionTarget(config, { selector: 'api' }), /OAuth/);
});

test('ends-on means usable through that local calendar date', () => {
  const endsAt = cancellationEndsAt('2026-09-06', 9 * 60);
  assert.equal(endsAt, '2026-09-06T15:00:00.000Z');
  assert.throws(() => cancellationEndsAt('2026-02-30', 9 * 60), /valid YYYY-MM-DD/);
  assert.throws(() => cancellationEndsAt('09/06', 9 * 60), /valid YYYY-MM-DD/);
});

test('ends-on uses the target date offset rather than the current DST offset', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    assert.equal(cancellationEndsAt('2027-01-15'), '2027-01-16T05:00:00.000Z');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('cancellation metadata moves from scheduled to due to ended without credentials', () => {
  const now = Date.parse('2026-08-31T00:00:00.000Z');
  const endsAt = new Date(now + DAY).toISOString();
  const account = codexAccount('scheduled');
  applySubscriptionCancellation(account, { endsAt, now });

  assert.deepEqual(account.subscriptionCancellation, {
    status: 'scheduled',
    recordedAt: new Date(now).toISOString(),
    endsAt,
  });
  assert.equal(subscriptionSnapshot(account, now).state, 'cancellation-scheduled');
  assert.equal(subscriptionSnapshot(account, now + DAY).state, 'end-date-reached');

  account.subscriptionCancellation = normalizeSubscriptionCancellation({
    ...account.subscriptionCancellation,
    status: 'ended',
    endedAt: new Date(now + DAY).toISOString(),
    evidence: 'auth-failure-after-cancellation',
  });
  assert.equal(subscriptionSnapshot(account, now + DAY).state, 'ended');
  assert.equal('accessToken' in subscriptionSnapshot(account, now + DAY), false);
});

test('clearing cancellation removes only tracking metadata', () => {
  const account = codexAccount('clear-me', {
    priority: 3,
    subscriptionCancellation: { status: 'scheduled', recordedAt: '2026-08-31T00:00:00.000Z' },
  });
  clearSubscriptionCancellation(account);
  assert.equal(account.subscriptionCancellation, undefined);
  assert.equal(account.accessToken, 'at');
  assert.equal(account.priority, 3);
});

test('Codex cancellation is informational before its end and terminal auth distinguishes the boundary', async () => {
  const now = Date.now();
  const am = new AccountManager([
    codexAccount('future-cancel', {
      expiresAt: now + HOUR,
      subscriptionCancellation: {
        status: 'scheduled', recordedAt: new Date(now).toISOString(),
        endsAt: new Date(now + HOUR).toISOString(),
      },
    }),
    codexAccount('due-cancel', {
      expiresAt: now + HOUR,
      subscriptionCancellation: {
        status: 'scheduled', recordedAt: new Date(now - HOUR).toISOString(),
        endsAt: new Date(now - 1).toISOString(),
      },
    }),
  ], 0.98);
  const persisted = [];
  am.onAccountMetadata((account, metadata) => persisted.push([account.name, metadata]));

  am.markAuthenticationError(am.accounts[0], 'auth-revoked', now);
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(am.accounts[0].errorReason, 'auth-revoked');
  assert.equal(am.accounts[0].subscriptionCancellation.status, 'scheduled');

  am.markAuthenticationError(am.accounts[1], 'auth-revoked', now);
  await am.waitForAccountFlag(am.accounts[1]);
  assert.equal(am.accounts[1].status, 'error');
  assert.equal(am.accounts[1].errorReason, 'subscription-ended');
  assert.equal(am.accounts[1].subscriptionCancellation.status, 'ended');
  assert.equal(am.getActiveAccount(), null, 'both error accounts are excluded from rotation');
  assert.equal(persisted.length, 1, 'only the inferred subscription transition is persisted');
});

test('a free or missing Codex plan type is not subscription termination evidence', () => {
  const recordedAt = new Date(Date.now() - HOUR).toISOString();
  const am = new AccountManager([
    codexAccount('free-plan', {
      planType: 'free',
      subscriptionCancellation: { status: 'scheduled', recordedAt, endsAt: null },
    }),
    codexAccount('unknown-plan', {
      subscriptionCancellation: { status: 'scheduled', recordedAt, endsAt: null },
    }),
  ], 0.98);

  assert.deepEqual(am.accounts.map(account => account.status), ['active', 'active']);
  assert.deepEqual(am.accounts.map(account => account.subscriptionCancellation.status),
    ['scheduled', 'scheduled']);
});

test('a later successful Codex response reopens an inferred end but retains the declaration', async () => {
  const now = Date.now();
  const am = new AccountManager([codexAccount('recovered', {
    subscriptionCancellation: {
      status: 'ended', recordedAt: new Date(now - HOUR).toISOString(),
      endsAt: new Date(now - HOUR).toISOString(), endedAt: new Date(now - 1).toISOString(),
      evidence: 'auth-failure-after-cancellation',
    },
  })], 0.98);
  const persisted = [];
  am.onAccountMetadata((account, metadata) => persisted.push([account.name, metadata]));

  assert.equal(am.accounts[0].errorReason, 'subscription-ended');
  am.markAccountSuccess(am.accounts[0], now);
  await am.waitForAccountFlag(am.accounts[0]);

  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[0].subscriptionCancellation.status, 'scheduled');
  assert.equal(am.getStatus().accounts[0].subscription.state, 'end-date-reached');
  assert.equal(persisted.length, 1);
});

test('rotating Codex credentials does not reopen an inferred subscription end before upstream success', async () => {
  const now = Date.now();
  const am = new AccountManager([codexAccount('still-ended', {
    subscriptionCancellation: {
      status: 'ended', recordedAt: new Date(now - HOUR).toISOString(),
      endsAt: new Date(now - HOUR).toISOString(), endedAt: new Date(now - 1).toISOString(),
      evidence: 'auth-failure-after-cancellation',
    },
  })], 0.98);

  am.updateAccountTokens(am.accounts[0], codexAccount('rotated', {
    accessToken: 'at2', refreshToken: 'rt2', expiresAt: now + HOUR,
  }));

  assert.equal(am.accounts[0].status, 'error', 'token issuance alone does not prove Codex entitlement');
  assert.equal(am.accounts[0].errorReason, 'subscription-ended');
  assert.equal(am.accounts[0].subscriptionCancellation.status, 'ended');

  am.markAccountSuccess(am.accounts[0], now);
  await am.waitForAccountFlag(am.accounts[0]);
  assert.equal(am.accounts[0].status, 'active', 'a real Codex success is the recovery proof');
  assert.equal(am.accounts[0].subscriptionCancellation.status, 'scheduled');
});

test('subscription metadata persistence callbacks are serialized per account', async () => {
  const now = Date.now();
  const am = new AccountManager([codexAccount('serialized', {
    subscriptionCancellation: {
      status: 'scheduled', recordedAt: new Date(now - HOUR).toISOString(), endsAt: null,
    },
  })], 0.98);
  const started = [];
  let releaseFirst;
  let reportFirstStarted;
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
  const firstStarted = new Promise(resolve => { reportFirstStarted = resolve; });
  am.onAccountMetadata(async (_account, metadata) => {
    started.push(metadata.status);
    if (metadata.status === 'ended') {
      reportFirstStarted();
      await firstBlocked;
    }
  });

  am.markAuthenticationError(am.accounts[0], 'auth-revoked', now);
  am.markAccountSuccess(am.accounts[0], now + 1);
  await firstStarted;
  assert.deepEqual(started, ['ended'], 'the recovery write must wait for the ended write');

  releaseFirst();
  await am.waitForAccountFlag(am.accounts[0]);
  assert.deepEqual(started, ['ended', 'scheduled']);
});

test('a terminal Codex refresh failure respects the declared subscription boundary', async () => {
  const now = Date.now();
  const am = new AccountManager([
    codexAccount('future', {
      expiresAt: now - HOUR,
      subscriptionCancellation: {
        status: 'scheduled', recordedAt: new Date(now - HOUR).toISOString(),
        endsAt: new Date(now + HOUR).toISOString(),
      },
    }),
    codexAccount('due', {
      expiresAt: now - HOUR,
      subscriptionCancellation: {
        status: 'scheduled', recordedAt: new Date(now - HOUR).toISOString(),
        endsAt: new Date(now - 1).toISOString(),
      },
    }),
  ], 0.98, 0, 3);
  const persisted = [];
  am.onAccountMetadata((account, metadata) => persisted.push([account.name, metadata]));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 401, text: async () => 'refresh denied',
    body: { cancel: async () => {} },
  });
  try {
    await am.refreshLapsedTokens();
  } finally {
    globalThis.fetch = originalFetch;
  }
  await am.waitForAccountFlagWrites();

  assert.equal(am.accounts[0].errorReason, 'refresh-failed');
  assert.equal(am.accounts[0].subscriptionCancellation.status, 'scheduled');
  assert.equal(am.accounts[1].errorReason, 'subscription-ended');
  assert.equal(am.accounts[1].subscriptionCancellation.status, 'ended');
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0][0], 'due');
});

test('an expiring but still-valid Codex token classifies terminal refresh failures', async t => {
  const scenarios = [
    ['401', async () => ({
      ok: false, status: 401, text: async () => 'refresh denied',
      body: { cancel: async () => {} },
    })],
    ['400 invalid_grant', async () => ({
      ok: false, status: 400, text: async () => JSON.stringify({ error: 'invalid_grant' }),
      body: { cancel: async () => {} },
    })],
  ];

  for (const [name, refresh] of scenarios) {
    await t.test(name, async () => {
      const now = Date.now();
      const am = new AccountManager([
        codexAccount(`future-${name}`, {
          expiresAt: now + 60_000,
          subscriptionCancellation: {
            status: 'scheduled', recordedAt: new Date(now - HOUR).toISOString(),
            endsAt: new Date(now + HOUR).toISOString(),
          },
        }),
        codexAccount(`due-${name}`, {
          expiresAt: now + 60_000,
          subscriptionCancellation: {
            status: 'scheduled', recordedAt: new Date(now - HOUR).toISOString(),
            endsAt: new Date(now - 1).toISOString(),
          },
        }),
      ], 0.98, 0, 3);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = refresh;
      try {
        await am.refreshLapsedTokens();
      } finally {
        globalThis.fetch = originalFetch;
      }
      await am.waitForAccountFlagWrites();

      assert.equal(am.accounts[0].errorReason, 'refresh-failed');
      assert.equal(am.accounts[0].subscriptionCancellation.status, 'scheduled');
      assert.equal(am.accounts[1].errorReason, 'subscription-ended');
      assert.equal(am.accounts[1].subscriptionCancellation.status, 'ended');
    });
  }
});

test('transient Codex refresh failures cannot infer a subscription end', async t => {
  const scenarios = [
    ['network failure', async () => { throw new TypeError('fetch failed'); }],
    ['server failure', async () => ({
      ok: false, status: 503, body: { cancel: async () => {} },
    })],
  ];

  for (const [name, refresh] of scenarios) {
    await t.test(name, async () => {
      const now = Date.now();
      const am = new AccountManager([codexAccount(name, {
        expiresAt: now - HOUR,
        subscriptionCancellation: {
          status: 'scheduled', recordedAt: new Date(now - HOUR).toISOString(),
          endsAt: new Date(now - 1).toISOString(),
        },
      })], 0.98, 0, 3);
      const persisted = [];
      am.onAccountMetadata((account, metadata) => persisted.push([account.name, metadata]));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = refresh;
      try {
        await am.refreshLapsedTokens();
      } finally {
        globalThis.fetch = originalFetch;
      }
      await am.waitForAccountFlagWrites();

      assert.equal(am.accounts[0].status, 'active');
      assert.equal(am.accounts[0].errorReason, undefined);
      assert.equal(am.accounts[0].subscriptionCancellation.status, 'scheduled');
      assert.equal(persisted.length, 0);
    });
  }
});

test('a parked pre-end auth error becomes subscription-ended after the boundary passes', async () => {
  const now = Date.now();
  const beforeEnd = now - (2 * HOUR);
  const am = new AccountManager([codexAccount('parked-before-end', {
    expiresAt: now - HOUR,
    subscriptionCancellation: {
      status: 'scheduled', recordedAt: new Date(beforeEnd - HOUR).toISOString(),
      endsAt: new Date(now - HOUR).toISOString(),
    },
  })], 0.98, 0, 3);
  const persisted = [];
  am.onAccountMetadata((account, metadata) => persisted.push([account.name, metadata]));
  am.markAuthenticationError(am.accounts[0], 'auth-revoked', beforeEnd);
  assert.equal(am.accounts[0].errorReason, 'auth-revoked');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 401, text: async () => 'refresh denied',
    body: { cancel: async () => {} },
  });
  try {
    await am.refreshLapsedTokens();
  } finally {
    globalThis.fetch = originalFetch;
  }
  await am.waitForAccountFlagWrites();

  assert.equal(am.accounts[0].errorReason, 'subscription-ended');
  assert.equal(am.accounts[0].subscriptionCancellation.status, 'ended');
  assert.equal(persisted.length, 1);
});

test('an ended Codex subscription cannot recover from a stale quota reset', () => {
  const now = Date.now();
  const am = new AccountManager([codexAccount('ended-with-stale-reset', {
    subscriptionCancellation: {
      status: 'ended',
      recordedAt: new Date(now - (2 * HOUR)).toISOString(),
      endsAt: new Date(now - HOUR).toISOString(),
      endedAt: new Date(now - HOUR).toISOString(),
      evidence: 'auth-failure-after-cancellation',
    },
  })], 0.98, 0, 3);
  am.accounts[0].quota.unified5h = 1;
  am.accounts[0].quota.unified5hReset = now - 1;

  assert.equal(am.getActiveAccount(), null);
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(am.accounts[0].errorReason, 'subscription-ended');
});

test('TUI rows visibly distinguish scheduled, due, and ended subscriptions', () => {
  const now = Date.now();
  const am = new AccountManager([
    codexAccount('scheduled', {
      subscriptionCancellation: {
        status: 'scheduled', recordedAt: new Date(now).toISOString(),
        endsAt: new Date(now + 60_000).toISOString(),
      },
    }),
    codexAccount('due', {
      subscriptionCancellation: {
        status: 'scheduled', recordedAt: new Date(now).toISOString(),
        endsAt: new Date(now - 60_000).toISOString(),
      },
    }),
    codexAccount('ended', {
      subscriptionCancellation: {
        status: 'ended', recordedAt: new Date(now).toISOString(),
        endedAt: new Date(now).toISOString(), evidence: 'auth-failure-after-cancellation',
      },
    }),
  ], 0.98, 0, 5);
  const tui = new TUI({
    accountManager: am,
    config: { provider: 'codex', accounts: [] },
    saveConfig: async () => {},
    syncAccounts: async () => 0,
    onQuit: () => {},
  });
  assert.match(tui._renderAcct(am.accounts[0], 0, 5, false), /canceling/);
  assert.match(tui._renderAcct(am.accounts[1], 1, 5, false), /sub due/);
  assert.match(tui._renderAcct(am.accounts[2], 2, 5, false), /sub ended/);
});

test('TUI keeps a pre-end authentication error visible for reauthentication', () => {
  const now = Date.now();
  const am = new AccountManager([codexAccount('future-auth-error', {
    subscriptionCancellation: {
      status: 'scheduled', recordedAt: new Date(now).toISOString(),
      endsAt: new Date(now + HOUR).toISOString(),
    },
  })], 0.98, 0, 5);
  am.markAuthenticationError(am.accounts[0], 'auth-revoked', now);
  const tui = new TUI({
    accountManager: am,
    config: { provider: 'codex', accounts: [] },
    saveConfig: async () => {},
    syncAccounts: async () => 0,
    onQuit: () => {},
  });

  const row = tui._renderAcct(am.accounts[0], 0, 5, false);
  assert.match(row, /error/);
  assert.doesNotMatch(row, /canceling/);
});
