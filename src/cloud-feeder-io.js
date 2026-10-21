// Real side effects for the cloud feeder (src/cloud-feeder.js): gh, the TDL
// ledger query, local clone discovery, git, the state file and its lock.

import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isFolderTrusted } from './cloud-dispatch.js';
import { githubRepoOf } from './cloud-feeder.js';

const REVIEW_TIMEOUT_MS = 25 * 60 * 1000;
const LIST_LIMIT = 1000;

export function feederStatePath() {
  return join(homedir(), '.config', 'teamclaude.cloud-feeder.json');
}

// A missing file is a fresh start; an unreadable or corrupt one is an error
// (treating it as empty would resend everything already sent).
export async function readFeederState(path = feederStatePath()) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { sent: {} };
    throw error;
  }
  const state = JSON.parse(text);
  if (!state || typeof state !== 'object' || typeof state.sent !== 'object') throw new Error('corrupt feeder state');
  return state;
}

export async function writeFeederState(state, path = feederStatePath()) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 1)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

// One feeder at a time (launchd tick and a manual run share the state file).
// The lock names its owner (pid + nonce); it is only taken over when that pid
// is gone, and only released by the owner that still holds it.
export async function withFeederLock(fn, path = `${feederStatePath()}.lock`) {
  const nonce = randomUUID();
  const take = async () => {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }));
    } finally {
      await handle.close();
    }
  };
  try {
    await take();
  } catch {
    let holder = null;
    try {
      holder = JSON.parse(await readFile(path, 'utf8'));
    } catch {}
    if (!Number.isInteger(holder?.pid) || pidAlive(holder.pid)) return { locked: true };
    await rm(path, { force: true });
    try {
      await take();
    } catch {
      return { locked: true };
    }
  }
  try {
    return { locked: false, value: await fn() };
  } finally {
    try {
      if (JSON.parse(await readFile(path, 'utf8')).nonce === nonce) await rm(path, { force: true });
    } catch {}
  }
}

