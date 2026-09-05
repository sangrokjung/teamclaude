import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import {
  buildProviderUpstreamUrl,
  getProviderDefinition,
  providerAuthHeaders,
  validateProviderAccounts,
} from '../src/provider-config.js';
import { assertSafeProxyConfig } from '../src/config.js';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise(resolve => server.close(resolve));
}

function runCli(args, env) {
  return new Promise(resolve => execFile(
    process.execPath,
    [entry, ...args],
    { encoding: 'utf8', env },
    (error, stdout, stderr) => resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr }),
  ));
}

test('provider definitions expose Grok and Agy subscription OAuth contracts', () => {
  assert.deepEqual(getProviderDefinition('grok'), {
    name: 'grok',
    defaultUpstream: 'https://cli-chat-proxy.grok.com/v1',
    credentialEnv: null,
    authMode: 'oauth',
    authHeader: 'authorization-bearer',
    defaultPath: '/chat/completions',
  });
  assert.deepEqual(getProviderDefinition('agy'), {
    name: 'agy',
    defaultUpstream: 'https://daily-cloudcode-pa.googleapis.com',
    credentialEnv: null,
    authMode: 'oauth',
    authHeader: 'authorization-bearer',
    defaultPath: '/v1internal:streamGenerateContent',
  });
});

