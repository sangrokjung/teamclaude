import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, isolatedGitEnv, makeRepo } from './helpers/git-fixture.js';
import { ALNUM } from './helpers/secret-fixtures.js';
import {
  CLOUD_PROMPT_MAX_BYTES,
  appendCloudLedger,
  attemptCloudHandoff,
  buildCloudEnv,
  buildCloudPrompt,
  fetchCloudCredits,
  CLOUD_ACCOUNT_LOOKUP_INCOMPLETE,
  CloudHandoffNotStopped,
  findCloudAccount,
  handoffBranchName,
  inspectHandoffRepo,
  isExcludedHandoffPath,
  isGitHubRemoteUrl,
  pushHandoffSnapshot,
} from '../src/cloud-handoff.js';

const SESSION_ID = '0a1b2c3d-1111-4222-8333-444455556666';
async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

test('excluded handoff paths cover secret-looking names in any segment', () => {
  for (const path of [
    '.env',
    '.env.local',
    'config/.env.production',
    'certs/server.pem',
    'tls/server.key',
    'id_rsa',
    'keys/id_ed25519.pub',
    '.netrc',
    'aws_credentials.json',
    'config/Credentials.yml',
    'my-secret.txt',
    'SECRETS.md',
    'secrets/plain.txt',
  ]) {
    assert.equal(isExcludedHandoffPath(path), true, path);
  }
  for (const path of [
    'src/index.js',
    'keyboard.js',
    'monkey.txt',
    'README.md',
    'identity.js',
    'env.js',
    'docs/environment.md',
  ]) {
    assert.equal(isExcludedHandoffPath(path), false, path);
  }
});

test('only github.com origins qualify for a cloud handoff', () => {
  for (const url of [
    'https://github.com/example-org/example-repo.git',
    'https://github.com/example-org/example-repo',
    'git@github.com:example-org/example-repo.git',
    'ssh://git@github.com/example-org/example-repo.git',
  ]) {
    assert.equal(isGitHubRemoteUrl(url), true, url);
  }
  for (const url of [
    '',
    null,
    'https://gitlab.com/example-org/example-repo.git',
    '/srv/git/example-repo.git',
    'https://github.com.evil.example/example-org/repo.git',
    'https://evil.example/github.com/example-org/repo.git',
    'git@evil.example:github.com/repo.git',
  ]) {
    assert.equal(isGitHubRemoteUrl(url), false, String(url));
  }
});

test('handoff branch name uses the session prefix and a minute timestamp', () => {
  assert.equal(
    handoffBranchName(SESSION_ID, new Date(2026, 9, 14, 9, 5, 42)),
    'teamclaude-handoff/0a1b2c3d-202610140905',
  );
});

test('findCloudAccount picks among the top three credit balances of valid OAuth accounts', async () => {
  const now = Date.UTC(2026, 9, 14);
  const lookups = [];
  const credits = {
    'tok-a': { remainingDollars: 10, lockedReason: null },
    'tok-b': { remainingDollars: 200, lockedReason: null },
    'tok-c': { remainingDollars: 150, lockedReason: null },
    'tok-d': { remainingDollars: 120, lockedReason: null },
    'tok-locked': { remainingDollars: 900, lockedReason: 'org_disabled' },
    'tok-poor': { remainingDollars: 0.5, lockedReason: null },
    'tok-none': null,
  };
  const accounts = [
    { name: 'a', type: 'oauth', accessToken: 'tok-a', expiresAt: now + 3_600_000 },
    { name: 'b', type: 'oauth', accessToken: 'tok-b', expiresAt: now + 3_600_000 },
    // expiresAt in seconds must be normalized.
    { name: 'c', type: 'oauth', accessToken: 'tok-c', expiresAt: Math.floor((now + 3_600_000) / 1000) },
    { name: 'd', type: 'oauth', accessToken: 'tok-d', expiresAt: now + 3_600_000 },
    { name: 'locked', type: 'oauth', accessToken: 'tok-locked', expiresAt: now + 3_600_000 },
    { name: 'poor', type: 'oauth', accessToken: 'tok-poor', expiresAt: now + 3_600_000 },
    { name: 'none', type: 'oauth', accessToken: 'tok-none', expiresAt: now + 3_600_000 },
    { name: 'throws', type: 'oauth', accessToken: 'tok-throw', expiresAt: now + 3_600_000 },
    { name: 'expiring', type: 'oauth', accessToken: 'tok-expiring', expiresAt: now + 120_000 },
    { name: 'api', type: 'apikey', apiKey: 'tok-api' },
    { name: 'imported', type: 'oauth', importFrom: '/nonexistent' },
  ];
  const creditLookup = async token => {
    lookups.push(token);
    if (token === 'tok-throw') throw new Error('network');
    return credits[token];
  };

  const best = await findCloudAccount({ accounts, creditLookup, now, random: () => 0 });
  assert.deepEqual(best, { name: 'b', accessToken: 'tok-b', remainingDollars: 200 });
  assert.equal(lookups.includes('tok-expiring'), false);
  assert.equal(lookups.includes('tok-api'), false);

  const third = await findCloudAccount({ accounts, creditLookup, now, random: () => 0.99 });
  assert.equal(third.name, 'd');
  const second = await findCloudAccount({ accounts, creditLookup, now, random: () => 0.5 });
  assert.equal(second.name, 'c');

  assert.equal(
    await findCloudAccount({ accounts: accounts.slice(4), creditLookup, now, random: () => 0 }),
    null,
  );
  assert.equal(await findCloudAccount({ accounts: null, creditLookup, now }), null);
});

