import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyReauthToConfig, findReauthTarget, reauthenticateAccount } from '../src/reauth.js';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';

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

test('reauth rejects provider-selected Codex mode when legacy config cannot prove its provider', () => {
  const config = fixture({ provider: undefined });
  delete config.provider;
  delete config.accounts[0].provider;
  assert.throws(() => findReauthTarget(config, {
    name: 'broken@example.com',
    expectedAccountUuid: 'uuid-broken',
    provider: 'codex',
  }), /requires an explicit Codex provider/);
});

test('Codex reauth accepts only a matching account identity and preserves cancellation metadata', async () => {
  const config = {
    provider: 'codex',
    accounts: [{
      name: 'codex@example.com', provider: 'codex', type: 'oauth',
      accountUuid: 'codex-account', accountId: 'codex-account',
      accessToken: 'old-access', refreshToken: 'old-refresh', idToken: 'old-id',
      expiresAt: 100, planType: 'pro',
      subscriptionCancellation: {
        status: 'scheduled', recordedAt: '2026-09-01T00:00:00.000Z', endsAt: null,
      },
    }],
  };
  const credentials = {
    accountUuid: 'codex-account', accountId: 'codex-account', email: 'codex@example.com',
    accessToken: 'new-access', refreshToken: 'new-refresh', idToken: 'new-id',
    expiresAt: 200, planType: 'pro',
  };
  let writes = 0;

  const result = await reauthenticateAccount({
    name: 'codex@example.com',
    expectedAccountUuid: 'codex-account',
    provider: 'codex',
    loadConfig: async () => structuredClone(config),
    login: async () => credentials,
    fetchProfile: async () => { throw new Error('Codex identity must come from verified auth.json'); },
    atomicUpdate: async updater => {
      writes += 1;
      await updater(config);
      return config;
    },
  });

  assert.equal(writes, 1);
  assert.equal(result.updated.idToken, 'new-id');
  assert.equal(result.updated.accountId, 'codex-account');
  assert.equal(result.updated.accessToken, 'new-access');
  assert.deepEqual(result.updated.subscriptionCancellation, {
    status: 'scheduled', recordedAt: '2026-09-01T00:00:00.000Z', endsAt: null,
  });
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
    assert.match(result.stderr, /requires an explicit Codex provider/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('teamcodex codex reauth runs isolated official login and updates only the pinned account', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-reauth-cli-'));
  const configPath = join(dir, 'teamcodex.json');
  const fakeCodex = join(dir, 'codex');
  const jwt = payload => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
  const auth = {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt({
        email: 'codex@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'codex-account', chatgpt_plan_type: 'pro',
        },
      }),
      access_token: jwt({
        exp: 1_900_000_000,
        'https://api.openai.com/profile': { email: 'codex@example.com' },
      }),
      refresh_token: 'new-refresh',
      account_id: 'codex-account',
    },
  };
  const config = {
    provider: 'codex',
    proxy: { port: 45692 },
    accounts: [
      {
        name: 'codex@example.com', provider: 'codex', type: 'oauth',
        accountUuid: 'codex-account', accountId: 'codex-account',
        accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 100,
        subscriptionCancellation: {
          status: 'scheduled', recordedAt: '2026-09-01T00:00:00.000Z', endsAt: null,
        },
      },
      {
        name: 'other@example.com', provider: 'codex', type: 'oauth',
        accountUuid: 'other-account', accountId: 'other-account',
        accessToken: 'other-access', refreshToken: 'other-refresh', expiresAt: 300,
      },
    ],
  };
  try {
    await writeFile(configPath, JSON.stringify(config, null, 2));
    await writeFile(fakeCodex, `#!/bin/sh\nmkdir -p "$CODEX_HOME"\nprintf '%s\\n' '${JSON.stringify(auth)}' > "$CODEX_HOME/auth.json"\n`);
    await chmod(fakeCodex, 0o700);
    const result = spawnSync(process.execPath, [
      entry, 'codex', 'reauth', 'codex@example.com',
      '--account-uuid', 'codex-account',
    ], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...anthropicEnv,
        TEAMCLAUDE_CONFIG: configPath,
        TEAMCODEX_CODEX_BIN: fakeCodex,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(saved.accounts[0].refreshToken, 'new-refresh');
    assert.equal(saved.accounts[0].accountId, 'codex-account');
    assert.deepEqual(saved.accounts[0].subscriptionCancellation, config.accounts[0].subscriptionCancellation);
    assert.deepEqual(saved.accounts[1], config.accounts[1]);
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

function makeCodexErrorTUI(reauthenticate) {
  const accounts = [
    {
      name: 'broken@example.com', provider: 'codex', type: 'oauth',
      accountUuid: 'codex-broken', accountId: 'codex-broken',
      accessToken: 'old-access', refreshToken: 'old-refresh', idToken: 'old-id',
      expiresAt: 100, planType: 'pro',
      subscriptionCancellation: {
        status: 'scheduled', recordedAt: '2026-09-01T00:00:00.000Z', endsAt: null,
      },
    },
    {
      name: 'healthy@example.com', provider: 'codex', type: 'oauth',
      accountUuid: 'codex-healthy', accountId: 'codex-healthy',
      accessToken: 'healthy-access', refreshToken: 'healthy-refresh',
      expiresAt: 200, planType: 'plus',
    },
  ];
  const am = new AccountManager(accounts.map(account => ({ ...account })), 0.98, 0, 5);
  am.accounts[0].status = 'error';
  am.accounts[0].errorReason = 'auth-revoked';
  const config = { provider: 'codex', accounts: accounts.map(account => structuredClone(account)) };
  const mutations = [];
  const tui = new TUI({
    accountManager: am,
    config,
    reauthenticate,
    saveConfig: async (_snapshot, mutation) => {
      mutations.push(mutation);
      return structuredClone(config);
    },
    syncAccounts: async () => 0,
    onQuit: () => {},
  });
  return { tui, am, config, mutations };
}

test('Codex auth error exposes re-authentication beside the selected account and r repairs only it', async () => {
  let calls = 0;
  const { tui, am, config, mutations } = makeCodexErrorTUI(async account => {
    calls += 1;
    return {
      credentials: {
        accessToken: 'fresh-access', refreshToken: 'fresh-refresh', idToken: 'fresh-id',
        expiresAt: 999, accountId: account.accountId, accountUuid: account.accountUuid,
        email: account.name, planType: 'pro',
      },
      profile: { accountUuid: account.accountUuid, email: account.name },
    };
  });
  const healthyBefore = structuredClone(config.accounts[1]);

  tui.selIdx = 0;
  assert.match(tui._renderAcct(am.accounts[0], 0, 10, true, false), /reauth/);
  assert.match(tui._renderFooter(), /재인증 필요.*r/);

  tui._keyNormal('r');
  await tui._reauthPromise;

  assert.equal(calls, 1);
  assert.equal(am.accounts[0].credential, 'fresh-access');
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(config.accounts[0].idToken, 'fresh-id');
  assert.equal(config.accounts[0].accountId, 'codex-broken');
  assert.deepEqual(config.accounts[0].subscriptionCancellation, {
    status: 'scheduled', recordedAt: '2026-09-01T00:00:00.000Z', endsAt: null,
  });
  assert.deepEqual(config.accounts[1], healthyBefore);
  assert.equal(mutations.at(-1).type, 'upsert');
});

test('confirmed Codex subscription end is not presented as a re-authentication error', () => {
  const { tui, am } = makeCodexErrorTUI(async () => null);
  am.accounts[0].errorReason = 'subscription-ended';
  am.accounts[0].subscriptionCancellation = {
    status: 'ended', recordedAt: '2026-09-01T00:00:00.000Z', endsAt: null,
  };
  tui.selIdx = 0;

  assert.doesNotMatch(tui._renderAcct(am.accounts[0], 0, 10, true, false), /reauth/);
  assert.doesNotMatch(tui._renderFooter(), /재인증 필요/);
});
