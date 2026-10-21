import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { feederStatePath, readFeederState, withFeederLock, writeFeederState } from '../src/cloud-feeder-io.js';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-feeder-io-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('feeder state follows TEAMCLAUDE_CONFIG, so two pools on one machine never share budget or history', t => {
  const previousConfig = process.env.TEAMCLAUDE_CONFIG;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  t.after(() => {
    if (previousConfig === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = previousConfig;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  });
  delete process.env.XDG_CONFIG_HOME;
  process.env.TEAMCLAUDE_CONFIG = '/tmp/pool-a/teamclaude.json';
  const a = feederStatePath();
  process.env.TEAMCLAUDE_CONFIG = '/tmp/pool-b/teamcodex.json';
  const b = feederStatePath();
  assert.notEqual(a, b);
  assert.equal(a, '/tmp/pool-a/teamclaude.cloud-feeder.json');
  assert.equal(b, '/tmp/pool-b/teamcodex.cloud-feeder.json');
});

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

test('REST listing reads page by page, reports truncated or failing repos, keeps the rest', { skip: process.platform === 'win32' }, async t => {
  const dir = await scratch(t);
  // A fake `gh`: o/full always returns full pages (never ends), o/broken
  // fails, o/small returns one short page of one PR.
  const fake = join(dir, 'gh');
  await writeFile(fake, `#!/bin/sh
case "$2" in
  repos/o/full/*) node -e 'console.log(JSON.stringify(Array.from({length:100},(_,i)=>({number:i+1,title:"t",draft:false,user:{login:"me"},author_association:"OWNER",head:{ref:"b",sha:"${'a'.repeat(40)}",repo:{full_name:"o/full"}}}))))' ;;
  repos/o/broken/*) echo 'boom' >&2; exit 1 ;;
  repos/o/small/*) echo '[{"number":7,"title":"t","draft":false,"user":{"login":"me"},"author_association":"OWNER","head":{"ref":"b","sha":"${'b'.repeat(40)}","repo":{"full_name":"o/small"}}}]' ;;
esac
`);
  await chmod(fake, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous}`;
  t.after(() => { process.env.PATH = previous; });
  const { listPulls } = await import('../src/cloud-feeder-io.js');
  const logs = [];
  const result = listPulls(['o/full', 'o/broken', 'o/small'], line => logs.push(line));
  assert.deepEqual(result.incomplete, ['o/full', 'o/broken']);
  assert.equal(result.items.filter(p => p.repository.nameWithOwner === 'o/full').length, 3000);
  assert.deepEqual(result.items.filter(p => p.repository.nameWithOwner === 'o/small').map(p => p.number), [7]);
  assert.ok(logs.some(line => /o\/full truncated/.test(line)) && logs.some(line => /o\/broken failed/.test(line)));
});

test('commit checks: statuses are read across pages and an unexplained aggregate state is unknown', { skip: process.platform === 'win32' }, async t => {
  const dir = await scratch(t);
  const fake = join(dir, 'gh');
  const sha = 'c'.repeat(40);
  // Status pages: 30 successes on page 1, one failure on page 2 (total 31).
  await writeFile(fake, `#!/bin/sh
case "$2" in
  repos/o/paged/commits/*/check-runs*) echo '{"check_runs":[{"name":"ci","status":"completed","conclusion":"success"}]}' ;;
  repos/o/paged/commits/*/status*page=1) node -e 'console.log(JSON.stringify({state:"failure",total_count:31,statuses:Array.from({length:30},(_,i)=>({context:"s"+i,state:"success"}))}))' ;;
  repos/o/paged/commits/*/status*page=2) echo '{"state":"failure","total_count":31,"statuses":[{"context":"late","state":"failure"}]}' ;;
  repos/o/liar/commits/*/check-runs*) echo '{"check_runs":[{"name":"ci","status":"completed","conclusion":"success"}]}' ;;
  repos/o/liar/commits/*/status*) echo '{"state":"failure","total_count":1,"statuses":[{"context":"x","state":"success"}]}' ;;
  repos/o/short/commits/*/check-runs*) echo '{"check_runs":[]}' ;;
  repos/o/short/commits/*/status*) echo '{"state":"success","total_count":5,"statuses":[]}' ;;
esac
`);
  await chmod(fake, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous}`;
  t.after(() => { process.env.PATH = previous; });
  const { listChecks } = await import('../src/cloud-feeder-io.js');
  const paged = listChecks('o/paged', sha);
  assert.equal(paged.length, 32);
  assert.ok(paged.some(check => check.name === 'late' && check.bucket === 'fail'));
  assert.equal(listChecks('o/liar', sha), null, 'aggregate failure without a failing status');
  assert.equal(listChecks('o/short', sha), null, 'fewer statuses than total_count');
});
