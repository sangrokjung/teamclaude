import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise(resolve => server.close(resolve));
}

function runCli(args, env) {
  return new Promise(resolve => {
    execFile(process.execPath, [entry, ...args], { encoding: 'utf8', env }, (error, stdout, stderr) => {
      resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

test('api rejects absolute destinations before attaching an account credential', async () => {
  let sinkHits = 0;
  const sink = http.createServer((_req, res) => {
    sinkHits += 1;
    res.writeHead(200).end('unexpected');
  });
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-api-origin-'));

  try {
    const sinkPort = await listen(sink);
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({
      proxy: { port: 0, apiKey: 'tc-fixture-key' },
      upstream: 'https://api.anthropic.com',
      accounts: [{ name: 'fixture', type: 'apikey', apiKey: 'fixture-account-key' }],
    }));
    const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
    delete env.TEAMCLAUDE_PROVIDER;

    const result = await runCli([
      'api', `http://127.0.0.1:${sinkPort}/capture`, '--account', 'fixture',
    ], env);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /relative API path/);
    assert.equal(sinkHits, 0);
  } finally {
    await Promise.all([close(sink), rm(dir, { recursive: true, force: true })]);
  }
});

test('api does not forward credentials across an upstream redirect', async () => {
  let redirectedHits = 0;
  const redirected = http.createServer((_req, res) => {
    redirectedHits += 1;
    res.writeHead(200).end('unexpected');
  });
  let redirector;
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-api-redirect-'));

  try {
    const redirectedPort = await listen(redirected);
    redirector = http.createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${redirectedPort}/capture` });
      res.end();
    });
    const redirectorPort = await listen(redirector);
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({
      proxy: { port: 0, apiKey: 'tc-fixture-key' },
      upstream: `http://127.0.0.1:${redirectorPort}`,
      accounts: [{ name: 'fixture', type: 'apikey', apiKey: 'fixture-account-key' }],
    }));
    const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
    delete env.TEAMCLAUDE_PROVIDER;

    const result = await runCli(['api', '/redirect', '--account', 'fixture'], env);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /^302 /m);
    assert.equal(redirectedHits, 0);
  } finally {
    await Promise.all([
      close(redirector),
      close(redirected),
      rm(dir, { recursive: true, force: true }),
    ]);
  }
});
