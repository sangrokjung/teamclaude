import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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
import {
  CLAUDE_SAFEGUARD_RECOVERY_PROMPT,
  CLAUDE_SAFETY_DENIAL_RECOVERY_PROMPT,
} from '../src/claude-recovery.js';
import { AccountManager } from '../src/account-manager.js';
import { parseClaudeRecoveryAccount } from '../src/claude-auth.js';
import { createProxyServer } from '../src/server.js';

const entry = process.env.TEAMCLAUDE_TEST_ENTRY
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve(server.address().port);
  }));
}

function closeServer(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

async function unusedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function waitForStatus(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, {
        signal: AbortSignal.timeout(250),
      });
      if (response.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`proxy did not become ready on port ${port}`);
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

function recoveryToken(accountUuid) {
  return `teamclaude-local-recovery:${Buffer.from(accountUuid).toString('base64url')}`;
}

test('real run keeps timeout UI-only and sends only bounded safety recovery prompts', async t => {
  const safetyMessage = 'claude-sonnet-5[1m] is temporarily unavailable, so auto mode cannot determine the safety of Bash right now. Wait briefly and then try this action again. If it keeps failing, continue with other tasks that don\'t require this action and come back to it later. Note: reading files, searching code, and other read-only operations do not require the classifier and can still be used.';
  const safeguardMessage = "API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). Our intentionally broad safeguards allow us to deliver more capabilities faster, but can sometimes flag legitimate coding, cybersecurity, and biology tasks. Claude Code can't respond to this message with Fable 5. Double press esc to edit your last message, or try a different model with /model. Send feedback with /feedback or learn more: https://support.claude.com/en/articles/15363606 Request ID: req_011CdtLkC348DZ8Vnk24bJnE";
  const scenarios = [
    {
      name: 'timeout',
      record(cwd) {
        return {
          type: 'assistant',
          cwd,
          isApiErrorMessage: true,
          error: 'server_error',
          apiErrorStatus: null,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Request timed out' }],
          },
        };
      },
      expectedPrompt: null,
    },
    {
      name: 'auto mode unavailable',
      record(cwd) {
        return {
          type: 'user',
          cwd,
          toolDenialKind: 'automode-unavailable',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              is_error: true,
              tool_use_id: 'toolu_real_test',
              content: safetyMessage,
            }],
          },
        };
      },
      expectedPrompt: CLAUDE_SAFETY_DENIAL_RECOVERY_PROMPT,
    },
    {
      name: 'safeguard refusal',
      record(cwd) {
        return {
          type: 'assistant',
          cwd,
          isApiErrorMessage: true,
          error: 'invalid_request',
          apiErrorStatus: null,
          message: {
            role: 'assistant',
            stop_reason: 'refusal',
            stop_details: { category: 'aup' },
            content: [{ type: 'text', text: safeguardMessage }],
          },
        };
      },
      expectedPrompt: CLAUDE_SAFEGUARD_RECOVERY_PROMPT,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async t => {
      const root = await mkdtemp(join(tmpdir(), 'teamclaude-run-exact-recovery-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const bin = join(root, 'bin');
      const project = join(root, 'project');
      const configPath = join(root, 'config.json');
      const claudeCalls = join(root, 'claude-calls.jsonl');
      await mkdir(bin);
      await mkdir(project);

      await writeFile(join(bin, 'claude'), `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({ args }) + '\\n');
const sessionFlag = args.indexOf('--session-id');
if (sessionFlag >= 0) {
  const sessionId = args[sessionFlag + 1];
  const dir = join(process.env.HOME, '.claude', 'projects', 'fake');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sessionId + '.jsonl'), process.env.FAKE_RECOVERY_RECORD + '\\n');
  setTimeout(() => process.exit(9), 20);
} else {
  setTimeout(() => process.exit(0), 20);
}
`, { mode: 0o755 });

      let rotateCalls = 0;
      const controlServer = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/teamclaude/status') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ switchThreshold: 0.98, accounts: [] }));
          return;
        }
        if (req.method === 'POST' && req.url === '/teamclaude/rotate') {
          rotateCalls += 1;
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'rotation must not run' }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      const port = await listen(controlServer);
      t.after(() => {
        controlServer.closeAllConnections();
        return closeServer(controlServer);
      });

      await writeFile(configPath, JSON.stringify({
        proxy: { port, apiKey: '' },
        autoResumeClaude: true,
        claudeAutoResumeMaxRetries: 1,
        claudeSafetyDenialMaxResumes: 1,
        claudeSafeguardMaxResumes: 1,
        claudeAutoResumeBackoffMs: 0,
        codexFallbackOnExhaustion: true,
        accounts: [],
      }));
      const blockedPrompt = 'blocked original prompt must not replay';
      const env = {
        ...process.env,
        HOME: root,
        PATH: `${bin}:${process.env.PATH}`,
        TEAMCLAUDE_PROVIDER: 'anthropic',
        TEAMCLAUDE_CLAUDE_BIN: join(bin, 'claude'),
        TEAMCLAUDE_CONFIG: configPath,
        FAKE_CLAUDE_CALLS: claudeCalls,
        FAKE_RECOVERY_RECORD: JSON.stringify(scenario.record(project)),
      };
      delete env.CLAUDE_CODE_OAUTH_TOKEN;

      const result = await runCli([
        'run',
        '--',
        '--model',
        'claude-fable-5',
        blockedPrompt,
      ], {
        cwd: project,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const calls = await jsonLines(claudeCalls);

      assert.equal(result.status, 0, result.stderr);
      assert.equal(rotateCalls, 0);
      assert.equal(calls.length, 2);
      const sessionId = calls[0].args[calls[0].args.indexOf('--session-id') + 1];
      const expectedArgs = scenario.expectedPrompt == null
        ? ['--resume', sessionId]
        : ['--resume', sessionId, scenario.expectedPrompt];
      assert.deepEqual(calls[1].args, expectedArgs);
      assert.doesNotMatch(calls[1].args.join(' '), new RegExp(blockedPrompt, 'i'));
      assert.doesNotMatch(calls[1].args.join(' '), /--model|permission|approve/i);
    });
  }
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

  const fakeClaude = `#!/usr/bin/env node
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
  const fakeCodex = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_CODEX_CALLS, JSON.stringify({
  args: process.argv.slice(2),
  provider: process.env.TEAMCLAUDE_PROVIDER ?? null,
}) + '\\n');
`;
  await writeFile(join(bin, 'codex'), fakeCodex, { mode: 0o755 });

  let currentAccount = 'account-a';
  let currentAccountUuid = 'uuid-a';
  let rotateCalls = 0;
  let rotateMode = 'success';
  const controlServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/teamclaude/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        switchThreshold: 0.98,
        currentAccount,
        currentAccountUuid,
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
      if (rotateMode !== 'success') {
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
      currentAccount = 'account-b';
      currentAccountUuid = 'uuid-b';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        rotated: true,
        previousAccount: 'account-a',
        previousAccountUuid: 'uuid-a',
        currentAccount,
        currentAccountUuid,
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
    TEAMCLAUDE_PROVIDER: 'anthropic',
    TEAMCODEX_CODEX_BIN: join(bin, 'codex'),
    TEAMCLAUDE_CONFIG: configPath,
    FAKE_CLAUDE_CALLS: claudeCalls,
    FAKE_CODEX_CALLS: codexCalls,
    ANTHROPIC_API_KEY: 'must-not-reach-child',
    ANTHROPIC_AUTH_TOKEN: 'must-not-reach-child',
  };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CONFIG_DIR;

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

test('real run seeds only a missing Claude OAuth marker from the production proxy status', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-run-seed-recovery-marker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const project = join(root, 'project');
  const configPath = join(root, 'config.json');
  const claudeCalls = join(root, 'claude-calls.jsonl');
  await mkdir(bin);
  await mkdir(project);

  const fakeClaude = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({
  args: process.argv.slice(2),
  oauthValue: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
}) + '\\n');
`;
  await writeFile(join(bin, 'claude'), fakeClaude, { mode: 0o755 });

  const manager = new AccountManager([
    {
      name: 'account-a',
      accountUuid: 'uuid-a',
      type: 'oauth',
      accessToken: 'secret-access-a',
      refreshToken: 'secret-refresh-a',
      expiresAt: Date.now() + 60 * 60 * 1000,
    },
    {
      name: 'account-b',
      accountUuid: 'uuid-b',
      type: 'oauth',
      accessToken: 'secret-access-b',
      refreshToken: 'secret-refresh-b',
      expiresAt: Date.now() + 60 * 60 * 1000,
    },
  ], 0.98, 0);
  manager.currentIndex = 1;
  const controlServer = createProxyServer(manager, {
    provider: 'anthropic',
    proxy: { apiKey: 'fixture-proxy-key' },
    activeWarmup: false,
    upstream: 'http://127.0.0.1:1',
  });
  const port = await listen(controlServer);
  t.after(() => {
    controlServer.closeAllConnections();
    return closeServer(controlServer);
  });

  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'fixture-proxy-key' },
    autoResumeClaude: true,
    claudeAutoResumeMaxRetries: 1,
    claudeAutoResumeBackoffMs: 0,
    codexFallbackOnExhaustion: false,
    accounts: [],
  }));

  const statusResponse = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, {
    headers: {
      'x-api-key': 'fixture-proxy-key',
      'x-teamcodex-status-identity': '1',
    },
  });
  const status = await statusResponse.json();
  assert.equal(status.currentAccountUuid, 'uuid-b');
  assert.equal('accessToken' in status.accounts[1], false);
  assert.equal('refreshToken' in status.accounts[1], false);
  assert.equal('credential' in status.accounts[1], false);
  assert.doesNotMatch(JSON.stringify(status), /secret-(?:access|refresh)-[ab]/);

  const cases = [
    {
      name: 'unmarked child',
      expectedToken: recoveryToken('uuid-b'),
    },
    {
      name: 'external OAuth token',
      initialToken: 'external-oauth-token',
      expectedToken: 'external-oauth-token',
    },
    {
      name: 'malformed recovery marker',
      initialToken: 'teamclaude-local-recovery:***',
      expectedToken: 'teamclaude-local-recovery:***',
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await writeFile(claudeCalls, '');
      const env = {
        ...process.env,
        HOME: root,
        PATH: `${bin}:${process.env.PATH}`,
        TEAMCLAUDE_PROVIDER: 'anthropic',
        TEAMCLAUDE_CONFIG: configPath,
        FAKE_CLAUDE_CALLS: claudeCalls,
      };
      if (scenario.initialToken !== undefined) {
        env.CLAUDE_CODE_OAUTH_TOKEN = scenario.initialToken;
      } else {
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
      }

      const result = await runCli(['run'], {
        cwd: project,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const calls = await jsonLines(claudeCalls);

      assert.equal(result.status, 0, `${scenario.name}: ${result.stderr}`);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].oauthValue, scenario.expectedToken);
    });
  }
  assert.equal(manager.currentIndex, 1);
});

test('real run fails closed when its seeded recovery account cannot serve the request', async t => {
  const scenarios = [
    { name: 'quota-blocked A to healthy B', quotaBlocked: true },
    { name: 'capped A to free B', quotaBlocked: false },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async st => {
      const root = await mkdtemp(join(tmpdir(), 'teamclaude-run-marker-spill-'));
      st.after(() => rm(root, { recursive: true, force: true }));
      const bin = join(root, 'bin');
      const project = join(root, 'project');
      const configPath = join(root, 'config.json');
      const claudeCalls = join(root, 'claude-calls.jsonl');
      await mkdir(bin);
      await mkdir(project);

      const fakeClaude = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const response = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
  method: 'POST',
  headers: {
    authorization: 'Bearer ' + process.env.CLAUDE_CODE_OAUTH_TOKEN,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
});
const body = await response.text();
appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({
  oauthValue: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
  responseStatus: response.status,
  body,
}) + '\\n');
process.exit(response.status === 200 ? 0 : 9);
`;
      await writeFile(join(bin, 'claude'), fakeClaude, { mode: 0o755 });

      const upstreamAuth = [];
      const upstream = http.createServer((req, res) => {
        upstreamAuth.push(req.headers.authorization);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      const upstreamPort = await listen(upstream);
      st.after(() => {
        upstream.closeAllConnections();
        return closeServer(upstream);
      });

      const manager = new AccountManager([
        {
          name: 'account-a', accountUuid: 'uuid-a', type: 'oauth',
          accessToken: 'fixture-a', expiresAt: Date.now() + 60 * 60 * 1000,
          priority: 0,
        },
        {
          name: 'account-b', accountUuid: 'uuid-b', type: 'oauth',
          accessToken: 'fixture-b', expiresAt: Date.now() + 60 * 60 * 1000,
          priority: 1,
        },
      ], 0.98, 0, 1);
      const reset = String(Math.floor((Date.now() + 60 * 60 * 1000) / 1000));
      for (const index of [0, 1]) {
        manager.updateQuota(index, {
          'anthropic-ratelimit-unified-5h-utilization': '0.1',
          'anthropic-ratelimit-unified-5h-reset': reset,
        });
      }

      let held = null;
      if (scenario.quotaBlocked) {
        manager.updateQuota(0, {
          'anthropic-ratelimit-unified-5h-utilization': '0.99',
          'anthropic-ratelimit-unified-5h-reset': reset,
        });
      } else {
        held = await manager.acquireAccount(
          null, 0, null, null, 'claude-sonnet-4-6', 'uuid-a',
        );
        assert.equal(held.accountUuid, 'uuid-a');
      }
      manager.currentIndex = 0;
      st.after(() => {
        if (held) manager.releaseAccount(held);
      });

      const proxy = createProxyServer(manager, {
        provider: 'anthropic',
        proxy: { apiKey: 'fixture-proxy-key' },
        upstream: `http://127.0.0.1:${upstreamPort}`,
        activeWarmup: false,
        continuityMode: false,
        overflowQueueTimeoutMs: 50,
      });
      const port = await listen(proxy);
      st.after(() => {
        proxy.closeAllConnections();
        return closeServer(proxy);
      });

      await writeFile(configPath, JSON.stringify({
        proxy: { port, apiKey: 'fixture-proxy-key' },
        autoResumeClaude: true,
        claudeAutoResumeMaxRetries: 0,
        claudeAutoResumeBackoffMs: 0,
        codexFallbackOnExhaustion: false,
        accounts: [],
      }));
      const env = {
        ...process.env,
        HOME: root,
        PATH: `${bin}:${process.env.PATH}`,
        TEAMCLAUDE_PROVIDER: 'anthropic',
        TEAMCLAUDE_CONFIG: configPath,
        FAKE_CLAUDE_CALLS: claudeCalls,
      };
      delete env.CLAUDE_CODE_OAUTH_TOKEN;

      const result = await runCli(['run'], {
        cwd: project,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const calls = await jsonLines(claudeCalls);
      if (held) {
        manager.releaseAccount(held);
        held = null;
      }

      assert.equal(result.status, 9, result.stderr);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].oauthValue, recoveryToken('uuid-a'));
      assert.equal(calls[0].responseStatus, 429);
      assert.deepEqual(upstreamAuth, []);
    });
  }
});

