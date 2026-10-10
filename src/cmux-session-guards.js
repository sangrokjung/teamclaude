import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import {
  lstat,
  link,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { classifyClaudeApiErrorRecord } from './claude-recovery.js';
import {
  inspectClaudeProcess as defaultInspectClaudeProcess,
  isTeamClaudeSupervisor,
} from './cmux-process-guard.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SURFACE_RE = /^(?:surface:\d+|[0-9a-f-]{36})$/i;
const NOFOLLOW = constants.O_NOFOLLOW || 0;
const DIRECTORY = constants.O_DIRECTORY || 0;
const execFileAsync = promisify(execFile);
const SESSION_LEASE_LOCK_BUSY = Symbol('session-lease-lock-busy');
let cachedProcessStartSeconds = null;
let processStartLookup = null;

function ownedPrivate(info, expectedType) {
  if (!info[expectedType]()) return false;
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return false;
  return (info.mode & 0o077) === 0;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertSessionId(sessionId) {
  if (!UUID_RE.test(sessionId || '')) throw new Error('Invalid recovery session id.');
}

async function openPrivateFile(path) {
  const before = await lstat(path);
  if (!ownedPrivate(before, 'isFile')) throw new Error('Untrusted file.');
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!ownedPrivate(info, 'isFile')
        || !sameIdentity(info, before)) {
      throw new Error('File identity changed.');
    }
    return { handle, info };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

async function openPrivateDirectory(path) {
  const before = await lstat(path);
  if (!ownedPrivate(before, 'isDirectory')) throw new Error('Untrusted directory.');
  const handle = await open(path, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!ownedPrivate(info, 'isDirectory')
        || !sameIdentity(info, before)) {
      throw new Error('Directory identity changed.');
    }
    return { handle, info };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

export async function readPrivateJson(path) {
  const { handle } = await openPrivateFile(path);
  try {
    return JSON.parse(await handle.readFile({ encoding: 'utf8' }));
  } finally {
    await handle.close();
  }
}

function isConversationRecord(record) {
  return record?.type === 'user'
    || (record?.type === 'assistant' && record.isApiErrorMessage !== true);
}

function pathInside(path, root) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
}

function recordTimestampMs(record) {
  const value = record?.timestamp;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

async function unresolvedApiError(path, transcriptRoot, sessionId, recoverableKinds) {
  try {
    const original = await lstat(path);
    if (!original.isFile()) return false;
    const [resolvedPath, resolvedRoot] = await Promise.all([
      realpath(path),
      realpath(transcriptRoot),
    ]);
    if (!pathInside(resolvedPath, resolvedRoot)) return false;
    if (basename(resolvedPath) !== `${sessionId}.jsonl`) return false;

    const { handle, info } = await openPrivateFile(resolvedPath);
    try {
      if (await realpath(path) !== resolvedPath) return false;
      const start = Math.max(0, info.size - 256 * 1024);
      const buffer = Buffer.alloc(info.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      let blocked = null;
      for (const line of buffer.toString('utf8').split('\n')) {
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        const event = classifyClaudeApiErrorRecord(record);
        if (event && recoverableKinds.has(event.kind)) {
          blocked = {
            kind: event.kind,
            retryAfterSeconds: event.retryAfterSeconds ?? null,
            timestampMs: recordTimestampMs(record),
          };
        }
        else if (blocked && isConversationRecord(record)) blocked = null;
      }
      return blocked;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function unresolvedApiErrorKind(path, transcriptRoot, sessionId, recoverableKinds) {
  return (await unresolvedApiError(path, transcriptRoot, sessionId, recoverableKinds))?.kind || false;
}

export function hasUnresolvedLoginExpired(path, transcriptRoot, sessionId) {
  return unresolvedApiErrorKind(path, transcriptRoot, sessionId, new Set(['login_expired']))
    .then(Boolean);
}

export function unresolvedRecoverableApiErrorKind(path, transcriptRoot, sessionId) {
  return unresolvedApiErrorKind(
    path,
    transcriptRoot,
    sessionId,
    new Set(['login_expired', 'connection_lost', 'ambiguous_connection', 'ambiguous_dispatch', 'fleet_exhausted']),
  );
}

export function unresolvedRecoverableApiErrorState(path, transcriptRoot, sessionId) {
  return unresolvedApiError(
    path,
    transcriptRoot,
    sessionId,
    new Set(['login_expired', 'connection_lost', 'ambiguous_connection', 'ambiguous_dispatch', 'fleet_exhausted']),
  );
}

export function hasUnresolvedRecoverableApiError(path, transcriptRoot, sessionId) {
  return unresolvedRecoverableApiErrorKind(path, transcriptRoot, sessionId).then(Boolean);
}

function activeSessionId(store, surfaceId) {
  return store?.activeSessionsBySurface?.[surfaceId]?.sessionId || null;
}

export function validSession(store, session) {
  return session?.isRestorable === true
    && UUID_RE.test(session.sessionId || '')
    && SURFACE_RE.test(session.surfaceId || '')
    && UUID_RE.test(session.workspaceId || '')
    && Number.isInteger(session.pid)
    && session.pid > 0
    && Number.isFinite(session.startedAt)
    && typeof session.cwd === 'string'
    && typeof session.transcriptPath === 'string'
    && session.launchCommand?.launcher === 'claude'
    && typeof session.launchCommand.executablePath === 'string'
    && typeof session.launchCommand.workingDirectory === 'string'
    && activeSessionId(store, session.surfaceId) === session.sessionId;
}
export async function resolveCmuxSessionId({
  storePath,
  surfaceId,
  pid,
  cwd,
  inspectProcess = defaultInspectClaudeProcess,
  startTimeToleranceSeconds = 5,
}) {
  if (typeof storePath !== 'string'
      || !SURFACE_RE.test(surfaceId || '')
      || !Number.isInteger(pid)
      || pid <= 0
      || typeof cwd !== 'string') {
    return null;
  }
  let store;
  try {
    store = await readPrivateJson(storePath);
  } catch {
    return null;
  }
  const sessionId = activeSessionId(store, surfaceId);
  const session = sessionId && store?.sessions?.[sessionId];
  if (!validSession(store, session)
      || session.surfaceId !== surfaceId
      || session.pid !== pid
      || session.launchCommand?.launcher !== 'claude') return null;
  let processInfo;
  try {
    processInfo = await inspectProcess(pid);
  } catch {
    return null;
  }
  const [callerCwd, launchCwd, processCwd, processLaunchCwd,
    processLaunchExecutable, sessionExecutable] = await Promise.all([
    realpath(cwd).catch(() => null),
    realpath(session.launchCommand.workingDirectory).catch(() => null),
    realpath(processInfo?.cwd || '').catch(() => null),
    realpath(processInfo?.launchCwd || '').catch(() => null),
    realpath(processInfo?.launchArgv?.[0] || '').catch(() => null),
    realpath(session.launchCommand.executablePath).catch(() => null),
  ]);
  const tolerance = Number.isFinite(startTimeToleranceSeconds)
    ? Math.max(0, startTimeToleranceSeconds)
    : 5;
  return processInfo?.alive === true
    && processInfo.pid === pid
    && processInfo.surfaceId === surfaceId
    && processInfo.agentLaunchKind === 'claude'
    && processInfo.supervised === false
    && processInfo.environmentValid === true
    && isTeamClaudeSupervisor(processInfo)
    && Array.isArray(processInfo.launchArgv)
    && processInfo.launchArgv.length > 0
    && callerCwd !== null
    && callerCwd === launchCwd
    && launchCwd === processCwd
    && launchCwd === processLaunchCwd
    && processLaunchExecutable !== null
    && processLaunchExecutable === sessionExecutable
    && Number.isFinite(processInfo.processStartedAt)
    && Number.isFinite(session.pidStartSeconds)
    && Math.abs(processInfo.processStartedAt - session.pidStartSeconds) <= tolerance
    ? session.sessionId
    : null;
}

export {
  inspectClaudeProcess,
  inspectClaudeProcessTree,
  resolveTrustedClaudePath,
  sameClaudeProcess,
} from './cmux-process-guard.js';

export async function claimSessionOnce(
  storePath,
  sessionId,
  { syncDirectory = handle => handle.sync() } = {},
) {
  assertSessionId(sessionId);
  const claimDir = `${storePath}.recovery-claims`;
  await mkdir(claimDir, { recursive: true, mode: 0o700 });
  const { handle: directoryHandle, info: directoryInfo } =
    await openPrivateDirectory(claimDir);
  let handle;
  try {
    handle = await open(
      join(claimDir, sessionId),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${Date.now()}\n`);
    await handle.sync();
    await syncDirectory(directoryHandle);
    let currentDirectory;
    let currentClaim;
    let claimInfo;
    try {
      [currentDirectory, currentClaim, claimInfo] = await Promise.all([
        lstat(claimDir),
        lstat(join(claimDir, sessionId)),
        handle.stat(),
      ]);
    } catch {
      throw new Error('Recovery claim identity changed.');
    }
    if (!ownedPrivate(currentDirectory, 'isDirectory')
        || !sameIdentity(currentDirectory, directoryInfo)
        || !ownedPrivate(currentClaim, 'isFile')
        || !sameIdentity(currentClaim, claimInfo)) {
      throw new Error('Recovery claim identity changed.');
    }
    return { dev: claimInfo.dev, ino: claimInfo.ino };
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    await handle?.close();
    await directoryHandle.close();
  }
}

export async function releaseSessionClaim(storePath, sessionId, expectedIdentity = null) {
  assertSessionId(sessionId);
  const claimDir = `${storePath}.recovery-claims`;
  let directoryHandle;
  try {
    const directory = await openPrivateDirectory(claimDir);
    directoryHandle = directory.handle;
    const claimPath = join(claimDir, sessionId);
    const claimInfo = await lstat(claimPath);
    if (!ownedPrivate(claimInfo, 'isFile')) {
      throw new Error('Untrusted recovery claim.');
    }
    if (expectedIdentity
        && !sameIdentity(claimInfo, expectedIdentity)) return false;
    await unlink(claimPath);
    await directoryHandle.sync();
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  } finally {
    await directoryHandle?.close();
  }
}

async function inspectProcessStartSeconds(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-p', String(pid), '-o', 'lstart='],
      { timeout: 1500, env: { ...process.env, LC_ALL: 'C' } },
    );
    const value = new Date(stdout.trim()).getTime() / 1000;
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function inspectOwnProcessStart(inspectProcessStart) {
  if (inspectProcessStart !== inspectProcessStartSeconds) {
    return inspectProcessStart(process.pid);
  }
  if (Number.isFinite(cachedProcessStartSeconds)) return cachedProcessStartSeconds;
  if (!processStartLookup) {
    processStartLookup = inspectProcessStartSeconds(process.pid)
      .then(value => {
        if (Number.isFinite(value)) cachedProcessStartSeconds = value;
        return value;
      })
      .finally(() => {
        processStartLookup = null;
      });
  }
  return processStartLookup;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function leaseOwnerAlive(owner, inspectProcessStart = inspectProcessStartSeconds) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0
      || !Number.isFinite(owner.processStartSeconds)) return false;
  if (!processAlive(owner.pid)) return false;
  let actualStart;
  try {
    actualStart = await inspectProcessStart(owner.pid);
  } catch {
    // An alive owner whose identity cannot be checked is still treated as
    // owning the lease. Reclaiming it would allow a duplicate recovery.
    return true;
  }
  if (!Number.isFinite(actualStart)) return true;
  return Math.abs(actualStart - owner.processStartSeconds) <= 2;
}

async function readLeaseOwner(path) {
  const { handle, info } = await openPrivateFile(path);
  try {
    const value = JSON.parse(await handle.readFile({ encoding: 'utf8' }));
    if (!value || typeof value !== 'object' || value.version !== 1
        || !Number.isInteger(value.pid) || value.pid <= 0
        || !Number.isFinite(value.processStartSeconds)
        || typeof value.nonce !== 'string' || value.nonce.length === 0) {
      throw new Error('Invalid recovery lease.');
    }
    return {
      value,
      identity: { dev: info.dev, ino: info.ino },
    };
  } finally {
    await handle.close();
  }
}

async function readLeaseOwnerHint(path) {
  const { handle, info } = await openPrivateFile(path);
  try {
    try {
      return {
        value: JSON.parse(await handle.readFile({ encoding: 'utf8' })),
        identity: { dev: info.dev, ino: info.ino },
      };
    } catch {
      return null;
    }
  } finally {
    await handle.close();
  }
}

async function createPrivateJsonExclusive(path, value) {
  const tempPath = `${path}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await link(tempPath, path);
    const info = await handle.stat();
    await handle.close();
    handle = null;
    await unlink(tempPath);
    return info;
  } finally {
    await handle?.close();
    try {
      await unlink(tempPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function malformedLeaseError(error) {
  return error instanceof SyntaxError || error?.message === 'Invalid recovery lease.';
}

const SESSION_LEASE_CLAIM_RETRIES = 240;
const SESSION_LEASE_RELEASE_RETRIES = 2400;

async function quarantineMalformedLease(path) {
  const info = await lstat(path);
  if (!ownedPrivate(info, 'isFile')) throw new Error('Untrusted recovery lease.');
  const quarantinePath = `${path}.corrupt-${randomUUID()}`;
  await rename(path, quarantinePath);
  const moved = await lstat(quarantinePath);
  if (!sameIdentity(info, moved)) throw new Error('Recovery lease identity changed.');
  return quarantinePath;
}

// A loopback listener is a kernel-owned mutex: exit/SIGKILL releases it without
// another stale lock file to reclaim. Hash collisions only defer recovery; they
// never grant two writers ownership. All on-disk lease mutations use this lock.
async function withSessionLeaseLock(leaseDir, sessionId, action, retries = 0) {
  const key = `${await realpath(leaseDir)}/${sessionId}`;
  const port = 20000 + createHash('sha256').update(key).digest().readUInt32BE(0) % 20000;
  for (let attempt = 0; ; attempt += 1) {
    const mutex = createServer(socket => socket.destroy());
    const acquired = await new Promise((resolve, reject) => {
      mutex.once('error', error => {
        if (error.code === 'EADDRINUSE') resolve(false);
        else reject(error);
      });
      mutex.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(true));
    });
    if (!acquired) {
      if (attempt >= retries) return SESSION_LEASE_LOCK_BUSY;
      await new Promise(resolve => setTimeout(resolve, 25));
      continue;
    }
    try {
      return await action();
    } finally {
      await new Promise((resolve, reject) => mutex.close(error => error ? reject(error) : resolve()));
    }
  }
}

/** A transient lease separate from the permanent replay claim. */
export async function claimSessionLease(
  storePath,
  sessionId,
  {
    syncDirectory = handle => handle.sync(),
    inspectProcessStart = inspectProcessStartSeconds,
  } = {},
) {
  assertSessionId(sessionId);
  const leaseDir = `${storePath}.recovery-leases`;
  await mkdir(leaseDir, { recursive: true, mode: 0o700 });
  const { handle: directoryHandle, info: directoryInfo } =
    await openPrivateDirectory(leaseDir);
  const leasePath = join(leaseDir, sessionId);
  try {
    const ownStart = await inspectOwnProcessStart(inspectProcessStart);
    if (!Number.isFinite(ownStart)) {
      throw new Error('Unable to establish the recovery lease owner identity.');
    }
    const result = await withSessionLeaseLock(leaseDir, sessionId, async () => {
      try {
        const { value: owner, identity } = await readLeaseOwner(leasePath);
        if (await leaseOwnerAlive(owner, inspectProcessStart)) return false;
        const stale = await lstat(leasePath);
        if (!ownedPrivate(stale, 'isFile') || !sameIdentity(stale, identity)) return false;
        await unlink(leasePath);
      } catch (error) {
        if (error.code === 'ENOENT') {
          // The lease was released between the read and the stale check.
        } else if (malformedLeaseError(error)) {
          const hint = await readLeaseOwnerHint(leasePath).catch(() => null);
          if (hint && await leaseOwnerAlive(hint.value, inspectProcessStart)) return false;
          await quarantineMalformedLease(leasePath);
          // A malformed record has no trustworthy owner identity. Quarantine
          // it for diagnosis, but fail closed for this recovery attempt rather
          // than granting a second actor ownership of the session.
          return false;
        } else {
          throw error;
        }
      }
      const leaseInfo = await createPrivateJsonExclusive(leasePath, {
        version: 1,
        pid: process.pid,
        processStartSeconds: ownStart,
        nonce: randomUUID(),
        createdAt: Date.now(),
      });
      await syncDirectory(directoryHandle);
      const [currentDirectory, currentLease] = await Promise.all([
        lstat(leaseDir),
        lstat(leasePath),
      ]);
      if (!ownedPrivate(currentDirectory, 'isDirectory')
          || !sameIdentity(currentDirectory, directoryInfo)
          || !ownedPrivate(currentLease, 'isFile')
          || !sameIdentity(currentLease, leaseInfo)) {
        throw new Error('Recovery lease identity changed.');
      }
      const owner = await readLeaseOwner(leasePath);
      return {
        dev: leaseInfo.dev,
        ino: leaseInfo.ino,
        pid: process.pid,
        processStartSeconds: ownStart,
        nonce: owner.value.nonce,
      };
    }, SESSION_LEASE_CLAIM_RETRIES);
    return result === SESSION_LEASE_LOCK_BUSY ? null : result;
  } finally {
    await directoryHandle.close();
  }
}

export async function releaseSessionLease(storePath, sessionId, expectedIdentity = null) {
  assertSessionId(sessionId);
  if (!expectedIdentity) return false;
  const leaseDir = `${storePath}.recovery-leases`;
  let directoryHandle;
  try {
    const directory = await openPrivateDirectory(leaseDir);
    directoryHandle = directory.handle;
    const result = await withSessionLeaseLock(leaseDir, sessionId, async () => {
      const leasePath = join(leaseDir, sessionId);
      const owner = await readLeaseOwner(leasePath);
      if (!sameIdentity(owner.identity, expectedIdentity)
          || owner.value.pid !== expectedIdentity.pid
          || owner.value.processStartSeconds !== expectedIdentity.processStartSeconds
          || owner.value.nonce !== expectedIdentity.nonce) return false;
      await unlink(leasePath);
      await directoryHandle.sync();
      return true;
    }, SESSION_LEASE_RELEASE_RETRIES);
    return result === SESSION_LEASE_LOCK_BUSY ? null : result;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  } finally {
    await directoryHandle?.close();
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

export function buildResumeCommand({
  cwd,
  sessionId,
  nodePath,
  scriptPath,
  configPath,
  continueLastPrompt = true,
}) {
  const config = configPath
    ? `TEAMCLAUDE_CONFIG=${shellQuote(configPath)} `
    : '';
  const prompt = continueLastPrompt ? ' continue' : '';
  return `cd -- ${shellQuote(cwd)} && ${config}${shellQuote(nodePath)} ${shellQuote(scriptPath)} run -- --resume ${shellQuote(sessionId)}${prompt}`;
}
