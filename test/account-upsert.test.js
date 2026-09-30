import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOAuthUpsert, carryOverAccountSettings } from '../src/account-upsert.js';

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

function oauthConfig(overrides = {}) {
  return {
    accounts: [
      { name: 'other@example.com', type: 'oauth', accountUuid: 'uuid-other', accessToken: 'o', refreshToken: 'o-r', expiresAt: 1 },
      {
        name: 'parked@example.com', type: 'oauth', source: 'import', accountUuid: 'uuid-parked',
        accessToken: 'old', refreshToken: 'old-r', expiresAt: 1, enabled: false, priority: 4,
        subscriptionDisabled: true, ...overrides,
      },
    ],
  };
}

const newCreds = { accessToken: 'new', refreshToken: 'new-r', expiresAt: 9 };

test('OAuth login matched by UUID re-enables the parked entry in place', () => {
  const cfg = oauthConfig();
  const result = applyOAuthUpsert(cfg, {
    name: 'parked@example.com',
    creds: newCreds,
    profile: { accountUuid: 'uuid-parked', email: 'parked@example.com' },
    source: 'login',
  });
  assert.equal(cfg.accounts.length, 2);
  const entry = cfg.accounts[1];
  assert.equal('enabled' in entry, false);
  assert.equal(entry.priority, 4);
  assert.equal('subscriptionDisabled' in entry, false);
  assert.equal(entry.accessToken, 'new');
  assert.equal(entry.source, 'login');
  assert.equal(cfg.accounts[0].accessToken, 'o');
  assert.deepEqual(result, {
    action: 'Updated', name: 'parked@example.com', carried: { reenabled: true, stillDisabled: false },
  });
});

test('OAuth import without a profile matches by name and keeps the disable', () => {
  const cfg = oauthConfig();
  const result = applyOAuthUpsert(cfg, {
    name: 'parked@example.com', creds: newCreds, profile: { error: 'HTTP 401' }, source: 'import',
  });
  assert.equal(cfg.accounts[1].enabled, false);
  assert.equal(cfg.accounts[1].accessToken, 'new');
  assert.deepEqual(result.carried, { reenabled: false, stillDisabled: true });
});

test('OAuth login of an unknown account is appended with a free account-N name', () => {
  const cfg = { accounts: [{ name: 'account-1', type: 'oauth' }] };
  const result = applyOAuthUpsert(cfg, { name: null, creds: newCreds, profile: null, source: 'login' });
  assert.equal(result.action, 'Added');
  assert.equal(result.name, 'account-2');
  assert.equal(result.carried, null);
  assert.equal(cfg.accounts[1].name, 'account-2');
});
