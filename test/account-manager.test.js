import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const HOUR = 3600_000;
const MIN = 60_000;

function makeAccounts(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `acct-${i}`,
    type: 'oauth',
    accessToken: `tok-${i}`,
    refreshToken: `r-${i}`,
    expiresAt: Date.now() + HOUR,
  }));
}

function setSession(am, idx, util, resetInMs, now = Date.now()) {
  am.accounts[idx].quota.unified5h = util;
  am.accounts[idx].quota.unified5hReset = now + resetInMs;
}

function setWeekly(am, idx, util, resetInMs, now = Date.now()) {
  am.accounts[idx].quota.unified7d = util;
  am.accounts[idx].quota.unified7dReset = now + resetInMs;
}

test('use-or-lose: account whose session resets soonest is chosen first', () => {
  const am = new AccountManager(makeAccounts(3), 0.98);
  setSession(am, 0, 0.10, 4 * HOUR);   // far reset, low usage
  setSession(am, 1, 0.50, 5 * MIN);    // soon reset, mid usage  ← should win
  setSession(am, 2, 0.05, 3 * HOUR);   // far reset, lowest usage
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('use-or-lose: soonest WEEKLY reset wins over soonest session reset', () => {
  const am = new AccountManager(makeAccounts(2), 0.98);
  const now = Date.now();
  // acct-0: session resets very soon, but its week renews far out.
  setSession(am, 0, 0.20, 5 * MIN, now);
  setWeekly(am, 0, 0.40, 6 * 24 * HOUR, now);
  // acct-1: session resets later, but its week renews tomorrow — its unspent
  // weekly quota is about to be wasted, so it must be drained first.
  setSession(am, 1, 0.20, 4 * HOUR, now);
  setWeekly(am, 1, 0.40, 1 * 24 * HOUR, now);
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('weekly tie → session reset decides (accounts without 7d data unchanged)', () => {
  const am = new AccountManager(makeAccounts(2), 0.98);
  const now = Date.now();
  const wkReset = 3 * 24 * HOUR;
  setSession(am, 0, 0.20, 4 * HOUR, now);
  setWeekly(am, 0, 0.40, wkReset, now);
  setSession(am, 1, 0.20, 5 * MIN, now);   // same weekly reset → soonest session wins
  setWeekly(am, 1, 0.40, wkReset, now);
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('explicit priority still beats weekly ordering', () => {
  const accts = makeAccounts(2);
  accts[0].priority = 0;                    // pinned #1
  const am = new AccountManager(accts, 0.98);
  const now = Date.now();
  setSession(am, 0, 0.20, 4 * HOUR, now);
  setWeekly(am, 0, 0.40, 6 * 24 * HOUR, now);   // far weekly reset
  setSession(am, 1, 0.20, 5 * MIN, now);
  setWeekly(am, 1, 0.40, 1 * 24 * HOUR, now);   // near weekly reset — loses to the pin
  assert.equal(am.getActiveAccount().name, 'acct-0');
});

test('tie on reset time → lowest utilization wins', () => {
  const am = new AccountManager(makeAccounts(2), 0.98);
  const reset = 60 * MIN;
  // One shared `now`, like the sibling tie tests: setSession defaults to
  // Date.now() PER CALL, so on a loaded host a millisecond between the two
  // lines makes acct-0 reset sooner and the reset rule wins before the
  // utilization tiebreak is ever reached (observed as a suite flake).
  const now = Date.now();
  setSession(am, 0, 0.40, reset, now);
  setSession(am, 1, 0.20, reset, now);
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('accounts at/over threshold are excluded even if their reset is soonest', () => {
  const am = new AccountManager(makeAccounts(2), 0.98);
  setSession(am, 0, 0.99, 1 * MIN);    // soonest reset but maxed out → excluded
  setSession(am, 1, 0.30, 4 * HOUR);
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('current account is sticky between re-evaluations (cache preservation)', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 5 * MIN);
  const now = Date.now();
  setSession(am, 0, 0.50, 4 * HOUR, now);
  setSession(am, 1, 0.10, 5 * MIN, now);
  assert.equal(am.getActiveAccount().name, 'acct-1');   // first call re-evaluates → soonest

  // acct-0 becomes the soonest, but we are inside the 5-min window → stay put
  am.accounts[0].quota.unified5hReset = now + 1 * MIN;
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('re-prioritizes after the interval elapses', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 5 * MIN);
  const now = Date.now();
  setSession(am, 0, 0.50, 4 * HOUR, now);
  setSession(am, 1, 0.10, 5 * MIN, now);
  assert.equal(am.getActiveAccount().name, 'acct-1');

  // Make acct-0 the soonest and force the interval to have elapsed
  am.accounts[0].quota.unified5hReset = now + 1 * MIN;
  am.lastEvalAt = now - 6 * MIN;
  assert.equal(am.getActiveAccount().name, 'acct-0');
});

test('reevalIntervalMs <= 0 disables periodic re-prioritization (stays sticky)', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0);   // 0 = timer disabled
  const now = Date.now();
  setSession(am, 0, 0.50, 4 * HOUR, now);   // current (index 0), far reset, higher usage
  setSession(am, 1, 0.10, 5 * MIN, now);    // soonest reset + lower usage — would win if the timer ran

  // Timer disabled → never re-prioritizes, so it stays on the initial current
  // (acct-0) instead of switching to the use-or-lose winner acct-1...
  assert.equal(am.getActiveAccount().name, 'acct-0');
  am.lastEvalAt = now - 60 * MIN;                  // even with lots of time "elapsed"
  assert.equal(am.getActiveAccount().name, 'acct-0');

  // ...but a forced switch still happens when the current account is unavailable.
  am.accounts[0].quota.unified5h = 0.99;           // current now over threshold
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('immediate switch when current hits threshold, picking by priority', () => {
  const am = new AccountManager(makeAccounts(3), 0.98, 5 * MIN);
  setSession(am, 0, 0.10, 4 * HOUR);
  setSession(am, 1, 0.10, 10 * MIN);
  setSession(am, 2, 0.10, 2 * MIN);
  assert.equal(am.getActiveAccount().name, 'acct-2');   // soonest

  am.accounts[2].quota.unified5h = 0.99;                // current now maxed
  assert.equal(am.getActiveAccount().name, 'acct-1');   // next-soonest available, not round-robin
});

test('weekly quota over threshold makes an account unavailable', () => {
  const am = new AccountManager(makeAccounts(2), 0.98);
  const now = Date.now();
  setSession(am, 0, 0.10, 1 * MIN, now);
  am.accounts[0].quota.unified7d = 0.99;                // weekly maxed → excluded
  am.accounts[0].quota.unified7dReset = now + 2 * HOUR;
  setSession(am, 1, 0.30, 4 * HOUR, now);
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('returns null when every account is exhausted (not yet reset)', () => {
  const am = new AccountManager(makeAccounts(2), 0.98);
  const now = Date.now();
  setSession(am, 0, 0.99, 30 * MIN, now);
  setSession(am, 1, 0.99, 30 * MIN, now);
  assert.equal(am.getActiveAccount(), null);
});

test('rotateActiveAccount switches to another available account without exposing credentials', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0);
  am.accounts[0].accountUuid = 'uuid-0';
  am.accounts[1].accountUuid = 'uuid-1';
  am.currentIndex = 0;

  const result = am.rotateActiveAccount();

  assert.deepEqual(result, {
    rotated: true,
    previousAccount: 'acct-0',
    previousAccountUuid: 'uuid-0',
    currentAccount: 'acct-1',
    currentAccountUuid: 'uuid-1',
  });
  assert.equal(am.currentIndex, 1);
  assert.deepEqual(Object.keys(result).sort(), [
    'currentAccount',
    'currentAccountUuid',
    'previousAccount',
    'previousAccountUuid',
    'rotated',
  ]);
});

test('rotateActiveAccount skips disabled, errored, and quota-blocked alternatives', () => {
  const accounts = makeAccounts(5);
  accounts[1].enabled = false;
  const am = new AccountManager(accounts, 0.98, 0);
  am.currentIndex = 0;
  am.accounts[2].status = 'error';
  setSession(am, 3, 0.99, 30 * MIN);
  setSession(am, 4, 0.2, 30 * MIN);

  const result = am.rotateActiveAccount();

  assert.equal(result.rotated, true);
  assert.equal(result.currentAccount, 'acct-4');
  assert.equal(am.currentIndex, 4);
});

test('rotateActiveAccount leaves state unchanged when no alternative is usable', () => {
  const accounts = makeAccounts(2);
  accounts[1].enabled = false;
  const inputBefore = structuredClone(accounts);
  const am = new AccountManager(accounts, 0.98, 0);
  am.currentIndex = 0;
  am.lastEvalAt = 12345;

  const result = am.rotateActiveAccount();

  assert.deepEqual(result, {
    rotated: false,
    reason: 'no-alternative-account',
  });
  assert.equal(am.currentIndex, 0);
  assert.equal(am.lastEvalAt, 12345);
  assert.deepEqual(accounts, inputBefore);
});

test('rotateActiveAccount excludes the failed recovery UUID instead of the global current account', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0);
  am.accounts[0].accountUuid = 'uuid-a';
  am.accounts[1].accountUuid = 'uuid-b';
  am.currentIndex = 0;

  const result = am.rotateActiveAccount(null, true, 'uuid-b');

  assert.deepEqual(result, {
    rotated: true,
    previousAccount: 'acct-1',
    previousAccountUuid: 'uuid-b',
    currentAccount: 'acct-0',
    currentAccountUuid: 'uuid-a',
  });
  assert.equal(am.currentIndex, 0);
});

test('a preferred recovery account survives concurrent global rotations and warm-up', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0);
  am.accounts[0].accountUuid = 'uuid-0';
  am.accounts[1].accountUuid = 'uuid-1';
  am.currentIndex = 0;

  const firstRecovery = am.rotateActiveAccount();
  const secondRecovery = am.rotateActiveAccount();

  assert.equal(firstRecovery.currentAccount, 'acct-1');
  assert.equal(secondRecovery.currentAccount, 'acct-0');
  assert.equal(am.currentIndex, 0);

  const first = await am.acquireAccount(
    null,
    0,
    null,
    {},
    null,
    firstRecovery.currentAccountUuid,
  );
  assert.equal(first?.name, 'acct-1');
  am.releaseAccount(first);

  const second = await am.acquireAccount(
    null,
    0,
    null,
    {},
    null,
    secondRecovery.currentAccountUuid,
  );
  assert.equal(second?.name, 'acct-0');
  am.releaseAccount(second);
});

test('a preferred recovery UUID survives rename and fails closed when unavailable or excluded', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0);
  am.accounts[0].accountUuid = 'uuid-0';
  am.accounts[1].accountUuid = 'uuid-1';
  am.currentIndex = 0;

  const recovery = am.rotateActiveAccount();
  const preferred = am.accounts[1];
  preferred.name = 'renamed-account';

  const renamed = await am.acquireAccount(
    null,
    0,
    null,
    {},
    null,
    recovery.currentAccountUuid,
  );
  assert.equal(renamed?.accountUuid, 'uuid-1');
  am.releaseAccount(renamed);

  preferred.enabled = false;
  assert.equal(await am.acquireAccount(
    null,
    0,
    null,
    {},
    null,
    recovery.currentAccountUuid,
  ), null);

  preferred.enabled = true;
  assert.equal(await am.acquireAccount(
    new Set([preferred]),
    0,
    null,
    {},
    null,
    recovery.currentAccountUuid,
  ), null);

  am.removeAccount(preferred.index);
  assert.equal(await am.acquireAccount(
    null,
    0,
    null,
    {},
    null,
    recovery.currentAccountUuid,
  ), null);
});

// Measure an account the way a real upstream response would (populates quota + totalRequests).
function measure(am, idx, util5h, resetInMs, now = Date.now()) {
  am.updateQuota(idx, {
    'anthropic-ratelimit-unified-5h-utilization': String(util5h),
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + resetInMs) / 1000)),
  });
}

