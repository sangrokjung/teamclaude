// Daemon-mode process tracing: timestamped log lines, signal/exit trace lines,
// and a bounded best-effort `ps` snapshot taken when the supervisor is told to
// stop. Pure helpers plus one async capture; no proxy state lives here.
//
// Why: a launchd-managed supervisor that exits 0 was stopped by a signal, not a
// crash, and an untimestamped daemon log cannot be lined up with anything else
// to find out who sent it.

import { spawn } from 'node:child_process';
import { format } from 'node:util';

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'];
const INSTALLED = Symbol.for('teamclaude.timestampedConsole');
const MAX_SNAPSHOT_TIMEOUT_MS = 1000;
const MAX_COMMAND_CHARS = 160;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const DEFAULT_MAX_ROWS = 50;

/** Commands worth seeing when a stop signal arrives. */
export const PS_MATCH = /launchctl|kickstart|teamclaude|teamcodex|kill/i;

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/** Local wall-clock ISO-8601 with milliseconds and UTC offset. */
export function formatLocalTimestamp(date = new Date()) {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Prefix every line of `text` with `stamp` (a blank line becomes the bare stamp). */
export function prefixLines(text, stamp) {
  return String(text)
    .split('\n')
    .map(line => (line ? `${stamp} ${line}` : stamp))
    .join('\n');
}

/**
 * Wrap console methods so every emitted line starts with a local timestamp.
 * Idempotent: a second install returns the first uninstaller untouched.
 */
export function installTimestampedConsole({ target = console, now = () => new Date() } = {}) {
  if (target[INSTALLED]) return target[INSTALLED];
  const originals = {};
  for (const method of CONSOLE_METHODS) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    originals[method] = original;
    target[method] = (...args) => {
      // Format once here and hand the result over as a `%s` argument, so a
      // literal `%` in the already-formatted text is not interpreted twice.
      original.call(target, '%s', prefixLines(format(...args), formatLocalTimestamp(now())));
    };
  }
  const uninstall = () => {
    Object.assign(target, originals);
    delete target[INSTALLED];
  };
  target[INSTALLED] = uninstall;
  return uninstall;
}

function formatUptime(uptimeSec) {
  const n = Number(uptimeSec);
  return `${(Number.isFinite(n) ? n : 0).toFixed(1)}s`;
}

function orNa(value) {
  return value == null || value === '' ? 'n/a' : String(value);
}

export function formatSignalTrace({ role = 'Supervisor', signal, pid, ppid, uptimeSec, inflight, workerPid }) {
  const worker = workerPid == null ? '' : ` workerPid=${workerPid}`;
  return `[TeamClaude] ${role} received ${signal} pid=${pid} ppid=${ppid}`
    + ` uptime=${formatUptime(uptimeSec)} inflight=${orNa(inflight)}${worker}`;
}

export function formatSupervisorExitTrace({ reason, code, pid, uptimeSec }) {
  return `[TeamClaude] Supervisor exiting reason=${reason || 'unspecified'} code=${code ?? 0}`
    + ` pid=${pid} uptime=${formatUptime(uptimeSec)}`;
}

export function formatWorkerShutdownTrace({ signal, source, pid, ppid, supervisorPid, ipcConnected }) {
  return `[TeamClaude] Worker shutting down on ${signal} source=${source} pid=${pid} ppid=${ppid}`
    + ` supervisorPid=${orNa(supervisorPid)} ipc=${ipcConnected ? 'connected' : 'disconnected'}`;
}

// ── secret masking ──────────────────────────────────────────

function hasDigit(s) { return /\d/.test(s); }
function hasLetter(s) { return /[A-Za-z]/.test(s); }
function count(s, re) { return (s.match(re) || []).length; }

function maskSegment(segment) {
  return segment.length >= 32 && hasDigit(segment) && hasLetter(segment) ? '***' : segment;
}

