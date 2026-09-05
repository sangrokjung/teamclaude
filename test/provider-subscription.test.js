import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  getProviderDefinition,
  providerAuthHeaders,
  validateProviderAccounts,
} from '../src/provider-config.js';
import {
  importGrokCredentials,
  refreshGrokAccessToken,
  importAgyCredentials,
  fetchAgyAccountIdentity,
} from '../src/provider-oauth.js';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const grokAccount = {
  name: 'grok-sub', provider: 'grok', type: 'oauth',
  accessToken: 'grok-access', refreshToken: 'grok-refresh',
  expiresAt: Date.now() + 3600_000,
  accountUuid: 'grok-user', oauthIssuer: 'https://auth.x.ai', oauthClientId: 'grok-client',
};
const agyAccount = {
  name: 'agy-sub', provider: 'agy', type: 'oauth',
  accessToken: 'agy-access', refreshToken: 'agy-refresh',
  expiresAt: Date.now() + 3600_000,
  accountUuid: 'agy-user', authMethod: 'consumer',
};

test('Grok and Agy expose subscription OAuth provider contracts', () => {
  assert.equal(getProviderDefinition('grok').defaultUpstream, 'https://cli-chat-proxy.grok.com/v1');
  assert.equal(getProviderDefinition('grok').authMode, 'oauth');
  assert.equal(getProviderDefinition('grok').credentialEnv, null);
  assert.equal(getProviderDefinition('agy').defaultUpstream, 'https://daily-cloudcode-pa.googleapis.com');
  assert.equal(getProviderDefinition('agy').authMode, 'oauth');
  assert.equal(getProviderDefinition('agy').credentialEnv, null);
  assert.deepEqual(providerAuthHeaders('grok', grokAccount), { authorization: 'Bearer grok-access' });
  assert.deepEqual(providerAuthHeaders('agy', agyAccount), { authorization: 'Bearer agy-access' });
});

test('top-level help exposes Grok and Agy provider entry points', () => {
  const result = spawnSync(process.execPath, [entry, 'help'], {
    encoding: 'utf8',
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !['TEAMCLAUDE_PROVIDER', 'TEAMCLAUDE_SESSION_SUPERVISED', 'CMUX_SURFACE_ID'].includes(key))),
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /grok \[command\]/i);
  assert.match(result.stdout, /agy \[command\]/i);
});

test('subscription providers accept OAuth accounts and reject API-key or incomplete credentials', () => {
  validateProviderAccounts('grok', [grokAccount]);
  validateProviderAccounts('agy', [agyAccount]);
  assert.throws(() => validateProviderAccounts('grok', [{ ...grokAccount, type: 'apikey', apiKey: 'x' }]), /oauth/i);
  assert.doesNotThrow(() => validateProviderAccounts('agy', [{ ...agyAccount, refreshToken: null }]));
  for (const refreshToken of ['', 42, { token: 'nested' }]) {
    assert.throws(
      () => validateProviderAccounts('agy', [{ ...agyAccount, refreshToken }]),
      /refreshToken/i,
    );
  }
  assert.throws(() => validateProviderAccounts('agy', [{ ...agyAccount, apiKey: 'x' }]), /apiKey|oauth/i);
  assert.throws(() => validateProviderAccounts('grok', [{ ...grokAccount, accessToken: null }]), /accessToken/i);
});

test('subscription provider config requires stable OAuth metadata at startup', () => {
  assert.throws(() => validateProviderAccounts('grok', [{
    name: 'grok-incomplete', type: 'oauth', accessToken: 'a', refreshToken: 'r',
  }], { requireMetadata: true }), /provider|accountUuid|oauthIssuer|oauthClientId/i);
  assert.throws(() => validateProviderAccounts('agy', [{
    name: 'agy-incomplete', provider: 'agy', type: 'oauth', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, accountUuid: 'u',
  }], { requireMetadata: true }), /authMethod/i);
  assert.throws(() => validateProviderAccounts('agy', [{
    ...agyAccount, provider: undefined,
  }], { requireMetadata: true }), /provider/i);
  for (const [provider, account] of [['grok', grokAccount], ['agy', agyAccount]]) {
    assert.throws(() => validateProviderAccounts(provider, [{
      ...account, expiresAt: undefined,
    }], { requireMetadata: true }), /expiresAt/i);
    assert.throws(() => validateProviderAccounts(provider, [{
      ...account, expiresAt: 'not-a-timestamp',
    }], { requireMetadata: true }), /expiresAt/i);
  }
});

