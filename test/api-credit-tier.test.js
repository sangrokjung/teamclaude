// 유료 계층(B3): Claude Code 요청은 구독 계정이 하나라도 서빙할 수 있으면 API 키를
// 고르지 않는다. /byok 통로는 반대로 API 키를 먼저 쓴다. API 키끼리는 만료 임박 →
// 추정 잔액 적은 순 → 배열 순.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const apiKey = (name, extra = {}) => ({ name, type: 'apikey', apiKey: `test-key-${name}`, ...extra });
const oauth = (name, extra = {}) => ({
  name, type: 'oauth', accessToken: `tok-${name}`, refreshToken: `r-${name}`, expiresAt: Date.now() + HOUR, ...extra,
});

function measure(a, { five = 0.1, seven = 0.2 } = {}) {
  a.quota.unified5h = five;
  a.quota.unified5hReset = Date.now() + HOUR;
  a.quota.unified7d = seven;
  a.quota.unified7dReset = Date.now() + 3 * DAY;
}

function measureKey(a) {
  a.quota.tokensLimit = 1000;
  a.quota.tokensRemaining = 900;
}

function makeManager(accounts, maxConcurrent = 3) {
  const am = new AccountManager(accounts, 0.98, 0, maxConcurrent);
  for (const a of am.accounts) {
    if (a.type === 'oauth') measure(a); else measureKey(a);
  }
  return am;
}

const byokScope = () => Object.assign(new Set(), { byok: true });

test('구독 계정이 서빙 가능하면 API 키는 우선순위가 있어도 고르지 않는다', () => {
  const am = makeManager([apiKey('api-1', { priority: 0 }), oauth('sub-1')]);
  assert.equal(am.getActiveAccount().name, 'sub-1');
  assert.equal(am._isAvailable(am.accounts[0]), false);
  // 이번 요청이 시도만 한(쓸 수는 있는) 구독 계정은 잠금 범위(scope)에 들지 않는다.
  assert.equal(am._selectBest(new Set([am.accounts[1]]), null, null), null, '시도한 구독을 뺀 실패 조치도 API 키로 새지 않는다');
});

test('구독 계정이 동시성 한도로만 꽉 찼으면 API 키로 넘기지 않고 대기한다', async () => {
  const am = makeManager([oauth('sub-1'), apiKey('api-1')], 1);
  const first = await am.acquireAccount(null, 0);
  assert.equal(first.name, 'sub-1');
  assert.equal(am.anyUsable(null), false);
  assert.equal(am.anyCapped(null), true);
  const second = await am.acquireAccount(null, 30);
  assert.equal(second, null, 'API 키를 받지 않고 대기열 시간 초과');
  am.releaseAccount(first);
});

for (const [label, park] of [
  ['주간 소진', a => measure(a, { seven: 0.99 })],
  // 5시간만 가득이면 상류 유예(usageLimitGrace)가 먼저다. 유예가 거절된 뒤에야 API 키로 간다.
  ['5시간 소진·유예 거절', a => { measure(a, { five: 0.99 }); a._graceSpentUntil = Date.now() + HOUR; }],
  ['스로틀', a => { a.status = 'throttled'; a.rateLimitedUntil = Date.now() + HOUR; }],
  ['비활성', a => { a.enabled = false; }],
  ['오류', a => { a.status = 'error'; a.errorReason = 'auth-revoked'; }],
]) {
  test(`구독 계정이 모두 ${label}이면 API 키가 서빙한다`, () => {
    const am = makeManager([oauth('sub-1'), oauth('sub-2'), apiKey('api-1')]);
    park(am.accounts[0]);
    park(am.accounts[1]);
    assert.equal(am.getActiveAccount().name, 'api-1');
  });
}

test('모델별 소진(Fable 주간)이면 원래 모델로 API 키가 서빙하고, 다른 모델은 구독으로 간다', () => {
  const am = makeManager([oauth('sub-1'), apiKey('api-1')]);
  am.accounts[0].quota.modelWeekly['7d_oi'] = { utilization: 1, reset: Date.now() + DAY };
  assert.equal(am.getActiveAccount(null, 'claude-fable-5').name, 'api-1');
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8').name, 'sub-1');
});

test('구독 계정이 없는 풀은 지금처럼 API 키를 바로 쓴다', () => {
  const am = makeManager([apiKey('api-1'), apiKey('api-2')]);
  assert.equal(am.getActiveAccount().type, 'apikey');
  assert.equal(am.anyUsable(null), true);
});