test('warm-up: routes to each unmeasured account until all measured, then priority', () => {
  const am = new AccountManager(makeAccounts(3), 0.98, 5 * MIN);
  const now = Date.now();
  // Nothing measured yet → warm-up cycles through accounts one request at a time
  assert.equal(am.getActiveAccount().name, 'acct-0');
  measure(am, 0, 0.50, 4 * HOUR, now);
  assert.equal(am.getActiveAccount().name, 'acct-1');
  measure(am, 1, 0.10, 5 * MIN, now);
  assert.equal(am.getActiveAccount().name, 'acct-2');
  measure(am, 2, 0.10, 3 * HOUR, now);
  // All measured → use-or-lose priority: soonest reset = acct-1
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('warm-up round-robins so a burst of any size stays spread (no pile-up on acct-0)', () => {
  const am = new AccountManager(makeAccounts(3), 0.98, 5 * MIN);
  // 3 fresh accounts, no updateQuota between calls (simulates a concurrent startup
  // burst). Even a burst far larger than maxWarmupTries * accountCount must keep
  // spreading rather than pinning to acct-0 once warm-up attempts are exhausted.
  const picks = Array.from({ length: 12 }, () => am.getActiveAccount().name);
  assert.deepEqual(picks, [
    'acct-0', 'acct-1', 'acct-2', 'acct-0', 'acct-1', 'acct-2',
    'acct-0', 'acct-1', 'acct-2', 'acct-0', 'acct-1', 'acct-2',
  ]);
});

test('warm-up gives up on an account after maxWarmupTries and lets priority start', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 5 * MIN);
  const now = Date.now();
  measure(am, 0, 0.30, 4 * HOUR, now);   // acct-0 measured; acct-1 keeps failing before headers
  // acct-1 is a warm-up target; route to it maxWarmupTries times (no measurement)
  for (let i = 0; i < am.maxWarmupTries; i++) {
    assert.equal(am.getActiveAccount().name, 'acct-1');
  }
  // attempts exhausted → warm-up stops → priority over measured accounts (only acct-0)
  assert.equal(am.getActiveAccount().name, 'acct-0');
});

