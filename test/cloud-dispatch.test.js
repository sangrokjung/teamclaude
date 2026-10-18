import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, makeRepo } from './helpers/git-fixture.js';
import { ALNUM } from './helpers/secret-fixtures.js';
import {
  DISPATCH_EXIT,
  DISPATCH_TASK_MAX_BYTES,
  attemptCloudDispatch,
  buildDispatchPrompt,
  extractSessionUrl,
  isFolderTrusted,
  launchCloudCapturing,
  readTaskInput,
} from '../src/cloud-dispatch.js';

const DISPATCH_ID = '9f8e7d6c-1111-4222-8333-444455556666';

async function vendorBinary(root, body = 'exit 0') {
  const path = join(root, 'claude-vendor');
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-dispatch-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, bare, env } = await makeRepo(root);
  const vendorBin = await vendorBinary(root);
  return { root, repo, bare, env, vendorBin };
}

function inputs(f, overrides = {}) {
  return {
    task: '이슈 #12 구현하고 테스트 추가',
    cwd: f.repo,
    gitEnv: f.env,
    vendorBin: f.vendorBin,
    baseEnv: { PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'http://localhost:3456', TEAMCLAUDE_X: '1' },
    loadAccounts: async () => [
      { name: 'cloud-acct', type: 'oauth', accessToken: 'tok-cloud', expiresAt: Date.now() + 3_600_000 },
    ],
    creditLookup: async () => ({ remainingDollars: 100, lockedReason: null }),
    ledgerPath: join(f.root, 'ledger.jsonl'),
    now: new Date(2026, 9, 18, 15, 0),
    random: () => 0,
    newId: () => DISPATCH_ID,
    folderTrusted: async () => true,
    launchCloud: async () => ({ status: 0, signal: null, output: 'https://claude.ai/code/session_default' }),
    ...overrides,
  };
}

