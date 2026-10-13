// Confirmed account reload between the CLI and the running proxy worker.
//
// SIGHUP carries no payload, so the request identity travels through a small
// per-config directory next to the config file (`<config>.reload/`), split into
// `req/` (pending requests) and `res/` (results):
//
//   1. The CLI saves the config, writes `req/<nonce>.req`, then sends SIGHUP.
//   2. The worker, when its reload step actually starts, claims (unlinks) a
//      bounded batch of pending requests, re-reads the config from disk,
//      applies it, and writes `res/<nonce>.res` for each nonce it claimed.
//   3. The CLI reads ITS `res/<nonce>.res` by exact path (never a directory
//      scan) and reports success only on `{ ok: true }`.
//
// Correctness: a request file is written after the config save, and the worker
// claims it before it re-reads the config, so a result for that nonce always
// comes from a reload that saw the CLI's change. Several requests may be
// answered by one reload; a result for another nonce never counts.
//
// "Applied" therefore means "the running server re-read the config at or after
// this CLI's save" — the same last-writer-wins contract as the config file. If
// another CLI saved a conflicting change later (`disable` racing `enable`), the
// live state ends equal to the disk state, which is also what serialized
// one-reload-per-request processing would end with. Per-request revision
// matching would instead fail the earlier CLI although nothing is wrong. A worker
// that predates this protocol never writes a result, which the CLI reports as
// "unconfirmed" after the timeout.
//
// Cost bounds: uncollected results pile up only in `res/`, so they never slow
// down request handling (`req/` holds just the requests of live CLIs). The CLI
// looks up its own result by path, and the worker's stale-result sweep walks
// `res/` with an `opendir` iterator capped by entry count and time.

import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, opendir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const DEFAULT_RELOAD_CONFIRM_TIMEOUT_MS = 10_000;
const NONCE_RE = /^[0-9a-f]{32}$/;
// Results nobody collected (the CLI gave up or died) are swept on later reloads.
const STALE_RESULT_MS = 5 * 60_000;
// Per-step bounds of the stale-result sweep: entries examined and wall time.
export const SWEEP_MAX_ENTRIES = 200;
export const SWEEP_BUDGET_MS = 50;

export function newReloadNonce() {
  return randomBytes(16).toString('hex');
}

export function normalizeReloadTimeoutMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RELOAD_CONFIRM_TIMEOUT_MS;
}

const requestDir = dir => join(dir, 'req');
const resultDir = dir => join(dir, 'res');
export const reloadRequestPath = (dir, nonce) => join(requestDir(dir), `${nonce}.req`);
export const reloadResultPath = (dir, nonce) => join(resultDir(dir), `${nonce}.res`);