test('real run keeps failed marker B across a global drift to A and resumes with A', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-run-pinned-usage-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const project = join(root, 'project');
  const configPath = join(root, 'config.json');
  const claudeCalls = join(root, 'claude-calls.jsonl');
  await mkdir(bin);
  await mkdir(project);

  const fakeClaude = `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({
  args,
  oauthValue: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
}) + '\\n');
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

  const manager = new AccountManager([
    {
      name: 'account-a',
      accountUuid: 'uuid-a',
      type: 'oauth',
      accessToken: 'fixture-a',
      expiresAt: Date.now() + 60 * 60 * 1000,
      priority: 0,
    },
    {
      name: 'account-b',
      accountUuid: 'uuid-b',
      type: 'oauth',
      accessToken: 'fixture-b',
      expiresAt: Date.now() + 60 * 60 * 1000,
      priority: 1,
    },
    {
      name: 'account-c',
      accountUuid: 'uuid-c',
      type: 'oauth',
      accessToken: 'fixture-c',
      expiresAt: Date.now() + 60 * 60 * 1000,
      priority: 2,
    },
  ], 0.98, 0);
  manager.currentIndex = 1;
  const controlServer = createProxyServer(manager, {
    provider: 'anthropic',
    proxy: { apiKey: 'fixture-proxy-key' },
    activeWarmup: false,
    upstream: 'http://127.0.0.1:1',
  });
  const port = await listen(controlServer);
  t.after(() => {
    controlServer.closeAllConnections();
    return closeServer(controlServer);
  });

  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'fixture-proxy-key' },
    autoResumeClaude: true,
    claudeAutoResumeMaxRetries: 3,
    claudeAutoResumeBackoffMs: 0,
    codexFallbackOnExhaustion: false,
    accounts: [],
  }));
  const failedAccountUuid = 'uuid-b';
  const initialRecoveryToken = recoveryToken(failedAccountUuid);
  const replacementRecoveryToken = recoveryToken('uuid-a');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    TEAMCLAUDE_PROVIDER: 'anthropic',
    TEAMCLAUDE_CONFIG: configPath,
    FAKE_CLAUDE_CALLS: claudeCalls,
    CLAUDE_CODE_OAUTH_TOKEN: initialRecoveryToken,
  };

  const runPromise = runCli(['run', '--', '--resume', sessionId], {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const driftDeadline = Date.now() + 2000;
  let firstCalls = [];
  while (Date.now() < driftDeadline) {
    firstCalls = await jsonLines(claudeCalls);
    if (firstCalls.length > 0) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (firstCalls.length === 1) manager.currentIndex = 0;
  const recovered = await runPromise;
  const calls = await jsonLines(claudeCalls);

  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(firstCalls.length, 1, 'first child must start before the simulated global drift');
  assert.equal(firstCalls[0].oauthValue, initialRecoveryToken);
  assert.equal(manager.currentIndex, 0, 'global current drifts to A before B recovers');
  assert.deepEqual(calls.map(call => call.args), [
    ['--resume', sessionId, '--model', 'claude-sonnet-5'],
    ['--resume', sessionId, 'continue'],
  ]);
  assert.deepEqual(calls.map(call => call.oauthValue), [
    initialRecoveryToken,
    replacementRecoveryToken,
  ]);
  assert.equal(
    parseClaudeRecoveryAccount(`Bearer ${calls[0].oauthValue}`),
    failedAccountUuid,
  );
  assert.equal(
    parseClaudeRecoveryAccount(`Bearer ${calls[1].oauthValue}`),
    'uuid-a',
  );
});

test('real run parks on a tunnel ConnectionRefused and resumes only after the proxy returns', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-run-connection-refused-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const project = join(root, 'project');
  const configPath = join(root, 'config.json');
  const claudeCalls = join(root, 'claude-calls.jsonl');
  await mkdir(bin);
  await mkdir(project);

  const fakeClaude = `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({ args, at: Date.now() }) + '\\n');
