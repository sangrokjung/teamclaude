import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import {
  CODEX_RESET_CREDIT_GRACE_MS,
  applyCodexResetCreditOutcome,
  codexResetCreditEligibility,
  codexResetCreditOutcomeKind,
  describeCodexResetCreditCandidates,
  rankCodexResetCreditCandidates,
  withinCodexResetCreditGrace,
} from '../src/codex-reset-credits.js';

// Review round 2 (2026-09-05): outcome classification, windows_reset 0,
// post-reset grace on the authoritative meter, model-quarantine exclusion.

const HOUR = 60 * 60 * 1000;

function codexAccount(overrides = {}) {
  return {
    name: 'codex-0',
    provider: 'codex',
    type: 'oauth',
    credential: 'tok-0',
    accountId: 'ws-0',
    enabled: true,
    status: 'active',
    rateLimitedUntil: null,
    quota: {
      unified5h: 0.1,
      unified7d: 1,
      unified5hReset: Date.now() + HOUR,
      unified7dReset: Date.now() + 60 * HOUR,
      unifiedStatus: null,
      codexResetCredits: 3,
      codexResetCreditLastAt: null,
      codexResetCreditLastOutcome: null,
      codexResetCreditsConsumed: 0,
      codexResetCreditResetAt: null,
    },
    ...overrides,
  };
}

test('outcome kinds: reset / spent-no-reset / indeterminate / no-spend', () => {
  assert.equal(codexResetCreditOutcomeKind({ code: 'reset', windowsReset: 2 }), 'reset');
  assert.equal(codexResetCreditOutcomeKind({ code: 'reset', windowsReset: null }), 'reset', 'older backends may omit windows_reset');
  assert.equal(codexResetCreditOutcomeKind({ code: 'reset', windowsReset: 0 }), 'spent-no-reset');
  for (const code of ['nothing_to_reset', 'no_credit', 'already_redeemed', 'http_400', 'http_401', 'http_404', 'token_refresh_failed']) {
    assert.equal(codexResetCreditOutcomeKind({ code }), 'no-spend', code);
  }
  for (const code of ['timeout', 'error', 'invalid_response', 'unknown', 'http_500', 'http_502', 'http_503', undefined]) {
    assert.equal(codexResetCreditOutcomeKind({ code }), 'indeterminate', String(code));
  }
  assert.equal(codexResetCreditOutcomeKind(null), 'indeterminate');
});

test('reset with windows_reset 0 spends the credit but leaves meters and throttle alone', () => {
  const now = Date.now();
  const acct = codexAccount({ status: 'throttled', rateLimitedUntil: now + 60_000 });
  assert.equal(applyCodexResetCreditOutcome(acct, { code: 'reset', windowsReset: 0 }, now), false);
  assert.equal(acct.quota.codexResetCredits, 2, 'the credit is gone');
  assert.equal(acct.quota.codexResetCreditsConsumed, 1);
  assert.equal(acct.quota.codexResetCreditLastOutcome, 'reset_no_windows');
  assert.equal(acct.quota.codexResetCreditLastAt, now, 'cooldown stamped');
  assert.equal(acct.quota.unified7d, 1, 'meter untouched');
  assert.equal(acct.status, 'throttled', 'throttle untouched');
  assert.equal(acct.quota.codexResetCreditResetAt, null, 'no effective reset recorded');

  const full = codexAccount();
  assert.equal(applyCodexResetCreditOutcome(full, { code: 'reset', windowsReset: null }, now), true);
  assert.equal(full.quota.codexResetCreditResetAt, now);
  assert.equal(full.quota.unified7d, 0);
});

