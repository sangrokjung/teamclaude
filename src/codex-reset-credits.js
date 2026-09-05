// Codex-mode rate-limit reset credits ("Full reset" grants shown under /usage
// in the Codex CLI). Pure helpers + one network call; no proxy state lives
// here. Contract verified against openai/codex main (2026-09-05):
//   GET  <chatgpt_base>/wham/usage                      → rate_limit_reset_credits.available_count
//   POST <chatgpt_base>/wham/rate-limit-reset-credits/consume
//        {redeem_request_id, credit_id?} → {code, credit, windows_reset}
// Spec: docs/specs/2026-09-05-codex-reset-credits.md
import { randomUUID } from 'node:crypto';

export const CODEX_RESET_CREDIT_CODES = new Set([
  'reset', 'nothing_to_reset', 'no_credit', 'already_redeemed',
]);
export const DEFAULT_CODEX_RESET_CREDITS_COOLDOWN_MS = 30 * 60 * 1000;
export const DEFAULT_CODEX_RESET_CREDITS_TIMEOUT_MS = 10_000;

/**
 * `<upstream minus trailing /codex>/wham/rate-limit-reset-credits[/consume]`.
 * Mirrors codexUsageEndpoint() in server.js so a custom upstream keeps both
 * endpoints on the same base.
 */
