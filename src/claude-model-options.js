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

import { mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeExpiresAt } from './oauth.js';

export const BOOTSTRAP_URL = 'https://api.anthropic.com/api/claude_cli/bootstrap';
const OAUTH_BETA = 'oauth-2025-04-20';
// One refresh per window is plenty: many sessions launch per minute.
export const MODEL_OPTIONS_REFRESH_MS = 10 * 60 * 1000;
const TOKEN_MIN_LIFETIME_MS = 60 * 1000;
// Claude Code serializes writers of its global config with proper-lockfile:
// a `<config>.lock` directory, treated as abandoned once its mtime is older
// than 10s. We take the same lock, never steal it, and give up long before
// another process could consider our hold stale.
const LOCK_WAIT_MS = 1500;
const LOCK_RETRY_MS = 50;
const LOCK_HOLD_LIMIT_MS = 5000;
const ACCOUNT_WAIT_MS = 2000;
const ACCOUNT_RETRY_MS = 250;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// The four model fields, shaped the way Claude Code stores them; null when the
// answer does not match that shape (the existing cache is then kept).
export function modelFieldsFromBootstrap(body) {
  if (!isPlainObject(body)) return null;
  const options = body.additional_model_options ?? [];
  const costs = body.additional_model_costs ?? {};
  const access = body.model_access ?? [];
  const orgDefault = body.org_model_default ?? null;
  if (!Array.isArray(options)
      || !options.every(option => isPlainObject(option) && typeof option.value === 'string')) return null;
  if (!isPlainObject(costs)) return null;
  if (!Array.isArray(access)) return null;
  if (orgDefault !== null && typeof orgDefault !== 'string' && !isPlainObject(orgDefault)) return null;
  return {
    additionalModelOptionsCache: options,
    additionalModelCostsCache: costs,
    modelAccessCache: access,
    orgModelDefaultCache: orgDefault,
  };
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
  return modelFieldsFromBootstrap(await response.json().catch(() => null));
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Claude Code's config lock (see LOCK_* above). Resolves to a release function,
// or null when the lock stayed busy for the whole wait.
export async function acquireConfigLock(configPath, { waitMs = LOCK_WAIT_MS } = {}) {
  const lockPath = `${configPath}.lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await mkdir(lockPath);
      return async () => { await rmdir(lockPath).catch(() => {}); };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) return null;
      await sleep(LOCK_RETRY_MS);
    }
  }
}

// Under Claude Code's own config lock: read → merge → write a sibling temp
// file → rename. Every Claude Code writer takes the same lock, so its writes
// cannot interleave with ours; the stat check additionally abandons the write
// if something wrote without the lock since our read.
export async function persistModelFields(configPath, fields, {
  now = Date.now(),
  beforeCommit = null,
  lockWaitMs = LOCK_WAIT_MS,
} = {}) {
  try {
    await stat(configPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return 'missing';
    throw err;
  }
  const release = await acquireConfigLock(configPath, { waitMs: lockWaitMs });
  if (!release) return 'locked';
  const lockedAt = Date.now();
  try {
    const before = await stat(configPath);
    let config;
    try {
      config = JSON.parse(await readFile(configPath, 'utf8'));
    } catch {
      return 'unparseable';
    }
    if (!isPlainObject(config)) return 'unparseable';

    const changed = Object.entries(fields).some(([key, value]) => !sameJson(config[key], value));
    const recent = typeof config.additionalModelOptionsAnsweredAt === 'number'
      && now - config.additionalModelOptionsAnsweredAt < MODEL_OPTIONS_REFRESH_MS;
    if (!changed && recent) return 'unchanged';

    const next = { ...config, ...fields, additionalModelOptionsAnsweredAt: now };
    const tmpPath = `${configPath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(tmpPath, JSON.stringify(next, null, 2), { mode: before.mode & 0o777, flag: 'wx' });
      if (beforeCommit) await beforeCommit();
      const current = await stat(configPath);
      if (current.mtimeMs !== before.mtimeMs || current.size !== before.size
          || Date.now() - lockedAt > LOCK_HOLD_LIMIT_MS) {
        await unlink(tmpPath);
        return 'raced';
      }
      await rename(tmpPath, configPath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
    return changed ? 'updated' : 'refreshed';
  } finally {
    await release();
  }
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

// `loadAccounts` re-reads the pool from disk: a proxy started by this very
// launch refreshes lapsed tokens in its startup sweep and persists them, so the
// launcher's earlier snapshot can hold only expired tokens. It is polled for a
// short while until a usable account appears.
async function pickWithReload(loadAccounts, preferredUuid, { waitMs, retryMs, now }) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const accounts = await loadAccounts().catch(() => null);
    const picked = pickBootstrapAccount(accounts, preferredUuid, now);
    if (picked || Date.now() >= deadline) return picked;
    await sleep(retryMs);
  }
}

// Best effort: any failure leaves Claude Code's cache exactly as it was and
// never blocks the launch beyond a few seconds. Returns an outcome label.
export async function refreshClaudeModelOptions({
  loadAccounts,
  preferredUuid = null,
  env = process.env,
  home = homedir(),
  fetchImpl = fetch,
  now = Date.now(),
  timeoutMs = 3000,
  accountWaitMs = ACCOUNT_WAIT_MS,
  accountRetryMs = ACCOUNT_RETRY_MS,
} = {}) {
  try {
    const configPath = claudeGlobalConfigPath(env, home);
    // No config yet (first run, or a throwaway HOME): nothing cached can go
    // stale, so spend no token and no network on it.
    try {
      await stat(configPath);
    } catch (err) {
      if (err?.code === 'ENOENT') return 'missing';
      throw err;
    }
    if (await modelOptionsAreFresh(configPath, now)) return 'fresh';
    const picked = await pickWithReload(loadAccounts, preferredUuid, {
      waitMs: accountWaitMs,
      retryMs: accountRetryMs,
      now,
    });
    if (!picked) return 'no-account';
    const fields = await fetchBootstrapModelFields(picked.token, { fetchImpl, timeoutMs });
    if (!fields) return 'fetch-failed';
    return await persistModelFields(configPath, fields, { now });
  } catch {
    return 'error';
  }
}