function fleet(count, now) {
  return Array.from({ length: count }, (_, i) => ({
    name: `acct-${i}`,
    type: 'oauth',
    accessToken: `tok-${i}`,
    expiresAt: now + 3_600_000,
  }));
}

test('findCloudAccount bounds concurrency at 4 in flight but still visits every eligible account', async () => {
  const now = Date.UTC(2026, 9, 14);
  const looked = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const creditLookup = async (token, options) => {
    looked.push(token);
    assert.ok(options?.signal instanceof AbortSignal, 'each lookup gets an abort signal');
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 1));
    inFlight -= 1;
    return { remainingDollars: Number(token.slice(4)) + 1, lockedReason: null };
  };
  const best = await findCloudAccount({ accounts: fleet(40, now), creditLookup, now, random: () => 0 });
  assert.equal(looked.length, 40);
  assert.equal(maxInFlight, 4);
  assert.equal(best.name, 'acct-39');
});

test('findCloudAccount still finds a funded account past position 32 when earlier ones have no credit', async () => {
  const now = Date.UTC(2026, 9, 14);
  const creditLookup = async token => (token === 'tok-32'
    ? { remainingDollars: 10, lockedReason: null }
    : { remainingDollars: 0, lockedReason: null });
  const best = await findCloudAccount({ accounts: fleet(40, now), creditLookup, now, random: () => 0 });
  assert.equal(best?.name, 'acct-32');
});

test('findCloudAccount reports an incomplete scan, not a plain miss, when the budget runs out early', async () => {
  const now = Date.UTC(2026, 9, 14);
  // Only the last of 20 accounts has credit, but the shared time budget
  // expires long before a lookup that slow could ever reach it.
  const creditLookup = async (token, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(token === 'tok-19'
      ? { remainingDollars: 10, lockedReason: null }
      : { remainingDollars: 0, lockedReason: null }), 100);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
  });
  const result = await findCloudAccount({
    accounts: fleet(20, now),
    creditLookup,
    now,
    random: () => 0,
    concurrency: 2,
    lookupTimeoutMs: 1000,
    budgetMs: 30,
  });
  assert.equal(result, CLOUD_ACCOUNT_LOOKUP_INCOMPLETE);
});

test('findCloudAccount returns plain null, not incomplete, when every account was actually checked', async () => {
  const now = Date.UTC(2026, 9, 14);
  const creditLookup = async () => ({ remainingDollars: 0, lockedReason: null });
  const result = await findCloudAccount({ accounts: fleet(5, now), creditLookup, now, random: () => 0 });
  assert.equal(result, null);
});

test('findCloudAccount treats a lookup past its timeout as ineligible and aborts it', async () => {
  const now = Date.UTC(2026, 9, 14);
  const aborted = [];
  const creditLookup = (token, { signal }) => {
    if (token === 'tok-0') {
      signal.addEventListener('abort', () => aborted.push(token));
      // Never settles, even on abort: the timeout must not depend on it.
      return new Promise(() => {});
    }
    return Promise.resolve({ remainingDollars: 10, lockedReason: null });
  };
  const started = Date.now();
  const best = await findCloudAccount({
    accounts: fleet(2, now),
    creditLookup,
    now,
    random: () => 0,
    lookupTimeoutMs: 50,
  });
  assert.equal(best.name, 'acct-1');
  assert.deepEqual(aborted, ['tok-0']);
  assert.ok(Date.now() - started < 2000);
});

