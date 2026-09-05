import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function runCli(command, env) {
  return new Promise(resolve => {
    execFile(process.execPath, [entry, command], { encoding: 'utf8', env }, (err, stdout, stderr) => {
      resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

test('stop refuses unverified lifecycle states before sending any signal', async t => {
  const targetPid = 424242;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accounts: [], switchThreshold: 0.98 }));
  });
  const port = await listen(server);
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-lifecycle-'));
  const binDir = join(dir, 'bin');
  const configPath = join(dir, 'teamcodex.json');
  const statePath = join(dir, 'teamcodex.server.json');
  const killLog = join(dir, 'signals.log');
  const preloadPath = join(dir, 'intercept-kill.cjs');
  await mkdir(binDir);
  await writeFile(join(binDir, 'lsof'), `#!/bin/sh\nprintf '%s\\n' '${targetPid}'\n`);
  await chmod(join(binDir, 'lsof'), 0o755);
  await writeFile(preloadPath, `
const fs = require('node:fs');
let signaled = false;
process.kill = (pid, signal = 0) => {
  if (signal === 0) {
    if (!signaled) return true;
    const error = new Error('gone');
    error.code = 'ESRCH';
    throw error;
  }
  fs.appendFileSync(process.env.TEAMCODEX_TEST_KILL_LOG, String(pid) + ' ' + signal + '\\n');
  signaled = true;
  return true;
};
`);
  await writeFile(configPath, JSON.stringify({
    provider: 'codex',
    proxy: { port, apiKey: 'test-key' },
    accounts: [],
  }));
  const legacyState = {
    pid: targetPid,
    workerPid: targetPid + 1,
    port,
    startedAt: new Date(0).toISOString(),
    config: configPath,
  };

  try {
    const env = {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
      NODE_OPTIONS: `--require=${preloadPath}`,
      TEAMCLAUDE_CONFIG: configPath,
      TEAMCLAUDE_PROVIDER: 'codex',
      TEAMCODEX_TEST_KILL_LOG: killLog,
    };
    delete env.TEAMCLAUDE_SESSION_SUPERVISED;
    delete env.TEAMCLAUDE_SUPERVISED_WORKER;
    delete env.TEAMCLAUDE_SUPERVISOR_PID;
    const cases = [
      ['legacy state', legacyState],
      ['forged lifecycle id', {
        ...legacyState,
        lifecycle: {
          version: 1,
          id: 'forged-lifecycle-id',
          supervisor: {
            pid: targetPid,
            ppid: 1,
            startedAt: 'Thu Aug 13 00:00:00 2026',
            command: `${process.execPath} ${entry} server`,
          },
          worker: {
            pid: targetPid + 1,
            ppid: targetPid,
            startedAt: 'Thu Aug 13 00:00:01 2026',
            command: `${process.execPath} ${entry} server`,
          },
        },
      }],
    ];
    for (const [name, state] of cases) await t.test(name, async () => {
      await writeFile(statePath, JSON.stringify(state));
      const status = await runCli('status', env);
      assert.equal(status.status, 0, status.stderr);
      assert.match(status.stdout, /lifecycle identity unverified/i);
      assert.doesNotMatch(status.stdout, new RegExp(`pid ${targetPid}`));
      for (const command of ['stop', 'restart']) {
        const result = await runCli(command, env);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, /lifecycle identity/i);
      }
      const signals = await readFile(killLog, 'utf8').catch(err => {
        if (err.code === 'ENOENT') return '';
        throw err;
      });
      assert.equal(signals, '');
    });
  } finally {
    await close(server);
    await rm(dir, { recursive: true, force: true });
  }
});