const sessionFlag = args.indexOf('--session-id');
if (sessionFlag >= 0) {
  const sessionId = args[sessionFlag + 1];
  await fetch(process.env.FAKE_OUTAGE_URL, { method: 'POST' });
  const dir = join(process.env.HOME, '.claude', 'projects', 'fake');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, sessionId + '.jsonl'), JSON.stringify({
    type: 'assistant',
    cwd: process.cwd(),
    isApiErrorMessage: true,
    error: 'server_error',
    message: 'Unable to connect to API (ConnectionRefused)',
  }) + '\\n');
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => process.exit(0), 20);
}
`;
  await writeFile(join(bin, 'claude'), fakeClaude, { mode: 0o755 });

  let statusHits = 0;
  let restored = false;
  const statusServer = http.createServer((req, res) => {
    statusHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ switchThreshold: 0.98, accounts: [] }));
  });
  const port = await listen(statusServer);

  const controlServer = http.createServer((req, res) => {
    statusServer.closeAllConnections();
    statusServer.close(() => {
      res.writeHead(204);
      res.end();
      setTimeout(() => {
        statusServer.listen(port, '127.0.0.1', () => {
          restored = true;
        });
      }, 500);
    });
  });
  const controlPort = await listen(controlServer);
  t.after(async () => {
    statusServer.closeAllConnections();
    controlServer.closeAllConnections();
    await Promise.all([
      new Promise(resolve => statusServer.close(() => resolve())),
      new Promise(resolve => controlServer.close(() => resolve())),
    ]);
  });

  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'fixture-proxy-key' },
    autoResumeClaude: true,
    claudeAutoResumeMaxRetries: 1,
    claudeAutoResumeBackoffMs: 0,
    accounts: [],
  }));
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    TEAMCLAUDE_PROVIDER: 'anthropic',
    TEAMCLAUDE_CONFIG: configPath,
    FAKE_CLAUDE_CALLS: claudeCalls,
    FAKE_OUTAGE_URL: `http://127.0.0.1:${controlPort}/outage`,
  };

  const result = await runCli(['run'], {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const calls = await jsonLines(claudeCalls);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(restored, true);
  assert.ok(statusHits >= 2, `expected startup and recovery probes, got ${statusHits}`);
  assert.equal(calls.length, 2);
  const sessionId = calls[0].args[calls[0].args.indexOf('--session-id') + 1];
  assert.deepEqual(calls[1].args, ['--resume', sessionId, 'continue']);
  assert.match(result.stderr, /Local proxy connection lost/);
  assert.match(result.stderr, /Local proxy connection restored/);
});

