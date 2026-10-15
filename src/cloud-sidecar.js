// Cloud-handoff sidecar for LEGACY `teamclaude run` supervisors.
//
// A supervisor started before the in-process cloud handoff shipped keeps the
// old code in memory: on fleet exhaustion it stops its claude child and sleeps
// until the quota resets. This one-shot scan (`teamclaude cloud-sidecar`, run
// periodically by launchd) finds such childless supervisors and performs the
// same attemptCloudHandoff on their behalf: permanent replay claim → SIGTERM
// the supervisor → `<vendor> --cloud <prompt>`. Pure decision logic with every
// side effect injected; the real process/fs/proxy seams live at the bottom.

import { execFile, spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { attemptCloudHandoff } from './cloud-handoff.js';
import { CLOUD_HANDOFF_MIN_WAIT_SECONDS } from './claude-recovery.js';
import { readPrivateJson } from './cmux-session-guards.js';

export const CLOUD_SIDECAR_LOG_PREFIX = '[TeamClaude cloud-sidecar]';
export const CLOUD_SIDECAR_MIN_CHILDLESS_MS = 60_000;
export const CLOUD_SIDECAR_DEFAULT_MAX_PER_RUN = 4;
export const CLOUD_SIDECAR_STOP_TIMEOUT_MS = 10_000;
const STOP_POLL_MS = 250;
const LEASE_START_TOLERANCE_SECONDS = 2;
const STORE_START_TOLERANCE_SECONDS = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PS_LINE_RE = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*\S)\s*$/;
const execFileAsync = promisify(execFile);

// ── parsing ─────────────────────────────────────────────────

// Output of `LC_ALL=C ps -axo pid=,ppid=,lstart=,command=`.
export function parsePsOutput(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const match = PS_LINE_RE.exec(line);
    if (!match) continue;
    const startedAtMs = new Date(match[3]).getTime();
    if (!Number.isFinite(startedAtMs)) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      lstart: match[3],
      startedAtMs,
      command: match[4],
    });
  }
  return rows;
}

function tokens(command) {
  return String(command ?? '').trim().split(/\s+/).filter(Boolean);
}

// node executing `.../src/index.js run` or `.../teamclaude.js run` (never
// `codex run`, `server`, or a shell that merely mentions it).
export function isTeamclaudeRunSupervisor(command) {
  const argv = tokens(command);
  if (argv.length < 3 || !/^node(?:\d+)?$/.test(basename(argv[0]))) return false;
  const entry = argv[1];
  const isEntry = entry.endsWith('/src/index.js') || basename(entry) === 'teamclaude.js';
  return isEntry && argv[2] === 'run';
}

