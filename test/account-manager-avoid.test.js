import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const HOUR = 3600_000;

function makeAccounts(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `acct-${i}`,
    type: 'oauth',
    accessToken: `tok-${i}`,
    refreshToken: `r-${i}`,
    expiresAt: Date.now() + HOUR,
  }));
}

// Measured accounts with acct-0 strictly preferred (soonest weekly reset), so
// neither cold-start warm-up nor a use-or-lose tie can explain a switch.
function measured(n) {
  const am = new AccountManager(makeAccounts(n), 0.98);
  const now = Date.now();
  am.accounts.forEach((a, i) => {
    a.quota.unified5h = 0.1;
    a.quota.unified5hReset = now + HOUR;
    a.quota.unified7d = 0.1;
    a.quota.unified7dReset = now + (i + 1) * HOUR;
  });
  return am;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('noteUpstreamFailure steers the next acquire to another account without moving the sticky primary', async () => {
  const am = measured(2);
  const first = await am.acquireAccount();
  assert.equal(first.name, 'acct-0');
  am.releaseAccount(first);
  const primaryBefore = am.currentIndex;

  assert.equal(am.noteUpstreamFailure(first, null, 30_000, 'HTTP 503 after dispatch'), true);
  const second = await am.acquireAccount();
  assert.equal(second.name, 'acct-1', 'the client retry must not land on the account that just failed');
  assert.equal(am.currentIndex, primaryBefore, 'steering is per-request; the sticky primary is untouched');
  assert.equal(first.status, 'active', 'a soft steer-away never changes account status');
  am.releaseAccount(second);
});

test('an avoided account serves again once the window expires', async () => {
  const am = measured(2);
  const a = await am.acquireAccount();
  am.releaseAccount(a);
  am.noteUpstreamFailure(a, null, 40);
  const b = await am.acquireAccount();
  assert.equal(b.name, 'acct-1');
  am.releaseAccount(b);
  await sleep(60);
  const again = await am.acquireAccount();
  assert.equal(again.name, 'acct-0', 'expiry restores the preferred account');
  assert.equal(a.avoidUntil, null, 'an expired window is cleared lazily');
  am.releaseAccount(again);
});

test('a single-account pool keeps serving while its only account is avoided', async () => {
  const am = measured(1);
  const a = await am.acquireAccount();
  am.releaseAccount(a);
  am.noteUpstreamFailure(a, null, 30_000);
  const again = await am.acquireAccount();
  assert.equal(again, a, 'soft avoidance must never leave a request with no account');
  am.releaseAccount(again);
});

test('avoidance falls back to the failed account rather than queueing when every alternative is capped', async () => {
  const am = measured(2);
  am.accounts.forEach(acc => { acc.maxConcurrent = 1; });
  const b = am.accounts[1];
  b.inflight = 1; // acct-1 at its cap
  am.noteUpstreamFailure(am.accounts[0], null, 30_000);
  const got = am._tryAcquire();
  assert.equal(got, am.accounts[0], 'a capped alternative is not a reason to wait; the failed account still has capacity');
  am.releaseAccount(got);
});

test('noteUpstreamFailure drops this connection\'s affinity so its retry re-homes on the working account', async () => {
  const am = measured(2);
  const socket = {}; // affinity key = the client socket object
  const a = await am.acquireAccount(null, 0, null, socket);
  assert.equal(a.name, 'acct-0');
  am.releaseAccount(a);
  assert.equal(am._affinity.get(socket), a, 'first acquire homes the connection');

  am.noteUpstreamFailure(a, socket, 30_000);
  assert.equal(am._affinity.has(socket), false, 'the failing home is forgotten');

  const b = await am.acquireAccount(null, 0, null, socket);
  assert.equal(b.name, 'acct-1');
  assert.equal(am._affinity.get(socket), b, 'the connection re-homes on the account that served the retry');
  am.releaseAccount(b);

  const c = await am.acquireAccount(null, 0, null, socket);
  assert.equal(c.name, 'acct-1', 'later requests on the connection stay on the working account');
  am.releaseAccount(c);
});

test('a different connection\'s affinity is left alone', async () => {
  const am = measured(2);
  const mine = {};
  const theirs = {};
  const a = await am.acquireAccount(null, 0, null, theirs);
  am.releaseAccount(a);
  am.noteUpstreamFailure(a, mine, 30_000);
  assert.equal(am._affinity.get(theirs), a, 'only the failing connection loses its home');
});

test('avoidMs of 0 is a no-op (config upstreamFailureAvoidMs: 0 disables steering)', async () => {
  const am = measured(2);
  const a = await am.acquireAccount();
  am.releaseAccount(a);
  assert.equal(am.noteUpstreamFailure(a, null, 0), false);
  assert.equal(a.avoidUntil, null);
  const again = await am.acquireAccount();
  assert.equal(again, a);
  am.releaseAccount(again);
});

test('repeated failures extend the window but never shorten it', async () => {
  const am = measured(2);
  const a = am.accounts[0];
  am.noteUpstreamFailure(a, null, 30_000);
  const first = a.avoidUntil;
  am.noteUpstreamFailure(a, null, 1_000);
  assert.equal(a.avoidUntil, first, 'a shorter follow-up window does not cut the existing one');
  am.noteUpstreamFailure(a, null, 60_000);
  assert.ok(a.avoidUntil > first, 'a longer follow-up window extends it');
});