test('warm-up skips unavailable accounts', () => {
  const am = new AccountManager(makeAccounts(2), 0.98);
  am.accounts[0].status = 'error';               // unavailable → never warmed
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

// Regression: a request that returns NO rate-limit headers (a HEAD / health
// check, a 404, an auth failure) must NOT permanently disqualify the account
// from warm-up. Otherwise it stays "unmeasured" forever — sorted to the bottom
// of use-or-lose priority (no reset data) and bounced by the unmeasured-
// rebalance — so rotation never uses it and its token never refreshes.
// (Real-world: maestrobs74/77 stuck unmeasured with expired tokens.)
test('a header-less response does not trap an account as permanently unmeasured', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 5 * MIN);
  const now = Date.now();
  measure(am, 0, 0.10, 4 * HOUR, now);                  // acct-0 healthy + measured

  // acct-1 gets a warm-up request that returns no rate-limit headers:
  // updateQuota with empty headers bumps totalRequests but leaves it unmeasured.
  assert.equal(am.getActiveAccount().name, 'acct-1');   // warm-up routes to it
  am.updateQuota(1, {});                                 // header-less response
  assert.equal(am.accounts[1].usage.totalRequests, 1);
  assert.equal(am._isMeasured(am.accounts[1]), false);

  // It must STILL be a warm-up target (not abandoned), so a real measurement
  // can still happen. On the OLD code this returned acct-0 (acct-1 trapped).
  assert.equal(am.getActiveAccount().name, 'acct-1');

  // Once a header-bearing response measures it, warm-up stops and use-or-lose
  // priority takes over (acct-1 resets soonest → chosen).
  measure(am, 1, 0.10, 5 * MIN, now);
  assert.equal(am._isMeasured(am.accounts[1]), true);
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

// ── model-scoped weekly windows (7d_oi — the "Fable" weekly limit) ────────────

test('updateQuota parses model-scoped weekly windows (7d_oi) generically', () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  const now = Date.now();
  const resetSec = Math.floor((now + 4 * 24 * HOUR) / 1000);
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-utilization': '0.54',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + HOUR) / 1000)),
    'anthropic-ratelimit-unified-7d-utilization': '0.86',
    'anthropic-ratelimit-unified-7d-reset': String(resetSec),
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.94',
    'anthropic-ratelimit-unified-7d_oi-reset': String(resetSec),
    'anthropic-ratelimit-unified-7d_oi-status': 'allowed_warning',
  });
  const win = am.accounts[0].quota.modelWeekly['7d_oi'];
  assert.equal(win.utilization, 0.94);
  assert.equal(win.reset, resetSec * 1000, 'reset normalized to ms');
  // The plain 7d window is untouched by the model-scoped one.
  assert.equal(am.accounts[0].quota.unified7d, 0.86);
});

test('a fresh model-scoped weekly limit blocks only the matching model family', () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  const now = Date.now();
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-utilization': '0.30',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + HOUR) / 1000)),
    'anthropic-ratelimit-unified-7d-utilization': '0.50',
    'anthropic-ratelimit-unified-7d-reset': String(Math.floor((now + 24 * HOUR) / 1000)),
    // Fable weekly exhausted — the account still serves every other model.
    'anthropic-ratelimit-unified-7d_oi-utilization': '1.01',
    'anthropic-ratelimit-unified-7d_oi-reset': String(Math.floor((now + 24 * HOUR) / 1000)),
  });
  assert.equal(am._isAvailable(am.accounts[0]), true);
  assert.equal(am._isAvailable(am.accounts[0], 'claude-fable-5'), false);
  assert.equal(am._isAvailable(am.accounts[0], 'claude-mythos-5'), false);
  assert.equal(am._isAvailable(am.accounts[0], 'claude-opus-4-8'), true);
  assert.equal(am.getActiveAccount().name, 'acct-0');
});

test('Opus remains eligible when the Fable/Mythos 7d_oi window is exhausted', async () => {
  const am = new AccountManager([
    { ...makeAccounts(1)[0], name: 'fable-full', priority: 0 },
    { ...makeAccounts(1)[0], name: 'fallback', accessToken: 'tok-ready', priority: 1 },
  ], 0.98);
  am.accounts[0].quota.modelWeekly['7d_oi'] = {
    utilization: 1,
    reset: Date.now() + HOUR,
  };

  const opus = await am.acquireAccount(null, 0, null, null, 'claude-opus-4-8');
  assert.equal(opus.name, 'fable-full', 'Fable quota must not pre-block the Opus fallback');
  am.releaseAccount(opus);
});

test('unknown and expired model-scoped cache do not pre-block the request that can refresh it', async () => {
  const cases = [
    ['unknown', null],
    ['missing-utilization', { reset: Date.now() + HOUR }],
    ['non-finite-utilization', { utilization: Number.NaN, reset: Date.now() + HOUR }],
    ['missing-reset', { utilization: 1 }],
    ['expired', { utilization: 1, reset: Date.now() - 1 }],
  ];

  for (const [name, window] of cases) {
    const am = new AccountManager([
      { ...makeAccounts(1)[0], name },
    ], 0.98);
    if (window) am.accounts[0].quota.modelWeekly['7d_oi'] = window;

    const fable = await am.acquireAccount(null, 0, null, null, 'claude-fable-5');
    assert.equal(fable.name, name, `${name} cache must still reach upstream for refresh`);
    am.releaseAccount(fable);
    if (name === 'expired') {
      assert.deepEqual(am.accounts[0].quota.modelWeekly, {}, 'expired cache is swept during selection');
    }
  }
});

