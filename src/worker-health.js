/**
 * Proxy-worker liveness judgement — pure decisions, no I/O, no proxy state.
 *
 * The supervisor owns the public port and relays every SSE byte and every
 * buffered request body on ONE event loop. Its health probe's timeout timer
 * lives on that same loop, so under host contention the timer fires the moment
 * the loop resumes — whether or not the worker ever stopped answering. Acting
 * on that verdict SIGKILLs a healthy worker and takes every in-flight turn with
 * it, which is exactly the failure it was meant to prevent (2026-08-07: 198
 * consecutive worker deaths, all supervisor-initiated, zero worker crashes).
 *
 * So a failed probe is classified, not obeyed:
 *   - our own freeze  → inconclusive (a frozen judge cannot convict)
 *   - refused/reset/non-200 → broken (the listener actually said something)
 *   - otherwise → strike (counts toward the threshold)
 * and reaching the threshold is corroborated over IPC before anything dies.
 */

/** A probe failure the worker's listener actively produced (not a timeout). */
export const PROBE_BROKEN = 'broken';

/**
 * Smallest self-stall that can discount a probe. Without a floor a very small
 * configured timeout (tests use single-digit ms) would make ordinary scheduling
 * jitter discard every probe, and a genuinely wedged worker would live forever.
 */
export const DEFAULT_STALL_TICK_MS = 250;

/**
 * @param {object} probe
 * @param {boolean} probe.ok            the worker answered 200
 * @param {string}  [probe.failure]     PROBE_BROKEN when the listener refused,
 *                                      reset the connection, or answered non-200
 * @param {number}  probe.selfStallMs   how long OUR event loop was blocked during the probe
 * @param {number}  probe.timeoutMs     the probe budget
 * @param {number}  [probe.tickMs]      stall-meter resolution (discount floor)
 * @returns {'healthy'|'broken'|'inconclusive'|'strike'}
 */
export function healthProbeVerdict({ ok, failure, selfStallMs = 0, timeoutMs, tickMs = DEFAULT_STALL_TICK_MS }) {
  if (ok) return 'healthy';
  // A frozen supervisor cannot fabricate an ECONNREFUSED or an HTTP 503 — those
  // are statements the worker's listener made, so they survive the discount.
  if (failure === PROBE_BROKEN) return 'broken';
  const discountAt = Math.max(tickMs, timeoutMs / 2);
  return selfStallMs >= discountAt ? 'inconclusive' : 'strike';
}

/**
 * What to do once a worker has struck out on HTTP probes.
 *
 * An IPC pong proves the worker's event loop is RUNNING, which no HTTP probe
 * can distinguish from "the loop is fine but the host is starved". A running
 * loop that misses probes is contention: replacing it destroys in-flight work
 * to fix nothing, and the replacement inherits the same starved host.
 *
 * @param {object} state
 * @param {boolean} state.broken    the listener itself failed (refused/reset/non-200)
 * @param {boolean} state.ipcAlive  the worker answered an IPC ping
 * @param {number}  [state.selfStallMs] supervisor stall during IPC corroboration
 * @param {number}  [state.timeoutMs] IPC timeout budget
 * @param {number}  [state.tickMs] stall-meter resolution
 * @returns {'keep'|'drain'|'kill'}
 */
export function unhealthyWorkerAction({
  broken,
  ipcAlive,
  selfStallMs = 0,
  timeoutMs,
  tickMs = DEFAULT_STALL_TICK_MS,
}) {
  if (!ipcAlive && Number.isFinite(timeoutMs)) {
    const verdict = healthProbeVerdict({
      ok: false,
      selfStallMs,
      timeoutMs,
      tickMs,
    });
    if (verdict === 'inconclusive') return 'keep';
  }
  if (!ipcAlive) return 'kill'; // no event loop at all: wedged or gone
  return broken ? 'drain' : 'keep';
}

/**
 * Running total of how long this process's event loop was blocked.
 *
 * A periodic timer that fires late by more than its interval was, by
 * definition, waiting on a blocked loop; the excess is the stall.
 */
export function createLoopStallMeter({
  tickMs = DEFAULT_STALL_TICK_MS,
  now = () => Date.now(),
  schedule = setInterval,
  cancel = clearInterval,
} = {}) {
  let accumulated = 0;
  let lastTick = now();
  const timer = schedule(() => {
    const at = now();
    const lag = at - lastTick - tickMs;
    lastTick = at;
    if (lag > 0) accumulated += lag;
  }, tickMs);
  timer?.unref?.();
  return {
    tickMs,
    /**
     * Includes a stall that is STILL in progress. After a long block Node
     * drains the timers phase in scheduled order, so a probe timeout can fire
     * before this meter's own tick — reading the ledger alone would report a
     * calm loop during the exact freeze we need to detect.
     */
    read() {
      return accumulated + Math.max(0, now() - lastTick - tickMs);
    },
    stop() {
      cancel(timer);
    },
  };
}
