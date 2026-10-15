// Cloud-handoff sidecar for LEGACY `teamclaude run` supervisors.
//
// A supervisor started before the in-process cloud handoff shipped keeps the
// old code in memory: on fleet exhaustion it stops its claude child and sleeps
// until the quota resets. This one-shot scan (`teamclaude cloud-sidecar`, run
// periodically by launchd) finds such childless supervisors and performs the
// same attemptCloudHandoff on their behalf: permanent replay claim → SIGTERM
// the supervisor → `<vendor> --cloud <prompt>`. Pure decision logic with every
// side effect injected; the real process/fs/proxy seams live at the bottom.

import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { CloudHandoffNotStopped, attemptCloudHandoff } from './cloud-handoff.js';
import { CLOUD_HANDOFF_MIN_WAIT_SECONDS } from './claude-recovery.js';
import { readPrivateJson } from './cmux-session-guards.js';

export const CLOUD_SIDECAR_LOG_PREFIX = '[TeamClaude cloud-sidecar]';
export const CLOUD_SIDECAR_MIN_CHILDLESS_MS = 60_000;
export const CLOUD_SIDECAR_DEFAULT_MAX_PER_RUN = 4;
export const CLOUD_SIDECAR_STOP_TIMEOUT_MS = 10_000;
const STOP_POLL_MS = 250;
const LEASE_START_TOLERANCE_SECONDS = 2;
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

// The script path of `node <entry> run …`, or null for anything else (never
// `codex run`, `server`, or a shell that merely mentions it).
export function runSupervisorEntry(command) {
  const argv = tokens(command);
  if (argv.length < 3 || !/^node(?:\d+)?$/.test(basename(argv[0]))) return null;
  return argv[2] === 'run' ? argv[1] : null;
}

// node running EXACTLY one of the trusted install entries (this package's
// src/index.js or src/teamclaude.js) with the run subcommand. A path that only
// shares the suffix belongs to some other install or app.
export function isTeamclaudeRunSupervisor(command, trustedEntries = []) {
  const entry = runSupervisorEntry(command);
  return entry !== null && Array.isArray(trustedEntries) && trustedEntries.includes(entry);
}

// The default Claude pool, PROVEN from the raw `ps -wwE` text (argv + launch
// environment, space-joined). Values are never extracted — a space inside a
// value makes entry boundaries unprovable — so only ABSENCE is proven:
//   - the environment is visible: the text is the known command line plus a
//     space and a `NAME=` token (another uid's process shows argv only);
//   - no `TEAMCLAUDE_CONFIG=` / `XDG_CONFIG_HOME=` anywhere (argv included),
//     so the process reads the default config `<HOME>/.config/teamclaude.json`;
//   - `TEAMCLAUDE_PROVIDER=` at most once, and then right after a space,
//     followed by exactly `anthropic` and a space or the end. The only value
//     that changes the pool is exactly `codex`, which a text starting with
//     `anthropic` cannot be (real supervisors launched from a TeamClaude
//     shell carry `TEAMCLAUDE_PROVIDER=anthropic`).
// HOME is deliberately NOT judged from this text. The evidence for "same
// HOME" is the supervisor's recovery lease: defaultCmuxRescuePaths() derives
// the store from homedir() alone (HOME, else the passwd home — no other env
// override exists, in the legacy code or now), and the sidecar only reads
// leases from its OWN store. A supervisor with another HOME writes its lease
// elsewhere and can never become a candidate.
export function provesDefaultPool(text, command) {
  const no = reason => ({ ok: false, reason });
  if (typeof text !== 'string' || typeof command !== 'string' || command.length === 0
      || !text.startsWith(`${command} `)
      || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(text.slice(command.length + 1))) {
    return no('launch environment not visible');
  }
  if (text.includes('TEAMCLAUDE_CONFIG=') || text.includes('XDG_CONFIG_HOME=')) {
    return no('config override present');
  }
  const provider = occurrences(text, 'TEAMCLAUDE_PROVIDER=');
  if (provider.length > 1) return no('provider ambiguous');
  if (provider.length === 1 && !exactEntryAt(text, provider[0], 'TEAMCLAUDE_PROVIDER=', 'anthropic')) {
    return no('provider not provably anthropic');
  }
  return { ok: true };
}

function occurrences(text, needle) {
  const found = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) found.push(at);
  return found;
}

