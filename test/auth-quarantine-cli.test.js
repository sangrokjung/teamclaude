import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

function runCli(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--require', env.TEAMCLAUDE_PROFILE_STUB, entry, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function fixture(profileUuid) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-auth-cli-'));
  const configPath = join(dir, 'config.json');
  const profileStub = join(dir, 'profile-stub.cjs');
  const now = Date.now();
  await writeFile(profileStub, `
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url) === 'https://api.anthropic.com/api/oauth/profile') {
    return new Response(JSON.stringify({
      account: { uuid: ${JSON.stringify(profileUuid)}, email: 'legacy@example.com' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return originalFetch(url, options);
};
`);
  return {
    dir,
    configPath,
    profileStub,
    now,
    async writeConfig(account) {
      await writeFile(configPath, JSON.stringify({
        provider: 'anthropic',
        proxy: { port: 65099, apiKey: 'proxy-key' },
        accounts: [account],
      }));
    },
    async run() {
      const env = {
        ...process.env,
        TEAMCLAUDE_CONFIG: configPath,
        TEAMCLAUDE_PROFILE_STUB: profileStub,
      };
      delete env.TEAMCLAUDE_PROVIDER;
      return runCli([
        'import',
        '--json', JSON.stringify({
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          expiresAt: now + 7200_000,
        }),
        '--name', 'legacy@example.com',
      ], env);
    },
    async readConfig() {
      return JSON.parse(await readFile(configPath, 'utf8'));
    },
  };
}

test('CLI import cannot replace a quarantined legacy account by same-name profile', async () => {
  const fx = await fixture('uuid-other');
  try {
    const legacy = {
      name: 'legacy@example.com',
      type: 'oauth',
      provider: 'anthropic',
      accountUuid: null,
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: fx.now + 3600_000,
      authRevoked: true,
      authRevokedAt: fx.now - 1000,
    };
    await fx.writeConfig(legacy);

    const result = await fx.run();
    const saved = (await fx.readConfig()).accounts[0];
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /quarantined/);
    assert.equal(saved.accountUuid, null);
    assert.equal(saved.accessToken, 'old-access');
    assert.equal(saved.refreshToken, 'old-refresh');
    assert.equal(saved.authRevoked, true);
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test('CLI import with a matching stable UUID can heal a quarantined account', async () => {
  const fx = await fixture('uuid-stable');
  try {
    await fx.writeConfig({
      name: 'legacy@example.com',
      type: 'oauth',
      provider: 'anthropic',
      accountUuid: 'uuid-stable',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: fx.now + 3600_000,
      authRevoked: true,
      authRevokedAt: fx.now - 1000,
    });

    const result = await fx.run();
    const saved = (await fx.readConfig()).accounts[0];
    assert.equal(result.code, 0, result.stderr);
    assert.equal(saved.accountUuid, 'uuid-stable');
    assert.equal(saved.accessToken, 'new-access');
    assert.equal(saved.refreshToken, 'new-refresh');
    assert.equal(saved.authRevoked, undefined);
    assert.equal(saved.authRevokedAt, undefined);
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});
