// API 키 계정의 크레딧 상태(B1)·추정 지출 원장(B4·B6)·영속 소진 플래그·상태
// 응답 credit 블록(B9)을 고정한다. 키 값은 픽스처에서도 실제 형식을 쓰지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { classifyCreditRefusal, normalizeCreditExhausted } from '../src/api-credit.js';

const HOUR = 3600_000;
const SINCE = Date.UTC(2026, 9, 1);
const EXPIRES = Date.UTC(2026, 11, 31);

const apiKey = (name = 'api-1', extra = {}) => ({
  name, type: 'apikey', apiKey: `test-key-${name}`, ...extra,
});
const oauth = (name = 'sub-1', extra = {}) => ({
  name, type: 'oauth', accessToken: `tok-${name}`, refreshToken: `r-${name}`, expiresAt: Date.now() + HOUR, ...extra,
});

function makeManager(accounts) {
  return new AccountManager(accounts, 0.98, 0, 3);
}

test('생성자는 API 키 계정의 크레딧 필드를 정규화해 읽는다', () => {
  const am = makeManager([
    apiKey('api-1', { creditUsd: 50, creditSince: SINCE, creditExpiresAt: EXPIRES }),
    apiKey('api-2', { creditUsd: -3, creditSince: 'x', creditExpiresAt: null }),
    oauth('sub-1', { creditUsd: 50 }),
  ]);
  const [a, b, sub] = am.accounts;
  assert.equal(a.creditUsd, 50);
  assert.equal(a.creditSince, SINCE);
  assert.equal(a.creditExpiresAt, EXPIRES);
  assert.equal(a.quota.apiSpendUsd, 0);
  assert.equal(a.quota.apiSpendSince, SINCE);
  assert.equal(b.creditUsd, null);
  assert.equal(b.creditSince, null);
  assert.equal(b.creditExpiresAt, null);
  assert.equal(sub.creditUsd, undefined, '구독 계정에는 크레딧 필드가 없다');
});

test('설정의 creditExhausted는 계정을 소진 오류로 띄운다(재시작 뒤에도 빠져 있다)', () => {
  const am = makeManager([apiKey('api-1', { creditExhausted: { reason: 'credit-exhausted', at: SINCE } })]);
  const a = am.accounts[0];
  assert.deepEqual(a.creditExhausted, { reason: 'credit-exhausted', at: SINCE });
  assert.equal(a.status, 'error');
  assert.equal(a.errorReason, 'credit-exhausted');
  assert.equal(am._isAvailable(a), false);
  assert.equal(am.getStatus().accounts[0].usable, false);
});

test('addAccount도 크레딧 필드와 소진 플래그를 읽는다', () => {
  const am = makeManager([oauth()]);
  const idx = am.addAccount(apiKey('api-9', { creditUsd: 20, creditExhausted: { reason: 'billing', at: 1 } }));
  const a = am.accounts[idx];
  assert.equal(a.creditUsd, 20);
  assert.equal(a.errorReason, 'credit-exhausted');
  assert.equal(a.creditExhausted.reason, 'billing');
});

test('normalizeCreditExhausted: 모양이 틀린 값은 무시하거나 기본 사유로 바꾼다', () => {
  assert.equal(normalizeCreditExhausted(null), null);
  assert.equal(normalizeCreditExhausted('yes'), null);
  assert.deepEqual(normalizeCreditExhausted(true), { reason: 'credit-exhausted', at: null });
  assert.deepEqual(normalizeCreditExhausted({ reason: 'weird', at: 'x' }), { reason: 'credit-exhausted', at: null });
  assert.deepEqual(normalizeCreditExhausted({ reason: 'spend-limit', at: 5 }), { reason: 'spend-limit', at: 5 });
});

test('recordApiSpend: API 키 계정에만 쌓고, 모르는 모델은 토큰으로 센다', () => {
  const am = makeManager([apiKey('api-1', { creditUsd: 50 }), oauth('sub-1')]);
  const [api, sub] = am.accounts;
  am.recordApiSpend(api, { input_tokens: 1000, output_tokens: 500 }, 'claude-sonnet-4-5-20250929');
  // 1,000 × $3 + 500 × $15 = $0.0105
  assert.ok(Math.abs(api.quota.apiSpendUsd - 0.0105) < 1e-12);
  am.recordApiSpend(api, { input_tokens: 100, output_tokens: 20 }, 'claude-fable-5');
  assert.equal(api.quota.apiUnpricedTokens, 120);
  am.recordApiSpend(sub, { input_tokens: 1000, output_tokens: 500 }, 'claude-sonnet-4-5');
  assert.equal(sub.quota.apiSpendUsd, 0);
  assert.equal(sub.quota.apiUnpricedTokens, 0);
});

