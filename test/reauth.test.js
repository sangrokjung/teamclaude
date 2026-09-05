import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReauthToConfig, reauthenticateAccount } from '../src/reauth.js';

function fixture(overrides = {}) {
  return {
    provider: 'anthropic',
    accounts: [{
      name: 'broken@example.com',
      type: 'oauth',
      provider: 'anthropic',
      accountUuid: 'uuid-broken',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: 100,
      enabled: true,
      priority: 2,
      maxConcurrent: 4,
      ...overrides,
    }],
  };
}

const freshResult = {
  credentials: {
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
    expiresAt: 200,
  },
  profile: {
    accountUuid: 'uuid-broken',
    email: 'broken@example.com',
  },
};

test('reauth updates only the selected OAuth account and preserves routing settings', () => {
  const config = fixture({ authRevoked: true, authRevokedAt: 1 });
  const result = applyReauthToConfig(config, {
    name: 'broken@example.com',
    expectedAccountUuid: 'uuid-broken',
    ...freshResult,
  });

  assert.equal(result.name, 'broken@example.com');
  assert.equal(result.accessToken, 'new-access');
  assert.equal(result.refreshToken, 'new-refresh');
  assert.equal(result.expiresAt, 200);
  assert.equal(result.source, 'reauth');
  assert.equal(result.priority, 2);
  assert.equal(result.maxConcurrent, 4);
  assert.equal(result.authRevoked, undefined);
  assert.equal(result.authRevokedAt, undefined);
  assert.ok(Number.isFinite(result.authVerifiedAt) && result.authVerifiedAt > 1,
    'only the profile-verified reauth path may create the durable recovery proof');
  assert.equal(result.authVerifiedAccountUuid, 'uuid-broken');
});

test('reauth rejects a mismatched profile without mutating config', () => {
  const config = fixture();
  const before = JSON.stringify(config);

  assert.throws(() => applyReauthToConfig(config, {
    name: 'broken@example.com',
    expectedAccountUuid: 'uuid-broken',
    credentials: freshResult.credentials,
    profile: { accountUuid: 'uuid-other', email: 'broken@example.com' },
  }), /does not match/);
  assert.equal(JSON.stringify(config), before);
});

test('reauth fails closed when the target changed or is not an Anthropic OAuth account', () => {
  const changed = fixture({ accountUuid: 'uuid-new' });
  const changedBefore = JSON.stringify(changed);
  assert.throws(() => applyReauthToConfig(changed, {
    name: 'broken@example.com',
    expectedAccountUuid: 'uuid-broken',
    ...freshResult,
  }), /not found/);
  assert.equal(JSON.stringify(changed), changedBefore);

  for (const overrides of [
    { enabled: false },
    { subscriptionDisabled: true },
    { type: 'apikey', provider: undefined },
    { provider: 'codex' },
  ]) {
    const config = fixture(overrides);
    const before = JSON.stringify(config);
    assert.throws(() => applyReauthToConfig(config, {
      name: 'broken@example.com',
      expectedAccountUuid: 'uuid-broken',
      ...freshResult,
    }));
    assert.equal(JSON.stringify(config), before);
  }
});

test('reauth accepts a legacy name-only account only when profile email matches', () => {
  const config = fixture({ accountUuid: undefined, name: 'legacy@example.com' });
  const result = applyReauthToConfig(config, {
    name: 'legacy@example.com',
    expectedAccountUuid: null,
    credentials: freshResult.credentials,
    profile: { accountUuid: 'uuid-legacy', email: 'LEGACY@example.com' },
  });
  assert.equal(result.accountUuid, 'uuid-legacy');
});

test('reauth orchestration writes only after login and profile verification succeed', async () => {
  const config = fixture();
  let writes = 0;
  const result = await reauthenticateAccount({
    name: 'broken@example.com',
    expectedAccountUuid: 'uuid-broken',
    loadConfig: async () => structuredClone(config),
    login: async () => freshResult.credentials,
    fetchProfile: async () => freshResult.profile,
    atomicUpdate: async updater => {
      writes += 1;
      await updater(config);
      return config;
    },
  });
  assert.equal(writes, 1);
  assert.equal(result.updated.accessToken, 'new-access');
  assert.equal(result.savedConfig.accounts[0].accessToken, 'new-access');
});

test('reauth cancellation and profile mismatch never invoke the atomic writer', async () => {
  for (const scenario of [
    {
      login: async () => { throw new Error('cancelled'); },
      fetchProfile: async () => freshResult.profile,
    },
    {
      login: async () => freshResult.credentials,
      fetchProfile: async () => ({ accountUuid: 'uuid-other', email: 'broken@example.com' }),
    },
  ]) {
    const config = fixture();
    const before = JSON.stringify(config);
    let writes = 0;
    await assert.rejects(() => reauthenticateAccount({
      name: 'broken@example.com',
      expectedAccountUuid: 'uuid-broken',
      loadConfig: async () => structuredClone(config),
      login: scenario.login,
      fetchProfile: scenario.fetchProfile,
      atomicUpdate: async updater => {
        writes += 1;
        await updater(config);
        return config;
      },
    }));
    assert.equal(writes, 0);
    assert.equal(JSON.stringify(config), before);
  }
});

test('reauth pins the initially selected UUID across the asynchronous login', async () => {
  const initial = fixture();
  const replacement = fixture({ accountUuid: 'uuid-replacement' });
  let updaterCalls = 0;
  await assert.rejects(() => reauthenticateAccount({
    name: 'broken@example.com',
    loadConfig: async () => structuredClone(initial),
    login: async () => freshResult.credentials,
    fetchProfile: async () => freshResult.profile,
    atomicUpdate: async updater => {
      updaterCalls += 1;
      await updater(replacement);
      return replacement;
    },
  }), /expected identity/);
  assert.equal(updaterCalls, 1);
  assert.equal(replacement.accounts[0].accessToken, 'old-access');
});

test('reauth rejects a legacy name-only account replaced during asynchronous login', async () => {
  const initial = fixture({
    accountUuid: undefined,
    name: 'legacy@example.com',
  });
  const replacement = fixture({
    accountUuid: 'uuid-replacement',
    name: 'legacy@example.com',
    accessToken: 'replacement-access',
    refreshToken: 'replacement-refresh',
    expiresAt: 300,
  });
  const before = JSON.stringify(replacement);

  await assert.rejects(() => reauthenticateAccount({
    name: 'legacy@example.com',
    loadConfig: async () => structuredClone(initial),
    login: async () => freshResult.credentials,
    fetchProfile: async () => ({
      accountUuid: 'uuid-legacy',
      email: 'legacy@example.com',
    }),
    atomicUpdate: async updater => {
      await updater(replacement);
      return replacement;
    },
  }), /changed while re-authentication was in progress/);

  assert.equal(JSON.stringify(replacement), before);
});
