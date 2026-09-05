import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve(server.address().port);
  }));
}

function runCli(args, options, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], options);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function jsonLines(path) {
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('real run waits for a fleet-exhaustion retry hint before resuming Claude', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-run-fleet-exhausted-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const project = join(root, 'project');
  const configPath = join(root, 'config.json');
  const claudeCalls = join(root, 'claude-calls.jsonl');
  await mkdir(bin);
  await mkdir(project);

  const fakeClaude = `#!${process.execPath}
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({ args, at: Date.now() }) + '\\n');
const sessionFlag = args.indexOf('--session-id');
if (sessionFlag >= 0) {
  const sessionId = args[sessionFlag + 1];
  const dir = join(process.env.HOME, '.claude', 'projects', 'fake');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sessionId + '.jsonl'), JSON.stringify({
    type: 'assistant',
    cwd: process.cwd(),
    isApiErrorMessage: true,
    error: 'rate_limit_error',
    apiErrorStatus: 429,
    message: { role: 'assistant', content: [{ type: 'text', text:
      'API Error: Server is temporarily limiting requests (not your usage limit) · All 16 accounts exhausted. Retry in 1s.'
    }] },
  }) + '\\n');
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => process.exit(0), 20);
}
`;
  await writeFile(join(bin, 'claude'), fakeClaude, { mode: 0o755 });

  const statusServer = http.createServer((req, res) => {
    if (req.url !== '/teamclaude/status') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ switchThreshold: 0.98, accounts: [] }));
  });
  const port = await listen(statusServer);
  t.after(() => {
    statusServer.closeAllConnections();
    return new Promise(resolve => statusServer.close(resolve));
  });

  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'fixture-proxy-key' },
    autoResumeClaude: true,
    claudeAutoResumeMaxRetries: 1,
    claudeAutoResumeBackoffMs: 0,
    codexFallbackOnExhaustion: false,
    accounts: [],
  }));

  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    TEAMCLAUDE_CONFIG: configPath,
    FAKE_CLAUDE_CALLS: claudeCalls,
  };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.TEAMCLAUDE_PROVIDER;

  const startedAt = Date.now();
  const result = await runCli(['run'], {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }, 15_000);
  const calls = await jsonLines(claudeCalls);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - startedAt >= 900, 'the launcher must honor the one-second server retry hint');
  assert.equal(calls.length, 2);
  const sessionId = calls[0].args[calls[0].args.indexOf('--session-id') + 1];
  assert.deepEqual(calls[1].args, ['--resume', sessionId, 'continue']);
  assert.match(result.stderr, /waiting 1s before resuming session/);
});