test('findCloudAccount stops at the overall budget instead of waiting for slow lookups', async () => {
  const now = Date.UTC(2026, 9, 14);
  let started = 0;
  const creditLookup = async (token, { signal }) => {
    started += 1;
    // The first batch answers fast; everything after it is slower than the budget.
    const fast = Number(token.slice(4)) < 4;
    await new Promise(resolve => {
      const timer = setTimeout(resolve, fast ? 5 : 5_000);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    if (signal.aborted) throw new Error('aborted');
    return { remainingDollars: fast ? 10 : 999, lockedReason: null };
  };
  const t0 = Date.now();
  const best = await findCloudAccount({
    accounts: fleet(12, now),
    creditLookup,
    now,
    random: () => 0,
    budgetMs: 200,
  });
  assert.ok(Date.now() - t0 < 2000, 'returns at the budget, not after the slow lookups');
  assert.equal(best.remainingDollars, 10);
  assert.ok(started < 12, 'no new lookups start after the budget');

  // Nobody answers before the budget fires: every status is genuinely
  // unknown, which is "incomplete", not a confirmed "nobody has credit".
  assert.equal(await findCloudAccount({
    accounts: fleet(3, now),
    creditLookup: () => new Promise(() => {}),
    now,
    budgetMs: 50,
  }), CLOUD_ACCOUNT_LOOKUP_INCOMPLETE);
});

test('fetchCloudCredits can read a missing credit grant as $0 (absentAsZero), never an HTTP failure', async () => {
  const ok = body => ({ fetchImpl: async () => ({ ok: true, json: async () => body }), absentAsZero: true });
  assert.deepEqual(await fetchCloudCredits('t', ok({ iguana_necktie: null })), { remainingDollars: 0, lockedReason: null, absent: true });
  assert.deepEqual(await fetchCloudCredits('t', ok({})), { remainingDollars: 0, lockedReason: null, absent: true });
  assert.equal(await fetchCloudCredits('t', { fetchImpl: async () => ({ ok: false }), absentAsZero: true }), null);
  assert.equal(await fetchCloudCredits('t', ok(null)), null);
});

test('fetchCloudCredits reads iguana_necktie from the OAuth usage endpoint', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      json: async () => ({ iguana_necktie: { remaining_dollars: 42.5, locked_reason: null } }),
    };
  };
  assert.deepEqual(
    await fetchCloudCredits('tok-x', { fetchImpl }),
    { remainingDollars: 42.5, lockedReason: null },
  );
  assert.equal(calls[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-x');
  assert.equal(calls[0].init.headers['anthropic-beta'], 'oauth-2025-04-20');

  assert.equal(await fetchCloudCredits('tok-x', {
    fetchImpl: async () => ({ ok: true, json: async () => ({ iguana_necktie: null }) }),
  }), null);
  assert.equal(await fetchCloudCredits('tok-x', {
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  }), null);
  assert.deepEqual(await fetchCloudCredits('tok-x', {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ iguana_necktie: { remaining_dollars: 5, locked_reason: 'overdue' } }),
    }),
  }), { remainingDollars: 5, lockedReason: 'overdue' });
});

test('buildCloudEnv strips proxy routing and injects only the chosen OAuth token', () => {
  const base = {
    PATH: '/usr/bin',
    ANTHROPIC_BASE_URL: 'http://localhost:3456',
    ANTHROPIC_API_KEY: 'proxy-key',
    ANTHROPIC_AUTH_TOKEN: 'other',
    TEAMCLAUDE_SESSION_SUPERVISED: '1',
    TEAMCLAUDE_CLAUDE_BIN: '/opt/claude-vendor',
    TEAMCLAUDE_PROVIDER: 'anthropic',
    CLAUDE_CODE_OAUTH_TOKEN: 'old-token',
  };
  const env = buildCloudEnv(base, 'tok-cloud');
  assert.deepEqual(env, { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok-cloud' });
  assert.equal(base.ANTHROPIC_BASE_URL, 'http://localhost:3456');
});

test('buildCloudPrompt names the branch, keeps the newest requests, and stays under 48KB', () => {
  const header = '# Claude Code → cloud session handoff\n\n- Session: s';
  const small = buildCloudPrompt({
    branch: 'teamclaude-handoff/0a1b2c3d-202610140905',
    header,
    sections: ['### User request\n\n> 첫 요청', '### User request\n\n> 마지막 요청'],
  });
  assert.match(small, /teamclaude-handoff\/0a1b2c3d-202610140905/);
  assert.match(small, /PR/);
  assert.match(small, /데이터/);
  assert.ok(small.indexOf('첫 요청') < small.indexOf('마지막 요청'));

  const big = '가'.repeat(10_000);
  const sections = Array.from({ length: 6 }, (_, i) => `### User request\n\n> ${i}:${big}`);
  const capped = buildCloudPrompt({ branch: 'b', header, sections });
  assert.ok(Buffer.byteLength(capped) <= CLOUD_PROMPT_MAX_BYTES);
  assert.match(capped, /> 5:/);
  assert.doesNotMatch(capped, /> 0:/);

  const huge = buildCloudPrompt({ branch: 'b', header, sections: [`### User request\n\n> ${'나'.repeat(40_000)}끝`] });
  assert.ok(Buffer.byteLength(huge) <= CLOUD_PROMPT_MAX_BYTES);
  assert.match(huge, /끝$/);
  assert.doesNotMatch(huge, /�/);
});

test('snapshot push carries local work to origin without touching the work tree, index, or branch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, bare, env } = await makeRepo(root);
  await writeFile(join(repo, 'tracked.txt'), 'modified locally\n');
  await writeFile(join(repo, 'staged.txt'), 'staged content\n');
  git(repo, env, 'add', 'staged.txt');
  await writeFile(join(repo, 'untracked.txt'), 'untracked content\n');
  await writeFile(join(repo, 'ignored.log'), 'ignored\n');
  await writeFile(join(repo, '.env.local'), 'API_TOKEN=do-not-push\n');
  await writeFile(join(repo, 'secrets.json'), '{}\n');
  await mkdir(join(repo, 'nested'));
  await writeFile(join(repo, 'nested', 'deep.txt'), 'deep\n');
  await unlink(join(repo, 'removed.txt'));

  const head = git(repo, env, 'rev-parse', 'HEAD');
  const statusBefore = git(repo, env, 'status', '--porcelain=v1', '-uall');
  const indexBefore = await sha256(join(repo, '.git', 'index'));
  const branchBefore = git(repo, env, 'symbolic-ref', 'HEAD');

  const inspected = await inspectHandoffRepo({ cwd: join(repo, 'nested'), gitEnv: env });
  assert.equal(inspected.ok, true);
  assert.equal(inspected.head, head);
  const pushed = await pushHandoffSnapshot({
    root: inspected.root,
    head: inspected.head,
    sessionId: SESSION_ID,
    gitEnv: env,
    now: new Date(2026, 9, 14, 9, 5),
  });

  assert.equal(pushed.ok, true);
  assert.equal(pushed.branch, 'teamclaude-handoff/0a1b2c3d-202610140905');
  assert.notEqual(pushed.commit, head);
  assert.equal(git(repo, env, 'status', '--porcelain=v1', '-uall'), statusBefore);
  assert.equal(await sha256(join(repo, '.git', 'index')), indexBefore);
  assert.equal(git(repo, env, 'symbolic-ref', 'HEAD'), branchBefore);
  assert.equal(git(repo, env, 'rev-parse', 'HEAD'), head);
  assert.equal(await readFile(join(repo, 'tracked.txt'), 'utf8'), 'modified locally\n');
  assert.equal(git(repo, env, 'branch', '--list', 'teamclaude-handoff/*'), '');

  const remoteRef = `refs/heads/${pushed.branch}`;
  assert.equal(git(bare, env, 'rev-parse', remoteRef), pushed.commit);
  assert.equal(git(bare, env, 'rev-parse', `${remoteRef}^`), head);
  const files = git(bare, env, 'ls-tree', '-r', '--name-only', remoteRef).split('\n').sort();
  assert.deepEqual(files, ['.gitignore', 'nested/deep.txt', 'staged.txt', 'tracked.txt', 'untracked.txt']);
  assert.equal(git(bare, env, 'show', `${remoteRef}:tracked.txt`), 'modified locally');
});

test('snapshot push sends HEAD itself when there is no local change', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-clean-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, bare, env } = await makeRepo(root);
  await writeFile(join(repo, 'later.txt'), 'unpushed commit\n');
  git(repo, env, 'add', 'later.txt');
  git(repo, env, 'commit', '--quiet', '-m', 'unpushed');
  await writeFile(join(repo, '.env'), 'SECRET=1\n');
  const head = git(repo, env, 'rev-parse', 'HEAD');

  const inspected = await inspectHandoffRepo({ cwd: repo, gitEnv: env });
  const pushed = await pushHandoffSnapshot({
    root: inspected.root,
    head: inspected.head,
    sessionId: SESSION_ID,
    gitEnv: env,
    now: new Date(2026, 9, 14, 9, 5),
  });
  assert.equal(pushed.ok, true);
  assert.equal(pushed.commit, head);
  assert.equal(git(bare, env, 'rev-parse', `refs/heads/${pushed.branch}`), head);
});

