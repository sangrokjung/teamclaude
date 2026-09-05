function matchingTargetIndexes(accounts, name, expectedAccountUuid) {
  if (expectedAccountUuid) {
    return accounts.map((account, index) => ({ account, index }))
      .filter(({ account }) => account.accountUuid === expectedAccountUuid)
      .map(({ index }) => index);
  }
  return accounts.map((account, index) => ({ account, index }))
    .filter(({ account }) => account.name === name)
    .map(({ index }) => index);
}

function snapshotValue(value) {
  if (Array.isArray(value)) return value.map(snapshotValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .map(key => [key, snapshotValue(value[key])]));
  }
  return value;
}

function accountSnapshot(account) {
  return JSON.stringify(snapshotValue(account));
}

export function findReauthTarget(config, {
  name,
  expectedAccountUuid = null,
  expectedLegacySnapshot = null,
}) {
  if (!name) throw new Error('Re-authentication requires an account name');
  if (!Array.isArray(config?.accounts)) throw new Error('TeamClaude config has no accounts');
  if (config.provider && config.provider !== 'anthropic') {
    throw new Error('Re-authentication applies to Anthropic accounts only');
  }

  const indexes = matchingTargetIndexes(config.accounts, name, expectedAccountUuid);
  if (indexes.length !== 1) {
    throw new Error(indexes.length === 0
      ? `Account "${name}" was not found with the expected identity`
      : `Account "${name}" is ambiguous`);
  }
  const index = indexes[0];
  const account = config.accounts[index];
  if (expectedAccountUuid && account.name !== name) {
    throw new Error(`Account "${name}" no longer matches the selected identity`);
  }
  if (!expectedAccountUuid && expectedLegacySnapshot
      && accountSnapshot(account) !== expectedLegacySnapshot) {
    throw new Error(`Account "${name}" changed while re-authentication was in progress`);
  }
  if (account.type !== 'oauth' || (account.provider && account.provider !== 'anthropic')) {
    throw new Error(`Account "${name}" is not an Anthropic OAuth account`);
  }
  if (account.enabled === false) throw new Error(`Account "${name}" is disabled`);
  if (account.subscriptionDisabled === true) {
    throw new Error(`Account "${name}" has organization access disabled`);
  }
  return { index, account };
}

export function applyReauthToConfig(config, {
  name,
  expectedAccountUuid = null,
  expectedLegacySnapshot = null,
  credentials,
  profile,
}) {
  const { index, account } = findReauthTarget(config, {
    name,
    expectedAccountUuid,
    expectedLegacySnapshot,
  });
  if (!credentials?.accessToken || !credentials?.refreshToken || credentials.expiresAt == null) {
    throw new Error('OAuth login returned incomplete credentials');
  }
  if (!profile || profile.error) {
    throw new Error(`Could not verify the logged-in account${profile?.error ? `: ${profile.error}` : ''}`);
  }

  const sameUuid = Boolean(account.accountUuid && profile.accountUuid
    && account.accountUuid === profile.accountUuid);
  const sameEmail = !account.accountUuid && profile.email
    && account.name.toLowerCase() === profile.email.toLowerCase();
  if (!sameUuid && !sameEmail) {
    throw new Error(`Logged-in account does not match "${account.name}"`);
  }

  const updated = {
    ...account,
    accountUuid: profile.accountUuid || account.accountUuid,
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresAt: credentials.expiresAt,
    source: 'reauth',
    authVerifiedAt: Date.now(),
    authVerifiedAccountUuid: profile.accountUuid || account.accountUuid || null,
  };
  delete updated.authRevoked;
  delete updated.authRevokedAt;
  delete updated.importFrom;
  config.accounts[index] = updated;
  return updated;
}

export async function reauthenticateAccount({
  name,
  expectedAccountUuid = null,
  loadConfig,
  login,
  fetchProfile,
  atomicUpdate,
}) {
  const initialConfig = await loadConfig();
  const initialTarget = findReauthTarget(initialConfig, { name, expectedAccountUuid });
  const pinnedAccountUuid = expectedAccountUuid || initialTarget.account.accountUuid || null;
  const initialLegacySnapshot = pinnedAccountUuid ? null : accountSnapshot(initialTarget.account);
  const credentials = await login();
  const profile = await fetchProfile(credentials?.accessToken);
  applyReauthToConfig({
    ...initialConfig,
    accounts: initialConfig.accounts.map(account => ({ ...account })),
  }, {
    name,
    expectedAccountUuid: pinnedAccountUuid,
    expectedLegacySnapshot: initialLegacySnapshot,
    credentials,
    profile,
  });
  let updated;
  const savedConfig = await atomicUpdate(config => {
    updated = applyReauthToConfig(config, {
      name,
      expectedAccountUuid: pinnedAccountUuid,
      expectedLegacySnapshot: initialLegacySnapshot,
      credentials,
      profile,
    });
  });
  return { updated, savedConfig };
}
