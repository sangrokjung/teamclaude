import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import {
  buildResumeCommand,
  claimSessionOnce,
  inspectClaudeProcess,
  inspectClaudeProcessTree,
  readPrivateJson,
  releaseSessionClaim,
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

// The rescue loop runs from background contexts with a minimal PATH, and a
// PATH lookup would let any earlier `cmux` on PATH receive surface commands.
// So only known absolute install locations are probed; a non-standard install
// names its binary explicitly with TEAMCLAUDE_CMUX_BIN (absolute, executable).
export async function resolveCmuxBinary(env = process.env) {
  const isExecutable = path => access(path, constants.X_OK).then(() => true, () => false);
  const override = env.TEAMCLAUDE_CMUX_BIN;
  if (override !== undefined && override !== '') {
    if (!isAbsolute(override) || !(await isExecutable(override))) {
      throw new Error('TEAMCLAUDE_CMUX_BIN must be an absolute path to an executable cmux.');
    }
    return override;
  }
  for (const candidate of CMUX_BINARY_CANDIDATES) {
    if (await isExecutable(candidate)) return candidate;
  }
  throw new Error('Unable to resolve the cmux executable (set TEAMCLAUDE_CMUX_BIN for a non-standard install).');
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

async function defaultResolveRecoveryWindow({ workspaceId, surfaceId }) {
  const cmuxBinary = await resolveCmuxBinary();
  const { stdout } = await execFileAsync(cmuxBinary, ['rpc', 'system.tree', '{}'], {
    timeout: 3000,
  });
  const tree = JSON.parse(stdout);
  const windowId = resolveRecoveryWindowId(tree, { surfaceId, workspaceId });
  if (typeof windowId !== 'string') {
    throw new Error('Unable to resolve the cmux window for the blocked session.');
  }
  return windowId;
}

async function defaultLaunchRecoveryWorkspace({
  workspaceId,
  surfaceId,
  windowId = null,
  cwd,
  sessionId,
  command,
}) {
  const cmuxBinary = await resolveCmuxBinary();
  const resolvedWindowId = windowId || await defaultResolveRecoveryWindow({
    workspaceId,
    surfaceId,
  });
  await execFileAsync(cmuxBinary, [
    'new-workspace',
    '--window',
    resolvedWindowId,
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

export async function stopExistingSessionProcess(
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
        || (Number.isInteger(parentPid)
          && pid === info?.pid
          && current.parentPid !== parentPid)) {
      return false;
    }
    if (pid === parentPid && current.surfaceId !== info.surfaceId) return false;
  }
  const stopOrder = [...pids].sort((left, right) => (
    left === parentPid ? -1 : right === parentPid ? 1 : 0
  ));
  // Stopping the launcher can let the child exit and its PID be reused, so
  // each PID is re-verified right before it is signalled. The identity carries
  // the process start time, so a reused PID never matches.
  const stillExpected = async pid => {
    try {
      const current = await inspectProcess(pid);
      return current?.alive === true && current.processIdentity === expected.get(pid);
    } catch {
      return false;
    }
  };
  for (const pid of stopOrder) {
    if (!await stillExpected(pid)) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  let stopped = true;
  for (const pid of stopOrder) {
    if (!await waitForProcessExit(pid, 2500)) stopped = false;
  }
  if (!stopped) {
    for (const pid of stopOrder) {
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
    for (const pid of stopOrder) {
      if (!await waitForProcessExit(pid, 750)) stopped = false;
    }
  }
  return stopped;
}

// A recovery claim covers one recoverable error EVENT, not the whole session:
// a session that is rescued and later exhausts the fleet again records a new
// error and must be rescuable again, while the same event is never launched
// twice (even across supervisor restarts). The event is the record's uuid, or
// its timestamp when it has no uuid; a record with neither keeps the
// conservative per-session key.
function recoveryClaimKey(sessionId, state) {
  if (typeof state?.eventId === 'string' && state.eventId) return `${sessionId}@${state.eventId}`;
  return Number.isSafeInteger(state?.eventTimestampMs) && state.eventTimestampMs > 0
    ? `${sessionId}@${state.eventTimestampMs}`
    : sessionId;
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

function processStartedAfterRecoveryError(info, state) {
  return Number.isFinite(info?.processStartedAt)
    && Number.isFinite(state?.timestampMs)
    && info.processStartedAt * 1000 > state.timestampMs;
}

function processGone(info, pid) {
  return !info?.alive && !processAlive(pid);
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
  resolveRecoveryWindow = null,
  claimRecovery = claimSessionOnce,
  releaseRecovery = releaseSessionClaim,
  stopProcess = stopExistingSessionProcess,
  stopInspectProcess = inspectClaudeProcess,
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
    const key = recoveryClaimKey(session.sessionId, initialState);
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
    if (!freshState || fleetRetryStillActive(freshState)
        || recoveryClaimKey(session.sessionId, freshState) !== key) continue;

    const first = await inspectProcess(fresh.pid, fresh.sessionId);
    const firstGone = processGone(first, fresh.pid);
    if (!firstGone && !await sameClaudeProcess(fresh, first, trustedClaudePath)) continue;
    if (!firstGone && processStartedAfterRecoveryError(first, freshState)) continue;
    const second = await inspectProcess(fresh.pid, fresh.sessionId);
    const secondGone = processGone(second, fresh.pid);
    if (firstGone !== secondGone) continue;
    if (!secondGone && !await sameClaudeProcess(
      fresh,
      second,
      trustedClaudePath,
      first.processIdentity,
      first.launcherProcessIdentity,
    )) continue;
    if (!secondGone && processStartedAfterRecoveryError(second, freshState)) continue;

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
    if (!finalState || fleetRetryStillActive(finalState)
        || recoveryClaimKey(session.sessionId, finalState) !== key) continue;
    const finalInfo = await inspectProcess(final.pid, final.sessionId);
    const finalGone = processGone(finalInfo, final.pid);
    if (finalGone !== secondGone) continue;
    if (!finalGone && !await sameClaudeProcess(
      final,
      finalInfo,
      trustedClaudePath,
      first.processIdentity,
      first.launcherProcessIdentity,
    )) continue;
    if (!finalGone && processStartedAfterRecoveryError(finalInfo, finalState)) continue;

    const command = buildResumeCommand({
      cwd: final.cwd,
      sessionId: final.sessionId,
      nodePath,
      scriptPath,
      configPath,
      continueLastPrompt: !['ambiguous_connection', 'ambiguous_dispatch'].includes(finalState.kind),
    });
    let recoveryWindowId = null;
    if (resolveRecoveryWindow
        || launchRecoveryWorkspace === defaultLaunchRecoveryWorkspace) {
      try {
        recoveryWindowId = await (resolveRecoveryWindow || defaultResolveRecoveryWindow)({
          workspaceId: final.workspaceId,
          surfaceId: final.surfaceId,
        });
      } catch {
        continue;
      }
    }
    let claimOwned = false;
    const releaseClaimForRetry = async () => {
      if (!claimOwned) return;
      const claimIdentity = typeof claimOwned === 'object' ? claimOwned : null;
      claimOwned = false;
      attempted.delete(key);
      try {
        await releaseRecovery(storePath, key, claimIdentity);
      } catch {}
    };
    try {
      const claim = await claimRecovery(storePath, key);
      if (!claim) {
        attempted.add(key);
        continue;
      }
      claimOwned = claim;
      attempted.add(key);
      let claimedStore;
      try {
        claimedStore = await readStore(storePath);
      } catch {
        await releaseClaimForRetry();
        continue;
      }
      const claimed = sessions(claimedStore).find(item => item?.sessionId === session.sessionId);
      if (!claimed
          || !sameRegistrySession(claimed, final)
          || !validSession(claimedStore, claimed)) {
        await releaseClaimForRetry();
        continue;
      }
      const claimedState = await unresolvedRecoverableApiErrorState(
        claimed.transcriptPath,
        transcriptRoot,
        claimed.sessionId,
      );
      if (!claimedState || fleetRetryStillActive(claimedState)
          || recoveryClaimKey(session.sessionId, claimedState) !== key) {
        await releaseClaimForRetry();
        continue;
      }
      const claimedInfo = await inspectProcess(claimed.pid, claimed.sessionId);
      const claimedGone = processGone(claimedInfo, claimed.pid);
      if (claimedGone !== finalGone) {
        await releaseClaimForRetry();
        continue;
      }
      if (!claimedGone && !await sameClaudeProcess(
        claimed,
        claimedInfo,
        trustedClaudePath,
        finalInfo.processIdentity,
        finalInfo.launcherProcessIdentity,
      )) {
        await releaseClaimForRetry();
        continue;
      }
      if (!claimedGone && processStartedAfterRecoveryError(claimedInfo, claimedState)) {
        await releaseClaimForRetry();
        continue;
      }
      const recoveryParentPid = finalInfo.processRole === 'teamclaude-child'
        ? (finalInfo.launcherCommand?.pid ?? finalInfo.parentPid)
        : null;
      if ((finalInfo.processRole === 'teamclaude-child'
          || finalInfo.processRole === 'legacy-native')
          && Number.isInteger(finalInfo.pid)
          && !await stopProcess(finalInfo, recoveryParentPid, { inspectProcess: stopInspectProcess })) {
        await releaseClaimForRetry();
        failed += 1;
        continue;
      }
      if (finalInfo.processRole === 'teamclaude-child'
          || finalInfo.processRole === 'legacy-native') {
        const afterStopInfo = await inspectProcess(final.pid, final.sessionId);
        if (afterStopInfo?.alive
            || processAlive(final.pid)
            || processAlive(recoveryParentPid)) {
          await releaseClaimForRetry();
          failed += 1;
          continue;
        }
      }
      const afterStopState = await unresolvedRecoverableApiErrorState(
        final.transcriptPath,
        transcriptRoot,
        final.sessionId,
      );
      if (!afterStopState || fleetRetryStillActive(afterStopState)
          || recoveryClaimKey(session.sessionId, afterStopState) !== key) {
        await releaseClaimForRetry();
        continue;
      }
      if (finalInfo.processRole === 'teamclaude-child'
          || finalInfo.processRole === 'legacy-native') {
        const beforeLaunchInfo = await inspectProcess(final.pid, final.sessionId);
        if (beforeLaunchInfo?.alive || processAlive(final.pid)) {
          await releaseClaimForRetry();
          failed += 1;
          continue;
        }
      } else if (finalGone && processAlive(final.pid)) {
        await releaseClaimForRetry();
        failed += 1;
        continue;
      }
      await launchRecoveryWorkspace({
        workspaceId: final.workspaceId,
        surfaceId: final.surfaceId,
        windowId: recoveryWindowId,
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
