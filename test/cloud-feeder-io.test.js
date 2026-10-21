import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextSearchCursor, readFeederState, withFeederLock, writeFeederState } from '../src/cloud-feeder-io.js';

test('search cursor: advances on a full page, wraps on a short one, never stalls on one timestamp', () => {
  const page = times => times.map(createdAt => ({ createdAt }));
  assert.equal(nextSearchCursor(page(['2026-01-01T00:00:00Z']), null, 2), null);
  assert.equal(nextSearchCursor(page(['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z']), null, 2), '2026-01-02T00:00:00Z');
  // Full page entirely at the cursor's own second: step past it.
  assert.equal(nextSearchCursor(page(['2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z']), '2026-01-02T00:00:00Z', 2), '2026-01-02T00:00:01Z');
});

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-feeder-io-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('state: missing is a fresh start, any corruption is an error, writes round-trip', async t => {
  const dir = await scratch(t);
  const path = join(dir, 'state.json');
  assert.deepEqual(await readFeederState(path), { sent: {} });
  for (const corrupt of [
    '{not json', '{"sent": 5}', '{"sent": null}', '{"sent": []}', '[]',
    '{"sent": {"k": {"ts": "2026-10-21T00:00:00Z"}}}',
    '{"sent": {"k": {"exit": 7, "ts": "2026-10-21T00:00:00Z"}}}',
    '{"sent": {"k": {"exit": 0, "ts": "yesterday"}}}',
    '{"sent": {"k": null}}',
    '{"sent": {"k": {"exit": 0, "ts": "2026-10-21T00:00:00Z", "repo": "o/a"}}}',
    '{"sent": {"k": {"exit": 3, "ts": "2026-10-21T00:00:00Z"}}}',
  ]) {
    await writeFile(path, corrupt);
    await assert.rejects(readFeederState(path), corrupt);
  }
  const good = { sent: {
    a: { exit: 0, ts: '2026-10-21T00:00:00Z', repo: 'o/a', branch: 'teamclaude-handoff/x', merge: 'pending' },
    b: { exit: 3, ts: '2026-10-21T00:00:00Z', repo: 'o/a', reason: 'no-credit-account' },
  } };
  await writeFeederState(good, path);
  assert.deepEqual(await readFeederState(path), good);
});

test('lock: an OS lock, held by one run at a time and freed when the holder dies', { skip: process.platform !== 'darwin' }, async t => {
  const dir = await scratch(t);
  const lock = join(dir, 'lock');
  // Nested acquisition while held is refused; after release it is free again.
  const outer = await withFeederLock(async () => withFeederLock(async () => 'inner', lock), lock);
  assert.deepEqual(outer, { locked: false, value: { locked: true } });
  assert.deepEqual(await withFeederLock(async () => 'again', lock), { locked: false, value: 'again' });

  // Another process holding it blocks us; once it exits, the kernel frees it.
  const holder = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    fs.openSync(${JSON.stringify(lock)}, fs.constants.O_RDWR | fs.constants.O_CREAT | 0x20);
    process.stdout.write('held\\n');
    setTimeout(() => {}, 60000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise(resolve => holder.stdout.once('data', resolve));
  assert.deepEqual(await withFeederLock(async () => 'ran', lock), { locked: true });
  holder.kill('SIGKILL');
  await new Promise(resolve => holder.once('exit', resolve));
  assert.deepEqual(await withFeederLock(async () => 'ran', lock), { locked: false, value: 'ran' });
});
