import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

function runCli(cliArgs, configPath) {
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
  delete env.TEAMCLAUDE_PROVIDER;
  return spawnSync(process.execPath, [entry, ...cliArgs], { encoding: 'utf8', env });
}

async function seedConfig(configPath, extra = {}) {
  await writeFile(configPath, JSON.stringify({
    provider: 'anthropic',
    // A port nothing listens on: noteRunningServerReload probes it and moves on.
    proxy: { port: 65033, apiKey: 'k' },
    accounts: [
      { name: 'a', type: 'oauth', accessToken: 'tok-a', refreshToken: 'r-a', expiresAt: Date.now() + 3600_000 },
    ],
    ...extra,
  }, null, 2));
}

test('subscription <name> disabled persists the flag and ok clears it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-subcli-'));
  const configPath = join(dir, 'teamclaude.json');
  await seedConfig(configPath);

  try {
    const set = runCli(['subscription', 'a', 'disabled'], configPath);
    assert.equal(set.status, 0, set.stderr);
    assert.match(set.stdout, /subscription-disabled/);
    let saved = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(saved.accounts[0].subscriptionDisabled, true);

    const clear = runCli(['subscription', 'a', 'ok'], configPath);
    assert.equal(clear.status, 0, clear.stderr);
    saved = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal('subscriptionDisabled' in saved.accounts[0], false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('subscription rejects unknown accounts and malformed states', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-subcli-bad-'));
  const configPath = join(dir, 'teamclaude.json');
  await seedConfig(configPath);

  try {
    const missing = runCli(['subscription', 'nope', 'disabled'], configPath);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /not found/);

    const badState = runCli(['subscription', 'a', 'maybe'], configPath);
    assert.equal(badState.status, 1);
    assert.match(badState.stderr, /Usage: teamcodex subscription/);
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal('subscriptionDisabled' in saved.accounts[0], false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('subscription errors out on a codex-mode config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-subcli-codex-'));
  const configPath = join(dir, 'teamcodex.json');
  await seedConfig(configPath, { provider: 'codex' });

  try {
    const viaConfig = runCli(['subscription', 'a', 'disabled'], configPath);
    assert.equal(viaConfig.status, 1);
    assert.match(viaConfig.stderr, /Claude \(Anthropic\) accounts only/);

    const viaCli = runCli(['codex', 'subscription', 'a', 'disabled'], configPath);
    assert.equal(viaCli.status, 1);

    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal('subscriptionDisabled' in saved.accounts[0], false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
