import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  buildResumeCommand,
  claimSessionOnce,
  inspectClaudeProcess,
  inspectClaudeProcessTree,
  readPrivateJson,
  resolveTrustedClaudePath,
  sameClaudeProcess,
  unresolvedRecoverableApiErrorState,
  validSession,
} from './cmux-session-guards.js';

const execFileAsync = promisify(execFile);

const CMUX_BINARY_CANDIDATES = [
  '/opt/homebrew/bin/cmux',
  '/usr/local/bin/cmux',
  '/Applications/cmux.app/Contents/Resources/bin/cmux',
];

async function resolveCmuxBinary() {
  for (const candidate of CMUX_BINARY_CANDIDATES) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) {
      return candidate;
    }
  }
  throw new Error('Unable to resolve the cmux executable.');
}

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
  const cmuxBinary = await resolveCmuxBinary();
  const { stdout } = await execFileAsync(cmuxBinary, ['rpc', 'system.tree', '{}'], {
    timeout: 3000,
  });
  const tree = JSON.parse(stdout);
  const windowId = resolveRecoveryWindowId(tree, { surfaceId, workspaceId });
  if (typeof windowId !== 'string') {
    throw new Error('Unable to resolve the cmux window for the blocked session.');
  }
  await execFileAsync(cmuxBinary, [
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

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return !processAlive(pid);
}

async function stopExistingSessionProcess(
  info,
  parentPid,
  { inspectProcess = inspectClaudeProcess } = {},
) {
  const pids = [info?.pid, parentPid].filter(
    (pid, index, values) => Number.isInteger(pid) && pid > 0 && values.indexOf(pid) === index,
  );
  const expected = new Map([[info?.pid, info?.processIdentity]]);
  if (Number.isInteger(parentPid)) {
    expected.set(parentPid, info?.launcherProcessIdentity);
  }
  for (const pid of pids) {
    let current;
    try {
      current = await inspectProcess(pid);
    } catch {
      return false;
    }
    if (!current?.alive
        || current.processIdentity !== expected.get(pid)
        || (pid === info?.pid && current.parentPid !== parentPid)) {
      return false;
    }
    if (pid === parentPid && current.surfaceId !== info.surfaceId) return false;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  let stopped = true;
  for (const pid of pids) {
    if (!await waitForProcessExit(pid, 2500)) stopped = false;
  }
  if (!stopped) {
    for (const pid of pids) {
      if (!processAlive(pid)) continue;
      let current;
      try {
        current = await inspectProcess(pid);
      } catch {
        return false;
      }
      if (!current?.alive || current.processIdentity !== expected.get(pid)) return false;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    stopped = true;
    for (const pid of pids) {
      if (!await waitForProcessExit(pid, 750)) stopped = false;
    }
  }
  return stopped;
}

function fleetRetryStillActive(state, now = Date.now()) {
  if (state?.kind !== 'fleet_exhausted') return false;
  if (!Number.isSafeInteger(state.retryAfterSeconds)
      || state.retryAfterSeconds <= 0
      || !Number.isSafeInteger(state.timestampMs)
      || state.timestampMs < 0) return true;
  const deadline = state.timestampMs + state.retryAfterSeconds * 1000;
  if (!Number.isSafeInteger(deadline)) return true;
  return now < deadline;
}

function sameRegistrySession(left, right) {
  return left?.sessionId === right?.sessionId
    && left?.pid === right?.pid
    && left?.workspaceId === right?.workspaceId;
}

export async function rescueCmuxSessionsOnce({
  storePath,
  transcriptRoot,
  nodePath,
  scriptPath,
  configPath = null,
  attempted = new Set(),
  readStore = defaultReadStore,
  inspectProcess = inspectClaudeProcessTree,
  launchRecoveryWorkspace = defaultLaunchRecoveryWorkspace,
  claimRecovery = claimSessionOnce,
  stopProcess = stopExistingSessionProcess,
  trustedClaudePath = null,
}) {
  let store;
  try {
    store = await readStore(storePath);
  } catch {
    return { scanned: 0, candidates: 0, rescued: 0, failed: 0 };
  }

  if (!trustedClaudePath && inspectProcess === inspectClaudeProcessTree) {
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
    const initialState = await unresolvedRecoverableApiErrorState(
      session.transcriptPath,
      transcriptRoot,
      session.sessionId,
    );
    if (!initialState) continue;
    candidates += 1;
    if (fleetRetryStillActive(initialState)) continue;
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
    const freshState = await unresolvedRecoverableApiErrorState(
      fresh.transcriptPath,
      transcriptRoot,
      fresh.sessionId,
    );
    if (!freshState || fleetRetryStillActive(freshState)) continue;

    const first = await inspectProcess(fresh.pid, fresh.sessionId);
    if (!await sameClaudeProcess(fresh, first, trustedClaudePath)) continue;
    const second = await inspectProcess(fresh.pid, fresh.sessionId);
    if (!await sameClaudeProcess(
      fresh,
      second,
      trustedClaudePath,
      first.processIdentity,
      first.launcherProcessIdentity,
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
    const finalState = await unresolvedRecoverableApiErrorState(
      final.transcriptPath,
      transcriptRoot,
      final.sessionId,
    );
    if (!finalState || fleetRetryStillActive(finalState)) continue;
    const finalInfo = await inspectProcess(final.pid, final.sessionId);
    if (!await sameClaudeProcess(
      final,
      finalInfo,
      trustedClaudePath,
      first.processIdentity,
      first.launcherProcessIdentity,
    )) continue;

    const command = buildResumeCommand({
      cwd: final.cwd,
      sessionId: final.sessionId,
      nodePath,
      scriptPath,
      configPath,
      continueLastPrompt: !['ambiguous_connection', 'ambiguous_dispatch'].includes(finalState.kind),
    });
    try {
      if (!await claimRecovery(storePath, key)) {
        attempted.add(key);
        continue;
      }
      attempted.add(key);
      let claimedStore;
      try {
        claimedStore = await readStore(storePath);
      } catch {
        continue;
      }
      const claimed = sessions(claimedStore).find(item => item?.sessionId === key);
      if (!claimed
          || !sameRegistrySession(claimed, final)
          || !validSession(claimedStore, claimed)) continue;
      const claimedState = await unresolvedRecoverableApiErrorState(
        claimed.transcriptPath,
        transcriptRoot,
        claimed.sessionId,
      );
      if (!claimedState || fleetRetryStillActive(claimedState)) continue;
      const claimedInfo = await inspectProcess(claimed.pid, claimed.sessionId);
      if (!await sameClaudeProcess(
        claimed,
        claimedInfo,
        trustedClaudePath,
        finalInfo.processIdentity,
        finalInfo.launcherProcessIdentity,
      )) continue;
      if (finalInfo.processRole === 'teamclaude-child'
          && Number.isInteger(finalInfo.pid)
          && !await stopProcess(finalInfo, final.pid, { inspectProcess: inspectClaudeProcess })) {
        failed += 1;
        continue;
      }
      if (finalInfo.processRole === 'legacy-native'
          && Number.isInteger(finalInfo.pid)
          && !await stopProcess(finalInfo, null, { inspectProcess: inspectClaudeProcess })) {
        failed += 1;
        continue;
      }
      if (finalInfo.processRole === 'teamclaude-child'
          || finalInfo.processRole === 'legacy-native') {
        const afterStopInfo = await inspectProcess(final.pid, final.sessionId);
        if (afterStopInfo?.alive || processAlive(final.pid)) {
          failed += 1;
          continue;
        }
      }
      let afterStopStore;
      try {
        afterStopStore = await readStore(storePath);
      } catch {
        failed += 1;
        continue;
      }
      const afterStop = sessions(afterStopStore).find(item => item?.sessionId === key);
      if (!afterStop
          || !sameRegistrySession(afterStop, final)
          || !validSession(afterStopStore, afterStop)
          || !await unresolvedRecoverableApiErrorState(
            afterStop.transcriptPath,
            transcriptRoot,
            afterStop.sessionId,
          )) continue;
      if (finalInfo.processRole === 'teamclaude-child'
          || finalInfo.processRole === 'legacy-native') {
        const beforeLaunchInfo = await inspectProcess(final.pid, final.sessionId);
        if (beforeLaunchInfo?.alive || processAlive(final.pid)) {
          failed += 1;
          continue;
        }
      }
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
