// Real side effects for the cloud feeder (src/cloud-feeder.js): gh, the TDL
// ledger query, local clone discovery, git, the state file and its lock.

import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { open, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isFolderTrusted } from './cloud-dispatch.js';
import { githubRepoOf } from './cloud-feeder.js';

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

// Every page of a REST list, one page (100 items) at a time, so a large
// repository is neither capped nor limited by one huge response buffer.
// `keep` filters each page as it arrives.
function restAll(path, keep = () => true) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const items = ghJson(['api', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`]);
    if (!Array.isArray(items)) throw new Error('unexpected list response');
    out.push(...items.filter(keep));
    if (items.length < 100) return out;
  }
}

// Runs `fn` per repository; one repository's failure is logged and skipped,
// the others' results are kept.
function perRepo(repos, what, fn, log) {
  const out = [];
  for (const repo of repos) {
    try {
      out.push(...fn(repo));
    } catch (error) {
      log?.(`[cloud-feed] ${what} for ${repo} failed: ${error?.message ?? error}`);
    }
  }
  return out;
}

// Open issues (not PRs) of the given repositories, completely.
export function listIssues(repos, log) {
  return perRepo(repos, 'issues', repo => restAll(`repos/${repo}/issues?state=open`, issue => !issue.pull_request)
    .map(issue => ({
      repository: { nameWithOwner: repo },
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      authorAssociation: issue.author_association,
    })), log);
}

// Open PRs of the given repositories, completely, with head and trust fields.
export function listPulls(repos, log) {
  return perRepo(repos, 'pulls', repo => restAll(`repos/${repo}/pulls?state=open`)
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
    })), log);
}

// Read-only ledger query through the guarded CLI, keyset-paged on
// (created_at, id) until exhausted, so no task is ever beyond a cap.
export function listTasks() {
  const all = [];
  let cursor = null;
  for (;;) {
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
    const next = { createdAt: last.created_at, id: last.id };
    // Keyset order is strict, so the cursor must move; if not, stop safely.
    if (cursor && `${next.createdAt}|${next.id}` <= `${cursor.createdAt}|${cursor.id}`) throw new Error('task cursor did not advance');
    cursor = next;
  }
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
    '--json', 'number,state,isDraft,headRefOid,headRefName,isCrossRepository,title,baseRefName,url',
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
