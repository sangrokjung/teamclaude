import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Daemon-mode (non-TTY) tracing: every supervisor/worker line is timestamped,
// stop signals are logged with who/what context, and the exit reason is recorded.

const cliPath = process.env.TEAMCLAUDE_TEST_CLI
  || fileURLToPath(new URL('../src/index.js', import.meta.url));
const STAMP = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}`;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function unusedPort() {
  const holder = http.createServer();
  const port = await listen(holder);
  await close(holder);
  return port;
}

async function waitUntilListening(port, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited before listening (code ${child.exitCode})`);
    const listening = await new Promise(resolve => {
      const req = http.get({ host: '127.0.0.1', port, path: '/teamclaude/status' }, res => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.once('error', () => resolve(false));
    });
    if (listening) return;
    await delay(50);
  }
  throw new Error('server did not start listening');
}

async function startServer(t) {
  const port = await unusedPort();
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-signal-trace-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'sk-ant-test' }],
  }));
  const child = spawn(process.execPath, [cliPath, 'server'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); });
  const out = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { out.stdout += chunk; });
  child.stderr.on('data', chunk => { out.stderr += chunk; });
  // The worker inherits these pipes, so they only close once BOTH processes
  // are gone — that is the point where every trace line has been written.
  const drained = Promise.all([
    new Promise(resolve => child.stdout.once('close', resolve)),
    new Promise(resolve => child.stderr.once('close', resolve)),
  ]);
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  await waitUntilListening(port, child);
  return { child, out, drained, exited };
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms); }),
  ]);
}

test('SIGTERM to the supervisor is traced with pid/ppid/uptime/inflight and an exit reason', async t => {
  const { child, out, drained, exited } = await startServer(t);
  child.kill('SIGTERM');
  const result = await withTimeout(exited, 10_000, 'supervisor exit');
  await withTimeout(drained, 10_000, 'output drain');
  const all = `${out.stdout}\n${out.stderr}`;

  assert.deepEqual(result, { code: 0, signal: null }, all);
  assert.match(out.stderr, new RegExp(
    `^${STAMP} \\[TeamClaude\\] Supervisor received SIGTERM pid=${child.pid} ppid=${process.pid}`
    + ' uptime=\\d+\\.\\ds inflight=0 workerPid=\\d+$', 'm'), all);
  assert.match(out.stderr, new RegExp(
    `^${STAMP} \\[TeamClaude\\] Worker shutting down on SIGTERM source=signal pid=\\d+ ppid=${child.pid}`
    + ` supervisorPid=${child.pid} ipc=connected$`, 'm'), all);
  assert.match(out.stderr, new RegExp(
    `^${STAMP} \\[TeamClaude\\] Supervisor exiting reason=signal:SIGTERM code=0 pid=${child.pid}`
    + ' uptime=\\d+\\.\\ds$', 'm'), all);
  // Daemon mode: every line the supervisor or the worker wrote carries a stamp.
  for (const line of all.split('\n').filter(Boolean)) {
    assert.match(line, new RegExp(`^${STAMP}( |$)`), `unstamped line: ${JSON.stringify(line)}`);
  }
});

test('SIGHUP is traced but keeps its default (terminating) disposition', async t => {
  const { child, out, drained, exited } = await startServer(t);
  child.kill('SIGHUP');
  const result = await withTimeout(exited, 10_000, 'supervisor exit');
  await withTimeout(drained, 10_000, 'output drain');
  const all = `${out.stdout}\n${out.stderr}`;

  assert.deepEqual(result, { code: null, signal: 'SIGHUP' }, all);
  assert.match(out.stderr, new RegExp(
    `^${STAMP} \\[TeamClaude\\] Supervisor received SIGHUP pid=${child.pid} ppid=${process.pid}`, 'm'), all);
  // The orphaned worker notices the dead IPC channel and says so.
  assert.match(out.stderr, new RegExp(
    `^${STAMP} \\[TeamClaude\\] Worker shutting down on SIGTERM source=ipc-disconnect pid=\\d+`, 'm'), all);
});
