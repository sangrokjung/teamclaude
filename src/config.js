import { readFile, readdir, mkdir, rmdir, rm, open, rename, link } from 'node:fs/promises';
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const DEFAULT_TOKEN_REFRESH_INTERVAL_MS = 300_000;
const MIN_TOKEN_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_CONTINUITY_MAX_WAIT_MS = 15 * 60 * 1000;

export function normalizeTokenRefreshIntervalMs(value) {
  if (!Number.isFinite(value)) return DEFAULT_TOKEN_REFRESH_INTERVAL_MS;
  if (value <= 0) return 0;
  return Math.max(MIN_TOKEN_REFRESH_INTERVAL_MS, value);
}

export function normalizeContinuityMaxWaitMs(value) {
  if (!Number.isFinite(value)) return DEFAULT_CONTINUITY_MAX_WAIT_MS;
  if (value <= 0) return 0;
  return Math.max(1, Math.floor(value));
}

async function syncParentDirectory(path) {
  if (process.platform === 'win32') return;
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

// Every persistent file here is written via write-to-temp → fsync → rename.
// A plain in-place write truncates first, so a process death mid-write (OOM
// kill, crash, power loss) leaves a 0-byte file — which is exactly how the
// whole account fleet's credentials were lost on 2026-07-27 under memory
// pressure. rename() on the same filesystem is atomic: readers (and the next
// boot) see either the old file or the new one, never a partial.
async function writeFileAtomic(path, data, mode = 0o600) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    const fh = await open(tmp, 'w', mode);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
    await syncParentDirectory(path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

const CONFIG_LOCK_TIMEOUT_MS = 120_000;

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function readConfigLockClaims(queuePath) {
  let names;
  try {
    names = await readdir(queuePath);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const claims = [];
  for (const name of names) {
    if (!name.startsWith('claim-') || !name.endsWith('.json')) continue;
    const claimPath = join(queuePath, name);
    try {
      claims.push({
        ...JSON.parse(await readFile(claimPath, 'utf8')),
        name,
        path: claimPath,
      });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return claims;
}

/**
 * A filesystem bakery queue serializes stale-lock recovery before any writer
 * inspects or unlinks the shared lock pathname. Claims are uniquely named, so
 * reclaiming a dead process removes only that process's claim — never a live
 * writer that replaced a shared path between a read and an unlink.
 */
async function acquireConfigLockQueue(path, deadline) {
  const queuePath = `${path}.lock-queue`;
  const nonce = randomBytes(12).toString('hex');
  const name = `claim-${process.pid}-${nonce}.json`;
  const claimPath = join(queuePath, name);
  const cleanup = async () => {
    await rm(claimPath, { force: true }).catch(() => {});
    await rmdir(queuePath).catch(() => {});
  };

  while (true) {
    await mkdir(queuePath, { recursive: true });
    try {
      await writeFileAtomic(claimPath, JSON.stringify({
        pid: process.pid,
        nonce,
        ticket: null,
      }));
      break;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  try {
    let ticket = 1;
    for (const claim of await readConfigLockClaims(queuePath)) {
      if (claim.name === name) continue;
      if (!isProcessAlive(claim.pid)) {
        await rm(claim.path, { force: true }).catch(() => {});
      } else if (Number.isInteger(claim.ticket) && claim.ticket >= ticket) {
        ticket = claim.ticket + 1;
      }
    }
    await writeFileAtomic(claimPath, JSON.stringify({ pid: process.pid, nonce, ticket }));

    while (true) {
      let blocked = false;
      for (const claim of await readConfigLockClaims(queuePath)) {
        if (claim.name === name) continue;
        if (!isProcessAlive(claim.pid)) {
          await rm(claim.path, { force: true }).catch(() => {});
          continue;
        }
        if (!Number.isInteger(claim.ticket)
            || claim.ticket < ticket
            || (claim.ticket === ticket && claim.name < name)) {
          blocked = true;
        }
      }
      if (!blocked) return cleanup;
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for config lock recovery queue');
      }
      await new Promise(resolve => setTimeout(resolve, 20 + Math.floor(Math.random() * 30)));
    }
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/**
 * Serialize config read-modify-write cycles across processes.
 *
 * The candidate is fully written before link() publishes it as `<config>.lock`,
 * so a crash cannot leave a half-written owner record. A dead owner's lock is
 * recoverable; a live owner is never timed out and stolen.
 */
async function withConfigLock(operation) {
  const path = getConfigPath();
  const lockPath = `${path}.lock`;
  const nonce = randomBytes(12).toString('hex');
  const owner = JSON.stringify({ pid: process.pid, nonce });
  const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS;
  await mkdir(dirname(path), { recursive: true });
  const releaseQueue = await acquireConfigLockQueue(path, deadline);

  try {
    while (true) {
      const candidate = `${lockPath}.candidate-${process.pid}-${randomBytes(4).toString('hex')}`;
      await writeFileAtomic(candidate, owner);
      try {
        await link(candidate, lockPath);
        await rm(candidate, { force: true }).catch(() => {});
        break;
      } catch (err) {
        await rm(candidate, { force: true }).catch(() => {});
        if (err.code !== 'EEXIST') throw err;

        let current = null;
        try {
          current = JSON.parse(await readFile(lockPath, 'utf8'));
        } catch (readErr) {
          if (readErr.code === 'ENOENT') continue;
        }
        if (current?.pid && !isProcessAlive(current.pid)) {
          await rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for config lock held by pid ${current?.pid || 'unknown'}`);
        }
        await new Promise(resolve => setTimeout(resolve, 20 + Math.floor(Math.random() * 30)));
      }
    }

    try {
      return await operation();
    } finally {
      try {
        const current = JSON.parse(await readFile(lockPath, 'utf8'));
        if (current.pid === process.pid && current.nonce === nonce) {
          await rm(lockPath, { force: true });
        }
      } catch {}
    }
  } finally {
    await releaseQueue();
  }
}

// Sync twin for the process-'exit' handler, where async I/O never completes.
function syncParentDirectorySync(path) {
  if (process.platform === 'win32') return;
  const fd = openSync(dirname(path), 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeFileAtomicSync(path, data, mode = 0o600) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    const fd = openSync(tmp, 'w', mode);
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    syncParentDirectorySync(path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw err;
  }
}

export function getConfigPath() {
  if (process.env.TEAMCLAUDE_CONFIG) return process.env.TEAMCLAUDE_CONFIG;
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const fileName = process.env.TEAMCLAUDE_PROVIDER === 'codex'
    ? 'teamcodex.json'
    : 'teamclaude.json';
  return join(configDir, fileName);
}

// Runtime state for the running server (pid/port), written next to the config so
// `teamcodex status` / `stop` / `restart` can find and signal it without the
// user hunting for the PID. One file per config, so different configs (and ports)
// never collide.
export function getServerStatePath() {
  return getConfigPath().replace(/\.json$/, '') + '.server.json';
}

export async function writeServerState(state) {
  const path = getServerStatePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, JSON.stringify(state, null, 2) + '\n');
}

export async function readServerState() {
  try {
    return JSON.parse(await readFile(getServerStatePath(), 'utf-8'));
  } catch {
    return null; // missing or unreadable → treat as "no recorded server"
  }
}

export async function clearServerState() {
  try { await rm(getServerStatePath(), { force: true }); } catch { /* best-effort */ }
}

// Per-account quota snapshot (credential-free), written next to the config so a
// restarted server starts from the last known quota/throttle state instead of a
// blank dashboard. Unlike the server-state file this survives exit on purpose.
export function getQuotaCachePath() {
  return getConfigPath().replace(/\.json$/, '') + '.quota.json';
}

export async function readQuotaCache() {
  try {
    return JSON.parse(await readFile(getQuotaCachePath(), 'utf-8'));
  } catch {
    return null; // missing or unreadable → start unmeasured, exactly as before
  }
}

/**
 * Synchronous on purpose: the last write happens inside a process 'exit'
 * handler, where async I/O never completes. The snapshot is small (a few KB).
 */
export function writeQuotaCacheSync(data) {
  try {
    const path = getQuotaCachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomicSync(path, JSON.stringify(data, null, 2) + '\n');
  } catch { /* best-effort — a failed snapshot must never break the proxy */ }
}

export function createDefaultConfig() {
  const provider = process.env.TEAMCLAUDE_PROVIDER === 'codex' ? 'codex' : 'anthropic';
  return {
    provider,
    proxy: {
      port: provider === 'codex' ? 3457 : 3456,
      apiKey: 'tc-' + randomBytes(24).toString('base64url'),
    },
    upstream: provider === 'codex'
      ? 'https://chatgpt.com/backend-api/codex'
      : 'https://api.anthropic.com',
    switchThreshold: 0.98,
    tokenRefreshIntervalMs: DEFAULT_TOKEN_REFRESH_INTERVAL_MS,
    // Max simultaneous in-flight requests per account before load spreads to the
    // next account (per-account `maxConcurrent` overrides this). Tune to just
    // below where one account starts returning rate/concurrency 429s.
    maxConcurrentPerAccount: 3,
    // Keep one client connection's sequential requests on the same account so
    // Anthropic's per-account prompt cache stays warm (a session's turns reuse
    // the keep-alive socket). Soft: concurrent overflow still spreads to other
    // accounts. Set false to route every request purely by use-or-lose priority.
    sessionAffinity: true,
    // How long (ms) a request waits for a free slot when every account is at its
    // cap, before returning 429. 0 = never queue.
    overflowQueueTimeoutMs: 15000,
    // Keep client requests inside the proxy while quota/cooldowns recover rather
    // than surfacing a 429 that interrupts an interactive Claude Code session.
    // A zero max wait retains the legacy fixed retry-count behavior.
    continuityMode: true,
    continuityMaxWaitMs: DEFAULT_CONTINUITY_MAX_WAIT_MS,
    continuityMaxSleepMs: 30000,
    continuityJitterMs: 500,
    // Maximum buffered upstream response per request. Transactional SSE spills
    // to disk after 1 MiB; non-SSE and OAuth responses remain memory-bounded.
    maxResponseBytes: 64 * 1024 * 1024,
    // Total deadline for upstream response headers and buffered response bodies.
    // Long-lived SSE bodies are exempt after their response headers arrive.
    upstreamResponseTimeoutMs: 300000,
    // Hard ceiling for one SSE response even when upstream keepalive/ping chunks
    // keep resetting the idle deadline. This fires before Claude Code's own
    // request timeout so the client receives a retryable overload response.
    streamTotalTimeoutMs: provider === 'anthropic' ? 900000 : null,
    // One alternate account distinguishes a per-account rate cap from a global
    // limit without multiplying one request across the whole fleet.
    rateLimitFailovers: 1,
    // When the whole fleet is out of quota for a requested model, rewrite the
    // request to these fallback models (in order) instead of surfacing the 429.
    // Keys and targets are plain API model IDs (no "[1m]"-style suffixes); a
    // suffixed incoming model falls back to its suffix-stripped entry.
    // e.g. { "claude-fable-5": ["claude-opus-4-8", "claude-sonnet-5"] }
    modelFallbacks: {},
    activeWarmup: provider === 'anthropic',
    launchModel: null,
    autoResumeClaude: true,
    claudeAutoResumeMaxRetries: 3,
    claudeAutoResumeBackoffMs: 2000,
    codexFallbackOnExhaustion: false,
    cmuxSessionRescue: false,
    cmuxSessionRescueIntervalMs: 1000,
    // Hard caps that bound proxy memory under a request flood.
    overflowQueueMaxDepth: 256,        // max queued requests before 429
    maxRequestBytes: 33554432,         // 32 MiB max buffered request body, else 413
    requestBodyTimeoutMs: 30000,        // total time allowed to receive one request body
    maxBufferedRequestBytes: 268435456, // 256 MiB request-buffer budget
    accounts: [],
  };
}

export async function loadConfig() {
  const path = getConfigPath();
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function loadOrCreateConfig() {
  let config = await loadConfig();
  if (!config) {
    config = await enqueueConfigWrite(() => withConfigLock(async () => {
      // Another process may have created (and populated) the file between the
      // optimistic read above and lock acquisition. Re-read under the lock so a
      // first-run CLI cannot overwrite those newly-added accounts with defaults.
      const existing = await loadConfig();
      if (existing) return existing;
      const created = createDefaultConfig();
      await saveConfigUnlocked(created);
      console.log(`Created config at ${getConfigPath()}`);
      return created;
    }));
  }
  return config;
}

async function saveConfigUnlocked(config) {
  const path = getConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Atomically update the config: re-reads from disk, calls updater(config),
 * then saves. Returns the updated config. This prevents overwriting changes
 * made by other processes (e.g. `teamcodex import` while the server runs).
 *
 * Calls are SERIALIZED within this process (via the chain below): atomicConfigUpdate
 * re-reads the whole file, mutates, and writes it all back, so two concurrent callers
 * — e.g. a background token refresh and a TUI save/delete — would each read the same
 * snapshot and the later write would clobber the earlier one's change (resurrecting a
 * just-deleted account, or dropping a freshly-refreshed token). The lock above extends
 * the same guarantee across processes, including a running server and concurrent CLI.
 */
let _configWriteChain = Promise.resolve();

function enqueueConfigWrite(run) {
  // Run after the previous cycle settles (success OR failure) so one failed update
  // can't stall the queue; keep the chain itself non-rejecting and surface the
  // result/error only to this caller.
  const result = _configWriteChain.then(run, run);
  _configWriteChain = result.then(() => {}, () => {});
  return result;
}

export function saveConfig(config) {
  return enqueueConfigWrite(() => withConfigLock(() => saveConfigUnlocked(config)));
}

export function atomicConfigUpdate(updater) {
  return enqueueConfigWrite(() => withConfigLock(async () => {
    const config = await loadConfig() || createDefaultConfig();
    await updater(config);
    await saveConfigUnlocked(config);
    return config;
  }));
}
