import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimSessionLease,
  releaseSessionLease,
} from '../src/cmux-session-guards.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const guardsUrl = new URL('../src/cmux-session-guards.js', import.meta.url).href;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-lease-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = join(root, 'sessions.json');
  const dir = `${store}.recovery-leases`;
  await mkdir(dir, { mode: 0o700 });
  return { store, dir, path: join(dir, SESSION) };
}

function child(t, fx, holdInClaim = false) {
  const script = `
    import { claimSessionLease } from ${JSON.stringify(guardsUrl)};
    process.on('message', async () => {
      try {
        const options = ${holdInClaim} ? (() => {
          let inspections = 0;
          return {
            inspectProcessStart: async () => {
              inspections += 1;
              if (inspections === 1) return 123;
              process.send({ locked: true });
              return new Promise(() => {});
            },
          };
        })() : {};
        const lease = await claimSessionLease(process.argv[1], process.argv[2], options);
        process.send({ acquired: Boolean(lease) });
      } catch (error) { process.send({ error: error.message }); }
    });
    process.send({ ready: true });
  `;
  const proc = spawn(process.execPath, ['--input-type=module', '-e', script, fx.store, SESSION], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (proc.exitCode == null && proc.signalCode == null) {
      const exited = once(proc, 'exit');
      proc.kill('SIGKILL');
      await exited;
    }
    assert.equal(stderr, '');
  });
  return proc;
}

async function message(proc) {
  const [value] = await once(proc, 'message', { signal: AbortSignal.timeout(5000) });
  assert.equal(value.error, undefined, value.error);
  return value;
}

for (const mode of ['null', 'throw']) {
  test(`live owner survives process inspection ${mode}`, async t => {
    const fx = await fixture(t);
    const original = JSON.stringify({ version: 1, pid: process.ppid, processStartSeconds: 1 });
    await writeFile(fx.path, original, { mode: 0o600 });
    const lease = await claimSessionLease(fx.store, SESSION, {
      inspectProcessStart: async pid => {
        if (pid === process.pid) return 123;
        if (mode === 'throw') throw new Error('ps timeout');
        return null;
      },
    });
    assert.equal(lease, false);
    assert.equal(await readFile(fx.path, 'utf8'), original);
  });
}

test('failed self inspection cannot publish a lease', async t => {
  const fx = await fixture(t);
  await assert.rejects(claimSessionLease(fx.store, SESSION, {
    inspectProcessStart: async () => null,
  }), /owner identity/);
  await assert.rejects(readFile(fx.path), { code: 'ENOENT' });
});

test('PID reuse with a different start time can be reclaimed', async t => {
  const fx = await fixture(t);
  await writeFile(fx.path, JSON.stringify({
    version: 1, pid: process.pid, processStartSeconds: 1,
  }), { mode: 0o600 });
  const lease = await claimSessionLease(fx.store, SESSION);
  assert.ok(lease);
  assert.equal(await releaseSessionLease(fx.store, SESSION, lease), true);
});

test('release cannot delete a replacement lease or release without identity', async t => {
  const fx = await fixture(t);
  const lease = await claimSessionLease(fx.store, SESSION);
  await rename(fx.path, `${fx.path}.old`);
  const replacement = await claimSessionLease(fx.store, SESSION);
  assert.ok(replacement);
  assert.equal(await releaseSessionLease(fx.store, SESSION, lease), false);
  assert.equal(await releaseSessionLease(fx.store, SESSION), false);
  assert.equal(await releaseSessionLease(fx.store, SESSION, replacement), true);
});

test('malformed legacy lease is quarantined and the recovery attempt fails closed', async t => {
  const fx = await fixture(t);
  await writeFile(fx.path, '{', { mode: 0o600 });
  const lease = await claimSessionLease(fx.store, SESSION);
  assert.equal(lease, false);
  await assert.rejects(readFile(fx.path), { code: 'ENOENT' });
  const entries = await readdir(fx.dir);
  assert.ok(entries.some(entry => entry.startsWith(`${SESSION}.corrupt-`)));
  const retry = await claimSessionLease(fx.store, SESSION);
  assert.ok(retry);
  assert.equal(await releaseSessionLease(fx.store, SESSION, retry), true);
});

test('unsupported lease versions fail closed after quarantine', async t => {
  const fx = await fixture(t);
  await writeFile(fx.path, JSON.stringify({
    version: 2,
    pid: process.pid,
    processStartSeconds: 123,
  }), { mode: 0o600 });
  assert.equal(await claimSessionLease(fx.store, SESSION, {
    inspectProcessStart: async pid => (pid === process.pid ? 123 : null),
  }), false);
  assert.equal(await readFile(fx.path, 'utf8'), JSON.stringify({
    version: 2,
    pid: process.pid,
    processStartSeconds: 123,
  }));
  const entries = await readdir(fx.dir);
  assert.equal(entries.some(entry => entry.startsWith(`${SESSION}.corrupt-`)), false);
});

test('two real processes reclaim a stale lease with exactly one winner', async t => {
  const fx = await fixture(t);
  await writeFile(fx.path, JSON.stringify({
    version: 1, pid: 99999999, processStartSeconds: 1,
  }), { mode: 0o600 });
  const a = child(t, fx);
  const b = child(t, fx);
  await Promise.all([message(a), message(b)]);
  const outcomes = Promise.all([message(a), message(b)]);
  a.send('go');
  b.send('go');
  const results = await outcomes;
  assert.equal(results.filter(result => result.acquired).length, 1);
  assert.equal(await claimSessionLease(fx.store, SESSION), false);
});

test('SIGKILL during claim releases the kernel mutex for the next claimant', async t => {
  const fx = await fixture(t);
  const owner = child(t, fx, true);
  await message(owner);
  await writeFile(fx.path, JSON.stringify({
    version: 1,
    pid: owner.pid,
    processStartSeconds: 1,
  }), { mode: 0o600 });
  const locked = message(owner);
  owner.send('go');
  assert.deepEqual(await locked, { locked: true });
  const exited = once(owner, 'exit');
  owner.kill('SIGKILL');
  await exited;
  const lease = await claimSessionLease(fx.store, SESSION);
  assert.ok(lease);
  assert.equal(await releaseSessionLease(fx.store, SESSION, lease), true);
});
