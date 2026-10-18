import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  launchCloudCapturing,
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
    launchCloud: async () => ({ status: 0, signal: null, output: '' }),
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

test('launch outcomes: clean failure runs locally, a kill or throw is uncertain', async t => {
  const f = await fixture(t);
  const cleanFail = await attemptCloudDispatch(inputs(f, {
    launchCloud: async () => ({ status: 1, signal: null, output: 'error' }),
  }));
  assert.equal(cleanFail.exit, DISPATCH_EXIT.RUN_LOCAL);
  assert.equal(cleanFail.reason, 'launch-failed');

  const notSpawned = await attemptCloudDispatch(inputs(f, {
    launchCloud: async () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }), status: null }),
  }));
  assert.equal(notSpawned.exit, DISPATCH_EXIT.RUN_LOCAL);

  const killed = await attemptCloudDispatch(inputs(f, {
    launchCloud: async () => ({ status: null, signal: 'SIGTERM', output: '' }),
  }));
  assert.equal(killed.exit, DISPATCH_EXIT.AMBIGUOUS);
  assert.equal(killed.reason, 'launch-uncertain');

  const threw = await attemptCloudDispatch(inputs(f, {
    launchCloud: async () => { throw new Error('boom'); },
  }));
  assert.equal(threw.exit, DISPATCH_EXIT.AMBIGUOUS);

  // A nonzero exit that still printed a session link did create a session.
  const linked = await attemptCloudDispatch(inputs(f, {
    launchCloud: async () => ({ status: 1, signal: null, output: 'https://claude.ai/code/session_zz9' }),
  }));
  assert.equal(linked.exit, DISPATCH_EXIT.DISPATCHED);
  assert.equal(linked.url, 'https://claude.ai/code/session_zz9');
});

test('prompt names the branch and carries the task verbatim', () => {
  const prompt = buildDispatchPrompt({ branch: 'teamclaude-handoff/abc-1', task: 'README 정리' });
  assert.ok(prompt.includes('teamclaude-handoff/abc-1'));
  assert.ok(prompt.endsWith('README 정리'));
  assert.ok(prompt.includes('머지는 하지 마세요'));
});

test('session url extraction strips terminal escapes and tolerates junk', () => {
  assert.equal(extractSessionUrl('\x1b]8;;x\x07see \x1b[1mhttps://claude.ai/code/session_A-b_9\x1b[0m'), 'https://claude.ai/code/session_A-b_9');
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