// The exact session from the supervisor's own argv, or null when absent or
// ambiguous (two different IDs, or a forked resume that mints a new ID).
export function sessionIdFromArgv(command) {
  const argv = tokens(command);
  const runIndex = argv.indexOf('run');
  const args = runIndex >= 0 ? argv.slice(runIndex + 1) : [];
  if (args.includes('--fork-session')) return null;
  const found = new Set();
  for (let i = 0; i < args.length - 1; i += 1) {
    if (['--session-id', '--resume', '-r'].includes(args[i]) && UUID_RE.test(args[i + 1])) {
      found.add(args[i + 1].toLowerCase());
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

// ── exhaustion verdict ──────────────────────────────────────

function futureMs(value, nowMs) {
  if (value == null) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) && ms > nowMs ? ms : null;
}

function blockedUntil(utilization, reset, threshold, nowMs) {
  if (!Number.isFinite(utilization) || utilization < threshold) return null;
  return futureMs(reset, nowMs);
}

function ratio(remaining, limit) {
  return Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining)
    ? 1 - remaining / limit
    : NaN;
}

// When an unusable account can serve again: the LATEST of its blocking
// windows, or null when nothing on a known clock explains why it is out.
function accountRecoveryMs(account, threshold, nowMs) {
  const q = account?.quota || {};
  const blockers = [
    futureMs(account?.rateLimitedUntil, nowMs),
    blockedUntil(q.unified5h, q.unified5hReset, threshold, nowMs),
    blockedUntil(q.unified7d, q.unified7dReset, threshold, nowMs),
    blockedUntil(ratio(q.tokensRemaining, q.tokensLimit), q.tokensReset || q.resetsAt, threshold, nowMs),
    blockedUntil(ratio(q.requestsRemaining, q.requestsLimit), q.requestsReset || q.resetsAt, threshold, nowMs),
  ].filter(value => value != null);
  return blockers.length ? Math.max(...blockers) : null;
}

// Reads the proxy `/teamclaude/status` payload (AccountManager.getStatus()).
// Exhausted only when `usableCount` is 0, no enabled account is `usable` or
// `creditBacked`, and every enabled, non-error account has a known future
// recovery time. Anything uncertain is reported as not exhausted.
export function fleetExhaustionVerdict(status, nowMs, threshold = status?.switchThreshold ?? 0.98) {
  const no = reason => ({ exhausted: false, reason, earliestRecoveryMs: null });
  if (!status || typeof status !== 'object' || !Array.isArray(status.accounts)) return no('status-unknown');
  if (status.usableCount !== 0) return no('usable-accounts');
  const enabled = status.accounts.filter(account => account && account.enabled !== false);
  if (enabled.length === 0) return no('no-accounts');
  let earliest = Infinity;
  for (const account of enabled) {
    if (account.usable === true || account.creditBacked === true) return no('usable-accounts');
    // A parked account does not come back on a clock; it neither blocks nor
    // sets the recovery time.
    if (account.status === 'error') continue;
    const recovery = accountRecoveryMs(account, threshold, nowMs);
    if (recovery == null) return no('recovery-unknown');
    earliest = Math.min(earliest, recovery);
  }
  if (!Number.isFinite(earliest)) return no('recovery-unknown');
  return { exhausted: true, reason: 'exhausted', earliestRecoveryMs: earliest };
}

// ── session lookup ─────────────────────────────────────────

// The session bound to this supervisor (pid + process start) in the cmux
// stores: the recovery lease it holds while waiting, or the hook session
// record it launched. Exactly one distinct session, otherwise null.
export async function resolveSupervisorSessionId({
  storePath,
  pid,
  startedAtMs,
  readJson = readPrivateJson,
  listDir = path => readdir(path),
}) {
  if (typeof storePath !== 'string' || !Number.isInteger(pid) || !Number.isFinite(startedAtMs)) {
    return null;
  }
  const startSeconds = startedAtMs / 1000;
  const found = new Set();
  const leaseDir = `${storePath}.recovery-leases`;
  const names = await listDir(leaseDir).catch(() => []);
  for (const name of names) {
    if (!UUID_RE.test(name)) continue;
    const lease = await readJson(join(leaseDir, name)).catch(() => null);
    if (lease?.version === 1
        && lease.pid === pid
        && Number.isFinite(lease.processStartSeconds)
        && Math.abs(lease.processStartSeconds - startSeconds) <= LEASE_START_TOLERANCE_SECONDS) {
      found.add(name.toLowerCase());
    }
  }
  const store = await readJson(storePath).catch(() => null);
  const sessions = store?.sessions && typeof store.sessions === 'object' ? store.sessions : {};
  for (const session of Object.values(sessions)) {
    if (session
        && UUID_RE.test(session.sessionId || '')
        && session.pid === pid
        && Number.isFinite(session.pidStartSeconds)
        && Math.abs(session.pidStartSeconds - startSeconds) <= STORE_START_TOLERANCE_SECONDS) {
      found.add(session.sessionId.toLowerCase());
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

// ── scan ────────────────────────────────────────────────────

function observationKey(proc) {
  return `${proc.pid}:${proc.lstart}`;
}

function maxPerRun(config) {
  const value = config?.cloudSidecarMaxPerRun;
  return Number.isInteger(value) && value > 0 ? value : CLOUD_SIDECAR_DEFAULT_MAX_PER_RUN;
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// One scan. Returns { handoffs, attempts }; never throws for an expected
// no-op. Every decision is logged as one prefixed line without secrets.
export async function runCloudSidecar({
  config,
  now = () => Date.now(),
  vendorBin,
  listProcesses,
  fetchStatus,
  readCwd,
  resolveSessionFromStore = async () => null,
  claimOnce,
  releaseClaim,
  kill,
  isAlive,
  launchCloud,
  readState,
  writeState,
  buildHandoff,
  attemptHandoff = attemptCloudHandoff,
  handoffOptions = {},
  ledgerPath = null,
  baseEnv = process.env,
  sleep = defaultSleep,
  stopTimeoutMs = CLOUD_SIDECAR_STOP_TIMEOUT_MS,
  log = message => console.error(message),
}) {
  const say = message => log(`${CLOUD_SIDECAR_LOG_PREFIX} ${message}`);
  const summary = { handoffs: 0, attempts: 0 };
  if (config?.cloudFallbackOnExhaustion !== true) {
    say('cloudFallbackOnExhaustion is off; nothing to do.');
    return summary;
  }
  const cutoffMs = typeof config.cloudSidecarLegacyBefore === 'string'
    ? Date.parse(config.cloudSidecarLegacyBefore)
    : NaN;
  if (!Number.isFinite(cutoffMs)) {
    say('cloudSidecarLegacyBefore is not set to a valid time; nothing to do.');
    return summary;
  }
  if (typeof vendorBin !== 'string' || vendorBin.length === 0) {
    say('No vendor claude binary configured (TEAMCLAUDE_CLAUDE_BIN / cloudSidecarClaudeBin); nothing to do.');
    return summary;
  }

  let processes;
  try {
    processes = await listProcesses();
  } catch {
    say('Could not list processes; nothing to do.');
    return summary;
  }
  const nowMs = now();
  const parents = new Set(processes.map(proc => proc.ppid));
  const legacy = processes.filter(proc => isTeamclaudeRunSupervisor(proc.command)
    && Number.isFinite(proc.startedAtMs)
    && proc.startedAtMs < cutoffMs);
  const childless = legacy.filter(proc => !parents.has(proc.pid));

  // Consecutive-observation bookkeeping: keep only supervisors that are still
  // childless; a child appearing or the process vanishing forgets the entry.
  let state;
  try {
    state = await readState();
  } catch {
    state = null;
  }
  const previous = state?.observations && typeof state.observations === 'object'
    ? state.observations
    : {};
  const observations = {};
  for (const proc of childless) {
    const key = observationKey(proc);
    const prior = previous[key];
    observations[key] = prior && Number.isFinite(prior.firstChildlessAt)
      ? { ...prior }
      : { firstChildlessAt: nowMs };
  }
  const persist = async () => {
    try {
      await writeState({ observations });
    } catch {
      say('Could not write the sidecar state file.');
    }
  };
  await persist();

  const eligible = childless
    .filter(proc => {
      const entry = observations[observationKey(proc)];
      return !entry.attemptedAt && nowMs - entry.firstChildlessAt >= CLOUD_SIDECAR_MIN_CHILDLESS_MS;
    })
    .sort((a, b) => a.startedAtMs - b.startedAtMs);
  if (eligible.length === 0) {
    say(`${legacy.length} legacy supervisor(s), ${childless.length} childless; none observed childless for 60s yet.`);
    return summary;
  }

  let status = null;
  try {
    status = await fetchStatus();
  } catch {
    status = null;
  }
  const verdict = fleetExhaustionVerdict(status, nowMs);
  if (!verdict.exhausted) {
    say(`Fleet not confirmed exhausted (${verdict.reason}); leaving ${eligible.length} supervisor(s) alone.`);
    return summary;
  }
  const waitSeconds = Math.floor((verdict.earliestRecoveryMs - nowMs) / 1000);
  if (waitSeconds < CLOUD_HANDOFF_MIN_WAIT_SECONDS) {
    say(`Fleet recovers in ${waitSeconds}s (< ${CLOUD_HANDOFF_MIN_WAIT_SECONDS}s); leaving supervisors to resume locally.`);
    return summary;
  }

  const limit = maxPerRun(config);
  for (const proc of eligible) {
    if (summary.attempts >= limit) {
      say(`Per-run limit ${limit} reached; deferring the rest to the next scan.`);
      break;
    }
    const sessionId = sessionIdFromArgv(proc.command)
      ?? await resolveSessionFromStore({ pid: proc.pid, startedAtMs: proc.startedAtMs }).catch(() => null);
    if (!sessionId) {
      say(`Supervisor pid ${proc.pid}: session ID unknown; skipping.`);
      continue;
    }
    const cwd = await Promise.resolve().then(() => readCwd(proc.pid)).catch(() => null);
    if (typeof cwd !== 'string' || cwd.length === 0) {
      say(`Supervisor pid ${proc.pid}: working directory unreadable; skipping.`);
      continue;
    }

    summary.attempts += 1;
    let claimIdentity = null;
    let killSent = false;
    const beforeLaunch = async () => {
      const current = await listProcesses();
      const same = current.find(p => p.pid === proc.pid && p.lstart === proc.lstart);
      if (!same) throw new Error('supervisor changed');
      if (current.some(p => p.ppid === proc.pid)) throw new Error('supervisor has a child again');
      killSent = true;
      await kill(proc.pid, 'SIGTERM');
      for (let waited = 0; waited <= stopTimeoutMs; waited += STOP_POLL_MS) {
        if (!(await isAlive({ pid: proc.pid, lstart: proc.lstart }))) return;
        await sleep(STOP_POLL_MS);
      }
      throw new Error('supervisor did not exit');
    };
    let outcome;
    try {
      outcome = await attemptHandoff({
        ...handoffOptions,
        sessionId,
        cwd,
        baseEnv,
        vendorBin,
        ledgerPath,
        ledgerExtra: { source: 'legacy-sidecar' },
        now: new Date(nowMs),
        buildHandoff: () => buildHandoff({ sessionId, cwd }),
        claimBeforeLaunch: async () => {
          claimIdentity = await claimOnce(sessionId);
          return claimIdentity;
        },
        releaseClaim: claim => releaseClaim(sessionId, claim),
        beforeLaunch,
        launchCloud,
        log: say,
      });
    } catch {
      outcome = { ok: false, reason: 'error', stopped: false };
    }

    const key = observationKey(proc);
    if (outcome.ok) {
      summary.handoffs += 1;
      delete observations[key];
      say(`Supervisor pid ${proc.pid}: handed session ${sessionId} to a cloud session on ${outcome.account} (branch ${outcome.branch}).`);
    } else {
      // The supervisor was never signalled: a held claim would only block the
      // cmux rescuer from replaying a session that is still local.
      if (outcome.claimHeld && !killSent && claimIdentity) {
        let released = false;
        try {
          released = (await releaseClaim(sessionId, claimIdentity)) === true;
        } catch {
          released = false;
        }
        say(`Supervisor pid ${proc.pid}: changed before the stop; ${released ? 'released' : 'could not release'} the replay claim for ${sessionId}.`);
      } else if (outcome.claimHeld) {
        say(`Supervisor pid ${proc.pid}: cloud handoff for ${sessionId} failed after the stop; the replay claim stays held for manual continuation.`);
      } else {
        say(`Supervisor pid ${proc.pid}: cloud handoff for ${sessionId} not possible (${outcome.reason}).`);
      }
      if (observations[key]) observations[key] = { ...observations[key], attemptedAt: nowMs, reason: outcome.reason };
    }
    await persist();
  }
  return summary;
}

// ── real seams (used by `teamclaude cloud-sidecar`) ─────────

export async function listProcessesWithPs() {
  const { stdout } = await execFileAsync(
    'ps',
    ['-axo', 'pid=,ppid=,lstart=,command='],
    { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 64 * 1024 * 1024, timeout: 10_000 },
  );
  return parsePsOutput(stdout);
}

export async function readProcessCwd(pid) {
  const { stdout } = await execFileAsync(
    'lsof',
    ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
    { env: { ...process.env, LC_ALL: 'C' }, timeout: 10_000 },
  );
  const line = stdout.split('\n').find(entry => entry.startsWith('n/'));
  return line ? line.slice(1) : null;
}

// Alive = same pid AND same start time, and not a zombie.
export async function processIsAlive({ pid, lstart }) {
  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-p', String(pid), '-o', 'stat=,lstart='],
      { env: { ...process.env, LC_ALL: 'C' }, timeout: 5_000 },
    );
    const match = /^\s*(\S+)\s+(.*\S)\s*$/.exec(stdout);
    if (!match) return false;
    if (match[1].startsWith('Z')) return false;
    return match[2].replace(/\s+/g, ' ') === String(lstart).replace(/\s+/g, ' ');
  } catch (error) {
    // ps exits 1 when the pid does not exist.
    if (error?.code === 1) return false;
    throw error;
  }
}

export async function killProcess(pid, signal) {
  process.kill(pid, signal);
}

// `--cloud` needs a TTY; `script` supplies a pseudo-terminal.
export function launchCloudWithScript({ vendorBin, args, env, cwd }) {
  return spawnSync('script', ['-q', '/dev/null', vendorBin, ...args], {
    env,
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}
