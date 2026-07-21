import { test } from 'node:test';
import assert from 'node:assert';
import { cpuSnapshot, cpuUsageBetween, memoryUsage, formatBytes, createHostTracker } from '../src/system-metrics.js';

const FAKE_CORE = (user, idle) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });

test('cpuSnapshot aggregates idle/total across cores', () => {
  const snap = cpuSnapshot([FAKE_CORE(100, 300), FAKE_CORE(50, 550)]);
  assert.deepStrictEqual(snap, { idle: 850, total: 1000 });
});

test('cpuUsageBetween measures busy% of the interval', () => {
  const prev = { idle: 800, total: 1000 };
  const next = { idle: 850, total: 1200 }; // +50 idle of +200 total → 75% busy
  assert.strictEqual(cpuUsageBetween(prev, next), 75);
});

test('cpuUsageBetween returns null without a measurable interval', () => {
  const s = { idle: 100, total: 200 };
  assert.strictEqual(cpuUsageBetween(null, s), null);
  assert.strictEqual(cpuUsageBetween(s, null), null);
  assert.strictEqual(cpuUsageBetween(s, s), null); // zero elapsed
  assert.strictEqual(cpuUsageBetween({ idle: 100, total: 300 }, s), null); // negative elapsed
});

test('cpuUsageBetween clamps into [0, 100]', () => {
  // idle going "backwards" (counter quirk) must not exceed 100
  assert.strictEqual(cpuUsageBetween({ idle: 100, total: 100 }, { idle: 50, total: 200 }), 100);
});

test('memoryUsage reports a coherent total/used/percent', () => {
  const m = memoryUsage();
  assert.ok(m.totalBytes > 0);
  assert.ok(m.usedBytes >= 0 && m.usedBytes <= m.totalBytes);
  assert.strictEqual(m.usedBytes + m.freeBytes, m.totalBytes);
  assert.ok(m.usedPct >= 0 && m.usedPct <= 100);
});

test('formatBytes renders GB/MB and tolerates junk', () => {
  assert.strictEqual(formatBytes(64 * 1024 ** 3), '64.0GB');
  assert.strictEqual(formatBytes(512 * 1024 ** 2), '512MB');
  assert.strictEqual(formatBytes(-1), '?');
  assert.strictEqual(formatBytes(NaN), '?');
});

test('createHostTracker: first sample has shape, cpu warms up between calls', async () => {
  const t = createHostTracker();
  const s1 = t.sample();
  assert.ok(Array.isArray(s1.cpu.loadavg) && s1.cpu.loadavg.length === 3);
  assert.ok(s1.cpu.cores > 0);
  assert.ok(s1.memory.totalBytes > 0);
  assert.ok(typeof s1.sampledAt === 'string');
  // immediately re-sampling (<100ms) must not produce a junk percentage
  const s2 = t.sample();
  assert.ok(s2.cpu.usedPct === null || (s2.cpu.usedPct >= 0 && s2.cpu.usedPct <= 100));
  await new Promise(r => setTimeout(r, 120));
  const s3 = t.sample();
  assert.ok(s3.cpu.usedPct === null || (s3.cpu.usedPct >= 0 && s3.cpu.usedPct <= 100));
});
