import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, normalizeQuotaReserve } from '../src/account-manager.js';

const HOUR = 3600_000;
const MIN = 60_000;

function makeAccounts(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `acct-${i}`,
    type: 'oauth',
    accountUuid: `uuid-${i}`,
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

// headroom 0.40 + guardBand 0.05 → session ceiling 0.55
// headroom 0.20 + guardBand 0.05 → weekly  ceiling 0.75
const RESERVE = { name: 'acct-0', session: 0.40, weekly: 0.20, guardBand: 0.05 };

test('no reserve configured: fleet behaves exactly as before', () => {
  const am = new AccountManager(makeAccounts(2), 0.98);
  assert.equal(am.quotaReserve, null);
  // 0.90 is far past any reserve ceiling but well under switchThreshold, so the
  // account must still be selectable — this is the regression guard.
  setSession(am, 0, 0.90, 5 * MIN);
  setSession(am, 1, 0.20, 4 * HOUR);
  assert.equal(am._isAvailable(am.accounts[0]), true);
  assert.equal(am.getActiveAccount().name, 'acct-0');
});

test('reserved account is held out once it crosses the session ceiling', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 5 * MIN, 3, 256, RESERVE);
  setSession(am, 0, 0.56, 4 * HOUR);   // over the 0.55 ceiling
  setSession(am, 1, 0.80, 4 * HOUR);   // heavier, but not reserved
  assert.equal(am._isAvailable(am.accounts[0]), false);
  assert.equal(am._isAvailable(am.accounts[1]), true);
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('reserved account still serves while under the ceiling', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 5 * MIN, 3, 256, RESERVE);
  setSession(am, 0, 0.54, 5 * MIN);    // just under 0.55
  setSession(am, 1, 0.20, 4 * HOUR);
  assert.equal(am._isAvailable(am.accounts[0]), true);
  // soonest session reset wins, so the reserved account is still preferred here
  assert.equal(am.getActiveAccount().name, 'acct-0');
});

test('weekly ceiling is enforced independently of the session window', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 5 * MIN, 3, 256, RESERVE);
  const now = Date.now();
  setSession(am, 0, 0.10, 4 * HOUR, now);   // session is fine
  setWeekly(am, 0, 0.76, 3 * 24 * HOUR, now); // weekly is over the 0.75 ceiling
  setSession(am, 1, 0.30, 4 * HOUR, now);
  setWeekly(am, 1, 0.30, 3 * 24 * HOUR, now);
  assert.equal(am._isAvailable(am.accounts[0]), false);
  assert.equal(am.getActiveAccount().name, 'acct-1');
});

test('the reserve applies only to the named account', () => {
  const am = new AccountManager(makeAccounts(3), 0.98, 5 * MIN, 3, 256, RESERVE);
  setSession(am, 0, 0.60, 4 * HOUR);
  setSession(am, 1, 0.60, 4 * HOUR);
  setSession(am, 2, 0.60, 4 * HOUR);
  assert.equal(am._isAvailable(am.accounts[0]), false);
  assert.equal(am._isAvailable(am.accounts[1]), true);
  assert.equal(am._isAvailable(am.accounts[2]), true);
});

test('matching by accountUuid takes precedence over name', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 5 * MIN, 3, 256,
    { accountUuid: 'uuid-1', session: 0.40, guardBand: 0.05 });
  setSession(am, 0, 0.60, 4 * HOUR);
  setSession(am, 1, 0.60, 4 * HOUR);
  assert.equal(am._isAvailable(am.accounts[0]), true);
  assert.equal(am._isAvailable(am.accounts[1]), false);
});

test('an unmeasured window never reserves the account out', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 5 * MIN, 3, 256, RESERVE);
  // quota.unified5h / unified7d are null on a cold start and again right after a
  // rollover. Failing closed there would be an indefinite disable with no data.
  assert.equal(am.accounts[0].quota.unified5h, null);
  assert.equal(am._isReserveExceeded(am.accounts[0]), false);
  assert.equal(am._isAvailable(am.accounts[0]), true);
});

test('_recoverSoonest does not revive a reserved-out account', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 5 * MIN, 3, 256, RESERVE);
  const now = Date.now();
  // Both accounts are past switchThreshold, so selection falls through to the
  // recover path. acct-0 resets soonest but is over its reserve ceiling; picking
  // it would park currentIndex on an account _tryAcquire then rejects.
  setSession(am, 0, 0.99, -1 * MIN, now);
  setSession(am, 1, 0.99, 1 * MIN, now);
  const recovered = am._recoverSoonest();
  assert.notEqual(recovered && recovered.name, 'acct-0');
});