test('dispatch pushes a snapshot branch, launches --cloud on the funded account, and records the ledger', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'tracked.txt'), 'uncommitted edit\n');
  let launch = null;
  const outcome = await attemptCloudDispatch(inputs(f, {
    launchCloud: async request => {
      launch = request;
      return { status: 0, signal: null, output: '\x1b[32mhttps://claude.ai/code/session_abc123\x1b[0m\n' };
    },
  }));

  assert.equal(outcome.ok, true);
  assert.equal(outcome.exit, DISPATCH_EXIT.DISPATCHED);
  assert.equal(outcome.account, 'cloud-acct');
  assert.equal(outcome.url, 'https://claude.ai/code/session_abc123');
  assert.match(outcome.branch, /^teamclaude-handoff\/9f8e7d6c-/);
  // The uncommitted edit travelled on the pushed branch; the local branch is untouched.
  assert.equal(git(f.bare, f.env, 'show', `${outcome.branch}:tracked.txt`), 'uncommitted edit');
  assert.equal(git(f.repo, f.env, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');

  assert.equal(launch.args[0], '--cloud');
  assert.ok(launch.args[1].includes(outcome.branch));
  assert.ok(launch.args[1].includes('이슈 #12 구현하고 테스트 추가'));
  assert.equal(launch.env.CLAUDE_CODE_OAUTH_TOKEN, 'tok-cloud');
  assert.equal(launch.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(launch.env.TEAMCLAUDE_X, undefined);

  const ledger = (await readFile(join(f.root, 'ledger.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].source, 'dispatch');
  assert.equal(ledger[0].account, 'cloud-acct');
  assert.equal(ledger[0].url, 'https://claude.ai/code/session_abc123');
  assert.equal(JSON.stringify(ledger).includes('tok-cloud'), false);
  assert.equal(outcome.ledgerRecorded, true);
});

test('no funded account means run locally, with nothing pushed or launched', async t => {
  const f = await fixture(t);
  let launched = false;
  const outcome = await attemptCloudDispatch(inputs(f, {
    creditLookup: async () => ({ remainingDollars: 0, lockedReason: null }),
    launchCloud: async () => { launched = true; return { status: 0 }; },
  }));
  assert.deepEqual(outcome, { ok: false, exit: DISPATCH_EXIT.RUN_LOCAL, reason: 'no-credit-account' });
  assert.equal(launched, false);
  assert.equal(git(f.bare, f.env, 'branch', '--list', 'teamclaude-handoff/*'), '');
});

test('a credit scan that could not finish also means run locally', async t => {
  const f = await fixture(t);
  const outcome = await attemptCloudDispatch(inputs(f, {
    creditLookup: () => new Promise(() => {}),
    creditLookupOptions: { lookupTimeoutMs: 20, budgetMs: 50 },
  }));
  assert.equal(outcome.exit, DISPATCH_EXIT.RUN_LOCAL);
  assert.equal(outcome.reason, 'credit-lookup-incomplete');
});

test('a task carrying a secret is never sent', async t => {
  const f = await fixture(t);
  let launched = false;
  const outcome = await attemptCloudDispatch(inputs(f, {
    task: `배포해줘 OPENAI_API_KEY=sk-proj-${ALNUM.slice(0, 40)}`,
    launchCloud: async () => { launched = true; return { status: 0 }; },
  }));
  assert.equal(outcome.reason, 'task-has-secret');
  assert.equal(outcome.exit, DISPATCH_EXIT.RUN_LOCAL);
  assert.equal(launched, false);
});

test('empty, oversized, non-GitHub and missing-vendor cases run locally', async t => {
  const f = await fixture(t);
  assert.equal((await attemptCloudDispatch(inputs(f, { task: '  ' }))).reason, 'task-empty');
  assert.equal((await attemptCloudDispatch(inputs(f, {
    task: 'x'.repeat(DISPATCH_TASK_MAX_BYTES + 1),
  }))).reason, 'task-too-large');
  assert.equal((await attemptCloudDispatch(inputs(f, {
    vendorBin: join(f.root, 'missing'),
  }))).reason, 'vendor-missing');
  git(f.repo, f.env, 'remote', 'set-url', 'origin', 'https://gitlab.com/x/y.git');
  assert.equal((await attemptCloudDispatch(inputs(f))).reason, 'origin-not-github');
  const notRepo = await mkdtemp(join(tmpdir(), 'teamclaude-dispatch-norepo-'));
  t.after(() => rm(notRepo, { recursive: true, force: true }));
  const outside = await attemptCloudDispatch(inputs(f, { cwd: notRepo }));
  assert.equal(outside.exit, DISPATCH_EXIT.RUN_LOCAL);
  assert.equal(outside.reason, 'not-git-repo');
});

test('dry run reports the account it would use without pushing or launching', async t => {
  const f = await fixture(t);
  let launched = false;
  const outcome = await attemptCloudDispatch(inputs(f, {
    dryRun: true,
    launchCloud: async () => { launched = true; return { status: 0 }; },
  }));
  assert.deepEqual(outcome, {
    ok: true, dryRun: true, exit: DISPATCH_EXIT.DISPATCHED, account: 'cloud-acct', remainingDollars: 100,
  });
  assert.equal(launched, false);
  assert.equal(git(f.bare, f.env, 'branch', '--list', 'teamclaude-handoff/*'), '');
});

test('launch outcomes: only a printed session link counts as sent', async t => {
  const f = await fixture(t);
  const outcomeOf = launchCloud => attemptCloudDispatch(inputs(f, { launchCloud }));

  // The launcher never started: nothing can exist.
  const notSpawned = await outcomeOf(async () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }), status: null }));
  assert.equal(notSpawned.exit, DISPATCH_EXIT.RUN_LOCAL);
  assert.equal(notSpawned.reason, 'launch-failed');

  // It ran but printed no link: a session may exist server-side.
  for (const result of [
    { status: 1, signal: null, output: 'error' },
    { status: 0, signal: null, output: 'Do you trust this folder?' },
    { status: null, signal: 'SIGTERM', output: '' },
  ]) {
    const outcome = await outcomeOf(async () => result);
    assert.equal(outcome.exit, DISPATCH_EXIT.AMBIGUOUS, JSON.stringify(result));
    assert.equal(outcome.reason, 'launch-uncertain');
    assert.match(outcome.branch, /^teamclaude-handoff\//);
  }
  const threw = await outcomeOf(async () => { throw new Error('boom'); });
  assert.equal(threw.exit, DISPATCH_EXIT.AMBIGUOUS);

  // A nonzero exit that still printed a session link did create a session.
  const linked = await outcomeOf(async () => ({ status: 1, signal: null, output: 'https://claude.ai/code/session_zz9' }));
  assert.equal(linked.exit, DISPATCH_EXIT.DISPATCHED);
  assert.equal(linked.url, 'https://claude.ai/code/session_zz9');
});

test('disabled accounts are never used, not even looked up', async t => {
  const f = await fixture(t);
  const looked = [];
  const outcome = await attemptCloudDispatch(inputs(f, {
    dryRun: true,
    loadAccounts: async () => [
      { name: 'off', enabled: false, type: 'oauth', accessToken: 'tok-off', expiresAt: Date.now() + 3_600_000 },
    ],
    creditLookup: async token => { looked.push(token); return { remainingDollars: 100, lockedReason: null }; },
  }));
  assert.equal(outcome.exit, DISPATCH_EXIT.RUN_LOCAL);
  assert.equal(outcome.reason, 'no-credit-account');
  assert.deepEqual(looked, []);
});

test('a ledger write failure keeps the dispatch result but says so', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'blocker'), 'not a directory\n');
  const outcome = await attemptCloudDispatch(inputs(f, {
    ledgerPath: join(f.root, 'blocker', 'ledger.jsonl'),
    launchCloud: async () => ({ status: 0, signal: null, output: 'https://claude.ai/code/session_l1' }),
  }));
  assert.equal(outcome.exit, DISPATCH_EXIT.DISPATCHED);
  assert.equal(outcome.ledgerRecorded, false);
});