test('provider validation rejects unresolved import descriptors outside the import boundary', () => {
  assert.throws(() => validateProviderAccounts('grok', [{
    provider: 'grok', type: 'oauth', importFrom: '/tmp/grok-auth.json',
    accountUuid: 'grok-user', expiresAt: Date.now() + 3600_000,
    oauthIssuer: 'https://auth.x.ai', oauthClientId: 'grok-client',
  }], { requireMetadata: true }), /accessToken|refreshToken/i);
  assert.throws(() => validateProviderAccounts('agy', [{
    provider: 'agy', type: 'oauth', importFrom: '/tmp/agy-auth.json',
    accountUuid: 'agy-user', expiresAt: Date.now() + 3600_000,
    authMethod: 'consumer',
  }], { requireMetadata: true }), /accessToken/i);
});

test('subscription provider rejects falsey API-key-shaped fields', () => {
  for (const provider of ['grok', 'agy']) {
    assert.throws(() => validateProviderAccounts(provider, [{
      provider, type: 'oauth', accessToken: 'access', refreshToken: 'refresh',
      accountUuid: `${provider}-user`, expiresAt: Date.now() + 3600_000,
      oauthIssuer: provider === 'grok' ? 'https://auth.x.ai' : undefined,
      oauthClientId: provider === 'grok' ? 'grok-client' : undefined,
      authMethod: provider === 'agy' ? 'consumer' : undefined,
      apiKey: '',
    }], { requireMetadata: true }), /apiKey/i);
  }
});

test('Grok auth.json import maps OIDC subscription fields without API-key shape', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-grok-oauth-'));
  const path = join(dir, 'auth.json');
  try {
    await writeFile(path, JSON.stringify({
      'https://auth.x.ai::grok-client': {
        key: 'grok-access', refresh_token: 'grok-refresh', expires_at: 1730000000,
        auth_mode: 'oidc', oidc_issuer: 'https://auth.x.ai', oidc_client_id: 'grok-client',
        user_id: 'grok-user', email: 'grok@example.test',
      },
    }));
    assert.deepEqual(await importGrokCredentials(path), {
      accessToken: 'grok-access', refreshToken: 'grok-refresh', expiresAt: 1730000000000,
      accountUuid: 'grok-user', email: 'grok@example.test',
      oauthIssuer: 'https://auth.x.ai', oauthClientId: 'grok-client', authMode: 'oidc',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Grok refresh uses OIDC discovery and public-client refresh grant', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).endsWith('/.well-known/openid-configuration')) {
      return { ok: true, json: async () => ({ token_endpoint: 'http://auth.test/oauth2/token' }) };
    }
    return { ok: true, json: async () => ({ access_token: 'grok-new', refresh_token: 'grok-new-refresh', expires_in: 3600 }) };
  };
  try {
    const tokens = await refreshGrokAccessToken('grok-refresh', 'https://auth.test', 'grok-client');
    assert.equal(tokens.accessToken, 'grok-new');
    assert.equal(calls[0].url, 'https://auth.test/.well-known/openid-configuration');
    assert.equal(calls[1].url, 'http://auth.test/oauth2/token');
    assert.match(calls[1].options.headers['content-type'], /form-urlencoded/);
    const body = new URLSearchParams(calls[1].options.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('client_id'), 'grok-client');
    assert.equal(body.get('refresh_token'), 'grok-refresh');
    assert.equal(body.has('client_secret'), false);
  } finally {
    globalThis.fetch = original;
  }
});

test('provider OAuth refresh redacts endpoint bodies and obeys a deadline', async () => {
  const original = globalThis.fetch;
  const secret = 'refresh-secret-must-not-appear';
  try {
    let call = 0;
    globalThis.fetch = async () => {
      call++;
      if (call === 1) {
        return { ok: true, json: async () => ({ token_endpoint: 'https://auth.test/token' }) };
      }
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'invalid_grant', error_description: secret }),
      };
    };
    await assert.rejects(
      () => refreshGrokAccessToken(secret, 'https://auth.test', 'grok-client', 100),
      error => /invalid_grant/.test(error.message) && !error.message.includes(secret),
    );

    globalThis.fetch = async (_url, options = {}) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    const started = Date.now();
    await assert.rejects(
      () => refreshGrokAccessToken(secret, 'https://auth.test', 'grok-client', 25),
      /timed out/i,
    );
    assert.ok(Date.now() - started < 500, 'OAuth refresh exceeded its configured deadline');
  } finally {
    globalThis.fetch = original;
  }
});

