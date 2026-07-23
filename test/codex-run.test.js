import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

test('teamclaude codex run launches Codex through the HTTP-only first-party auth provider', async () => {
  // Given
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-run-'));
  const fakeCodex = join(dir, 'codex');
  const configPath = join(dir, 'teamcodex.json');
  await writeFile(fakeCodex, `#!/usr/bin/env node
console.log(JSON.stringify({
  args: process.argv.slice(2),
  proxyToken: process.env.TEAMCLAUDE_CODEX_PROXY_TOKEN ?? null,
  openaiApiKey: process.env.OPENAI_API_KEY ?? null,
  codexApiKey: process.env.CODEX_API_KEY ?? null,
  codexAccessToken: process.env.CODEX_ACCESS_TOKEN ?? null,
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
    assert.match(child.args[3], /requires_openai_auth = true/);
    assert.match(child.args[3], /supports_websockets = false/);
    assert.equal(child.args[5], 'chatgpt_base_url="http://127.0.0.1:4567"');
  } finally {
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
      id_token: jwt({
        email: 'pool@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'workspace-pool',
          chatgpt_plan_type: 'pro',
        },
      }),
      access_token: jwt({ exp: 1_900_000_000 }),
      refresh_token: 'refresh-pool',
      account_id: 'workspace-pool',
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
      accountUuid: 'workspace-pool',
      accountId: 'workspace-pool',
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
      id_token: jwt({
        email: 'isolated@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'workspace-isolated',
          chatgpt_plan_type: 'plus',
        },
      }),
      access_token: jwt({ exp: 1_900_000_000 }),
      refresh_token: 'refresh-isolated',
      account_id: 'workspace-isolated',
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
    assert.equal(config.accounts[0].accountId, 'workspace-isolated');
    assert.equal(config.accounts[0].planType, 'plus');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
