const RECOVERY_OAUTH_MARKER = 'teamclaude-local-recovery';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function buildClaudeRecoveryEnv(baseEnv) {
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

  const recoveryEnv = { ...baseEnv };
  delete recoveryEnv.ANTHROPIC_API_KEY;
  delete recoveryEnv.ANTHROPIC_AUTH_TOKEN;
  recoveryEnv.CLAUDE_CODE_OAUTH_TOKEN = RECOVERY_OAUTH_MARKER;
  return recoveryEnv;
}
