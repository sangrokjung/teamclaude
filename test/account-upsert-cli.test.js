import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function codexFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-upsert-'));
  const config = join(dir, 'teamcodex.json');
  await writeFile(config, JSON.stringify({
    provider: 'codex',
    proxy: { port: 1, apiKey: 'test-local-key-000000' },
    accounts: [{
      name: 'parked@example.com', provider: 'codex', type: 'oauth',
      accountUuid: 'acct-parked', accountId: 'acct-parked',
      accessToken: 'old', refreshToken: 'old-r', expiresAt: 1, enabled: false, priority: 2,
    }],
  }), { mode: 0o600 });
  const fakeCodex = join(dir, 'codex');
  await writeFile(fakeCodex, [
    '#!/bin/sh',
    'mkdir -p "$CODEX_HOME"',
    `printf '%s' '{"tokens":{"access_token":"fresh","refresh_token":"fresh-r","account_id":"acct-parked"}}' > "$CODEX_HOME/auth.json"`,
    '',
  ].join('\n'));
  await chmod(fakeCodex, 0o755);
  return { dir, config, fakeCodex };
}

function run(args, { config, fakeCodex }) {
  return spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8',
    input: '',
    timeout: 30_000,
    env: { ...process.env, TEAMCLAUDE_CONFIG: config, TEAMCODEX_CODEX_BIN: fakeCodex },
  });
}

test('codex login through the CLI re-enables a disabled account', async () => {
  const fx = await codexFixture();
  try {
    const result = run(['codex', 'login', '--name', 'parked@example.com'], fx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Re-enabled "parked@example\.com"/);
    const saved = JSON.parse(await readFile(fx.config, 'utf8')).accounts[0];
    assert.equal('enabled' in saved, false);
    assert.equal(saved.priority, 2);
    assert.equal(saved.accessToken, 'fresh');
    assert.equal(saved.source, 'login');
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test('codex import keeps the disable and names the exact enable command', async () => {
  const fx = await codexFixture();
  try {
    const json = JSON.stringify({ tokens: { access_token: 'fresh', refresh_token: 'fresh-r', account_id: 'acct-parked' } });
    const result = run(['codex', 'import', '--name', 'parked@example.com', '--json', json], fx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /`teamclaude codex enable parked@example\.com` puts it back/);
    const saved = JSON.parse(await readFile(fx.config, 'utf8')).accounts[0];
    assert.equal(saved.enabled, false);
    assert.equal(saved.accessToken, 'fresh');
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});
