import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, makeRepo } from './helpers/git-fixture.js';
import { ALNUM } from './helpers/secret-fixtures.js';
import { defaultRunGit, handoffBranchName } from '../src/cloud-handoff.js';
import {
  DISPATCH_EXIT,
  DISPATCH_TASK_MAX_BYTES,
  attemptCloudDispatch,
  buildDispatchPrompt,
  extractSessionUrl,
  isFolderTrusted,
  launchCloudCapturing,
  parseDispatchArgs,
  readTaskInput,
} from '../src/cloud-dispatch.js';

const DISPATCH_ID = '9f8e7d6c-1111-4222-8333-444455556666';
// One clock for the fixture: token expiry is judged against `now`, not the wall clock.
const NOW = new Date(2026, 9, 18, 15, 0);
const TOKEN_EXPIRES = NOW.getTime() + 3_600_000;

// The launcher's real success output shape (Claude Code 2.1.302).
function created(id) {
  return `Created cloud session: 작업\r\nView: https://claude.ai/code/${id}?from=cli&m=0\r\n`
    + `Resume with: claude --teleport ${id}\r\n\x1b[?1006l\x1b[?1003l`;
}

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
      { name: 'cloud-acct', type: 'oauth', accessToken: 'tok-cloud', expiresAt: TOKEN_EXPIRES },
    ],
    creditLookup: async () => ({ remainingDollars: 100, lockedReason: null }),
    ledgerPath: join(f.root, 'ledger.jsonl'),
    now: NOW,
    random: () => 0,
    newId: () => DISPATCH_ID,
    folderTrusted: async () => true,
    platform: 'darwin',
    launchCloud: async () => ({ status: 0, signal: null, output: created('session_default') }),
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
      return { status: 0, signal: null, output: created('session_abc123') };
    },
  }));

  assert.equal(outcome.ok, true, JSON.stringify(outcome));
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
  const linked = await outcomeOf(async () => ({ status: 1, signal: null, output: created('session_zz9') }));
  assert.equal(linked.exit, DISPATCH_EXIT.DISPATCHED);
  assert.equal(linked.url, 'https://claude.ai/code/session_zz9');
});

test('disabled accounts are never used, not even looked up', async t => {
  const f = await fixture(t);
  const looked = [];
  const outcome = await attemptCloudDispatch(inputs(f, {
    dryRun: true,
    loadAccounts: async () => [
      { name: 'off', enabled: false, type: 'oauth', accessToken: 'tok-off', expiresAt: TOKEN_EXPIRES },
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
    launchCloud: async () => ({ status: 0, signal: null, output: created('session_l1') }),
  }));
  assert.equal(outcome.exit, DISPATCH_EXIT.DISPATCHED);
  assert.equal(outcome.ledgerRecorded, false);
});

test('prompt names the branch and carries the task verbatim', () => {
  const prompt = buildDispatchPrompt({ branch: 'teamclaude-handoff/abc-1', task: 'README 정리' });
  assert.ok(prompt.includes('teamclaude-handoff/abc-1'));
  assert.ok(prompt.endsWith('README 정리'));
  assert.ok(prompt.includes('머지는 하지 마세요'));
  assert.ok(prompt.includes('기본 브랜치 대상 PR'));
  const targeted = buildDispatchPrompt({ branch: 'b', task: 't', prTarget: 'feat/x' });
  assert.ok(targeted.includes('`feat/x` 브랜치 대상 PR'));
  assert.ok(!targeted.includes('기본 브랜치 대상'));
});

test('session link comes only from the launcher\'s whole Resume line', () => {
  assert.equal(extractSessionUrl(created('session_Ab9')), 'https://claude.ai/code/session_Ab9');
  assert.equal(extractSessionUrl('Resume with: \x1b[1mclaude --teleport session_Q1\x1b[0m\n'), 'https://claude.ai/code/session_Q1');
  // Links anywhere else are not proof: error hints, look-alikes, partial lines.
  for (const output of [
    'Error: launch failed. Visit https://claude.ai/code/settings',
    'See https://claude.ai/code/session_old9;settings',
    'View: https://claude.ai/code/session_old9?from=cli',
    'Resume with: claude --teleport session_old9;x',
    'Hint — Resume with: claude --teleport session_old9',
    'Resume with: claude --teleport session_ab-cd',
    'no link here',
  ]) {
    assert.equal(extractSessionUrl(output), null, output);
  }
  assert.equal(extractSessionUrl(undefined), null);
  // An id that was part of what we sent (an echoed task) proves nothing.
  const sent = '이전 작업 Resume with: claude --teleport session_old1 이어서';
  assert.equal(extractSessionUrl(`${sent}\nResume with: claude --teleport session_old1\n`, { sent }), null);
  assert.equal(extractSessionUrl(`${sent}\n${created('session_new2')}`, { sent }), 'https://claude.ai/code/session_new2');
  const colored = 'session_\x1b[1mold9\x1b[0m 이어서';
  assert.equal(extractSessionUrl('Resume with: claude --teleport session_old9', { sent: colored }), null);
});

test('launchCloudCapturing runs the binary under a pty and returns its output', {
  skip: process.platform !== 'darwin',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-dispatch-pty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vendorBin = await vendorBinary(root, '[ -t 1 ] && printf "View: https://claude.ai/code/session_pty1?from=cli\\nResume with: claude --teleport session_pty1\\n"');
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
    launchCloud: async () => ({ status: 1, signal: null, output: 'Error: failed. See https://claude.ai/code/session_old9;settings\nView: https://claude.ai/code/session_old9' }),
  }));
  assert.equal(outcome.exit, DISPATCH_EXIT.AMBIGUOUS);
});

