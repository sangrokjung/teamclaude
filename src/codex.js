import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const CODEX_REFRESH_ENDPOINT = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';
const OPENAI_PROFILE_CLAIM = 'https://api.openai.com/profile';
const TOKEN_REFRESH_TIMEOUT_MS = 30_000;
const UNSAFE_CODEX_RESUME_OPTIONS = new Set([
  '--local-provider',
  '--oss',
  '--remote',
  '--remote-auth-token-env',
]);

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
    let terminalAuthentication = response.status === 401;
    if (response.status === 400) {
      const raw = await response.text().catch(() => '');
      try {
        terminalAuthentication = JSON.parse(raw)?.error === 'invalid_grant';
      } catch {
        terminalAuthentication = false;
      }
    } else {
      await response.body?.cancel();
    }
    const error = new Error(`Codex token refresh failed (${response.status})`);
    error.terminalAuthentication = terminalAuthentication;
    throw error;
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

export function resolveCodexCliBin({
  env = process.env,
  execPath = process.execPath,
  exists = existsSync,
  platform = process.platform,
} = {}) {
  // A bare PATH lookup of `codex` can be shadowed by a shell wrapper/symlink
  // (e.g. an agent router that ships sessions to a remote host) — that breaks
  // `login`, whose throwaway CODEX_HOME must be written on THIS machine
  // (2026-08-04 incident). Prefer the CLI co-installed with the running Node;
  // TEAMCODEX_CODEX_BIN stays as the explicit escape hatch in both directions.
  if (env.TEAMCODEX_CODEX_BIN) return env.TEAMCODEX_CODEX_BIN;
  if (platform !== 'win32') {
    // win32: the extension-less `codex` next to node.exe is npm's POSIX shim,
    // which CreateProcess can't run — the bare lookup resolving codex.exe wins.
    const sibling = join(dirname(execPath), 'codex');
    if (exists(sibling)) return sibling;
  }
  return 'codex';
}

export function codexCliNotFoundMessage(codexBin, env = process.env) {
  if (codexBin === 'codex') return 'Codex CLI not found in PATH. Install it first.';
  return env.TEAMCODEX_CODEX_BIN
    ? `Codex CLI not found at ${codexBin} — check TEAMCODEX_CODEX_BIN.`
    : `Codex CLI not found at ${codexBin}. Install it first.`;
}

export function buildCodexProxyArgs(port, userArgs) {
  // requires_openai_auth stays false: the proxy strips the client's
  // authorization/chatgpt-account-id and injects the pool account's, so a
  // local ~/.codex login adds nothing upstream — but requiring it lets a
  // revoked local grant block `codex run` with the sign-in screen while the
  // pool is healthy (2026-08-03 incident).
  const provider = [
    'name = "TeamCodex"',
    `base_url = "http://127.0.0.1:${port}/codex"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
  ].join(', ');
  const overrides = [
    '-c',
    'model_provider="teamcodex_proxy"',
    '-c',
    `model_providers.teamcodex_proxy={ ${provider} }`,
    '-c',
    `chatgpt_base_url="http://127.0.0.1:${port}"`,
  ];
  if (userArgs[0] === 'resume') {
    return [...userArgs, ...overrides];
  }
  return [...overrides, ...userArgs];
}

export function assertSafeCodexResumeArgs(userArgs) {
  for (const arg of userArgs) {
    if (arg === '--') break;
    const option = arg.split('=', 1)[0];
    if (UNSAFE_CODEX_RESUME_OPTIONS.has(option)) {
      throw new Error(
        `Codex resume option ${option} bypasses TeamCodex provider routing.`,
      );
    }
  }
}
