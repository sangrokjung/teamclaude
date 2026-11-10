// Keeps Claude Code's /model picker in step with the server.
//
// Claude Code learns which extra models to offer (e.g. a newly launched Fable
// version) from GET https://api.anthropic.com/api/claude_cli/bootstrap and
// caches the answer in its global config (~/.claude.json, or
// $CLAUDE_CONFIG_DIR/.claude.json). That request does not go through
// ANTHROPIC_BASE_URL: it is sent straight to api.anthropic.com with the
// session's own OAuth token. A TeamClaude-launched session carries only the
// local recovery marker as its token, so the request answers 401 and the
// cache is never refreshed — the picker kept showing whatever the server said
// on the last day the session had a real token (2026-11-10 incident: "Fable
// 5.1" long after Claude Code itself shipped Fable 5.2).
//
// The launcher therefore performs that bootstrap once on the session's behalf
// with a pool account's real token and persists the model fields exactly the
// way Claude Code does (absent fields become empty, so Claude Code falls back
// to the newest models built into the installed binary).

import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeExpiresAt } from './oauth.js';

export const BOOTSTRAP_URL = 'https://api.anthropic.com/api/claude_cli/bootstrap';
const OAUTH_BETA = 'oauth-2025-04-20';
// One refresh per window is plenty: many sessions launch per minute.
export const MODEL_OPTIONS_REFRESH_MS = 10 * 60 * 1000;
const TOKEN_MIN_LIFETIME_MS = 60 * 1000;

export function claudeGlobalConfigPath(env = process.env, home = homedir()) {
  const dir = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.length > 0
    ? env.CLAUDE_CONFIG_DIR
    : home;
  return join(dir, '.claude.json');
}

// Config accounts (teamclaude.json) store the OAuth access token as
// `accessToken`; in-memory AccountManager entries call it `credential`.
function accountToken(account) {
  const token = account?.accessToken ?? account?.credential;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

// The pool account whose token answers the bootstrap: the account the session
// was seeded with when it is usable, otherwise any usable Anthropic OAuth one.
// Returns { account, token } or null.
export function pickBootstrapAccount(accounts, preferredUuid = null, now = Date.now()) {
  if (!Array.isArray(accounts)) return null;
  const usable = accounts.filter(account => account
    && (account.provider ?? 'anthropic') === 'anthropic'
    && account.type === 'oauth'
    && account.enabled !== false
    && account.subscriptionDisabled !== true
    && accountToken(account) != null
    && Number(normalizeExpiresAt(account.expiresAt)) > now + TOKEN_MIN_LIFETIME_MS);
  const chosen = (preferredUuid && usable.find(account => account.accountUuid === preferredUuid))
    || usable[0];
  return chosen ? { account: chosen, token: accountToken(chosen) } : null;
}

export async function fetchBootstrapModelFields(token, {
  fetchImpl = fetch,
  timeoutMs = 3000,
  url = BOOTSTRAP_URL,
} = {}) {
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': OAUTH_BETA,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const options = body.additional_model_options;
  if (options != null && !Array.isArray(options)) return null;
  return {
    additionalModelOptionsCache: options ?? [],
    additionalModelCostsCache: body.additional_model_costs ?? {},
    modelAccessCache: body.model_access ?? [],
    orgModelDefaultCache: body.org_model_default ?? null,
  };
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Read → merge → write a sibling temp file → rename, the same pattern Claude
// Code uses. The file is shared by every running session, so the write is
// abandoned when the file changed between our read and the rename (another
// writer won; their content must not be clobbered by our older snapshot).
export async function persistModelFields(configPath, fields, { now = Date.now(), beforeCommit = null } = {}) {
  let before;
  let raw;
  try {
    before = await stat(configPath);
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return 'missing';
    throw err;
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return 'unparseable';
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 'unparseable';

  const changed = Object.entries(fields).some(([key, value]) => !sameJson(config[key], value));
  const recent = typeof config.additionalModelOptionsAnsweredAt === 'number'
    && now - config.additionalModelOptionsAnsweredAt < MODEL_OPTIONS_REFRESH_MS;
  if (!changed && recent) return 'unchanged';

  const next = { ...config, ...fields, additionalModelOptionsAnsweredAt: now };
  const tmpPath = `${configPath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  await writeFile(tmpPath, JSON.stringify(next, null, 2), { mode: before.mode & 0o777, flag: 'wx' });
  try {
    if (beforeCommit) await beforeCommit();
    const current = await stat(configPath);
    if (current.mtimeMs !== before.mtimeMs || current.size !== before.size) {
      await unlink(tmpPath);
      return 'raced';
    }
    await rename(tmpPath, configPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
  return changed ? 'updated' : 'refreshed';
}

// Whether the cached answer is fresh enough to skip the network round trip.
export async function modelOptionsAreFresh(configPath, now = Date.now()) {
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    return typeof config?.additionalModelOptionsAnsweredAt === 'number'
      && now - config.additionalModelOptionsAnsweredAt < MODEL_OPTIONS_REFRESH_MS
      && config.additionalModelOptionsAnsweredAt <= now;
  } catch {
    return false;
  }
}

// Best effort: any failure leaves Claude Code's cache exactly as it was and
// never blocks the launch.
export async function refreshClaudeModelOptions({
  accounts,
  preferredUuid = null,
  env = process.env,
  home = homedir(),
  fetchImpl = fetch,
  now = Date.now(),
  timeoutMs = 3000,
} = {}) {
  try {
    const configPath = claudeGlobalConfigPath(env, home);
    if (await modelOptionsAreFresh(configPath, now)) return 'fresh';
    const picked = pickBootstrapAccount(accounts, preferredUuid, now);
    if (!picked) return 'no-account';
    const fields = await fetchBootstrapModelFields(picked.token, { fetchImpl, timeoutMs });
    if (!fields) return 'fetch-failed';
    return await persistModelFields(configPath, fields, { now });
  } catch {
    return 'error';
  }
}
