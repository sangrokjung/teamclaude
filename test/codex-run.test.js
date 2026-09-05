import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const forbiddenResumeArgs = new Set(['resume', '--resume', '--last', '--continue']);
const OLD_SESSION_ID = '01900000-0000-7000-8000-000000000010';
const NEW_SESSION_ID = '01900000-0000-7000-8000-000000000011';

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function codexIdToken(email, accountId, planType) {
  return jwt({
    email,
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: planType,
    },
  });
}

async function readInvocations(logPath) {
  return (await readFile(logPath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function assertSingleInvocationWithoutResume(invocations, expectedTail) {
  assert.equal(invocations.length, 1, `expected one child invocation, got ${invocations.length}`);
  assert.deepEqual(invocations[0].slice(-expectedTail.length), expectedTail);
  assert.deepEqual(
    invocations[0].filter(arg => forbiddenResumeArgs.has(arg)),
    [],
    `launcher added an implicit resume argument: ${JSON.stringify(invocations[0])}`,
  );
}

async function startStatusServer(receiptSessionId = null) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
import http from 'node:http';
const receiptSessionId = ${JSON.stringify(receiptSessionId)};
const server = http.createServer((req, res) => {
  if (req.url === '/teamclaude/codex-recovery/consume' && req.method === 'POST') {
    if (!receiptSessionId) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'not_found' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessionId: receiptSessionId }));
    return;
  }
  if (req.url !== '/teamclaude/status') {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ accounts: [], switchThreshold: 0.98 }));
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const [chunk] = await once(child.stdout, 'data');
  return { child, port: Number(String(chunk).trim()) };
}