test('prompt names the branch and carries the task verbatim', () => {
  const prompt = buildDispatchPrompt({ branch: 'teamclaude-handoff/abc-1', task: 'README 정리' });
  assert.ok(prompt.includes('teamclaude-handoff/abc-1'));
  assert.ok(prompt.endsWith('README 정리'));
  assert.ok(prompt.includes('머지는 하지 마세요'));
});

test('session url extraction strips terminal escapes and tolerates junk', () => {
  assert.equal(extractSessionUrl('\x1b]8;;x\x07see \x1b[1mhttps://claude.ai/code/session_Ab9\x1b[0m'), 'https://claude.ai/code/session_Ab9');
  // Not session links: settings pages, partial ids.
  assert.equal(extractSessionUrl('Error: launch failed. Visit https://claude.ai/code/settings'), null);
  assert.equal(extractSessionUrl('https://claude.ai/code/session_ab-cd'), null);
  for (const variant of ['session_old9.html', 'session_old9%2Fsettings', 'session_old9/settings', 'session_old9?x=1',
    'session_old9;settings', 'session_old9+backup', 'session_old9@archive', 'session_old9:archive', 'session_old9#x', 'session_old9_x']) {
    assert.equal(extractSessionUrl(`see https://claude.ai/code/${variant}`), null, variant);
  }
  assert.equal(extractSessionUrl('Open https://claude.ai/code/session_end1.'), 'https://claude.ai/code/session_end1');
  assert.equal(extractSessionUrl('(https://claude.ai/code/session_p1) 생성'), 'https://claude.ai/code/session_p1');
  assert.equal(extractSessionUrl('https://claude.ai/code/session_q1\r\n'), 'https://claude.ai/code/session_q1');
  // An escape-coloured old link in the task is still recognised as echoed.
  const colored = 'https://claude.ai/code/session_\x1b[1mold9\x1b[0m 이어서';
  assert.equal(extractSessionUrl(colored, { sent: colored }), null);
  // A link that was part of what we sent (echo, quoted old task) proves nothing.
  const sent = '이전 작업 https://claude.ai/code/session_old1 이어서';
  assert.equal(extractSessionUrl(`${sent}\nError: auth failed`, { sent }), null);
  assert.equal(extractSessionUrl(`${sent}\nhttps://claude.ai/code/session_new2`, { sent }), 'https://claude.ai/code/session_new2');
  assert.equal(extractSessionUrl('no link here'), null);
  assert.equal(extractSessionUrl(undefined), null);
});

// BSD `script` argument order (macOS, where the launcher runs); util-linux differs.
test('launchCloudCapturing runs the binary under a pty and returns its output', {
  skip: process.platform !== 'darwin',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-dispatch-pty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vendorBin = await vendorBinary(root, '[ -t 1 ] && echo "tty https://claude.ai/code/session_pty1"');
  const result = await launchCloudCapturing({ vendorBin, args: ['--cloud', 'x'], env: { PATH: '/usr/bin:/bin' }, cwd: root });
  assert.equal(result.status, 0);
  assert.equal(extractSessionUrl(result.output), 'https://claude.ai/code/session_pty1');
});

