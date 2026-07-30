import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SURFACE_RE = /^(?:surface:\d+|[0-9a-f-]{36})$/i;
const LOGIN_EXPIRED = 'Login expired · Please run /login';
const NOFOLLOW = constants.O_NOFOLLOW || 0;
const DIRECTORY = constants.O_DIRECTORY || 0;

function ownedPrivate(info, expectedType) {
  if (!info[expectedType]()) return false;
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return false;
  return (info.mode & 0o077) === 0;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
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

function textContent(record) {
  const content = typeof record?.message === 'string'
    ? record.message
    : record?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

function isLoginExpired(record) {
  return record?.isApiErrorMessage === true
    && record.error === 'authentication_failed'
    && textContent(record).trim().replace(/\s+/g, ' ') === LOGIN_EXPIRED;
}

function isConversationRecord(record) {
  return record?.type === 'user'
    || (record?.type === 'assistant' && record.isApiErrorMessage !== true);
}

function pathInside(path, root) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
}

export async function hasUnresolvedLoginExpired(path, transcriptRoot, sessionId) {
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
      let blocked = false;
      for (const line of buffer.toString('utf8').split('\n')) {
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (isLoginExpired(record)) blocked = true;
        else if (blocked && isConversationRecord(record)) blocked = false;
      }
      return blocked;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
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
    && activeSessionId(store, session.surfaceId) === session.sessionId;
}

export {
  inspectClaudeProcess,
  resolveTrustedClaudePath,
  sameClaudeProcess,
} from './cmux-process-guard.js';

export async function claimSessionOnce(
  storePath,
  sessionId,
  { syncDirectory = handle => handle.sync() } = {},
) {
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
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    await handle?.close();
    await directoryHandle.close();
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

export function buildResumeCommand({ cwd, sessionId, nodePath, scriptPath, configPath }) {
  const config = configPath
    ? `TEAMCLAUDE_CONFIG=${shellQuote(configPath)} `
    : '';
  return `cd -- ${shellQuote(cwd)} && ${config}${shellQuote(nodePath)} ${shellQuote(scriptPath)} run -- --resume ${shellQuote(sessionId)} continue`;
}
