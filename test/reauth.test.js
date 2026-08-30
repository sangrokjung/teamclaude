import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyReauthToConfig, findReauthTarget, reauthenticateAccount } from '../src/reauth.js';

const entry = new URL('../src/index.js', import.meta.url).pathname;
const anthropicEnv = { ...process.env };
delete anthropicEnv.TEAMCLAUDE_PROVIDER;

function fixture(overrides = {}) {
  return {
    provider: 'anthropic',
    accounts: [{
      name: 'broken@example.com',
      type: 'oauth',
      provider: 'anthropic',
      accountUuid: 'uuid-broken',
      importFrom: '/tmp/stale-claude-credentials.json',
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
  const config = fixture();
  config.accounts.push({
    name: 'other@example.com',
    type: 'oauth',
    accountUuid: 'uuid-other',
    accessToken: 'other-access',
    refreshToken: 'other-refresh',
    expiresAt: 300,
  });
  const otherBefore = structuredClone(config.accounts[1]);
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
  assert.equal(result.importFrom, undefined);
  assert.equal(result.priority, 2);
  assert.equal(result.maxConcurrent, 4);
  assert.deepEqual(config.accounts[1], otherBefore);
});

test('reauth rejects a provider-selected Codex mode even when legacy config omits provider fields', () => {
  const config = fixture({ provider: undefined });
  delete config.provider;
  delete config.accounts[0].provider;
  assert.throws(() => findReauthTarget(config, {
    name: 'broken@example.com',
    expectedAccountUuid: 'uuid-broken',
    provider: 'codex',
  }), /Anthropic accounts only/);
});

test('teamcodex codex reauth rejects a provider-less legacy config before OAuth', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-reauth-codex-'));
  const configPath = join(dir, 'config.json');
  try {
    const config = fixture({ provider: undefined });
    delete config.provider;
    delete config.accounts[0].provider;
    await writeFile(configPath, JSON.stringify(config, null, 2));
    const result = spawnSync(process.execPath, [
      entry,
      'codex',
      'reauth',
      'broken@example.com',
      '--account-uuid',
      'uuid-broken',
    ], {
      input: '',
      encoding: 'utf8',
      timeout: 3000,
      env: { ...anthropicEnv, TEAMCLAUDE_CONFIG: configPath },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Anthropic accounts only/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test('reauth validates complete credentials before fetching the profile', async () => {
  let profileCalls = 0;
  await assert.rejects(() => reauthenticateAccount({
    name: 'broken@example.com',
    expectedAccountUuid: 'uuid-broken',
    loadConfig: async () => fixture(),
    login: async () => ({}),
    fetchProfile: async () => { profileCalls++; return freshResult.profile; },
    atomicUpdate: async () => { throw new Error('writer must not run'); },
  }), /incomplete credentials/);
  assert.equal(profileCalls, 0);
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

test('reauth CLI rejects a stale UUID before OAuth and leaves config byte-identical', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-reauth-cli-'));
  const configPath = join(dir, 'config.json');
  try {
    const config = fixture();
    await writeFile(configPath, JSON.stringify(config, null, 2));
    const before = await readFile(configPath);
    const result = spawnSync(process.execPath, [
      entry,
      'reauth',
      'broken@example.com',
      '--account-uuid',
      'uuid-stale',
    ], {
      encoding: 'utf8',
      env: { ...anthropicEnv, TEAMCLAUDE_CONFIG: configPath },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /not found with the expected identity/);
    assert.deepEqual(await readFile(configPath), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reauth CLI rejects a valueless account UUID flag before OAuth', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-reauth-missing-uuid-'));
  const configPath = join(dir, 'config.json');
  try {
    await writeFile(configPath, JSON.stringify(fixture(), null, 2));
    const result = spawnSync(process.execPath, [
      entry,
      'reauth',
      'broken@example.com',
      '--account-uuid',
    ], {
      input: '',
      encoding: 'utf8',
      timeout: 3000,
      env: { ...anthropicEnv, TEAMCLAUDE_CONFIG: configPath },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--account-uuid requires a value/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
