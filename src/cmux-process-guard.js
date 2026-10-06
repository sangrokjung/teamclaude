import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function environmentValues(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...text.matchAll(new RegExp(`(?:^|\\s)${escaped}=([^\\s]*)`, 'g'))]
    .map(match => match[1]);
}

function decodeLaunchArgv(value) {
  if (typeof value !== 'string'
      || value.length === 0
      || value.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  const argv = decoded.split('\0');
  if (argv.at(-1) === '') argv.pop();
  return argv.length > 0 && argv.every(arg => !arg.includes('\0'))
    ? argv
    : null;
}

function parseProcessTable(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return rows;
}

async function directChildRows(pid) {
  const { stdout: childPids } = await execFileAsync('pgrep', ['-P', String(pid)], {
    timeout: 1000,
  });
  const pids = childPids.split(/\s+/).filter(Boolean);
  if (pids.length === 0) return [];
  const { stdout } = await execFileAsync(
    'ps',
    ['-p', pids.join(','), '-o', 'pid=,ppid=,command='],
    { timeout: 1500, env: { ...process.env, LC_ALL: 'C' } },
  );
  return parseProcessTable(stdout);
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function selectorFromCommand(command, sessionId) {
  const session = escapedRegExp(sessionId);
  const match = command.match(
    new RegExp(`(?:^|\\s)(--resume|--session-id)(?:=|\\s+)${session}(?=\\s|$)`),
  );
  return match?.[1] || null;
}

function hasSessionSelector(command) {
  return /(?:^|\s)(?:--resume|--session-id)(?:=|\s+)/.test(command);
}

const CLAUDE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_PROCESS_START_DRIFT_SECONDS = 7 * 24 * 60 * 60;

async function trustedNativeClaudeExecutable(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  try {
    const [resolved, root] = await Promise.all([
      realpath(path),
      realpath(join(homedir(), '.local', 'share', 'claude', 'versions')),
    ]);
    const rel = relative(root, resolved);
    return rel !== ''
      && !rel.startsWith('..')
      && !rel.includes('/')
      && CLAUDE_VERSION_RE.test(rel)
      && (await access(resolved, constants.X_OK).then(() => true, () => false));
  } catch {
    return false;
  }
}

function isTeamClaudeSupervisor(info) {
  return info?.alive
    && info.supervised !== true
    && /\/teamcodex\/src\/index\.js\s+run(?:\s|$)/.test(info.command)
    && info.environmentValid === true
    && Array.isArray(info.launchArgv)
    && typeof info.launchArgv[0] === 'string'
    && info.launchArgv[0].length > 0
    && typeof info.teamClaudeBin === 'string'
    && info.teamClaudeBin.length > 0;
}

function childLooksLikeClaude(info, sessionId) {
  return info?.alive
    && info.environmentValid === true
    && info.supervised === true
    && info.agentLaunchKind === 'claude'
    && info.nativeExecutableTrusted === true
    && (!hasSessionSelector(info.command)
      || typeof selectorFromCommand(info.command, sessionId) === 'string')
    && typeof info.teamClaudeBin === 'string'
    && info.teamClaudeBin.length > 0;
}

function legacyNativeLooksLikeClaude(info, sessionId) {
  return info?.alive
    && info.legacyEnvironmentValid === true
    && info.supervised !== true
    && info.nativeExecutableTrusted === true
    && typeof selectorFromCommand(info.command, sessionId) === 'string';
}

export async function inspectClaudeProcess(pid) {
  try {
    process.kill(pid, 0);
    const [
      { stdout: command },
      { stdout: environment },
      { stdout: parentPidOutput },
      { stdout: startedAt },
    ] = await Promise.all([
      execFileAsync('ps', ['ww', '-p', String(pid), '-o', 'command='], {
        timeout: 1500,
      }),
      execFileAsync('ps', ['eww', '-p', String(pid), '-o', 'command='], {
        timeout: 1500,
      }),
      execFileAsync('ps', ['-p', String(pid), '-o', 'ppid='], {
        timeout: 1500,
        env: { ...process.env, LC_ALL: 'C' },
      }),
      execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], {
        timeout: 1500,
        env: { ...process.env, LC_ALL: 'C' },
      }),
    ]);
    const processCommand = command.trim();
    const processWithEnvironment = environment.trim();
    const environmentText = processWithEnvironment.startsWith(`${processCommand} `)
      ? processWithEnvironment.slice(processCommand.length + 1)
      : '';
    const surfaceValues = environmentValues(environmentText, 'CMUX_SURFACE_ID');
    const launchArgvValues = environmentValues(
      environmentText,
      'CMUX_AGENT_LAUNCH_ARGV_B64',
    );
    const supervisedValues = environmentValues(
      environmentText,
      'TEAMCLAUDE_SESSION_SUPERVISED',
    );
    const teamClaudeBinValues = environmentValues(
      environmentText,
      'TEAMCLAUDE_CLAUDE_BIN',
    );
    const parentPid = parentPidOutput.trim();
    const agentLaunchKindValues = environmentValues(environmentText, 'CMUX_AGENT_LAUNCH_KIND');
    const executablePath = processCommand.split(/\s+/)[0] || '';
    const launchCwd = environmentValues(environmentText, 'CMUX_AGENT_LAUNCH_CWD')[0] || '';
    let cwd = environmentValues(environmentText, 'PWD')[0] || launchCwd;
    try {
      const { stdout: cwdOutput } = await execFileAsync(
        'lsof',
        ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
        { timeout: 1500 },
      );
      cwd = cwdOutput.split('\n').find(line => line.startsWith('n'))?.slice(1) || cwd;
    } catch {}
    const launchArgv = launchArgvValues.length === 1
      ? decodeLaunchArgv(launchArgvValues[0])
      : null;
    return {
      alive: true,
      pid: Number(pid),
      command: processCommand,
      cwd,
      launchCwd,
      environmentValid: surfaceValues.length === 1
        && launchArgvValues.length === 1
        && supervisedValues.length <= 1
        && Array.isArray(launchArgv),
      legacyEnvironmentValid: surfaceValues.length === 1
        && supervisedValues.length === 0
        && launchArgvValues.length <= 1
        && (launchArgvValues.length === 0 || Array.isArray(launchArgv)),
      executablePath,
      launchArgv,
      parentPid: /^\d+$/.test(parentPid)
        ? Number(parentPid)
        : null,
      teamClaudeBin: teamClaudeBinValues.length === 1 ? teamClaudeBinValues[0] : null,
      agentLaunchKind: agentLaunchKindValues.length === 1 ? agentLaunchKindValues[0] : null,
      processIdentity: `${pid}:${startedAt.trim()}`,
      processStartedAt: new Date(startedAt.trim()).getTime() / 1000,
      surfaceId: surfaceValues.length === 1 ? surfaceValues[0] : null,
      supervised: supervisedValues[0] === '1',
      nativeExecutableTrusted: await trustedNativeClaudeExecutable(executablePath),
    };
  } catch {
    return { alive: false };
  }
}

