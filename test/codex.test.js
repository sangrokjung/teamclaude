import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import {
  buildCodexProxyArgs,
  codexCliNotFoundMessage,
  importCodexCredentials,
  refreshCodexAccessToken,
  resolveCodexCliBin,
} from '../src/codex.js';

function jwt(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${encoded}.signature`;
}

test('importCodexCredentials parses the official Codex auth.json shape', async () => {
  // Given
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-auth-'));
  const authPath = join(dir, 'auth.json');
  const expiresAt = 1_900_000_000;
  await writeFile(authPath, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt({
        email: 'codex@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'account-from-id-token',
          chatgpt_plan_type: 'pro',
        },
      }),
      access_token: jwt({
        exp: expiresAt,
        'https://api.openai.com/profile': { email: 'codex@example.com' },
      }),
      refresh_token: 'refresh-token',
      account_id: 'account-from-auth-json',
    },
  }));

  try {
    // When
    const credentials = await importCodexCredentials(authPath);

    // Then
    assert.deepEqual(credentials, {
      accessToken: jwt({
        exp: expiresAt,
        'https://api.openai.com/profile': { email: 'codex@example.com' },
      }),
      refreshToken: 'refresh-token',
      idToken: jwt({
        email: 'codex@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'account-from-id-token',
          chatgpt_plan_type: 'pro',
        },
      }),
      accountId: 'account-from-auth-json',
      accountUuid: 'account-from-auth-json',
      email: 'codex@example.com',
      planType: 'pro',
      expiresAt: expiresAt * 1000,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refreshCodexAccessToken uses the official Codex refresh contract', async () => {
  // Given
  let received;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {
      method: req.method,
      contentType: req.headers['content-type'],
      body: JSON.parse(Buffer.concat(chunks).toString()),
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      access_token: jwt({ exp: 1_900_000_100 }),
      refresh_token: 'next-refresh-token',
      id_token: jwt({
        email: 'next@example.com',
        'https://api.openai.com/auth': { chatgpt_account_id: 'next-account' },
      }),
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/oauth/token`;

  try {
    // When
    const refreshed = await refreshCodexAccessToken('old-refresh-token', endpoint);

    // Then
    assert.deepEqual(received, {
      method: 'POST',
      contentType: 'application/json',
      body: {
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        grant_type: 'refresh_token',
        refresh_token: 'old-refresh-token',
      },
    });
    assert.equal(refreshed.refreshToken, 'next-refresh-token');
    assert.equal(refreshed.accountId, 'next-account');
    assert.equal(refreshed.email, 'next@example.com');
    assert.equal(refreshed.expiresAt, 1_900_000_100_000);
  } finally {
    server.close();
  }
});

test('buildCodexProxyArgs uses a login-free HTTP-only local provider', () => {
  // Given
  const userArgs = ['exec', '--json', 'say hello'];

  // When
  const args = buildCodexProxyArgs(4567, userArgs);

  // Then
  assert.deepEqual(args.slice(-3), userArgs);
  assert.equal(args[0], '-c');
  assert.equal(args[1], 'model_provider="teamcodex_proxy"');
  assert.equal(args[2], '-c');
  assert.match(args[3], /base_url = "http:\/\/127\.0\.0\.1:4567\/codex"/);
  assert.match(args[3], /requires_openai_auth = false/);
  assert.match(args[3], /supports_websockets = false/);
  assert.match(
    args[3],
    /env_http_headers = \{ "X-TeamCodex-Invocation" = "TEAMCODEX_INVOCATION_ID" \}/,
  );
  assert.doesNotMatch(args[3], /env_key/);
  assert.equal(args[4], '-c');
  assert.equal(args[5], 'chatgpt_base_url="http://127.0.0.1:4567"');
});

test('resolveCodexCliBin prefers env override, then the node-sibling CLI, then PATH', () => {
  // Given: an explicit override always wins
  assert.equal(
    resolveCodexCliBin({
      env: { TEAMCODEX_CODEX_BIN: '/opt/custom/codex' },
      execPath: '/nodes/v24/bin/node',
      exists: () => true,
    }),
    '/opt/custom/codex',
  );

  // Given: no override — the CLI co-installed with this Node beats a PATH
  // lookup that a shell wrapper/symlink may shadow
  assert.equal(
    resolveCodexCliBin({
      env: {},
      execPath: '/nodes/v24/bin/node',
      exists: p => p === join('/nodes/v24/bin', 'codex'),
    }),
    join('/nodes/v24/bin', 'codex'),
  );

  // Given: neither — bare PATH lookup is the legacy fallback
  assert.equal(
    resolveCodexCliBin({ env: {}, execPath: '/nodes/v24/bin/node', exists: () => false }),
    'codex',
  );

  // Given: win32 — the extension-less sibling is npm's unspawnable POSIX shim,
  // so the bare lookup (which resolves codex.exe) must win
  assert.equal(
    resolveCodexCliBin({
      env: {},
      execPath: 'C:\\nodejs\\node.exe',
      exists: () => true,
      platform: 'win32',
    }),
    'codex',
  );
});

test('codexCliNotFoundMessage names the resolved binary and the override source', () => {
  assert.equal(
    codexCliNotFoundMessage('codex', {}),
    'Codex CLI not found in PATH. Install it first.',
  );
  assert.equal(
    codexCliNotFoundMessage('/opt/custom/codex', { TEAMCODEX_CODEX_BIN: '/opt/custom/codex' }),
    'Codex CLI not found at /opt/custom/codex — check TEAMCODEX_CODEX_BIN.',
  );
  assert.equal(
    codexCliNotFoundMessage('/nodes/v24/bin/codex', {}),
    'Codex CLI not found at /nodes/v24/bin/codex. Install it first.',
  );
});
