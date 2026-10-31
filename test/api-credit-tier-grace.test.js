// 검토 지적 회귀(이중 검토 2라운드): ① 구독의 5시간 유예(usageLimitGrace)가 API 키보다
// 먼저다. ② API 키는 warm-up·프로브 대상이 아니고, 측정 전(tokensLimit null)에도
// _apiKeyCompare 순서와 연결 친화를 따른다. API 키의 quota는 일부러 비워 둔다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const apiKey = (name, extra = {}) => ({ name, type: 'apikey', apiKey: `test-key-${name}`, ...extra });
const oauth = (name, extra = {}) => ({
  name, type: 'oauth', accessToken: `tok-${name}`, refreshToken: `r-${name}`, expiresAt: Date.now() + HOUR, ...extra,
});
const byokScope = () => Object.assign(new Set(), { byok: true });

function measure(a, { five = 0.1, seven = 0.2 } = {}) {
  a.quota.unified5h = five;
  a.quota.unified5hReset = Date.now() + HOUR;
  a.quota.unified7d = seven;
  a.quota.unified7dReset = Date.now() + 3 * DAY;
}

const futureSec = ms => String(Math.floor((Date.now() + ms) / 1000));

test('5시간만 가득인 구독은 유예로 먼저 쓰고, 유예가 거절된 뒤에만 API 키로 간다', async () => {
  const am = new AccountManager([oauth('sub-1'), apiKey('api-1')], 0.98, 0, 3);
  const [sub, key] = am.accounts;
  measure(sub, { five: 0.99, seven: 0.2 });
  assert.equal(am._isGraceEligible(sub), true);

  const first = await am.acquireAccount(null, 0);
  assert.equal(first.name, 'sub-1', '유예 가능한 구독이 유료 키보다 먼저다');
  am.releaseAccount(first);
  assert.equal(am._isAvailable(key), false);

  // 상류가 유예를 거절했다(rejected 429).
  am.noteGraceRefused(sub, {
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-5h-utilization': '1',
    'anthropic-ratelimit-unified-5h-reset': futureSec(HOUR),
  });
  assert.equal(am._isGraceEligible(sub), false);
  const second = await am.acquireAccount(null, 0);
  assert.equal(second.name, 'api-1');
  am.releaseAccount(second);

  // /byok 역순 정책은 그대로: 유예가 남아 있어도 키 먼저.
  const am2 = new AccountManager([oauth('sub-1'), apiKey('api-1')], 0.98, 0, 3);
  measure(am2.accounts[0], { five: 0.99, seven: 0.2 });
  const viaByok = await am2.acquireAccount(null, 0, null, null, null, null, byokScope());
  assert.equal(viaByok.name, 'api-1');
});

function keyPool() {
  const am = new AccountManager([
    oauth('sub-1'),
    apiKey('api-none'),
    apiKey('api-soon', { creditUsd: 10, creditExpiresAt: Date.now() + DAY }),
  ], 0.98, 0, 3);
  measure(am.accounts[0], { seven: 0.99 }); // 구독 주간 소진(유예 없음)
  return am;
}

test('측정 전(tokensLimit null) API 키도 warm-up 라운드로빈이 아니라 만료 임박 순서로 고른다', () => {
  const am = keyPool();
  const [, none, soon] = am.accounts;
  assert.equal(none.quota.tokensLimit, null);
  assert.equal(am._isWarmupTarget(none), false);
  assert.equal(am._isWarmupTarget(soon), false);
  for (let i = 0; i < 4; i++) assert.equal(am.getActiveAccount().name, 'api-soon', `호출 ${i}`);
});

test('API 키는 active warm-up 후보가 아니다(유료 프로브 금지)', () => {
  const am = keyPool();
  assert.deepEqual(am.warmupCandidates().map(a => a.name), []);
  const am2 = new AccountManager([oauth('sub-1'), apiKey('api-1')], 0.98, 0, 3); // 구독 미측정
  assert.deepEqual(am2.warmupCandidates().map(a => a.name), ['sub-1']);
});

test('분당 창 리셋으로 tokensLimit이 비워진 API 키도 순서·후보 판정이 같다', () => {
  const am = keyPool();
  const [, none, soon] = am.accounts;
  for (const key of [none, soon]) {
    key.quota.tokensLimit = 1000;
    key.quota.tokensRemaining = 900;
    key.quota.tokensReset = new Date(Date.now() - 1000).toISOString();
  }
  am.sweepExpired();
  assert.equal(none.quota.tokensLimit, null, '지난 분당 창은 비워진다');
  assert.deepEqual(am.warmupCandidates(), []);
  assert.equal(am.getActiveAccount().name, 'api-soon');
});

test('측정 전 API 키가 있어도 연결 친화가 유지된다', async () => {
  const am = keyPool();
  const socket = {};
  const first = await am.acquireAccount(null, 0, null, socket);
  assert.equal(first.name, 'api-soon');
  am.releaseAccount(first);
  // 다른 키의 만료가 더 가까워져도 이 연결은 집(api-soon)에 머문다. 새 연결은 새 순서를 따른다.
  am.applyCreditConfig(am.accounts[1], { creditExpiresAt: Date.now() + HOUR });
  const again = await am.acquireAccount(null, 0, null, socket);
  assert.equal(again.name, 'api-soon');
  am.releaseAccount(again);
  const fresh = await am.acquireAccount(null, 0, null, {});
  assert.equal(fresh.name, 'api-none');
  am.releaseAccount(fresh);
});

test('applyCreditConfig는 바로 다시 고른다(만료·잔액이 바뀐 키로 고정 계정 이동)', () => {
  const am = keyPool();
  assert.equal(am.getActiveAccount().name, 'api-soon');
  assert.equal(am.accounts[am.currentIndex].name, 'api-soon');
  am.applyCreditConfig(am.accounts[1], { creditExpiresAt: Date.now() + HOUR });
  assert.equal(am.accounts[am.currentIndex].name, 'api-none', '재적용 직후 재선택');
});
