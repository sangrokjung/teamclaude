import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFeederState, withFeederLock, writeFeederState } from '../src/cloud-feeder-io.js';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-feeder-io-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('state: missing is a fresh start, corrupt is an error, writes round-trip', async t => {
  const dir = await scratch(t);
  const path = join(dir, 'state.json');
  assert.deepEqual(await readFeederState(path), { sent: {} });
  await writeFile(path, '{not json');
  await assert.rejects(readFeederState(path));
  await writeFile(path, '{"sent": 5}');
  await assert.rejects(readFeederState(path));
  await writeFeederState({ sent: { a: { exit: 0 } } }, path);
  assert.deepEqual(await readFeederState(path), { sent: { a: { exit: 0 } } });
});

test('lock: a live holder blocks, a dead holder is taken over, only the owner releases', async t => {
  const dir = await scratch(t);
  const lock = join(dir, 'lock');
  // Held by this (live) process.
  await writeFile(lock, JSON.stringify({ pid: process.pid, nonce: 'other' }));
  assert.deepEqual(await withFeederLock(async () => 'ran', lock), { locked: true });
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).nonce, 'other', 'a live holder keeps its lock');
  // A holder whose pid no longer exists is taken over.
  await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, nonce: 'dead' }));
  assert.deepEqual(await withFeederLock(async () => 'ran', lock), { locked: false, value: 'ran' });
  await assert.rejects(readFile(lock, 'utf8'), 'released after the run');
  // A lock replaced by someone else during the run is not removed by us.
  const result = await withFeederLock(async () => {
    await writeFile(lock, JSON.stringify({ pid: process.pid, nonce: 'newcomer' }));
    return 'ran';
  }, lock);
  assert.equal(result.value, 'ran');
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).nonce, 'newcomer');
});