test('real run reopens the same session once after an ambiguous-dispatch 502', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-run-ambiguous-dispatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const project = join(root, 'project');
  const configPath = join(root, 'config.json');
  const claudeCalls = join(root, 'claude-calls.jsonl');
  await mkdir(bin);
  await mkdir(project);

  await writeFile(join(bin, 'claude'), `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({
  args,
  baseUrl: process.env.ANTHROPIC_BASE_URL,
}) + '\\n');
const sessionFlag = args.indexOf('--session-id');
if (sessionFlag >= 0) {
  const sessionId = args[sessionFlag + 1];
  const dir = join(process.env.HOME, '.claude', 'projects', 'fake');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, sessionId + '.jsonl'), JSON.stringify({
    type: 'assistant',
    cwd: process.cwd(),
    isApiErrorMessage: true,
    error: 'server_error',
    apiErrorStatus: 502,
    message: {
      role: 'assistant',
      content: [{
        type: 'text',
        text: 'API Error: 502 Upstream connection failed after dispatch. Request was not replayed. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (localhost:3456).\\n\\nSend feedback with /feedback or learn more: https://support.claude.com/en/articles/15363606\\n\\nRequest ID: req_011CdtLkC348DZ8Vnk24bJnE',
      }],
    },
  }) + '\\n');
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
}
`, { mode: 0o755 });

  let statusHits = 0;
  const statusServer = http.createServer((_req, res) => {
    statusHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ switchThreshold: 0.98, accounts: [] }));
  });
  const port = await listen(statusServer);
  t.after(async () => {
    statusServer.closeAllConnections();
    await closeServer(statusServer);
  });

  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'fixture-proxy-key' },
    autoResumeClaude: true,
    claudeAutoResumeMaxRetries: 0,
    claudeAutoResumeBackoffMs: 0,
    accounts: [],
  }));
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    TEAMCLAUDE_PROVIDER: 'anthropic',
    TEAMCLAUDE_CONFIG: configPath,
    FAKE_CLAUDE_CALLS: claudeCalls,
  };

  const result = await runCli(['run'], {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const calls = await jsonLines(claudeCalls);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(statusHits >= 2, `expected startup and recovery readiness checks, got ${statusHits}`);
  assert.equal(calls.length, 2);
  const sessionId = calls[0].args[calls[0].args.indexOf('--session-id') + 1];
  assert.deepEqual(calls[1].args, ['--resume', sessionId]);
  assert.equal(calls[0].baseUrl, `http://localhost:${port}`);
  assert.equal(calls[1].baseUrl, `http://localhost:${port}`);
  assert.match(result.stderr, /did not replay the request/);
  assert.match(result.stderr, /without resending the last prompt/);
});

