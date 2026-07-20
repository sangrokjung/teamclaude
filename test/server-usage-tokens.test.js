import { test } from 'node:test';
import assert from 'node:assert';
import { sumInputTokens } from '../src/server.js';

// `input_tokens` excludes the prompt cache; the bulk of a Claude Code request
// arrives as cache_read/cache_creation. The dashboard totals must fold all three
// input families or heavy cached sessions accumulate almost nothing.

test('sumInputTokens folds plain + cache_creation + cache_read', () => {
  assert.strictEqual(sumInputTokens({
    input_tokens: 8,
    cache_creation_input_tokens: 12000,
    cache_read_input_tokens: 950000,
  }), 962008);
});

test('sumInputTokens tolerates missing cache fields (non-cached request)', () => {
  assert.strictEqual(sumInputTokens({ input_tokens: 4321 }), 4321);
});

test('sumInputTokens tolerates absent/odd usage objects', () => {
  assert.strictEqual(sumInputTokens(undefined), 0);
  assert.strictEqual(sumInputTokens(null), 0);
  assert.strictEqual(sumInputTokens('usage'), 0);
  assert.strictEqual(sumInputTokens({}), 0);
});