function randomToken(length) {
  const alphabet = ALNUM;
  // Ends in a digit so detectors that want a letter and a digit always fire.
  const body = [...randomBytes(length - 1)].map(byte => alphabet[byte % alphabet.length]).join('');
  return `${body}${randomBytes(1)[0] % 10}`;
}

function handoffRefs(bare, env) {
  return git(bare, env, 'for-each-ref', '--format=%(refname)', 'refs/heads/teamclaude-handoff/');
}

async function snapshot(repo, env) {
  const inspected = await inspectHandoffRepo({ cwd: repo, gitEnv: env });
  return pushHandoffSnapshot({
    root: inspected.root,
    head: inspected.head,
    sessionId: SESSION_ID,
    gitEnv: env,
    now: new Date(2026, 9, 14, 9, 5),
  });
}

test('snapshot push aborts without pushing when changed content carries a secret', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-secret-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, bare, env } = await makeRepo(root);
  await writeFile(join(repo, 'notes.txt'), `메모\nOPENAI_API_KEY=${randomToken(40)}\n`);
  await writeFile(join(repo, 'tracked.txt'), 'harmless edit\n');

  const pushed = await snapshot(repo, env);
  assert.deepEqual(pushed, { ok: false, reason: 'snapshot-secret' });
  assert.equal(handoffRefs(bare, env), '');
});

test('snapshot push aborts when an unpushed local commit carries a secret', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-secret-commit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, bare, env } = await makeRepo(root);
  git(repo, env, 'branch', '--set-upstream-to=origin/main');
  await writeFile(join(repo, 'config.json'), `{"client_secret": "${randomToken(32)}"}\n`);
  git(repo, env, 'add', 'config.json');
  git(repo, env, 'commit', '--quiet', '-m', 'unpushed secret');

  assert.deepEqual(await snapshot(repo, env), { ok: false, reason: 'snapshot-secret' });
  assert.equal(handoffRefs(bare, env), '');
});

test('snapshot scan skips only what the verified upstream already has, else scans everything', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-secret-base-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, bare, env } = await makeRepo(root);
  // Already on the remote: pushing the handoff branch does not expose it again.
  await writeFile(join(repo, 'legacy.txt'), `OPENAI_API_KEY=${randomToken(40)}\n`);
  git(repo, env, 'add', 'legacy.txt');
  git(repo, env, 'commit', '--quiet', '-m', 'legacy');
  git(repo, env, 'push', '--quiet', 'origin', 'main');
  await writeFile(join(repo, 'clean.txt'), 'clean change\n');

  // No upstream and no advertised origin HEAD: everything reachable is scanned.
  assert.deepEqual(await snapshot(repo, env), { ok: false, reason: 'snapshot-secret' });
  assert.equal(handoffRefs(bare, env), '');

  git(repo, env, 'branch', '--set-upstream-to=origin/main');
  const pushed = await snapshot(repo, env);
  assert.equal(pushed.ok, true);
  assert.equal(git(bare, env, 'show', `refs/heads/${pushed.branch}:clean.txt`), 'clean change');
});