function maskRun(run) {
  if (!run.includes('/')) return maskSegment(run);
  // Standard base64 may contain '/'. Treat a run as one token only when it does
  // not look like an absolute path and has the mixed alphabet of random data;
  // otherwise judge each slash-separated segment on its own.
  const tokenLike = !run.startsWith('/')
    && run.length >= 40
    && count(run, /\d/g) >= 2
    && count(run, /[A-Z]/g) >= 2
    && count(run, /[a-z]/g) >= 2;
  return tokenLike ? '***' : run.split('/').map(maskSegment).join('/');
}

/** Mask credential-looking substrings (sk-ant- keys, Bearer values, long base64-ish runs). */
export function maskSecrets(text) {
  return String(text)
    .replace(/\bBearer\s+[^\s'"]+/gi, 'Bearer ***')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***')
    .replace(/\bsk-(?!ant-\*)[A-Za-z0-9_-]{16,}/g, 'sk-***')
    .replace(/[A-Za-z0-9_+/=-]{32,}/g, maskRun);
}

// ── ps snapshot ─────────────────────────────────────────────

const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

/**
 * Parse `ps -axo pid=,ppid=,lstart=,command=` output, keep PS_MATCH rows and
 * render them as `pid= ppid= start="…" cmd=…` with the command masked and cut
 * to its first 160 characters.
 */
export function filterPsSnapshot(output, { maxLines = DEFAULT_MAX_ROWS } = {}) {
  const lines = [];
  let total = 0;
  for (const raw of String(output).split('\n')) {
    const m = PS_ROW.exec(raw);
    if (!m) continue;
    const [, pid, ppid, lstart, command] = m;
    if (!PS_MATCH.test(command)) continue;
    total += 1;
    if (lines.length >= maxLines) continue;
    const cmd = maskSecrets(command.trim()).slice(0, MAX_COMMAND_CHARS);
    lines.push(`pid=${pid} ppid=${ppid} start="${lstart.replace(/\s+/g, ' ')}" cmd=${cmd}`);
  }
  return { lines, total };
}

export function clampSnapshotTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return MAX_SNAPSHOT_TIMEOUT_MS;
  return Math.min(Math.max(1, Math.floor(n)), MAX_SNAPSHOT_TIMEOUT_MS);
}

/**
 * Best-effort process snapshot. Never rejects, never holds the event loop open
 * (the child and its pipe are unref'd), and gives up after at most one second.
 */
export function captureProcessSnapshot({
  spawnImpl = spawn,
  timeoutMs = MAX_SNAPSHOT_TIMEOUT_MS,
  maxLines = DEFAULT_MAX_ROWS,
} = {}) {
  const limit = clampSnapshotTimeout(timeoutMs);
  return new Promise(resolve => {
    let settled = false;
    let child = null;
    let timer = null;
    let output = '';
    let bytes = 0;
    const done = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child && child.exitCode == null && child.signalCode == null) {
        try { child.kill('SIGKILL'); } catch {}
      }
      resolve(result);
    };
    const fail = error => done({ ok: false, error, lines: [], total: 0 });
    try {
      child = spawnImpl('ps', ['-axo', 'pid=,ppid=,lstart=,command='], {
        stdio: ['ignore', 'pipe', 'ignore'],
        // System dirs first so a shadowing `ps` on PATH is not picked up; C
        // locale keeps lstart in the parseable English form.
        env: { PATH: `/bin:/usr/bin${process.env.PATH ? `:${process.env.PATH}` : ''}`, LC_ALL: 'C' },
      });
    } catch (err) {
      fail(err?.message || String(err));
      return;
    }
    timer = setTimeout(() => fail(`timed out after ${limit}ms`), limit);
    timer.unref?.();
    child.unref?.();
    child.stdout?.unref?.();
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_SNAPSHOT_BYTES) {
        fail('ps output too large');
        return;
      }
      output += chunk;
    });
    child.once('error', err => fail(err?.message || String(err)));
    child.once('close', (code, signal) => {
      if (code === 0) done({ ok: true, ...filterPsSnapshot(output, { maxLines }) });
      else fail(`ps exited ${signal || code}`);
    });
  });
}