test('recordApiSpend는 config.apiPricing 덮어쓰기를 쓴다', () => {
  const am = makeManager([apiKey('api-1')]);
  am.setApiPricing({ 'claude-fable-5': { input: 10, output: 50 } });
  am.recordApiSpend(am.accounts[0], { input_tokens: 1_000_000 }, 'claude-fable-5[1m]');
  assert.equal(am.accounts[0].quota.apiSpendUsd, 10);
  assert.equal(am.accounts[0].quota.apiUnpricedTokens, 0);
});

test('Codex 모드 API 키 계정은 원장에 쌓지 않는다', () => {
  const am = makeManager([{ ...apiKey('cx-1'), provider: 'codex' }]);
  am.recordApiSpend(am.accounts[0], { input_tokens: 1000 }, 'claude-sonnet-4-5');
  assert.equal(am.accounts[0].quota.apiSpendUsd, 0);
  assert.equal(am.accounts[0].creditUsd, undefined);
});

test('setCreditExhausted는 영속 훅을 부르고 clearCreditExhausted가 되돌린다', async () => {
  const am = makeManager([apiKey('api-1'), oauth('sub-1')]);
  const calls = [];
  am.onAccountCreditFlag((account, value) => { calls.push([account.name, value]); });
  const a = am.accounts[0];
  am.setCreditExhausted(a, 'spend-limit');
  await am.waitForAccountFlag(a);
  assert.equal(a.status, 'error');
  assert.equal(a.errorReason, 'credit-exhausted');
  assert.equal(a.creditExhausted.reason, 'spend-limit');
  assert.ok(Number.isFinite(a.creditExhausted.at));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'api-1');
  assert.equal(calls[0][1].reason, 'spend-limit');

  // 같은 값으로 다시 세우면 다시 쓰지 않는다.
  am.setCreditExhausted(a, 'spend-limit');
  await am.waitForAccountFlag(a);
  assert.equal(calls.length, 1);

  am.clearCreditExhausted(a);
  await am.waitForAccountFlag(a);
  assert.equal(a.status, 'active');
  assert.equal(a.errorReason, undefined);
  assert.equal(a.creditExhausted, undefined);
  assert.deepEqual(calls[1], ['api-1', null]);

  // 구독 계정에는 적용되지 않는다.
  assert.equal(am.setCreditExhausted(am.accounts[1], 'billing'), null);
  assert.equal(am.accounts[1].status, 'active');
});

test('소진 키는 enable·_recoverSoonest·스냅샷 스로틀 복원으로 되살아나지 않는다', () => {
  const am = makeManager([apiKey('api-1')]);
  const a = am.accounts[0];
  am.setCreditExhausted(a, 'credit-exhausted', { persist: false });
  am.setEnabled(a, true);
  assert.equal(a.status, 'error');
  a.rateLimitedUntil = Date.now() - 1000;
  assert.equal(am._recoverSoonest(), null);
  assert.equal(a.status, 'error');

  const saved = [{ accountUuid: null, name: 'api-1', quota: {}, rateLimitedUntil: Date.now() + HOUR, usage: {} }];
  am.importQuotaState(saved);
  assert.equal(a.status, 'error', '스로틀 복원이 소진 오류를 덮으면 안 된다');
  assert.equal(am._isAvailable(a), false);
});

test('원장은 스냅샷에 저장되고 creditSince가 같을 때만 복원된다', () => {
  const am = makeManager([apiKey('api-1', { creditUsd: 50, creditSince: SINCE })]);
  am.recordApiSpend(am.accounts[0], { input_tokens: 1_000_000 }, 'claude-haiku-4-5');
  am.recordApiSpend(am.accounts[0], { input_tokens: 7 }, 'claude-fable-5');
  const saved = JSON.parse(JSON.stringify(am.exportQuotaState()));
  assert.equal(saved[0].quota.apiSpendUsd, 1);

  const same = makeManager([apiKey('api-1', { creditUsd: 50, creditSince: SINCE })]);
  same.importQuotaState(saved);
  assert.equal(same.accounts[0].quota.apiSpendUsd, 1);
  assert.equal(same.accounts[0].quota.apiUnpricedTokens, 7);

  const reset = makeManager([apiKey('api-1', { creditUsd: 80, creditSince: SINCE + 1 })]);
  reset.importQuotaState(saved);
  assert.equal(reset.accounts[0].quota.apiSpendUsd, 0, '충전 금액을 다시 정하면 0부터 센다');
  assert.equal(reset.accounts[0].quota.apiUnpricedTokens, 0);
  assert.equal(reset.accounts[0].quota.apiSpendSince, SINCE + 1);

  const tampered = saved.map(s => ({ ...s, quota: { ...s.quota, apiSpendUsd: '9', apiUnpricedTokens: -4 } }));
  const clean = makeManager([apiKey('api-1', { creditUsd: 50, creditSince: SINCE })]);
  clean.importQuotaState(tampered);
  assert.equal(clean.accounts[0].quota.apiSpendUsd, 0);
  assert.equal(clean.accounts[0].quota.apiUnpricedTokens, 0);
});

