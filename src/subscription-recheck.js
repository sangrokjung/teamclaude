// `teamclaude recheck <name>`: re-verify one parked Anthropic OAuth account on
// demand. Pure helpers (fetch is injected) so the CLI, the menubar and tests
// share one classification.
//
// Why: a `subscriptionDisabled` park is only lifted by evidence. The Anthropic
// 403 `oauth_not_allowed_for_organization` covers two very different causes:
// an organization that blocks Claude Code, and a subscription whose payment
// failed (`organization.subscription_status: past_due`). The second is fixed
// by paying, not by re-login, so the outcome names it explicitly.

import { normalizeExpiresAt } from './oauth.js';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const DEFAULT_BETA = 'oauth-2025-04-20';
const DEFAULT_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_SYSTEM = [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }];
const PAYMENT_STATES = new Set(['past_due', 'unpaid', 'incomplete', 'incomplete_expired']);
const TOKEN_MIN_REMAINING_MS = 60_000;
// The only 403 that proves an organization-level OAuth denial (same contract
// as the request path's subscription-access check).
const ORG_DENIED_CODE = 'oauth_not_allowed_for_organization';

export const RECHECK_EXIT = Object.freeze({
  ok: 0,
  'payment-past-due': 2,
  'org-blocked': 3,
  'auth-invalid': 4,
  'token-expired': 5,
  unknown: 6,
  // The verdict was conclusive and saved, but the running server did not
  // confirm the reload, so it may still route on its previous state.
  'not-applied': 7,
  // Organization OAuth denied, but the profile (payment status) was unreadable:
  // the account stays parked and the cause is unknown until a later recheck.
  'access-denied': 8,
});

const PARKING_OUTCOMES = new Set(['payment-past-due', 'org-blocked', 'access-denied']);

export const BILLING_URL = 'https://claude.ai/settings/billing';

