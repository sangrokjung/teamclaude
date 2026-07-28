import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTokenRefreshIntervalMs } from '../src/config.js';

test('token refresh interval preserves off and clamps unsafe positive values', () => {
  assert.equal(normalizeTokenRefreshIntervalMs(undefined), 300_000);
  assert.equal(normalizeTokenRefreshIntervalMs('1000'), 300_000);
  assert.equal(normalizeTokenRefreshIntervalMs(-1), 0);
  assert.equal(normalizeTokenRefreshIntervalMs(0), 0);
  assert.equal(normalizeTokenRefreshIntervalMs(1), 60_000);
  assert.equal(normalizeTokenRefreshIntervalMs(59_999), 60_000);
  assert.equal(normalizeTokenRefreshIntervalMs(60_000), 60_000);
  assert.equal(normalizeTokenRefreshIntervalMs(300_000), 300_000);
});