test('all fresh Fable-full accounts return null without recovery', async () => {
  const am = new AccountManager(makeAccounts(2), 0.98);
  for (const account of am.accounts) {
    account.quota.modelWeekly['7d_oi'] = {
      utilization: 1,
      reset: Date.now() + HOUR,
    };
  }
  am.accounts[0].rateLimitedUntil = Date.now() - 1;

  const fable = await am.acquireAccount(null, 0, null, null, 'claude-fable-5');
  assert.equal(fable, null);
});

test('fresh Fable-full preferred account is skipped for Fable routing', async () => {
  const am = new AccountManager([
    { ...makeAccounts(1)[0], name: 'fable-full', priority: 0 },
    { ...makeAccounts(1)[0], name: 'fable-ready', accessToken: 'tok-ready', priority: 1 },
  ], 0.98);
  am.accounts[0].quota.modelWeekly['7d_oi'] = {
    utilization: 1,
    reset: Date.now() + HOUR,
  };

  const fable = await am.acquireAccount(null, 0, null, null, 'claude-fable-5');
  assert.equal(fable.name, 'fable-ready');
  am.releaseAccount(fable);
});

test('live 7d_oi data classifies Fable/Mythos 429s while routing to a ready account', async () => {
  const am = new AccountManager([
    { ...makeAccounts(1)[0], name: 'fable-full', priority: 0 },
    { ...makeAccounts(1)[0], name: 'fable-ready', accessToken: 'tok-ready', priority: 1 },
  ], 0.98);
  am.accounts[0].quota.modelWeekly['7d_oi'] = {
    utilization: 1,
    reset: Date.now() + HOUR,
  };
  for (let i = 0; i < am.accounts.length; i++) {
    setSession(am, i, 0.1, HOUR);
    setWeekly(am, i, 0.1, HOUR);
  }

  for (const model of ['claude-fable-5', 'claude-mythos-5']) {
    assert.equal(am.isModelExhausted(am.accounts[0], model), true,
      `${model} must classify the live 7d_oi window`);
    const acct = await am.acquireAccount(null, 0, null, null, model);
    assert.equal(acct.name, 'fable-ready', `${model} must skip the fresh exhausted window`);
    am.releaseAccount(acct);
  }
  assert.equal(am.isModelExhausted(am.accounts[0], 'claude-opus-4-8'), false);
});

test('model-scoped exhaustion requires a finite future complete window', () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  const now = Date.now();
  const incompleteOrStale = [
    ['null reset', { utilization: 1, reset: null }],
    ['non-finite reset (NaN)', { utilization: 1, reset: Number.NaN }],
    ['non-finite reset (Infinity)', { utilization: 1, reset: Number.POSITIVE_INFINITY }],
    ['non-finite utilization (NaN)', { utilization: Number.NaN, reset: now + HOUR }],
    ['non-finite utilization (Infinity)', { utilization: Number.POSITIVE_INFINITY, reset: now + HOUR }],
    ['past reset', { utilization: 1, reset: now - 1 }],
  ];

  for (const [name, window] of incompleteOrStale) {
    am.accounts[0].quota.modelWeekly['7d_oi'] = window;
    assert.equal(am.isModelExhausted(0, 'claude-fable-5'), false,
      `${name} must not classify the model as exhausted`);
  }

  am.accounts[0].quota.modelWeekly['7d_oi'] = {
    utilization: 1,
    reset: now + HOUR,
  };
  assert.equal(am.isModelExhausted(0, 'claude-fable-5'), true,
    'a finite full window with a future reset must classify the model as exhausted');
});

test('a headerless response clears stale unifiedStatus across models', () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  const reset = String(Math.floor((Date.now() + HOUR) / 1000));
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-5h-utilization': '0.1',
    'anthropic-ratelimit-unified-5h-reset': reset,
    'anthropic-ratelimit-unified-7d-utilization': '0.1',
    'anthropic-ratelimit-unified-7d-reset': reset,
    'anthropic-ratelimit-unified-7d_oi-utilization': '1',
    'anthropic-ratelimit-unified-7d_oi-reset': reset,
  });
  assert.equal(am.isModelExhausted(0, 'claude-fable-5'), true);
  assert.equal(am.isExhausted(0), true);

  am.updateQuota(0, {});
  assert.equal(am.accounts[0].quota.unifiedStatus, null);
  assert.equal(am.isExhausted(0), false,
    'a later transient 429 must not inherit another response status');
});

// Regression (review finding): a partial header pair — 7d-reset present but
// 7d-utilization missing/garbled — leaves a reset timestamp with no utilization.
// The expiry sweep used to be gated on `unified7d != null`, so that stale PAST
// timestamp survived forever and, with weekly-first ordering, permanently biased
// selection toward the account. The sweep must clear reset times independently.
test('a stale reset-only weekly timestamp is cleared (no permanent selection bias)', () => {
  const am = new AccountManager(makeAccounts(2), 0.98);
  const now = Date.now();
  setSession(am, 0, 0.20, 4 * HOUR, now);
  setSession(am, 1, 0.20, 4 * HOUR, now);
  // acct-0 got a garbled pair: reset set (already in the past), utilization never set.
  am.accounts[0].quota.unified7dReset = now - 1000;
  setWeekly(am, 1, 0.40, 3 * 24 * HOUR, now);
  am.getActiveAccount();                       // _isAvailable → expiry sweep
  assert.equal(am.accounts[0].quota.unified7dReset, null, 'stale reset-only timestamp swept');
  assert.equal(am._weeklyResetTime(am.accounts[0]), Infinity, 'no longer sorts as "resets soonest"');
});

// A FUTURE reset-only value (utilization missing/garbled) must not outrank an
// account with no 7d data either — the weekly window counts only when both
// utilization and reset are present ("no weekly data ranks at Infinity").
test('a reset-only weekly window (no utilization) does not bias weekly ordering', () => {
  const am = new AccountManager(makeAccounts(2), 0.98);
  const now = Date.now();
  setSession(am, 0, 0.20, 4 * HOUR, now);
  am.accounts[0].quota.unified7dReset = now + 60_000;   // future reset, utilization never set
  setSession(am, 1, 0.20, 5 * MIN, now);                // no 7d data, soonest session
  assert.equal(am._weeklyResetTime(am.accounts[0]), Infinity, 'partial window ranks at Infinity');
  assert.equal(am.getActiveAccount().name, 'acct-1', 'weekly tie → soonest session still wins');
});

