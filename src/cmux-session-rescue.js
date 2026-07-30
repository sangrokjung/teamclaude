import { execFile } from 'node:child_process';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SURFACE_RE = /^(?:surface:\d+|[0-9a-f-]{36})$/i;
const SUPERVISED_MARKER = 'TEAMCLAUDE_SESSION_SUPERVISED=1';
const LOGIN_EXPIRED = 'Login expired · Please run /login';

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
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

async function readTail(path, maxBytes = 256 * 1024) {
  const info = await stat(path);
  if (!info.isFile()) return '';
  const start = Math.max(0, info.size - maxBytes);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(info.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function pathInside(path, root) {
  const [resolvedPath, resolvedRoot] = await Promise.all([
    realpath(path),
    realpath(root),
  ]);
  const rel = relative(resolvedRoot, resolvedPath);
  return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
}

async function hasUnresolvedLoginExpired(path, transcriptRoot) {
  try {
    if (!await pathInside(path, transcriptRoot)) return false;
    const tail = await readTail(path);
    let blocked = false;
    for (const line of tail.split('\n')) {
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
  } catch {
    return false;
  }
}

function sessions(store) {
  return store?.sessions && typeof store.sessions === 'object'
    ? Object.values(store.sessions)
    : [];
}

function activeSessionId(store, surfaceId) {
  return store?.activeSessionsBySurface?.[surfaceId]?.sessionId || null;
}

function validSession(store, session) {
  return session?.isRestorable === true
    && UUID_RE.test(session.sessionId || '')
    && SURFACE_RE.test(session.surfaceId || '')
    && Number.isInteger(session.pid)
    && session.pid > 0
    && typeof session.cwd === 'string'
    && typeof session.transcriptPath === 'string'
    && session.launchCommand?.launcher === 'claude'
    && typeof session.launchCommand.executablePath === 'string'
    && activeSessionId(store, session.surfaceId) === session.sessionId;
}

async function defaultInspectProcess(pid) {
  try {
    process.kill(pid, 0);
    const [{ stdout: command }, { stdout: environment }, { stdout: cwdOutput }] = await Promise.all([
      execFileAsync('ps', ['-p', String(pid), '-o', 'command='], { timeout: 1500 }),
      execFileAsync('ps', ['eww', '-p', String(pid), '-o', 'command='], { timeout: 1500 }),
      execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 1500 }),
    ]);
    const executablePath = command.trim().split(/\s+/)[0] || '';
    const cwd = cwdOutput.split('\n').find(line => line.startsWith('n'))?.slice(1) || '';
    const surfaceId = environment.match(/(?:^|\s)CMUX_SURFACE_ID=([^\s]+)/)?.[1] || null;
    return {
      alive: true,
      cwd,
      executablePath,
      surfaceId,
      supervised: environment.includes(SUPERVISED_MARKER),
    };
  } catch {
    return { alive: false };
  }
}

async function sameProcess(session, info) {
  if (!info?.alive || info.supervised || info.surfaceId !== session.surfaceId) return false;
  try {
    const [processExecutable, launchExecutable, processCwd, sessionCwd] = await Promise.all([
      realpath(info.executablePath),
      realpath(session.launchCommand.executablePath),
      realpath(info.cwd),
      realpath(session.cwd),
    ]);
    return processExecutable === launchExecutable && processCwd === sessionCwd;
  } catch {
    return false;
  }
}

async function defaultTerminateProcess(pid, timeoutMs = 5000) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await delay(50);
  }
  return false;
}

function buildResumeCommand({ cwd, sessionId, nodePath, scriptPath, configPath }) {
  const config = configPath
    ? `TEAMCLAUDE_CONFIG=${shellQuote(configPath)} `
    : '';
  return `cd -- ${shellQuote(cwd)} && ${config}${shellQuote(nodePath)} ${shellQuote(scriptPath)} run -- --resume ${shellQuote(sessionId)} continue`;
}

