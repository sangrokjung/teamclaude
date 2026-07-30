import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildClaudeRecoveryEnv,
  parseClaudeRecoveryAccount,
} from '../src/claude-auth.js';

test('buildClaudeRecoveryEnv replaces higher-precedence auth only for loopback URLs', () => {
  for (const baseUrl of [
    'http://127.0.0.1:3456',
    'http://localhost:3456',
    'http://[::1]:3456',
  ]) {
    const input = {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: 'api-key-must-be-removed',
      ANTHROPIC_AUTH_TOKEN: 'auth-token-must-be-removed',
      CLAUDE_CODE_OAUTH_TOKEN: 'stale-token-must-be-replaced',
      PRESERVED: 'yes',
    };
    const before = structuredClone(input);

    const result = buildClaudeRecoveryEnv(input, 'account-b');

    assert.deepEqual(input, before);
    assert.equal(result.ANTHROPIC_BASE_URL, baseUrl);
    assert.equal(result.PRESERVED, 'yes');
    assert.equal('ANTHROPIC_API_KEY' in result, false);
    assert.equal('ANTHROPIC_AUTH_TOKEN' in result, false);
    assert.equal(typeof result.CLAUDE_CODE_OAUTH_TOKEN, 'string');
    assert.ok(result.CLAUDE_CODE_OAUTH_TOKEN.length > 0);
    assert.notEqual(
      result.CLAUDE_CODE_OAUTH_TOKEN,
      input.CLAUDE_CODE_OAUTH_TOKEN,
    );
  }
});

test('buildClaudeRecoveryEnv rejects non-loopback and malformed recovery base URLs', () => {
  const invalidUrls = [
    undefined,
    '',
    'not-a-url',
    'https://localhost:3456',
    'http://0.0.0.0:3456',
    'http://localhost.example:3456',
    'http://user@localhost:3456',
    'http://localhost:3456/not-teamclaude',
    'http://localhost:3456/?target=remote',
    'http://localhost:3456/#remote',
  ];

  for (const baseUrl of invalidUrls) {
    const input = {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: 'unchanged-api-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'unchanged-oauth-token',
    };
    const before = structuredClone(input);

    assert.throws(
      () => buildClaudeRecoveryEnv(input, 'account-b'),
      /loopback TeamClaude URL/,
    );
    assert.deepEqual(input, before);
  }
});

test('recovery auth carries only the selected account routing hint', () => {
  const result = buildClaudeRecoveryEnv({
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456',
  }, '계정/b');

  assert.equal(
    parseClaudeRecoveryAccount(`Bearer ${result.CLAUDE_CODE_OAUTH_TOKEN}`),
    '계정/b',
  );
  for (const authorization of [
    undefined,
    '',
    'Bearer unrelated-token',
    'Basic unrelated-token',
    'Bearer teamclaude-local-recovery:',
    'Bearer teamclaude-local-recovery:not_base64url!',
  ]) {
    assert.equal(parseClaudeRecoveryAccount(authorization), null);
  }
});

if (process.env.TEAMCLAUDE_REAL_CLAUDE_QA === '1') {
  test('installed Claude recognizes the loopback recovery env as oauth_token', async t => {
    const root = await mkdtemp(join(tmpdir(), 'teamclaude-claude-auth-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const env = buildClaudeRecoveryEnv({
      ...process.env,
      HOME: root,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456',
    }, 'account-b');
    delete env.CLAUDE_CONFIG_DIR;

    const version = spawnSync('claude', ['--version'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /2\.1\.220/);

    const status = spawnSync('claude', ['auth', 'status', '--json'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(status.status, 0, status.stderr);
    const parsed = JSON.parse(status.stdout);
    assert.equal(parsed.loggedIn, true);
    assert.equal(parsed.authMethod, 'oauth_token');
  });

  test('installed Claude forwards synthetic OAuth only to a loopback fixture', {
    timeout: 15000,
  }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'teamclaude-claude-auth-http-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let child = null;
    let expectedAuthorization = null;
    let resolveRequest;
    let rejectRequest;
    const observedRequest = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const server = http.createServer((req, res) => {
      if (req.method === 'HEAD' && req.url === '/api/hello') {
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method === 'POST' && req.url?.startsWith('/v1/messages')) {
        resolveRequest({
          method: req.method,
          authorizationMatches: req.headers.authorization === expectedAuthorization,
        });
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'QA fixture complete' },
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    });

    const env = buildClaudeRecoveryEnv({
      ...process.env,
      HOME: root,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    }, 'account-b');
    delete env.CLAUDE_CONFIG_DIR;
    expectedAuthorization = `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN}`;
    child = spawn('claude', ['-p', 'reply with ok', '--output-format', 'json'], {
      env,
      stdio: 'ignore',
    });
    t.after(async () => {
      if (child.exitCode != null || child.signalCode != null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    });
    child.once('error', rejectRequest);

    const timeout = setTimeout(
      () => rejectRequest(new Error('Claude did not send a loopback messages request')),
      10000,
    );
    const observed = await observedRequest.finally(() => clearTimeout(timeout));
    if (child.exitCode == null && child.signalCode == null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }

    assert.deepEqual(observed, {
      method: 'POST',
      authorizationMatches: true,
    });
  });
}
