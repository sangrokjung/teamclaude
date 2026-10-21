// Real side effects for the cloud feeder (src/cloud-feeder.js): gh, the TDL
// ledger query, local clone discovery, git, the state file and its lock.

import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
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
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!plain(state) || !plain(state.sent)) throw new Error('corrupt feeder state');
  const nonEmpty = value => typeof value === 'string' && value.length > 0;
  for (const entry of Object.values(state.sent)) {
    const ok = plain(entry)
      && [0, 3, 4].includes(entry.exit)
      && Number.isFinite(Date.parse(entry.ts))
      && nonEmpty(entry.repo)
      // A sent entry is only useful (and only skipped) with the branch to follow.
      && (entry.exit !== 0 || (nonEmpty(entry.branch) && (entry.merge == null || nonEmpty(entry.merge))));
    if (!ok) throw new Error('corrupt feeder state entry');
  }
  return state;
}

export async function writeFeederState(state, path = feederStatePath()) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 1)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

// macOS open(2) O_EXLOCK: an exclusive flock taken atomically with the open
// and released by the kernel when the descriptor closes or the process dies,
// so there is no stale lock to take over and no takeover race.
const O_EXLOCK = 0x20;

// One feeder at a time (launchd tick and a manual run share the state file).
export async function withFeederLock(fn, path = `${feederStatePath()}.lock`) {
  if (process.platform !== 'darwin') return { locked: true };
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NONBLOCK | O_EXLOCK, 0o600);
  } catch (error) {
    if (error?.code === 'EAGAIN' || error?.code === 'EWOULDBLOCK') return { locked: true };
    throw error;
  }
  try {
    return { locked: false, value: await fn() };
  } finally {
    await handle.close();
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

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every page of a REST list (gh --paginate --slurp), so nothing is capped.
function restAll(path) {
  const pages = ghJson(['api', '--paginate', '--slurp', path]);
  return Array.isArray(pages) ? pages.flat() : [];
}

// Open issues (not PRs) of the given repositories, completely.
export function listIssues(repos) {
  return repos.flatMap(repo => restAll(`repos/${repo}/issues?state=open&per_page=100`)
    .filter(issue => !issue.pull_request)
    .map(issue => ({
      repository: { nameWithOwner: repo },
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      authorAssociation: issue.author_association,
    })));
}

// Open PRs of the given repositories, completely, with head and trust fields.
export function listPulls(repos) {
  return repos.flatMap(repo => restAll(`repos/${repo}/pulls?state=open&per_page=100`)
    .map(pull => ({
      repository: { nameWithOwner: repo },
      number: pull.number,
      title: pull.title,
      isDraft: pull.draft === true,
      author: { login: pull.user?.login },
      authorAssociation: pull.author_association,
      headRefName: pull.head?.ref,
      headRefOid: pull.head?.sha,
      isCrossRepository: String(pull.head?.repo?.full_name ?? '').toLowerCase() !== repo,
    })));
}

// Read-only ledger query through the guarded CLI, keyset-paged on
// (created_at, id) until exhausted, so no task is ever beyond a cap.
export function listTasks() {
  const all = [];
  let cursor = null;
  for (let page = 0; page < 50; page += 1) {
    const after = cursor ? `and (t.created_at, t.id) > ('${cursor.createdAt}'::timestamptz, '${cursor.id}'::uuid)` : '';
    const query = [
      "select t.id, t.title, t.description, p.github_repo,",
      "to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as created_at",
      'from os_tasks t join os_projects p on p.id = t.project_id',
      "where t.status = 'todo' and coalesce(p.github_repo, '') <> ''",
      after,
      `order by t.created_at, t.id limit ${LIST_LIMIT}`,
    ].join(' ');
    const result = run(join(homedir(), '.claude', 'bin', 'sb-sql'), ['--project', 'internal', query]);
    if (result.status !== 0) throw new Error('task query failed');
    const rows = JSON.parse(result.stdout).rows ?? [];
    all.push(...rows);
    if (rows.length < LIST_LIMIT) return all;
    const last = rows[rows.length - 1];
    if (!ISO_RE.test(last.created_at ?? '') || !UUID_RE.test(last.id ?? '')) throw new Error('task cursor invalid');
    cursor = { createdAt: last.created_at, id: last.id };
  }
  throw new Error('task list did not end');
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

// After a fetch: `wanted` (an origin/<branch> ref) when it exists, else
// origin/<default branch>; null when neither resolves.
export function defaultBase(cwd, wanted = null) {
  if (run('git', ['-C', cwd, 'fetch', '-q', 'origin'], { timeout: 120_000 }).status !== 0) return null;
  if (wanted) {
    if (!/^origin\/[A-Za-z0-9._/-]+$/.test(wanted)) return null;
    return run('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', `${wanted}^{commit}`]).status === 0 ? wanted : null;
  }
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
    '--json', 'number,state,isDraft,headRefOid,headRefName,isCrossRepository,title,baseRefName,baseRefOid',
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

// Cross-vendor review of the PR diff with the PR's CI results as evidence;
// returns APPROVE, REQUEST_CHANGES or null.
export async function reviewPull(repo, pull, cwd, checks = []) {
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
    const evidencePath = join(scratch, 'ci.txt');
    await writeFile(evidencePath, [
      `CI checks reported by GitHub for PR #${pull.number} at head ${pull.headRefOid}:`,
      ...checks.map(check => `- ${check.name}: ${check.bucket ?? check.state}`),
    ].join('\n'));
    const result = run('bash', [
      join(homedir(), '.claude', 'scripts', 'codex-astra-review.sh'),
      '--diff', diffPath, '--evidence', evidencePath, '--label', `cloud-feed ${repo}#${pull.number}`,
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

// Whether the PR head already contains the current base tip, so the CI that
// ran on the head also covers what the merge will produce. null = unknown.
export function headContainsBase(repo, pull) {
  try {
    const compare = ghJson(['api', `repos/${repo}/compare/${pull.baseRefOid}...${pull.headRefOid}`, '--jq', '{behind_by}']);
    return Number.isInteger(compare.behind_by) ? compare.behind_by === 0 : null;
  } catch {
    return null;
  }
}

// Brings a behind PR branch up to date with its base (a new head; CI reruns).
export function updateBranch(repo, pull) {
  return run('gh', ['pr', 'update-branch', String(pull.number), '-R', repo]).status === 0;
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
