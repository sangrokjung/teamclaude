import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLoopStallMeter,
  healthProbeVerdict,
  unhealthyWorkerAction,
} from '../src/worker-health.js';

const TIMEOUT = 5000;

test('a probe that answered 200 is healthy regardless of how stalled we were', () => {
  assert.equal(
    healthProbeVerdict({ ok: true, selfStallMs: 9000, timeoutMs: TIMEOUT }),
    'healthy',
  );
});

test('a probe that timed out while THIS process was frozen is inconclusive, not a strike', () => {
  // The supervisor relays every SSE byte on the same event loop that owns the
  // probe's timeout timer. A loop that was blocked longer than half the budget
  // cannot testify about the worker: the timer fires the instant the loop
  // resumes, whether or not the worker ever stopped answering.
  assert.equal(
    healthProbeVerdict({ ok: false, selfStallMs: 2500, timeoutMs: TIMEOUT }),
    'inconclusive',
  );
});

test('a probe that timed out while this process ran normally is a strike', () => {
  assert.equal(
    healthProbeVerdict({ ok: false, selfStallMs: 120, timeoutMs: TIMEOUT }),
    'strike',
  );
});

test('the self-stall discount has a floor so a tiny configured timeout stays usable', () => {
  // timeoutMs/2 would be 5ms here; ordinary scheduling jitter would then
  // discard every probe and the worker could never be recycled.
  assert.equal(
    healthProbeVerdict({ ok: false, selfStallMs: 8, timeoutMs: 10, tickMs: 250 }),
    'strike',
  );
  assert.equal(
    healthProbeVerdict({ ok: false, selfStallMs: 400, timeoutMs: 10, tickMs: 250 }),
    'inconclusive',
  );
});

test('a refused/reset connection or a non-200 answer is a broken listener, never discounted', () => {
  // Our own freeze cannot fabricate an ECONNREFUSED or an HTTP 503: those are
  // statements the worker's listener actually made.
  for (const selfStallMs of [0, 60_000]) {
    assert.equal(
      healthProbeVerdict({ ok: false, failure: 'broken', selfStallMs, timeoutMs: TIMEOUT }),
      'broken',
    );
  }
});

test('timed-out probes plus a live IPC channel mean host contention, so keep the worker', () => {
  assert.equal(unhealthyWorkerAction({ broken: false, ipcAlive: true }), 'keep');
});

test('a worker that answers neither HTTP nor IPC is wedged and is killed outright', () => {
  assert.equal(unhealthyWorkerAction({ broken: false, ipcAlive: false }), 'kill');
  assert.equal(unhealthyWorkerAction({ broken: true, ipcAlive: false }), 'kill');
});

test('an IPC timeout while the supervisor itself was frozen is inconclusive', () => {
  assert.equal(unhealthyWorkerAction({
    broken: false,
    ipcAlive: false,
    selfStallMs: 3000,
    timeoutMs: 5000,
    tickMs: 250,
  }), 'keep');
  assert.equal(unhealthyWorkerAction({
    broken: true,
    ipcAlive: false,
    selfStallMs: 3000,
    timeoutMs: 5000,
    tickMs: 250,
  }), 'keep');
});

test('a broken listener on a worker whose loop still runs is drained, not killed', () => {
  assert.equal(unhealthyWorkerAction({ broken: true, ipcAlive: true }), 'drain');
});

test('the loop stall meter accumulates only the lag beyond the tick interval', () => {
  let clock = 1000;
  const now = () => clock;
  let tick = null;
  const meter = createLoopStallMeter({
    tickMs: 250,
    now,
    schedule: fn => { tick = fn; return { unref() {} }; },
    cancel: () => { tick = null; },
  });

  assert.equal(meter.read(), 0);

  clock += 250; // on time
  tick();
  assert.equal(meter.read(), 0);

  clock += 1250; // 1000ms late
  tick();
  assert.equal(meter.read(), 1000);

  meter.stop();
  assert.equal(tick, null);
});

test('the meter reports a stall that is still in progress, before its own tick runs', () => {
  // After a long block Node drains the timers phase in scheduled order, so the
  // health timeout can fire before the meter's tick. Reading only the ledger
  // would report a calm loop during the exact freeze we need to detect.
  let clock = 0;
  let tick = null;
  const meter = createLoopStallMeter({
    tickMs: 250,
    now: () => clock,
    schedule: fn => { tick = fn; return {}; },
    cancel: () => {},
  });
  clock += 3000; // the loop was blocked for 3s and no tick has run yet
  assert.equal(meter.read(), 2750);
  tick();
  assert.equal(meter.read(), 2750);
});
