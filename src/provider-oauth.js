import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeExpiresAt } from './oauth.js';

const execFileAsync = promisify(execFile);
const GROK_ISSUER = 'https://auth.x.ai';
const AGY_KEYCHAIN_SERVICE = 'gemini';
const AGY_KEYCHAIN_ACCOUNT = 'antigravity';
const AGY_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';
const DEFAULT_OAUTH_TIMEOUT_MS = 15_000;

function resolvePath(filePath) {
  return String(filePath).replace(/^~/, homedir());
}

function normalizeProviderExpiry(value) {
  if (typeof value === 'number') return normalizeExpiresAt(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return normalizeExpiresAt(parsed);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return date;
  }
  return null;
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`OAuth credential requires ${field}`);
  }
  return value.trim();
}

function parseGrokEntry(raw) {
  const entries = raw && typeof raw === 'object' ? Object.entries(raw) : [];
  const [entryKey, entry] = entries.find(([, value]) => value && typeof value === 'object') || [];
  if (!entry) throw new Error('Grok auth.json contains no credential entry');
  if (!['oidc', 'oauth'].includes(entry.auth_mode)) {
    throw new Error('Grok subscription credential must use OAuth/OIDC auth_mode');
  }
  const accessToken = requireString(entry.key || entry.access_token, 'access token');
  const refreshToken = requireString(entry.refresh_token, 'refresh token');
  const oauthIssuer = requireString(entry.oidc_issuer || (entryKey?.startsWith('http') ? entryKey.split('::')[0] : GROK_ISSUER), 'issuer');
  const oauthClientId = requireString(entry.oidc_client_id || entryKey?.split('::')[1], 'client id');
  const accountUuid = requireString(entry.user_id || entry.principal_id, 'accountUuid');
  return {
    accessToken,
    refreshToken,
    expiresAt: normalizeProviderExpiry(entry.expires_at),
    accountUuid,
    email: entry.email || null,
    oauthIssuer,
    oauthClientId,
    authMode: entry.auth_mode,
  };
}

export async function importGrokCredentials(filePath = '~/.grok/auth.json') {
  let raw;
  try {
    raw = JSON.parse(await readFile(resolvePath(filePath), 'utf8'));
  } catch (err) {
    throw new Error(`Unable to read Grok OAuth credentials: ${err.message}`);
  }
  return parseGrokEntry(raw);
}

export async function loginGrokCredentials() {
  const grokHome = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'teamclaude-grok-login-'));
  try {
    const result = spawnSync('grok', ['login'], {
      stdio: 'inherit',
      env: { ...process.env, GROK_HOME: grokHome },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`grok login exited with status ${result.status ?? 1}`);
    return await importGrokCredentials(join(grokHome, 'auth.json'));
  } finally {
    await rm(grokHome, { recursive: true, force: true });
  }
}

function oauthDeadline(timeoutMs) {
  const value = Number(timeoutMs);
  return Date.now() + (Number.isFinite(value) && value > 0 ? value : DEFAULT_OAUTH_TIMEOUT_MS);
}

async function fetchJson(url, options = {}, deadlineAt = oauthDeadline()) {
  const remaining = Math.max(1, deadlineAt - Date.now());
  const controller = new AbortController();
  let timeoutReject;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutReject = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    timeoutReject(new Error('OAuth endpoint timed out'));
  }, remaining);
  try {
    const response = await Promise.race([
      fetch(url, { redirect: 'manual', ...options, signal: controller.signal }),
      timeoutPromise,
    ]);
    if (!response.ok) {
      const detail = await Promise.race([response.text().catch(() => ''), timeoutPromise]);
      let code = '';
      try {
        const parsed = JSON.parse(detail);
        code = [
          'invalid_grant', 'invalid_client', 'invalid_request',
          'unauthorized_client', 'temporarily_unavailable',
        ].includes(parsed.error) ? parsed.error : '';
      } catch {}
      throw new Error(`OAuth endpoint failed (${response.status})${code ? `: ${code}` : ''}`);
    }
    return await Promise.race([response.json(), timeoutPromise]);
  } catch (err) {
    if (controller.signal.aborted || err?.message === 'OAuth endpoint timed out') {
      throw new Error('OAuth endpoint timed out');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshGrokAccessToken(
  refreshToken,
  issuer = GROK_ISSUER,
  clientId,
  timeoutMs = DEFAULT_OAUTH_TIMEOUT_MS,
) {
  const token = requireString(refreshToken, 'refresh token');
  const client = requireString(clientId, 'client id');
  const base = requireString(issuer, 'issuer').replace(/\/$/, '');
  const deadlineAt = oauthDeadline(timeoutMs);
  const discovery = await fetchJson(`${base}/.well-known/openid-configuration`, {}, deadlineAt);
  const endpoint = requireString(discovery.token_endpoint, 'token endpoint');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token,
    client_id: client,
  });
  const data = await fetchJson(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  }, deadlineAt);
  return {
    accessToken: requireString(data.access_token, 'access token'),
    refreshToken: data.refresh_token || token,
    expiresAt: normalizeProviderExpiry(data.expires_at) || (Date.now() + (Number(data.expires_in) || 3600) * 1000),
  };
}