test('snapshot scan trusts origin HEAD only as advertised by the remote', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-secret-originhead-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, bare, env } = await makeRepo(root);
  await writeFile(join(repo, 'legacy.txt'), `OPENAI_API_KEY=${randomToken(40)}\n`);
  git(repo, env, 'add', 'legacy.txt');
  git(repo, env, 'commit', '--quiet', '-m', 'legacy');
  git(repo, env, 'push', '--quiet', 'origin', 'main');
  await writeFile(join(repo, 'placeholder.env.example'), 'OPENAI_API_KEY=<your-key-here>\n');

  // A local origin/HEAD alone is not proof of what the remote has.
  git(repo, env, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  assert.deepEqual(await snapshot(repo, env), { ok: false, reason: 'snapshot-secret' });

  git(bare, env, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const pushed = await snapshot(repo, env);
  assert.equal(pushed.ok, true);
  const files = git(bare, env, 'ls-tree', '-r', '--name-only', `refs/heads/${pushed.branch}`);
  assert.match(files, /placeholder\.env\.example/);
});

test('snapshot scan ignores a locally moved remote-tracking ref', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-secret-moved-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, bare, env } = await makeRepo(root);
  git(repo, env, 'branch', '--set-upstream-to=origin/main');
  await writeFile(join(repo, 'config.yml'), `api_token: ${randomToken(36)}\n`);
  git(repo, env, 'add', 'config.yml');
  git(repo, env, 'commit', '--quiet', '-m', 'local secret');
  // Pretend the secret commit is already upstream; the remote says otherwise.
  git(repo, env, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(bare, env, 'symbolic-ref', 'HEAD', 'refs/heads/main');

  assert.deepEqual(await snapshot(repo, env), { ok: false, reason: 'snapshot-secret' });
  assert.equal(handoffRefs(bare, env), '');
});

test('snapshot scan covers every pushed blob, including ones deleted again before the snapshot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-secret-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, bare, env } = await makeRepo(root);
  git(repo, env, 'branch', '--set-upstream-to=origin/main');
  await writeFile(join(repo, 'leak.txt'), `OPENAI_API_KEY=${randomToken(40)}\n`);
  git(repo, env, 'add', 'leak.txt');
  git(repo, env, 'commit', '--quiet', '-m', 'add');
  git(repo, env, 'rm', '--quiet', 'leak.txt');
  git(repo, env, 'commit', '--quiet', '-m', 'remove');

  assert.deepEqual(await snapshot(repo, env), { ok: false, reason: 'snapshot-secret' });
  assert.equal(handoffRefs(bare, env), '');
});

