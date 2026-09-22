import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installTimestampedConsole } from '../src/log-timestamps.js';

function fakeConsole() {
  const lines = { log: [], error: [] };
  return {
    lines,
    log: (...a) => lines.log.push(a.join(' ')),
    error: (...a) => lines.error.push(a.join(' ')),
  };
}

test('non-TTY consoles get an ISO timestamp before every line', () => {
  const c = fakeConsole();
  const restore = installTimestampedConsole({
    console: c, isTTY: false, now: () => new Date('2026-09-22T09:00:00.000Z'),
  });
  c.log('[TeamClaude] hello');
  c.error('[TeamClaude] boom', 42);
  restore();
  c.log('after');
  assert.deepEqual(c.lines.log, ['2026-09-22T09:00:00.000Z [TeamClaude] hello', 'after']);
  assert.deepEqual(c.lines.error, ['2026-09-22T09:00:00.000Z [TeamClaude] boom 42']);
});

test('TTY consoles are left untouched', () => {
  const c = fakeConsole();
  const originalLog = c.log;
  installTimestampedConsole({ console: c, isTTY: true });
  assert.equal(c.log, originalLog);
});