test('an expired model-scoped weekly window is cleared lazily', () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  const now = Date.now();
  setSession(am, 0, 0.30, 4 * HOUR, now);
  am.accounts[0].quota.modelWeekly['7d_oi'] = { utilization: 0.94, reset: now - 1000 };
  am.getActiveAccount();               // runs _isNearQuota → lazy expiry sweep
  assert.deepEqual(am.accounts[0].quota.modelWeekly, {}, 'stale window removed after its reset passed');
});

// Regression (user report): ordering must follow reset ROLLOVERS continuously,
// not just at set-time. A reset timestamp that has passed is the SMALLEST value,
// so without clamping it pinned the account at the top of the auto order until
// a request-path sweep happened to clear it.
test('a reset that has rolled over stops ranking as "soonest" immediately (no sweep needed)', () => {
  const now = Date.now();
  const am = new AccountManager(makeAccounts(2), 0.98);
  setWeekly(am, 0, 0.40, -1000, now);            // acct-0's week just rolled over (past)
  setWeekly(am, 1, 0.40, 3 * 24 * HOUR, now);    // acct-1 resets in 3 days
  assert.equal(am._weeklyResetTime(am.accounts[0]), Infinity, 'past weekly reset ranks at Infinity');
  assert.equal(am.autoCompare(am.accounts[0], am.accounts[1]) > 0, true,
    'rolled-over account no longer outranks the future-reset account');
  // Session rollover behaves the same for the tiebreak.
  setSession(am, 0, 0.10, -1000, now);
  assert.equal(am._sessionResetTime(am.accounts[0]), Infinity, 'past session reset ranks at Infinity');
});

test('sweepExpired clears rolled-over windows so warm-up can re-measure (idle proxy)', () => {
  const now = Date.now();
  const am = new AccountManager(makeAccounts(1), 0.98);
  setSession(am, 0, 0.50, -1000, now);           // both windows already rolled over
  setWeekly(am, 0, 0.60, -1000, now);
  am.accounts[0].quota.modelWeekly['7d_oi'] = { utilization: 0.9, reset: now - 1000 };
  assert.equal(am._isMeasured(am.accounts[0]), true, 'stale values still present before sweep');
  am.sweepExpired();
  assert.equal(am.accounts[0].quota.unified5h, null);
  assert.equal(am.accounts[0].quota.unified7d, null);
  assert.deepEqual(am.accounts[0].quota.modelWeekly, {});
  assert.equal(am._isMeasured(am.accounts[0]), false, 'back to unmeasured → warm-up target again');
});

// ── quota snapshot persistence (survives a server restart) ───────────────────

test('exportQuotaState → importQuotaState restores general quota but re-measures modelWeekly', () => {
  const now = Date.now();
  const am1 = new AccountManager(makeAccounts(2), 0.98);
  am1.accounts[0].accountUuid = 'uuid-0';
  setSession(am1, 0, 0.54, 1 * HOUR, now);
  setWeekly(am1, 0, 0.86, 4 * 24 * HOUR, now);
  am1.accounts[0].quota.modelWeekly['7d_oi'] = { utilization: 0.94, reset: now + 4 * 24 * HOUR };
  am1.markRateLimited(0, 120);                       // throttled 2 min into the future
  am1.updateQuota(1, {});                            // bump usage counters only

  const snapshot = JSON.parse(JSON.stringify(am1.exportQuotaState())); // via-disk fidelity
  assert.deepEqual(snapshot[0].quota.modelWeekly, {},
    'response-derived model windows are not persisted');

  snapshot[0].quota.modelWeekly['7d_oi'] = {
    utilization: 1,
    reset: now + 4 * 24 * HOUR,
  };

  const am2 = new AccountManager(makeAccounts(2), 0.98);
  am2.accounts[0].accountUuid = 'uuid-0';
  am2.importQuotaState(snapshot);
  assert.equal(am2.accounts[0].quota.unified5h, 0.54);
  assert.equal(am2.accounts[0].quota.unified7d, 0.86);
  assert.deepEqual(am2.accounts[0].quota.modelWeekly, {},
    'response-derived model windows are dropped to avoid a restart self-lock');
  assert.equal(am2.accounts[0].status, 'throttled', 'future throttle restored');
  assert.equal(am2._isMeasured(am2.accounts[0]), true, 'restored account skips warm-up');
  assert.equal(am2.accounts[1].usage.totalRequests, 1, 'usage counters carried over');
});

// Regression (review finding): unifiedStatus is a per-response signal that
// isExhausted() reads as "this 429 is account exhaustion". A stale 'rejected'
// restored from a snapshot would misclassify a later transient/headerless 429
// as exhaustion and wrongly throttle the account.
test('importQuotaState never restores unifiedStatus (stale rejected must not classify future 429s)', () => {
  const now = Date.now();
  const am = new AccountManager(makeAccounts(1), 0.98);
  am.importQuotaState([{
    name: 'acct-0',
    quota: { unified5h: 0.1, unified5hReset: now + HOUR, unifiedStatus: 'rejected' },
  }]);
  assert.equal(am.accounts[0].quota.unified5h, 0.1, 'quota values restored');
  assert.equal(am.accounts[0].quota.unifiedStatus, null, 'stale unifiedStatus dropped');
  am.updateQuota(0, {});                             // a later header-less 429's updateQuota
  assert.equal(am.isExhausted(0), false, 'transient 429 not misclassified as exhaustion');
});

// Regression (review finding): a snapshot entry WITH a uuid must never fall
// back to name matching — a same-name account with a different uuid is a
// replaced account, and inheriting the old throttle would falsely 429 it.
test('importQuotaState does not restore state onto a replaced (same-name, new-uuid) account', () => {
  const now = Date.now();
  const am = new AccountManager(makeAccounts(1), 0.98);
  am.accounts[0].accountUuid = 'uuid-new';
  am.importQuotaState([{
    accountUuid: 'uuid-old', name: 'acct-0',           // same name, different identity
    quota: { unified5h: 0.99, unified5hReset: now + HOUR },
    rateLimitedUntil: now + 60_000,
  }]);
  assert.equal(am.accounts[0].quota.unified5h, null, 'replaced account starts unmeasured');
  assert.equal(am.accounts[0].status, 'active', 'old throttle NOT inherited');
});