test('applyCreditConfig: creditSince가 바뀌면 원장을 0으로, 같으면 유지한다', () => {
  const am = makeManager([apiKey('api-1', { creditUsd: 50, creditSince: SINCE })]);
  const a = am.accounts[0];
  am.recordApiSpend(a, { input_tokens: 1_000_000 }, 'claude-haiku-4-5');
  am.applyCreditConfig(a, { creditUsd: 50, creditSince: SINCE, creditExpiresAt: EXPIRES });
  assert.equal(a.quota.apiSpendUsd, 1);
  assert.equal(a.creditExpiresAt, EXPIRES);
  am.applyCreditConfig(a, { creditUsd: 60, creditSince: SINCE + 10 });
  assert.equal(a.creditUsd, 60);
  assert.equal(a.creditExpiresAt, null);
  assert.equal(a.quota.apiSpendUsd, 0);
  assert.equal(a.quota.apiSpendSince, SINCE + 10);
});

test('상태 응답 credit 블록: 키 값 없이 금액·만료·소진을 싣는다', () => {
  const am = makeManager([
    apiKey('api-1', { creditUsd: 50, creditSince: SINCE, creditExpiresAt: EXPIRES }),
    apiKey('api-2', { creditExhausted: { reason: 'usage-limit', at: SINCE } }),
    oauth('sub-1'),
  ]);
  am.recordApiSpend(am.accounts[0], { input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'claude-haiku-4-5');
  am.recordApiSpend(am.accounts[0], { input_tokens: 3 }, 'claude-fable-5');
  const status = am.getStatus({ includeIdentity: true });
  const [s1, s2, s3] = status.accounts;
  assert.deepEqual(s1.credit, {
    usd: 50, spentUsd: 6, remainingUsd: 44, since: SINCE, expiresAt: EXPIRES,
    exhausted: false, exhaustedReason: null, unpricedTokens: 3,
  });
  assert.deepEqual(s2.credit, {
    usd: null, spentUsd: 0, remainingUsd: null, since: null, expiresAt: null,
    exhausted: true, exhaustedReason: 'usage-limit', unpricedTokens: 0,
  });
  assert.equal(s2.errorReason, 'credit-exhausted');
  assert.equal('credit' in s3, false, '구독 계정에는 credit 블록이 없다');
  const json = JSON.stringify(status);
  assert.equal(json.includes('test-key-'), false, '상태 응답에 키 값이 나오면 안 된다');
});

test('classifyCreditRefusal: 크레딧 거절 4종만 사유를 돌려준다', () => {
  const body = obj => Buffer.from(JSON.stringify(obj));
  assert.equal(classifyCreditRefusal(400, body({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } })), 'credit-exhausted');
  assert.equal(classifyCreditRefusal(400, body({ type: 'error', error: { type: 'invalid_request_error', message: 'You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.' } })), 'usage-limit');
  assert.equal(classifyCreditRefusal(429, body({ type: 'error', error: { type: 'rate_limit_error', message: 'spend limit', details: { error_code: 'enforced_spend_limit_reached' } } })), 'spend-limit');
  assert.equal(classifyCreditRefusal(402, body({ type: 'error', error: { type: 'billing_error', message: 'Payment required' } })), 'billing');
  // 그 밖은 null: 일반 400, 일반 429, 다른 상태의 같은 문구, JSON 아님.
  assert.equal(classifyCreditRefusal(400, body({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: field required' } })), null);
  assert.equal(classifyCreditRefusal(429, body({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } })), null);
  assert.equal(classifyCreditRefusal(500, body({ type: 'error', error: { type: 'api_error', message: 'credit balance is too low' } })), null);
  assert.equal(classifyCreditRefusal(400, Buffer.from('not json')), null);
  assert.equal(classifyCreditRefusal(402, body({ type: 'error', error: { type: 'api_error', message: 'x' } })), null);
});
