import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const forbiddenResumeArgs = new Set(['resume', '--resume', '--last', '--continue']);

async function startStatusServer(dir, status, statusCode = 200, closeAfterHealth = false) {
  const payload = { switchThreshold: 0.98, ...status };
  const script = join(dir, 'status-server.mjs');
  await writeFile(script, `import http from 'node:http';
const status = JSON.parse(Buffer.from(process.env.STATUS_BASE64, 'base64').toString());
const statusCode = Number(process.env.STATUS_CODE);
const closeAfterHealth = process.env.CLOSE_AFTER_HEALTH === '1';
let requestCount = 0;
const server = http.createServer((req, res) => {
  requestCount++;
  res.writeHead(requestCount === 1 ? 200 : statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(status));
  if (closeAfterHealth && requestCount === 1) {
    res.once('finish', () => server.close(() => process.exit(0)));
  }
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      STATUS_BASE64: Buffer.from(JSON.stringify(payload)).toString('base64'),
      STATUS_CODE: String(statusCode),
      CLOSE_AFTER_HEALTH: closeAfterHealth ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout });
  const [line] = await once(lines, 'line');
  return { child, lines, port: Number(line) };
}

async function stopStatusServer(server) {
  server.lines.close();
  if (server.child.exitCode != null || server.child.signalCode != null) return;
  server.child.kill('SIGTERM');
  await once(server.child, 'exit');
}

async function runModelFixture({
  status,
  statusCode = 200,
  closeAfterHealth = false,
  args = [],
  launchModel = 'claude-fable-5',
  modelFallbacks = { 'claude-fable-5': ['claude-opus-4-8'] },
}) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-run-model-'));
  let server;
  try {
    const fakeClaude = join(dir, 'claude');
    const configPath = join(dir, 'config.json');
    await writeFile(fakeClaude, `#!/usr/bin/env node
console.log(JSON.stringify({ args: process.argv.slice(2) }));
`);
    await chmod(fakeClaude, 0o755);
    server = await startStatusServer(dir, status, statusCode, closeAfterHealth);
    await writeFile(configPath, JSON.stringify({
      proxy: { port: server.port },
      switchThreshold: 0.98,
      launchModel,
      modelFallbacks,
    }));
    return spawnSync(process.execPath, [entry, 'run', ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        TEAMCLAUDE_CONFIG: configPath,
      },
    });
  } finally {
    if (server) await stopStatusServer(server);
    await rm(dir, { recursive: true, force: true });
  }
}

test('run preserves OAuth while clearing higher-precedence API credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-run-env-'));
  let server;
  try {
    server = await startStatusServer(dir, { accounts: [] });
    const fakeClaude = join(dir, 'claude');
    const configPath = join(dir, 'config.json');
    await writeFile(fakeClaude, `#!/usr/bin/env node
console.log(JSON.stringify({
  apiKey: process.env.ANTHROPIC_API_KEY ?? null,
  authToken: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
  oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
  baseUrl: process.env.ANTHROPIC_BASE_URL,
  args: process.argv.slice(2),
}));
`);
    await chmod(fakeClaude, 0o755);
    await writeFile(configPath, JSON.stringify({ proxy: { port: server.port, apiKey: 'proxy-key' } }));

    const result = spawnSync(process.execPath, [entry, 'run', '--', '--model', 'fable'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        TEAMCLAUDE_CONFIG: configPath,
        ANTHROPIC_API_KEY: 'must-not-reach-child',
        ANTHROPIC_AUTH_TOKEN: 'must-not-reach-child',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-must-reach-child',
        ANTHROPIC_BASE_URL: 'https://wrong.example',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const child = JSON.parse(result.stdout.trim());
    assert.equal(child.apiKey, null);
    assert.equal(child.authToken, null);
    assert.equal(child.oauthToken, 'oauth-must-reach-child');
    assert.equal(child.baseUrl, `http://localhost:${server.port}`);
    assert.deepEqual(child.args, ['--model', 'fable']);
  } finally {
    if (server) await stopStatusServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('run rejects an inherited supervised marker before spawning Claude', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-run-nested-supervision-'));
  let server;
  try {
    server = await startStatusServer(dir, { accounts: [] });
    const fakeClaude = join(dir, 'claude-vendor');
    const configPath = join(dir, 'config.json');
    const invocationLog = join(dir, 'invocations.log');
    await writeFile(fakeClaude, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.INVOCATION_LOG, 'spawned\\n');
`);
    await chmod(fakeClaude, 0o755);
    await writeFile(configPath, JSON.stringify({ proxy: { port: server.port } }));

    const result = spawnSync(process.execPath, [entry, 'run'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TEAMCLAUDE_PROVIDER: 'anthropic',
        TEAMCLAUDE_CONFIG: configPath,
        TEAMCLAUDE_CLAUDE_BIN: fakeClaude,
        TEAMCLAUDE_SESSION_SUPERVISED: '1',
        INVOCATION_LOG: invocationLog,
      },
    });

    assert.equal(result.status, 75, result.stderr);
    assert.match(result.stderr, /nested supervised Claude launch/i);
    await assert.rejects(readFile(invocationLog, 'utf8'), { code: 'ENOENT' });
  } finally {
    if (server) await stopStatusServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('codex run allows an inherited supervised marker for the internal handoff', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-run-supervised-handoff-'));
  const fakeCodex = join(dir, 'codex');
  const configPath = join(dir, 'teamcodex.json');
  try {
    await writeFile(fakeCodex, `#!/usr/bin/env node
console.log(JSON.stringify({ args: process.argv.slice(2) }));
`);
    await chmod(fakeCodex, 0o755);
    await writeFile(configPath, JSON.stringify({
      provider: 'codex',
      proxy: { port: 4567, apiKey: 'proxy-key' },
    }));

    const result = spawnSync(
      process.execPath,
      [entry, 'codex', 'run', '--', 'exec', 'handoff'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          TEAMCLAUDE_CONFIG: configPath,
          TEAMCLAUDE_SESSION_SUPERVISED: '1',
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()).args.slice(-2), ['exec', 'handoff']);
    assert.doesNotMatch(result.stderr, /nested supervised Claude launch/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run propagates SIGINT from Claude with a single spawn and no resume flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-run-signal-'));
  let server;
  try {
    server = await startStatusServer(dir, { accounts: [] });
    const fakeClaude = join(dir, 'claude');
    const configPath = join(dir, 'config.json');
    const logPath = join(dir, 'invocations.log');
    await writeFile(fakeClaude, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.INVOCATION_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.kill(process.pid, 'SIGINT');
`);
    await chmod(fakeClaude, 0o755);
    await writeFile(configPath, JSON.stringify({ proxy: { port: server.port, apiKey: 'proxy-key' } }));

    const result = spawnSync(
      process.execPath,
      [entry, 'run', '--', '--model', 'sonnet'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          TEAMCLAUDE_CONFIG: configPath,
          INVOCATION_LOG: logPath,
        },
      },
    );

    assert.equal(result.status, null, result.stderr);
    assert.equal(result.signal, 'SIGINT');
    const invocations = (await readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    assert.equal(invocations.length, 1, `expected one child invocation, got ${invocations.length}`);
    assert.deepEqual(invocations[0], ['--model', 'sonnet']);
    assert.deepEqual(
      invocations[0].filter(arg => forbiddenResumeArgs.has(arg)),
      [],
      `launcher added an implicit resume argument: ${JSON.stringify(invocations[0])}`,
    );
  } finally {
    if (server) await stopStatusServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('run starts Claude Code on the visible Opus 1M fallback when Fable is exhausted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-run-model-'));
  let server;
  try {
    const fakeClaude = join(dir, 'claude');
    const configPath = join(dir, 'config.json');
    await writeFile(fakeClaude, `#!/usr/bin/env node
console.log(JSON.stringify({ args: process.argv.slice(2) }));
`);
    await chmod(fakeClaude, 0o755);
    server = await startStatusServer(dir, {
      accounts: [{
        enabled: true,
        status: 'active',
        quota: {
          unified5h: 0.2,
          unified7d: 0.3,
          modelWeekly: { '7d_oi': { utilization: 1, reset: Date.now() + 3600000 } },
        },
      }],
    });
    await writeFile(configPath, JSON.stringify({
      proxy: { port: server.port, apiKey: 'proxy-key' },
      switchThreshold: 0.98,
      launchModel: 'claude-fable-5',
      modelFallbacks: { 'claude-fable-5': ['claude-opus-4-8'] },
    }));

    const result = spawnSync(process.execPath, [entry, 'run'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        TEAMCLAUDE_CONFIG: configPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()).args, ['--model', 'claude-opus-4-8[1m]']);
    assert.match(result.stderr, /launching Claude Code as claude-opus-4-8\[1m\]/);
  } finally {
    if (server) await stopStatusServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('run keeps a confirmed-available Fable model and respects an explicit other model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-run-model-'));
  let server;
  try {
    const fakeClaude = join(dir, 'claude');
    const configPath = join(dir, 'config.json');
    await writeFile(fakeClaude, `#!/usr/bin/env node
console.log(JSON.stringify({ args: process.argv.slice(2) }));
`);
    await chmod(fakeClaude, 0o755);
    server = await startStatusServer(dir, {
      accounts: [{
        enabled: true,
        status: 'active',
        quota: {
          unified5h: 1,
          unified5hReset: Date.now() - 1000,
          unified7d: 0.3,
          modelWeekly: { '7d_oi': { utilization: 0.5, reset: Date.now() + 3600000 } },
        },
      }],
    });
    await writeFile(configPath, JSON.stringify({
      proxy: { port: server.port, apiKey: 'proxy-key' },
      switchThreshold: 0.98,
      launchModel: 'claude-fable-5',
      modelFallbacks: { 'claude-fable-5': ['claude-opus-4-8'] },
    }));
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      TEAMCLAUDE_CONFIG: configPath,
    };

    const defaultResult = spawnSync(process.execPath, [entry, 'run'], { encoding: 'utf8', env });
    assert.equal(defaultResult.status, 0, defaultResult.stderr);
    assert.deepEqual(JSON.parse(defaultResult.stdout.trim()).args, ['--model', 'claude-fable-5']);

    const explicitResult = spawnSync(
      process.execPath,
      [entry, 'run', '--', '--model', 'sonnet'],
      { encoding: 'utf8', env },
    );
    assert.equal(explicitResult.status, 0, explicitResult.stderr);
    assert.deepEqual(JSON.parse(explicitResult.stdout.trim()).args, ['--model', 'sonnet']);
  } finally {
    if (server) await stopStatusServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('run does not apply Fable-only full quota evidence to an Opus launch model', async (t) => {
  const status = {
    accounts: [{
      enabled: true,
      status: 'active',
      quota: {
        unified5h: 0.2,
        unified7d: 0.3,
        modelWeekly: { '7d_oi': { utilization: 1, reset: Date.now() + 3600000 } },
      },
    }],
  };
  const modelFallbacks = { 'claude-opus-4-8': ['sonnet'] };

  await t.test('configured Opus remains Opus', async () => {
    const result = await runModelFixture({
      status,
      launchModel: 'claude-opus-4-8',
      modelFallbacks,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()).args, ['--model', 'claude-opus-4-8']);
  });

  await t.test('explicit Opus remains Opus', async () => {
    const result = await runModelFixture({
      status,
      modelFallbacks,
      args: ['--', '--model', 'claude-opus-4-8'],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()).args, ['--model', 'claude-opus-4-8']);
  });
});

test('run keeps Fable when the proxy status request fails or returns non-200', async (t) => {
  const fullStatus = {
    accounts: [{
      enabled: true,
      status: 'active',
      quota: {
        unified5h: 0.2,
        unified7d: 0.3,
        modelWeekly: { '7d_oi': { utilization: 1, reset: Date.now() + 3600000 } },
      },
    }],
  };

  await t.test('statusFailure=Fable', async () => {
    const result = await runModelFixture({ status: fullStatus, closeAfterHealth: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()).args, ['--model', 'claude-fable-5']);
  });

  await t.test('non200Status=Fable', async () => {
    const result = await runModelFixture({ status: fullStatus, statusCode: 503 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()).args, ['--model', 'claude-fable-5']);
  });
});

test('run defers Fable fallback until every general-available account is fresh and full', async (t) => {
  const fullAccount = {
    enabled: true,
    status: 'active',
    quota: {
      unified5h: 0.2,
      unified7d: 0.3,
      modelWeekly: { '7d_oi': { utilization: 1, reset: Date.now() + 3600000 } },
    },
  };
  const scenarios = [
    {
      name: 'unknown=Fable',
      account: {
        enabled: true,
        status: 'active',
        quota: { unified5h: 0.2, unified7d: 0.3 },
      },
    },
    {
      name: 'expired=Fable',
      account: {
        enabled: true,
        status: 'active',
        quota: {
          unified5h: 0.2,
          unified7d: 0.3,
          modelWeekly: { '7d_oi': { utilization: 1, reset: Date.now() - 1000 } },
        },
      },
    },
    {
      name: 'ready=Fable',
      account: {
        enabled: true,
        status: 'active',
        quota: {
          unified5h: 0.2,
          unified7d: 0.3,
          modelWeekly: { '7d_oi': { utilization: 0.5, reset: Date.now() + 3600000 } },
        },
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const result = await runModelFixture({
        status: { accounts: [fullAccount, scenario.account] },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()).args, ['--model', 'claude-fable-5']);
    });
  }
});

test('run preserves fallback when no general-available Fable candidate remains', async (t) => {
  const generallyBlocked = {
    enabled: true,
    status: 'active',
    quota: {
      unified5h: 1,
      unified5hReset: Date.now() + 3600000,
      unified7d: 0.3,
    },
  };

  await t.test('noGeneralCandidate=Opus[1m]', async () => {
    const result = await runModelFixture({ status: { accounts: [generallyBlocked] } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()).args, ['--model', 'claude-opus-4-8[1m]']);
  });

  await t.test('unusableCandidatesExcluded=Opus[1m]', async () => {
    const fullAccount = {
      enabled: true,
      status: 'active',
      quota: {
        unified5h: 0.2,
        unified7d: 0.3,
        modelWeekly: { '7d_oi': { utilization: 1, reset: Date.now() + 3600000 } },
      },
    };
    const unusable = ['disabled', 'error', 'exhausted', 'throttled'].map(status => ({
      enabled: true,
      status,
      quota: { unified5h: 0.2, unified7d: 0.3 },
    }));
    const result = await runModelFixture({
      status: { accounts: [fullAccount, ...unusable, generallyBlocked] },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()).args, ['--model', 'claude-opus-4-8[1m]']);
  });
});
