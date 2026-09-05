const PROVIDERS = Object.freeze({
  anthropic: Object.freeze({
    name: 'anthropic',
    defaultUpstream: 'https://api.anthropic.com',
    credentialEnv: 'ANTHROPIC_API_KEY',
    authHeader: 'anthropic-api-key',
    defaultPath: '/v1/messages',
  }),
  codex: Object.freeze({
    name: 'codex',
    defaultUpstream: 'https://chatgpt.com/backend-api/codex',
    credentialEnv: null,
    authHeader: 'authorization-bearer',
    defaultPath: '/responses',
  }),
  grok: Object.freeze({
    name: 'grok',
    defaultUpstream: 'https://cli-chat-proxy.grok.com/v1',
    credentialEnv: null,
    authMode: 'oauth',
    authHeader: 'authorization-bearer',
    defaultPath: '/chat/completions',
  }),
  agy: Object.freeze({
    name: 'agy',
    defaultUpstream: 'https://daily-cloudcode-pa.googleapis.com',
    credentialEnv: null,
    authMode: 'oauth',
    authHeader: 'authorization-bearer',
    defaultPath: '/v1internal:streamGenerateContent',
  }),
});

export const PROVIDER_NAMES = Object.freeze(Object.keys(PROVIDERS));

export function normalizeProvider(value, fallback = 'anthropic') {
  if (value == null || value === '') return fallback;
  if (typeof value === 'string' && Object.hasOwn(PROVIDERS, value)) return value;
  throw new Error(`Unsupported provider "${value}"`);
}

export function assertSupportedProvider(value) {
  if (typeof value !== 'string' || !Object.hasOwn(PROVIDERS, value)) {
    throw new Error(`Unsupported provider "${value}"`);
  }
  return value;
}

export function getProviderDefinition(value) {
  const provider = assertSupportedProvider(value);
  return { ...PROVIDERS[provider] };
}

export function validateProviderAccounts(provider, accounts = [], options = {}) {
  getProviderDefinition(provider);
  const requireMetadata = options.requireMetadata === true;
  const allowInternalAuth = options.allowInternalAuth === true;
  for (const account of accounts) {
    const accountProvider = account.provider || provider;
    if (accountProvider !== provider) {
      throw new Error(
        `Account "${account.name || 'unnamed'}" uses provider "${accountProvider}" `
        + `but this config uses provider "${provider}"`,
      );
    }
    if (provider === 'grok' || provider === 'agy') {
      if (requireMetadata && account.provider !== provider) {
        throw new Error(`${provider} OAuth account requires provider "${provider}"`);
      }
      if (account.type !== 'oauth') {
        throw new Error(`${provider} subscription accounts require type "oauth"`);
      }
      if (Object.hasOwn(account, 'apiKey')) {
        throw new Error(`${provider} subscription accounts cannot contain apiKey`);
      }
      if (!allowInternalAuth && Object.hasOwn(account, 'credential')) {
        throw new Error(`${provider} subscription accounts cannot contain credential`);
      }
      const accessToken = account.accessToken;
      if (typeof accessToken !== 'string' || accessToken.trim() === '') {
        throw new Error(`${provider} OAuth account requires accessToken`);
      }
      if (provider === 'grok'
          && (typeof account.refreshToken !== 'string' || account.refreshToken.trim() === '')) {
        throw new Error(`${provider} OAuth account requires refreshToken`);
      }
      if (provider === 'agy' && account.refreshToken != null
          && (typeof account.refreshToken !== 'string' || account.refreshToken.trim() === '')) {
        throw new Error(`${provider} OAuth account refreshToken must be a non-empty string when present`);
      }
      if (requireMetadata && (typeof account.accountUuid !== 'string' || account.accountUuid.trim() === '')) {
        throw new Error(`${provider} OAuth account requires accountUuid`);
      }
      if (requireMetadata && (!Number.isFinite(account.expiresAt) || account.expiresAt <= 0)) {
        throw new Error(`${provider} OAuth account requires expiresAt`);
      }
      if (requireMetadata && provider === 'grok') {
        if (typeof account.oauthIssuer !== 'string' || account.oauthIssuer.trim() === '') {
          throw new Error('grok OAuth account requires oauthIssuer');
        }
        if (typeof account.oauthClientId !== 'string' || account.oauthClientId.trim() === '') {
          throw new Error('grok OAuth account requires oauthClientId');
        }
      }
      if (requireMetadata && provider === 'agy' && account.authMethod !== 'consumer') {
        throw new Error('agy OAuth account requires authMethod "consumer"');
      }
    }
  }
}

export function providerConfigFileName(provider) {
  switch (normalizeProvider(provider)) {
    case 'codex': return 'teamcodex.json';
    case 'grok': return 'teamgrok.json';
    case 'agy': return 'teamagy.json';
    default: return 'teamclaude.json';
  }
}

export function providerDefaultPort(provider) {
  switch (normalizeProvider(provider)) {
    case 'codex': return 3457;
    case 'grok': return 3458;
    case 'agy': return 3459;
    default: return 3456;
  }
}

export function providerAuthHeaders(provider, account) {
  const definition = getProviderDefinition(provider);
  if ((provider === 'grok' || provider === 'agy')
      && (account?.type !== 'oauth' || Object.hasOwn(account, 'apiKey'))) {
    throw new Error(`${provider} subscription accounts require OAuth credentials`);
  }
  let credential;
  if (provider === 'grok' || provider === 'agy') {
    credential = account?.accessToken;
    if (!credential) {
      throw new Error(`${provider} subscription accounts require an accessToken`);
    }
  } else {
    credential = account?.credential || account?.accessToken || account?.apiKey;
  }
  if (!credential) throw new Error(`Account "${account?.name || 'unnamed'}" has no credential`);
  switch (definition.authHeader) {
    case 'authorization-bearer':
      return { authorization: `Bearer ${credential}` };
    case 'x-goog-api-key':
      return { 'x-goog-api-key': credential };
    default:
      return { 'x-api-key': credential };
  }
}

export function buildProviderUpstreamUrl(provider, upstream, requestPath) {
  if (provider === 'grok' && typeof requestPath === 'string'
      && requestPath.startsWith('/v1/')
      && new URL(upstream).pathname.replace(/\/$/, '') === '/v1') {
    return `${upstream.replace(/\/$/, '')}${requestPath.slice('/v1'.length)}`;
  }
  return `${upstream}${requestPath}`;
}