export function codexResetCreditsEndpoint(upstream, { consume = false } = {}) {
  const url = new URL(upstream);
  const base = url.pathname.replace(/\/codex\/?$/, '').replace(/\/$/, '');
  url.pathname = `${base}/wham/rate-limit-reset-credits${consume ? '/consume' : ''}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function normalizeCodexResetCreditsConfig(config = {}, provider = 'codex') {
  const cooldownMs = Number.isFinite(config?.codexResetCreditsCooldownMs)
    ? Math.max(0, Math.floor(config.codexResetCreditsCooldownMs))
    : DEFAULT_CODEX_RESET_CREDITS_COOLDOWN_MS;
  const reserve = Number.isInteger(config?.codexResetCreditsReserve) && config.codexResetCreditsReserve > 0
    ? config.codexResetCreditsReserve
    : 0;
  const timeoutMs = Number.isFinite(config?.codexResetCreditsTimeoutMs) && config.codexResetCreditsTimeoutMs > 0
    ? Math.floor(config.codexResetCreditsTimeoutMs)
    : DEFAULT_CODEX_RESET_CREDITS_TIMEOUT_MS;
  return {
    enabled: provider === 'codex' && config?.codexResetCredits === true,
    policy: config?.codexResetCreditsPolicy === 'account' ? 'account' : 'fleet',
    cooldownMs,
    reserve,
    timeoutMs,
  };
}

/** available_count from a wham/usage payload, or null when absent/invalid. */
export function parseCodexResetCreditsAvailable(payload) {
  const value = payload?.rate_limit_reset_credits?.available_count;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Is this account out of quota from the proxy's point of view? A throttle
 * with a future rateLimitedUntil (set on an exhaustion 429) or a measured
 * utilization at/over the switch threshold (isExhausted). Both are the states
 * a reset credit can actually help with.
 */
export function isCodexAccountExhausted(account, { now = Date.now(), isExhausted } = {}) {
  if (!account) return false;
  if (account.status === 'throttled' && Number.isFinite(account.rateLimitedUntil)
      && account.rateLimitedUntil > now) return true;
  return typeof isExhausted === 'function' ? isExhausted(account) === true : false;
}

/**
 * Eligibility for an AUTOMATIC redemption. Returns { eligible, reason } so a
 * caller can log why a candidate was skipped.
 */
export function codexResetCreditEligibility(account, {
  now = Date.now(),
  reserve = 0,
  cooldownMs = DEFAULT_CODEX_RESET_CREDITS_COOLDOWN_MS,
  isExhausted,
} = {}) {
  if (!account || account.provider !== 'codex' || account.type !== 'oauth') {
    return { eligible: false, reason: 'not-codex-oauth' };
  }
  if (account.enabled === false) return { eligible: false, reason: 'disabled' };
  if (account.status === 'error') return { eligible: false, reason: 'error' };
  if (account.authRevoked === true) return { eligible: false, reason: 'auth-revoked' };
  if (!account.credential) return { eligible: false, reason: 'no-credential' };
  const quota = account.quota || {};
  const credits = quota.codexResetCredits;
  if (!Number.isInteger(credits)) return { eligible: false, reason: 'credits-unknown' };
  if (credits <= reserve) return { eligible: false, reason: credits === 0 ? 'no-credits' : 'reserved' };
  const lastAt = Number.isFinite(quota.codexResetCreditLastAt) ? quota.codexResetCreditLastAt : 0;
  if (cooldownMs > 0 && now - lastAt < cooldownMs) return { eligible: false, reason: 'cooldown' };
  if (!isCodexAccountExhausted(account, { now, isExhausted })) {
    return { eligible: false, reason: 'not-exhausted' };
  }
  return { eligible: true, reason: 'ok' };
}

/**
 * Exhausted accounts that may redeem right now, best first: most cached
 * credits (spread the expiry risk), then the LATEST natural weekly reset (a
 * reset credit buys the most time there), then pool order.
 */
export function rankCodexResetCreditCandidates(accounts, options = {}) {
  const list = Array.isArray(accounts) ? accounts : [];
  return list
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => codexResetCreditEligibility(account, options).eligible)
    .sort((a, b) => {
      const creditsA = a.account.quota?.codexResetCredits ?? 0;
      const creditsB = b.account.quota?.codexResetCredits ?? 0;
      if (creditsA !== creditsB) return creditsB - creditsA;
      const resetA = Number.isFinite(a.account.quota?.unified7dReset) ? a.account.quota.unified7dReset : 0;
      const resetB = Number.isFinite(b.account.quota?.unified7dReset) ? b.account.quota.unified7dReset : 0;
      if (resetA !== resetB) return resetB - resetA;
      return a.index - b.index;
    })
    .map(({ account }) => account);
}

async function readErrorMessage(response) {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      const message = parsed?.error?.message ?? parsed?.detail ?? parsed?.message;
      return typeof message === 'string' ? message.slice(0, 200) : text.slice(0, 200);
    } catch {
      return text.slice(0, 200);
    }
  } catch {
    return null;
  }
}

/**
 * One redemption attempt. Never throws: every failure shape becomes an
 * outcome the caller can apply/log. `ok` is true only for code "reset".
 */
export async function consumeCodexResetCredit({
  account,
  upstream,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_CODEX_RESET_CREDITS_TIMEOUT_MS,
  redeemRequestId = randomUUID(),
  creditId = null,
  signal = null,
} = {}) {
  const base = { ok: false, code: 'error', windowsReset: null, status: null, redeemRequestId, error: null };
  if (!account?.credential) return { ...base, error: 'missing credential' };
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${account.credential}`,
  };
  if (account.accountId) headers['chatgpt-account-id'] = account.accountId;
  const body = JSON.stringify(creditId
    ? { redeem_request_id: redeemRequestId, credit_id: creditId }
    : { redeem_request_id: redeemRequestId });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    const response = await fetchImpl(codexResetCreditsEndpoint(upstream, { consume: true }), {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    const status = response.status;
    if (!response.ok) {
      const error = await readErrorMessage(response);
      return { ...base, code: `http_${status}`, status, error };
    }
    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      return { ...base, code: 'invalid_response', status, error: `unparseable body: ${err.message}` };
    }
    const code = typeof payload?.code === 'string' ? payload.code : 'unknown';
    const windowsReset = Number.isInteger(payload?.windows_reset) ? payload.windows_reset : null;
    return {
      ...base,
      ok: code === 'reset',
      code: CODEX_RESET_CREDIT_CODES.has(code) ? code : 'unknown',
      windowsReset,
      status,
      error: CODEX_RESET_CREDIT_CODES.has(code) ? null : `unexpected code ${JSON.stringify(payload?.code ?? null)}`,
    };
  } catch (err) {
    const aborted = controller.signal.aborted;
    return { ...base, code: aborted ? 'timeout' : 'error', error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onOuterAbort);
  }
}

/**
 * Fold a redemption outcome into the live account. Returns true when the
 * upstream windows were reset and the account is routable again. Every
 * attempt (success or not) stamps codexResetCreditLastAt so the cooldown
 * bounds retries; only "reset" touches utilization/throttle.
 */
export function applyCodexResetCreditOutcome(account, outcome, now = Date.now()) {
  if (!account?.quota || !outcome) return false;
  const quota = account.quota;
  quota.codexResetCreditLastAt = now;
  quota.codexResetCreditLastOutcome = outcome.code ?? 'error';
  if (outcome.code === 'no_credit') {
    quota.codexResetCredits = 0;
    return false;
  }
  if (outcome.code !== 'reset') return false;
  quota.unified5h = 0;
  quota.unified7d = 0;
  quota.unifiedStatus = null;
  if (Number.isInteger(quota.codexResetCredits)) {
    quota.codexResetCredits = Math.max(0, quota.codexResetCredits - 1);
  }
  quota.codexResetCreditsConsumed = (Number.isInteger(quota.codexResetCreditsConsumed)
    ? quota.codexResetCreditsConsumed : 0) + 1;
  if (account.status === 'throttled') {
    account.status = 'active';
    account.rateLimitedUntil = null;
  }
  return true;
}