test('malformed reserve config fails open rather than throwing', () => {
  for (const bad of [null, undefined, {}, 'x', 42, { session: 0.4 }, { name: 'a' },
    { name: 'a', session: 1.5 }, { name: 'a', session: -0.2 }, { name: 'a', session: 'half' }]) {
    assert.equal(normalizeQuotaReserve(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
  const am = new AccountManager(makeAccounts(2), 0.98, 5 * MIN, 3, 256, { name: 'acct-0', session: 2 });
  assert.equal(am.quotaReserve, null);
  setSession(am, 0, 0.90, 4 * HOUR);
  assert.equal(am._isAvailable(am.accounts[0]), true);
});

test('guardBand defaults to 0.05 and shifts the effective ceiling', () => {
  const withDefault = normalizeQuotaReserve({ name: 'acct-0', session: 0.40 });
  assert.equal(withDefault.guardBand, 0.05);

  const am = new AccountManager(makeAccounts(1), 0.98, 5 * MIN, 3, 256,
    { name: 'acct-0', session: 0.40 });
  const ceilings = am._reserveCeilings(am.accounts[0]);
  assert.ok(Math.abs(ceilings.session - 0.55) < 1e-9);
  assert.equal(ceilings.weekly, null);

  // guardBand 0 means the ceiling sits exactly at the requested headroom.
  const strict = new AccountManager(makeAccounts(1), 0.98, 5 * MIN, 3, 256,
    { name: 'acct-0', session: 0.40, guardBand: 0 });
  assert.ok(Math.abs(strict._reserveCeilings(strict.accounts[0]).session - 0.60) < 1e-9);
});

test('name still matches when the account uuid was cleared by a re-login', () => {
  // index.js overwrites accountUuid from a profile fetch that only warns on
  // failure, so a network blip can null it. The reserve must survive that.
  const accts = makeAccounts(2);
  accts[0].accountUuid = null;
  const am = new AccountManager(accts, 0.98, 5 * MIN, 3, 256,
    { accountUuid: 'uuid-0', name: 'acct-0', session: 0.40, guardBand: 0.05 });
  setSession(am, 0, 0.95, 4 * HOUR);
  assert.equal(am._isAvailable(am.accounts[0]), false);
});

test('a headroom of 0 means "do not reserve this window", not a 0.95 ceiling', () => {
  const r = normalizeQuotaReserve({ name: 'acct-0', session: 0, weekly: 0.20, guardBand: 0.05 });
  assert.equal(r.session, null);
  const am = new AccountManager(makeAccounts(1), 0.98, 5 * MIN, 3, 256,
    { name: 'acct-0', session: 0, weekly: 0.20, guardBand: 0.05 });
  const ceilings = am._reserveCeilings(am.accounts[0]);
  assert.equal(ceilings.session, null);
  setSession(am, 0, 0.97, 4 * HOUR);   // would exceed a 0.95 ceiling
  assert.equal(am._isReserveExceeded(am.accounts[0]), false);
});

test('headroom + guardBand reaching 1 is rejected, not clamped to a 0 ceiling', () => {
  // A 0 ceiling with a `>=` comparison holds the account out at utilization 0.0
  // — a permanent, unrecoverable disable. Fail open instead.
  assert.equal(normalizeQuotaReserve({ name: 'acct-0', session: 0.6, guardBand: 0.4 }), null);
  assert.equal(normalizeQuotaReserve({ name: 'acct-0', weekly: 0.95, guardBand: 0.05 }), null);
  const am = new AccountManager(makeAccounts(1), 0.98, 5 * MIN, 3, 256,
    { name: 'acct-0', session: 0.6, guardBand: 0.4 });
  assert.equal(am.quotaReserve, null);
  assert.equal(am._isAvailable(am.accounts[0]), true);   // brand-new window stays usable
});

test('the exact ceiling boundary holds the account out', () => {
  // 1 - 0.4 - 0.05 is 0.5499999999999999 in IEEE754, so a reading of exactly
  // 0.55 must still be treated as over the line.
  const am = new AccountManager(makeAccounts(1), 0.98, 5 * MIN, 3, 256, RESERVE);
  setSession(am, 0, 0.55, 4 * HOUR);
  assert.equal(am._isReserveExceeded(am.accounts[0]), true);
  setSession(am, 0, 0.5499, 4 * HOUR);
  assert.equal(am._isReserveExceeded(am.accounts[0]), false);
});

test('isReserveHeld is exposed for callers outside the class', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 5 * MIN, 3, 256, RESERVE);
  setSession(am, 0, 0.70, 4 * HOUR);
  setSession(am, 1, 0.70, 4 * HOUR);
  assert.equal(am.isReserveHeld(am.accounts[0]), true);
  assert.equal(am.isReserveHeld(am.accounts[1]), false);
});

test('_reserveHeld never leaks into status or the quota snapshot', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 5 * MIN, 3, 256, RESERVE);
  setSession(am, 0, 0.70, 4 * HOUR);
  am._isAvailable(am.accounts[0]);   // drives the transition
  const status = JSON.stringify(am.getStatus());
  assert.equal(status.includes('_reserveHeld'), false);
  if (typeof am.exportQuotaState === 'function') {
    assert.equal(JSON.stringify(am.exportQuotaState()).includes('_reserveHeld'), false);
  }
});

test('a reserved-out account reports usable:false in status', () => {
  const am = new AccountManager(makeAccounts(2), 0.98, 5 * MIN, 3, 256, RESERVE);
  setSession(am, 0, 0.70, 4 * HOUR);
  setSession(am, 1, 0.20, 4 * HOUR);
  const status = am.getStatus({ includeIdentity: true });
  const reserved = status.accounts.find(a => a.name === 'acct-0');
  assert.equal(reserved.usable, false);
  // It is held, not disabled — the distinction the owner asked for.
  assert.equal(reserved.enabled, true);
  assert.equal(reserved.status, 'active');
});
