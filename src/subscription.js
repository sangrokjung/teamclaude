const CANCELLATION_STATUSES = new Set(['scheduled', 'ended']);
const CANCELLATION_EVIDENCE = new Set(['auth-failure-after-cancellation']);

function isoOrNull(value) {
  if (value == null || value === '') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function localpart(value) {
  if (typeof value !== 'string') return null;
  return value.trim().toLowerCase().split('@')[0] || null;
}

function selectorMatches(account, selector) {
  const needle = String(selector || '').trim().toLowerCase();
  if (!needle) return false;
  const names = [account.name, account.email]
    .filter(value => typeof value === 'string')
    .map(value => value.trim().toLowerCase());
  return names.includes(needle) || names.some(value => localpart(value) === needle);
}

export function normalizeSubscriptionCancellation(value) {
  if (!value || typeof value !== 'object' || !CANCELLATION_STATUSES.has(value.status)) {
    return null;
  }
  const recordedAt = isoOrNull(value.recordedAt);
  if (!recordedAt) return null;
  const normalized = {
    status: value.status,
    recordedAt,
    endsAt: isoOrNull(value.endsAt),
  };
  if (value.status === 'ended') {
    const endedAt = isoOrNull(value.endedAt);
    if (!endedAt || !CANCELLATION_EVIDENCE.has(value.evidence)) return null;
    normalized.endedAt = endedAt;
    normalized.evidence = value.evidence;
  }
  return normalized;
}

export function cancellationEndsAt(value, offsetMinutes) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) throw new Error('--ends-on requires a valid YYYY-MM-DD date');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1
      || check.getUTCDate() !== day) {
    throw new Error('--ends-on requires a valid YYYY-MM-DD date');
  }
  if (offsetMinutes !== undefined) {
    const nextMidnightUtc = Date.UTC(year, month - 1, day + 1)
      - Number(offsetMinutes) * 60 * 1000;
    return new Date(nextMidnightUtc).toISOString();
  }
  return new Date(year, month - 1, day + 1).toISOString();
}

export function findSubscriptionTarget(config, {
  selector,
  expectedAccountUuid = null,
} = {}) {
  if (!selector) throw new Error('Subscription tracking requires an account selector');
  if (config?.provider && config.provider !== 'codex') {
    throw new Error('Subscription tracking applies to Codex accounts only');
  }
  const accounts = Array.isArray(config?.accounts) ? config.accounts : [];
  const matches = accounts.map((account, index) => ({ account, index }))
    .filter(({ account }) => selectorMatches(account, selector))
    .filter(({ account }) => !expectedAccountUuid || account.accountUuid === expectedAccountUuid);
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `Account "${selector}" was not found with the expected identity`
      : `Account "${selector}" is ambiguous`);
  }
  const target = matches[0];
  if (target.account.type !== 'oauth'
      || (target.account.provider || config.provider) !== 'codex') {
    throw new Error(`Account "${selector}" is not a Codex OAuth account`);
  }
  return target;
}

export function applySubscriptionCancellation(account, {
  endsAt = null,
  now = Date.now(),
} = {}) {
  const normalizedEnd = isoOrNull(endsAt);
  if (endsAt != null && !normalizedEnd) throw new Error('Invalid subscription end timestamp');
  account.subscriptionCancellation = {
    status: 'scheduled',
    recordedAt: new Date(now).toISOString(),
    endsAt: normalizedEnd,
  };
  return account.subscriptionCancellation;
}

export function clearSubscriptionCancellation(account) {
  delete account.subscriptionCancellation;
}

export function cancellationIsDue(account, now = Date.now()) {
  const cancellation = normalizeSubscriptionCancellation(account?.subscriptionCancellation);
  if (!cancellation || cancellation.status === 'ended') return cancellation?.status === 'ended';
  return cancellation.endsAt == null || Date.parse(cancellation.endsAt) <= now;
}

export function subscriptionSnapshot(account, now = Date.now()) {
  const cancellation = normalizeSubscriptionCancellation(account?.subscriptionCancellation);
  if (!cancellation) {
    return { state: 'active', endsAt: null, recordedAt: null, endedAt: null, evidence: null };
  }
  let state = 'cancellation-scheduled';
  if (cancellation.status === 'ended') state = 'ended';
  else if (cancellation.endsAt && Date.parse(cancellation.endsAt) <= now) state = 'end-date-reached';
  return {
    state,
    endsAt: cancellation.endsAt,
    recordedAt: cancellation.recordedAt,
    endedAt: cancellation.endedAt || null,
    evidence: cancellation.evidence || null,
  };
}