async function stopStatusServer(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

test('teamclaude codex run launches Codex through the login-free HTTP-only provider', async () => {
  // Given
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-run-'));
  const fakeCodex = join(dir, 'codex');
  const configPath = join(dir, 'teamcodex.json');
  await writeFile(fakeCodex, `#!/usr/bin/env node
const readEnv = name => process.env[name] ?? null;
console.log(JSON.stringify({
  args: process.argv.slice(2),
  proxyToken: readEnv('TEAMCLAUDE_CODEX_PROXY_TOKEN'),
  openaiApiKey: readEnv('OPENAI_API_KEY'),
  codexApiKey: readEnv('CODEX_API_KEY'),
  codexAccessToken: readEnv('CODEX_ACCESS_TOKEN'),
}));
`);
  await chmod(fakeCodex, 0o755);
  await writeFile(configPath, JSON.stringify({
    provider: 'codex',
    proxy: { port: 4567, apiKey: 'proxy-key' },
  }));

  try {
    // When
    const result = spawnSync(
      process.execPath,
      [entry, 'codex', 'run', '--', 'exec', '--json', 'say hello'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          TEAMCODEX_CODEX_BIN: fakeCodex,
          TEAMCLAUDE_CONFIG: configPath,
          OPENAI_API_KEY: 'must-not-reach-child',
          CODEX_API_KEY: 'must-not-reach-child',
          CODEX_ACCESS_TOKEN: 'must-not-reach-child',
        },
      },
    );

    // Then
    assert.equal(result.status, 0, result.stderr);
    const child = JSON.parse(result.stdout.trim());
    assert.equal(child.proxyToken, null);
    assert.equal(child.openaiApiKey, null);
    assert.equal(child.codexApiKey, null);
    assert.equal(child.codexAccessToken, null);
    assert.deepEqual(child.args.slice(-3), ['exec', '--json', 'say hello']);
    assert.equal(child.args[1], 'model_provider="teamcodex_proxy"');
    assert.match(child.args[3], /requires_openai_auth = false/);
    assert.match(child.args[3], /supports_websockets = false/);
    assert.equal(child.args[5], 'chatgpt_base_url="http://127.0.0.1:4567"');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('teamclaude codex run rejects arguments that can bypass TeamCodex provider routing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-run-routing-'));
  const fakeCodex = join(dir, 'codex');
  const configPath = join(dir, 'teamcodex.json');
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.INVOCATION_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
`);
  await chmod(fakeCodex, 0o755);
  await writeFile(configPath, JSON.stringify({
    provider: 'codex',
    proxy: { port: 4567, apiKey: 'proxy-key' },
  }));
  const scenarios = [
    ['exec', '-c', 'model_provider="openai"', 'probe'],
    ['exec', '-cmodel_provider="openai"', 'probe'],
    ['exec', '-c=model_provider="openai"', 'probe'],
    ['exec', '--config', 'chatgpt_base_url="https://api.openai.com"', 'probe'],
    ['resume', NEW_SESSION_ID, '--remote', 'ws://127.0.0.1:9999'],
  ];

  try {
    for (const [index, scenario] of scenarios.entries()) {
      const logPath = join(dir, `invocation-${index}.log`);
      const result = spawnSync(
        process.execPath,
        [entry, 'codex', 'run', '--', ...scenario],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            TEAMCODEX_CODEX_BIN: fakeCodex,
            TEAMCLAUDE_CONFIG: configPath,
            INVOCATION_LOG: logPath,
          },
        },
      );

      assert.notEqual(result.status, 0, scenario.join(' '));
      assert.match(result.stderr, /bypasses TeamCodex provider routing/);
      await assert.rejects(readFile(logPath), { code: 'ENOENT' });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('teamclaude codex run uses a single spawn for success, non-429, and 429-style exits without implicit resume', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-run-exit-'));
  const fakeCodex = join(dir, 'codex');
  const configPath = join(dir, 'teamcodex.json');
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.INVOCATION_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.FAKE_EXIT === '429') {
  console.error('429 Too Many Requests');
  process.exit(1);
}
process.exit(Number(process.env.FAKE_EXIT));
`);
  await chmod(fakeCodex, 0o755);
  await writeFile(configPath, JSON.stringify({
    provider: 'codex',
    proxy: { port: 4567, apiKey: 'proxy-key' },
  }));

  try {
    const scenarios = [
      { name: 'success', fakeExit: '0', expectedStatus: 0 },
      { name: 'non-429', fakeExit: '23', expectedStatus: 23 },
      { name: '429-style', fakeExit: '429', expectedStatus: 1 },
    ];

    for (const scenario of scenarios) {
      const logPath = join(dir, `${scenario.name}.log`);
      const result = spawnSync(
        process.execPath,
        [entry, 'codex', 'run', '--', 'exec', 'probe'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            TEAMCODEX_CODEX_BIN: fakeCodex,
            TEAMCLAUDE_CONFIG: configPath,
            INVOCATION_LOG: logPath,
            FAKE_EXIT: scenario.fakeExit,
          },
        },
      );

      assert.equal(result.status, scenario.expectedStatus, `${scenario.name}: ${result.stderr}`);
      if (scenario.fakeExit === '429') assert.match(result.stderr, /429 Too Many Requests/);
      assertSingleInvocationWithoutResume(await readInvocations(logPath), ['exec', 'probe']);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('teamclaude codex run propagates SIGINT with a single spawn and no resume flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-run-signal-'));
  const fakeCodex = join(dir, 'codex');
  const configPath = join(dir, 'teamcodex.json');
  const logPath = join(dir, 'invocations.log');
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.INVOCATION_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.kill(process.pid, 'SIGINT');
`);
  await chmod(fakeCodex, 0o755);
  await writeFile(configPath, JSON.stringify({
    provider: 'codex',
    proxy: { port: 4567, apiKey: 'proxy-key' },
  }));

  try {
    const result = spawnSync(
      process.execPath,
      [entry, 'codex', 'run', '--', 'exec', 'probe'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          TEAMCODEX_CODEX_BIN: fakeCodex,
          TEAMCLAUDE_CONFIG: configPath,
          INVOCATION_LOG: logPath,
        },
      },
    );

    assert.equal(result.status, null, result.stderr);
    assert.equal(result.signal, 'SIGINT');
    assertSingleInvocationWithoutResume(await readInvocations(logPath), ['exec', 'probe']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('teamclaude codex run resumes the newly bound exact cmux checkpoint once after child error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-run-recovery-'));
  const fakeCodex = join(dir, 'codex');
  const fakeCmux = join(dir, 'cmux');
  const configPath = join(dir, 'teamcodex.json');
  const logPath = join(dir, 'invocations.log');
  const bindingPath = join(dir, 'binding.json');
  const statusServer = await startStatusServer(NEW_SESSION_ID);
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
appendFileSync(process.env.INVOCATION_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const attempts = readFileSync(process.env.INVOCATION_LOG, 'utf8').trim().split('\\n').length;
if (attempts === 1) {
  writeFileSync(process.env.BINDING_PATH, process.env.CMUX_AFTER);
  console.error('HTTP 502: Upstream connection failed after dispatch. Request was not replayed.');
  process.exit(1);
}
process.exit(0);
`);
  await writeFile(fakeCmux, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
process.stdout.write(readFileSync(process.env.BINDING_PATH, 'utf8'));
`);
  await Promise.all([
    chmod(fakeCodex, 0o755),
    chmod(fakeCmux, 0o755),
    writeFile(bindingPath, JSON.stringify({
      resume_binding: { kind: 'codex', checkpoint_id: OLD_SESSION_ID },
    })),
    writeFile(configPath, JSON.stringify({
      provider: 'codex',
      proxy: { port: statusServer.port, apiKey: 'proxy-key' },
    })),
  ]);

  try {
    const result = spawnSync(
      process.execPath,
      [entry, 'codex', 'run', '--', 'exec', 'probe'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          TEAMCODEX_CODEX_BIN: fakeCodex,
          TEAMCLAUDE_CONFIG: configPath,
          CMUX_SURFACE_ID: 'surface-recovery-test',
          INVOCATION_LOG: logPath,
          BINDING_PATH: bindingPath,
          CMUX_AFTER: JSON.stringify({
            resume_binding: { kind: 'codex', checkpoint_id: NEW_SESSION_ID },
          }),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /resuming its trusted exact session/i);
    assert.doesNotMatch(result.stderr, new RegExp(NEW_SESSION_ID));
    const invocations = await readInvocations(logPath);
    assert.equal(invocations.length, 2);
    assert.deepEqual(invocations[1].slice(0, 2), ['resume', NEW_SESSION_ID]);
    assert.equal(invocations[1].includes('--all'), false);
    assert.equal(invocations[1].includes('--last'), false);
    assert.ok(invocations[1].includes('model_provider="teamcodex_proxy"'));
  } finally {
    await stopStatusServer(statusServer.child);
    await rm(dir, { recursive: true, force: true });
  }
});

test('teamclaude codex run resumes a receipt-bound checkpoint created on an empty cmux surface', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-run-empty-surface-'));
  const fakeCodex = join(dir, 'codex');
  const fakeCmux = join(dir, 'cmux');
  const configPath = join(dir, 'teamcodex.json');
  const logPath = join(dir, 'invocations.log');
  const bindingPath = join(dir, 'binding.json');
  const statusServer = await startStatusServer(NEW_SESSION_ID);
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
appendFileSync(process.env.INVOCATION_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const attempts = readFileSync(process.env.INVOCATION_LOG, 'utf8').trim().split('\\n').length;
if (attempts === 1) {
  writeFileSync(process.env.BINDING_PATH, process.env.CMUX_AFTER);
  process.exit(1);
}
process.exit(0);
`);
  await writeFile(fakeCmux, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
process.stdout.write(readFileSync(process.env.BINDING_PATH, 'utf8'));
`);
  await Promise.all([
    chmod(fakeCodex, 0o755),
    chmod(fakeCmux, 0o755),
    writeFile(bindingPath, JSON.stringify({})),
    writeFile(configPath, JSON.stringify({
      provider: 'codex',
      proxy: { port: statusServer.port, apiKey: 'proxy-key' },
    })),
  ]);

  try {
    const result = spawnSync(
      process.execPath,
      [entry, 'codex', 'run', '--', 'exec', 'probe'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          TEAMCODEX_CODEX_BIN: fakeCodex,
          TEAMCLAUDE_CONFIG: configPath,
          CMUX_SURFACE_ID: 'surface-empty-recovery-test',
          INVOCATION_LOG: logPath,
          BINDING_PATH: bindingPath,
          CMUX_AFTER: JSON.stringify({
            resume_binding: { kind: 'codex', checkpoint_id: NEW_SESSION_ID },
          }),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const invocations = await readInvocations(logPath);
    assert.equal(invocations.length, 2);
    assert.deepEqual(invocations[1].slice(0, 2), ['resume', NEW_SESSION_ID]);
  } finally {
    await stopStatusServer(statusServer.child);
    await rm(dir, { recursive: true, force: true });
  }
});

test('teamclaude codex run does not resume a fresh binding after an unrelated child error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-run-nonproxy-error-'));
  const fakeCodex = join(dir, 'codex');
  const fakeCmux = join(dir, 'cmux');
  const configPath = join(dir, 'teamcodex.json');
  const logPath = join(dir, 'invocations.log');
  const bindingPath = join(dir, 'binding.json');
  const statusServer = await startStatusServer();
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
appendFileSync(process.env.INVOCATION_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
writeFileSync(process.env.BINDING_PATH, process.env.CMUX_AFTER);
console.error('invalid configuration');
process.exit(7);
`);
  await writeFile(fakeCmux, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
process.stdout.write(readFileSync(process.env.BINDING_PATH, 'utf8'));
`);
  await Promise.all([
    chmod(fakeCodex, 0o755),
    chmod(fakeCmux, 0o755),
    writeFile(bindingPath, JSON.stringify({
      resume_binding: { kind: 'codex', checkpoint_id: OLD_SESSION_ID },
    })),
    writeFile(configPath, JSON.stringify({
      provider: 'codex',
      proxy: { port: statusServer.port, apiKey: 'proxy-key' },
    })),
  ]);

  try {
    const result = spawnSync(
      process.execPath,
      [entry, 'codex', 'run', '--', 'exec', 'probe'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          TEAMCODEX_CODEX_BIN: fakeCodex,
          TEAMCLAUDE_CONFIG: configPath,
          CMUX_SURFACE_ID: 'surface-nonproxy-error-test',
          INVOCATION_LOG: logPath,
          BINDING_PATH: bindingPath,
          CMUX_AFTER: JSON.stringify({
            resume_binding: { kind: 'codex', checkpoint_id: NEW_SESSION_ID },
          }),
        },
      },
    );

    assert.equal(result.status, 7, result.stderr);
    assertSingleInvocationWithoutResume(await readInvocations(logPath), ['exec', 'probe']);
  } finally {
    await stopStatusServer(statusServer.child);
    await rm(dir, { recursive: true, force: true });
  }
});

test('teamclaude codex run rejects a recovery receipt for another cmux checkpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-run-receipt-mismatch-'));
  const fakeCodex = join(dir, 'codex');
  const fakeCmux = join(dir, 'cmux');
  const configPath = join(dir, 'teamcodex.json');
  const logPath = join(dir, 'invocations.log');
  const bindingPath = join(dir, 'binding.json');
  const otherSessionId = '01900000-0000-7000-8000-000000000012';
  const statusServer = await startStatusServer(otherSessionId);
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
appendFileSync(process.env.INVOCATION_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
writeFileSync(process.env.BINDING_PATH, process.env.CMUX_AFTER);
process.exit(1);
`);
  await writeFile(fakeCmux, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
process.stdout.write(readFileSync(process.env.BINDING_PATH, 'utf8'));
`);
  await Promise.all([
    chmod(fakeCodex, 0o755),
    chmod(fakeCmux, 0o755),
    writeFile(bindingPath, JSON.stringify({
      resume_binding: { kind: 'codex', checkpoint_id: OLD_SESSION_ID },
    })),
    writeFile(configPath, JSON.stringify({
      provider: 'codex',
      proxy: { port: statusServer.port, apiKey: 'proxy-key' },
    })),
  ]);

  try {
    const result = spawnSync(
      process.execPath,
      [entry, 'codex', 'run', '--', 'exec', 'probe'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          TEAMCODEX_CODEX_BIN: fakeCodex,
          TEAMCLAUDE_CONFIG: configPath,
          CMUX_SURFACE_ID: 'surface-receipt-mismatch-test',
          INVOCATION_LOG: logPath,
          BINDING_PATH: bindingPath,
          CMUX_AFTER: JSON.stringify({
            resume_binding: { kind: 'codex', checkpoint_id: NEW_SESSION_ID },
          }),
        },
      },
    );

    assert.equal(result.status, 1, result.stderr);
    assertSingleInvocationWithoutResume(await readInvocations(logPath), ['exec', 'probe']);
  } finally {
    await stopStatusServer(statusServer.child);
    await rm(dir, { recursive: true, force: true });
  }
});

test('teamclaude codex recovery readiness obeys the five-second total deadline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-run-recovery-deadline-'));
  const fakeCodex = join(dir, 'codex');
  const fakeCmux = join(dir, 'cmux');
  const preload = join(dir, 'virtual-clock.mjs');
  const configPath = join(dir, 'teamcodex.json');
  const bindingPath = join(dir, 'binding.json');
  const cmuxCallPath = join(dir, 'cmux-calls.log');
  const clockPath = join(dir, 'clock.txt');
  const preloadLogPath = join(dir, 'preload.log');
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.BINDING_PATH, process.env.CMUX_AFTER);
process.exit(19);
`);
  await writeFile(fakeCmux, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(process.env.CMUX_CALL_PATH, 'call\\n');
const calls = readFileSync(process.env.CMUX_CALL_PATH, 'utf8').trim().split('\\n').length;
if (calls === 1) process.stdout.write(readFileSync(process.env.BINDING_PATH, 'utf8'));
else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
`);
  await writeFile(preload, `
import { appendFileSync, writeFileSync } from 'node:fs';
let clock = 0;
let fetchCalls = 0;
appendFileSync(process.env.PRELOAD_LOG_PATH, JSON.stringify({
  pid: process.pid,
  supervised: process.env.TEAMCLAUDE_SESSION_SUPERVISED ?? null,
  argv: process.argv,
}) + '\\n');
if (!process.env.TEAMCLAUDE_SESSION_SUPERVISED) {
  Date.now = () => clock;
  globalThis.setTimeout = (callback, ms, ...args) => {
    clock += Number(ms) || 0;
    queueMicrotask(() => callback(...args));
    return 1;
  };
  globalThis.clearTimeout = () => {};
  AbortSignal.timeout = ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  };
  globalThis.fetch = async (_url, { signal } = {}) => {
    fetchCalls += 1;
    if (fetchCalls >= 5) {
      return {
        status: 200,
        ok: true,
        json: async () => ({ sessionId: ${JSON.stringify(NEW_SESSION_ID)} }),
      };
    }
    return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('aborted'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    });
  };
  process.on('exit', () => {
    appendFileSync(process.env.PRELOAD_LOG_PATH, JSON.stringify({
      pid: process.pid,
      exitClock: clock,
    }) + '\\n');
    if (clock > 0) writeFileSync(process.env.CLOCK_PATH, String(clock));
  });
}
`);
  await Promise.all([
    chmod(fakeCodex, 0o755),
    chmod(fakeCmux, 0o755),
    writeFile(bindingPath, JSON.stringify({
      resume_binding: { kind: 'codex', checkpoint_id: OLD_SESSION_ID },
    })),
    writeFile(configPath, JSON.stringify({
      provider: 'codex',
      proxy: { port: 4567, apiKey: 'proxy-key' },
    })),
  ]);

  try {
    const wallStartedAt = Date.now();
    const result = spawnSync(
      process.execPath,
      [entry, 'codex', 'run', '--', 'exec', 'probe'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${preload}`,
          TEAMCLAUDE_SESSION_SUPERVISED: '',
          PATH: `${dir}:${process.env.PATH}`,
          TEAMCODEX_CODEX_BIN: fakeCodex,
          TEAMCLAUDE_CONFIG: configPath,
          CMUX_SURFACE_ID: 'surface-recovery-deadline-test',
          CMUX_CALL_PATH: cmuxCallPath,
          BINDING_PATH: bindingPath,
          CMUX_AFTER: JSON.stringify({
            resume_binding: { kind: 'codex', checkpoint_id: NEW_SESSION_ID },
          }),
          CLOCK_PATH: clockPath,
          PRELOAD_LOG_PATH: preloadLogPath,
        },
      },
    );

    assert.equal(result.status, 19, result.stderr);
    const wallElapsedMs = Date.now() - wallStartedAt;
    const elapsedMs = Number(await readFile(clockPath, 'utf8').catch(async (err) => {
      err.message += `; preload=${await readFile(preloadLogPath, 'utf8')}`;
      throw err;
    }));
    assert.ok(elapsedMs > 0, 'virtual deadline clock was not installed');
    assert.ok(elapsedMs <= 5000, `virtual elapsed ${elapsedMs}ms exceeded 5000ms`);
    assert.ok(wallElapsedMs <= 1500, `recovery overran its remaining deadline by ${wallElapsedMs}ms`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('teamclaude codex run fails closed for stale or invalid checkpoints, cancel, and repeated recovery failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-run-recovery-edge-'));
  const fakeCodex = join(dir, 'codex');
  const fakeCmux = join(dir, 'cmux');
  const configPath = join(dir, 'teamcodex.json');
  const statusServer = await startStatusServer(NEW_SESSION_ID);
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
appendFileSync(process.env.INVOCATION_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const attempts = readFileSync(process.env.INVOCATION_LOG, 'utf8').trim().split('\\n').length;
if (attempts === 1) writeFileSync(process.env.BINDING_PATH, process.env.CMUX_AFTER);
process.exit(Number(attempts === 1 ? process.env.FIRST_EXIT : process.env.SECOND_EXIT));
`);
  await writeFile(fakeCmux, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
process.stdout.write(readFileSync(process.env.BINDING_PATH, 'utf8'));
`);
  await Promise.all([
    chmod(fakeCodex, 0o755),
    chmod(fakeCmux, 0o755),
    writeFile(configPath, JSON.stringify({
      provider: 'codex',
      proxy: { port: statusServer.port, apiKey: 'proxy-key' },
    })),
  ]);
  const oldBinding = JSON.stringify({
    resume_binding: { kind: 'codex', checkpoint_id: OLD_SESSION_ID },
  });
  const newBinding = JSON.stringify({
    resume_binding: { kind: 'codex', checkpoint_id: NEW_SESSION_ID },
  });
  const scenarios = [
    { name: 'stale', before: oldBinding, after: oldBinding, first: 7, second: 0, calls: 1, status: 7 },
    { name: 'unreadable-baseline', before: '{not-json', after: newBinding, first: 6, second: 0, calls: 1, status: 6 },
    { name: 'missing', before: oldBinding, after: '{}', first: 8, second: 0, calls: 1, status: 8 },
    { name: 'malformed', before: oldBinding, after: '{not-json', first: 9, second: 0, calls: 1, status: 9 },
    { name: 'cancel', before: oldBinding, after: newBinding, first: 130, second: 0, calls: 1, status: 130 },
    { name: 'bounded', before: oldBinding, after: newBinding, first: 10, second: 17, calls: 2, status: 17 },
  ];

  try {
    for (const scenario of scenarios) {
      const bindingPath = join(dir, `${scenario.name}-binding.json`);
      const logPath = join(dir, `${scenario.name}-invocations.log`);
      await writeFile(bindingPath, scenario.before);
      const result = spawnSync(
        process.execPath,
        [entry, 'codex', 'run', '--', 'exec', 'probe'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            TEAMCODEX_CODEX_BIN: fakeCodex,
            TEAMCLAUDE_CONFIG: configPath,
            CMUX_SURFACE_ID: 'surface-recovery-edge-test',
            INVOCATION_LOG: logPath,
            BINDING_PATH: bindingPath,
            CMUX_AFTER: scenario.after,
            FIRST_EXIT: String(scenario.first),
            SECOND_EXIT: String(scenario.second),
          },
        },
      );

      assert.equal(result.status, scenario.status, `${scenario.name}: ${result.stderr}`);
      const invocations = await readInvocations(logPath);
      assert.equal(invocations.length, scenario.calls, scenario.name);
      if (scenario.calls === 2) {
        assert.deepEqual(invocations[1].slice(0, 2), ['resume', NEW_SESSION_ID]);
      } else {
        assert.deepEqual(invocations[0].filter(arg => forbiddenResumeArgs.has(arg)), []);
      }
    }
  } finally {
    await stopStatusServer(statusServer.child);
    await rm(dir, { recursive: true, force: true });
  }
});