test('importQuotaState skips unknown accounts, expired throttles, and tolerates an old cache shape', () => {
  const now = Date.now();
  const am = new AccountManager(makeAccounts(1), 0.98);
  am.importQuotaState([
    { name: 'ghost', quota: { unified5h: 0.9 } },                       // no such account → skipped
    { name: 'acct-0',
      quota: { unified5h: 0.3, unified5hReset: now + HOUR },            // old cache: no modelWeekly field
      rateLimitedUntil: now - 5000 },                                   // throttle already expired
    null, 'garbage',                                                    // corrupt entries → ignored
  ]);
  assert.equal(am.accounts[0].quota.unified5h, 0.3);
  assert.deepEqual(am.accounts[0].quota.modelWeekly, {}, 'missing modelWeekly backfilled to {}');
  assert.equal(am.accounts[0].status, 'active', 'expired throttle NOT restored');
  assert.equal(am.accounts[0].rateLimitedUntil, null);
});

test('importQuotaState keeps auth-revoked status ahead of a restored throttle', () => {
  const am = new AccountManager([{
    ...makeAccounts(1)[0],
    authRevoked: true,
    expiresAt: Date.now() - HOUR,
  }], 0.98);
  am.importQuotaState([{
    name: 'acct-0',
    rateLimitedUntil: Date.now() + HOUR,
  }]);
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(am.accounts[0].errorReason, 'auth-revoked');
  assert.equal(am.accounts[0].authRevoked, true);
  assert.equal(am.accounts[0].rateLimitedUntil, null);
});

test('getStatus exposes modelWeekly as a detached copy', () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  const now = Date.now();
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.94',
    'anthropic-ratelimit-unified-7d_oi-reset': String(Math.floor((now + 24 * HOUR) / 1000)),
  });
  const status = am.getStatus();
  assert.equal(status.accounts[0].quota.modelWeekly['7d_oi'].utilization, 0.94);
  status.accounts[0].quota.modelWeekly['7d_oi'].utilization = 0;
  assert.equal(am.accounts[0].quota.modelWeekly['7d_oi'].utilization, 0.94,
    'mutating the snapshot must not reach live account state');
});

test('getStatus hides stable account identity by default and exposes it only internally', () => {
  const am = new AccountManager([{
    name: 'same-name',
    type: 'oauth',
    accountUuid: 'uuid-safe',
    accessToken: 'secret-access',
    refreshToken: 'secret-refresh',
    expiresAt: Date.now() + HOUR,
  }], 0.98, 0, 5);

  const status = am.getStatus({ includeIdentity: true });
  assert.equal(status.currentAccountUuid, 'uuid-safe');
  assert.equal(status.accounts[0].accountUuid, 'uuid-safe');
  assert.equal('accessToken' in status.accounts[0], false);
  assert.equal('refreshToken' in status.accounts[0], false);
  const publicStatus = am.getStatus();
  assert.equal('currentAccountUuid' in publicStatus, false);
  assert.equal('accountUuid' in publicStatus.accounts[0], false);
});

// ── errorReason: WHY an account is parked, and who is usable now ────────────

function fetchStub(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

test('invalid_grant refresh failure → errorReason auth-revoked; updateAccountTokens heals it', async () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  const acct = am.accounts[0];
  acct.expiresAt = Date.now() - HOUR;   // expired → a failed refresh parks the account
  const restore = fetchStub(async () => ({
    ok: false,
    status: 400,
    text: async () => '{"error":"invalid_grant","error_description":"Refresh token revoked"}',
    body: { cancel: async () => {} },
  }));
  try { await am.ensureTokenFresh(0); } finally { restore(); }

  assert.equal(acct.status, 'error');
  assert.equal(acct.errorReason, 'auth-revoked');
  const parked = am.getStatus();
  assert.equal(parked.accounts[0].errorReason, 'auth-revoked');
  assert.equal(parked.accounts[0].usable, false);
  assert.equal(parked.usableCount, 0);
  assert.equal(parked.totalCount, 1);

  // Re-import/login (updateAccountTokens) is the heal path — reason must clear.
  am.updateAccountTokens(0, { accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: Date.now() + HOUR });
  assert.equal(acct.status, 'active');
  assert.equal(acct.errorReason, undefined);
  const healed = am.getStatus();
  assert.equal(healed.accounts[0].errorReason, null);
  assert.equal(healed.accounts[0].usable, true);
  assert.equal(healed.usableCount, 1);
});

test('invalid_grant quarantine survives a restart and prevents another refresh attempt', async () => {
  const source = makeAccounts(1);
  source[0].expiresAt = Date.now() - HOUR;
  const am = new AccountManager(source, 0.98);
  let refreshCalls = 0;
  const restore = fetchStub(async () => {
    refreshCalls++;
    return {
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant","error_description":"Refresh token revoked"}',
      body: { cancel: async () => {} },
    };
  });
  try {
    await am.ensureTokenFresh(0);
  } finally {
    restore();
  }

  assert.equal(refreshCalls, 1);
  assert.equal(am.accounts[0].authRevoked, true, 'the revoked marker must be durable state');
  const persisted = { ...source[0], authRevoked: am.accounts[0].authRevoked };
  const restarted = new AccountManager([persisted], 0.98);
  assert.equal(restarted.accounts[0].status, 'error');
  assert.equal(restarted.accounts[0].errorReason, 'auth-revoked');
  assert.equal(restarted.accounts[0].authRevoked, true);

  let unexpectedRefresh = false;
  const restartRestore = fetchStub(async () => {
    unexpectedRefresh = true;
    throw new Error('restart must not retry a revoked refresh token');
  });
  try {
    await restarted.ensureTokenFresh(0, true);
  } finally {
    restartRestore();
  }
  assert.equal(unexpectedRefresh, false);
});

