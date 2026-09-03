import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
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
  return argv.length > 0 && argv.every(arg => !arg.includes('\0'))
    ? argv
    : null;
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
      execFileAsync('ps', ['ww', '-p', String(pid), '-o', 'command='], {
        timeout: 1500,
      }),
      execFileAsync('ps', ['eww', '-p', String(pid), '-o', 'command='], {
        timeout: 1500,
      }),
      execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
        timeout: 1500,
      }),
      execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], {
        timeout: 1500,
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
    const executablePath = processCommand.split(/\s+/)[0] || '';
    const cwd = cwdOutput.split('\n').find(line => line.startsWith('n'))?.slice(1) || '';
    const launchArgv = launchArgvValues.length === 1
      ? decodeLaunchArgv(launchArgvValues[0])
      : null;
    return {
      alive: true,
      command: processCommand,
      cwd,
      environmentValid: surfaceValues.length === 1
        && launchArgvValues.length === 1
        && supervisedValues.length <= 1
        && Array.isArray(launchArgv),
      executablePath,
      launchArgv,
      processIdentity: `${pid}:${startedAt.trim()}`,
      processStartedAt: new Date(startedAt.trim()).getTime() / 1000,
      surfaceId: surfaceValues.length === 1 ? surfaceValues[0] : null,
      supervised: supervisedValues[0] === '1',
    };
  } catch {
    return { alive: false };
  }
}

function exactSelectorInArgv(argv, sessionId) {
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if ((argument === '--resume' || argument === '--session-id')
        && argv[index + 1] === sessionId) {
      return true;
    }
    if (argument === `--resume=${sessionId}`
        || argument === `--session-id=${sessionId}`) {
      return true;
    }
  }
  return false;
}

function selectorMatches(info, sessionId) {
  const executable = info.executablePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const session = sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const renderedPrefix = new RegExp(
    `^${executable}\\s+--(?:resume|session-id)(?:=|\\s+)${session}(?=\\s|$)`,
  );
  if (!renderedPrefix.test(info.command)) return false;

  const argvHasSelector = exactSelectorInArgv(info.launchArgv, sessionId);
  for (let index = 1; index < info.launchArgv.length; index += 1) {
    const argument = info.launchArgv[index];
    if (argument.includes('CMUX_SURFACE_ID=')) return false;
    if (!argument.includes(sessionId)) continue;
    const isSelectorValue = info.launchArgv[index - 1] === '--resume'
      || info.launchArgv[index - 1] === '--session-id';
    const isJoinedSelector = argument === `--resume=${sessionId}`
      || argument === `--session-id=${sessionId}`;
    if (!argvHasSelector || (!isSelectorValue && !isJoinedSelector)) return false;
  }
  return true;
}

export async function sameClaudeProcess(
  session,
  info,
  trustedClaudePath = null,
  expectedIdentity = null,
) {
  const startDelta = session?.startedAt - info?.processStartedAt;
  if (!info?.alive
      || info.environmentValid !== true
      || info.supervised
      || info.surfaceId !== session.surfaceId
      || typeof info.processIdentity !== 'string'
      || !info.processIdentity
      || (expectedIdentity && info.processIdentity !== expectedIdentity)
      || !Array.isArray(info.launchArgv)
      || !selectorMatches(info, session.sessionId)
      || !Number.isFinite(startDelta)
      || startDelta < -2
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
      realpath(info.launchArgv[0]),
      realpath(session.launchCommand.executablePath),
      realpath(trustedClaudePath || session.launchCommand.executablePath),
      realpath(info.cwd),
      realpath(session.cwd),
    ]);
    return processExecutable === trustedExecutable
      && processLaunchExecutable === trustedExecutable
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