test('an untrusted folder runs locally before anything is pushed', async t => {
  const f = await fixture(t);
  let launched = false;
  const outcome = await attemptCloudDispatch(inputs(f, {
    folderTrusted: async () => false,
    launchCloud: async () => { launched = true; return { status: 0 }; },
  }));
  assert.equal(outcome.exit, DISPATCH_EXIT.RUN_LOCAL);
  assert.equal(outcome.reason, 'folder-not-trusted');
  assert.equal(launched, false);
  assert.equal(git(f.bare, f.env, 'branch', '--list', 'teamclaude-handoff/*'), '');
});

test('folder trust reads exactly this folder from Claude Code config', async () => {
  const config = projects => async () => JSON.stringify({ projects });
  const resolvePath = async path => path;
  const env = { CLAUDE_CONFIG_DIR: '/cfg' };
  assert.equal(await isFolderTrusted('/a/b/c', {
    env, resolvePath, readText: config({ '/a/b/c': { hasTrustDialogAccepted: true } }),
  }), true);
  // A trusted parent does not carry over into a repository below it.
  assert.equal(await isFolderTrusted('/a/b/c', {
    env, resolvePath, readText: config({ '/a': { hasTrustDialogAccepted: true } }),
  }), false);
  assert.equal(await isFolderTrusted('/a/b/c', {
    env, resolvePath, readText: config({ '/a/b/c': { hasTrustDialogAccepted: false }, '/x': { hasTrustDialogAccepted: true } }),
  }), false);
  assert.equal(await isFolderTrusted('/a', { env, resolvePath, readText: async () => 'not json' }), false);
  assert.equal(await isFolderTrusted('/a', { env, resolvePath, readText: async () => { throw new Error('missing'); } }), false);
  let read = null;
  await isFolderTrusted('/a', { env, resolvePath, readText: async path => { read = path; return '{}'; } });
  assert.equal(read, '/cfg/.claude.json');
});

test('a failed launch printing a look-alike link is not success', async t => {
  const f = await fixture(t);
  const outcome = await attemptCloudDispatch(inputs(f, {
    launchCloud: async () => ({ status: 1, signal: null, output: 'Error: failed. See https://claude.ai/code/session_old9;settings' }),
  }));
  assert.equal(outcome.exit, DISPATCH_EXIT.AMBIGUOUS);
});

test('an echoed old session link in a failed launch is not success', async t => {
  const f = await fixture(t);
  const outcome = await attemptCloudDispatch(inputs(f, {
    task: '지난번 https://claude.ai/code/session_old9 결과를 이어서 마무리',
    launchCloud: async request => ({ status: 1, signal: null, output: `${request.args[1]}\nError: auth failed` }),
  }));
  assert.equal(outcome.exit, DISPATCH_EXIT.AMBIGUOUS);
});

test('task input is read with a hard byte cap from files and streams', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-dispatch-input-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const small = join(root, 'small.txt');
  await writeFile(small, '이슈 #3 해결');
  assert.deepEqual(await readTaskInput(small), { task: '이슈 #3 해결' });
  const big = join(root, 'big.txt');
  await writeFile(big, 'x'.repeat(DISPATCH_TASK_MAX_BYTES + 10));
  assert.deepEqual(await readTaskInput(big), { reason: 'task-too-large' });
  assert.deepEqual(await readTaskInput(join(root, 'missing')), { reason: 'task-unreadable' });

  // An endless stream stops once past the cap instead of being buffered whole.
  let pulled = 0;
  const endless = new Readable({
    read() { pulled += 1; this.push(Buffer.alloc(1024, 120)); },
  });
  assert.deepEqual(await readTaskInput(endless), { reason: 'task-too-large' });
  assert.ok(pulled < 64, `pulled ${pulled} chunks`);
  assert.deepEqual(await readTaskInput(Readable.from([Buffer.from('a'), Buffer.from('b')])), { task: 'ab' });
});

test('a commit landing during the credit lookup does not drop its changes from the snapshot', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'tracked.txt'), 'work in progress\n');
  const outcome = await attemptCloudDispatch(inputs(f, {
    creditLookup: async () => {
      git(f.repo, f.env, 'commit', '--quiet', '-am', 'local commit meanwhile');
      return { remainingDollars: 100, lockedReason: null };
    },
    launchCloud: async () => ({ status: 0, signal: null, output: 'https://claude.ai/code/session_race1' }),
  }));
  assert.equal(outcome.exit, DISPATCH_EXIT.DISPATCHED);
  assert.equal(git(f.bare, f.env, 'show', `${outcome.branch}:tracked.txt`), 'work in progress');
});