test('stale invalid_grant from an old refresh cannot quarantine a newly reauthenticated credential', async () => {
  const source = makeAccounts(1);
  source[0].expiresAt = Date.now() - HOUR;
  const am = new AccountManager(source, 0.98);
  let releaseRefresh;
  let refreshStarted;
  const started = new Promise(resolve => { refreshStarted = resolve; });
  const restore = fetchStub(async () => {
    refreshStarted();
    await new Promise(resolve => { releaseRefresh = resolve; });
    return {
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant"}',
      body: { cancel: async () => {} },
    };
  });
  try {
    const pending = am.ensureTokenFresh(0);
    await started;

    am.updateAccountTokens(0, {
      accessToken: 'fresh-at',
      refreshToken: 'fresh-rt',
      expiresAt: Date.now() + HOUR,
    }, false);
    releaseRefresh();
    await pending;
  } finally {
    restore();
  }

  assert.equal(am.accounts[0].credential, 'fresh-at');
  assert.equal(am.accounts[0].refreshToken, 'fresh-rt');
  assert.equal(am.accounts[0].authRevoked, undefined,
    'the old refresh result must not re-park a fresh credential');
  assert.equal(am.accounts[0].status, 'active');
});

test('stale invalid_grant cannot quarantine a credential reinstalled with the same token strings', async () => {
  const source = makeAccounts(1);
  source[0].expiresAt = Date.now() - HOUR;
  const am = new AccountManager(source, 0.98);
  let releaseRefresh;
  let refreshStarted;
  const started = new Promise(resolve => { refreshStarted = resolve; });
  const restore = fetchStub(async () => {
    refreshStarted();
    await new Promise(resolve => { releaseRefresh = resolve; });
    return {
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant"}',
      body: { cancel: async () => {} },
    };
  });
  try {
    const pending = am.ensureTokenFresh(0);
    await started;

    am.updateAccountTokens(0, {
      accessToken: source[0].accessToken,
      refreshToken: source[0].refreshToken,
      expiresAt: Date.now() + HOUR,
    }, false);
    releaseRefresh();
    await pending;
  } finally {
    restore();
  }

  assert.equal(am.accounts[0].authRevoked, undefined,
    'a credential installation is newer evidence even when token strings compare equal');
  assert.equal(am.accounts[0].status, 'active');
});

test('auth-revoked quarantine notifies persistence and only fresh credentials clear it', async () => {
  const source = makeAccounts(1);
  source[0].expiresAt = Date.now() - HOUR;
  const am = new AccountManager(source, 0.98);
  const events = [];
  am.onAuthRevoked((account, revoked) => {
    events.push({ name: account.name, revoked });
  });
  const restore = fetchStub(async () => ({
    ok: false,
    status: 400,
    text: async () => '{"error":"invalid_grant"}',
    body: { cancel: async () => {} },
  }));
  try { await am.ensureTokenFresh(0); } finally { restore(); }

  assert.deepEqual(events, [{ name: 'acct-0', revoked: true }]);
  am.updateAccountTokens(0, {
    accessToken: 'fresh-at', refreshToken: 'fresh-rt', expiresAt: Date.now() + HOUR,
  });
  assert.deepEqual(events, [
    { name: 'acct-0', revoked: true },
    { name: 'acct-0', revoked: false },
  ]);
  assert.equal(am.accounts[0].authRevoked, undefined);
  assert.equal(am.accounts[0].status, 'active');
});

test('unverified credential sync keeps an auth-revoked account parked', () => {
  const am = new AccountManager([{
    ...makeAccounts(1)[0],
    authRevoked: true,
    expiresAt: Date.now() - HOUR,
  }], 0.98);
  am.updateAccountTokens(0, {
    accessToken: 'unverified-at',
    refreshToken: 'unverified-rt',
    expiresAt: Date.now() + HOUR,
  }, false, { clearAuthRevoked: false });

  assert.equal(am.accounts[0].authRevoked, true);
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(am.accounts[0].errorReason, 'auth-revoked');
});

test('restored auth-revoked accounts stay out of selection, recovery, and affinity', async () => {
  const am = new AccountManager([
    { ...makeAccounts(1)[0], authRevoked: true, expiresAt: Date.now() - HOUR },
    { ...makeAccounts(1)[0], name: 'acct-1', accessToken: 'tok-1', refreshToken: 'r-1' },
  ], 0.98, 0, 1);
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(am.accounts[0].errorReason, 'auth-revoked');
  assert.equal(am.getActiveAccount().name, 'acct-1');
  assert.equal(am._recoverSoonest(), null);

  const socket = {};
  const acquired = await am.acquireAccount(null, socket);
  assert.equal(acquired.name, 'acct-1');
  am.releaseAccount(acquired);
  assert.equal(am.accounts[0].inflight, 0);
});

test('auth-revoked quarantine stays authoritative when subscription access is also disabled', () => {
  const am = new AccountManager([{
    ...makeAccounts(1)[0],
    authRevoked: true,
    subscriptionDisabled: true,
    expiresAt: Date.now() - HOUR,
  }], 0.98);
  const account = am.accounts[0];

  assert.equal(account.status, 'error');
  assert.equal(account.errorReason, 'auth-revoked',
    'a revoked refresh token must not be masked as a subscription lapse');

  am.setSubscriptionDisabled(account, false, false);
  assert.equal(account.status, 'error');
  assert.equal(account.errorReason, 'auth-revoked',
    'clearing the secondary flag must not make a revoked account look active');

  am.setAuthRevoked(account, false, false);
  assert.equal(account.status, 'active');
  assert.equal(account.errorReason, undefined);
});

test('auth quarantine persistence callbacks carry a monotonic state generation', () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  const events = [];
  am.onAuthRevoked((_account, revoked, _previousTokens, generation) => {
    events.push({ revoked, generation });
  });

  am.setAuthRevoked(am.accounts[0], true);
  am.setAuthRevoked(am.accounts[0], false);

  assert.deepEqual(events, [
    { revoked: true, generation: 1 },
    { revoked: false, generation: 2 },
  ]);
});

test('a non-invalid_grant refresh failure → errorReason refresh-failed', async () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  const acct = am.accounts[0];
  acct.expiresAt = Date.now() - HOUR;
  const restore = fetchStub(async () => { throw new Error('fetch failed'); });
  try { await am.ensureTokenFresh(0); } finally { restore(); }
  assert.equal(acct.status, 'error');
  assert.equal(acct.errorReason, 'refresh-failed');
});

test('usable is false for disabled, throttled, and over-threshold accounts', () => {
  const am = new AccountManager(makeAccounts(4), 0.98);
  am.setEnabled('acct-1', false);
  am.accounts[2].status = 'throttled';
  am.accounts[2].rateLimitedUntil = Date.now() + HOUR;
  setSession(am, 3, 0.99, HOUR);   // over switchThreshold
  const status = am.getStatus();
  assert.deepEqual(status.accounts.map(a => a.usable), [true, false, false, false]);
  assert.equal(status.usableCount, 1);
  assert.equal(status.totalCount, 4);
});

