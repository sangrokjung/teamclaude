import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
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

function processStartSeconds() {
  return (Date.now() - process.uptime() * 1000) / 1000;
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

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function leaseOwnerAlive(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0
      || !Number.isFinite(owner.processStartSeconds)) return false;
  if (!processAlive(owner.pid)) return false;
  const actualStart = await inspectProcessStartSeconds(owner.pid);
  return Number.isFinite(actualStart)
    && Math.abs(actualStart - owner.processStartSeconds) <= 2;
}

async function readLeaseOwner(path) {
  const { handle } = await openPrivateFile(path);
  try {
    const value = JSON.parse(await handle.readFile({ encoding: 'utf8' }));
    if (!value || typeof value !== 'object' || value.version !== 1) {
      throw new Error('Invalid recovery lease.');
    }
    return value;
  } finally {
    await handle.close();
  }
}

/**
 * A transient cross-process lease. It deliberately lives in a different
 * directory from the permanent replay claim so a successful cmux rescue does
 * not suppress a later launcher retry in the same session.
 */
export async function claimSessionLease(
  storePath,
  sessionId,
  {
    syncDirectory = handle => handle.sync(),
  } = {},
) {
  assertSessionId(sessionId);
  const leaseDir = `${storePath}.recovery-leases`;
  await mkdir(leaseDir, { recursive: true, mode: 0o700 });
  const { handle: directoryHandle, info: directoryInfo } =
    await openPrivateDirectory(leaseDir);
  const leasePath = join(leaseDir, sessionId);
  try {
    try {
      const owner = await readLeaseOwner(leasePath);
      if (owner && await leaseOwnerAlive(owner)) return false;
      const stale = await lstat(leasePath);
      if (!ownedPrivate(stale, 'isFile')) throw new Error('Untrusted recovery lease.');
      await unlink(leasePath);
      await syncDirectory(directoryHandle);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    let handle;
    try {
      handle = await open(
        leasePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
        0o600,
      );
      await handle.writeFile(JSON.stringify({
        version: 1,
        pid: process.pid,
        processStartSeconds: processStartSeconds(),
        createdAt: Date.now(),
      }));
      await handle.sync();
      await syncDirectory(directoryHandle);
      const [currentDirectory, currentLease, leaseInfo] = await Promise.all([
        lstat(leaseDir),
        lstat(leasePath),
        handle.stat(),
      ]);
      if (!ownedPrivate(currentDirectory, 'isDirectory')
          || !sameIdentity(currentDirectory, directoryInfo)
          || !ownedPrivate(currentLease, 'isFile')
          || !sameIdentity(currentLease, leaseInfo)) {
        throw new Error('Recovery lease identity changed.');
      }
      return {
        dev: leaseInfo.dev,
        ino: leaseInfo.ino,
        pid: process.pid,
        processStartSeconds: processStartSeconds(),
      };
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    } finally {
      await handle?.close();
    }
  } finally {
    await directoryHandle.close();
  }
}

export async function releaseSessionLease(storePath, sessionId, expectedIdentity = null) {
  assertSessionId(sessionId);
  const leaseDir = `${storePath}.recovery-leases`;
  let directoryHandle;
  try {
    const directory = await openPrivateDirectory(leaseDir);
    directoryHandle = directory.handle;
    const leasePath = join(leaseDir, sessionId);
    const leaseInfo = await lstat(leasePath);
    if (!ownedPrivate(leaseInfo, 'isFile')) throw new Error('Untrusted recovery lease.');
    if (expectedIdentity && !sameIdentity(leaseInfo, expectedIdentity)) return false;
    await unlink(leasePath);
    await directoryHandle.sync();
    return true;
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
