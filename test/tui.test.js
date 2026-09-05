import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, applyTuiAccountMutation } from '../src/tui.js';

// Build a TUI wired to a real AccountManager + a config copy, without start()
// (start() is what touches stdin/stdout — the constructor just sets fields). A
// mock saveConfig records that a persist happened.
function makeTUI(names = ['a0', 'a1', 'a2']) {
  const accts = names.map(n => ({ name: n, type: 'apikey', apiKey: `sk-${n}` }));
  const am = new AccountManager(accts.map(a => ({ ...a })), 0.98, 0, 5);
  const config = { accounts: accts.map(a => ({ ...a })) };
  let saves = 0;
  const mutations = [];
  const tui = new TUI({
    accountManager: am,
    config,
    saveConfig: async (_snapshot, mutation) => { saves++; mutations.push(mutation); },
    syncAccounts: async () => 0,
    onQuit: () => {},
  });
  return { tui, am, config, saves: () => saves, mutations };
}

function makeOAuthTUI(accounts, reauthenticate, saveResult) {
  const am = new AccountManager(accounts.map(a => ({ ...a })), 0.98, 0, 5);
  for (const [index, account] of accounts.entries()) {
    if (account.status) am.accounts[index].status = account.status;
  }
  const config = { accounts: accounts.map(a => ({ ...a })) };
  const mutations = [];
  const tui = new TUI({
    accountManager: am,
    config,
    saveConfig: async (_snapshot, mutation) => {
      mutations.push(mutation);
      return saveResult === undefined ? config : saveResult;
    },
    syncAccounts: async () => 0,
    reauthenticate,
    onQuit: () => {},
  });
  return { tui, am, config, mutations };
}