test('teamclaude codex resume retries the same explicit session without submitting its prompt twice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-resume-recovery-'));
  const fakeCodex = join(dir, 'codex');
  const configPath = join(dir, 'teamcodex.json');
  const logPath = join(dir, 'invocations.log');
  const statusServer = await startStatusServer(NEW_SESSION_ID);
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(process.env.INVOCATION_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const attempts = readFileSync(process.env.INVOCATION_LOG, 'utf8').trim().split('\\n').length;
process.exit(attempts === 1 ? 12 : 0);
`);
  await Promise.all([
    chmod(fakeCodex, 0o755),
    writeFile(configPath, JSON.stringify({
      provider: 'codex',
      proxy: { port: statusServer.port, apiKey: 'proxy-key' },
    })),
  ]);

  try {
    const result = spawnSync(
      process.execPath,
      [entry, 'codex', 'resume', NEW_SESSION_ID, '--', '--model', 'fable', 'submit-once'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          TEAMCODEX_CODEX_BIN: fakeCodex,
          TEAMCLAUDE_CONFIG: configPath,
          INVOCATION_LOG: logPath,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const invocations = await readInvocations(logPath);
    assert.equal(invocations.length, 2);
    const firstResumeIndex = invocations[0].indexOf('resume');
    assert.deepEqual(
      invocations[0].slice(firstResumeIndex, firstResumeIndex + 5),
      ['resume', NEW_SESSION_ID, '--model', 'fable', 'submit-once'],
    );
    const retryResumeIndex = invocations[1].indexOf('resume');
    assert.deepEqual(
      invocations[1].slice(retryResumeIndex, retryResumeIndex + 4),
      ['resume', NEW_SESSION_ID, '--model', 'fable'],
    );
    assert.equal(invocations[1].includes('submit-once'), false);
  } finally {
    await stopStatusServer(statusServer.child);
    await rm(dir, { recursive: true, force: true });
  }
});

test('teamclaude codex import creates a separate Codex account pool', async () => {
  // Given
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-import-'));
  const authPath = join(dir, 'auth.json');
  await writeFile(authPath, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: codexIdToken('pool@example.com', 'acct', 'pro'),
      access_token: jwt({ exp: 1_900_000_000 }),
      refresh_token: 'refresh-pool',
      account_id: 'acct',
    },
  }));

  try {
    // When
    const result = spawnSync(
      process.execPath,
      [entry, 'codex', 'import', '--from', authPath, '--name', 'pooled-pro'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          XDG_CONFIG_HOME: dir,
          TEAMCLAUDE_CONFIG: '',
        },
      },
    );

    // Then
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(await readFile(join(dir, 'teamcodex.json'), 'utf8'));
    assert.equal(config.provider, 'codex');
    assert.equal(config.proxy.port, 3457);
    assert.equal(config.upstream, 'https://chatgpt.com/backend-api/codex');
    assert.deepEqual(config.accounts.map(account => ({
      name: account.name,
      provider: account.provider,
      accountUuid: account.accountUuid,
      accountId: account.accountId,
      planType: account.planType,
    })), [{
      name: 'pooled-pro',
      provider: 'codex',
      accountUuid: 'acct',
      accountId: 'acct',
      planType: 'pro',
    }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('teamclaude codex login keeps the official login in an isolated CODEX_HOME', async () => {
  // Given
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-login-'));
  const fakeCodex = join(dir, 'codex');
  const auth = {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: codexIdToken('isolated@example.com', 'acct', 'plus'),
      access_token: jwt({ exp: 1_900_000_000 }),
      refresh_token: 'refresh-isolated',
      account_id: 'acct',
    },
  };
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
mkdirSync(process.env.CODEX_HOME, { recursive: true });
writeFileSync(join(process.env.CODEX_HOME, 'auth.json'), ${JSON.stringify(JSON.stringify(auth))});
`);
  await chmod(fakeCodex, 0o755);

  try {
    // When
    const result = spawnSync(
      process.execPath,
      [entry, 'codex', 'login', '--name', 'isolated-plus'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          TEAMCODEX_CODEX_BIN: fakeCodex,
          XDG_CONFIG_HOME: dir,
          TEAMCLAUDE_CONFIG: '',
        },
      },
    );

    // Then
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(await readFile(join(dir, 'teamcodex.json'), 'utf8'));
    assert.equal(config.accounts.length, 1);
    assert.equal(config.accounts[0].name, 'isolated-plus');
    assert.equal(config.accounts[0].accountId, 'acct');
    assert.equal(config.accounts[0].planType, 'plus');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