export async function inspectClaudeProcessTree(
  pid,
  sessionId,
  { inspectProcess = inspectClaudeProcess } = {},
) {
  if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return { alive: false };
  }
  const inspected = await inspectProcess(pid);
  let supervisor = inspected;
  let directChild = null;
  if (!isTeamClaudeSupervisor(supervisor)
      && legacyNativeLooksLikeClaude(inspected, sessionId)) {
    if (Number.isInteger(inspected.parentPid)) {
      const parent = await inspectProcess(inspected.parentPid);
      if (isTeamClaudeSupervisor(parent)
          && parent.surfaceId === inspected.surfaceId
          && (!parent.teamClaudeBin
            || !inspected.teamClaudeBin
            || parent.teamClaudeBin === inspected.teamClaudeBin)) {
        return { alive: false };
      }
    }
    return {
      ...inspected,
      processRole: 'legacy-native',
    };
  }
  if (!isTeamClaudeSupervisor(supervisor)
      && childLooksLikeClaude(inspected, sessionId)
      && Number.isInteger(inspected.parentPid)) {
    supervisor = await inspectProcess(inspected.parentPid);
    directChild = inspected;
  }
  if (directChild
      && isTeamClaudeSupervisor(supervisor)
      && directChild.surfaceId === supervisor.surfaceId
      && directChild.teamClaudeBin === supervisor.teamClaudeBin) {
    return {
      ...directChild,
      processRole: 'teamclaude-child',
      launcherCommand: supervisor,
      launcherProcessIdentity: supervisor.processIdentity,
    };
  }
  if (!isTeamClaudeSupervisor(supervisor)) return { alive: false };
  let table;
  try {
    const directRows = await directChildRows(pid);
    const prioritized = directRows.sort((left, right) => {
      const leftPriority = selectorFromCommand(left.command, sessionId)
        || /\/claude\/versions\//.test(left.command) ? 0 : 1;
      const rightPriority = selectorFromCommand(right.command, sessionId)
        || /\/claude\/versions\//.test(right.command) ? 0 : 1;
      return leftPriority - rightPriority;
    });
    for (const row of prioritized) {
      const child = await inspectProcess(row.pid);
      if (childLooksLikeClaude(child, sessionId)
          && child.parentPid === pid
          && child.surfaceId === supervisor.surfaceId
          && (!supervisor.teamClaudeBin || child.teamClaudeBin === supervisor.teamClaudeBin)) {
        return {
          ...child,
          processRole: 'teamclaude-child',
          launcherCommand: supervisor,
          launcherProcessIdentity: supervisor.processIdentity,
        };
      }
    }
    if (directRows.length === 0) throw new Error('No direct child.');
  } catch {}
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,command='], {
      timeout: 2500,
      env: { ...process.env, LC_ALL: 'C' },
    });
    table = parseProcessTable(stdout);
  } catch {
    return { alive: false };
  }
  const childrenByParent = new Map();
  for (const row of table) {
    const list = childrenByParent.get(row.ppid) || [];
    list.push(row);
    childrenByParent.set(row.ppid, list);
  }
  let queue = [...(childrenByParent.get(pid) || [])];
  const seen = new Set();
  while (queue.length > 0 && seen.size < 64) {
    const row = queue.shift();
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    if (selectorFromCommand(row.command, sessionId)) {
      const child = await inspectProcess(row.pid);
      if (childLooksLikeClaude(child, sessionId)
          && child.parentPid === pid
          && child.surfaceId === supervisor.surfaceId
          && (!supervisor.teamClaudeBin || child.teamClaudeBin === supervisor.teamClaudeBin)) {
        return {
          ...child,
          processRole: 'teamclaude-child',
          launcherCommand: supervisor,
          launcherProcessIdentity: supervisor.processIdentity,
        };
      }
    }
    const descendants = childrenByParent.get(row.pid) || [];
    if (descendants.length > 0) {
      const matching = descendants.filter(child => selectorFromCommand(child.command, sessionId));
      const remaining = descendants.filter(child => !selectorFromCommand(child.command, sessionId));
      queue = [...matching, ...queue, ...remaining];
    }
  }
  return { alive: false };
}

