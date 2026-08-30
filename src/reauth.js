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

function assertCompleteCredentials(credentials) {
  if (!credentials?.accessToken || !credentials?.refreshToken || credentials.expiresAt == null) {
    throw new Error('OAuth login returned incomplete credentials');
  }
}

export function findReauthTarget(config, {
  name,
  expectedAccountUuid = null,
  provider = null,
}) {
  if (!name) throw new Error('Re-authentication requires an account name');
  if (!Array.isArray(config?.accounts)) throw new Error('TeamClaude config has no accounts');
  if ((provider && provider !== 'anthropic')
      || (config.provider && config.provider !== 'anthropic')) {
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
  provider = null,
  credentials,
  profile,
}) {
  const { index, account } = findReauthTarget(config, { name, expectedAccountUuid, provider });
  assertCompleteCredentials(credentials);
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

  const accountWithoutImport = { ...account };
  delete accountWithoutImport.importFrom;
  const updated = {
    ...accountWithoutImport,
    accountUuid: profile.accountUuid || account.accountUuid,
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresAt: credentials.expiresAt,
    source: 'reauth',
  };
  config.accounts[index] = updated;
  return updated;
}

export async function reauthenticateAccount({
  name,
  expectedAccountUuid = null,
  provider = null,
  loadConfig,
  login,
  fetchProfile,
  atomicUpdate,
}) {
  const initialConfig = await loadConfig();
  findReauthTarget(initialConfig, { name, expectedAccountUuid, provider });
  const credentials = await login();
  assertCompleteCredentials(credentials);
  const profile = await fetchProfile(credentials?.accessToken);
  applyReauthToConfig({
    ...initialConfig,
    accounts: initialConfig.accounts.map(account => ({ ...account })),
  }, {
    name,
    expectedAccountUuid,
    provider,
    credentials,
    profile,
  });
  let updated;
  const savedConfig = await atomicUpdate(config => {
    updated = applyReauthToConfig(config, {
      name,
      expectedAccountUuid,
      provider,
      credentials,
      profile,
    });
  });
  return { updated, savedConfig };
}
