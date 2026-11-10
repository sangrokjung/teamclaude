import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recheckAnthropicAccount, recheckedAccount, isConclusiveRecheck, describeRecheck, RECHECK_EXIT, BILLING_URL,
} from '../src/subscription-recheck.js';

const NOW = 1_800_000_000_000;
const account = { name: 'a@example.com', accessToken: 'tok', expiresAt: NOW + 3_600_000 };

function fakeFetch({ messages, profile }) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const spec = url.endsWith('/v1/messages') ? messages : profile;
    if (spec instanceof Error) throw spec;
    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      headers: new Headers(spec.headers ?? {}),
      text: async () => JSON.stringify(spec.body ?? {}),
      json: async () => spec.body ?? {},
    };
  };
  return { impl, calls };
}

const orgDenied = {
  status: 403,
  body: { type: 'error', error: { type: 'permission_error', details: { error_code: 'oauth_not_allowed_for_organization' } } },
};

test('2xx probe means access is back', async () => {
  const { impl, calls } = fakeFetch({ messages: { status: 200 } });
  const r = await recheckAnthropicAccount({ account, fetchImpl: impl, now: NOW });
  assert.equal(r.outcome, 'ok');
  assert.equal(calls.length, 1, 'no profile lookup needed on success');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.max_tokens, 1);
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
});

test('403 with a past_due subscription is a payment problem, not an org block', async () => {
  const { impl } = fakeFetch({ messages: orgDenied, profile: { status: 200, body: { organization: { subscription_status: 'past_due' } } } });
  const r = await recheckAnthropicAccount({ account, fetchImpl: impl, now: NOW });
  assert.equal(r.outcome, 'payment-past-due');
  assert.equal(r.subscriptionStatus, 'past_due');
  assert.equal(r.errorCode, 'oauth_not_allowed_for_organization');
  assert.match(describeRecheck('a', r), new RegExp(BILLING_URL.replace(/[/.]/g, '\\$&')));
});

test('403 with an active subscription is an organization block', async () => {
  const { impl } = fakeFetch({ messages: orgDenied, profile: { status: 200, body: { organization: { subscription_status: 'active' } } } });
  const r = await recheckAnthropicAccount({ account, fetchImpl: impl, now: NOW });
  assert.equal(r.outcome, 'org-blocked');
});

test('403 with an unreadable profile stays an organization block', async () => {
  const { impl } = fakeFetch({ messages: orgDenied, profile: { status: 500 } });
  const r = await recheckAnthropicAccount({ account, fetchImpl: impl, now: NOW });
  assert.equal(r.outcome, 'org-blocked');
  assert.equal(r.subscriptionStatus, null);
});

test('401 asks for re-authentication', async () => {
  const { impl } = fakeFetch({ messages: { status: 401 } });
  assert.equal((await recheckAnthropicAccount({ account, fetchImpl: impl, now: NOW })).outcome, 'auth-invalid');
});

test('only an account-quota 429 (unified status rejected) proves access', async () => {
  const quota = fakeFetch({ messages: { status: 429, headers: { 'anthropic-ratelimit-unified-status': 'rejected' } } });
  assert.equal((await recheckAnthropicAccount({ account, fetchImpl: quota.impl, now: NOW })).outcome, 'ok');
  const rate = fakeFetch({ messages: { status: 429, body: { error: { type: 'rate_limit_error' } } } });
  assert.equal((await recheckAnthropicAccount({ account, fetchImpl: rate.impl, now: NOW })).outcome, 'unknown');
});

test('a 403 without the organization-denial code is inconclusive', async () => {
  const { impl, calls } = fakeFetch({ messages: { status: 403, body: { error: { type: 'permission_error' } } } });
  const r = await recheckAnthropicAccount({ account, fetchImpl: impl, now: NOW });
  assert.equal(r.outcome, 'unknown');
  assert.equal(calls.length, 1, 'no profile lookup for an unrelated 403');
});

test('an expiring token is not probed and never refreshed here', async () => {
  const { impl, calls } = fakeFetch({ messages: { status: 200 } });
  const r = await recheckAnthropicAccount({ account: { ...account, expiresAt: NOW + 10_000 }, fetchImpl: impl, now: NOW });
  assert.equal(r.outcome, 'token-expired');
  assert.equal(calls.length, 0);
});

test('network failure and other statuses are inconclusive', async () => {
  const net = fakeFetch({ messages: new Error('boom') });
  assert.equal((await recheckAnthropicAccount({ account, fetchImpl: net.impl, now: NOW })).outcome, 'unknown');
  const other = fakeFetch({ messages: { status: 529 } });
  assert.equal((await recheckAnthropicAccount({ account, fetchImpl: other.impl, now: NOW })).outcome, 'unknown');
});

test('the probe replays the captured template and strips a bracket model suffix', async () => {
  const { impl, calls } = fakeFetch({ messages: { status: 200 } });
  await recheckAnthropicAccount({
    account, fetchImpl: impl, now: NOW,
    template: { model: 'claude-x[1m]', version: 'v9', beta: 'b1', system: [{ type: 'text', text: 's' }] },
  });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'claude-x');
  assert.deepEqual(body.system, [{ type: 'text', text: 's' }]);
  assert.equal(calls[0].init.headers['anthropic-version'], 'v9');
  assert.equal(calls[0].init.headers['anthropic-beta'], 'b1');
});

test('the stored park changes only on conclusive outcomes, without mutating input', () => {
  const parked = Object.freeze({ name: 'a', subscriptionDisabled: true });
  const lifted = recheckedAccount(parked, { outcome: 'ok' });
  assert.equal(lifted.changed, true);
  assert.equal('subscriptionDisabled' in lifted.account, false);
  assert.equal(lifted.account.name, 'a');
  assert.equal(parked.subscriptionDisabled, true);

  const active = Object.freeze({ name: 'b' });
  const pastDue = recheckedAccount(active, { outcome: 'payment-past-due' });
  assert.equal(pastDue.changed, true);
  assert.equal(pastDue.account.subscriptionDisabled, true);
  assert.equal(recheckedAccount(pastDue.account, { outcome: 'org-blocked' }).changed, false);

  for (const outcome of ['auth-invalid', 'token-expired', 'unknown']) {
    assert.equal(isConclusiveRecheck({ outcome }), false);
    const kept = recheckedAccount(parked, { outcome });
    assert.equal(kept.changed, false);
    assert.equal(kept.account, parked);
  }
  for (const outcome of ['ok', 'payment-past-due', 'org-blocked']) assert.equal(isConclusiveRecheck({ outcome }), true);
});

test('not-applied has its own message and exit code', () => {
  assert.equal(RECHECK_EXIT['not-applied'], 7);
  assert.match(describeRecheck('a', { outcome: 'not-applied' }), /did not confirm the reload/);
});

test('exit codes are distinct per outcome', () => {
  const codes = Object.values(RECHECK_EXIT);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(RECHECK_EXIT.ok, 0);
});