async function writeExclusive(path, data) {
  const fh = await open(path, 'wx', 0o600);
  try {
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
}

/** Iterate entry names of `path` lazily; a missing directory yields nothing. */
async function* entryNames(path) {
  let dirHandle;
  try {
    dirHandle = await opendir(path);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  // The async iterator closes the handle when the loop ends or breaks.
  for await (const entry of dirHandle) yield entry.name;
}

// ── worker side ─────────────────────────────────────────────

// Requests claimed (and results written) per reload step. A burst larger than
// this is served by follow-up steps instead of one unbounded fan-out.
export const MAX_CLAIMS_PER_STEP = 64;

/**
 * Remove uncollected results older than `staleMs`, examining at most
 * `maxEntries` entries of `res/` and stopping once `budgetMs` has elapsed.
 * Returns how many files were removed.
 */
async function sweepStaleResults(dir, { staleMs, maxEntries, budgetMs }) {
  const started = Date.now();
  const cutoff = started - staleMs;
  let examined = 0;
  let removed = 0;
  for await (const name of entryNames(resultDir(dir))) {
    if (examined >= maxEntries || Date.now() - started >= budgetMs) break;
    examined += 1;
    if (!name.endsWith('.res') && !name.includes('.res.tmp-')) continue;
    const path = join(resultDir(dir), name);
    try {
      if ((await stat(path)).mtimeMs <= cutoff) {
        await rm(path, { force: true });
        removed += 1;
      }
    } catch { /* already gone */ }
  }
  return removed;
}

/** Up to `limit` valid request nonces from `req/`, skipping `exclude`. */
async function listRequestNonces(dir, limit, exclude = new Set()) {
  const nonces = [];
  if (limit <= 0) return nonces;
  for await (const name of entryNames(requestDir(dir))) {
    if (!name.endsWith('.req')) continue;
    const nonce = name.slice(0, -'.req'.length);
    if (!NONCE_RE.test(nonce) || exclude.has(nonce)) continue;
    nonces.push(nonce);
    if (nonces.length >= limit) break;
  }
  return nonces;
}

/**
 * Claim up to `limit` pending requests: unlinking is the claim, so a request
 * its CLI withdrew (or one that cannot be removed) is skipped. `attempted`
 * lists every nonce tried, claimed or not.
 */
async function claimReloadRequests(dir, limit) {
  const attempted = await listRequestNonces(dir, limit);
  const claimed = [];
  for (const nonce of attempted) {
    try {
      await rm(reloadRequestPath(dir, nonce));
      claimed.push(nonce);
    } catch { /* withdrawn meanwhile, or not removable */ }
  }
  return { claimed, attempted };
}

async function writeReloadResult(dir, nonce, result) {
  const path = reloadResultPath(dir, nonce);
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await mkdir(resultDir(dir), { recursive: true, mode: 0o700 });
    await writeExclusive(tmp, JSON.stringify({ ...result, nonce }) + '\n');
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * One reload step: sweep a bounded slice of stale results, claim a bounded
 * batch of pending requests, run `reload`, and answer every claimed request.
 * Never throws — a failed reload is returned (and reported to the waiting
 * CLIs) so the caller keeps the worker running. `ackError` reports a
 * claim/result-write failure separately: the reload may have applied while a
 * waiting CLI never learns of it. `pending` is true when a request this step
 * did not try is waiting (batch overflow, or posted during the reload — its
 * SIGHUP may have been coalesced with the one being handled). A request that
 * was tried but could not be claimed does not count, so an unremovable file
 * cannot make the caller spin.
 */
export async function runConfirmedReload({
  dir,
  reload,
  onResultError = () => {},
  maxClaims = MAX_CLAIMS_PER_STEP,
  staleResultMs = STALE_RESULT_MS,
  sweepMaxEntries = SWEEP_MAX_ENTRIES,
  sweepBudgetMs = SWEEP_BUDGET_MS,
}) {
  let ackError = null;
  const noteAckError = err => {
    ackError ??= err?.message || String(err);
    onResultError(err);
  };

  let swept = 0;
  try {
    swept = await sweepStaleResults(dir, {
      staleMs: staleResultMs, maxEntries: sweepMaxEntries, budgetMs: sweepBudgetMs,
    });
  } catch (err) {
    onResultError(err); // housekeeping only; no waiting CLI depends on it
  }
  let claimed = [];
  let attempted = [];
  try {
    ({ claimed, attempted } = await claimReloadRequests(dir, maxClaims));
  } catch (err) {
    noteAckError(err);
  }
  let outcome;
  try {
    await reload();
    outcome = { ok: true };
  } catch (err) {
    outcome = { ok: false, error: err?.message || String(err) };
  }
  const result = { ...outcome, pid: process.pid, finishedAt: new Date().toISOString() };
  for (const nonce of claimed) {
    await writeReloadResult(dir, nonce, result).catch(noteAckError);
  }
  let pending = false;
  try {
    pending = (await listRequestNonces(dir, 1, new Set(attempted))).length > 0;
  } catch (err) {
    noteAckError(err);
  }
  return { ...outcome, claimed, ackError, pending, swept };
}

/**
 * Serialize reload steps (one per SIGHUP) and keep stepping while requests the
 * last step did not try are waiting, so a request whose SIGHUP was coalesced is
 * still answered. Each step is bounded (`maxClaims`) and goes back through the
 * same FIFO chain, so a step for a fresh SIGHUP is never starved by follow-ups;
 * every step is a full reload of the current config either way.
 */
export function createReloadQueue({ dir, reload, onResult = () => {}, ...stepOptions }) {
  let chain = Promise.resolve();
  const trigger = () => {
    chain = chain
      .then(() => runConfirmedReload({ dir, reload, ...stepOptions }))
      .then(result => {
        onResult(result);
        if (result.pending) trigger();
      })
      .catch(err => onResult({ ok: false, error: err?.message || String(err), claimed: [], pending: false }));
    return chain;
  };
  // Resolves once no step is queued or running (tests and shutdown paths).
  const whenIdle = async () => {
    for (;;) {
      const current = chain;
      await current;
      if (current === chain) return;
    }
  };
  return { trigger, whenIdle };
}

// ── CLI side ────────────────────────────────────────────────

/**
 * Create `path` as a 0700 directory, or tighten an existing one: mkdir's mode
 * only applies on creation. A symlink or non-directory is refused rather than
 * followed, so requests and results are never written through a link.
 */
async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory()) throw new Error(`${path} is not a directory`);
  if (process.platform !== 'win32') await chmod(path, 0o700);
}

/** Read and consume this request's result by exact path — never a directory scan. */
async function takeResult(dir, nonce) {
  const path = reloadResultPath(dir, nonce);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  await rm(path, { force: true });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: 'failed', error: 'unreadable reload result' };
  }
  if (body?.nonce !== nonce) return { status: 'failed', error: 'reload result for a different request' };
  return body.ok === true
    ? { status: 'applied' }
    : { status: 'failed', error: typeof body.error === 'string' ? body.error : 'unknown error' };
}

/**
 * CLI side: post a request, deliver the signal, and wait for this request's
 * result. Resolves to `{ status: 'applied' }`, `{ status: 'failed', error }`,
 * or `{ status: 'unconfirmed', reason }`.
 */
export async function requestConfirmedReload({
  dir,
  signal,
  timeoutMs = DEFAULT_RELOAD_CONFIRM_TIMEOUT_MS,
  pollMs = 50,
  isWorkerAlive = () => true,
  nonce = newReloadNonce(),
}) {
  await ensurePrivateDir(dir);
  await ensurePrivateDir(requestDir(dir));
  await ensurePrivateDir(resultDir(dir));
  await writeExclusive(reloadRequestPath(dir, nonce), '');
  const withdraw = () => rm(reloadRequestPath(dir, nonce), { force: true }).catch(() => {});

  try {
    signal();
  } catch (err) {
    await withdraw();
    return { status: 'unconfirmed', reason: `could not signal the worker: ${err.message}` };
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await takeResult(dir, nonce);
    if (result) return result;
    if (!isWorkerAlive()) {
      // The worker may have answered right before exiting.
      const last = await takeResult(dir, nonce);
      if (last) return last;
      await withdraw();
      return { status: 'unconfirmed', reason: 'worker-exited' };
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  await withdraw();
  // A result written between the last poll and the withdrawal still counts.
  return (await takeResult(dir, nonce)) || { status: 'unconfirmed', reason: 'timeout' };
}
