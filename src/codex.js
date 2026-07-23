import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

const CODEX_REFRESH_ENDPOINT = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';
const OPENAI_PROFILE_CLAIM = 'https://api.openai.com/profile';
const TOKEN_REFRESH_TIMEOUT_MS = 30_000;

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return {};
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    const value = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function parseCodexTokens(raw) {
  const tokens = raw?.tokens;
  if (!tokens || typeof tokens !== 'object') {
    throw new Error('Codex auth.json must contain a "tokens" object');
  }
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) {
    throw new Error('Codex auth.json is missing tokens.access_token');
  }
  if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) {
    throw new Error('Codex auth.json is missing tokens.refresh_token');
  }

  const idClaims = decodeJwtPayload(tokens.id_token);
  const accessClaims = decodeJwtPayload(tokens.access_token);
  const authClaims = idClaims[OPENAI_AUTH_CLAIM] || accessClaims[OPENAI_AUTH_CLAIM] || {};
  const profileClaims = accessClaims[OPENAI_PROFILE_CLAIM] || {};
  const accountId = tokens.account_id || authClaims.chatgpt_account_id || null;
  if (!accountId) {
    throw new Error('Codex auth.json is missing the ChatGPT account id');
  }

  const exp = Number(accessClaims.exp);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: typeof tokens.id_token === 'string' ? tokens.id_token : null,
    accountId,
    accountUuid: accountId,
    email: idClaims.email || profileClaims.email || null,
    planType: authClaims.chatgpt_plan_type || null,
    expiresAt: Number.isFinite(exp) ? exp * 1000 : null,
  };
}

export async function importCodexCredentials(filePath = '~/.codex/auth.json') {
  const resolvedPath = filePath.replace(/^~/, homedir());
  const raw = JSON.parse(await readFile(resolvedPath, 'utf-8'));
  return parseCodexTokens(raw);
}

export function parseCodexCredentialsJson(raw) {
  return parseCodexTokens(raw);
}

export async function refreshCodexAccessToken(
  refreshToken,
  endpoint = CODEX_REFRESH_ENDPOINT,
) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(TOKEN_REFRESH_TIMEOUT_MS),
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Codex token refresh failed (${response.status})`);
  }

  const data = await response.json();
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('Codex token refresh response is missing access_token');
  }

  const idClaims = decodeJwtPayload(data.id_token);
  const accessClaims = decodeJwtPayload(data.access_token);
  const authClaims = idClaims[OPENAI_AUTH_CLAIM] || accessClaims[OPENAI_AUTH_CLAIM] || {};
  const profileClaims = accessClaims[OPENAI_PROFILE_CLAIM] || {};
  const exp = Number(accessClaims.exp);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    idToken: typeof data.id_token === 'string' ? data.id_token : null,
    accountId: authClaims.chatgpt_account_id || null,
    email: idClaims.email || profileClaims.email || null,
    planType: authClaims.chatgpt_plan_type || null,
    expiresAt: Number.isFinite(exp)
      ? exp * 1000
      : Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
}

export function buildCodexProxyArgs(port, userArgs) {
  const provider = [
    'name = "TeamCodex"',
    `base_url = "http://127.0.0.1:${port}/codex"`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    'supports_websockets = false',
  ].join(', ');
  return [
    '-c',
    'model_provider="teamcodex_proxy"',
    '-c',
    `model_providers.teamcodex_proxy={ ${provider} }`,
    '-c',
    `chatgpt_base_url="http://127.0.0.1:${port}"`,
    ...userArgs,
  ];
}