test('real proxy and run reopen an ambiguous session without issuing a second POST', {
  timeout: 15000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-run-ambiguous-proxy-e2e-'));
  const bin = join(root, 'bin');
  const project = join(root, 'project');
  const configPath = join(root, 'config.json');
  const claudeCalls = join(root, 'claude-calls.jsonl');
  const proxyPort = await unusedPort();
  await mkdir(bin);
  await mkdir(project);

  const upstreamMarkers = [];
  const upstreamAuths = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    upstreamMarkers.push(body.marker);
    upstreamAuths.push(req.headers.authorization || '');
    if (body.marker === 'attempt-1') {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'continued' }] }));
  });
  const upstreamPort = await listen(upstream);

  await writeFile(join(bin, 'claude'), `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const sessionFlag = args.indexOf('--session-id');
const continuePrompt = args.includes('continue');
const marker = sessionFlag >= 0 ? 'attempt-1' : 'attempt-2';
appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({ args, marker }) + '\\n');
if (sessionFlag < 0 && !continuePrompt) process.exit(0);
const response = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'test-model', messages: [], marker }),
});
const payload = await response.json();
if (sessionFlag >= 0) {
  if (response.status !== 502) process.exit(41);
  const sessionId = args[sessionFlag + 1];
  const dir = join(process.env.HOME, '.claude', 'projects', 'fake');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, sessionId + '.jsonl'), JSON.stringify({
    type: 'assistant',
    cwd: process.cwd(),
    isApiErrorMessage: true,
    error: 'server_error',
    apiErrorStatus: 502,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'API Error: 502 ' + payload.error.message }],
    },
  }) + '\\n');
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  process.exit(response.status === 200 ? 0 : 42);
}
`, { mode: 0o755 });

  await writeFile(configPath, JSON.stringify({
    proxy: { port: proxyPort, apiKey: 'fixture-proxy-key' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    tokenRefreshIntervalMs: 0,
    autoResumeClaude: true,
    claudeAutoResumeMaxRetries: 0,
    claudeAutoResumeBackoffMs: 0,
    accounts: [{ name: 'fixture', type: 'apikey', apiKey: 'fixture-upstream-key' }],
  }));
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    TEAMCLAUDE_PROVIDER: 'anthropic',
    TEAMCLAUDE_CONFIG: configPath,
    FAKE_CLAUDE_CALLS: claudeCalls,
  };
  delete env.TEAMCLAUDE_SUPERVISED_WORKER;
  delete env.TEAMCLAUDE_SUPERVISOR_PID;
  delete env.TEAMCLAUDE_SESSION_SUPERVISED;

  const supervisor = spawn(process.execPath, [entry, 'server'], {
    env,
    stdio: 'ignore',
  });
  t.after(async () => {
    if (supervisor.exitCode == null && supervisor.signalCode == null) {
      supervisor.kill('SIGTERM');
      await once(supervisor, 'exit');
    }
    upstream.closeAllConnections();
    if (upstream.listening) await closeServer(upstream);
    await rm(root, { recursive: true, force: true });
  });
  await waitForStatus(proxyPort);

  const result = await runCli(['run'], {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const calls = await jsonLines(claudeCalls);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(upstreamMarkers, ['attempt-1']);
  assert.deepEqual(
    Object.fromEntries(upstreamMarkers.map(marker => [
      marker,
      upstreamMarkers.filter(value => value === marker).length,
    ])),
    { 'attempt-1': 1 },
  );
  assert.equal(new Set(upstreamAuths).size, 1, 'launcher continuation must not rotate accounts');
  assert.equal(calls.length, 2);
  const sessionId = calls[0].args[calls[0].args.indexOf('--session-id') + 1];
  assert.deepEqual(calls[1].args, ['--resume', sessionId]);
});