for (const provider of ['grok', 'agy']) {
  test(`${provider} accounts empty-state uses provider OAuth commands`, async () => {
    const dir = await mkdtemp(join(tmpdir(), `teamclaude-${provider}-accounts-empty-`));
    const configPath = join(dir, 'config.json');
    try {
      await writeFile(configPath, JSON.stringify({
        provider,
        proxy: { port: 45981, apiKey: 'proxy-key' },
        accounts: [],
      }));
      const result = await runCli([provider, 'accounts'], {
        ...process.env,
        TEAMCLAUDE_CONFIG: configPath,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`teamcodex ${provider} (import|login)`));
      assert.doesNotMatch(result.stdout, /teamcodex import,|teamcodex login --api/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`${provider} accounts labels OAuth rows as provider subscriptions`, async () => {
    const dir = await mkdtemp(join(tmpdir(), `teamclaude-${provider}-accounts-row-`));
    const configPath = join(dir, 'config.json');
    try {
      await writeFile(configPath, JSON.stringify({
        provider,
        proxy: { port: 45982, apiKey: 'proxy-key' },
        accounts: [{
          name: `${provider}-fixture`, provider, type: 'oauth',
          accessToken: 'redacted-access-token', refreshToken: provider === 'agy' ? null : 'redacted-refresh-token',
          expiresAt: Date.now() + 3600_000, accountUuid: `${provider}-user`,
          ...(provider === 'grok'
            ? { oauthIssuer: 'https://auth.x.ai', oauthClientId: 'redacted-client' }
            : { authMethod: 'consumer' }),
        }],
      }));
      const result = await runCli([provider, 'accounts'], {
        ...process.env,
        TEAMCLAUDE_CONFIG: configPath,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`${provider === 'grok' ? 'Grok' : 'Agy'} subscription`, 'i'));
      assert.doesNotMatch(result.stdout, /unknown \(no token\)|Claude (Max|Pro|subscription)/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('provider config rejects mixed account providers', () => {
  assert.throws(
    () => validateProviderAccounts('grok', [
      { name: 'g', provider: 'grok', type: 'oauth', accessToken: 'g', refreshToken: 'gr' },
      { name: 'a', provider: 'agy', type: 'oauth', accessToken: 'a', refreshToken: 'ar' },
    ]),
    /provider.*grok/i,
  );
});



test('Grok subscription upstream does not duplicate the public /v1 path', () => {
  assert.equal(
    buildProviderUpstreamUrl('grok', 'https://cli-chat-proxy.grok.com/v1', '/v1/chat/completions'),
    'https://cli-chat-proxy.grok.com/v1/chat/completions',
  );
});

test('Agy startup uses the consumer cloudcode upstream by default', () => {
  assert.doesNotThrow(() => assertSafeProxyConfig({
    provider: 'agy',
    proxy: { apiKey: 'proxy-key' },
    accounts: [{ name: 'agy-one', provider: 'agy', type: 'oauth', accountUuid: 'agy-user', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, authMethod: 'consumer' }],
  }));
});

test('persisted Grok and Agy configs reject internal-only auth fields', () => {
  for (const provider of ['grok', 'agy']) {
    assert.throws(() => assertSafeProxyConfig({
      provider,
      proxy: { apiKey: 'proxy-key' },
      accounts: [{
        name: `${provider}-runtime-shape`,
        provider,
        type: 'oauth',
        credential: `${provider}-runtime-credential`,
        refreshToken: `${provider}-refresh`,
        accountUuid: `${provider}-user`,
        oauthIssuer: 'https://issuer.example.test',
        oauthClientId: `${provider}-client`,
        authMethod: 'consumer',
      }],
    }), /credential/i);

    assert.throws(() => assertSafeProxyConfig({
      provider,
      proxy: { apiKey: 'proxy-key' },
      accounts: [{
        name: `${provider}-mixed-shape`,
        provider,
        type: 'oauth',
        accessToken: `${provider}-access`,
        credential: `${provider}-runtime-credential`,
        refreshToken: `${provider}-refresh`,
        accountUuid: `${provider}-user`,
        expiresAt: Date.now() + 3600_000,
        oauthIssuer: 'https://issuer.example.test',
        oauthClientId: `${provider}-client`,
        authMethod: 'consumer',
      }],
    }), /credential/i);
  }
});

test('Grok and Agy reject runtime credentials without OAuth provenance', () => {
  for (const provider of ['grok', 'agy']) {
    assert.throws(() => providerAuthHeaders(provider, {
      type: 'oauth',
      credential: `${provider}-legacy-api-key`,
    }), /oauth|accessToken|credential/i);

    const accountManager = new AccountManager([{
      name: `${provider}-legacy-runtime`,
      provider,
      type: 'oauth',
      apiKey: `${provider}-legacy-api-key`,
      accountUuid: `${provider}-user`,
      expiresAt: Date.now() + 3600_000,
      oauthIssuer: 'https://issuer.example.test',
      oauthClientId: `${provider}-client`,
      authMethod: 'consumer',
    }]);
    assert.throws(() => createProxyServer(accountManager, {
      provider,
      activeWarmup: false,
      proxy: { apiKey: 'proxy-key' },
    }), /oauth|accessToken|credential/i);
  }
});

test('Agy runtime token updates clear an explicitly removed optional refresh token', () => {
  const accountManager = new AccountManager([{
    name: 'agy-refresh-removal',
    provider: 'agy',
    type: 'oauth',
    accountUuid: 'agy-user',
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: Date.now() + 3600_000,
    authMethod: 'consumer',
  }]);

  accountManager.updateAccountTokens(0, {
    accessToken: 'new-access',
    refreshToken: null,
    expiresAt: Date.now() + 3600_000,
  }, false);

  assert.equal(accountManager.accounts[0].accessToken, 'new-access');
  assert.equal(accountManager.accounts[0].refreshToken, null);
});

test('Agy request logs do not expose OAuth credential material', async () => {
  const logDir = await mkdtemp(join(tmpdir(), 'teamclaude-agy-log-'));
  const secret = 'agy-log-secret-that-must-not-appear';
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  const accountManager = new AccountManager([{
    name: 'agy-log', provider: 'agy', type: 'oauth', accountUuid: 'agy-log-user', authMethod: 'consumer', accessToken: secret, refreshToken: 'agy-refresh', expiresAt: Date.now() + 3600_000,
  }]);
  const proxy = createProxyServer(accountManager, {
    provider: 'agy',
    upstream: `http://127.0.0.1:${upstreamPort}`,
    logDir,
    activeWarmup: false,
    continuityMode: false,
    codexUsageRefresh: false,
    proxy: { apiKey: 'proxy-key' },
  });
  const proxyPort = await listen(proxy);
  try {
    const response = await fetch(
      `http://127.0.0.1:${proxyPort}/v1internal:streamGenerateContent`,
      { method: 'POST', body: '{}' },
    );
    assert.equal(response.status, 200);
    for (let i = 0; i < 100 && (await readdir(logDir)).length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const files = await readdir(logDir);
    assert.equal(files.length, 1);
    const log = await readFile(join(logDir, files[0]), 'utf8');
    assert.doesNotMatch(log, new RegExp(secret));
    assert.doesNotMatch(log, /^\s*authorization:/im);
    assert.doesNotMatch(log, /account: agy-log/i);
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
    await rm(logDir, { recursive: true, force: true });
  }
});

for (const [provider, key, header, path] of [
  ['grok', 'grok-test-token', 'authorization', '/v1/chat/completions'],
  ['agy', 'agy-test-token', 'authorization', '/v1internal:streamGenerateContent'],
]) {
  test(`${provider} OAuth account forwards subscription authentication and path`, async () => {
    let seen = null;
    const upstream = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      seen = {
        url: req.url,
        auth: req.headers[header],
        opposite: req.headers[header === 'authorization' ? 'x-goog-api-key' : 'authorization'],
        body: Buffer.concat(chunks).toString(),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const upstreamPort = await listen(upstream);
    const accountManager = new AccountManager([{
      name: `${provider}-one`, provider, type: 'oauth', accessToken: key,
      refreshToken: `${key}-refresh`, expiresAt: Date.now() + 3600_000,
      accountUuid: `${provider}-user`,
      ...(provider === 'grok'
        ? { oauthIssuer: 'https://auth.x.ai', oauthClientId: 'grok-client' }
        : { authMethod: 'consumer' }),
    }]);
    const proxy = createProxyServer(accountManager, {
      provider,
      upstream: `http://127.0.0.1:${upstreamPort}`,
      activeWarmup: false,
      continuityMode: false,
      codexUsageRefresh: false,
      proxy: { apiKey: 'proxy-key' },
    });
    const proxyPort = await listen(proxy);

    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: provider, input: 'hello' }),
      });
      assert.equal(response.status, 200);
      assert.equal(seen.url, path);
      assert.equal(seen.auth, `Bearer ${key}`);
      assert.equal(seen.opposite, undefined);
      assert.match(seen.body, /"hello"/);
    } finally {
      await Promise.all([close(proxy), close(upstream)]);
    }
  });
}

for (const provider of ['grok', 'agy']) {
  test(`${provider} import persists a subscription OAuth account without echoing tokens`, async () => {
    const dir = await mkdtemp(join(tmpdir(), `teamclaude-${provider}-cli-`));
    const configPath = join(dir, 'config.json');
    const credentialPath = join(dir, 'credential.json');
    try {
      await writeFile(credentialPath, JSON.stringify(provider === 'grok'
        ? { 'https://auth.x.ai::client': { key: 'access-token', refresh_token: 'refresh-token', expires_at: Date.now() + 3600000, auth_mode: 'oidc', oidc_issuer: 'https://auth.x.ai', oidc_client_id: 'client', user_id: 'user', email: 'user@example.test' } }
        : { token: { access_token: 'access-token', refresh_token: 'refresh-token', expiry: Date.now() + 3600000 }, auth_method: 'consumer', account_id: 'user' }));
      const result = await runCli([
        provider, 'import', '--from', credentialPath, '--name', `${provider}-account`,
      ], { ...process.env, TEAMCLAUDE_CONFIG: configPath });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /access-token|refresh-token/);
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      assert.equal(config.provider, provider);
      assert.equal(config.accounts[0].type, 'oauth');
      assert.equal(config.accounts[0].accessToken, 'access-token');
      assert.equal(config.accounts[0].refreshToken, 'refresh-token');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('first Grok account replaces a stale upstream in an empty Anthropic config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-grok-transition-'));
  const configPath = join(dir, 'config.json');
  try {
    await writeFile(configPath, JSON.stringify({
      provider: 'anthropic',
      proxy: { port: 4567, apiKey: 'proxy-key' },
      upstream: 'https://api.anthropic.com',
      accounts: [],
    }));
    const credentialPath = join(dir, 'auth.json');
    await writeFile(credentialPath, JSON.stringify({ 'https://auth.x.ai::client': { key: 'access-token', refresh_token: 'refresh-token', expires_at: Date.now() + 3600000, auth_mode: 'oidc', oidc_issuer: 'https://auth.x.ai', oidc_client_id: 'client', user_id: 'user' } }));
    const result = await runCli([
      'grok', 'import', '--from', credentialPath, '--name', 'grok-one',
    ], { ...process.env, TEAMCLAUDE_CONFIG: configPath });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.provider, 'grok');
    assert.equal(config.upstream, 'https://cli-chat-proxy.grok.com/v1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const [provider, expected] of [
  ['grok', ['GROK_CLI_CHAT_PROXY_BASE_URL=http://localhost:4567/v1']],
  ['agy', ['CLOUD_CODE_URL=http://localhost:4567']],
]) {
  test(`${provider} env prints provider-specific client variables`, async () => {
    const dir = await mkdtemp(join(tmpdir(), `teamclaude-${provider}-env-`));
    const configPath = join(dir, 'config.json');
    try {
      await writeFile(configPath, JSON.stringify({
        provider,
        proxy: { port: 4567, apiKey: 'proxy-key' },
        upstream: provider === 'agy' ? 'https://daily-cloudcode-pa.googleapis.com' : 'https://cli-chat-proxy.grok.com/v1',
        accounts: [],
      }));
      const result = await runCli([provider, 'env'], {
        ...process.env,
        TEAMCLAUDE_CONFIG: configPath,
      });
      assert.equal(result.status, 0, result.stderr);
      for (const fragment of expected) assert.match(result.stdout, new RegExp(fragment));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
