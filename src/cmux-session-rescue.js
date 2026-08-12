import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  buildResumeCommand,
  claimSessionOnce,
  hasUnresolvedRecoverableApiError,
  inspectClaudeProcess,
  readPrivateJson,
  resolveTrustedClaudePath,
  sameClaudeProcess,
  unresolvedRecoverableApiErrorKind,
  validSession,
} from './cmux-session-guards.js';

const execFileAsync = promisify(execFile);

function sessions(store) {
  return store?.sessions && typeof store.sessions === 'object'
    ? Object.values(store.sessions)
    : [];
}

export function resolveRecoveryWindowId(tree, { surfaceId, workspaceId }) {
  const matches = [];
  for (const window of tree?.windows || []) {
    for (const workspace of window?.workspaces || []) {
      for (const pane of workspace?.panes || []) {
        if (pane?.surfaces?.some(surface => surface?.id === surfaceId)) {
          matches.push({ windowId: window.id, workspaceId: workspace.id });
        }
      }
    }
  }
  return matches.length === 1 && matches[0].workspaceId === workspaceId
    ? matches[0].windowId
    : null;
}

async function defaultLaunchRecoveryWorkspace({
  workspaceId,
  surfaceId,
  cwd,
  sessionId,
  command,
}) {
  const { stdout } = await execFileAsync('cmux', ['rpc', 'system.tree', '{}'], {
    timeout: 3000,
  });
  const tree = JSON.parse(stdout);
  const windowId = resolveRecoveryWindowId(tree, { surfaceId, workspaceId });
  if (typeof windowId !== 'string') {
    throw new Error('Unable to resolve the cmux window for the blocked session.');
  }
  await execFileAsync('cmux', [
    'new-workspace',
    '--window',
    windowId,
    '--name',
    `Recovered Claude ${sessionId.slice(0, 8)}`,
    '--cwd',
    cwd,
    '--command',
    command,
    '--focus',
    'false',
  ], {
    timeout: 5000,
  });
}

async function defaultReadStore(path) {
  return readPrivateJson(path);
}

export async function rescueCmuxSessionsOnce({
  storePath,
  transcriptRoot,
  nodePath,
  scriptPath,
  configPath = null,
  attempted = new Set(),
  readStore = defaultReadStore,
  inspectProcess = inspectClaudeProcess,
  launchRecoveryWorkspace = defaultLaunchRecoveryWorkspace,
  claimRecovery = claimSessionOnce,
  trustedClaudePath = null,
}) {
  let store;
  try {
    store = await readStore(storePath);
  } catch {
    return { scanned: 0, candidates: 0, rescued: 0, failed: 0 };
  }

  if (!trustedClaudePath && inspectProcess === inspectClaudeProcess) {
    try {
      trustedClaudePath = await resolveTrustedClaudePath();
    } catch {
      return { scanned: 0, candidates: 0, rescued: 0, failed: 0 };
    }
  }

  let candidates = 0;
  let rescued = 0;
  let failed = 0;
  const currentSessions = sessions(store);
  for (const session of currentSessions) {
    if (!validSession(store, session)) continue;
    if (!await hasUnresolvedRecoverableApiError(
      session.transcriptPath,
      transcriptRoot,
      session.sessionId,
    )) continue;
    candidates += 1;
    const key = session.sessionId;
    if (attempted.has(key)) continue;

    let freshStore;
    try {
      freshStore = await readStore(storePath);
    } catch {
      continue;
    }
    const fresh = sessions(freshStore).find(item => item?.sessionId === session.sessionId);
    if (!fresh
        || fresh.pid !== session.pid
        || fresh.workspaceId !== session.workspaceId
        || !validSession(freshStore, fresh)) continue;
    if (!await hasUnresolvedRecoverableApiError(
      fresh.transcriptPath,
      transcriptRoot,
      fresh.sessionId,
    )) continue;

    const first = await inspectProcess(fresh.pid);
    if (!await sameClaudeProcess(fresh, first, trustedClaudePath)) continue;
    const second = await inspectProcess(fresh.pid);
    if (!await sameClaudeProcess(
      fresh,
      second,
      trustedClaudePath,
      first.processIdentity,
    )) continue;

    let finalStore;
    try {
      finalStore = await readStore(storePath);
    } catch {
      continue;
    }
    const final = sessions(finalStore).find(item => item?.sessionId === fresh.sessionId);
    if (!final
        || final.pid !== fresh.pid
        || final.workspaceId !== fresh.workspaceId
        || !validSession(finalStore, final)) continue;
    const finalFailureKind = await unresolvedRecoverableApiErrorKind(
      final.transcriptPath,
      transcriptRoot,
      final.sessionId,
    );
    if (!finalFailureKind) continue;
    const finalInfo = await inspectProcess(final.pid);
    if (!await sameClaudeProcess(
      final,
      finalInfo,
      trustedClaudePath,
      first.processIdentity,
    )) continue;

    const command = buildResumeCommand({
      cwd: final.cwd,
      sessionId: final.sessionId,
      nodePath,
      scriptPath,
      configPath,
      continueLastPrompt: !['ambiguous_connection', 'ambiguous_dispatch'].includes(finalFailureKind),
    });
    try {
      if (!await claimRecovery(storePath, key)) {
        attempted.add(key);
        continue;
      }
      attempted.add(key);
      await launchRecoveryWorkspace({
        workspaceId: final.workspaceId,
        surfaceId: final.surfaceId,
        cwd: final.cwd,
        sessionId: final.sessionId,
        command,
      });
      rescued += 1;
    } catch {
      failed += 1;
    }
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
          log(`[TeamClaude] Continued ${result.rescued} blocked Claude session(s) in new supervised cmux workspaces.`);
        }
        if (result.failed > 0) {
          log(`[TeamClaude] Cmux recovery workspace launch was uncertain for ${result.failed} blocked Claude session(s); not replaying in this supervisor run.`);
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