test('tunnel-only run waits for the external listener instead of starting an empty local proxy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-run-tunnel-startup-'));
  const bin = join(root, 'bin');
  const project = join(root, 'project');
  const configPath = join(root, 'config.json');
  const claudeCalls = join(root, 'claude-calls.jsonl');
  const port = await unusedPort();
  let statusServer = null;
  await mkdir(bin);
  await mkdir(project);

  await writeFile(join(bin, 'claude'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({
  args: process.argv.slice(2),
  baseUrl: process.env.ANTHROPIC_BASE_URL,
}) + '\\n');
`, { mode: 0o755 });
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'fixture-proxy-key' },
    autoResumeClaude: true,
    claudeAutoResumeBackoffMs: 0,
    accounts: [],
  }));

  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    TEAMCLAUDE_PROVIDER: 'anthropic',
    TEAMCLAUDE_CONFIG: configPath,
    FAKE_CLAUDE_CALLS: claudeCalls,
  };
  delete env.TEAMCLAUDE_SUPERVISED_WORKER;
  delete env.TEAMCLAUDE_SUPERVISOR_PID;
  delete env.TEAMCLAUDE_SESSION_SUPERVISED;

  t.after(async () => {
    statusServer?.closeAllConnections();
    if (statusServer?.listening) await closeServer(statusServer);
    await runCli(['stop'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const resultPromise = runCli(['run'], {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(
    await jsonLines(claudeCalls),
    [],
    'Claude must remain parked until the external tunnel listener returns',
  );

  statusServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ switchThreshold: 0.98, accounts: [] }));
  });
  await new Promise((resolve, reject) => {
    statusServer.once('error', reject);
    statusServer.listen(port, '127.0.0.1', resolve);
  });

  const result = await resultPromise;
  assert.equal(result.status, 0, result.stderr);
  const calls = await jsonLines(claudeCalls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].baseUrl, `http://localhost:${port}`);
});