test('post-reset grace window helper', () => {
  const now = 1_000_000_000;
  assert.equal(withinCodexResetCreditGrace({ codexResetCreditResetAt: now - 1000 }, now), true);
  assert.equal(withinCodexResetCreditGrace({ codexResetCreditResetAt: now - CODEX_RESET_CREDIT_GRACE_MS }, now), false);
  assert.equal(withinCodexResetCreditGrace({ codexResetCreditResetAt: now + 1000 }, now), false, 'a future stamp is not a grace');
  assert.equal(withinCodexResetCreditGrace({ codexResetCreditResetAt: null }, now), false);
  assert.equal(withinCodexResetCreditGrace({}, now), false);
});

test('AccountManager.updateCodexUsage: inside the grace an authoritative payload may not RAISE the meter', () => {
  const am = new AccountManager([{
    name: 'codex-0', provider: 'codex', type: 'oauth', accessToken: 'tok-0', refreshToken: 'r-0',
    accountId: 'ws-0', expiresAt: Date.now() + HOUR,
  }]);
  const a = am.accounts[0];
  const payload = used => ({
    rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 3600 } },
    rate_limit_reset_credits: { available_count: 2 },
  });
  am.updateCodexUsage(a, payload(100));
  assert.equal(a.quota.unified7d, 1);
  assert.equal(applyCodexResetCreditOutcome(a, { code: 'reset', windowsReset: 2 }), true);
  assert.equal(a.quota.unified7d, 0);
  // Lagging backend still says 100% → skipped during the grace, count still folded.
  a.quota.codexResetCredits = 3;
  assert.equal(am.updateCodexUsage(a, payload(100)), true, 'held by the grace, but still a recognized (successful) poll');
  assert.equal(a.quota.unified7d, 0, 'meter not raised inside the grace');
  assert.equal(a.quota.codexResetCredits, 2, 'the credit count is still authoritative');
  assert.ok(a.quota.codexUsageAt > 0, 'freshness stamp still advances');
  // A lower/equal reading applies.
  assert.equal(am.updateCodexUsage(a, payload(0)), true);
  assert.equal(a.quota.unified7d, 0);
  // Once the grace has passed, the authoritative meter wins again.
  a.quota.codexResetCreditResetAt = Date.now() - CODEX_RESET_CREDIT_GRACE_MS - 1;
  assert.equal(am.updateCodexUsage(a, payload(100)), true);
  assert.equal(a.quota.unified7d, 1);
});

test('eligibility: canServe excludes accounts that cannot serve the request (model quarantine)', () => {
  const opts = { now: Date.now(), cooldownMs: 0, isExhausted: () => true };
  assert.equal(codexResetCreditEligibility(codexAccount(), { ...opts, canServe: () => false }).reason, 'cannot-serve');
  assert.equal(codexResetCreditEligibility(codexAccount(), { ...opts, canServe: () => true }).reason, 'ok');
  const a = codexAccount({ name: 'a' });
  const b = codexAccount({ name: 'b' });
  const ranked = rankCodexResetCreditCandidates([a, b], { ...opts, canServe: acct => acct.name === 'b' });
  assert.deepEqual(ranked.map(x => x.name), ['b']);
  assert.deepEqual(describeCodexResetCreditCandidates([a, b, { name: 'claude', provider: 'anthropic' }], { ...opts, canServe: acct => acct.name === 'b' }),
    ['a:cannot-serve', 'b:ok']);
});

test('eligibility: an in-flight redemption on the account is joinable even inside the cooldown', () => {
  const opts = { now: Date.now(), cooldownMs: 30 * 60 * 1000, isExhausted: () => true };
  const busy = codexAccount();
  busy.quota.codexResetCreditLastAt = Date.now(); // the durable "pending" stamp
  busy.quota.codexResetCreditLastOutcome = 'pending';
  assert.equal(codexResetCreditEligibility(busy, opts).reason, 'cooldown', 'no promise → the stamp is a real cooldown');
  busy._resetCreditPromise = Promise.resolve({ reset: true, kind: 'reset' });
  assert.deepEqual(codexResetCreditEligibility(busy, opts), { eligible: true, reason: 'in-flight' });
  assert.deepEqual(rankCodexResetCreditCandidates([busy], opts).map(a => a.name), ['codex-0']);
});
