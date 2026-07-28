import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicConfigUpdate, saveConfig, writeQuotaCacheSync, readQuotaCache } from '../src/config.js';

// node --test runs each test file in its own process, so setting TEAMCLAUDE_CONFIG
// (and the module-level write chain) here doesn't leak into other test files.

test('atomicConfigUpdate serializes concurrent writers (no lost update / no resurrection)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-cfg-'));
  const cfgPath = join(dir, 'teamclaude.json');
  const prev = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = cfgPath;
  try {
    await writeFile(cfgPath, JSON.stringify({
      proxy: { port: 1 },
      accounts: [
        { name: 'A', type: 'apikey', apiKey: 'a' },
        { name: 'B', type: 'apikey', apiKey: 'b' },
      ],
    }, null, 2) + '\n', { mode: 0o600 });

    // Two concurrent read-modify-write cycles: one DELETES A (like a TUI delete),
    // the other UPDATES B's token (like a background token refresh). Each reads the
    // whole file and writes it all back — without serialization the later write
    // clobbers the earlier (either resurrecting A or losing B's update).
    await Promise.all([
      atomicConfigUpdate(c => { c.accounts = c.accounts.filter(a => a.name !== 'A'); }),
      atomicConfigUpdate(c => { const b = c.accounts.find(a => a.name === 'B'); if (b) b.apiKey = 'b-new'; }),
    ]);

    const final = JSON.parse(await readFile(cfgPath, 'utf8'));
    assert.deepEqual(final.accounts.map(a => a.name), ['B'], 'A stays deleted (not resurrected)');
    assert.equal(final.accounts[0].apiKey, 'b-new', "B's concurrent update is not lost");
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test('config/quota writes are atomic: valid content, 0600, no temp leftovers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-cfg-'));
  const cfgPath = join(dir, 'teamclaude.json');
  const prev = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = cfgPath;
  try {
    // Pre-existing file simulates the overwrite path (the dangerous one:
    // an in-place write would truncate it before writing).
    await writeFile(cfgPath, JSON.stringify({ accounts: [{ name: 'old' }] }) + '\n', { mode: 0o600 });

    await saveConfig({ proxy: { port: 1 }, accounts: [{ name: 'A', type: 'apikey', apiKey: 'a' }] });
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
    assert.equal(cfg.accounts[0].name, 'A');
    assert.equal((await stat(cfgPath)).mode & 0o777, 0o600, 'config stays private');

    writeQuotaCacheSync({ savedAt: 1, accounts: [] });
    assert.deepEqual(await readQuotaCache(), { savedAt: 1, accounts: [] });

    const leftovers = (await readdir(dir)).filter(f => f.includes('.tmp-'));
    assert.deepEqual(leftovers, [], 'no temp files left behind');
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test('atomicConfigUpdate serializes independent processes without losing accounts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-cfg-process-'));
  const cfgPath = join(dir, 'teamclaude.json');
  const moduleUrl = new URL('../src/config.js', import.meta.url).href;
  try {
    await writeFile(cfgPath, JSON.stringify({ proxy: { port: 1 }, accounts: [] }) + '\n', { mode: 0o600 });
    const runWriter = (name, holdMs) => new Promise((resolve, reject) => {
      const source = `
        import { atomicConfigUpdate } from ${JSON.stringify(moduleUrl)};
        await atomicConfigUpdate(async config => {
          await new Promise(resolve => setTimeout(resolve, ${holdMs}));
          config.accounts.push({ name: ${JSON.stringify(name)}, type: 'apikey', apiKey: 'test' });
        });
      `;
      const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
        env: { ...process.env, TEAMCLAUDE_CONFIG: cfgPath },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', code => {
        if (code === 0) resolve();
        else reject(new Error(`writer ${name} exited ${code}: ${stderr}`));
      });
    });

    await Promise.all([runWriter('A', 120), runWriter('B', 0)]);

    const final = JSON.parse(await readFile(cfgPath, 'utf8'));
    assert.deepEqual(final.accounts.map(a => a.name).sort(), ['A', 'B']);
    assert.equal((await readdir(dir)).some(name => name.includes('.lock')), false,
      'lock and candidate files are cleaned up');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('atomicConfigUpdate recovers a lock whose owner process is dead', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-cfg-stale-lock-'));
  const cfgPath = join(dir, 'teamclaude.json');
  const prev = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = cfgPath;
  try {
    await writeFile(cfgPath, JSON.stringify({ proxy: { port: 1 }, accounts: [] }) + '\n', { mode: 0o600 });
    await writeFile(`${cfgPath}.lock`, JSON.stringify({ pid: 2_147_483_647, nonce: 'dead' }), { mode: 0o600 });

    await atomicConfigUpdate(config => {
      config.accounts.push({ name: 'recovered', type: 'apikey', apiKey: 'test' });
    });

    const final = JSON.parse(await readFile(cfgPath, 'utf8'));
    assert.deepEqual(final.accounts.map(account => account.name), ['recovered']);
    assert.equal((await readdir(dir)).some(name => name.includes('.lock')), false);
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
