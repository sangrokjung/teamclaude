import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atomicConfigUpdate,
  createDefaultConfig,
  readQuotaCache,
  saveConfig,
  writeQuotaCacheSync,
} from '../src/config.js';
import { applyTuiAccountMutation } from '../src/tui.js';

// node --test runs each test file in its own process, so setting TEAMCLAUDE_CONFIG
// (and the module-level write chain) here doesn't leak into other test files.

test('default config bounds Claude connection recovery to fifteen minutes', () => {
  assert.equal(createDefaultConfig().claudeConnectionRecoveryMaxWaitMs, 900000);
});

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

test('TUI account patch preserves an account added by an external writer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-cfg-tui-'));
  const cfgPath = join(dir, 'teamclaude.json');
  const prev = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = cfgPath;
  const snapshot = {
    accounts: [{ name: 'A', type: 'apikey', apiKey: 'a' }],
  };
  const accountManager = {
    accounts: [{ name: 'A', type: 'apikey', credential: 'a' }],
  };
  try {
    await writeFile(cfgPath, JSON.stringify({
      proxy: { port: 1 },
      accounts: snapshot.accounts,
    }, null, 2) + '\n', { mode: 0o600 });

    await atomicConfigUpdate(config => {
      config.accounts.push({ name: 'B', type: 'apikey', apiKey: 'b' });
    });
    await atomicConfigUpdate(diskConfig => {
      applyTuiAccountMutation(diskConfig, snapshot, accountManager, {
        type: 'patch',
        account: snapshot.accounts[0],
        fields: { enabled: false },
      });
    });

    const final = JSON.parse(await readFile(cfgPath, 'utf8'));
    assert.deepEqual(final.accounts.map(account => account.name), ['A', 'B']);
    assert.equal(final.accounts[0].enabled, false);
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test('TUI account mutations do not resurrect removals or delete UUID replacements', () => {
  const staleSnapshot = {
    accounts: [
      { name: 'A', type: 'oauth', accountUuid: 'old-a', accessToken: 'old-a-token' },
      { name: 'B', type: 'apikey', apiKey: 'b' },
    ],
  };
  const accountManager = {
    accounts: [
      { name: 'A', type: 'oauth', accountUuid: 'old-a', credential: 'old-a-token' },
      { name: 'B', type: 'apikey', credential: 'b' },
    ],
  };
  const afterExternalRemoval = {
    accounts: [{ name: 'B', type: 'apikey', apiKey: 'b' }],
  };
  applyTuiAccountMutation(afterExternalRemoval, staleSnapshot, accountManager, {
    type: 'batchPatch',
    patches: staleSnapshot.accounts.map(account => ({
      account,
      fields: { priority: 0 },
    })),
  });
  assert.deepEqual(afterExternalRemoval.accounts.map(account => account.name), ['B']);
  assert.equal(afterExternalRemoval.accounts[0].priority, 0);

  const afterExternalReplacement = {
    accounts: [{ name: 'A', type: 'oauth', accountUuid: 'new-a', accessToken: 'new-a-token' }],
  };
  applyTuiAccountMutation(afterExternalReplacement, staleSnapshot, accountManager, {
    type: 'remove',
    account: staleSnapshot.accounts[0],
  });
  assert.deepEqual(afterExternalReplacement.accounts, [
    { name: 'A', type: 'oauth', accountUuid: 'new-a', accessToken: 'new-a-token' },
  ]);

  const afterExternalAddition = {
    accounts: [
      staleSnapshot.accounts[0],
      { name: 'C', type: 'apikey', apiKey: 'c' },
    ],
  };
  const reimportSnapshot = {
    accounts: [{ name: 'A', type: 'oauth', accountUuid: 'new-a', accessToken: 'new-a-token' }],
  };
  applyTuiAccountMutation(afterExternalAddition, reimportSnapshot, {
    accounts: [{ name: 'A', type: 'oauth', accountUuid: 'new-a', credential: 'new-a-token' }],
  }, {
    type: 'upsert',
    account: reimportSnapshot.accounts[0],
    previous: staleSnapshot.accounts[0],
  });
  assert.deepEqual(afterExternalAddition.accounts.map(account => account.name), ['A', 'C']);
  assert.equal(afterExternalAddition.accounts[0].accountUuid, 'new-a');
  assert.equal(afterExternalAddition.accounts[0].accessToken, 'new-a-token');
});

test('stale TUI upsert does not revive an externally replaced or removed UUID', () => {
  const oldAccount = {
    name: 'A',
    type: 'oauth',
    accountUuid: 'old-a',
    accessToken: 'old-a-token',
  };
  const snapshot = { accounts: [oldAccount] };
  const accountManager = {
    accounts: [{ ...oldAccount, credential: 'old-a-token' }],
  };
  const mutation = {
    type: 'upsert',
    account: oldAccount,
    previous: oldAccount,
  };

  const externallyReplaced = {
    accounts: [{
      name: 'A',
      type: 'oauth',
      accountUuid: 'new-a',
      accessToken: 'new-a-token',
    }],
  };
  applyTuiAccountMutation(externallyReplaced, snapshot, accountManager, mutation);
  assert.deepEqual(externallyReplaced.accounts, [{
    name: 'A',
    type: 'oauth',
    accountUuid: 'new-a',
    accessToken: 'new-a-token',
  }]);

  const externallyRemoved = { accounts: [] };
  applyTuiAccountMutation(externallyRemoved, snapshot, accountManager, mutation);
  assert.deepEqual(externallyRemoved.accounts, []);
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

test('atomic config and quota renames fsync their parent directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-cfg-durability-'));
  const cfgPath = join(dir, 'teamclaude.json');
  const moduleUrl = new URL('../src/config.js', import.meta.url).href;
  try {
    await writeFile(cfgPath, JSON.stringify({ accounts: [] }) + '\n', { mode: 0o600 });
    const source = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const directory = ${JSON.stringify(dir)};
      let asyncDirectorySyncs = 0;
      let syncDirectorySyncs = 0;
      const directoryFds = new Set();
      const originalOpen = fs.promises.open.bind(fs.promises);
      fs.promises.open = async (path, ...args) => {
        const handle = await originalOpen(path, ...args);
        if (path === directory) {
          const originalSync = handle.sync.bind(handle);
          handle.sync = async () => {
            asyncDirectorySyncs += 1;
            return originalSync();
          };
        }
        return handle;
      };
      const originalOpenSync = fs.openSync.bind(fs);
      const originalFsyncSync = fs.fsyncSync.bind(fs);
      fs.openSync = (path, ...args) => {
        const fd = originalOpenSync(path, ...args);
        if (path === directory) directoryFds.add(fd);
        return fd;
      };
      fs.fsyncSync = fd => {
        if (directoryFds.has(fd)) syncDirectorySyncs += 1;
        return originalFsyncSync(fd);
      };
      syncBuiltinESMExports();
      const { saveConfig, writeQuotaCacheSync } = await import(${JSON.stringify(moduleUrl)});
      await saveConfig({ accounts: [{ name: 'A', type: 'apikey', apiKey: 'masked' }] });
      writeQuotaCacheSync({ savedAt: 1, accounts: [] });
      process.stdout.write(JSON.stringify({ asyncDirectorySyncs, syncDirectorySyncs }));
    `;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
        env: { ...process.env, TEAMCLAUDE_CONFIG: cfgPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout = [];
      const stderr = [];
      child.stdout.on('data', chunk => stdout.push(chunk));
      child.stderr.on('data', chunk => stderr.push(chunk));
      child.once('error', reject);
      child.once('exit', code => {
        if (code === 0) {
          resolve(JSON.parse(Buffer.concat(stdout).toString()));
        } else {
          reject(new Error(`durability probe exited ${code}: ${Buffer.concat(stderr).toString()}`));
        }
      });
    });
    assert.ok(result.asyncDirectorySyncs > 0, 'async rename must fsync its directory');
    assert.ok(result.syncDirectorySyncs > 0, 'sync rename must fsync its directory');
  } finally {
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

test('stale-lock recovery never removes a concurrently acquired live lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-cfg-stale-race-'));
  const cfgPath = join(dir, 'teamclaude.json');
  const lockPath = `${cfgPath}.lock`;
  const moduleUrl = new URL('../src/config.js', import.meta.url).href;
  const children = [];
  const pendingMessages = [];
  const waitForMessage = (child, type) => {
    const pending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${type}`));
      }, 3_000);
      const onMessage = message => {
        if (message?.type !== type) return;
        cleanup();
        resolve(message);
      };
      const onExit = code => {
        cleanup();
        reject(new Error(`writer exited ${code} before ${type}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.removeListener('message', onMessage);
        child.removeListener('exit', onExit);
      };
      child.on('message', onMessage);
      child.once('exit', onExit);
    });
    pendingMessages.push(pending);
    return pending;
  };
  const spawnWriter = (name, pauseBeforeStaleRemove) => {
    const source = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const lockPath = ${JSON.stringify(lockPath)};
      if (${pauseBeforeStaleRemove}) {
        const originalRm = fs.promises.rm.bind(fs.promises);
        let paused = false;
        fs.promises.rm = async (target, options) => {
          if (!paused && target === lockPath) {
            paused = true;
            process.send({ type: 'before-stale-remove' });
            await new Promise(resolve => process.once('message', resolve));
          }
          return originalRm(target, options);
        };
        syncBuiltinESMExports();
      }
      const { atomicConfigUpdate } = await import(${JSON.stringify(moduleUrl)});
      await atomicConfigUpdate(async config => {
        process.send({ type: 'entered' });
        await new Promise(resolve => process.once('message', resolve));
        config.accounts.push({ name: ${JSON.stringify(name)}, type: 'apikey', apiKey: 'test' });
      });
      process.send({ type: 'done' });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      env: { ...process.env, TEAMCLAUDE_CONFIG: cfgPath },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.push(child);
    return child;
  };

  try {
    await writeFile(cfgPath, JSON.stringify({ proxy: { port: 1 }, accounts: [] }) + '\n',
      { mode: 0o600 });
    await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, nonce: 'dead' }),
      { mode: 0o600 });

    const writerA = spawnWriter('A', true);
    const aBeforeRemove = waitForMessage(writerA, 'before-stale-remove');
    const aEntered = waitForMessage(writerA, 'entered');
    const aDone = waitForMessage(writerA, 'done');
    await aBeforeRemove;

    const writerB = spawnWriter('B', false);
    const bEntered = waitForMessage(writerB, 'entered');
    const bDone = waitForMessage(writerB, 'done');
    const bWasBlocked = await Promise.race([
      bEntered.then(() => false),
      new Promise(resolve => setTimeout(() => resolve(true), 150)),
    ]);
    assert.equal(bWasBlocked, true,
      'a competing recovery must wait before it can replace the stale lock');

    writerA.send('remove-stale-lock');
    await aEntered;
    writerA.send('write');
    await aDone;

    await bEntered;
    writerB.send('write');
    await bDone;

    const final = JSON.parse(await readFile(cfgPath, 'utf8'));
    assert.deepEqual(final.accounts.map(account => account.name).sort(), ['A', 'B']);
  } finally {
    for (const child of children) {
      if (child.exitCode == null) child.kill('SIGKILL');
    }
    await Promise.allSettled(pendingMessages);
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