function parseAgyEnvelope(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || !raw.token || typeof raw.token !== 'object') {
    throw new Error('Agy credential envelope is malformed; expected token object');
  }
  if (raw.auth_method !== 'consumer') {
    throw new Error('Agy credential requires auth_method "consumer"');
  }
  const token = raw.token;
  const hasApiKeyShape = value => value && typeof value === 'object'
    && (value.apiKey || value.api_key || value.key || value.type === 'apikey');
  if (hasApiKeyShape(raw) || hasApiKeyShape(token)) {
    throw new Error('Agy subscription credentials must be OAuth, not an API key');
  }
  const accessToken = requireString(token.access_token, 'access_token');
  const refreshToken = token.refresh_token;
  if (refreshToken != null) requireString(refreshToken, 'refresh_token');
  const accountUuid = raw.account_id || raw.user_id || raw.accountUuid;
  if (!options.allowMissingIdentity) requireString(accountUuid, 'accountUuid');
  return {
    accessToken,
    refreshToken: refreshToken || null,
    expiresAt: normalizeProviderExpiry(token.expiry || token.expires_at || token.expiresAt),
    accountUuid,
    authMethod: raw.auth_method,
    projectId: raw.project_id || raw.projectId || null,
    oauthTokenEndpoint: raw.oauth_token_endpoint || raw.oauthTokenEndpoint || null,
    oauthClientId: raw.oauth_client_id || raw.oauthClientId || null,
  };
}

export async function fetchAgyAccountIdentity(accessToken, timeoutMs = DEFAULT_OAUTH_TIMEOUT_MS) {
  const token = requireString(accessToken, 'access token');
  const data = await fetchJson(AGY_USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  }, oauthDeadline(timeoutMs));
  return requireString(data.sub || data.user_id || data.account_id, 'accountUuid');
}

async function readAgyKeychain() {
  try {
    const result = await execFileAsync('security', [
      'find-generic-password', '-s', AGY_KEYCHAIN_SERVICE, '-a', AGY_KEYCHAIN_ACCOUNT, '-w',
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const value = result.stdout.trim();
    const encoded = value.startsWith('go-keyring-base64:')
      ? value.slice('go-keyring-base64:'.length)
      : value;
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (err) {
    throw new Error(`Unable to read Agy consumer OAuth credential from Keychain: ${err.message}`);
  }
}

export async function importAgyCredentials(filePath = null) {
  const fromFile = Boolean(filePath);
  const raw = fromFile ? JSON.parse(await readFile(resolvePath(filePath), 'utf8')) : await readAgyKeychain();
  const result = parseAgyEnvelope(raw, { allowMissingIdentity: !fromFile });
  if (!result.accountUuid) result.accountUuid = await fetchAgyAccountIdentity(result.accessToken);
  if (result.authMethod !== 'consumer') {
    throw new Error('Agy credential must use consumer OAuth auth_method');
  }
  return result;
}

export async function refreshAgyAccessToken(
  refreshToken,
  endpoint,
  clientId,
  timeoutMs = DEFAULT_OAUTH_TIMEOUT_MS,
) {
  const token = requireString(refreshToken, 'refresh token');
  const client = requireString(clientId, 'oauth client id');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: client });
  const data = await fetchJson(requireString(endpoint, 'oauth token endpoint'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  }, oauthDeadline(timeoutMs));
  return {
    accessToken: requireString(data.access_token, 'access token'),
    refreshToken: data.refresh_token || token,
    expiresAt: normalizeProviderExpiry(data.expires_at) || (Date.now() + (Number(data.expires_in) || 3600) * 1000),
  };
}

export async function refreshProviderAccessToken(account) {
  if (account?.provider === 'grok') {
    return refreshGrokAccessToken(account.refreshToken, account.oauthIssuer, account.oauthClientId);
  }
  if (account?.provider === 'agy') {
    return refreshAgyAccessToken(account.refreshToken, account.oauthTokenEndpoint, account.oauthClientId);
  }
  throw new Error(`Unsupported OAuth provider "${account?.provider || 'unknown'}"`);
}