test('tunnel-only startup stops at the configured connection recovery deadline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-run-tunnel-deadline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const project = join(root, 'project');
  const configPath = join(root, 'config.json');
  const claudeCalls = join(root, 'claude-calls.jsonl');
  const port = await unusedPort();
  await mkdir(bin);
  await mkdir(project);

  await writeFile(join(bin, 'claude'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({
  args: process.argv.slice(2),
}) + '\\n');
`, { mode: 0o755 });
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'fixture-proxy-key' },
    autoResumeClaude: true,
    claudeAutoResumeBackoffMs: 0,
    continuityMaxWaitMs: 40,
    accounts: [],
  }));

  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    TEAMCLAUDE_PROVIDER: 'anthropic',
    TEAMCLAUDE_CONFIG: configPath,
    TEAMCLAUDE_CLAUDE_BIN: join(bin, 'claude'),
    FAKE_CLAUDE_CALLS: claudeCalls,
  };
  delete env.TEAMCLAUDE_SUPERVISED_WORKER;
  delete env.TEAMCLAUDE_SUPERVISOR_PID;
  delete env.TEAMCLAUDE_SESSION_SUPERVISED;

  const startedAt = Date.now();
  const result = await runCli(['run'], {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }, 1000);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.status, 1, result.stderr);
  assert.ok(elapsedMs < 750, `deadline took ${elapsedMs}ms`);
  assert.deepEqual(await jsonLines(claudeCalls), []);
  assert.match(result.stderr, /connection recovery timed out after 40ms/i);
});

test('active recovery bounds a failed local proxy start by the same deadline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-run-local-recovery-deadline-'));
  const bin = join(root, 'bin');
  const project = join(root, 'project');
  const configPath = join(root, 'config.json');
  const claudeCalls = join(root, 'claude-calls.jsonl');
  await mkdir(bin);
  await mkdir(project);

  const statusServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ switchThreshold: 0.98, accounts: [] }));
  });
  const port = await listen(statusServer);
  const foreignServer = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end('foreign listener');
  });
  const controlServer = http.createServer(async (_req, res) => {
    statusServer.closeAllConnections();
    await closeServer(statusServer);
    await new Promise((resolve, reject) => {
      foreignServer.once('error', reject);
      foreignServer.listen(port, '127.0.0.1', resolve);
    });
    res.writeHead(204);
    res.end();
  });
  const controlPort = await listen(controlServer);

  t.after(async () => {
    statusServer.closeAllConnections();
    foreignServer.closeAllConnections();
    controlServer.closeAllConnections();
    await Promise.all([
      statusServer.listening ? closeServer(statusServer) : Promise.resolve(),
      foreignServer.listening ? closeServer(foreignServer) : Promise.resolve(),
      controlServer.listening ? closeServer(controlServer) : Promise.resolve(),
    ]);
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(join(bin, 'claude'), `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({ args }) + '\\n');
const sessionFlag = args.indexOf('--session-id');
if (sessionFlag >= 0) {
  const sessionId = args[sessionFlag + 1];
  await fetch(process.env.FAKE_OUTAGE_URL, { method: 'POST' });
  const dir = join(process.env.HOME, '.claude', 'projects', 'fake');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, sessionId + '.jsonl'), JSON.stringify({
    type: 'assistant',
    cwd: process.cwd(),
    isApiErrorMessage: true,
    error: 'server_error',
    message: 'Unable to connect to API (ConnectionRefused)',
  }) + '\\n');
  process.exit(9);
}
`, { mode: 0o755 });
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'fixture-proxy-key' },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    tokenRefreshIntervalMs: 0,
    autoResumeClaude: true,
    claudeAutoResumeMaxRetries: 1,
    claudeAutoResumeBackoffMs: 0,
    continuityMaxWaitMs: 50,
    accounts: [{ name: 'fixture', type: 'apikey', apiKey: 'fixture-key' }],
  }));

  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    TEAMCLAUDE_PROVIDER: 'anthropic',
    TEAMCLAUDE_CONFIG: configPath,
    TEAMCLAUDE_CLAUDE_BIN: join(bin, 'claude'),
    FAKE_CLAUDE_CALLS: claudeCalls,
    FAKE_OUTAGE_URL: `http://127.0.0.1:${controlPort}/outage`,
  };
  delete env.TEAMCLAUDE_SUPERVISED_WORKER;
  delete env.TEAMCLAUDE_SUPERVISOR_PID;
  delete env.TEAMCLAUDE_SESSION_SUPERVISED;

  const startedAt = Date.now();
  const result = await runCli(['run'], {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }, 2000);
  const elapsedMs = Date.now() - startedAt;
  const calls = await jsonLines(claudeCalls);

  assert.equal(result.status, 1, result.stderr);
  assert.ok(elapsedMs < 1500, `local-start recovery took ${elapsedMs}ms`);
  assert.equal(calls.length, 1);
  const sessionId = calls[0].args[calls[0].args.indexOf('--session-id') + 1];
  assert.match(result.stderr, /connection recovery timed out after 50ms/i);
  assert.match(result.stderr, new RegExp(sessionId));
  assert.match(result.stderr, /preserv/i);
});

test('tunnel-only recovery follows a disk config port move without a local state file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-run-tunnel-port-move-'));
  const bin = join(root, 'bin');
  const project = join(root, 'project');
  const configPath = join(root, 'config.json');
  const claudeCalls = join(root, 'claude-calls.jsonl');
  const oldPort = await unusedPort();
  const newPort = await unusedPort();
  await mkdir(bin);
  await mkdir(project);

  const makeConfig = port => ({
    proxy: { port, apiKey: 'fixture-proxy-key' },
    autoResumeClaude: true,
    claudeAutoResumeMaxRetries: 1,
    claudeAutoResumeBackoffMs: 0,
    accounts: [],
  });
  await writeFile(configPath, JSON.stringify(makeConfig(oldPort)));

  const fakeClaude = `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({
  args,
  baseUrl: process.env.ANTHROPIC_BASE_URL,
}) + '\\n');
const sessionFlag = args.indexOf('--session-id');
if (sessionFlag >= 0) {
  const sessionId = args[sessionFlag + 1];
  await fetch(process.env.FAKE_OUTAGE_URL, { method: 'POST' });
  const dir = join(process.env.HOME, '.claude', 'projects', 'fake');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, sessionId + '.jsonl'), JSON.stringify({
    type: 'assistant',
    cwd: process.cwd(),
    isApiErrorMessage: true,
    error: 'server_error',
    message: 'Unable to connect to API (ConnectionRefused)',
  }) + '\\n');
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
}
`;
  await writeFile(join(bin, 'claude'), fakeClaude, { mode: 0o755 });

  const statusResponse = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ switchThreshold: 0.98, accounts: [] }));
  };
  const oldStatusServer = http.createServer(statusResponse);
  const newStatusServer = http.createServer(statusResponse);
  await new Promise((resolve, reject) => {
    oldStatusServer.once('error', reject);
    oldStatusServer.listen(oldPort, '127.0.0.1', resolve);
  });

  let restored = false;
  const controlServer = http.createServer(async (_req, res) => {
    await writeFile(configPath, JSON.stringify(makeConfig(newPort)));
    oldStatusServer.closeAllConnections();
    await closeServer(oldStatusServer);
    res.writeHead(204);
    res.end();
    setTimeout(() => {
      newStatusServer.listen(newPort, '127.0.0.1', () => {
        restored = true;
      });
    }, 500);
  });
  const controlPort = await listen(controlServer);

  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    TEAMCLAUDE_PROVIDER: 'anthropic',
    TEAMCLAUDE_CONFIG: configPath,
    FAKE_CLAUDE_CALLS: claudeCalls,
    FAKE_OUTAGE_URL: `http://127.0.0.1:${controlPort}/outage`,
  };
  delete env.TEAMCLAUDE_SUPERVISED_WORKER;
  delete env.TEAMCLAUDE_SUPERVISOR_PID;
  delete env.TEAMCLAUDE_SESSION_SUPERVISED;

  t.after(async () => {
    oldStatusServer.closeAllConnections();
    newStatusServer.closeAllConnections();
    controlServer.closeAllConnections();
    await Promise.all([
      oldStatusServer.listening ? closeServer(oldStatusServer) : Promise.resolve(),
      newStatusServer.listening ? closeServer(newStatusServer) : Promise.resolve(),
      controlServer.listening ? closeServer(controlServer) : Promise.resolve(),
    ]);
    await rm(root, { recursive: true, force: true });
  });

  const result = await runCli(['run'], {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const calls = await jsonLines(claudeCalls);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(restored, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].baseUrl, `http://localhost:${oldPort}`);
  assert.equal(calls[1].baseUrl, `http://localhost:${newPort}`);
  const sessionId = calls[0].args[calls[0].args.indexOf('--session-id') + 1];
  assert.deepEqual(calls[1].args, ['--resume', sessionId, 'continue']);
});