function probeRequest(account, template) {
  const t = template && typeof template === 'object' ? template : {};
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${account.accessToken}`,
    'anthropic-version': typeof t.version === 'string' && t.version ? t.version : DEFAULT_VERSION,
    'anthropic-beta': typeof t.beta === 'string' && t.beta ? t.beta : DEFAULT_BETA,
  };
  const body = {
    model: typeof t.model === 'string' && t.model ? t.model.replace(/\[[^\]]*\]$/, '') : DEFAULT_MODEL,
    max_tokens: 1,
    system: t.system ?? DEFAULT_SYSTEM,
    messages: [{ role: 'user', content: 'hi' }],
  };
  return { headers, body: JSON.stringify(body) };
}

// The organization's subscription status, or null when it could not be read
// (HTTP error, network, malformed body, or no status field). null must never
// be read as "not a payment problem": the cause is then simply unknown.
async function readSubscriptionStatus(fetchImpl, accessToken) {
  try {
    const res = await fetchImpl(PROFILE_URL, {
      headers: { authorization: `Bearer ${accessToken}`, 'anthropic-beta': DEFAULT_BETA },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const value = data?.organization?.subscription_status;
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

function deniedOutcome(subscriptionStatus) {
  if (subscriptionStatus == null) return 'access-denied';
  return PAYMENT_STATES.has(subscriptionStatus) ? 'payment-past-due' : 'org-blocked';
}

/**
 * Classify one Anthropic OAuth account. Never refreshes tokens (the running
 * server owns the refresh-token chain; a second refresher would race it).
 * Returns { outcome, httpStatus, subscriptionStatus, errorCode }.
 */
export async function recheckAnthropicAccount({ account, template = null, fetchImpl = fetch, now = Date.now() }) {
  // An `importFrom` account's live credential lives in another file that the
  // server resolves (an inline token may be stale). Recheck does not follow
  // it, so it reports inconclusive instead of probing the wrong token.
  if (account?.importFrom) {
    return { outcome: 'unknown', httpStatus: null, subscriptionStatus: null, errorCode: 'import-from-account' };
  }
  if (!account?.accessToken) {
    return { outcome: 'auth-invalid', httpStatus: null, subscriptionStatus: null, errorCode: 'no-token' };
  }
  if (account.expiresAt != null
      && normalizeExpiresAt(account.expiresAt) < now + TOKEN_MIN_REMAINING_MS) {
    return { outcome: 'token-expired', httpStatus: null, subscriptionStatus: null, errorCode: null };
  }
  const { headers, body } = probeRequest(account, template);
  let res;
  try {
    res = await fetchImpl(MESSAGES_URL, { method: 'POST', headers, body });
  } catch (err) {
    return { outcome: 'unknown', httpStatus: null, subscriptionStatus: null, errorCode: err?.code || 'network' };
  }
  let errorCode = null;
  let text = '';
  try { text = await res.text(); } catch { /* body is optional */ }
  if (!res.ok) {
    try {
      const parsed = JSON.parse(text);
      errorCode = parsed?.error?.details?.error_code || parsed?.error?.type || null;
    } catch { /* non-JSON error body */ }
  }
  if (res.ok) return { outcome: 'ok', httpStatus: res.status, subscriptionStatus: null, errorCode: null };
  if (res.status === 401) {
    return { outcome: 'auth-invalid', httpStatus: 401, subscriptionStatus: null, errorCode };
  }
  if (res.status === 403 && errorCode === ORG_DENIED_CODE) {
    const subscriptionStatus = await readSubscriptionStatus(fetchImpl, account.accessToken);
    return { outcome: deniedOutcome(subscriptionStatus), httpStatus: 403, subscriptionStatus, errorCode };
  }
  // A 429 is evidence of access only when it is this account's own quota
  // verdict (unified status rejected): the organization accepted the OAuth
  // token and metered it. A request-rate or global 429 proves nothing.
  if (res.status === 429 && res.headers?.get?.('anthropic-ratelimit-unified-status') === 'rejected') {
    return { outcome: 'ok', httpStatus: 429, subscriptionStatus: null, errorCode };
  }
  return { outcome: 'unknown', httpStatus: res.status, subscriptionStatus: null, errorCode };
}

/** Outcomes conclusive enough to change the stored park. */
export function isConclusiveRecheck(outcome) {
  return outcome.outcome === 'ok' || PARKING_OUTCOMES.has(outcome.outcome);
}

function findTargetAccount(accounts, target) {
  return accounts.findIndex(a => (target.accountUuid
    ? a.accountUuid === target.accountUuid
    : a.name === target.name));
}

// The probed state is still current: same identity, same token, and the same
// park flag. A re-auth, removal, or a concurrent recheck / `subscription`
// edit that flipped the park while this probe was in flight makes it stale.
function isProbedState(current, target) {
  return Boolean(current)
    && current.accessToken === target.accessToken
    && (current.subscriptionDisabled === true) === (target.subscriptionDisabled === true);
}

function staleOutcome(probe) {
  return { ...probe, outcome: 'unknown', verdict: probe.outcome, errorCode: 'account-changed' };
}

/**
 * The account config after an outcome, as a new object (the input is untouched).
 * Returns { account, changed }.
 */
export function recheckedAccount(acct, outcome) {
  const before = acct.subscriptionDisabled === true;
  let next = acct;
  if (outcome.outcome === 'ok') {
    next = { ...acct };
    delete next.subscriptionDisabled;
  } else if (PARKING_OUTCOMES.has(outcome.outcome)) {
    next = { ...acct, subscriptionDisabled: true };
  }
  return { account: next, changed: before !== (next.subscriptionDisabled === true) };
}

/**
 * Persist a conclusive verdict and confirm the running server converged.
 * Dependencies are injected (config writer, reload notifier, server state) so
 * the whole path is testable without a server or network.
 *
 * - The verdict is saved only onto the exact account state that was probed
 *   (see isProbedState): a stale verdict must not re-park a fresh account or
 *   undo a concurrent lift.
 * - An auth-invalid verdict (which makes the menubar open re-auth) is also
 *   dropped when the token was replaced meanwhile.
 * - The reload is requested even when disk already matched (an earlier
 *   recheck may have saved without the reload landing).
 * - "No server" counts as applied only when no live supervisor pid is
 *   recorded; a live pid the status probe could not reach is unverified.
 *
 * Returns { outcome, changed, applied }.
 */
export async function settleRecheck({ target, probe, atomicUpdate, readConfig, noteReload, readServerState, isPidAlive }) {
  if (probe.outcome === 'auth-invalid') {
    const current = await readConfig().catch(() => null);
    const accounts = current?.accounts || [];
    const fresh = isProbedState(accounts[findTargetAccount(accounts, target)], target);
    return { outcome: fresh ? probe : staleOutcome(probe), changed: false, applied: null };
  }
  if (!isConclusiveRecheck(probe)) return { outcome: probe, changed: false, applied: null };
  let changed = false;
  let saved = false;
  const config = await atomicUpdate(cfg => {
    const accounts = cfg.accounts || [];
    const idx = findTargetAccount(accounts, target);
    if (idx < 0 || !isProbedState(accounts[idx], target)) return;
    const result = recheckedAccount(accounts[idx], probe);
    changed = result.changed;
    saved = true;
    accounts[idx] = result.account;
  });
  if (!saved) return { outcome: staleOutcome(probe), changed: false, applied: null };
  const { confirmed, failed } = await noteReload(config);
  let applied = confirmed;
  if (!confirmed && !failed) {
    const state = await readServerState().catch(() => null);
    applied = !(state?.pid && isPidAlive(state.pid));
  }
  const outcome = applied ? probe : { ...probe, outcome: 'not-applied', verdict: probe.outcome };
  return { outcome, changed, applied };
}

export function describeRecheck(name, outcome) {
  switch (outcome.outcome) {
    case 'ok': return `"${name}" can use Claude Code again and is back in rotation.`;
    case 'payment-past-due':
      return `"${name}" subscription payment is ${outcome.subscriptionStatus}. Pay at ${BILLING_URL}, then recheck. Re-login will not fix this.`;
    case 'org-blocked': return `"${name}" organization does not allow Claude Code (OAuth). Re-login will not fix this.`;
    case 'access-denied':
      return `"${name}" organization access is denied, but the payment status could not be read. Kept out of rotation; recheck shortly.`;
    case 'auth-invalid': return `"${name}" token was rejected. Re-authenticate with: teamclaude reauth "${name}"`;
    case 'token-expired': return `"${name}" access token is expiring; the running server refreshes it within minutes. Recheck shortly.`;
    case 'not-applied':
      return `"${name}" was saved, but the running server did not confirm the reload, so it may still route on the old state. Recheck again.`;
    default: return `"${name}" recheck was inconclusive (HTTP ${outcome.httpStatus ?? 'n/a'}${outcome.errorCode ? `, ${outcome.errorCode}` : ''}).`;
  }
}
