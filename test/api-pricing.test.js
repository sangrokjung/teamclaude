import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelName, resolveApiPrice, computeApiCost, normalizeApiPricing } from '../src/api-pricing.js';

// 단가표는 추정 잔액의 근거다. 손계산 예제와 맞는지, 모르는 모델을 엉뚱한
// 단가로 세지 않는지 고정한다.

test('모델 이름 정규화: 날짜·[1m]·-v1:0·-latest 접미를 뗀다', () => {
  assert.equal(normalizeModelName('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
  assert.equal(normalizeModelName('claude-sonnet-4-5[1m]'), 'claude-sonnet-4-5');
  assert.equal(normalizeModelName('claude-sonnet-4-5-20250929-v1:0'), 'claude-sonnet-4-5');
  assert.equal(normalizeModelName('claude-3-5-sonnet-latest'), 'claude-3-5-sonnet');
  assert.equal(normalizeModelName('Claude-Opus-4-5'), 'claude-opus-4-5');
  assert.equal(normalizeModelName(''), null);
  assert.equal(normalizeModelName(null), null);
});

test('가장 긴 접두로 맞추되 숫자 버전 경계는 넘지 않는다', () => {
  assert.equal(resolveApiPrice('claude-opus-4-5-20251101').input, 5);
  assert.equal(resolveApiPrice('claude-opus-4-20250514').input, 15);
  // claude-opus-4 단가가 claude-opus-4-8 같은 새 모델을 잡으면 안 된다.
  assert.equal(resolveApiPrice('claude-opus-4-8'), null);
  assert.equal(resolveApiPrice('claude-fable-5'), null);
  assert.equal(resolveApiPrice('claude-sonnet-5'), null);
  // 숫자가 아닌 꼬리는 같은 모델의 변형으로 본다.
  assert.equal(resolveApiPrice('claude-haiku-4-5-preview').output, 5);
});

test('캐시 단가는 입력 단가의 1.25배(5분)·2배(1시간)·0.1배(읽기)다', () => {
  const p = resolveApiPrice('claude-opus-4-5');
  assert.deepEqual(p, { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 });
});

test('비용 손계산 예제 (Sonnet 4.5)', () => {
  // 입력 1,000 × $3 + 캐시 쓰기 2,000 × $3.75 + 캐시 읽기 10,000 × $0.30 + 출력 500 × $15
  // = 0.003 + 0.0075 + 0.003 + 0.0075 = $0.021
  const r = computeApiCost({
    input_tokens: 1000,
    cache_creation_input_tokens: 2000,
    cache_read_input_tokens: 10000,
    output_tokens: 500,
  }, 'claude-sonnet-4-5-20250929');
  assert.equal(r.priced, true);
  assert.equal(r.tokens, 13500);
  assert.ok(Math.abs(r.usd - 0.021) < 1e-12, `usd=${r.usd}`);
});

test('cache_creation 분리 필드가 있으면 5분·1시간 단가를 따로 쓴다', () => {
  // Opus 4.5: 5분 1,000 × $6.25 + 1시간 1,000 × $10 = 0.00625 + 0.01 = $0.01625
  const r = computeApiCost({
    input_tokens: 0,
    cache_creation_input_tokens: 2000,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 },
    output_tokens: 0,
  }, 'claude-opus-4-5');
  assert.ok(Math.abs(r.usd - 0.01625) < 1e-12, `usd=${r.usd}`);
});

test('모르는 모델은 unpriced로 토큰만 센다', () => {
  const r = computeApiCost({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 }, 'claude-fable-5');
  assert.deepEqual(r, { priced: false, usd: 0, tokens: 160 });
  assert.deepEqual(computeApiCost({ input_tokens: 5 }, null), { priced: false, usd: 0, tokens: 5 });
});

test('잘못된 토큰 값은 0으로 본다', () => {
  const r = computeApiCost({ input_tokens: -5, output_tokens: 'x', cache_read_input_tokens: NaN }, 'claude-opus-4-5');
  assert.deepEqual(r, { priced: true, usd: 0, tokens: 0 });
  assert.deepEqual(computeApiCost(null, 'claude-opus-4-5'), { priced: true, usd: 0, tokens: 0 });
});

test('config.apiPricing 덮어쓰기: 새 모델 추가, 부분 입력은 배수로 보충, 잘못된 값 무시', () => {
  const overrides = normalizeApiPricing({
    'claude-fable-5': { input: 10, output: 50 },
    'claude-opus-4-5-20251101': { input: 4, output: 20, cacheRead: 0.3 },
    'bad-1': { input: -1, output: 5 },
    'bad-2': { input: 'x', output: 5 },
    'bad-3': 'nope',
  });
  assert.deepEqual(resolveApiPrice('claude-fable-5[1m]', overrides),
    { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 });
  assert.deepEqual(resolveApiPrice('claude-opus-4-5', overrides),
    { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.3 });
  assert.equal(resolveApiPrice('bad-1', overrides), null);
  assert.equal(resolveApiPrice('bad-2', overrides), null);
  assert.equal(resolveApiPrice('bad-3', overrides), null);
  // 덮어쓰기 없는 모델은 기본값 그대로.
  assert.equal(resolveApiPrice('claude-haiku-4-5', overrides).input, 1);
  assert.deepEqual(normalizeApiPricing(null), {});
  assert.deepEqual(normalizeApiPricing([1, 2]), {});
});
