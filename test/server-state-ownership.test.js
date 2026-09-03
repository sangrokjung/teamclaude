import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function listen(server) {
  return new Promise(resolve => server.listen(0, () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function unusedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function waitUntil(check, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function status(port) {
  try { return (await fetch(`http://127.0.0.1:${port}/teamclaude/status`)).ok; }
  catch { return false; }
}

async function lifecycleStateReady(configPath, supervisorPid) {
  try {
    const statePath = configPath.replace(/\.json$/, '') + '.server.json';
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    return state?.pid === supervisorPid && state?.lifecycle?.supervisor?.pid === supervisorPid;
  } catch {
    return false;
  }
}

async function stopChild(child) {
  if (child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 6500)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

function runServer(configPath) {
  const child = spawn(process.execPath, [cliPath, 'server'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('server did not exit after listen error'));
    }, 5000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

// A start that loses the port race exits through the same process-level 'exit'
// handler as a healthy shutdown. If that handler unlinks the state file
// unconditionally, the FAILED start deletes the RUNNING server's state file and
// findRunningServer loses the recorded-port leg it needs to find a server whose
// config port was edited.
test('a failed start does not delete the running server state file', async () => {
  const occupied = http.createServer((_req, res) => res.end('ok'));
  const port = await listen(occupied);
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-state-own-'));
  const configPath = join(dir, 'config.json');
  const statePath = join(dir, 'config.server.json');

  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    switchThreshold: 0.98,
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'sk-ant-test' }],
  }));

  // Stand in for a healthy server that already owns this config's state file.
  // The pid must be a LIVE process: findRunningServer legitimately clears a state
  // file whose recorded pid is dead, and that stale-cleanup path is not what this
  // test is about. Using the test runner's own pid keeps the file "owned".
  const incumbent = { pid: process.pid, port, startedAt: new Date(0).toISOString(), config: configPath };
  await writeFile(statePath, JSON.stringify(incumbent));

  try {
    const result = await runServer(configPath);
    assert.equal(result.code, 1);

    await access(statePath); // throws if the failed start unlinked it
    const after = JSON.parse(await readFile(statePath, 'utf-8'));
    assert.deepEqual(after, incumbent, 'incumbent state file must be left untouched');
  } finally {
    await close(occupied);
  }
});

test('status discovers a running server from the state PID when lsof is unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-lsof-fallback-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const fakeLsof = join(bin, 'lsof');
  await writeFile(fakeLsof, '#!/bin/sh\nexit 127\n');
  await chmod(fakeLsof, 0o755);
  const port = await unusedPort();
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'http://127.0.0.1:9', activeWarmup: false,
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'test-api-key' }],
  }));
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath, PATH: `${bin}:${process.env.PATH}` };
  const child = spawn(process.execPath, [cliPath, 'server'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitUntil(() => status(port), 'proxy did not start');
    await waitUntil(
      () => lifecycleStateReady(configPath, child.pid),
      'proxy did not write lifecycle state',
      15000,
    );
    const result = spawnSync(process.execPath, [cliPath, 'status'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Server:\s+running \(pid \d+, port \d+\)/);
  } finally {
    await stopChild(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test('lifecycle identity accepts a server launched through an absolute symlink entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-symlink-lifecycle-'));
  const linkedEntry = join(dir, 'teamcodex');
  await symlink(cliPath, linkedEntry);
  const port = await unusedPort();
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'http://127.0.0.1:9', activeWarmup: false,
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'test-api-key' }],
  }));
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
  const child = spawn(process.execPath, [linkedEntry, 'server'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitUntil(() => status(port), 'proxy did not start');
    await waitUntil(
      () => lifecycleStateReady(configPath, child.pid),
      'proxy did not write lifecycle state',
      15000,
    );
    const result = spawnSync(process.execPath, [cliPath, 'status'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Server:\s+running \(pid \d+, port \d+\)/);
  } finally {
    await stopChild(child);
    await rm(dir, { recursive: true, force: true });
  }
});
