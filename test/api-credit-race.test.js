// 검토 지적(REQUEST_CHANGES 1·4) 회귀: 발송 뒤 재충전·키 교체된 키를 늦은 거절이 다시
// 차단하지 않는다. 영속 쓰기 실패는 상태에 드러나고 다시 시도된다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { creditStampMatchesConfig } from '../src/api-credit.js';

const SINCE = Date.UTC(2026, 9, 1);
const apiKey = (name = 'api-1', extra = {}) => ({ name, type: 'apikey', apiKey: `test-key-${name}`, ...extra });

function makeManager(accounts = [apiKey('api-1', { creditUsd: 20, creditSince: SINCE })]) {
  return new AccountManager(accounts, 0.98, 0, 3);
}

test('발송 시점 도장(stamp)이 맞으면 차단하고, 재충전(api-credit) 뒤 도착한 거절은 무시한다', () => {
  const am = makeManager();
  const a = am.accounts[0];
  const stampB = am.creditDispatchStamp(a);
  const stampA = am.creditDispatchStamp(a);
  assert.ok(am.setCreditExhausted(a, 'credit-exhausted', { persist: false, stamp: stampA }));
  assert.equal(a.errorReason, 'credit-exhausted');

  // 운영자가 충전 후 api-credit: creditSince가 바뀌고 플래그가 지워진다(재적용 경로와 같은 순서).
  am.applyCreditConfig(a, { creditUsd: 50, creditSince: SINCE + 1000 });
  am.clearCreditExhausted(a, { persist: false });
  assert.equal(a.status, 'active');

  // 재충전 전에 발송된 B의 거절이 지금 도착한다.
  assert.equal(am.setCreditExhausted(a, 'credit-exhausted', { persist: false, stamp: stampB }), null);
  assert.equal(a.creditExhausted, undefined);
  assert.equal(a.status, 'active');
  assert.equal(am._isAvailable(a), true);
});

test('creditSince를 바꾸지 않은 재활성화(손으로 플래그 삭제)도 세대가 바뀌어 늦은 거절을 무시한다', () => {
  const am = makeManager();
  const a = am.accounts[0];
  const stamp = am.creditDispatchStamp(a);
  am.setCreditExhausted(a, 'billing', { persist: false });
  am.clearCreditExhausted(a, { persist: false });
  assert.equal(am.setCreditExhausted(a, 'billing', { persist: false, stamp }), null);
  assert.equal(a.status, 'active');
});

test('키를 교체한 뒤 도착한 옛 키의 거절은 새 키를 차단하지 않는다', () => {
  const am = makeManager();
  const a = am.accounts[0];
  const stamp = am.creditDispatchStamp(a);
  am.setApiKey(a, 'test-key-replaced');
  assert.equal(a.credential, 'test-key-replaced');
  assert.equal(am.setCreditExhausted(a, 'spend-limit', { persist: false, stamp }), null);
  assert.equal(a.status, 'active');
  // 새 키로 발송한 요청의 거절은 그대로 차단한다.
  assert.ok(am.setCreditExhausted(a, 'spend-limit', { persist: false, stamp: am.creditDispatchStamp(a) }));
  assert.equal(a.errorReason, 'credit-exhausted');
  // 키 교체는 소진 플래그도 해제한다.
  am.setApiKey(a, 'test-key-third');
  assert.equal(a.creditExhausted, undefined);
  assert.equal(a.status, 'active');
});

test('도장에는 키 값이 없다', () => {
  const am = makeManager();
  const stamp = am.creditDispatchStamp(am.accounts[0]);
  assert.equal(JSON.stringify(stamp).includes('test-key-'), false);
});

test('creditStampMatchesConfig: 설정 쓰기는 디스크의 creditSince·키가 발송 때와 같을 때만', () => {
  const am = makeManager();
  const a = am.accounts[0];
  const stamp = am.creditDispatchStamp(a);
  const disk = { name: 'api-1', type: 'apikey', apiKey: 'test-key-api-1', creditUsd: 20, creditSince: SINCE };
  assert.equal(creditStampMatchesConfig(disk, stamp), true);
  assert.equal(creditStampMatchesConfig({ ...disk, creditSince: SINCE + 1 }, stamp), false, '재충전된 디스크 상태');
  assert.equal(creditStampMatchesConfig({ ...disk, apiKey: 'test-key-other' }, stamp), false, '교체된 키');
  assert.equal(creditStampMatchesConfig({ ...disk, creditSince: undefined }, stamp), false);
  assert.equal(creditStampMatchesConfig(disk, null), true, '도장 없는 호출(재적용 경로)은 막지 않는다');
});

test('영속 쓰기가 실패하면 상태에 드러나고, 같은 사유가 다시 와도 쓰기를 다시 시도한다', async () => {
  const am = makeManager();
  const a = am.accounts[0];
  let calls = 0;
  let fail = true;
  am.onAccountCreditFlag(() => {
    calls++;
    if (fail) return Promise.reject(new Error('disk full'));
    return Promise.resolve();
  });
  am.setCreditExhausted(a, 'credit-exhausted');
  await am.waitForAccountFlag(a).catch(() => {});
  assert.equal(calls, 1);
  assert.equal(am.getStatus().accounts[0].credit.persistFailed, true);

  fail = false;
  am.setCreditExhausted(a, 'credit-exhausted');
  await am.waitForAccountFlag(a);
  assert.equal(calls, 2, '저장 실패한 같은 플래그는 다시 쓴다');
  assert.equal(am.getStatus().accounts[0].credit.persistFailed, false);

  // 저장이 끝난 뒤의 같은 사유는 다시 쓰지 않는다.
  am.setCreditExhausted(a, 'credit-exhausted');
  await am.waitForAccountFlag(a);
  assert.equal(calls, 2);
});

test('재적용: 디스크에 플래그가 없을 때 저장 실패한 차단은 지우지 않고 다시 쓴다, 저장된 차단은 지운다', async () => {
  const am = makeManager();
  const a = am.accounts[0];
  let calls = 0;
  let fail = true;
  am.onAccountCreditFlag(() => { calls++; return fail ? Promise.reject(new Error('io')) : Promise.resolve(); });
  am.setCreditExhausted(a, 'credit-exhausted');
  await am.waitForAccountFlag(a).catch(() => {});

  fail = false;
  am.reconcileCreditFlagFromDisk(a, null);
  await am.waitForAccountFlag(a);
  assert.equal(a.errorReason, 'credit-exhausted', '저장 못 한 차단을 디스크 기준으로 풀면 안 된다');
  assert.equal(calls, 2);
  assert.equal(am.getStatus().accounts[0].credit.persistFailed, false);

  // 이제 저장됐다. 디스크에서 플래그가 지워지면(api-credit) 해제한다.
  am.reconcileCreditFlagFromDisk(a, null);
  assert.equal(a.creditExhausted, undefined);
  assert.equal(a.status, 'active');

  // 디스크에 플래그가 있으면 세운다(저장된 상태로).
  am.reconcileCreditFlagFromDisk(a, { reason: 'billing', at: 5 });
  assert.equal(a.creditExhausted.reason, 'billing');
  assert.equal(am.getStatus().accounts[0].credit.persistFailed, false);
});