test('Agy consumer keychain envelope import maps OAuth token fields and rejects API keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-agy-oauth-'));
  const path = join(dir, 'credential.json');
  try {
    await writeFile(path, JSON.stringify({
      token: {
        access_token: 'agy-access', refresh_token: 'agy-refresh', expiry: '2026-09-01T00:00:00Z',
      },
      auth_method: 'consumer', account_id: 'agy-user', project_id: 'gcp-project',
    }));
    const parsed = await importAgyCredentials(path);
    assert.equal(parsed.accessToken, 'agy-access');
    assert.equal(parsed.refreshToken, 'agy-refresh');
    assert.equal(parsed.accountUuid, 'agy-user');
    assert.equal(parsed.authMethod, 'consumer');
    assert.equal(parsed.projectId, 'gcp-project');
    await writeFile(path, JSON.stringify({ apiKey: 'AIza-secret' }));
    await assert.rejects(() => importAgyCredentials(path), /envelope|access_token|OAuth/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Agy import rejects flat tokens and nested API-key envelopes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-agy-oauth-boundary-'));
  const path = join(dir, 'credential.json');
  try {
    await writeFile(path, JSON.stringify({
      access_token: 'agy-access',
      auth_method: 'consumer',
    }));
    await assert.rejects(() => importAgyCredentials(path), /envelope|token/i);

    await writeFile(path, JSON.stringify({
      token: { access_token: 'agy-access', apiKey: 'AIza-secret' },
      auth_method: 'consumer',
    }));
    await assert.rejects(() => importAgyCredentials(path), /api.?key|OAuth/i);

    await writeFile(path, JSON.stringify({
      token: { access_token: 'agy-access', api_key: 'AIza-secret' },
      auth_method: 'consumer',
    }));
    await assert.rejects(() => importAgyCredentials(path), /api.?key|OAuth/i);

    await writeFile(path, JSON.stringify({
      token: { access_token: 'agy-access' },
    }));
    await assert.rejects(() => importAgyCredentials(path), /auth_method|consumer/i);

    await writeFile(path, JSON.stringify({
      token: { access_token: 'agy-access' },
      auth_method: 'consumer',
    }));
    await assert.rejects(() => importAgyCredentials(path), /account|identity|uuid/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Grok import rejects OAuth entries without a stable account identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-grok-oauth-boundary-'));
  const path = join(dir, 'auth.json');
  try {
    await writeFile(path, JSON.stringify({
      'https://auth.x.ai::grok-client': {
        key: 'grok-access', refresh_token: 'grok-refresh',
        auth_mode: 'oidc', oidc_issuer: 'https://auth.x.ai', oidc_client_id: 'grok-client',
      },
    }));
    await assert.rejects(() => importGrokCredentials(path), /account|identity|uuid/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Agy refresh fails closed without explicit OAuth metadata', async () => {
  await assert.rejects(
    () => import('../src/provider-oauth.js').then(({ refreshAgyAccessToken }) =>
      refreshAgyAccessToken('agy-refresh', null, null)),
    /token endpoint|client id/i,
  );
});

test('Agy keychain identity lookup uses standard OAuth userinfo and Bearer auth', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ sub: 'agy-userinfo-id' }) };
  };
  try {
    assert.equal(await fetchAgyAccountIdentity('agy-access'), 'agy-userinfo-id');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://www.googleapis.com/oauth2/v3/userinfo');
    assert.equal(calls[0].options.headers.authorization, 'Bearer agy-access');
  } finally {
    globalThis.fetch = original;
  }
});

test('provider-prefixed login rejects --api-key for subscription pools', () => {
  const dir = '/tmp/teamclaude-subscription-cli-red';
  const result = spawnSync(process.execPath, [entry, 'grok', 'login', '--api-key', 'secret'], {
    encoding: 'utf8', env: { ...process.env, TEAMCLAUDE_CONFIG: join(dir, 'config.json') },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /OAuth|subscription|api-key.*not supported/i);
});

test('provider-prefixed login rejects compact --api-key=value syntax', () => {
  const dir = '/tmp/teamclaude-subscription-cli-compact-red';
  const result = spawnSync(process.execPath, [entry, 'agy', 'login', '--api-key=secret'], {
    encoding: 'utf8', env: { ...process.env, TEAMCLAUDE_CONFIG: join(dir, 'config.json') },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /OAuth|subscription|api-key.*not supported/i);
});
