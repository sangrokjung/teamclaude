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
  const configuredProvider = config.provider || account.provider || null;
  if (provider === 'codex' && !configuredProvider) {
    throw new Error('Codex re-authentication requires an explicit Codex provider config');
  }
  if (provider && configuredProvider && provider !== configuredProvider) {
    throw new Error(`Account "${name}" belongs to provider "${configuredProvider}", not "${provider}"`);
  }
  const resolvedProvider = provider || configuredProvider || 'anthropic';
  if (!['anthropic', 'codex'].includes(resolvedProvider)) {
    throw new Error(`Re-authentication is not supported for provider "${resolvedProvider}"`);
  }
  if (account.type !== 'oauth'
      || (account.provider && account.provider !== resolvedProvider)) {
    throw new Error(`Account "${name}" is not a ${resolvedProvider} OAuth account`);
  }
  if (account.enabled === false) throw new Error(`Account "${name}" is disabled`);
  if (account.subscriptionDisabled === true) {
    throw new Error(`Account "${name}" has organization access disabled`);
  }
  return { index, account, provider: resolvedProvider };
}

export function applyReauthToConfig(config, {
  name,
  expectedAccountUuid = null,
  provider = null,
  credentials,
  profile,
}) {
  const { index, account, provider: resolvedProvider } = findReauthTarget(
    config,
    { name, expectedAccountUuid, provider },
  );
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
  const accountUuid = credentials.accountUuid || credentials.accountId
    || profile.accountUuid || account.accountUuid;
  const updated = {
    ...accountWithoutImport,
    provider: resolvedProvider,
    accountUuid,
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresAt: credentials.expiresAt,
    source: 'reauth',
  };
  for (const field of ['idToken', 'accountId', 'email', 'planType']) {
    if (credentials[field] != null) updated[field] = credentials[field];
  }
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
  const target = findReauthTarget(initialConfig, { name, expectedAccountUuid, provider });
  const credentials = await login();
  assertCompleteCredentials(credentials);
  const profile = target.provider === 'codex'
    ? {
      accountUuid: credentials.accountUuid || credentials.accountId || null,
      email: credentials.email || null,
    }
    : await fetchProfile(credentials?.accessToken);
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

function sameAccountIdentity(a, b) {
  if (a.accountUuid && b.accountUuid) return a.accountUuid === b.accountUuid;
  return a.name === b.name;
}

function findAccountByIdentity(accounts, account) {
  return accounts.find(candidate => sameAccountIdentity(candidate, account));
}

export function canReauthenticateTuiAccount(tui, account) {
  const provider = account?.provider || tui.config.provider || 'anthropic';
  return Boolean(account
    && account.type === 'oauth'
    && ['anthropic', 'codex'].includes(provider)
    && account.enabled !== false
    && account.status === 'error'
    && !['subscription-disabled', 'subscription-ended'].includes(account.errorReason)
    && !account._reauthenticating);
}

export function reauthenticateTuiAccount(tui, account) {
  if (!canReauthenticateTuiAccount(tui, account) || tui._reauthPromise) {
    return tui._reauthPromise;
  }
  const wasRunning = tui.running;
  const previousLive = {
    credential: account.credential,
    refreshToken: account.refreshToken,
    expiresAt: account.expiresAt,
    idToken: account.idToken,
    accountId: account.accountId,
    accountUuid: account.accountUuid,
    email: account.email,
    planType: account.planType,
    status: account.status,
    errorReason: account.errorReason,
    errorFromRefresh: account._errorFromRefresh,
    refreshRetryAt: account._refreshRetryAt,
  };
  const configAccount = account.accountUuid
    ? tui.config.accounts.find(candidate => candidate.accountUuid === account.accountUuid)
    : tui.config.accounts.find(candidate => candidate.name === account.name);
  const previousConfig = configAccount ? { ...configAccount } : null;

  account._reauthenticating = true;
  tui._addLog(`Re-authentication required for "${account.name}" — opening login...`);

  const run = async () => {
    if (wasRunning) tui.stop();
    try {
      const result = await tui.reauthenticate(account);
      const credentials = result?.credentials || result;
      const profile = result?.profile;
      assertCompleteCredentials(credentials);
      if (!profile || profile.error) {
        throw new Error(`could not verify the logged-in account${profile?.error ? `: ${profile.error}` : ''}`);
      }
      const sameUuid = Boolean(account.accountUuid && profile.accountUuid
        && account.accountUuid === profile.accountUuid);
      const sameEmail = !account.accountUuid && account.name && profile.email
        && account.name.toLowerCase() === profile.email.toLowerCase();
      if (!sameUuid && !sameEmail) {
        throw new Error(`logged-in account does not match "${account.name}"`);
      }
      if (!configAccount) throw new Error('selected account is missing from config');

      const newUuid = profile.accountUuid || account.accountUuid;
      Object.assign(configAccount, {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt,
        accountUuid: newUuid,
        source: 'reauth',
      });
      for (const field of ['idToken', 'accountId', 'email', 'planType']) {
        if (credentials[field] != null) configAccount[field] = credentials[field];
      }

      tui.am.updateAccountTokens(account, credentials, false);
      account.accountUuid = newUuid;
      if (credentials.email != null) account.email = credentials.email;
      const savedConfig = await tui.saveConfig(tui.config, {
        type: 'upsert',
        account: { ...configAccount },
        previous: previousConfig,
      });
      if (!Array.isArray(savedConfig?.accounts)) {
        throw new Error('re-authenticated account persistence could not be verified');
      }
      const persisted = findAccountByIdentity(savedConfig.accounts, {
        name: account.name,
        accountUuid: newUuid,
      });
      if (!persisted
          || persisted.accessToken !== credentials.accessToken
          || persisted.refreshToken !== credentials.refreshToken
          || persisted.expiresAt !== credentials.expiresAt) {
        throw new Error('re-authenticated account was not persisted');
      }
      tui._addLog(`Re-authenticated "${account.name}" successfully`);
    } catch (e) {
      account.credential = previousLive.credential;
      account.refreshToken = previousLive.refreshToken;
      account.expiresAt = previousLive.expiresAt;
      for (const field of ['idToken', 'accountId', 'accountUuid', 'email', 'planType']) {
        if (previousLive[field] === undefined) delete account[field];
        else account[field] = previousLive[field];
      }
      account.status = previousLive.status;
      if (previousLive.errorReason === undefined) delete account.errorReason;
      else account.errorReason = previousLive.errorReason;
      if (previousLive.errorFromRefresh === undefined) delete account._errorFromRefresh;
      else account._errorFromRefresh = previousLive.errorFromRefresh;
      if (previousLive.refreshRetryAt === undefined) delete account._refreshRetryAt;
      else account._refreshRetryAt = previousLive.refreshRetryAt;
      if (configAccount && previousConfig) {
        Object.keys(configAccount).forEach(key => delete configAccount[key]);
        Object.assign(configAccount, previousConfig);
      }
      tui._addLog(`Re-authentication failed for "${account.name}": ${e.message}`);
    } finally {
      delete account._reauthenticating;
      if (wasRunning) tui.start();
    }
  };
  tui._reauthPromise = run().finally(() => { tui._reauthPromise = null; });
  return tui._reauthPromise;
}
