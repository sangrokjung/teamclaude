import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteRemoteBranch, feederStatePath, readFeederState, withFeederLock, writeFeederState } from '../src/cloud-feeder-io.js';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-feeder-io-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function cleanupFixture(t) {
  const dir = await scratch(t);
  const cwd = join(dir, 'work');
  const bareA = join(dir, 'a.git');
  const bareB = join(dir, 'b.git');
  git(dir, 'init', '--quiet', '--bare', bareA);
  git(dir, 'init', '--quiet', '--bare', bareB);
  git(dir, 'init', '--quiet', '-b', 'main', cwd);
  git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'config', 'user.email', 'test@example.invalid');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(cwd, 'f.txt'), 'x\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '--quiet', '-m', 'init');
  git(cwd, 'push', '--quiet', bareA, `HEAD:refs/heads/teamclaude-handoff/x`);
  return { cwd, bareA, bareB };
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
  assert.equal(a, '/tmp/pool-a/teamclaude.json.cloud-feeder.json');
  assert.equal(b, '/tmp/pool-b/teamcodex.json.cloud-feeder.json');
});

test('an extensionless TEAMCLAUDE_CONFIG never collides with a .json sibling of the same stem', t => {
  const previousConfig = process.env.TEAMCLAUDE_CONFIG;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  t.after(() => {
    if (previousConfig === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = previousConfig;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  });
  delete process.env.XDG_CONFIG_HOME;
  process.env.TEAMCLAUDE_CONFIG = '/x/profile';
  const extensionless = feederStatePath();
  process.env.TEAMCLAUDE_CONFIG = '/x/profile.json';
  const withExtension = feederStatePath();
  assert.notEqual(extensionless, withExtension);
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
    '{"sent": {}, "pendingCleanup": {}}',
    '{"sent": {}, "pendingCleanup": [{"branch": "x", "ts": "2026-10-21T00:00:00Z"}]}',
    '{"sent": {}, "pendingCleanup": [{"repo": "o/a", "ts": "2026-10-21T00:00:00Z"}]}',
    '{"sent": {}, "pendingCleanup": [{"repo": "o/a", "branch": "x", "ts": "not-a-date"}]}',
  ]) {
    await writeFile(path, corrupt);
    await assert.rejects(readFeederState(path), corrupt);
  }
  const good = { sent: {
    a: { exit: 0, ts: '2026-10-21T00:00:00Z', repo: 'o/a', branch: 'teamclaude-handoff/x', merge: 'pending' },
    b: { exit: 3, ts: '2026-10-21T00:00:00Z', repo: 'o/a', reason: 'no-credit-account' },
  },
  // remoteUrl is optional (older state written before it was tracked).
  pendingCleanup: [{ repo: 'o/a', branch: 'stale-1', ts: '2026-10-21T00:00:00Z' }] };
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

test('lock: a non-darwin host reports unsupported plainly, never claims contention, and never runs the body', async t => {
  const dir = await scratch(t);
  const lock = join(dir, 'lock');
  let ran = false;
  const outcome = await withFeederLock(async () => { ran = true; return 'x'; }, lock, { platform: 'linux' });
  assert.deepEqual(outcome, { locked: false, unsupported: true });
  assert.equal(ran, false, 'the O_EXLOCK trick is macOS-only — never attempted elsewhere');
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

test('an overall cap bounds total items across ALL repos, skipping later repos without even querying them', { skip: process.platform === 'win32' }, async t => {
  const dir = await scratch(t);
  const calls = join(dir, 'calls.log');
  const fake = join(dir, 'gh');
  await writeFile(fake, `#!/bin/sh
echo "$2" >> ${JSON.stringify(calls)}
case "$2" in
  repos/o/full1/*) node -e 'console.log(JSON.stringify(Array.from({length:100},(_,i)=>({number:i+1,title:"t",draft:false,user:{login:"me"},author_association:"OWNER",head:{ref:"b",sha:"${'a'.repeat(40)}",repo:{full_name:"o/full1"}}}))))' ;;
  repos/o/full2/*) node -e 'console.log(JSON.stringify(Array.from({length:100},(_,i)=>({number:i+1,title:"t",draft:false,user:{login:"me"},author_association:"OWNER",head:{ref:"b",sha:"${'b'.repeat(40)}",repo:{full_name:"o/full2"}}}))))' ;;
  repos/o/never/*) echo '[{"number":1,"title":"t","draft":false,"user":{"login":"me"},"author_association":"OWNER","head":{"ref":"b","sha":"${'c'.repeat(40)}","repo":{"full_name":"o/never"}}}]' ;;
esac
`);
  await chmod(fake, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous}`;
  t.after(() => { process.env.PATH = previous; });
  const { listPulls } = await import('../src/cloud-feeder-io.js');
  const result = listPulls(['o/full1', 'o/full2', 'o/never']);
  assert.equal(result.items.length, 6000, 'each full repo caps at 3000 on its own; together they exactly fill the overall cap');
  assert.deepEqual(result.incomplete, ['o/full1', 'o/full2', 'o/never']);
  const calledRepos = (await readFile(calls, 'utf8')).split('\n').filter(Boolean);
  assert.ok(!calledRepos.some(line => line.includes('o/never')), 'o/never must never be queried once the overall cap is already reached');
});

test('the overall cap holds exactly even when no single repo lands on a round multiple of it', { skip: process.platform === 'win32' }, async t => {
  const dir = await scratch(t);
  const fake = join(dir, 'gh');
  // o/a ends naturally just short of a full page (2999, not truncated by
  // anything); o/b would naturally fill to its own full 3000; o/c would too,
  // but only 1 slot is left in the overall budget by the time it's reached.
  // Before the fix, perRepo added each repo's FULL result before ever
  // checking the running total against the next repo, so this exact shape
  // (2999 + 3000 + 3000) would have produced 8999 instead of exactly 6000.
  await writeFile(fake, `#!/bin/sh
case "$2" in
  repos/o/a/*page=30*) node -e 'console.log(JSON.stringify(Array.from({length:99},(_,i)=>({number:i+1,title:"t",draft:false,user:{login:"me"},author_association:"OWNER",head:{ref:"b",sha:"${'a'.repeat(40)}",repo:{full_name:"o/a"}}}))))' ;;
  repos/o/a/*) node -e 'console.log(JSON.stringify(Array.from({length:100},(_,i)=>({number:i+1,title:"t",draft:false,user:{login:"me"},author_association:"OWNER",head:{ref:"b",sha:"${'a'.repeat(40)}",repo:{full_name:"o/a"}}}))))' ;;
  repos/o/b/*) node -e 'console.log(JSON.stringify(Array.from({length:100},(_,i)=>({number:i+1,title:"t",draft:false,user:{login:"me"},author_association:"OWNER",head:{ref:"b",sha:"${'b'.repeat(40)}",repo:{full_name:"o/b"}}}))))' ;;
  repos/o/c/*) node -e 'console.log(JSON.stringify(Array.from({length:100},(_,i)=>({number:i+1,title:"t",draft:false,user:{login:"me"},author_association:"OWNER",head:{ref:"b",sha:"${'c'.repeat(40)}",repo:{full_name:"o/c"}}}))))' ;;
esac
`);
  await chmod(fake, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous}`;
  t.after(() => { process.env.PATH = previous; });
  const { listPulls } = await import('../src/cloud-feeder-io.js');
  const result = listPulls(['o/a', 'o/b', 'o/c']);
  assert.equal(result.items.length, 6000, 'must stop exactly at the overall cap, never past it');
  assert.equal(result.items.filter(p => p.repository.nameWithOwner === 'o/a').length, 2999);
  assert.equal(result.items.filter(p => p.repository.nameWithOwner === 'o/b').length, 3000);
  assert.equal(result.items.filter(p => p.repository.nameWithOwner === 'o/c').length, 1);
  assert.deepEqual(result.incomplete, ['o/b', 'o/c']);
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

test('deleteRemoteBranch deletes the exact branch from the exact verified URL', async t => {
  const { cwd, bareA } = await cleanupFixture(t);
  assert.equal(await deleteRemoteBranch(cwd, 'teamclaude-handoff/x', bareA), true);
  assert.equal(git(bareA, 'branch', '--list', 'teamclaude-handoff/*'), '');
});

test('deleteRemoteBranch refuses when a rewrite rule now redirects its own verified destination', async t => {
  const { cwd, bareA, bareB } = await cleanupFixture(t);
  // A rule added to the clone's config AFTER the branch was originally
  // pushed, that would silently redirect this exact, already-resolved URL
  // somewhere else. The delete must refuse rather than let that happen.
  git(cwd, 'config', `url.${bareB}.insteadOf`, bareA);
  assert.equal(await deleteRemoteBranch(cwd, 'teamclaude-handoff/x', bareA), false);
  // Neither destination was touched: not the real one (refused before
  // pushing), and not the decoy either (deleteRemoteBranch never pushes once
  // it refuses).
  assert.equal(git(bareA, 'branch', '--list', 'teamclaude-handoff/*'), 'teamclaude-handoff/x');
  assert.equal(git(bareB, 'branch', '--list', 'teamclaude-handoff/*'), '');
});

test('deleteRemoteBranch with the default origin never runs the rewrite check (legacy state compatibility)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-feeder-io-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'work');
  const bare = join(dir, 'origin.git');
  git(dir, 'init', '--quiet', '--bare', bare);
  git(dir, 'init', '--quiet', '-b', 'main', cwd);
  git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'config', 'user.email', 'test@example.invalid');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  git(cwd, 'remote', 'add', 'origin', bare);
  await writeFile(join(cwd, 'f.txt'), 'x\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '--quiet', '-m', 'init');
  git(cwd, 'push', '--quiet', 'origin', 'HEAD:refs/heads/teamclaude-handoff/legacy');
  assert.equal(await deleteRemoteBranch(cwd, 'teamclaude-handoff/legacy'), true);
});

test('listTasks caps the overall backlog it reads, instead of walking a huge todo table to the end', { skip: process.platform === 'win32' }, async t => {
  const fakeHome = await scratch(t);
  const binDir = join(fakeHome, '.claude', 'bin');
  await mkdir(binDir, { recursive: true });
  const counterFile = join(fakeHome, 'page-counter');
  // Each call returns one more full (1000-row) page, with a later created_at
  // than the last — a real keyset page boundary, so the cursor logic takes
  // the normal "page is full, keep going" path every time, never the
  // small-last-page termination.
  await writeFile(join(binDir, 'sb-sql'), `#!/bin/sh
PAGE=0
if [ -f ${JSON.stringify(counterFile)} ]; then PAGE=$(cat ${JSON.stringify(counterFile)}); fi
PAGE=$((PAGE+1))
echo $PAGE > ${JSON.stringify(counterFile)}
printf '{"rows":['
i=1
while [ $i -le 1000 ]; do
  if [ $i -gt 1 ]; then printf ','; fi
  printf '{"id":"00000000-0000-0000-0000-%012d","title":"t","description":"","github_repo":"o/a","created_at":"2026-01-%02dT00:00:00.000Z"}' $((PAGE*1000+i)) $PAGE
  i=$((i+1))
done
printf ']}'
`);
  await chmod(join(binDir, 'sb-sql'), 0o755);
  const previousHome = process.env.HOME;
  process.env.HOME = fakeHome;
  t.after(() => { process.env.HOME = previousHome; });
  const { listTasks } = await import('../src/cloud-feeder-io.js');
  const result = listTasks();
  assert.equal(result.items.length, 6000, 'stops at the overall cap, not the end of the (fake, endless) table');
  assert.deepEqual(result.incomplete, ['os_tasks']);
  assert.equal(await readFile(counterFile, 'utf8').then(s => s.trim()), '6', 'never makes the 7th page request once the cap is already met');
});