test('구독 계정이 회복하면 붙어 있던 API 키에서 구독으로 돌아온다', () => {
  const am = makeManager([oauth('sub-1'), apiKey('api-1')]);
  measure(am.accounts[0], { seven: 0.99 });
  assert.equal(am.getActiveAccount().name, 'api-1');
  measure(am.accounts[0], { seven: 0.2 });
  assert.equal(am.getActiveAccount().name, 'sub-1');
});

test('/byok 범위는 API 키를 먼저 쓰고, 키가 없거나 소진이면 구독으로 간다', async () => {
  const am = makeManager([oauth('sub-1'), apiKey('api-1')]);
  assert.equal(am.getActiveAccount(null, null, byokScope()).name, 'api-1');
  const acquired = await am.acquireAccount(null, 0, null, null, null, null, byokScope());
  assert.equal(acquired.name, 'api-1');
  am.releaseAccount(acquired);
  // byok 요청이 구독 쪽 고정 계정을 옮기지 않는다.
  assert.equal(am.getActiveAccount().name, 'sub-1');

  am.setCreditExhausted(am.accounts[1], 'credit-exhausted', { persist: false });
  assert.equal(am.getActiveAccount(null, null, byokScope()).name, 'sub-1');
});

test('/byok 범위: API 키가 동시성 한도로 꽉 차면 구독으로 넘친다', async () => {
  const am = makeManager([oauth('sub-1'), apiKey('api-1')], 1);
  const a = await am.acquireAccount(null, 0, null, null, null, null, byokScope());
  const b = await am.acquireAccount(null, 0, null, null, null, null, byokScope());
  assert.equal(a.name, 'api-1');
  assert.equal(b.name, 'sub-1');
});

test('/byok 범위는 연결 친화(affinity)보다 API 키를 먼저 쓴다', async () => {
  const am = makeManager([oauth('sub-1'), apiKey('api-1')]);
  const socket = {};
  const first = await am.acquireAccount(null, 0, null, socket);
  assert.equal(first.name, 'sub-1');
  am.releaseAccount(first);
  const second = await am.acquireAccount(null, 0, null, socket, null, null, byokScope());
  assert.equal(second.name, 'api-1');
});

test('API 키끼리: 만료 임박 → 추정 잔액 적은 순 → 배열 순', () => {
  const soon = Date.now() + 2 * DAY;
  const later = Date.now() + 20 * DAY;
  const am = makeManager([
    apiKey('k-none-a'),
    apiKey('k-none-b'),
    apiKey('k-later', { creditUsd: 5, creditExpiresAt: later }),
    apiKey('k-soon-big', { creditUsd: 40, creditExpiresAt: soon }),
    apiKey('k-soon-small', { creditUsd: 30, creditExpiresAt: soon }),
    apiKey('k-noexp-small', { creditUsd: 3 }),
  ]);
  am.recordApiSpend(am.accounts[4], { input_tokens: 15_000_000 }, 'claude-haiku-4-5'); // 30 - 15 = 15
  const order = [];
  const tried = new Set();
  for (let i = 0; i < am.accounts.length; i++) {
    const pick = am._selectBest(tried.size ? tried : null);
    order.push(pick.name);
    tried.add(pick);
  }
  assert.deepEqual(order, ['k-soon-small', 'k-soon-big', 'k-later', 'k-noexp-small', 'k-none-a', 'k-none-b']);
  assert.equal(am._strictlyPrefer(am.accounts[4], am.accounts[3]), true);
  assert.equal(am._strictlyPrefer(am.accounts[0], am.accounts[1]), true);
});

test('구독과 API 키가 함께 열려 있을 때 구독이 엄격히 앞선다', () => {
  const am = makeManager([apiKey('api-1'), oauth('sub-1')]);
  assert.equal(am._strictlyPrefer(am.accounts[1], am.accounts[0]), true);
  assert.equal(am._strictlyPrefer(am.accounts[0], am.accounts[1]), false);
});

test('요청 범위에서 인증 실패한 구독 계정은 API 키를 막지 않는다', () => {
  const am = makeManager([oauth('sub-1'), apiKey('api-1')]);
  const scope = new Set([am.accounts[0]]);
  assert.equal(am.getActiveAccount(scope, null, scope).name, 'api-1');
});