function exactSelectorInArgv(argv, sessionId) {
  let count = 0;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--resume' || argument === '--session-id') {
      if (argv[index + 1] !== sessionId) return false;
      count += 1;
      index += 1;
    } else if (argument.startsWith('--resume=') || argument.startsWith('--session-id=')) {
      if (argument !== `--resume=${sessionId}` && argument !== `--session-id=${sessionId}`) {
        return false;
      }
      count += 1;
    }
  }
  return count === 1;
}

function selectorMatches(info, sessionId) {
  const executable = info.executablePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const session = sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const renderedPrefix = new RegExp(
    `^${executable}\\s+--(?:resume|session-id)(?:=|\\s+)${session}(?=\\s|$)`,
  );
  if (info.processRole === 'teamclaude-child' || info.processRole === 'legacy-native') {
    if (hasSessionSelector(info.command) && !selectorFromCommand(info.command, sessionId)) {
      return false;
    }
    if (info.processRole === 'legacy-native' && !Array.isArray(info.launchArgv)) return true;
  } else if (!renderedPrefix.test(info.command)) {
    return false;
  }

  const argvHasSelector = exactSelectorInArgv(info.launchArgv, sessionId);
  if (!argvHasSelector) {
    if (info.processRole !== 'teamclaude-child' && info.processRole !== 'legacy-native') return false;
    if (info.launchArgv.slice(1).some(argument => argument === '--resume'
        || argument === '--session-id'
        || argument.startsWith('--resume=')
        || argument.startsWith('--session-id='))) return false;
  }
  for (let index = 1; index < info.launchArgv.length; index += 1) {
    const argument = info.launchArgv[index];
    if (argument.includes('CMUX_SURFACE_ID=')) return false;
    if (!argument.includes(sessionId)) continue;
    const isSelectorValue = info.launchArgv[index - 1] === '--resume'
      || info.launchArgv[index - 1] === '--session-id';
    const isJoinedSelector = argument === `--resume=${sessionId}`
      || argument === `--session-id=${sessionId}`;
    if (!argvHasSelector || (!isSelectorValue && !isJoinedSelector)) {
      return false;
    }
  }
  return true;
}

