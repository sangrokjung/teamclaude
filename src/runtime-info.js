// Build / uptime / worker-restart facts for the status payload. Pure: the
// supervisor passes its ledger to the worker through env at fork time (the
// worker serves /teamclaude/status, the supervisor owns the restarts), and this
// module only formats what it is given.
import { readFileSync } from 'node:fs';

const ARTIFACT_RE = /\/artifacts\/([0-9a-f]{64})\//;

function intOrNull(value) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : null;
}

function isoOrNull(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

export function runtimeInfo({
  env = process.env,
  entry = process.argv[1] || '',
  now = Date.now(),
  workerStartedAt,
  packageVersion = null,
} = {}) {
  const artifact = ARTIFACT_RE.exec(entry)?.[1] ?? null;
  return {
    version: packageVersion ?? null,
    artifact: artifact ? artifact.slice(0, 12) : null,
    entry,
    workerStartedAt: isoOrNull(workerStartedAt),
    supervisorStartedAt: isoOrNull(intOrNull(env.TEAMCLAUDE_SUPERVISOR_STARTED_AT)),
    uptimeMs: Math.max(0, now - workerStartedAt),
    workerRestarts: intOrNull(env.TEAMCLAUDE_WORKER_RESTARTS),
    lastWorkerRestartAt: isoOrNull(intOrNull(env.TEAMCLAUDE_WORKER_LAST_RESTART_AT)),
    lastWorkerRestartReason: env.TEAMCLAUDE_WORKER_LAST_RESTART_REASON || null,
  };
}

export function formatUptime(ms) {
  const totalMinutes = Math.max(0, Math.floor((Number(ms) || 0) / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const pad = n => String(n).padStart(2, '0');
  if (days > 0) return `${days}d ${pad(hours)}h`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  return `${minutes}m`;
}

export function readPackageVersion(url = new URL('../package.json', import.meta.url)) {
  try {
    return JSON.parse(readFileSync(url, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}
