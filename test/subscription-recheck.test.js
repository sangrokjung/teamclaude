import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recheckAnthropicAccount, recheckedAccount, isConclusiveRecheck, settleRecheck, describeRecheck, RECHECK_EXIT, BILLING_URL,
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

test('an importFrom account without an inline token is inconclusive, not a token rejection', async () => {
  const { impl, calls } = fakeFetch({ messages: { status: 200 } });
  const r = await recheckAnthropicAccount({ account: { name: 'x', importFrom: '/elsewhere.json' }, fetchImpl: impl, now: NOW });
  assert.equal(r.outcome, 'unknown');
  assert.equal(calls.length, 0);
  const bare = await recheckAnthropicAccount({ account: { name: 'y' }, fetchImpl: impl, now: NOW });
  assert.equal(bare.outcome, 'auth-invalid');
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

function settleDeps(diskAccounts, { reload = { confirmed: true, failed: false }, serverPid = null, alive = false } = {}) {
  const disk = { accounts: diskAccounts.map(a => ({ ...a })) };
  const calls = { reload: 0 };
  return {
    disk,
    calls,
    deps: {
      atomicUpdate: async updater => { updater(disk); return disk; },
      noteReload: async () => { calls.reload += 1; return reload; },
      readServerState: async () => (serverPid ? { pid: serverPid } : null),
      isPidAlive: () => alive,
    },
  };
}

const parkedTarget = { name: 'a', accountUuid: 'u1', accessToken: 'tok', subscriptionDisabled: true };

test('settle: ok lifts the park and confirms the live reload', async () => {
  const { disk, calls, deps } = settleDeps([parkedTarget]);
  const r = await settleRecheck({ target: parkedTarget, probe: { outcome: 'ok' }, ...deps });
  assert.deepEqual([r.outcome.outcome, r.changed, r.applied], ['ok', true, true]);
  assert.equal('subscriptionDisabled' in disk.accounts[0], false);
  assert.equal(calls.reload, 1);
});

test('settle: a retry still asks the server to reload when disk already matched', async () => {
  const lifted = { ...parkedTarget };
  delete lifted.subscriptionDisabled;
  const { calls, deps } = settleDeps([lifted]);
  const r = await settleRecheck({ target: lifted, probe: { outcome: 'ok' }, ...deps });
  assert.deepEqual([r.outcome.outcome, r.changed, r.applied], ['ok', false, true]);
  assert.equal(calls.reload, 1);
});

test('settle: an unconfirmed live reload is not-applied', async () => {
  const { deps } = settleDeps([parkedTarget], { reload: { confirmed: false, failed: true } });
  const r = await settleRecheck({ target: parkedTarget, probe: { outcome: 'ok' }, ...deps });
  assert.equal(r.outcome.outcome, 'not-applied');
  assert.equal(r.outcome.verdict, 'ok');
  assert.equal(r.applied, false);
});

test('settle: an unreachable but live server pid is unverified, a dead or absent one is fine', async () => {
  const live = settleDeps([parkedTarget], { reload: { confirmed: false, failed: false }, serverPid: 42, alive: true });
  assert.equal((await settleRecheck({ target: parkedTarget, probe: { outcome: 'ok' }, ...live.deps })).outcome.outcome, 'not-applied');
  const dead = settleDeps([parkedTarget], { reload: { confirmed: false, failed: false }, serverPid: 42, alive: false });
  assert.equal((await settleRecheck({ target: parkedTarget, probe: { outcome: 'ok' }, ...dead.deps })).outcome.outcome, 'ok');
  const none = settleDeps([parkedTarget], { reload: { confirmed: false, failed: false } });
  assert.equal((await settleRecheck({ target: parkedTarget, probe: { outcome: 'ok' }, ...none.deps })).applied, true);
});

test('settle: a re-auth during the probe makes the verdict stale and saves nothing', async () => {
  const reauthed = { name: 'a', accountUuid: 'u1', accessToken: 'new-token' };
  const { disk, calls, deps } = settleDeps([reauthed]);
  const r = await settleRecheck({ target: parkedTarget, probe: { outcome: 'org-blocked' }, ...deps });
  assert.equal(r.outcome.outcome, 'unknown');
  assert.equal(r.outcome.errorCode, 'account-changed');
  assert.equal('subscriptionDisabled' in disk.accounts[0], false, 'fresh account is not re-parked');
  assert.equal(calls.reload, 0);
});

test('settle: a removal during the probe is not reported as success', async () => {
  const { calls, deps } = settleDeps([]);
  const r = await settleRecheck({ target: parkedTarget, probe: { outcome: 'ok' }, ...deps });
  assert.equal(r.outcome.outcome, 'unknown');
  assert.equal(calls.reload, 0);
});

test('settle: inconclusive outcomes touch neither disk nor server', async () => {
  const { disk, calls, deps } = settleDeps([parkedTarget]);
  const r = await settleRecheck({ target: parkedTarget, probe: { outcome: 'unknown' }, ...deps });
  assert.equal(r.outcome.outcome, 'unknown');
  assert.equal(disk.accounts[0].subscriptionDisabled, true);
  assert.equal(calls.reload, 0);
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