export async function sameClaudeProcess(
  session,
  info,
  trustedClaudePath = null,
  expectedIdentity = null,
  expectedLauncherIdentity = null,
) {
  const isTeamClaudeChild = info?.processRole === 'teamclaude-child';
  const isLegacyNative = info?.processRole === 'legacy-native';
  const processStartedAt = isTeamClaudeChild
    ? (info.launcherCommand?.processStartedAt ?? info?.processStartedAt)
    : info?.processStartedAt;
  const startDelta = session?.startedAt - processStartedAt;
  if (!info?.alive
      || (info.environmentValid !== true && !isLegacyNative)
      || (info.supervised && !isTeamClaudeChild)
      || info.surfaceId !== session.surfaceId
      || typeof info.processIdentity !== 'string'
      || !info.processIdentity
      || (expectedIdentity && info.processIdentity !== expectedIdentity)
      || (expectedLauncherIdentity
        && info.launcherProcessIdentity !== expectedLauncherIdentity)
      || (isTeamClaudeChild
        && (!isTeamClaudeSupervisor(info.launcherCommand)
          || info.teamClaudeBin !== info.launcherCommand.teamClaudeBin))
      || (!Array.isArray(info.launchArgv) && !isLegacyNative)
      || !selectorMatches(info, session.sessionId)
      || !Number.isFinite(startDelta)
      || startDelta < -MAX_PROCESS_START_DRIFT_SECONDS
      || startDelta > 60) {
    return false;
  }
  try {
    const [
      processExecutable,
      processLaunchExecutable,
      launchExecutable,
      trustedExecutable,
      processCwd,
      sessionCwd,
    ] = await Promise.all([
      realpath(info.executablePath),
      realpath(info.launchArgv?.[0] || info.executablePath),
      realpath(session.launchCommand.executablePath),
      realpath(trustedClaudePath || session.launchCommand.executablePath),
      realpath(info.cwd),
      realpath(session.launchCommand.workingDirectory || session.cwd),
    ]);
    if (isLegacyNative) {
      return info.legacyEnvironmentValid === true
        && info.nativeExecutableTrusted === true
        && (processExecutable === processLaunchExecutable
          || processLaunchExecutable === launchExecutable)
        && processCwd === sessionCwd;
    }
    if (processExecutable === trustedExecutable
        && processLaunchExecutable === trustedExecutable
        && launchExecutable === trustedExecutable
        && processCwd === sessionCwd) {
      return true;
    }
    if (!isTeamClaudeChild
        && info.nativeExecutableTrusted === true
        && processCwd === sessionCwd
        && (processExecutable === processLaunchExecutable
          || processLaunchExecutable === launchExecutable)
        && (processExecutable === launchExecutable || isLegacyNative)
        && (processExecutable === launchExecutable || launchExecutable === trustedExecutable)) {
      return true;
    }
    if (!isTeamClaudeChild || !isTeamClaudeSupervisor(info.launcherCommand)) return false;
    const [launcherExecutable, launcherCwd, sessionLauncherExecutable] = await Promise.all([
      realpath(info.launcherCommand.executablePath),
      realpath(info.launcherCommand.cwd),
      realpath(session.launchCommand.executablePath),
    ]);
    const launcherUsesTrustedWrapper = Array.isArray(info.launcherCommand.launchArgv)
      && info.launcherCommand.launchArgv.length > 0
      && await realpath(info.launcherCommand.launchArgv[0]) === sessionLauncherExecutable;
    const launcherUsesInheritedWrapper = info.launcherCommand.environmentValid !== true
      && launcherCwd === sessionCwd;
    return info.nativeExecutableTrusted === true
      && launcherExecutable !== trustedExecutable
      && (launcherUsesTrustedWrapper || launcherUsesInheritedWrapper)
      && processExecutable !== trustedExecutable
      && (processLaunchExecutable === processExecutable
        || processLaunchExecutable === launchExecutable)
      && launchExecutable === trustedExecutable
      && processCwd === sessionCwd
      && (session.pid === info.pid || info.parentPid === session.pid)
      && info.launcherProcessIdentity === info.launcherCommand.processIdentity;
  } catch {
    return false;
  }
}

export async function resolveTrustedClaudePath() {
  const candidates = [
    ...((process.env.PATH || '').split(delimiter)
      .filter(Boolean)
      .map(directory => join(directory, 'claude'))),
    join(homedir(), '.local', 'bin', 'claude'),
    join(homedir(), 'bin', 'claude'),
  ];
  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {}
  }
  throw new Error('Unable to resolve the trusted Claude executable.');
}
