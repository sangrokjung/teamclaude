const RECOVERY_OAUTH_PREFIX = 'teamclaude-local-recovery:';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function parseClaudeRecoveryAccount(authorization) {
  const bearerPrefix = `Bearer ${RECOVERY_OAUTH_PREFIX}`;
  if (typeof authorization !== 'string' || !authorization.startsWith(bearerPrefix)) {
    return null;
  }
  const encoded = authorization.slice(bearerPrefix.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const accountName = Buffer.from(encoded, 'base64url').toString('utf8');
  if (!accountName
      || Buffer.from(accountName, 'utf8').toString('base64url') !== encoded) {
    return null;
  }
  return accountName;
}

export function buildClaudeRecoveryEnv(baseEnv, accountName) {
  let baseUrl;
  try {
    baseUrl = new URL(baseEnv?.ANTHROPIC_BASE_URL);
  } catch {
    throw new Error('Claude recovery requires a loopback TeamClaude URL');
  }

  const isLoopback = baseUrl.protocol === 'http:'
    && LOOPBACK_HOSTS.has(baseUrl.hostname)
    && !baseUrl.username
    && !baseUrl.password
    && baseUrl.pathname === '/'
    && !baseUrl.search
    && !baseUrl.hash;
  if (!isLoopback) {
    throw new Error('Claude recovery requires a loopback TeamClaude URL');
  }
  if (typeof accountName !== 'string' || accountName.length === 0) {
    throw new Error('Claude recovery requires a selected account');
  }

  const recoveryEnv = { ...baseEnv };
  delete recoveryEnv.ANTHROPIC_API_KEY;
  delete recoveryEnv.ANTHROPIC_AUTH_TOKEN;
  const encodedAccount = Buffer.from(accountName, 'utf8').toString('base64url');
  recoveryEnv.CLAUDE_CODE_OAUTH_TOKEN = RECOVERY_OAUTH_PREFIX + encodedAccount;
  return recoveryEnv;
}