test('real run Login expired rotates first and resumes the same session with recovery auth', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-run-login-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const project = join(root, 'project');
  const configDir = join(root, '.config');
  const configPath = join(root, 'config.json');
  const claudeCalls = join(root, 'claude-calls.jsonl');
  const codexCalls = join(root, 'codex-calls.jsonl');
  await mkdir(bin);
  await mkdir(project);
  await mkdir(configDir);

  const fakeClaude = `#!${process.execPath}
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({
  args,
  oauthPresent: typeof process.env.CLAUDE_CODE_OAUTH_TOKEN === 'string',
  apiKeyPresent: typeof process.env.ANTHROPIC_API_KEY === 'string',
  authTokenPresent: typeof process.env.ANTHROPIC_AUTH_TOKEN === 'string',
  supervised: process.env.TEAMCLAUDE_SESSION_SUPERVISED === '1',
}) + '\\n');
const sessionFlag = args.indexOf('--session-id');
if (sessionFlag >= 0) {
  const sessionId = args[sessionFlag + 1];
  const dir = join(process.env.HOME, '.claude', 'projects', 'fake');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sessionId + '.jsonl'), JSON.stringify({
    type: 'assistant',
    cwd: process.cwd(),
    isApiErrorMessage: true,
    error: 'authentication_failed',
    message: 'Login expired · Please run /login',
  }) + '\\n');
  process.on('SIGTERM', () => process.exit(0));
  setTimeout(() => process.exit(9), 3000);
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => process.exit(
    process.env.CLAUDE_CODE_OAUTH_TOKEN ? 0 : 42
  ), 20);
}
`;
  await writeFile(join(bin, 'claude'), fakeClaude, { mode: 0o755 });
  const fakeCodex = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_CODEX_CALLS, JSON.stringify({
  args: process.argv.slice(2),
  provider: process.env.TEAMCLAUDE_PROVIDER ?? null,
}) + '\\n');
`;
  await writeFile(join(bin, 'codex'), fakeCodex, { mode: 0o755 });

  let currentAccount = 'account-a';
  let rotateCalls = 0;
  let rotateMode = 'success';
  const controlServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/teamclaude/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        switchThreshold: 0.98,
        currentAccount,
        currentAccountUuid: currentAccount === 'account-a' ? 'uuid-a' : 'uuid-b',
        accounts: [
          { name: 'account-a', enabled: true, status: 'active', quota: {} },
          { name: 'account-b', enabled: true, status: 'active', quota: {} },
        ],
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/teamclaude/rotate') {
      if (req.headers['x-api-key'] !== 'fixture-proxy-key') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error' },
        }));
        return;
      }
      rotateCalls += 1;
      if (rotateMode !== 'success' && rotateMode !== 'same-name-different-uuid') {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: rotateMode === 'no-alternative'
              ? 'no_alternative_account'
              : 'rotation_conflict',
          },
        }));
        return;
      }
      const sameNameRotation = rotateMode === 'same-name-different-uuid';
      currentAccount = sameNameRotation ? 'account-a' : 'account-b';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        rotated: true,
        previousAccount: 'account-a',
        previousAccountUuid: 'uuid-a',
        currentAccount,
        currentAccountUuid: 'uuid-b',
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listen(controlServer);
  t.after(() => {
    controlServer.closeAllConnections();
    return new Promise(resolve => controlServer.close(resolve));
  });

  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'fixture-proxy-key' },
    autoResumeClaude: true,
    claudeAutoResumeMaxRetries: 3,
    claudeAutoResumeBackoffMs: 0,
    codexFallbackOnExhaustion: false,
    accounts: [],
  }));
  await writeFile(join(configDir, 'teamcodex.json'), JSON.stringify({
    proxy: { port },
    provider: 'codex',
  }));
  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: configDir,
    PATH: `${bin}:${process.env.PATH}`,
    TEAMCODEX_CODEX_BIN: join(bin, 'codex'),
    TEAMCLAUDE_CONFIG: configPath,
    FAKE_CLAUDE_CALLS: claudeCalls,
    FAKE_CODEX_CALLS: codexCalls,
    ANTHROPIC_API_KEY: 'must-not-reach-child',
    ANTHROPIC_AUTH_TOKEN: 'must-not-reach-child',
  };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.TEAMCLAUDE_PROVIDER;

  const result = await runCli(['run'], {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const calls = await jsonLines(claudeCalls);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(rotateCalls, 1);
  assert.equal(currentAccount, 'account-b');
  assert.equal(calls.length, 2);
  const sessionId = calls[0].args[calls[0].args.indexOf('--session-id') + 1];
  assert.deepEqual(calls[1].args, ['--resume', sessionId, 'continue']);
  assert.deepEqual(
    calls.map(call => ({
      oauthPresent: call.oauthPresent,
      apiKeyPresent: call.apiKeyPresent,
      authTokenPresent: call.authTokenPresent,
      supervised: call.supervised,
    })),
    [
      {
        oauthPresent: true,
        apiKeyPresent: false,
        authTokenPresent: false,
        supervised: true,
      },
      {
        oauthPresent: true,
        apiKeyPresent: false,
        authTokenPresent: false,
        supervised: true,
      },
    ],
  );
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-proxy-key|must-not-reach-child/);

  await writeFile(claudeCalls, '');
  currentAccount = 'account-a';
  rotateMode = 'same-name-different-uuid';
  const sameNameRotation = await runCli(['run'], {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sameNameCalls = await jsonLines(claudeCalls);
  assert.equal(sameNameRotation.status, 0, sameNameRotation.stderr);
  assert.equal(sameNameCalls.length, 2);
  const sameNameSessionId = sameNameCalls[0].args[
    sameNameCalls[0].args.indexOf('--session-id') + 1
  ];
  assert.deepEqual(
    sameNameCalls[1].args,
    ['--resume', sameNameSessionId, 'continue'],
  );

  await writeFile(claudeCalls, '');
  rotateMode = 'no-alternative';
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'fixture-proxy-key' },
    autoResumeClaude: true,
    claudeAutoResumeMaxRetries: 3,
    claudeAutoResumeBackoffMs: 0,
    codexFallbackOnExhaustion: true,
    accounts: [],
  }));
  const noAlternative = await runCli(['run'], {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(noAlternative.status, 0, noAlternative.stderr);
  assert.equal((await jsonLines(claudeCalls)).length, 1);
  const handedOff = await jsonLines(codexCalls);
  assert.equal(handedOff.length, 1);
  assert.equal(handedOff[0].provider, 'codex');
  assert.ok(handedOff[0].args.some(arg => arg.includes('teamclaude-handoffs')));

  await writeFile(claudeCalls, '');
  await writeFile(codexCalls, '');
  rotateMode = 'malformed-conflict';
  const malformedConflict = await runCli(['run'], {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(malformedConflict.status, 9, malformedConflict.stderr);
  assert.equal((await jsonLines(claudeCalls)).length, 1);
  assert.deepEqual(await jsonLines(codexCalls), []);
});

test('real run excludes a pinned failed account and rejects a rotate response that reselects it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-run-pinned-usage-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const project = join(root, 'project');
  const configPath = join(root, 'config.json');
  const claudeCalls = join(root, 'claude-calls.jsonl');
  await mkdir(bin);
  await mkdir(project);

  const fakeClaude = `#!${process.execPath}
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({ args }) + '\\n');
const resume = args.indexOf('--resume');
if (resume >= 0 && args.at(-1) !== 'continue') {
  const sessionId = args[resume + 1];
  const dir = join(process.env.HOME, '.claude', 'projects', 'fake');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, sessionId + '.jsonl'), JSON.stringify({
    type: 'assistant', cwd: process.cwd(), isApiErrorMessage: true,
    error: 'rate_limit', apiErrorStatus: 429,
    message: { role: 'assistant', content: [{ type: 'text', text:
      "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models."
    }] },
  }) + '\\n');
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => process.exit(0), 20);
}
`;
  await writeFile(join(bin, 'claude'), fakeClaude, { mode: 0o755 });

  const failedAccountUuid = 'uuid-b';
  const recoveryToken = `teamclaude-local-recovery:${Buffer.from(failedAccountUuid).toString('base64url')}`;
  let rotateAuthorization = null;
  let returnFailedAccount = false;
  const controlServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/teamclaude/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ switchThreshold: 0.98, accounts: [] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/teamclaude/rotate') {
      rotateAuthorization = req.headers.authorization ?? null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        rotated: true,
        previousAccount: 'account-b',
        previousAccountUuid: failedAccountUuid,
        currentAccount: 'account-a',
        currentAccountUuid: returnFailedAccount ? failedAccountUuid : 'uuid-a',
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listen(controlServer);
  t.after(() => {
    controlServer.closeAllConnections();
    return new Promise(resolve => controlServer.close(resolve));
  });

  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: '' },
    autoResumeClaude: true,
    claudeAutoResumeMaxRetries: 3,
    claudeAutoResumeBackoffMs: 0,
    codexFallbackOnExhaustion: false,
    accounts: [],
  }));
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    TEAMCLAUDE_PROVIDER: 'anthropic',
    TEAMCLAUDE_CONFIG: configPath,
    FAKE_CLAUDE_CALLS: claudeCalls,
    CLAUDE_CODE_OAUTH_TOKEN: recoveryToken,
  };

  const recovered = await runCli(['run', '--', '--resume', sessionId], {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(rotateAuthorization, `Bearer ${recoveryToken}`);
  assert.deepEqual((await jsonLines(claudeCalls)).map(call => call.args), [
    ['--resume', sessionId],
    ['--resume', sessionId, 'continue'],
  ]);

  await writeFile(claudeCalls, '');
  returnFailedAccount = true;
  const rejected = await runCli(['run', '--', '--resume', sessionId], {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal((await jsonLines(claudeCalls)).length, 1, rejected.stderr);
});

test('real run command isolates ambiguous sessions, resumes Claude, then hands off once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-run-recovery-'));
  const bin = join(root, 'bin');
  const project = join(root, 'project');
  const configDir = join(root, '.config');
  const claudeCalls = join(root, 'claude-calls.jsonl');
  const codexCalls = join(root, 'codex-calls.jsonl');
  await mkdir(bin);
  await mkdir(project);
  await mkdir(configDir);

  const fakeClaude = `#!${process.execPath}
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify(args) + '\\n');
const flag = args.findIndex(arg => arg === '--session-id');
if (flag >= 0) {
  const sessionId = args[flag + 1];
  const dir = join(process.env.HOME, '.claude', 'projects', 'fake');
  mkdirSync(dir, { recursive: true });
  const records = [
    { type: 'user', cwd: process.cwd(), gitBranch: 'test/recovery', message: { role: 'user', content: 'finish the recovery test' } },
    { type: 'assistant', cwd: process.cwd(), isApiErrorMessage: true, error: 'server_error', message: { role: 'assistant', content: [{ type: 'text', text: 'Request timed out' }] } },
  ];
  writeFileSync(join(dir, sessionId + '.jsonl'), records.map(JSON.stringify).join('\\n') + '\\n');
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
}
if (args.includes('--continue')) {
  setTimeout(() => {
    const record = {
      type: 'assistant',
      cwd: process.cwd(),
      isApiErrorMessage: true,
      error: 'server_error',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Request timed out' }] },
    };
    appendFileSync(process.env.FAKE_COMPETING_TRANSCRIPT, JSON.stringify(record) + '\\n');
  }, 10);
  setTimeout(() => process.exit(0), 50);
}
`;
  const fakeCodex = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_CODEX_CALLS, JSON.stringify({
  args: process.argv.slice(2),
  config: process.env.TEAMCLAUDE_CONFIG ?? null,
  provider: process.env.TEAMCLAUDE_PROVIDER ?? null,
}) + '\\n');
`;
  await writeFile(join(bin, 'claude'), fakeClaude, { mode: 0o755 });
  await writeFile(join(bin, 'codex'), fakeCodex, { mode: 0o755 });

  let utilization = 0.5;
  const statusServer = http.createServer((req, res) => {
    if (req.url !== '/teamclaude/status') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      switchThreshold: 0.98,
      accounts: [{
        enabled: true,
        status: 'active',
        quota: {
          unified7d: utilization,
          unified7dReset: new Date(Date.now() + 60_000).toISOString(),
        },
      }],
    }));
  });
  const port = await listen(statusServer);

  const baseConfig = {
    proxy: { port, apiKey: 'test-proxy-key' },
    upstream: 'http://127.0.0.1:9',
    switchThreshold: 0.98,
    autoResumeClaude: true,
    claudeAutoResumeMaxRetries: 1,
    claudeAutoResumeBackoffMs: 0,
    codexFallbackOnExhaustion: true,
    accounts: [],
  };
  const claudeConfigPath = join(root, 'custom-claude.json');
  await writeFile(claudeConfigPath, JSON.stringify(baseConfig));
  await writeFile(join(configDir, 'teamcodex.json'), JSON.stringify({
    ...baseConfig,
    provider: 'codex',
    codexFallbackOnExhaustion: false,
  }));

  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: configDir,
    PATH: `${bin}:${process.env.PATH}`,
    TEAMCODEX_CODEX_BIN: join(bin, 'codex'),
    FAKE_CLAUDE_CALLS: claudeCalls,
    FAKE_CODEX_CALLS: codexCalls,
    FAKE_COMPETING_TRANSCRIPT: join(
      root,
      '.claude',
      'projects',
      'fake',
      '11111111-1111-4111-8111-111111111111.jsonl',
    ),
    TEAMCLAUDE_CONFIG: claudeConfigPath,
  };
  delete env.TEAMCLAUDE_PROVIDER;
  await mkdir(dirname(env.FAKE_COMPETING_TRANSCRIPT), { recursive: true });
  await writeFile(
    env.FAKE_COMPETING_TRANSCRIPT,
    `${JSON.stringify({ type: 'user', cwd: project })}\n`,
  );

  try {
    utilization = 0.98;
    const ambiguous = await runCli(['run', '--', '--continue'], {
      cwd: project,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(ambiguous.status, 0, ambiguous.stderr);
    assert.deepEqual(await jsonLines(claudeCalls), [['--continue']]);
    assert.deepEqual(await jsonLines(codexCalls), []);

    await writeFile(claudeCalls, '');
    utilization = 0.5;
    const resumed = await runCli(['run'], {
      cwd: project,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    const resumedCalls = await jsonLines(claudeCalls);
    assert.equal(resumedCalls.length, 2);
    const sessionId = resumedCalls[0][resumedCalls[0].indexOf('--session-id') + 1];
    assert.deepEqual(resumedCalls[1], ['--resume', sessionId]);
    assert.deepEqual(await jsonLines(codexCalls), []);

    await writeFile(claudeCalls, '');
    utilization = 0.98;
    const handedOff = await runCli(['run'], {
      cwd: project,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(handedOff.status, 0, handedOff.stderr);
    assert.equal((await jsonLines(claudeCalls)).length, 1);
    const codex = await jsonLines(codexCalls);
    assert.equal(codex.length, 1);
    assert.ok(codex[0].args.some(arg => arg.includes('teamclaude-handoffs')));
    assert.equal(codex[0].config, null);
    assert.equal(codex[0].provider, 'codex');
    const handoffs = await readdir(join(configDir, 'teamclaude-handoffs'));
    assert.equal(handoffs.length, 1);
  } finally {
    statusServer.close();
  }
});