function makeProviderTUI(provider) {
  const account = provider === 'grok'
    ? {
      name: 'grok-sub', provider, type: 'oauth', accessToken: 'access', refreshToken: 'refresh',
      expiresAt: Date.now() + 3600_000, accountUuid: 'grok-user',
      oauthIssuer: 'https://auth.x.ai', oauthClientId: 'grok-client',
    }
    : {
      name: 'agy-sub', provider, type: 'oauth', accessToken: 'access', refreshToken: null,
      expiresAt: Date.now() + 3600_000, accountUuid: 'agy-user', authMethod: 'consumer',
    };
  const am = new AccountManager([account], 0.98, 0, 5);
  return new TUI({
    accountManager: am,
    config: { provider, proxy: { port: provider === 'grok' ? 3458 : 3459 }, accounts: [account] },
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
}

test('Grok and Agy TUI surfaces use provider labels and OAuth-only add guidance', () => {
  for (const [provider, brand, port] of [['grok', 'TeamGrok', '3458'], ['agy', 'TeamAgy', '3459']]) {
    const tui = makeProviderTUI(provider);
    assert.equal(tui._brandLabel(), brand);
    assert.equal(tui._proxyPort(), Number(port));
    tui.mode = 'add';
    const footer = stripAnsi(tui._renderFooter());
    assert.match(footer, new RegExp(`teamcodex ${provider} (login|import)`));
    assert.doesNotMatch(footer, /API key|Import Claude Code/);
    tui._keyAdd('k');
    assert.equal(tui.mode, 'add', `${provider} does not open API-key input`);
  }
});

test('Grok and Agy TUI import existing OAuth credentials without API-key fields', async () => {
  for (const provider of ['grok', 'agy']) {
    const am = new AccountManager([], 0.98, 0, 5);
    const config = { provider, accounts: [] };
    const mutations = [];
    const tui = new TUI({
      accountManager: am,
      config,
      saveConfig: async (_snapshot, mutation) => { mutations.push(mutation); },
      syncAccounts: async () => 0,
      importProviderCredentials: async () => provider === 'grok'
        ? {
          accessToken: 'grok-access', refreshToken: 'grok-refresh',
          expiresAt: Date.now() + 3600_000, accountUuid: 'grok-user',
          oauthIssuer: 'https://auth.x.ai', oauthClientId: 'grok-client',
        }
        : {
          accessToken: 'agy-access', refreshToken: null,
          expiresAt: Date.now() + 3600_000, accountUuid: 'agy-user', authMethod: 'consumer',
        },
      onQuit: () => {},
    });

    await tui._doImport();

    assert.equal(config.accounts.length, 1);
    assert.equal(config.accounts[0].provider, provider);
    assert.equal(config.accounts[0].type, 'oauth');
    assert.equal(Object.hasOwn(config.accounts[0], 'apiKey'), false);
    assert.equal(am.accounts.length, 1);
    assert.equal(am.accounts[0].provider, provider);
    assert.equal(mutations.at(-1).type, 'upsert');
  }
});

test('a stale TUI reauth mutation cannot clear a newer disk quarantine', () => {
  const now = Date.now();
  const account = {
    name: 'auth@example.com', type: 'oauth', provider: 'anthropic', accountUuid: 'auth-id',
    accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: now + 3600_000,
    source: 'reauth', authVerifiedAt: now, authVerifiedAccountUuid: 'auth-id',
  };
  const diskConfig = {
    accounts: [{
      ...account,
      accessToken: 'old-access', refreshToken: 'old-refresh',
      authRevoked: true, authRevokedAt: now + 1_000,
      importFrom: '/fixture/credentials.json',
    }],
  };
  const manager = new AccountManager([{
    ...diskConfig.accounts[0], accessToken: 'new-access', refreshToken: 'new-refresh',
  }], 0.98, 0, 5);
  applyTuiAccountMutation(diskConfig, { accounts: [account] }, manager, {
    type: 'upsert', account, previous: account,
    clearFields: ['authRevoked', 'authRevokedAt', 'importFrom'],
  });
  assert.equal(diskConfig.accounts[0].authRevoked, true);
  assert.equal(diskConfig.accounts[0].authRevokedAt, now + 1_000);
  assert.equal(diskConfig.accounts[0].importFrom, '/fixture/credentials.json');
});

test('a legacy account cannot be revived by an imported credential with a different UUID', () => {
  const now = Date.now();
  const legacy = {
    name: 'legacy@example.com',
    type: 'oauth',
    provider: 'anthropic',
    accountUuid: null,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: now + 3600_000,
    authRevoked: true,
    authRevokedAt: now - 1000,
  };
  const imported = {
    ...legacy,
    accountUuid: 'uuid-other',
    accessToken: 'other-access',
    refreshToken: 'other-refresh',
    source: 'import',
    authVerifiedAt: now,
    authVerifiedAccountUuid: 'uuid-other',
  };
  const manager = new AccountManager([{ ...legacy, accountUuid: 'uuid-other' }], 0.98, 0, 5);
  manager.accounts[0].credential = imported.accessToken;
  manager.accounts[0].accessToken = imported.accessToken;
  manager.accounts[0].refreshToken = imported.refreshToken;
  const diskConfig = { accounts: [{ ...legacy }] };

  applyTuiAccountMutation(diskConfig, { accounts: [imported] }, manager, {
    type: 'upsert',
    account: imported,
    previous: legacy,
    clearFields: ['authRevoked', 'authRevokedAt', 'importFrom'],
  });

  assert.equal(diskConfig.accounts[0].authRevoked, true,
    'an import proof must not clear a legacy account quarantine');
  assert.equal(diskConfig.accounts[0].authRevokedAt, legacy.authRevokedAt);
});

test('TUI import cannot replace a quarantined legacy account by same-name profile', async () => {
  const now = Date.now();
  const legacy = {
    name: 'legacy@example.com',
    type: 'oauth',
    provider: 'anthropic',
    accountUuid: null,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: now + 3600_000,
    authRevoked: true,
    authRevokedAt: now - 1000,
    status: 'error',
  };
  const { tui, am, config, mutations } = makeOAuthTUI([legacy]);
  tui.importAnthropicCredentials = async () => ({
    accessToken: 'other-access', refreshToken: 'other-refresh', expiresAt: now + 7200_000,
  });
  tui.fetchAnthropicProfile = async () => ({
    accountUuid: 'uuid-other', email: 'legacy@example.com',
  });

  await tui._doImport();

  assert.equal(am.accounts[0].credential, 'old-access');
  assert.equal(am.accounts[0].accountUuid, null);
  assert.equal(am.accounts[0].authRevoked, true);
  assert.equal(config.accounts[0].accessToken, 'old-access');
  assert.equal(config.accounts[0].accountUuid, null);
  assert.equal(config.accounts[0].authRevoked, true);
  assert.equal(mutations.length, 0);
});

test('TUI import honors a live quarantine even when the config snapshot is stale', async () => {
  const now = Date.now();
  const legacy = {
    name: 'legacy@example.com',
    type: 'oauth',
    provider: 'anthropic',
    accountUuid: null,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: now + 3600_000,
  };
  const { tui, am, config, mutations } = makeOAuthTUI([legacy]);
  am.accounts[0].authRevoked = true;
  am.accounts[0].authRevokedAt = now - 1000;
  am.accounts[0].status = 'error';
  am.accounts[0].errorReason = 'auth-revoked';
  tui.importAnthropicCredentials = async () => ({
    accessToken: 'other-access', refreshToken: 'other-refresh', expiresAt: now + 7200_000,
  });
  tui.fetchAnthropicProfile = async () => ({
    accountUuid: 'uuid-other', email: 'legacy@example.com',
  });

  await tui._doImport();

  assert.equal(am.accounts[0].credential, 'old-access');
  assert.equal(am.accounts[0].accountUuid, null);
  assert.equal(am.accounts[0].authRevoked, true);
  assert.equal(config.accounts[0].accessToken, 'old-access');
  assert.equal(mutations.length, 0);
});

test('TUI import with a matching stable UUID can heal a quarantined account', async () => {
  const now = Date.now();
  const account = {
    name: 'stable@example.com',
    type: 'oauth',
    provider: 'anthropic',
    accountUuid: 'uuid-stable',
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: now + 3600_000,
    authRevoked: true,
    authRevokedAt: now - 1000,
    status: 'error',
  };
  const { tui, am, config, mutations } = makeOAuthTUI([account]);
  tui.importAnthropicCredentials = async () => ({
    accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: now + 7200_000,
  });
  tui.fetchAnthropicProfile = async () => ({
    accountUuid: 'uuid-stable', email: 'stable@example.com',
  });

  await tui._doImport();

  assert.equal(am.accounts[0].credential, 'new-access');
  assert.equal(am.accounts[0].accountUuid, 'uuid-stable');
  assert.equal(am.accounts[0].authRevoked, undefined);
  assert.equal(config.accounts[0].accessToken, 'new-access');
  assert.equal(config.accounts[0].authRevoked, undefined);
  assert.equal(mutations.at(-1).clearFields?.includes('authRevoked'), true);
});

test('a missing or malformed legacy revocation timestamp cannot be bypassed by a proof marker', () => {
  for (const badTimestamp of [undefined, 'not-a-timestamp']) {
    const now = Date.now();
    const legacy = {
      name: 'legacy@example.com',
      type: 'oauth',
      provider: 'anthropic',
      accountUuid: null,
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: now + 3600_000,
      authRevoked: true,
      ...(badTimestamp === undefined ? {} : { authRevokedAt: badTimestamp }),
    };
    const incoming = {
      ...legacy,
      accountUuid: 'uuid-reauth',
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      source: 'reauth',
      authVerifiedAt: now + 1,
      authVerifiedAccountUuid: 'uuid-reauth',
    };
    const manager = new AccountManager([{ ...legacy, accountUuid: 'uuid-reauth' }], 0.98, 0, 5);
    manager.accounts[0].credential = incoming.accessToken;
    manager.accounts[0].accessToken = incoming.accessToken;
    manager.accounts[0].refreshToken = incoming.refreshToken;
    const diskConfig = { accounts: [{ ...legacy }] };
    applyTuiAccountMutation(diskConfig, { accounts: [incoming] }, manager, {
      type: 'upsert',
      account: incoming,
      previous: legacy,
      clearFields: ['authRevoked', 'authRevokedAt', 'importFrom'],
    });
    assert.equal(diskConfig.accounts[0].authRevoked, true,
      `invalid authRevokedAt (${String(badTimestamp)}) must fail closed`);
  }
});

// ── normal-mode cursor: ↑/↓ select, action keys act on the selection ─────────

test('normal mode: ↑/↓ move a selection cursor over the accounts (clamped at ends)', () => {
  const { tui } = makeTUI(['a0', 'a1', 'a2']);
  tui.mode = 'normal'; tui.selIdx = 0;
  tui._keyNormal('down'); assert.equal(tui.selIdx, 1);
  tui._keyNormal('down'); assert.equal(tui.selIdx, 2);
  tui._keyNormal('down'); assert.equal(tui.selIdx, 2, 'clamped at the last account');
  tui._keyNormal('up');   assert.equal(tui.selIdx, 1);
  tui._keyNormal('up'); tui._keyNormal('up'); assert.equal(tui.selIdx, 0, 'clamped at the top');
});

test('normal mode: "s" switches to the ↑/↓-selected account directly (no sub-mode)', () => {
  const { tui, am } = makeTUI(['a0', 'a1', 'a2']);
  tui.mode = 'normal'; tui.selIdx = 2; // all unranked → display order == am order
  tui._keyNormal('s');
  assert.equal(am.currentIndex, 2, 'active account is the selected one');
  assert.equal(tui.mode, 'normal');
});

test('normal mode: "e" toggles the ↑/↓-selected account directly', () => {
  const { tui, am } = makeTUI(['a0', 'a1']);
  tui.mode = 'normal'; tui.selIdx = 1;
  tui._keyNormal('e');
  assert.equal(am.accounts[1].enabled, false, 'selected account disabled directly');
});

test('normal mode: "o" grabs the ↑/↓-selected account into order (move) mode', () => {
  const { tui, am } = makeTUI(['a0', 'a1', 'a2']);
  tui.mode = 'normal'; tui.selIdx = 1;
  tui._keyNormal('o');
  assert.equal(tui.mode, 'order');
  assert.equal(tui.orderAccount, am.accounts[1], 'grabs the selected account');
});

test('normal mode: "d" asks for confirmation (enters select mode, not a direct delete)', () => {
  const { tui } = makeTUI(['a0', 'a1']);
  tui.mode = 'normal'; tui.selIdx = 1;
  tui._keyNormal('d');
  assert.equal(tui.mode, 'select', 'delete is destructive → confirmation step, not a direct action');
});

test('error OAuth account exposes a re-authentication action, but active account does not', () => {
  const { tui, am } = makeOAuthTUI([
    { name: 'broken@example.com', type: 'oauth', accountUuid: 'broken-id', accessToken: 'old', refreshToken: 'old-r', status: 'error' },
    { name: 'ok@example.com', type: 'oauth', accountUuid: 'ok-id', accessToken: 'ok', refreshToken: 'ok-r', status: 'active' },
  ]);

  tui.selIdx = 0;
  assert.match(stripAnsi(tui._renderAcct(am.accounts[0], 0, 10, true, false)), /reauth/, 'error row is visibly actionable');
  assert.match(stripAnsi(tui._renderFooter()), /재인증 필요.*\[r\]/, 'selected error account exposes the re-auth action');

  tui.selIdx = 1;
  tui.selAcct = am.accounts[1];
  assert.doesNotMatch(stripAnsi(tui._renderFooter()), /재인증 필요/, 'active account does not expose re-auth');
});

test('re-authentication updates only the selected account and persists its identity', async () => {
  const { tui, am, config, mutations } = makeOAuthTUI([
    { name: 'broken@example.com', type: 'oauth', accountUuid: 'broken-id', accessToken: 'old', refreshToken: 'old-r', expiresAt: 1, status: 'error' },
    { name: 'ok@example.com', type: 'oauth', accountUuid: 'ok-id', accessToken: 'ok', refreshToken: 'ok-r', status: 'active' },
  ], async account => ({
    credentials: { accessToken: 'fresh', refreshToken: 'fresh-r', expiresAt: 999 },
    profile: { accountUuid: account.accountUuid, email: account.name },
  }));

  tui.selIdx = 0;
  tui._keyNormal('r');
  await tui._reauthPromise;

  assert.equal(am.accounts[0].credential, 'fresh');
  assert.equal(am.accounts[0].refreshToken, 'fresh-r');
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[1].credential, 'ok');
  assert.equal(am.accounts[1].status, 'active');
  assert.equal(config.accounts[0].accessToken, 'fresh');
  assert.equal(config.accounts[1].accessToken, 'ok');
  assert.equal(mutations.at(-1).type, 'upsert');
  assert.equal(mutations.at(-1).account.accountUuid, 'broken-id');
});

test('re-authentication rejects a different profile without changing either account', async () => {
  const { tui, am, config, mutations } = makeOAuthTUI([
    { name: 'broken@example.com', type: 'oauth', accountUuid: 'broken-id', accessToken: 'old', refreshToken: 'old-r', status: 'error' },
    { name: 'ok@example.com', type: 'oauth', accountUuid: 'ok-id', accessToken: 'ok', refreshToken: 'ok-r', status: 'active' },
  ], async () => ({
    credentials: { accessToken: 'wrong', refreshToken: 'wrong-r', expiresAt: 999 },
    profile: { accountUuid: 'ok-id', email: 'ok@example.com' },
  }));

  tui.selIdx = 0;
  tui._keyNormal('r');
  await tui._reauthPromise;

  assert.equal(am.accounts[0].credential, 'old');
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(am.accounts[1].credential, 'ok');
  assert.equal(config.accounts[0].accessToken, 'old');
  assert.equal(config.accounts[1].accessToken, 'ok');
  assert.equal(mutations.length, 0, 'mismatched login must not persist tokens');
});

test('subscription-disabled OAuth accounts cannot be re-authenticated or expose re-auth UI', () => {
  const { tui, am } = makeOAuthTUI([
    {
      name: 'lapsed@example.com',
      type: 'oauth',
      accountUuid: 'lapsed-id',
      accessToken: 'old',
      refreshToken: 'old-r',
      status: 'error',
    },
  ]);
  am.accounts[0].errorReason = 'subscription-disabled';
  tui.selIdx = 0;

  assert.equal(tui._canReauthenticate(am.accounts[0]), false);
  assert.doesNotMatch(stripAnsi(tui._renderAcct(am.accounts[0], 0, 10, true, false)), /reauth/);
  assert.doesNotMatch(stripAnsi(tui._renderFooter()), /reauth|재인증 필요/);
});

test('disabled OAuth error accounts cannot be re-authenticated or expose re-auth UI', async () => {
  let calls = 0;
  const { tui, am } = makeOAuthTUI([
    {
      name: 'disabled@example.com',
      type: 'oauth',
      accountUuid: 'disabled-id',
      accessToken: 'old',
      refreshToken: 'old-r',
      enabled: false,
      status: 'error',
      errorReason: 'token-expired',
    },
  ], async () => { calls++; return null; });
  am.accounts[0].errorReason = 'token-expired';
  tui.selIdx = 0;

  const canReauthenticate = tui._canReauthenticate(am.accounts[0]);
  const rowHasReauth = /reauth/.test(stripAnsi(tui._renderAcct(am.accounts[0], 0, 10, true, false)));
  const footerHasReauth = /reauth|재인증 필요/.test(stripAnsi(tui._renderFooter()));
  tui._keyNormal('r');
  await tui._reauthPromise;

  assert.deepEqual({ canReauthenticate, rowHasReauth, footerHasReauth, calls }, {
    canReauthenticate: false,
    rowHasReauth: false,
    footerHasReauth: false,
    calls: 0,
  });
});

test('non-Anthropic OAuth accounts cannot be re-authenticated or expose re-auth UI', async () => {
  let calls = 0;
  const { tui, am } = makeOAuthTUI([
    {
      name: 'codex@example.com',
      type: 'oauth',
      provider: 'codex',
      accountUuid: 'codex-id',
      accessToken: 'old',
      refreshToken: 'old-r',
      status: 'error',
    },
  ], async () => { calls++; return null; });
  tui.selIdx = 0;

  assert.equal(tui._canReauthenticate(am.accounts[0]), false);
  assert.doesNotMatch(stripAnsi(tui._renderAcct(am.accounts[0], 0, 10, true, false)), /reauth/);
  assert.doesNotMatch(stripAnsi(tui._renderFooter()), /reauth|재인증 필요/);
  tui._keyNormal('r');
  await Promise.resolve();
  assert.equal(calls, 0);
});

test('re-authentication with incomplete credentials preserves selected account and config without saving', async () => {
  const { tui, am, config, mutations } = makeOAuthTUI([
    {
      name: 'broken@example.com',
      type: 'oauth',
      accountUuid: 'broken-id',
      accessToken: 'old',
      refreshToken: 'old-r',
      expiresAt: 123,
      status: 'error',
      errorReason: 'token-expired',
    },
  ], async () => ({
    credentials: { accessToken: 'fresh', refreshToken: 'fresh-r' },
    profile: { accountUuid: 'broken-id', email: 'broken@example.com' },
  }));
  am.accounts[0].errorReason = 'token-expired';
  tui.selIdx = 0;
  const beforeConfig = { ...config.accounts[0] };

  tui._keyNormal('r');
  await tui._reauthPromise;

  assert.equal(am.accounts[0].credential, 'old');
  assert.equal(am.accounts[0].refreshToken, 'old-r');
  assert.equal(am.accounts[0].expiresAt, 123);
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(am.accounts[0].errorReason, 'token-expired');
  assert.deepEqual(config.accounts[0], beforeConfig);
  assert.equal(mutations.length, 0, 'incomplete credentials must not persist tokens');
});

test('re-authentication rejection preserves selected account and config without saving', async () => {
  const { tui, am, config, mutations } = makeOAuthTUI([
    {
      name: 'broken@example.com',
      type: 'oauth',
      accountUuid: 'broken-id',
      accessToken: 'old',
      refreshToken: 'old-r',
      expiresAt: 456,
      status: 'error',
      errorReason: 'token-expired',
    },
  ], async () => {
    throw new Error('oauth browser failed');
  });
  am.accounts[0].errorReason = 'token-expired';
  tui.selIdx = 0;
  const beforeConfig = { ...config.accounts[0] };

  tui._keyNormal('r');
  await tui._reauthPromise;

  assert.equal(am.accounts[0].credential, 'old');
  assert.equal(am.accounts[0].refreshToken, 'old-r');
  assert.equal(am.accounts[0].expiresAt, 456);
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(am.accounts[0].errorReason, 'token-expired');
  assert.deepEqual(config.accounts[0], beforeConfig);
  assert.equal(mutations.length, 0, 'rejected login must not persist tokens');
});

test('re-authentication rejects a profile with mismatched UUID even when email matches', async () => {
  const { tui, am, config, mutations } = makeOAuthTUI([
    {
      name: 'broken@example.com',
      type: 'oauth',
      accountUuid: 'broken-id',
      accessToken: 'old',
      refreshToken: 'old-r',
      expiresAt: 789,
      status: 'error',
      errorReason: 'token-expired',
    },
  ], async () => ({
    credentials: { accessToken: 'wrong', refreshToken: 'wrong-r', expiresAt: 999 },
    profile: { accountUuid: 'other-id', email: 'broken@example.com' },
  }));
  am.accounts[0].errorReason = 'token-expired';
  tui.selIdx = 0;
  const beforeConfig = { ...config.accounts[0] };

  tui._keyNormal('r');
  await tui._reauthPromise;

  assert.equal(am.accounts[0].credential, 'old');
  assert.equal(am.accounts[0].refreshToken, 'old-r');
  assert.equal(am.accounts[0].expiresAt, 789);
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(am.accounts[0].errorReason, 'token-expired');
  assert.deepEqual(config.accounts[0], beforeConfig);
  assert.equal(mutations.length, 0, 'identity-mismatched login must not persist tokens');
});

test('re-authentication rejects a profile missing UUID when the stored account has one', async () => {
  const { tui, am, config, mutations } = makeOAuthTUI([
    {
      name: 'broken@example.com',
      type: 'oauth',
      accountUuid: 'broken-id',
      accessToken: 'old',
      refreshToken: 'old-r',
      expiresAt: 790,
      status: 'error',
      errorReason: 'token-expired',
    },
  ], async () => ({
    credentials: { accessToken: 'wrong', refreshToken: 'wrong-r', expiresAt: 1000 },
    profile: { email: 'broken@example.com' },
  }));
  am.accounts[0].errorReason = 'token-expired';
  tui.selIdx = 0;
  const beforeConfig = { ...config.accounts[0] };

  tui._keyNormal('r');
  await tui._reauthPromise;

  assert.equal(am.accounts[0].credential, 'old');
  assert.equal(am.accounts[0].refreshToken, 'old-r');
  assert.equal(am.accounts[0].expiresAt, 790);
  assert.equal(am.accounts[0].status, 'error');
  assert.deepEqual(config.accounts[0], beforeConfig);
  assert.equal(mutations.length, 0, 'a missing profile UUID must not use an email fallback');
});

test('re-authentication fails closed when config has a same-name account with a different UUID', async () => {
  const { tui, am, config, mutations } = makeOAuthTUI([
    {
      name: 'broken@example.com',
      type: 'oauth',
      accountUuid: 'live-id',
      accessToken: 'old',
      refreshToken: 'old-r',
      expiresAt: 791,
      status: 'error',
      errorReason: 'token-expired',
    },
  ], async () => ({
    credentials: { accessToken: 'fresh', refreshToken: 'fresh-r', expiresAt: 1001 },
    profile: { accountUuid: 'live-id', email: 'broken@example.com' },
  }));
  config.accounts[0].accountUuid = 'config-other-id';
  config.accounts[0].accessToken = 'config-old';
  config.accounts[0].refreshToken = 'config-old-r';
  config.accounts[0].expiresAt = 792;
  am.accounts[0].errorReason = 'token-expired';
  tui.selIdx = 0;
  const beforeConfig = { ...config.accounts[0] };

  tui._keyNormal('r');
  await tui._reauthPromise;

  assert.equal(am.accounts[0].credential, 'old');
  assert.equal(am.accounts[0].refreshToken, 'old-r');
  assert.equal(am.accounts[0].expiresAt, 791);
  assert.equal(am.accounts[0].status, 'error');
  assert.deepEqual(config.accounts[0], beforeConfig);
  assert.equal(mutations.length, 0, 'a UUID mismatch in config must not be repaired by name');
});

test('re-authentication rolls back when the config save result omits the updated account', async () => {
  const { tui, am, config, mutations } = makeOAuthTUI([
    {
      name: 'broken@example.com',
      type: 'oauth',
      accountUuid: 'broken-id',
      accessToken: 'old',
      refreshToken: 'old-r',
      expiresAt: 321,
      status: 'error',
      errorReason: 'token-expired',
    },
  ], async () => ({
    credentials: { accessToken: 'fresh', refreshToken: 'fresh-r', expiresAt: 654 },
    profile: { accountUuid: 'broken-id', email: 'broken@example.com' },
  }), { accounts: [] });
  am.accounts[0].errorReason = 'token-expired';
  tui.selIdx = 0;
  const beforeConfig = { ...config.accounts[0] };

  tui._keyNormal('r');
  await tui._reauthPromise;

  assert.equal(am.accounts[0].credential, 'old');
  assert.equal(am.accounts[0].refreshToken, 'old-r');
  assert.equal(am.accounts[0].expiresAt, 321);
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(am.accounts[0].errorReason, 'token-expired');
  assert.deepEqual(config.accounts[0], beforeConfig);
  assert.equal(mutations.length, 1, 'the attempted save is recorded, but its no-op result must fail re-auth');
});

test('re-authentication rolls back when the config save callback returns no result', async () => {
  const { tui, am, config } = makeOAuthTUI([
    {
      name: 'broken@example.com',
      type: 'oauth',
      accountUuid: 'broken-id',
      accessToken: 'old',
      refreshToken: 'old-r',
      expiresAt: 322,
      status: 'error',
      errorReason: 'token-expired',
    },
  ], async () => ({
    credentials: { accessToken: 'fresh', refreshToken: 'fresh-r', expiresAt: 655 },
    profile: { accountUuid: 'broken-id', email: 'broken@example.com' },
  }));
  tui.saveConfig = async () => undefined;
  am.accounts[0].errorReason = 'token-expired';
  tui.selIdx = 0;
  const beforeConfig = { ...config.accounts[0] };

  tui._keyNormal('r');
  await tui._reauthPromise;

  assert.equal(am.accounts[0].credential, 'old');
  assert.equal(am.accounts[0].refreshToken, 'old-r');
  assert.equal(am.accounts[0].expiresAt, 322);
  assert.equal(am.accounts[0].status, 'error');
  assert.deepEqual(config.accounts[0], beforeConfig);
});

test('selected account action bar makes account deletion discoverable', () => {
  const { tui } = makeTUI(['alpha', 'yoon']);
  tui.selIdx = 1;

  const footer = stripAnsi(tui._renderFooter());
  assert.match(footer, /Selected: yoon/, 'the action bar names the selected account');
  assert.match(footer, /\[d\] Delete account/, 'delete is exposed as an explicit selected-account action');
});

test('delete confirmation names the selected account and Esc cancels', () => {
  const { tui, config } = makeTUI(['alpha', 'yoon']);
  tui.selIdx = 1;
  tui._keyNormal('d');

  const footer = stripAnsi(tui._renderFooter());
  assert.match(footer, /Delete account "yoon"\?/, 'confirmation repeats the destructive target');
  assert.match(footer, /\[Enter\] Confirm delete/, 'confirmation action is explicit');
  assert.match(footer, /\[Esc\] Cancel/, 'cancel action is explicit');

  tui._keySelect('esc');
  assert.deepEqual(config.accounts.map(a => a.name), ['alpha', 'yoon']);
});

test('delete confirmation removes yoon from memory and persisted config', () => {
  const { tui, am, config, mutations } = makeTUI(['alpha', 'yoon']);
  tui.selIdx = 1;

  tui._keyNormal('d');
  tui._keySelect('enter');

  assert.deepEqual(am.accounts.map(a => a.name), ['alpha']);
  assert.deepEqual(config.accounts.map(a => a.name), ['alpha']);
  assert.equal(mutations.at(-1).type, 'remove');
  assert.equal(mutations.at(-1).account.name, 'yoon');
});

test('select-mode (delete) → Enter removes the cursor account, Esc cancels', async () => {
  const { tui, config } = makeTUI(['a0', 'a1', 'a2']);
  tui.mode = 'select'; tui.selIdx = 1;          // cursor on a1
  tui._keySelect('esc');
  assert.equal(tui.mode, 'normal');
  assert.deepEqual(config.accounts.map(a => a.name), ['a0', 'a1', 'a2'], 'Esc cancels — nothing removed');
  // Enter path delegates to _doRemove (awaited here to assert its effect deterministically).
  await tui._doRemove(tui._displayList()[1].index);
  assert.deepEqual(config.accounts.map(a => a.name), ['a0', 'a2'], 'a1 removed on confirm');
});

test('TUI saves scoped account mutations for toggle, order, and delete', async () => {
  const { tui, am, mutations } = makeTUI(['a0', 'a1']);
  await tui._doToggleEnabled(0);
  assert.equal(mutations.at(-1).type, 'patch');
  assert.equal(mutations.at(-1).account, am.accounts[0]);
  assert.deepEqual(mutations.at(-1).fields, { enabled: false });

  tui._moveOrder(am.accounts[1], -1);
  await tui._saving;
  assert.equal(mutations.at(-1).type, 'batchPatch');
  assert.equal(mutations.at(-1).patches.length, 2);

  await tui._doRemove(0);
  assert.equal(mutations.at(-1).type, 'remove');
  assert.equal(mutations.at(-1).account.name, 'a0');
});

// ── moving accounts in the order ────────────────────────────────────────────

test('moving an unranked account up ranks it (#1) and leaves the rest on use-or-lose', async () => {
  const { tui, am, config, saves } = makeTUI();
  tui._moveOrder(am.accounts[1], -1); // a1 up → becomes the only ranked account
  assert.equal(am.accounts[1].priority, 0, 'a1 is now ranked (priority 0, shown as #1)');
  assert.equal(config.accounts[1].priority, 0, 'persisted to config');
  assert.equal(am.accounts[0].priority, null, 'unranked accounts stay null (use-or-lose)');
  assert.equal(am.accounts[2].priority, null);
  assert.equal(tui._rankOf(am.accounts[1]), 1, 'rank badge is the 1-based position');
  assert.equal(saves() >= 1, true, 'saveConfig was called');
});

test('moving up swaps order among ranked; priorities stay contiguous', async () => {
  const { tui, am } = makeTUI();
  tui._moveOrder(am.accounts[0], -1); // a0 → #1 (priority 0)
  tui._moveOrder(am.accounts[1], -1); // a1 → #2 (priority 1)
  assert.deepEqual(am.accounts.map(a => a.priority), [0, 1, null]);
  tui._moveOrder(am.accounts[1], -1); // a1 up → swaps above a0
  assert.deepEqual(am.accounts.map(a => a.priority), [1, 0, null], 'a1 now #1, a0 #2');
});

test('moving the last ranked account down un-ranks it (back to use-or-lose)', async () => {
  const { tui, am } = makeTUI(['a0', 'a1']);
  tui._moveOrder(am.accounts[0], -1); // a0 #1
  tui._moveOrder(am.accounts[1], -1); // a1 #2
  assert.deepEqual(am.accounts.map(a => a.priority), [0, 1]);
  tui._moveOrder(am.accounts[1], +1); // a1 is last ranked → down → un-rank
  assert.deepEqual(am.accounts.map(a => a.priority), [0, null], 'a1 back to auto (null)');
});

test('moving an account that is already top up, or an unranked account down, is a no-op', async () => {
  const { tui, am } = makeTUI(['a0', 'a1']);
  tui._moveOrder(am.accounts[0], -1);      // a0 #1
  tui._moveOrder(am.accounts[0], -1);      // already top → no change
  assert.deepEqual(am.accounts.map(a => a.priority), [0, null]);
  tui._moveOrder(am.accounts[1], +1);      // a1 unranked, down → no change
  assert.deepEqual(am.accounts.map(a => a.priority), [0, null]);
});

// ── display order ───────────────────────────────────────────────────────────

test('display list shows ranked accounts first (in order), then unranked', async () => {
  const { tui, am } = makeTUI(['a0', 'a1', 'a2']);
  tui._moveOrder(am.accounts[2], -1); // a2 #1
  tui._moveOrder(am.accounts[0], -1); // a0 #2
  assert.deepEqual(tui._displayList().map(a => a.name), ['a2', 'a0', 'a1'],
    'ranked (a2, a0) first by order, then unranked a1');
});

test('order mode: ↑ moves the grabbed account and the selection follows it', () => {
  const { tui, am } = makeTUI(['a0', 'a1', 'a2']);
  tui.orderAccount = am.accounts[2];
  tui.mode = 'order';
  tui.selIdx = tui._displayList().indexOf(am.accounts[2]); // 2 (unranked, bottom)
  tui._keyOrder('up'); // ranks a2 → it floats to the top of the (only) ranked group
  assert.equal(am.accounts[2].priority, 0, 'a2 became ranked');
  assert.equal(tui._displayList()[tui.selIdx], am.accounts[2], 'selection stays on the moved account');
});

test('order mode: "a" resets the ENTIRE order — every rank cleared to auto', () => {
  const { tui, am, config } = makeTUI(['a0', 'a1', 'a2']);
  tui._moveOrder(am.accounts[0], -1);            // a0 #1
  tui._moveOrder(am.accounts[1], -1);            // a1 #2
  assert.deepEqual(am.accounts.map(a => a.priority), [0, 1, null]);

  tui.orderAccount = am.accounts[2];
  tui.mode = 'order';
  tui._keyOrder('a');                             // reset the whole order
  assert.deepEqual(am.accounts.map(a => a.priority), [null, null, null], 'every account back to auto');
  // a0/a1 had ranks → explicit null persisted (so a stale disk value cannot
  // survive a merge); a2 was never ranked → its config entry stays untouched.
  assert.deepEqual(config.accounts.map(a => a.priority), [null, null, undefined]);
  assert.equal(tui.mode, 'order', 'stays in order mode (Enter/Esc to finish)');

  tui._keyOrder('a');                             // already all-auto → harmless no-op
  assert.deepEqual(am.accounts.map(a => a.priority), [null, null, null]);
});

test('order mode: "c" clears ONLY the grabbed account\'s rank', () => {
  const { tui, am, config } = makeTUI(['a0', 'a1', 'a2']);
  tui._moveOrder(am.accounts[0], -1);            // a0 #1
  tui._moveOrder(am.accounts[1], -1);            // a1 #2
  assert.deepEqual(am.accounts.map(a => a.priority), [0, 1, null]);

  tui.orderAccount = am.accounts[0];
  tui.mode = 'order';
  tui._keyOrder('c');                             // a0 → auto, a1 keeps its (renumbered) rank
  assert.equal(am.accounts[0].priority, null, 'grabbed account back to auto');
  assert.equal(am.accounts[1].priority, 0, 'remaining ranked renumbered contiguously');
  assert.equal(config.accounts[0].priority, null, 'persisted');
  assert.equal(tui._displayList()[tui.selIdx], am.accounts[0], 'selection follows the account');
});

test('display list sorts unranked accounts by the automatic drain order (weekly reset soonest first)', () => {
  const am = new AccountManager([
    { name: 'far',  type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'soon', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'pin',  type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, priority: 0 },
  ], 0.98, 0, 5);
  const now = Date.now();
  const HOUR = 3600_000;
  am.accounts[0].quota.unified7d = 0.4; am.accounts[0].quota.unified7dReset = now + 6 * 24 * HOUR;
  am.accounts[1].quota.unified7d = 0.4; am.accounts[1].quota.unified7dReset = now + 1 * 24 * HOUR;
  const tui = new TUI({ accountManager: am, config: { accounts: [] }, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {} });
  assert.deepEqual(tui._displayList().map(a => a.name), ['pin', 'soon', 'far'],
    'ranked first, then unranked by weekly reset soonest (drain order)');
});

// Regression (user report): auto ordering is a continuous MODE, not a set-time
// snapshot — when a reset time rolls over, the display order must follow at
// once, without any settings operation and without waiting for a traffic sweep.
test('the display order follows a reset rollover without any set operation', () => {
  const am = new AccountManager([
    { name: 'A', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'B', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98, 0, 5);
  const now = Date.now(), DAY = 86400_000;
  am.accounts[0].quota.unified7d = 0.4; am.accounts[0].quota.unified7dReset = now + 1 * DAY;
  am.accounts[1].quota.unified7d = 0.4; am.accounts[1].quota.unified7dReset = now + 3 * DAY;
  const tui = new TUI({ accountManager: am, config: { accounts: [] }, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {} });
  assert.deepEqual(tui._displayList().map(a => a.name), ['A', 'B'], 'A drains first (soonest weekly)');

  // A's week rolls over (its reset timestamp is now in the past) — its fresh
  // window is unknown, so it must drop below B immediately, pre-sweep.
  am.accounts[0].quota.unified7dReset = now - 1000;
  assert.deepEqual(tui._displayList().map(a => a.name), ['B', 'A'],
    'rolled-over account no longer pinned at the top by its past timestamp');
});

// Regression (adversarial review CRITICAL): the display list re-sorts live
// (quota updates reorder the auto group), so an index-based cursor could let a
// background reorder retarget a pending delete onto a NEIGHBORING account.
// The cursor must anchor the account OBJECT, not the row index.
test('a live display reorder cannot retarget a pending delete (cursor anchors the object)', () => {
  const am = new AccountManager([
    { name: 'a0', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98, 0, 5);
  const now = Date.now(), DAY = 86400_000;
  // a0 drains first (soonest weekly reset) → display order [a0, a1]
  am.accounts[0].quota.unified7d = 0.4; am.accounts[0].quota.unified7dReset = now + 1 * DAY;
  am.accounts[1].quota.unified7d = 0.4; am.accounts[1].quota.unified7dReset = now + 3 * DAY;
  const config = { accounts: [{ name: 'a0' }, { name: 'a1' }] };
  const tui = new TUI({ accountManager: am, config, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {} });

  tui.selIdx = 0;
  tui._keyNormal('d');                 // anchor the cursor on a0, enter delete-confirm
  assert.equal(tui.selAcct.name, 'a0', 'cursor anchored on the account object');

  // Background quota update flips the auto order: a1 now resets sooner → [a1, a0]
  am.accounts[1].quota.unified7dReset = now + 3600_000;
  assert.equal(tui._displayList()[0].name, 'a1', 'display order flipped under the cursor');

  tui._keySelect('enter');             // confirm — must delete the ANCHORED a0, not display[0]
  assert.deepEqual(am.accounts.map(a => a.name), ['a1'], 'the anchored account was deleted, not its neighbor');
  assert.deepEqual(config.accounts.map(a => a.name), ['a1']);
});

// ── normalization of legacy / duplicate priority values ─────────────────────

test('duplicate / legacy priority values render as distinct positions and normalize on a move', async () => {
  const am = new AccountManager([
    { name: 'a0', type: 'apikey', apiKey: 'k', priority: 1 },
    { name: 'a1', type: 'apikey', apiKey: 'k', priority: 0 },
    { name: 'a2', type: 'apikey', apiKey: 'k', priority: 1 }, // duplicate "1"
  ], 0.98, 0, 5);
  const config = { accounts: am.accounts.map(a => ({ name: a.name, priority: a.priority })) };
  const tui = new TUI({ accountManager: am, config, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {} });

  // Even with duplicate raw values, the badge shows distinct positions #1..#3.
  assert.deepEqual(tui._displayList().map(a => a.name), ['a1', 'a0', 'a2'], 'sorted by (priority, index)');
  assert.equal(tui._rankOf(am.accounts[1]), 1);
  assert.equal(tui._rankOf(am.accounts[0]), 2);
  assert.equal(tui._rankOf(am.accounts[2]), 3);

  // A move renumbers everyone to contiguous values (no more duplicates).
  tui._moveOrder(am.accounts[2], -1); // a2 up one (swap with a0)
  assert.deepEqual(am.accounts.map(a => a.priority), [2, 0, 1], 'contiguous 0,1,2 — duplicates gone');
});

test('a config priority of null loads as "unset" (use-or-lose)', () => {
  const am = new AccountManager([
    { name: 'a0', type: 'apikey', apiKey: 'k', priority: null },
    { name: 'a1', type: 'apikey', apiKey: 'k' },
  ], 0.98, 0, 5);
  assert.equal(am.accounts[0].priority, null, 'null priority loads as unset');
  assert.equal(am._priority(am.accounts[0]), Infinity, 'unset sentinel — no preference');
});

// ── generated names stay unique (identity key for credential-less accounts) ──

test('generated api names are collision-free after a delete (no duplicate)', async () => {
  const { tui, config } = makeTUI([]); // start empty
  await tui._doAddKey('sk-1');         // api-1
  await tui._doAddKey('sk-2');         // api-2
  assert.deepEqual(config.accounts.map(a => a.name), ['api-1', 'api-2']);
  await tui._doRemove(0);              // delete api-1
  assert.deepEqual(config.accounts.map(a => a.name), ['api-2']);
  await tui._doAddKey('sk-3');         // must reuse the freed api-1, NOT a 2nd api-2
  const names = config.accounts.map(a => a.name).sort();
  assert.equal(new Set(names).size, names.length, 'no duplicate account names');
  assert.deepEqual(names, ['api-1', 'api-2']);
});

// ── model-scoped weekly (Fable) quota bar ────────────────────────────────────

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

test('a wide row renders a third "Fbl" bar for an OAuth account', () => {
  const am = new AccountManager([
    { name: 'max-1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98, 0, 5);
  const now = Date.now();
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-utilization': '0.54',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + 3600_000) / 1000)),
    'anthropic-ratelimit-unified-7d-utilization': '0.73',
    'anthropic-ratelimit-unified-7d-reset': String(Math.floor((now + 86400_000) / 1000)),
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.94',
    'anthropic-ratelimit-unified-7d_oi-reset': String(Math.floor((now + 86400_000) / 1000)),
  });
  const tui = new TUI({ accountManager: am, config: { accounts: [] }, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {} });

  const wide = stripAnsi(tui._renderAcct(am.accounts[0], 0, 10, true, true));
  assert.match(wide, /Ses .*Wk .*Fbl .*94%/s, 'third bar labelled Fbl with the 7d_oi utilization');

  const mid = stripAnsi(tui._renderAcct(am.accounts[0], 0, 10, true, false));
  assert.doesNotMatch(mid, /Fbl/, 'no third bar on mid widths');
});

test('the Fbl bar prefers the 7d_oi window when multiple model windows exist', () => {
  const am = new AccountManager([
    { name: 'max-1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98, 0, 5);
  // Insert an unknown window FIRST, then 7d_oi — the bar must still show 7d_oi.
  am.accounts[0].quota.modelWeekly['7d_xx'] = { utilization: 0.11, reset: Date.now() + 86400_000 };
  am.accounts[0].quota.modelWeekly['7d_oi'] = { utilization: 0.94, reset: Date.now() + 86400_000 };
  const tui = new TUI({ accountManager: am, config: { accounts: [] }, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {} });
  const row = stripAnsi(tui._renderAcct(am.accounts[0], 0, 10, true, true));
  assert.match(row, /Fbl .*94%/s, '7d_oi (94%) shown, not the first-inserted window (11%)');
});

test('an unmeasured Fable window renders an empty Fbl bar; API-key rows pad the slot', () => {
  const am = new AccountManager([
    { name: 'max-1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'api-1', type: 'apikey', apiKey: 'sk-1' },
  ], 0.98, 0, 5);
  const tui = new TUI({ accountManager: am, config: { accounts: [] }, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {} });

  const oauthRow = stripAnsi(tui._renderAcct(am.accounts[0], 0, 10, true, true));
  assert.match(oauthRow, /Fbl/, 'OAuth row always shows the Fbl label (with "-" until measured)');

  const apiRow = stripAnsi(tui._renderAcct(am.accounts[1], 1, 10, true, true));
  assert.doesNotMatch(apiRow, /Fbl/, 'API-key accounts have no Fable window');
  assert.equal(oauthRow.length, apiRow.length, 'slot padded so columns stay aligned');
});

// ── Reload (R) re-measures quota, not just accounts ──────────────────────────

test('R (sync) also triggers the fleet quota re-measure and logs the count', async () => {
  const { tui } = makeTUI(['a0']);
  let called = 0;
  tui.refreshQuota = async () => { called++; return { targets: 1, measured: 1 }; };
  await tui._doSync();
  assert.equal(called, 1, 'refreshQuota invoked by the reload path');
  assert.equal(tui.log.some(l => /Quota re-measured for all 1 account/.test(l.msg)), true,
    'result surfaced in the activity log');
});

test('a partial refresh is reported honestly as M/N, not a blanket success', async () => {
  const { tui } = makeTUI(['a0']);
  tui.refreshQuota = async () => ({ targets: 11, measured: 3 });
  await tui._doSync();
  assert.equal(tui.log.some(l => /Quota re-measured for 3\/11 account/.test(l.msg)), true,
    'partial result surfaced with the failed/skipped remainder called out');
});

test('R without traffic yet logs an honest skip; no refreshQuota wiring stays harmless', async () => {
  const { tui } = makeTUI(['a0']);
  tui.refreshQuota = async () => -1;                    // server has no probe template
  await tui._doSync();
  assert.equal(tui.log.some(l => /no request has flowed/.test(l.msg)), true,
    'skip reason surfaced instead of a silent no-op');

  const bare = makeTUI(['a0']).tui;                     // no refreshQuota (legacy wiring)
  await bare._doSync();                                  // must not throw
  assert.equal(bare.log.some(l => /Config reloaded/.test(l.msg)), true);
});

// ── enable/disable (unchanged) ──────────────────────────────────────────────

test('TUI "e" toggle disables/enables the selected account and persists it', async () => {
  const { tui, am, config } = makeTUI();
  await tui._doToggleEnabled(0);
  assert.equal(am.accounts[0].enabled, false, 'disabled in AccountManager');
  assert.equal(config.accounts[0].enabled, false, 'persisted to config');
  await tui._doToggleEnabled(0);
  assert.equal(am.accounts[0].enabled, true, 'toggled back on');
  assert.equal(config.accounts[0].enabled, true);
});