test('real run follows a replacement supervisor to its new configured port before resuming', {
  timeout: 15000,
}, async _t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-run-recovery-port-move-'));
  const bin = join(root, 'bin');
  const project = join(root, 'project');
  const configPath = join(root, 'config.json');
  const claudeCalls = join(root, 'claude-calls.jsonl');
  const oldPort = await unusedPort();
  const newPort = await unusedPort();
  await mkdir(bin);
  await mkdir(project);

  const makeConfig = port => ({
    proxy: { port, apiKey: 'fixture-proxy-key' },
    upstream: 'http://127.0.0.1:9',
    activeWarmup: false,
    tokenRefreshIntervalMs: 0,
    autoResumeClaude: true,
    claudeAutoResumeMaxRetries: 1,
    claudeAutoResumeBackoffMs: 0,
    accounts: [{ name: 'fixture', type: 'apikey', apiKey: 'fixture-upstream-key' }],
  });
  await writeFile(configPath, JSON.stringify(makeConfig(oldPort)));

  const baseEnv = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    TEAMCLAUDE_PROVIDER: 'anthropic',
    TEAMCLAUDE_CONFIG: configPath,
    FAKE_CLAUDE_CALLS: claudeCalls,
  };
  delete baseEnv.TEAMCLAUDE_SUPERVISED_WORKER;
  delete baseEnv.TEAMCLAUDE_SUPERVISOR_PID;
  delete baseEnv.TEAMCLAUDE_SESSION_SUPERVISED;
  const originalSupervisor = spawn(process.execPath, [entry, 'server'], {
    env: baseEnv,
    stdio: 'ignore',
  });
  await waitForStatus(oldPort);

  let outageTriggered = false;
  const controlServer = http.createServer(async (_req, res) => {
    outageTriggered = true;
    await writeFile(configPath, JSON.stringify(makeConfig(newPort)));
    const exited = once(originalSupervisor, 'exit');
    originalSupervisor.kill('SIGKILL');
    await exited;
    res.writeHead(204);
    res.end();
  });
  const controlPort = await listen(controlServer);
  baseEnv.FAKE_OUTAGE_URL = `http://127.0.0.1:${controlPort}/outage`;

  const fakeClaude = `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify({
  args,
  baseUrl: process.env.ANTHROPIC_BASE_URL,
}) + '\\n');
const sessionFlag = args.indexOf('--session-id');
if (sessionFlag >= 0) {
  const sessionId = args[sessionFlag + 1];
  await fetch(process.env.FAKE_OUTAGE_URL, { method: 'POST' });
  const dir = join(process.env.HOME, '.claude', 'projects', 'fake');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, sessionId + '.jsonl'), JSON.stringify({
    type: 'assistant',
    cwd: process.cwd(),
    isApiErrorMessage: true,
    error: 'server_error',
    message: 'Unable to connect to API (ConnectionRefused)',
  }) + '\\n');
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  const response = await fetch(process.env.ANTHROPIC_BASE_URL + '/teamclaude/status');
  process.exit(response.status === 200 ? 0 : 9);
}
`;
  await writeFile(join(bin, 'claude'), fakeClaude, { mode: 0o755 });

  try {
    const result = await runCli(['run'], {
      cwd: project,
      env: baseEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const calls = await jsonLines(claudeCalls);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(outageTriggered, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].baseUrl, `http://localhost:${oldPort}`);
    assert.equal(calls[1].baseUrl, `http://localhost:${newPort}`);
    const sessionId = calls[0].args[calls[0].args.indexOf('--session-id') + 1];
    assert.deepEqual(calls[1].args, ['--resume', sessionId, 'continue']);
    await waitForStatus(newPort);
  } finally {
    controlServer.closeAllConnections();
    await closeServer(controlServer);
    if (originalSupervisor.exitCode == null && originalSupervisor.signalCode == null) {
      originalSupervisor.kill('SIGKILL');
      await once(originalSupervisor, 'exit');
    }
    await runCli(['stop'], {
      env: baseEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
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

  const fakeClaude = `#!/usr/bin/env node
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
  const fakeCodex = `#!/usr/bin/env node
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
    assert.deepEqual(await jsonLines(claudeCalls), [[
      '--continue',
      '--model',
      'claude-sonnet-5',
    ]]);
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
