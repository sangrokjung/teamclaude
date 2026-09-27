import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carryOverAccountSettings } from '../src/account-upsert.js';

function fresh() {
  return { name: 'parked@example.com', type: 'oauth', accessToken: 'new', refreshToken: 'new-r', expiresAt: 2 };
}

test('a browser login lifts a manual disable on the account it replaces', () => {
  const account = fresh();
  const result = carryOverAccountSettings(
    { enabled: false, priority: 3, maxConcurrent: 2 },
    account,
    'login',
  );
  assert.equal(account.enabled, undefined);
  assert.equal(account.priority, 3);
  assert.equal(account.maxConcurrent, 2);
  assert.deepEqual(result, { reenabled: true, stillDisabled: false });
});

test('a file import keeps a manual disable and reports it', () => {
  const account = fresh();
  const result = carryOverAccountSettings({ enabled: false }, account, 'import');
  assert.equal(account.enabled, false);
  assert.deepEqual(result, { reenabled: false, stillDisabled: true });
});

test('an enabled account stays as it was on login', () => {
  const account = fresh();
  const result = carryOverAccountSettings({ enabled: true }, account, 'login');
  assert.equal(account.enabled, true);
  assert.deepEqual(result, { reenabled: false, stillDisabled: false });
});

test('an account with no enabled flag is left unset', () => {
  const account = fresh();
  const result = carryOverAccountSettings({}, account, 'login');
  assert.equal('enabled' in account, false);
  assert.deepEqual(result, { reenabled: false, stillDisabled: false });
});

test('subscription cancellation tracking survives a login', () => {
  const account = fresh();
  const cancellation = { state: 'scheduled', endsAt: 5 };
  carryOverAccountSettings({ enabled: false, subscriptionCancellation: cancellation }, account, 'login');
  assert.deepEqual(account.subscriptionCancellation, cancellation);
});