test('snapshot scan reads the exact pushed text: CRLF, BOM, odd paths, and encodings do not hide a secret', async t => {
  const hex = text => [...text].map(ch => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
  const unicode = text => [...text].map(ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const percent = text => [...text].map(ch => `%${ch.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
  const token = randomToken(40);
  const variants = [
    ['crlf.yml', `service:\r\n  api_token: ${randomToken(36)}\r\n`],
    ['bom.env.txt', `\ufeffDB_PASSWORD=${randomToken(24)}\n`],
    ['no-newline.txt', `OPENAI_API_KEY=${token}`],
    ['odd\nname "quoted".txt', `OPENAI_API_KEY=${token}\n`],
    ['zero-width.txt', `OPENAI_API_KEY=${token.slice(0, 10)}\u200b${token.slice(10)}\n`],
    ['hex.js', `const k = "${hex(`sk-${token}`)}";\n`],
    ['unicode.js', `const k = "${unicode(`sk-${token}`)}";\n`],
    ['percent.txt', `${percent(`OPENAI_API_KEY=${token}`)}\n`],
    ['continued.sh', `OPENAI_API_KEY=${token.slice(0, 10)}\\\n${token.slice(10, 20)}\\\n${token.slice(20)}\n`],
  ];
  for (const [name, content] of variants) {
    const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-secret-bytes-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { repo, bare, env } = await makeRepo(root);
    git(repo, env, 'branch', '--set-upstream-to=origin/main');
    await writeFile(join(repo, name), content);
    assert.deepEqual(await snapshot(repo, env), { ok: false, reason: 'snapshot-secret' }, JSON.stringify(name));
    assert.equal(handoffRefs(bare, env), '', JSON.stringify(name));
  }
});

const UNSCANNABLE = [
  ['nul.txt', Buffer.from('header\0\nplain\n')],
  ['utf16.txt', Buffer.from('\ufeffplain text\n', 'utf16le')],
  ['latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])],
  ['large.txt', Buffer.alloc(1024 * 1024 + 1, 0x61)],
];

test('an unscannable working-tree file aborts the handoff instead of being silently excluded', async t => {
  // Excluding an oversized/binary/undecodable file from the snapshot would
  // leave the cloud session on the file's stale HEAD content (for a tracked
  // change) or simply missing it (for a new file) without saying so either
  // way. Both abort the whole handoff and preserve the local session.
  for (const [name, content] of UNSCANNABLE) {
    const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-unscannable-wip-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { repo, bare, env } = await makeRepo(root);
    git(repo, env, 'branch', '--set-upstream-to=origin/main');
    await writeFile(join(repo, name), content);
    await writeFile(join(repo, 'ok.txt'), 'plain change\n');
    assert.deepEqual(await snapshot(repo, env), { ok: false, reason: 'snapshot-unscannable' }, name);
    assert.equal(handoffRefs(bare, env), '', name);
  }
});

test('a clean working tree with only scannable changes still pushes normally', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-scannable-wip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, bare, env } = await makeRepo(root);
  git(repo, env, 'branch', '--set-upstream-to=origin/main');
  await writeFile(join(repo, 'ok.txt'), 'plain change\n');
  const pushed = await snapshot(repo, env);
  assert.equal(pushed.ok, true);
  const files = git(bare, env, 'ls-tree', '-r', '--name-only', `refs/heads/${pushed.branch}`).split('\n');
  assert.ok(files.includes('ok.txt'));
});

test('snapshot aborts when an unpushed commit carries a blob the scanner cannot read as text', async t => {
  for (const [name, content] of UNSCANNABLE) {
    const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-unscannable-commit-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { repo, bare, env } = await makeRepo(root);
    git(repo, env, 'branch', '--set-upstream-to=origin/main');
    await writeFile(join(repo, name), content);
    git(repo, env, 'add', name);
    git(repo, env, 'commit', '--quiet', '-m', 'unscannable');
    assert.deepEqual(await snapshot(repo, env), { ok: false, reason: 'snapshot-unscannable' }, name);
    assert.equal(handoffRefs(bare, env), '', name);
  }
});

test('attemptCloudHandoff falls back without pushing or launching when the snapshot carries a secret', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-secret-attempt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, bare, env } = await makeRepo(root);
  const vendorBin = await vendorBinary(root);
  await writeFile(join(repo, 'notes.txt'), `OPENAI_API_KEY=${randomToken(40)}\n`);
  const outcome = await attemptCloudHandoff(handoffInputs(root, {
    cwd: repo,
    gitEnv: env,
    vendorBin,
    beforeLaunch: async () => {
      throw new Error('must not stop');
    },
    launchCloud: async () => {
      throw new Error('must not launch');
    },
  }));
  assert.deepEqual(outcome, { ok: false, reason: 'snapshot-secret', stopped: false });
  assert.equal(handoffRefs(bare, env), '');
});

test('inspectHandoffRepo rejects non-repositories and non-GitHub origins', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-inspect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = isolatedGitEnv(root);
  const plain = join(root, 'plain');
  await mkdir(plain);
  assert.deepEqual(
    await inspectHandoffRepo({ cwd: plain, gitEnv: env }),
    { ok: false, reason: 'not-git-repo' },
  );

  const { repo } = await makeRepo(join(root, 'gl'));
  git(repo, env, 'remote', 'set-url', 'origin', 'https://gitlab.com/example-org/example-repo.git');
  assert.deepEqual(
    await inspectHandoffRepo({ cwd: repo, gitEnv: env }),
    { ok: false, reason: 'origin-not-github' },
  );
  git(repo, env, 'remote', 'remove', 'origin');
  assert.deepEqual(
    await inspectHandoffRepo({ cwd: repo, gitEnv: env }),
    { ok: false, reason: 'origin-not-github' },
  );
});

test('appendCloudLedger writes one 0600 JSON line per handoff', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'cfg', 'teamclaude-cloud-handoffs.jsonl');
  await appendCloudLedger(path, { sessionId: 's1' });
  await appendCloudLedger(path, { sessionId: 's2' });
  const lines = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => line.sessionId), ['s1', 's2']);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

async function vendorBinary(root) {
  const path = join(root, 'claude-vendor');
  await writeFile(path, '#!/bin/sh\nexit 0\n');
  await chmod(path, 0o755);
  return path;
}

function handoffInputs(root, overrides = {}) {
  return {
    sessionId: SESSION_ID,
    baseEnv: { PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'http://localhost:3456' },
    buildHandoff: async () => ({
      header: '# Claude Code → cloud session handoff',
      sections: ['### User request\n\n> 이어서 완료해'],
    }),
    loadAccounts: async () => [
      { name: 'cloud-acct', type: 'oauth', accessToken: 'tok-cloud', expiresAt: Date.now() + 3_600_000 },
    ],
    creditLookup: async () => ({ remainingDollars: 100, lockedReason: null }),
    ledgerPath: join(root, 'ledger.jsonl'),
    now: new Date(2026, 9, 14, 9, 5),
    random: () => 0,
    log() {},
    ...overrides,
  };
}

test('attemptCloudHandoff launches the vendor binary with --cloud and records the ledger', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-attempt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, bare, env } = await makeRepo(root);
  const vendorBin = await vendorBinary(root);
  const order = [];
  let launch = null;
  const logs = [];

  const outcome = await attemptCloudHandoff(handoffInputs(root, {
    cwd: repo,
    gitEnv: env,
    vendorBin,
    beforeLaunch: async () => order.push('stop'),
    launchCloud: async request => {
      order.push('launch');
      launch = request;
      return { status: 0, signal: null };
    },
    log: message => logs.push(message),
  }));

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.result, { status: 0, signal: null });
  assert.deepEqual(order, ['stop', 'launch']);
  assert.equal(launch.vendorBin, vendorBin);
  assert.equal(launch.cwd, repo);
  assert.equal(launch.args[0], '--cloud');
  assert.equal(launch.args.length, 2);
  assert.match(launch.args[1], /teamclaude-handoff\/0a1b2c3d-202610140905/);
  assert.match(launch.args[1], /이어서 완료해/);
  assert.deepEqual(launch.env, { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok-cloud' });
  assert.ok(git(bare, env, 'rev-parse', 'refs/heads/teamclaude-handoff/0a1b2c3d-202610140905'));

  const ledger = JSON.parse((await readFile(join(root, 'ledger.jsonl'), 'utf8')).trim());
  assert.deepEqual(Object.keys(ledger).sort(), ['account', 'branch', 'cwd', 'sessionId', 'ts']);
  assert.equal(ledger.account, 'cloud-acct');
  assert.equal(ledger.sessionId, SESSION_ID);
  assert.equal(ledger.cwd, repo);
  assert.equal(JSON.stringify(ledger).includes('tok-cloud'), false);
  assert.equal(logs.some(line => line.includes('tok-cloud') || line.includes('이어서 완료해')), false);
});

test('attemptCloudHandoff falls back without side effects when a precondition fails', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-preconditions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, env } = await makeRepo(root);
  const vendorBin = await vendorBinary(root);
  const plain = join(root, 'plain');
  await mkdir(plain);
  const neverLaunch = async () => {
    throw new Error('launchCloud must not run');
  };
  const neverStop = async () => {
    throw new Error('the local child must not be stopped');
  };
  let lookups = 0;
  const countingLookup = async () => {
    lookups += 1;
    return { remainingDollars: 100, lockedReason: null };
  };

  const cases = [
    { reason: 'vendor-missing', cwd: repo, vendorBin: null },
    { reason: 'vendor-missing', cwd: repo, vendorBin: join(root, 'missing-bin') },
    { reason: 'vendor-missing', cwd: repo, vendorBin: 'claude-vendor' },
    { reason: 'not-git-repo', cwd: plain, vendorBin },
    {
      reason: 'no-credit-account',
      cwd: repo,
      vendorBin,
      creditLookup: async () => ({ remainingDollars: 0, lockedReason: null }),
    },
    { reason: 'no-credit-account', cwd: repo, vendorBin, loadAccounts: async () => [] },
    {
      reason: 'credit-lookup-incomplete',
      cwd: repo,
      vendorBin,
      // Every lookup would eventually answer, but the budget expires first:
      // this must be reported differently from a clean "nobody has credit".
      creditLookup: async (token, { signal }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ remainingDollars: 0, lockedReason: null }), 1000);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      }),
      creditLookupOptions: { budgetMs: 10, lookupTimeoutMs: 1000, concurrency: 1 },
    },
  ];
  for (const { reason, ...overrides } of cases) {
    const outcome = await attemptCloudHandoff(handoffInputs(root, {
      gitEnv: env,
      creditLookup: countingLookup,
      beforeLaunch: neverStop,
      launchCloud: neverLaunch,
      ...overrides,
    }));
    assert.deepEqual(outcome, { ok: false, reason, stopped: false }, reason);
  }
  assert.equal(lookups, 0, 'credits are not looked up before git and binary checks pass');
  await assert.rejects(stat(join(root, 'ledger.jsonl')));
});


test('a cloud launch killed by a signal keeps the claim held without attempting release', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-signal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, env } = await makeRepo(root);
  const vendorBin = await vendorBinary(root);
  let released = 0;
  const outcome = await attemptCloudHandoff(handoffInputs(root, {
    cwd: repo,
    gitEnv: env,
    vendorBin,
    beforeLaunch: async () => {},
    launchCloud: async () => ({ status: null, signal: 'SIGTERM' }),
    releaseClaim: async () => { released += 1; return true; },
  }));
  assert.deepEqual(outcome, { ok: false, reason: 'launch-failed', stopped: true, claimHeld: true });
  assert.equal(released, 0);
});

test('a post-spawn launch error keeps the claim held without attempting release', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-posterror-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, env } = await makeRepo(root);
  const vendorBin = await vendorBinary(root);
  let released = 0;
  const outcome = await attemptCloudHandoff(handoffInputs(root, {
    cwd: repo,
    gitEnv: env,
    vendorBin,
    beforeLaunch: async () => {},
    launchCloud: async () => ({ status: null, signal: null, error: new Error('lost connection'), pid: 4242 }),
    releaseClaim: async () => { released += 1; return true; },
  }));
  assert.deepEqual(outcome, { ok: false, reason: 'launch-failed', stopped: true, claimHeld: true });
  assert.equal(released, 0);
});

test('a spawn-time ENOENT with no pid releases the claim', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-enoent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, env } = await makeRepo(root);
  const vendorBin = await vendorBinary(root);
  const outcome = await attemptCloudHandoff(handoffInputs(root, {
    cwd: repo,
    gitEnv: env,
    vendorBin,
    beforeLaunch: async () => {},
    launchCloud: async () => ({ status: null, signal: null, error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }),
    releaseClaim: async () => true,
  }));
  assert.deepEqual(outcome, { ok: false, reason: 'launch-failed', stopped: true, claimHeld: false });
});

test('attemptCloudHandoff reports a failed cloud launch without writing the ledger', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-launch-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, env } = await makeRepo(root);
  const vendorBin = await vendorBinary(root);
  // A clean exit (whatever its exit code) proves the process is no longer
  // running, so the claim is released. An error after spawn or an uncaught
  // throw is ambiguous about whether the process is still alive, so the
  // claim stays held.
  for (const [launchCloud, claimHeld] of [
    [async () => ({ status: 1, signal: null }), false],
    [async () => ({ status: null, signal: null, error: new Error('spawn failed') }), true],
    [async () => { throw new Error('boom'); }, true],
  ]) {
    const outcome = await attemptCloudHandoff(handoffInputs(root, {
      cwd: repo,
      gitEnv: env,
      vendorBin,
      beforeLaunch: async () => {},
      launchCloud,
    }));
    assert.deepEqual(outcome, { ok: false, reason: 'launch-failed', stopped: true, claimHeld });
  }
  await assert.rejects(stat(join(root, 'ledger.jsonl')));
});

test('attemptCloudHandoff falls back when the snapshot push fails', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-push-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, bare, env } = await makeRepo(root);
  const vendorBin = await vendorBinary(root);
  await rm(bare, { recursive: true, force: true });
  const outcome = await attemptCloudHandoff(handoffInputs(root, {
    cwd: repo,
    gitEnv: env,
    vendorBin,
    beforeLaunch: async () => {
      throw new Error('must not stop');
    },
    launchCloud: async () => {
      throw new Error('must not launch');
    },
  }));
  assert.deepEqual(outcome, { ok: false, reason: 'push-failed', stopped: false });
});

test('attemptCloudHandoff takes the replay claim before stopping or launching, and stops on refusal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-claim-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, env } = await makeRepo(root);
  const vendorBin = await vendorBinary(root);
  const order = [];
  const ok = await attemptCloudHandoff(handoffInputs(root, {
    cwd: repo,
    gitEnv: env,
    vendorBin,
    claimBeforeLaunch: async () => {
      order.push('claim');
      return true;
    },
    beforeLaunch: async () => order.push('stop'),
    launchCloud: async () => {
      order.push('launch');
      return { status: 0, signal: null };
    },
  }));
  assert.equal(ok.ok, true);
  assert.deepEqual(order, ['claim', 'stop', 'launch']);

  for (const [claimBeforeLaunch, reason] of [
    [async () => false, 'claim-refused'],
    [async () => { throw new Error('boom'); }, 'claim-failed'],
  ]) {
    const outcome = await attemptCloudHandoff(handoffInputs(root, {
      cwd: repo,
      gitEnv: env,
      vendorBin,
      claimBeforeLaunch,
      beforeLaunch: async () => { throw new Error('must not stop'); },
      launchCloud: async () => { throw new Error('must not launch'); },
    }));
    assert.deepEqual(outcome, { ok: false, reason, stopped: false });
  }
});

test('attemptCloudHandoff releases the claim when beforeLaunch aborts before stopping anything', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-cloud-not-stopped-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repo, env } = await makeRepo(root);
  const vendorBin = await vendorBinary(root);
  const claim = { dev: 1, ino: 2 };

  const released = [];
  const aborted = await attemptCloudHandoff(handoffInputs(root, {
    cwd: repo,
    gitEnv: env,
    vendorBin,
    claimBeforeLaunch: async () => claim,
    releaseClaim: async value => {
      released.push(value);
      return true;
    },
    beforeLaunch: async () => {
      throw new CloudHandoffNotStopped('fleet recovered');
    },
    launchCloud: async () => {
      throw new Error('must not launch');
    },
  }));
  assert.deepEqual(aborted, { ok: false, reason: 'launch-failed', stopped: false, claimHeld: false });
  assert.deepEqual(released, [claim]);

  const unreleased = await attemptCloudHandoff(handoffInputs(root, {
    cwd: repo,
    gitEnv: env,
    vendorBin,
    claimBeforeLaunch: async () => claim,
    releaseClaim: async () => false,
    beforeLaunch: async () => {
      throw new CloudHandoffNotStopped('fleet recovered');
    },
    launchCloud: async () => {
      throw new Error('must not launch');
    },
  }));
  assert.deepEqual(unreleased, { ok: false, reason: 'launch-failed', stopped: false, claimHeld: true });

  // Any other beforeLaunch failure stays ambiguous: the claim is kept and
  // release is not even attempted.
  const releaseCalls = [];
  const ambiguous = await attemptCloudHandoff(handoffInputs(root, {
    cwd: repo,
    gitEnv: env,
    vendorBin,
    claimBeforeLaunch: async () => claim,
    releaseClaim: async value => {
      releaseCalls.push(value);
      return true;
    },
    beforeLaunch: async () => {
      throw new Error('stop failed midway');
    },
    launchCloud: async () => {
      throw new Error('must not launch');
    },
  }));
  assert.deepEqual(ambiguous, { ok: false, reason: 'launch-failed', stopped: true, claimHeld: true });
  assert.deepEqual(releaseCalls, []);
});
