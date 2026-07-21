import os from 'node:os';

/**
 * Host CPU / RAM metrics — zero-dependency, Node `os` built-ins only.
 *
 * CPU busy% cannot be read at an instant: `os.cpus()` exposes cumulative
 * per-core time counters since boot, so a percentage is only defined BETWEEN
 * two snapshots. `createHostTracker()` keeps the previous snapshot and reports
 * the busy fraction of the interval since the last call (first call: null).
 */

/** Aggregate cumulative CPU times across all cores into { idle, total }. */
export function cpuSnapshot(cpus = os.cpus()) {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus || []) {
    for (const [kind, ms] of Object.entries(cpu.times)) {
      total += ms;
      if (kind === 'idle') idle += ms;
    }
  }
  return { idle, total };
}

/**
 * Busy percentage (0–100, 1 decimal) between two snapshots.
 * Returns null when the interval carries no information (missing snapshot,
 * zero/negative elapsed time — e.g. two calls within the same tick).
 */
export function cpuUsageBetween(prev, next) {
  if (!prev || !next) return null;
  const total = next.total - prev.total;
  const idle = next.idle - prev.idle;
  if (!(total > 0)) return null;
  const busy = Math.min(100, Math.max(0, ((total - idle) / total) * 100));
  return Math.round(busy * 10) / 10;
}

/** RAM usage from os.totalmem/freemem (bytes + percent, 1 decimal). */
export function memoryUsage() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    totalBytes: total,
    freeBytes: free,
    usedBytes: used,
    usedPct: total > 0 ? Math.round((used / total) * 1000) / 10 : null,
  };
}

/** "58.3/64.0 GB" style human string. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)}GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toFixed(0)}MB`;
}

/**
 * Stateful sampler: each sample() returns the full host picture, with CPU%
 * measured since the previous sample() call. Load average is the 1/5/15-min
 * triple (all-zero on Windows — surfaced as-is, consumers may hide it).
 */
export function createHostTracker() {
  let prev = cpuSnapshot();
  let prevAt = Date.now();
  let lastCpuPct = null;
  return {
    sample() {
      const now = Date.now();
      const snap = cpuSnapshot();
      // Sub-100ms re-entry (e.g. two status requests back to back) carries too
      // little signal — reuse the last measured value instead of returning a
      // jittery near-random percentage.
      if (now - prevAt >= 100) {
        const pct = cpuUsageBetween(prev, snap);
        if (pct != null) lastCpuPct = pct;
        prev = snap;
        prevAt = now;
      }
      const load = os.loadavg();
      return {
        cpu: {
          usedPct: lastCpuPct,
          cores: os.cpus().length,
          loadavg: [
            Math.round(load[0] * 100) / 100,
            Math.round(load[1] * 100) / 100,
            Math.round(load[2] * 100) / 100,
          ],
        },
        memory: memoryUsage(),
        sampledAt: new Date(now).toISOString(),
      };
    },
  };
}
