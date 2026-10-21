// Real side effects for the cloud feeder (src/cloud-feeder.js): gh, the TDL
// ledger query, local clone discovery, git, the state file and its lock.

import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isFolderTrusted } from './cloud-dispatch.js';
import { githubRepoOf } from './cloud-feeder.js';

const LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const REVIEW_TIMEOUT_MS = 25 * 60 * 1000;

export function feederStatePath() {
  return join(homedir(), '.config', 'teamclaude.cloud-feeder.json');
}

export async function readFeederState(path = feederStatePath()) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { sent: {} };
  }
}

export async function writeFeederState(state, path = feederStatePath()) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 1)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

// One feeder at a time (launchd tick and a manual run share the state file).
export async function withFeederLock(fn, path = `${feederStatePath()}.lock`) {
  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) await rm(path, { force: true });
  } catch {}
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch {
    return { locked: true };
  }
  try {
    await handle.writeFile(String(process.pid));
    return { locked: false, value: await fn() };
  } finally {
    await handle.close();
    await rm(path, { force: true });
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

export function listIssues(owners) {
  return owners.flatMap(owner => ghJson([
    'search', 'issues', '--owner', owner, '--state', 'open', '--limit', '200',
    '--json', 'repository,number,title,body,labels',
  ]));
}

export function listPulls(owners) {
  const repos = new Set(owners.flatMap(owner => ghJson([
    'search', 'prs', '--owner', owner, '--state', 'open', '--limit', '200', '--json', 'repository',
  ]).map(pull => pull.repository?.nameWithOwner).filter(Boolean)));
  return [...repos].flatMap(repo => ghJson([
    'pr', 'list', '-R', repo, '--state', 'open', '--limit', '50',
    '--json', 'number,title,isDraft,headRefName,headRefOid,author',
  ]).map(pull => ({ ...pull, repository: { nameWithOwner: repo } })));
}

const TASK_QUERY = [
  'select t.id, t.title, t.description, p.github_repo',
  'from os_tasks t join os_projects p on p.id = t.project_id',
  "where t.status = 'todo' and coalesce(p.github_repo, '') <> ''",
  'order by t.created_at limit 100',
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

export function findPull(repo, branch) {
  return ghJson([
    'pr', 'list', '-R', repo, '--head', branch, '--state', 'all', '--limit', '1',
    '--json', 'number,state,isDraft,headRefOid,title,baseRefName',
  ])[0] ?? null;
}

export function listChecks(repo, number) {
  const result = run('gh', ['pr', 'checks', String(number), '-R', repo, '--json', 'name,state,bucket']);
  try {
    return JSON.parse(result.stdout || '[]');
  } catch {
    return [];
  }
}

// Cross-vendor review of the PR diff; returns APPROVE, REQUEST_CHANGES or null.
export async function reviewPull(repo, pull, cwd) {
  const scratch = await mkdtemp(join(tmpdir(), 'teamclaude-feed-review-'));
  try {
    const diff = run('gh', ['pr', 'diff', String(pull.number), '-R', repo]);
    if (diff.status !== 0 || !diff.stdout.trim()) return null;
    const diffPath = join(scratch, 'pr.diff');
    await writeFile(diffPath, diff.stdout);
    const result = run('bash', [
      join(homedir(), '.claude', 'scripts', 'codex-astra-review.sh'),
      '--diff', diffPath, '--label', `cloud-feed ${repo}#${pull.number}`,
    ], { cwd: cwd ?? dirname(diffPath), timeout: REVIEW_TIMEOUT_MS });
    const verdict = `${result.stdout}\n${result.stderr}`.match(/^VERDICT:\s*(APPROVE|REQUEST_CHANGES)\b/m);
    return verdict ? verdict[1] : null;
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