async function defaultSendResume({ surfaceId, command }) {
  await execFileAsync('cmux', ['send', '--surface', surfaceId, `${command}\\n`], {
    timeout: 5000,
  });
}

async function defaultReadStore(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function rescueCmuxSessionsOnce({
  storePath,
  transcriptRoot,
  nodePath,
  scriptPath,
  configPath = null,
  attempted = new Set(),
  readStore = defaultReadStore,
  inspectProcess = defaultInspectProcess,
  terminateProcess = defaultTerminateProcess,
  sendResume = defaultSendResume,
}) {
  let store;
  try {
    store = await readStore(storePath);
  } catch {
    return { scanned: 0, candidates: 0, rescued: 0, failed: 0 };
  }

  let candidates = 0;
  let rescued = 0;
  let failed = 0;
  const currentSessions = sessions(store);
  for (const session of currentSessions) {
    if (!validSession(store, session)) continue;
    if (!await hasUnresolvedLoginExpired(session.transcriptPath, transcriptRoot)) continue;
    candidates += 1;
    const key = `${session.sessionId}:${session.pid}`;
    if (attempted.has(key)) continue;

    let freshStore;
    try {
      freshStore = await readStore(storePath);
    } catch {
      continue;
    }
    const fresh = sessions(freshStore).find(item => item?.sessionId === session.sessionId);
    if (!fresh || fresh.pid !== session.pid || !validSession(freshStore, fresh)) continue;
    if (!await hasUnresolvedLoginExpired(fresh.transcriptPath, transcriptRoot)) continue;

    const first = await inspectProcess(fresh.pid);
    if (!await sameProcess(fresh, first)) continue;
    const second = await inspectProcess(fresh.pid);
    if (!await sameProcess(fresh, second)) continue;
    if (!await terminateProcess(fresh.pid)) continue;

    attempted.add(key);
    const command = buildResumeCommand({
      cwd: fresh.cwd,
      sessionId: fresh.sessionId,
      nodePath,
      scriptPath,
      configPath,
    });
    let sent = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await sendResume({ surfaceId: fresh.surfaceId, command });
        sent = true;
        break;
      } catch {
        if (attempt < 2) await delay(200 * 2 ** attempt);
      }
    }
    if (sent) rescued += 1;
    else failed += 1;
  }
  return { scanned: currentSessions.length, candidates, rescued, failed };
}

export function createCmuxSessionRescuer({
  enabled,
  ready = () => true,
  intervalMs = 1000,
  log = message => console.error(message),
  ...options
}) {
  let timer = null;
  let scanPromise = null;
  const attempted = new Set();

  const scanNow = () => {
    if (!enabled || !ready()) {
      return Promise.resolve({ scanned: 0, candidates: 0, rescued: 0, failed: 0 });
    }
    if (scanPromise) return scanPromise;
    scanPromise = rescueCmuxSessionsOnce({ ...options, attempted })
      .then(result => {
        if (result.rescued > 0) {
          log(`[TeamClaude] Rescued ${result.rescued} blocked Claude session(s) under recovery supervision.`);
        }
        if (result.failed > 0) {
          log(`[TeamClaude] Failed to relaunch ${result.failed} blocked Claude session(s) in cmux.`);
        }
        return result;
      })
      .catch(err => {
        log(`[TeamClaude] Existing Claude session rescue failed: ${err.message}`);
        return { scanned: 0, candidates: 0, rescued: 0, failed: 0 };
      })
      .finally(() => {
        scanPromise = null;
      });
    return scanPromise;
  };

  return {
    scanNow,
    start() {
      if (!enabled || timer) return;
      void scanNow();
      const period = Number.isFinite(intervalMs)
        ? Math.max(500, Math.floor(intervalMs))
        : 1000;
      timer = setInterval(() => {
        void scanNow();
      }, period);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}

export function defaultCmuxRescuePaths() {
  return {
    storePath: join(homedir(), '.cmuxterm', 'claude-hook-sessions.json'),
    transcriptRoot: join(homedir(), '.claude', 'projects'),
  };
}