// `<key><value>` sits at `index`, right after a space, and is followed by a
// space or the end.
function exactEntryAt(text, index, key, value) {
  if (index === 0 || text[index - 1] !== ' ') return false;
  const start = index + key.length;
  if (text.slice(start, start + value.length) !== value) return false;
  const after = text[start + value.length];
  return after === undefined || after === ' ';
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

// The session a legacy supervisor is waiting on, from the ONE recovery lease
// it holds itself. The legacy fleet_exhausted path calls
// acquireFleetRecoveryClaim() → claimSessionLease(storePath, sessionId),
// which records the supervisor's own pid + process start (+ a nonce), and
// keeps it for the whole wait(). Argv (which may quote a prompt) and the hook
// session store are never used.
// Why this also closes the rescuer race: while the supervisor is alive its
// lease is live, so the cmux rescuer cannot take it; a lease held by the
// rescuer names the rescuer's pid and therefore is not a target here. The
// fence re-reads the lease under SIGSTOP and requires the same nonce: an
// unchanged nonce on a frozen supervisor proves it never let go, so no
// rescuer can have taken the lease before the sidecar's permanent claim.
// No lease (a non-cmux supervisor), more than one, or no nonce → null.
// Returns { sessionId, pid, processStartSeconds, nonce }.
export async function resolveSupervisorLease({
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
  const found = [];
  const leaseDir = `${storePath}.recovery-leases`;
  const names = await listDir(leaseDir).catch(() => []);
  for (const name of names) {
    if (!UUID_RE.test(name)) continue;
    const lease = await readJson(join(leaseDir, name)).catch(() => null);
    if (lease?.version === 1
        && lease.pid === pid
        && Number.isFinite(lease.processStartSeconds)
        && Math.abs(lease.processStartSeconds - startSeconds) <= LEASE_START_TOLERANCE_SECONDS) {
      found.push({ name: name.toLowerCase(), lease });
    }
  }
  if (found.length !== 1) return null;
  const [{ name, lease }] = found;
  if (typeof lease.nonce !== 'string' || lease.nonce.length === 0) return null;
  return {
    sessionId: name,
    pid: lease.pid,
    processStartSeconds: lease.processStartSeconds,
    nonce: lease.nonce,
  };
}

// The same lease, re-read by session for the check under SIGSTOP.
export async function readSessionLease({ storePath, sessionId, readJson = readPrivateJson }) {
  if (typeof storePath !== 'string' || !UUID_RE.test(sessionId || '')) return null;
  return readJson(join(`${storePath}.recovery-leases`, sessionId));
}

function sameLease(current, expected) {
  return Boolean(current && expected)
    && current.pid === expected.pid
    && current.processStartSeconds === expected.processStartSeconds
    && current.nonce === expected.nonce;
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

// Exhausted AND the earliest recovery is at least the in-process handoff's
// minimum wait away. Anything uncertain fails.
function exhaustionGate(status, nowMs) {
  const verdict = fleetExhaustionVerdict(status, nowMs);
  if (!verdict.exhausted) {
    return { ok: false, message: `Fleet not confirmed exhausted (${verdict.reason})` };
  }
  const waitSeconds = Math.floor((verdict.earliestRecoveryMs - nowMs) / 1000);
  if (waitSeconds < CLOUD_HANDOFF_MIN_WAIT_SECONDS) {
    return {
      ok: false,
      message: `Fleet recovers in ${waitSeconds}s (< ${CLOUD_HANDOFF_MIN_WAIT_SECONDS}s)`,
    };
  }
  return { ok: true, waitSeconds };
}

async function resolveOrNull(resolvePath, path) {
  try {
    const resolved = await resolvePath(path);
    return typeof resolved === 'string' && resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

async function trustedEntrySet(trustedEntries, resolvePath) {
  const set = new Set();
  for (const entry of Array.isArray(trustedEntries) ? trustedEntries : []) {
    if (typeof entry !== 'string' || !isAbsolute(entry)) continue;
    set.add(entry);
    const resolved = await resolveOrNull(resolvePath, entry);
    if (resolved) set.add(resolved);
  }
  return set;
}

// The trusted entry this command runs (exact path, or its realpath), or null.
async function trustedEntryOf(command, trusted, resolvePath) {
  const entry = runSupervisorEntry(command);
  if (!entry || !isAbsolute(entry)) return null;
  if (trusted.has(entry)) return entry;
  const resolved = await resolveOrNull(resolvePath, entry);
  return resolved && trusted.has(resolved) ? resolved : null;
}

// Pool membership from the supervisor's raw `ps -wwE` text (see
// provesDefaultPool). Unreadable → not a member (fail closed).
async function poolMembership(proc, { readProcessEnvText }) {
  let text = null;
  try {
    text = typeof readProcessEnvText === 'function' ? await readProcessEnvText(proc.pid, proc) : null;
  } catch {
    text = null;
  }
  return provesDefaultPool(text, proc.command);
}

// The sidecar serves the DEFAULT Claude pool only: no config override in its
// own environment (its store and config then both follow homedir()).
function sidecarDefaultPool(selfEnv) {
  const env = selfEnv && typeof selfEnv === 'object' ? selfEnv : {};
  if (env.TEAMCLAUDE_CONFIG !== undefined || env.XDG_CONFIG_HOME !== undefined) {
    return { ok: false, reason: 'the sidecar runs with a config override (default pool only)' };
  }
  if (env.TEAMCLAUDE_PROVIDER !== undefined && env.TEAMCLAUDE_PROVIDER !== 'anthropic') {
    return { ok: false, reason: 'the sidecar provider is not anthropic' };
  }
  return { ok: true };
}

// One scan. Returns { handoffs, attempts }; never throws for an expected
// no-op. Every decision is logged as one prefixed line without secrets.
export async function runCloudSidecar({
  config,
  now = () => Date.now(),
  vendorBin,
  trustedEntries = [],
  selfEnv = process.env,
  resolvePath = path => realpath(path),
  readProcessEnvText,
  listProcesses,
  listProcessesSync,
  fetchStatus,
  readCwd,
  resolveSupervisorLease: resolveLease = async () => null,
  readLease = async () => null,
  transcriptBlocked = async () => false,
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
  const self = sidecarDefaultPool(selfEnv);
  if (!self.ok) {
    say(`${self.reason}; nothing to do.`);
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
  const trusted = await trustedEntrySet(trustedEntries, resolvePath);
  const legacy = [];
  for (const proc of processes) {
    if (!Number.isFinite(proc.startedAtMs) || proc.startedAtMs >= cutoffMs) continue;
    const entry = await trustedEntryOf(proc.command, trusted, resolvePath);
    if (entry) legacy.push({ ...proc, entry });
  }
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
  const exhaustion = exhaustionGate(status, nowMs);
  if (!exhaustion.ok) {
    say(`${exhaustion.message}; leaving ${eligible.length} supervisor(s) alone.`);
    return summary;
  }

  const limit = maxPerRun(config);
  for (const proc of eligible) {
    if (summary.attempts >= limit) {
      say(`Per-run limit ${limit} reached; deferring the rest to the next scan.`);
      break;
    }
    // Pool membership BEFORE any snapshot or push: the status above describes
    // this sidecar's pool only.
    const membership = await poolMembership(proc, { readProcessEnvText });
    if (!membership.ok) {
      say(`Supervisor pid ${proc.pid}: not provably in this pool (${membership.reason}); skipping.`);
      continue;
    }
    const lease = await Promise.resolve()
      .then(() => resolveLease({ pid: proc.pid, startedAtMs: proc.startedAtMs }))
      .catch(() => null);
    const sessionId = lease?.sessionId;
    if (!sessionId) {
      say(`Supervisor pid ${proc.pid}: holds no unique recovery lease; skipping.`);
      continue;
    }
    // Only a session whose transcript still ENDS in the quota error it is
    // waiting out; a session that moved on (or cannot be judged) is left alone.
    const stillBlocked = await Promise.resolve()
      .then(() => transcriptBlocked(sessionId))
      .catch(() => false);
    if (stillBlocked !== true) {
      say(`Supervisor pid ${proc.pid}: session ${sessionId} transcript is not an unresolved exhaustion error; skipping.`);
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
    // Everything before the SIGTERM aborts with CloudHandoffNotStopped, so
    // attemptCloudHandoff releases the claim and the session stays local.
    const beforeLaunch = async () => {
      const notStopped = message => new CloudHandoffNotStopped(message);
      const unchanged = list => list.some(p => p.pid === proc.pid && p.lstart === proc.lstart)
        && !list.some(p => p.ppid === proc.pid);
      const listNow = () => {
        try {
          return listProcessesSync();
        } catch {
          return null;
        }
      };
      // 1. Preparation (snapshot, push, credit lookup) took time: re-check
      //    the fleet at this moment.
      let lateStatus = null;
      try {
        lateStatus = await fetchStatus();
      } catch {
        lateStatus = null;
      }
      const late = exhaustionGate(lateStatus, now());
      if (!late.ok) {
        say(`Supervisor pid ${proc.pid}: ${late.message} at the final check; not stopping it.`);
        throw notStopped('fleet no longer exhausted');
      }
      // 2. A SYNCHRONOUS process snapshot right before the first signal:
      //    same pid + lstart (no reuse) and still childless. On failure no
      //    signal at all is sent. Residual limit: the few milliseconds between
      //    this ps snapshot and SIGSTOP are not covered (a pid recycled or a
      //    child spawned exactly then); the check under SIGSTOP below catches
      //    the child case, and pid reuse within that window is accepted.
      const before = listNow();
      if (!before || !unchanged(before)) throw notStopped('supervisor changed or has a child again');
      try {
        await kill(proc.pid, 'SIGSTOP');
      } catch {
        throw notStopped('supervisor could not be paused');
      }
      // 3. Check again under the freeze (a stopped process cannot spawn a
      //    child). From here on SIGCONT always follows: on failure it resumes
      //    the supervisor untouched; after SIGTERM it lets the termination run.
      try {
        const frozen = listNow();
        if (!frozen || !unchanged(frozen)) {
          throw notStopped('supervisor changed or has a child again under pause');
        }
        // Same lease nonce on a frozen supervisor = it never released the
        // lease, so no rescuer could have taken it before our claim.
        let currentLease = null;
        try {
          currentLease = await readLease(sessionId);
        } catch {
          currentLease = null;
        }
        if (!sameLease(currentLease, lease)) {
          say(`Supervisor pid ${proc.pid}: recovery lease changed during preparation; not stopping it.`);
          throw notStopped('supervisor lease changed');
        }
        // The transcript must still end in the unresolved quota error.
        let blockedNow = false;
        try {
          blockedNow = (await transcriptBlocked(sessionId)) === true;
        } catch {
          blockedNow = false;
        }
        if (!blockedNow) {
          say(`Supervisor pid ${proc.pid}: session ${sessionId} moved on during preparation; not stopping it.`);
          throw notStopped('transcript moved on');
        }
        killSent = true;
        await kill(proc.pid, 'SIGTERM');
      } finally {
        try {
          await kill(proc.pid, 'SIGCONT');
        } catch {}
      }
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
      if (outcome.claimHeld && !killSent && claimIdentity) {
        say(`Supervisor pid ${proc.pid}: handoff for ${sessionId} aborted before the stop, but its replay claim could not be released.`);
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

// Synchronous twin for the final check right before the first signal: no
// event-loop turn between the snapshot and the SIGSTOP.
export function listProcessesWithPsSync() {
  const stdout = execFileSync(
    'ps',
    ['-ww', '-axo', 'pid=,ppid=,lstart=,command='],
    { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 64 * 1024 * 1024, timeout: 10_000, encoding: 'utf8' },
  );
  return parsePsOutput(stdout);
}

export async function listProcessesWithPs() {
  const { stdout } = await execFileAsync(
    'ps',
    // -ww: never truncate the command (session flags and the entry path).
    ['-ww', '-axo', 'pid=,ppid=,lstart=,command='],
    { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 64 * 1024 * 1024, timeout: 10_000 },
  );
  return parsePsOutput(stdout);
}

// The raw `ps -wwE` text (argv followed by the launch environment) for
// provesDefaultPool. Returned as-is to the in-memory check; never logged.
export async function readProcessEnvTextWithPs(pid) {
  const { stdout } = await execFileAsync(
    'ps',
    ['-wwE', '-p', String(pid), '-o', 'command='],
    { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 },
  );
  return stdout.replace(/\n+$/, '');
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

// `--cloud` needs a TTY; `script` supplies a pseudo-terminal. Creating a
// cloud session returns within seconds; the timeout keeps one hung launch from
// blocking every later sidecar run (a timed-out launch is a signal kill, so
// attemptCloudHandoff keeps the claim held and the session is preserved).
export const CLOUD_LAUNCH_TIMEOUT_MS = 5 * 60 * 1000;

export function launchCloudWithScript({ vendorBin, args, env, cwd }) {
  return spawnSync('script', ['-q', '/dev/null', vendorBin, ...args], {
    env,
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: CLOUD_LAUNCH_TIMEOUT_MS,
    killSignal: 'SIGTERM',
  });
}