test('an echoed old session link in a failed launch is not success', async t => {
  const f = await fixture(t);
  const outcome = await attemptCloudDispatch(inputs(f, {
    task: '지난번 결과를 이어서 마무리\nResume with: claude --teleport session_old9',
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
  // Invalid UTF-8 is refused from both sources, not passed on garbled.
  const latin1 = join(root, 'latin1.txt');
  await writeFile(latin1, Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  assert.deepEqual(await readTaskInput(latin1), { reason: 'task-invalid-encoding' });
  assert.deepEqual(await readTaskInput(Readable.from([Buffer.from([0xff, 0xfe])])), { reason: 'task-invalid-encoding' });
  // A multi-byte character split across stream chunks is still valid.
  const han = Buffer.from('한', 'utf8');
  assert.deepEqual(await readTaskInput(Readable.from([han.subarray(0, 1), han.subarray(1)])), { task: '한' });
});

test('a commit landing during the credit lookup does not drop its changes from the snapshot', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'tracked.txt'), 'work in progress\n');
  const outcome = await attemptCloudDispatch(inputs(f, {
    creditLookup: async () => {
      git(f.repo, f.env, 'commit', '--quiet', '-am', 'local commit meanwhile');
      return { remainingDollars: 100, lockedReason: null };
    },
    launchCloud: async () => ({ status: 0, signal: null, output: created('session_race1') }),
  }));
  assert.equal(outcome.exit, DISPATCH_EXIT.DISPATCHED);
  assert.equal(git(f.bare, f.env, 'show', `${outcome.branch}:tracked.txt`), 'work in progress');
});

test('dispatch is refused off macOS before anything is pushed', async t => {
  const f = await fixture(t);
  let launched = false;
  const outcome = await attemptCloudDispatch(inputs(f, {
    platform: 'linux',
    launchCloud: async () => { launched = true; return { status: 0 }; },
  }));
  assert.deepEqual(outcome, { ok: false, exit: DISPATCH_EXIT.RUN_LOCAL, reason: 'platform-unsupported' });
  assert.equal(launched, false);
  assert.equal(git(f.bare, f.env, 'branch', '--list', 'teamclaude-handoff/*'), '');
});

test('argument parsing takes the task from one source and refuses guesses', () => {
  assert.deepEqual(parseDispatchArgs(['--cwd', 'repo', '--dry-run', '--', '이슈', '--x']),
    { cwd: 'repo', dryRun: true, taskFile: null, base: null, words: ['이슈', '--x'] });
  assert.deepEqual(parseDispatchArgs(['--task-file', '-', '--base', 'origin/main']),
    { cwd: null, dryRun: false, taskFile: '-', base: 'origin/main', words: [] });
  assert.deepEqual(parseDispatchArgs(['README', '정리']),
    { cwd: null, dryRun: false, taskFile: null, base: null, words: ['README', '정리'] });
  for (const argv of [
    ['--task-file', 'task.txt', '--', '수정하지 말고 분석만'],
    ['--task-file', 'task.txt', '추가'],
    ['--task-file'],
    ['--cwd'],
    ['--cwd', '--dry-run', 'x'],
    ['--task-file', ''],
    ['--unknown', 'x'],
    ['--task-file', 'a.txt', '--task-file', 'b.txt'],
    ['--task-file', '-', '--task-file', 'b.txt'],
    ['--cwd', 'a', '--cwd', 'b', 'x'],
    ['--base'],
    ['--base', 'a', '--base', 'b', 'x'],
  ]) {
    assert.deepEqual(parseDispatchArgs(argv), { reason: 'bad-arguments' }, argv.join(' '));
  }
});

test('a task with a NUL byte is refused before anything is pushed', async t => {
  const f = await fixture(t);
  let launched = false;
  const outcome = await attemptCloudDispatch(inputs(f, {
    task: 'a\0b',
    launchCloud: async () => { launched = true; return { status: 0 }; },
  }));
  assert.equal(outcome.reason, 'task-invalid-content');
  assert.equal(outcome.exit, DISPATCH_EXIT.RUN_LOCAL);
  assert.equal(launched, false);
  assert.equal(git(f.bare, f.env, 'branch', '--list', 'teamclaude-handoff/*'), '');
});

test('--base sends exactly that commit and leaves uncommitted work behind', async t => {
  const f = await fixture(t);
  const mainCommit = git(f.repo, f.env, 'rev-parse', 'HEAD');
  git(f.repo, f.env, 'checkout', '--quiet', '-b', 'feature');
  await writeFile(join(f.repo, 'tracked.txt'), 'feature commit\n');
  git(f.repo, f.env, 'commit', '--quiet', '-am', 'unrelated feature commit');
  await writeFile(join(f.repo, 'tracked.txt'), 'unrelated uncommitted edit\n');
  await writeFile(join(f.repo, 'stray.txt'), 'untracked\n');

  const outcome = await attemptCloudDispatch(inputs(f, { base: 'main' }));
  assert.equal(outcome.exit, DISPATCH_EXIT.DISPATCHED);
  assert.equal(git(f.bare, f.env, 'rev-parse', outcome.branch), mainCommit);
  assert.equal(git(f.bare, f.env, 'show', `${outcome.branch}:tracked.txt`), 'original');
  // The caller's checkout is untouched.
  assert.equal(git(f.repo, f.env, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature');
  assert.equal(await readFile(join(f.repo, 'tracked.txt'), 'utf8'), 'unrelated uncommitted edit\n');
});

test('an unknown or option-like --base runs locally without pushing', async t => {
  const f = await fixture(t);
  for (const base of ['no-such-ref', '--upload-pack=x', '']) {
    const outcome = await attemptCloudDispatch(inputs(f, { base }));
    assert.equal(outcome.exit, DISPATCH_EXIT.RUN_LOCAL, base);
    assert.equal(outcome.reason, 'base-not-found', base);
  }
  assert.equal(git(f.bare, f.env, 'branch', '--list', 'teamclaude-handoff/*'), '');
});

test('origin whose push side differs from its fetch side is refused before any push', async t => {
  for (const configure of [
    (f, other) => git(f.repo, f.env, 'remote', 'set-url', '--push', 'origin', other),
    (f, other) => git(f.repo, f.env, 'config', `url.${other}.pushInsteadOf`, 'https://github.com/'),
    (f, other) => git(f.repo, f.env, 'remote', 'set-url', '--add', '--push', 'origin', other),
    (f, other) => git(f.repo, f.env, 'remote', 'set-url', '--add', 'origin', other),
  ]) {
    const f = await fixture(t);
    const other = join(f.root, 'other.git');
    git(f.root, f.env, 'init', '--quiet', '--bare', other);
    configure(f, other);
    let launched = false;
    const outcome = await attemptCloudDispatch(inputs(f, {
      base: 'main',
      launchCloud: async () => { launched = true; return { status: 0 }; },
    }));
    assert.equal(outcome.exit, DISPATCH_EXIT.RUN_LOCAL, configure.toString());
    // A second fetch URL makes `remote.origin.url` itself non-GitHub (last wins).
    assert.ok(['origin-push-differs', 'origin-not-github'].includes(outcome.reason), configure.toString());
    assert.equal(launched, false);
    assert.equal(git(other, f.env, 'for-each-ref'), '');
    assert.equal(git(f.bare, f.env, 'branch', '--list', 'teamclaude-handoff/*'), '');
  }
});

test('a remote config change after inspection cannot redirect the push', async t => {
  for (const base of ['main', null]) {
    const f = await fixture(t);
    const other = join(f.root, 'other.git');
    git(f.root, f.env, 'init', '--quiet', '--bare', other);
    const outcome = await attemptCloudDispatch(inputs(f, {
      base,
      creditLookup: async () => {
        // Mid-run edit: point origin's push side elsewhere.
        git(f.repo, f.env, 'remote', 'set-url', '--push', 'origin', other);
        return { remainingDollars: 100, lockedReason: null };
      },
    }));
    assert.equal(outcome.exit, DISPATCH_EXIT.DISPATCHED);
    assert.equal(git(other, f.env, 'for-each-ref'), '', 'nothing reached the other repository');
    assert.notEqual(git(f.bare, f.env, 'branch', '--list', outcome.branch), '');
  }
});

test('a rewrite rule that would re-apply to the resolved URL at push time is refused', async t => {
  for (const base of ['main', null]) {
    const f = await fixture(t);
    const other = join(f.root, 'other.git');
    git(f.root, f.env, 'init', '--quiet', '--bare', other);
    // Applies only to the already-resolved URL (the bare path), at push time.
    git(f.repo, f.env, 'config', `url.${other}.pushInsteadOf`, f.bare);
    let launched = false;
    const outcome = await attemptCloudDispatch(inputs(f, {
      base,
      launchCloud: async () => { launched = true; return { status: 0 }; },
    }));
    assert.equal(outcome.exit, DISPATCH_EXIT.RUN_LOCAL);
    assert.equal(outcome.reason, 'origin-push-differs');
    assert.equal(launched, false);
    assert.equal(git(other, f.env, 'for-each-ref'), '');
  }
  // Same for a fetch-side rewrite of the resolved URL (scan would look elsewhere).
  const f = await fixture(t);
  const other = join(f.root, 'other2.git');
  git(f.root, f.env, 'init', '--quiet', '--bare', other);
  git(f.repo, f.env, 'config', `url.${other}.insteadOf`, f.bare);
  const outcome = await attemptCloudDispatch(inputs(f, { base: 'main' }));
  assert.equal(outcome.exit, DISPATCH_EXIT.RUN_LOCAL);
});

test('an empty-prefix rewrite rule matches every URL and is refused', async t => {
  for (const base of ['main', null]) {
    const f = await fixture(t);
    const other = join(f.root, 'other.git');
    git(f.root, f.env, 'init', '--quiet', '--bare', other);
    git(f.repo, f.env, 'config', `url.${other}/.pushInsteadOf`, '');
    let launched = false;
    const outcome = await attemptCloudDispatch(inputs(f, {
      base,
      launchCloud: async () => { launched = true; return { status: 0 }; },
    }));
    assert.equal(outcome.reason, 'origin-push-differs');
    assert.equal(launched, false);
  }
});

test('a rewrite rule added after inspection is caught right before the push', async t => {
  for (const base of ['main', null]) {
    const f = await fixture(t);
    const other = join(f.root, 'other.git');
    git(f.root, f.env, 'init', '--quiet', '--bare', other);
    let launched = false;
    const outcome = await attemptCloudDispatch(inputs(f, {
      base,
      creditLookup: async () => {
        git(f.repo, f.env, 'config', `url.${other}.pushInsteadOf`, f.bare);
        return { remainingDollars: 100, lockedReason: null };
      },
      launchCloud: async () => { launched = true; return { status: 0 }; },
    }));
    assert.equal(outcome.exit, DISPATCH_EXIT.RUN_LOCAL);
    assert.equal(outcome.reason, 'origin-push-differs');
    assert.equal(launched, false);
    assert.equal(git(other, f.env, 'for-each-ref'), '');
  }
});

test('a secret only in an unpushed commit message is never sent', async t => {
  for (const base of ['main', null]) {
    const f = await fixture(t);
    await writeFile(join(f.repo, 'tracked.txt'), 'harmless change\n');
    git(f.repo, f.env, 'commit', '--quiet', '-am', `deploy fix\n\nOPENAI_API_KEY=sk-proj-${ALNUM.slice(0, 40)}`);
    let launched = false;
    const outcome = await attemptCloudDispatch(inputs(f, {
      base,
      launchCloud: async () => { launched = true; return { status: 0 }; },
    }));
    assert.equal(outcome.exit, DISPATCH_EXIT.RUN_LOCAL, String(base));
    assert.equal(outcome.reason, 'snapshot-secret', String(base));
    assert.equal(launched, false);
    assert.equal(git(f.bare, f.env, 'branch', '--list', 'teamclaude-handoff/*'), '');
  }
});

test('push.followTags does not publish tags along with the dispatch branch', async t => {
  for (const base of ['main', null]) {
    const f = await fixture(t);
    git(f.repo, f.env, 'config', 'push.followTags', 'true');
    git(f.repo, f.env, 'tag', '-a', 'v9.9.9', '-m', 'release tag');
    const outcome = await attemptCloudDispatch(inputs(f, { base }));
    assert.equal(outcome.exit, DISPATCH_EXIT.DISPATCHED);
    assert.equal(git(f.bare, f.env, 'tag', '--list'), '', String(base));
  }
});

test('a secret in a file name or hidden behind git replace is never sent', async t => {
  const secretName = `ghp_${ALNUM.slice(0, 36)}`;
  for (const base of ['main', null]) {
    // A file name.
    const f = await fixture(t);
    await writeFile(join(f.repo, `${secretName}.txt`), 'harmless\n');
    git(f.repo, f.env, 'add', '--', `${secretName}.txt`);
    git(f.repo, f.env, 'commit', '--quiet', '-m', 'add file');
    git(f.repo, f.env, 'rm', '--quiet', '--', `${secretName}.txt`);
    git(f.repo, f.env, 'commit', '--quiet', '-m', 'remove it again');
    const named = await attemptCloudDispatch(inputs(f, { base }));
    assert.equal(named.reason, 'snapshot-secret', `name ${base}`);

    // A commit whose message carries a secret, replaced by a clean twin.
    const g = await fixture(t);
    await writeFile(join(g.repo, 'tracked.txt'), 'change\n');
    git(g.repo, g.env, 'commit', '--quiet', '-am', `fix\n\nOPENAI_API_KEY=sk-proj-${ALNUM.slice(0, 40)}`);
    const dirty = git(g.repo, g.env, 'rev-parse', 'HEAD');
    git(g.repo, g.env, 'commit', '--quiet', '--amend', '-m', 'fix');
    const clean = git(g.repo, g.env, 'rev-parse', 'HEAD');
    git(g.repo, g.env, 'reset', '--quiet', '--hard', dirty);
    git(g.repo, g.env, 'replace', dirty, clean);
    const replaced = await attemptCloudDispatch(inputs(g, { base }));
    assert.equal(replaced.reason, 'snapshot-secret', `replace ${base}`);
    assert.equal(git(g.bare, g.env, 'branch', '--list', 'teamclaude-handoff/*'), '');
  }
});

test('every push sends one branch only: no tags, no submodule pushes, stored objects', async t => {
  for (const base of ['main', null]) {
    const f = await fixture(t);
    const calls = [];
    const outcome = await attemptCloudDispatch(inputs(f, {
      base,
      runGit: (args, options) => {
        calls.push({ args, env: options?.env });
        return defaultRunGit(args, options);
      },
    }));
    assert.equal(outcome.exit, DISPATCH_EXIT.DISPATCHED);
    const pushes = calls.filter(call => call.args[0] === 'push');
    assert.equal(pushes.length, 1);
    assert.ok(pushes[0].args.includes('--no-follow-tags'));
    assert.ok(pushes[0].args.includes('--recurse-submodules=no'));
    assert.ok(calls.every(call => call.env?.GIT_NO_REPLACE_OBJECTS === '1'), 'all git calls ignore replacements');
  }
});

const hasSshKeygen = spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error === undefined;

test('an unpushed signed commit fails closed (run locally), a pushed base does not care', { skip: !hasSshKeygen }, async t => {
  const f = await fixture(t);
  const key = join(f.root, 'signing-key');
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test', '-f', key]).status, 0);
  git(f.repo, f.env, 'config', 'gpg.format', 'ssh');
  git(f.repo, f.env, 'config', 'user.signingkey', key);
  await writeFile(join(f.repo, 'tracked.txt'), 'signed change\n');
  git(f.repo, f.env, 'commit', '--quiet', '-S', '-am', 'signed commit');
  assert.match(git(f.repo, f.env, 'cat-file', 'commit', 'HEAD'), /^gpgsig -----BEGIN SSH SIGNATURE-----$/m);
  // Unpushed signed history: refused before any push, the task runs locally.
  for (const base of ['HEAD', null]) {
    const outcome = await attemptCloudDispatch(inputs(f, { base }));
    assert.equal(outcome.exit, DISPATCH_EXIT.RUN_LOCAL, String(base));
    assert.equal(outcome.reason, 'snapshot-secret', String(base));
  }
  assert.equal(git(f.bare, f.env, 'branch', '--list', 'teamclaude-handoff/*'), '');
  // Once pushed, a base at that commit scans nothing new and dispatches.
  // (-u: the fixture's bare HEAD does not name main, the upstream does.)
  git(f.repo, f.env, 'push', '--quiet', '-u', 'origin', 'main');
  const pushed = await attemptCloudDispatch(inputs(f, { base: 'main' }));
  assert.equal(pushed.exit, DISPATCH_EXIT.DISPATCHED);
});

test('credential freshness is judged by eligibilityNow, not the branch-naming clock, when they diverge', async t => {
  const f = await fixture(t);
  // Margin looks fine measured from the frozen `now` (6 min, over the 5 min
  // floor) but a slow collection phase means the real clock has moved on 10
  // minutes by dispatch time: by then this token has 4 min left, under the
  // floor.
  const expiresSoonFromRealNow = NOW.getTime() + 6 * 60_000;
  const tenMinutesLater = new Date(NOW.getTime() + 10 * 60_000);
  const outcome = await attemptCloudDispatch(inputs(f, {
    loadAccounts: async () => [{ name: 'cloud-acct', type: 'oauth', accessToken: 'tok-cloud', expiresAt: expiresSoonFromRealNow }],
    eligibilityNow: tenMinutesLater,
  }));
  assert.equal(outcome.exit, DISPATCH_EXIT.RUN_LOCAL);
  assert.equal(outcome.reason, 'no-credit-account');
});

test('branch naming still uses the frozen now even when eligibilityNow is later', async t => {
  const f = await fixture(t);
  const muchLater = new Date(NOW.getTime() + 10 * 60_000);
  const outcome = await attemptCloudDispatch(inputs(f, { eligibilityNow: muchLater }));
  assert.equal(outcome.exit, DISPATCH_EXIT.DISPATCHED);
  assert.equal(outcome.branch, handoffBranchName(DISPATCH_ID, NOW));
});

test('a token that lapses during the snapshot push is caught right before launch, not after', async t => {
  const f = await fixture(t);
  // Fine margin at selection time (6 min, over the 5 min floor from `now`),
  // but the push to the handoff branch (git network I/O) is slow enough that
  // by the time we are about to invoke the launcher, only 4 min are left.
  const expiresAt = NOW.getTime() + 6 * 60_000;
  let launched = false;
  const outcome = await attemptCloudDispatch(inputs(f, {
    loadAccounts: async () => [{ name: 'cloud-acct', type: 'oauth', accessToken: 'tok-cloud', expiresAt }],
    launchCloud: async () => { launched = true; return { status: 0, signal: null, output: created('session_default') }; },
    liveNow: () => NOW.getTime() + 10 * 60_000,
  }));
  assert.equal(outcome.exit, DISPATCH_EXIT.RUN_LOCAL);
  assert.equal(outcome.reason, 'token-expired-before-launch');
  assert.equal(launched, false, 'the launcher must never run once the chosen account is no longer eligible');
});

test('a token that is still fresh by liveNow launches normally', async t => {
  const f = await fixture(t);
  const expiresAt = NOW.getTime() + 6 * 60_000;
  const outcome = await attemptCloudDispatch(inputs(f, {
    loadAccounts: async () => [{ name: 'cloud-acct', type: 'oauth', accessToken: 'tok-cloud', expiresAt }],
    liveNow: () => NOW.getTime() + 60_000,
  }));
  assert.equal(outcome.exit, DISPATCH_EXIT.DISPATCHED);
});

// The pre-launch recheck no longer re-finds the account in `accounts` at all
// (every re-find kept being a fresh source of identity-collision bugs across
// rounds: uuid on only one side, array order, ...) — it reads the exact
// credential's expiresAt that findCloudAccount already resolved and carried
// forward as data. These two cases are exactly the ones that broke the old
// re-find approach, proven here by a decoy sharing the selected account's
// name that would mislead ANY re-find, whether by uuid-aware identity or not.
for (const uuidKind of ['uuid-bearing', 'legacy-no-uuid']) {
  test(`the pre-launch recheck reads the exact selected credential's own expiry, not a same-name decoy's (${uuidKind})`, async t => {
    const f = await fixture(t);
    // A decoy sharing the chosen account's name, generously long-lived, with
    // $0 credit so findCloudAccount can never select IT.
    const decoy = { name: 'dup', type: 'oauth', accessToken: 'tok-decoy', expiresAt: NOW.getTime() + 3_600_000 };
    // The account actually selected: funded, but only 6 min of margin at
    // selection time — expired by the time liveNow (10 min later) is checked.
    const selected = {
      name: 'dup',
      ...(uuidKind === 'uuid-bearing' ? { accountUuid: 'uuid-x' } : {}),
      type: 'oauth',
      accessToken: 'tok-dup',
      expiresAt: NOW.getTime() + 6 * 60_000,
    };
    let launched = false;
    const outcome = await attemptCloudDispatch(inputs(f, {
      loadAccounts: async () => [decoy, selected],
      creditLookup: async token => ({ remainingDollars: token === 'tok-dup' ? 100 : 0, lockedReason: null }),
      launchCloud: async () => { launched = true; return { status: 0, signal: null, output: created('session_default') }; },
      liveNow: () => NOW.getTime() + 10 * 60_000,
    }));
    assert.equal(outcome.exit, DISPATCH_EXIT.RUN_LOCAL);
    assert.equal(outcome.reason, 'token-expired-before-launch');
    assert.equal(launched, false, 'must check the actually-selected account, not its same-name decoy');
  });
}

test('a programDeadline that lapses during the snapshot push is caught right before launch', async t => {
  const f = await fixture(t);
  let launched = false;
  const outcome = await attemptCloudDispatch(inputs(f, {
    programDeadline: NOW.getTime() + 5 * 60_000,
    launchCloud: async () => { launched = true; return { status: 0, signal: null, output: created('session_default') }; },
    liveNow: () => NOW.getTime() + 10 * 60_000,
  }));
  assert.equal(outcome.exit, DISPATCH_EXIT.RUN_LOCAL);
  assert.equal(outcome.reason, 'program-expired-before-launch');
  assert.equal(launched, false);
});

test('a programDeadline that has not lapsed yet does not block launch', async t => {
  const f = await fixture(t);
  const outcome = await attemptCloudDispatch(inputs(f, {
    programDeadline: NOW.getTime() + 5 * 60_000,
    liveNow: () => NOW.getTime() + 60_000,
  }));
  assert.equal(outcome.exit, DISPATCH_EXIT.DISPATCHED);
});