test('status remains unusable when an external mutation restores active status but leaves authRevoked', () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  const account = am.accounts[0];
  account.authRevoked = true;
  account.status = 'active';
  const status = am.getStatus();
  assert.equal(status.accounts[0].usable, false);
});

test('dispatch failure cooldown temporarily excludes an account without persisting health state', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 0);
  const now = Date.now();
  for (let index = 0; index < am.accounts.length; index++) {
    setSession(am, index, 0.1, HOUR, now);
    setWeekly(am, index, 0.1, 2 * HOUR, now);
  }
  am.currentIndex = 0;

  assert.equal(am.markDispatchFailureCooldown(am.accounts[0], 5_000), true);
  assert.equal(am.getActiveAccount(), am.accounts[1], 'the next request avoids the failed account');
  assert.equal(am.accounts[0].status, 'active', 'a transport failure is not a quota or auth error');
  assert.equal(am.getStatus().accounts[0].usable, false, 'status agrees with selection during cooldown');

  const snapshot = am.exportQuotaState();
  assert.equal('dispatchFailureCooldownUntil' in snapshot[0], false, 'the cooldown is process-local');
  const restored = new AccountManager(makeAccounts(2), 0.98, 0);
  restored.importQuotaState(snapshot);
  assert.equal(restored.accounts[0].dispatchFailureCooldownUntil, 0, 'a restart does not revive stale cooldown');

  const coolingOnly = new AccountManager(makeAccounts(1), 0.98, 0);
  coolingOnly.accounts[0].status = 'throttled';
  coolingOnly.accounts[0].rateLimitedUntil = Date.now() - 1;
  assert.equal(coolingOnly.markDispatchFailureCooldown(coolingOnly.accounts[0], 5_000), true);
  assert.equal(coolingOnly._recoverSoonest(), null, 'recovery must not bypass an active cooldown');

  am.accounts[0].dispatchFailureCooldownUntil = Date.now() - 1;
  am.currentIndex = 0;
  assert.equal(am.getActiveAccount(), am.accounts[0], 'expiry restores ordinary selection');
});

// ── persistent subscription-lapse flag (config subscriptionDisabled) ────────

test('config subscriptionDisabled restores the account as a hard subscription error', () => {
  const accts = makeAccounts(2);
  accts[0].subscriptionDisabled = true;
  const am = new AccountManager(accts, 0.98);
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(am.accounts[0].errorReason, 'subscription-disabled');
  // Not refresh-caused: the token-refresh sweep must not revive it.
  assert.equal(am.accounts[0]._errorFromRefresh, false);
  const status = am.getStatus();
  assert.equal(status.accounts[0].errorReason, 'subscription-disabled');
  assert.equal(status.accounts[0].usable, false);
  assert.equal(status.usableCount, 1);
  // Selection routes around the lapsed account.
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('subscriptionDisabled is anthropic-scoped: a codex account ignores it', () => {
  const accts = makeAccounts(1);
  accts[0].provider = 'codex';
  accts[0].subscriptionDisabled = true;
  const am = new AccountManager(accts, 0.98);
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[0].subscriptionDisabled, undefined);
});

test('_recoverSoonest never revives a subscription-disabled account', () => {
  const accts = makeAccounts(1);
  accts[0].subscriptionDisabled = true;
  const am = new AccountManager(accts, 0.98);
  // A past throttle window would revive an ordinary all-unavailable fleet via
  // _recoverSoonest — a lapsed subscription is billing state, not a quota
  // window, so the rollover must not return it to rotation.
  am.accounts[0].rateLimitedUntil = Date.now() - 1000;
  assert.equal(am.getActiveAccount(), null);
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(am.accounts[0].errorReason, 'subscription-disabled');
});

test('re-imported credentials clear subscriptionDisabled and notify the flag hook', () => {
  const accts = makeAccounts(1);
  accts[0].subscriptionDisabled = true;
  const am = new AccountManager(accts, 0.98);
  const events = [];
  am.onAccountFlag((account, disabled) => { events.push([account.name, disabled]); });
  am.updateAccountTokens(0, { accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: Date.now() + HOUR });
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[0].subscriptionDisabled, undefined);
  assert.equal(am.accounts[0].errorReason, undefined);
  assert.deepEqual(events, [['acct-0', false]]);
});

test('setSubscriptionDisabled parks/frees the account and fires the hook only on change', () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  const events = [];
  am.onAccountFlag((account, disabled) => { events.push([account.name, disabled]); });

  am.setSubscriptionDisabled(am.accounts[0], true);
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(am.accounts[0].errorReason, 'subscription-disabled');
  assert.equal(am.accounts[0]._errorFromRefresh, false);

  // Re-flagging an already-flagged account must not churn the config.
  am.setSubscriptionDisabled(am.accounts[0], true);
  assert.deepEqual(events, [['acct-0', true]]);

  am.setSubscriptionDisabled(am.accounts[0], false);
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[0].subscriptionDisabled, undefined);
  assert.equal(am.accounts[0].errorReason, undefined);
  assert.deepEqual(events, [['acct-0', true], ['acct-0', false]]);

  // persist=false applies a disk-sourced change without echoing it back.
  am.setSubscriptionDisabled(am.accounts[0], true, false);
  assert.equal(am.accounts[0].status, 'error');
  assert.deepEqual(events, [['acct-0', true], ['acct-0', false]]);
});

test('clearing subscriptionDisabled leaves an unrelated error parked', () => {
  const am = new AccountManager(makeAccounts(1), 0.98);
  am.accounts[0].status = 'error';
  am.accounts[0].errorReason = 'auth-rejected';
  am.accounts[0]._errorFromRefresh = false;
  am.accounts[0].subscriptionDisabled = true;
  am.setSubscriptionDisabled(am.accounts[0], false);
  assert.equal(am.accounts[0].subscriptionDisabled, undefined);
  // The auth rejection is separate evidence; the flag clear must not lift it.
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(am.accounts[0].errorReason, 'auth-rejected');
});

test('a restored throttle snapshot cannot overwrite the subscription-disabled park', () => {
  const accts = makeAccounts(1);
  accts[0].subscriptionDisabled = true;
  const am = new AccountManager(accts, 0.98);
  am.importQuotaState([{ name: 'acct-0', rateLimitedUntil: Date.now() + HOUR }]);
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(am.accounts[0].errorReason, 'subscription-disabled');
});
