import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, delimiter, join, relative } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SURFACE_RE = /^(?:surface:\d+|[0-9a-f-]{36})$/i;
const SUPERVISED_MARKER = 'TEAMCLAUDE_SESSION_SUPERVISED=1';
const LOGIN_EXPIRED = 'Login expired · Please run /login';
const NOFOLLOW = constants.O_NOFOLLOW || 0;

function ownedPrivate(info, expectedType) {
  if (!info[expectedType]()) return false;
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return false;
  return (info.mode & 0o077) === 0;
}

async function openPrivateFile(path) {
  const before = await lstat(path);
  if (!ownedPrivate(before, 'isFile')) throw new Error('Untrusted file.');
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!ownedPrivate(info, 'isFile')
        || info.dev !== before.dev
        || info.ino !== before.ino) {
      throw new Error('File identity changed.');
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

export async function inspectClaudeProcess(pid) {
  try {
    process.kill(pid, 0);
    const [
      { stdout: command },
      { stdout: environment },
      { stdout: cwdOutput },
      { stdout: startedAt },
    ] = await Promise.all([
      execFileAsync('ps', ['-p', String(pid), '-o', 'command='], { timeout: 1500 }),
      execFileAsync('ps', ['eww', '-p', String(pid), '-o', 'command='], { timeout: 1500 }),
      execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 1500 }),
      execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 1500 }),
    ]);
    const processCommand = command.trim();
    const executablePath = processCommand.split(/\s+/)[0] || '';
    const cwd = cwdOutput.split('\n').find(line => line.startsWith('n'))?.slice(1) || '';
    const surfaceId = environment.match(/(?:^|\s)CMUX_SURFACE_ID=([^\s]+)/)?.[1] || null;
    return {
      alive: true,
      command: processCommand,
      cwd,
      executablePath,
      processIdentity: `${pid}:${startedAt.trim()}`,
      processStartedAt: new Date(startedAt.trim()).getTime() / 1000,
      surfaceId,
      supervised: environment.includes(SUPERVISED_MARKER),
    };
  } catch {
    return { alive: false };
  }
}

function selectorMatches(command, sessionId) {
  const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:^|\\s)--(?:resume|session-id)(?:=|\\s+)${escaped}(?=\\s|$)`,
  ).test(command);
}

export async function sameClaudeProcess(
  session,
  info,
  trustedClaudePath = null,
  expectedIdentity = null,
) {
  const startDelta = session?.startedAt - info?.processStartedAt;
  if (!info?.alive
      || info.supervised
      || info.surfaceId !== session.surfaceId
      || typeof info.processIdentity !== 'string'
      || !info.processIdentity
      || (expectedIdentity && info.processIdentity !== expectedIdentity)
      || !selectorMatches(info.command || '', session.sessionId)
      || !Number.isFinite(startDelta)
      || startDelta < -2
      || startDelta > 60) {
    return false;
  }
  try {
    const [
      processExecutable,
      launchExecutable,
      trustedExecutable,
      processCwd,
      sessionCwd,
    ] = await Promise.all([
      realpath(info.executablePath),
      realpath(session.launchCommand.executablePath),
      realpath(trustedClaudePath || session.launchCommand.executablePath),
      realpath(info.cwd),
      realpath(session.cwd),
    ]);
    return processExecutable === trustedExecutable
      && launchExecutable === trustedExecutable
      && processCwd === sessionCwd;
  } catch {
    return false;
  }
}

export async function resolveTrustedClaudePath() {
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, 'claude');
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {}
  }
  throw new Error('Unable to resolve the trusted Claude executable.');
}

export async function claimSessionOnce(storePath, sessionId) {
  const claimDir = `${storePath}.recovery-claims`;
  await mkdir(claimDir, { recursive: true, mode: 0o700 });
  const dirInfo = await lstat(claimDir);
  if (!ownedPrivate(dirInfo, 'isDirectory')) {
    throw new Error('Untrusted recovery claim directory.');
  }

  let handle;
  try {
    handle = await open(
      join(claimDir, sessionId),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${Date.now()}\n`);
    await handle.sync();
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    await handle?.close();
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
