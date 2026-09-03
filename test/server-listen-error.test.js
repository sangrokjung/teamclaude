import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

function runServer(configPath) {
  const child = spawn(process.execPath, [cliPath, 'server'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('server did not exit after listen error'));
    }, 5000);

    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('server exits cleanly when configured port is already in use', async () => {
  const occupied = http.createServer((_req, res) => res.end('ok'));
  const port = await listen(occupied);
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    switchThreshold: 0.98,
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'sk-ant-test' }],
  }));

  try {
    const result = await runServer(configPath);
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(`Port ${port} is already in use`));
    assert.match(result.stderr, /teamcodex status/);
    assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
  } finally {
    await close(occupied);
  }
});

test('a post-listen public socket error is handled without killing the supervisor', async () => {
  const holder = http.createServer();
  const port = await listen(holder);
  await close(holder);
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-runtime-listener-error-'));
  const configPath = join(dir, 'config.json');
  const preloadPath = join(dir, 'inject-runtime-error.mjs');
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'sk-ant-test' }],
  }));
  await writeFile(preloadPath, `
import http from 'node:http';
if (process.env.TEAMCLAUDE_SUPERVISED_WORKER !== '1') {
  const originalCreateServer = http.createServer;
  http.createServer = function (...args) {
    const server = originalCreateServer.apply(this, args);
    server.once('listening', () => {
      setTimeout(() => {
        const error = new Error('synthetic post-listen EMFILE');
        error.code = 'EMFILE';
        server.emit('error', error);
      }, 300);
    });
    return server;
  };
}
`);

  const child = spawn(process.execPath, [cliPath, 'server'], {
    env: {
      ...process.env,
      TEAMCLAUDE_PROVIDER: 'anthropic',
      TEAMCLAUDE_CONFIG: configPath,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${preloadPath}`.trim(),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });

  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !stderr.includes('synthetic post-listen EMFILE')) {
      if (child.exitCode != null) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.match(stderr, /synthetic post-listen EMFILE/);
    assert.equal(child.exitCode, null, stderr);
    const response = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
    assert.equal(response.status, 200);
  } finally {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(dir, { recursive: true, force: true });
  }
});