function run(command, args, { cwd, timeout = 120_000, input } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

function ghJson(args) {
  const result = run('gh', args);
  if (result.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed`);
  return JSON.parse(result.stdout || '[]');
}

function warnTruncated(what, list, log) {
  if (list.length >= LIST_LIMIT) log?.(`[cloud-feed] ${what} list hit the ${LIST_LIMIT} limit; later items are not seen this run`);
  return list;
}

export function listIssues(owners, log) {
  return owners.flatMap(owner => warnTruncated(`issues(${owner})`, ghJson([
    'search', 'issues', '--owner', owner, '--state', 'open', '--limit', String(LIST_LIMIT),
    '--json', 'repository,number,title,body,labels,authorAssociation',
  ]), log));
}

// Open PRs: trust (author association) from search, head fields per repo.
export function listPulls(owners, log) {
  const found = owners.flatMap(owner => warnTruncated(`prs(${owner})`, ghJson([
    'search', 'prs', '--owner', owner, '--state', 'open', '--limit', String(LIST_LIMIT),
    '--json', 'repository,number,title,isDraft,author,authorAssociation',
  ]), log));
  const byRepo = new Map();
  for (const pull of found) {
    const repo = pull.repository?.nameWithOwner;
    if (!repo) continue;
    if (!byRepo.has(repo)) byRepo.set(repo, new Map());
    byRepo.get(repo).set(pull.number, pull);
  }
  const out = [];
  for (const [repo, pulls] of byRepo) {
    const heads = ghJson([
      'pr', 'list', '-R', repo, '--state', 'open', '--limit', String(LIST_LIMIT),
      '--json', 'number,headRefName,headRefOid,isCrossRepository',
    ]);
    for (const head of heads) {
      const pull = pulls.get(head.number);
      if (pull) out.push({ ...pull, ...head, repository: { nameWithOwner: repo } });
    }
  }
  return out;
}

const TASK_QUERY = [
  'select t.id, t.title, t.description, p.github_repo',
  'from os_tasks t join os_projects p on p.id = t.project_id',
  "where t.status = 'todo' and coalesce(p.github_repo, '') <> ''",
  `order by t.created_at limit ${LIST_LIMIT}`,
].join(' ');

// Read-only ledger query through the guarded CLI.
export function listTasks() {
  const result = run(join(homedir(), '.claude', 'bin', 'sb-sql'), ['--project', 'internal', TASK_QUERY]);
  if (result.status !== 0) throw new Error('task query failed');
  return JSON.parse(result.stdout).rows ?? [];
}

// owner/name -> trusted local clone path, from one level under each root.
export async function buildRepoIndex(roots) {
  const index = new Map();
  for (const root of roots) {
    let names = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const dir = join(root, name);
      let gitIsDir = false;
      try {
        gitIsDir = lstatSync(join(dir, '.git')).isDirectory();
      } catch {
        continue;
      }
      // Linked worktrees (.git file) are skipped: the main clone represents the repo.
      if (!gitIsDir) continue;
      const repo = githubRepoOf(run('git', ['-C', dir, 'config', '--get', 'remote.origin.url']).stdout);
      if (!repo || index.has(repo)) continue;
      if (await isFolderTrusted(dir)) index.set(repo, dir);
    }
  }
  return index;
}

// origin/<default branch> after a fetch, or null.
export function defaultBase(cwd) {
  if (run('git', ['-C', cwd, 'fetch', '-q', 'origin'], { timeout: 120_000 }).status !== 0) return null;
  const head = run('git', ['-C', cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).stdout.trim();
  if (head) return head;
  for (const candidate of ['origin/main', 'origin/master']) {
    if (run('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', candidate]).status === 0) return candidate;
  }
  return null;
}

// The PR opened from exactly this branch of this repository (never a fork's
// branch that happens to share the name).
export function findPull(repo, branch) {
  const pulls = ghJson([
    'pr', 'list', '-R', repo, '--head', branch, '--state', 'all', '--limit', '20',
    '--json', 'number,state,isDraft,headRefOid,headRefName,isCrossRepository,title,baseRefName',
  ]);
  return pulls.find(pull => pull.headRefName === branch && pull.isCrossRepository === false) ?? null;
}

// [] = no checks configured; null = the query failed (unknown, so wait).
export function listChecks(repo, number) {
  const result = run('gh', ['pr', 'checks', String(number), '-R', repo, '--json', 'name,state,bucket']);
  if (/no checks reported/i.test(result.stderr)) return [];
  // gh exits 8 while checks are pending; the JSON is still complete.
  if (result.status !== 0 && result.status !== 8 && result.status !== 1) return null;
  try {
    const checks = JSON.parse(result.stdout);
    return Array.isArray(checks) ? checks : null;
  } catch {
    return null;
  }
}

function headOf(repo, number) {
  try {
    return ghJson(['pr', 'view', String(number), '-R', repo, '--json', 'headRefOid']).headRefOid ?? null;
  } catch {
    return null;
  }
}

// Cross-vendor review of the PR diff; returns APPROVE, REQUEST_CHANGES or null.
export async function reviewPull(repo, pull, cwd) {
  const scratch = await mkdtemp(join(tmpdir(), 'teamclaude-feed-review-'));
  try {
    // The diff must be the one of pull.headRefOid, the commit merged later
    // (--match-head-commit): the head is read before and after the diff.
    if (headOf(repo, pull.number) !== pull.headRefOid) return null;
    const diff = run('gh', ['pr', 'diff', String(pull.number), '-R', repo]);
    if (diff.status !== 0 || !diff.stdout.trim()) return null;
    if (headOf(repo, pull.number) !== pull.headRefOid) return null;
    const diffPath = join(scratch, 'pr.diff');
    await writeFile(diffPath, diff.stdout);
    const result = run('bash', [
      join(homedir(), '.claude', 'scripts', 'codex-astra-review.sh'),
      '--diff', diffPath, '--label', `cloud-feed ${repo}#${pull.number}`,
    ], { cwd: cwd ?? dirname(diffPath), timeout: REVIEW_TIMEOUT_MS });
    // The engine's exit code is its final (gate-adjusted) verdict: 0 approve,
    // 1 request changes; anything else is no verdict.
    const verdict = `${result.stdout}\n${result.stderr}`.match(/^VERDICT:\s*(APPROVE|REQUEST_CHANGES)\b/m)?.[1];
    if (result.status === 0 && !result.error && verdict === 'APPROVE') return 'APPROVE';
    if (result.status === 1 && verdict === 'REQUEST_CHANGES') return 'REQUEST_CHANGES';
    return null;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function mergePull(repo, pull) {
  const merged = run('gh', ['pr', 'merge', String(pull.number), '-R', repo, '--merge', '--match-head-commit', pull.headRefOid]);
  if (merged.status !== 0) return false;
  return findPullByNumber(repo, pull.number)?.state === 'MERGED';
}

function findPullByNumber(repo, number) {
  try {
    return ghJson(['pr', 'view', String(number), '-R', repo, '--json', 'state']);
  } catch {
    return null;
  }
}
