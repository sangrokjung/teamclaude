// Proactive cloud dispatch: hand a self-contained task to a Claude Code cloud
// session on a pooled account that still has cloud credits, instead of
// running it locally on the (scarcer) weekly quota.
//
// Unlike the exhaustion handoff (cloud-handoff.js), nothing local is stopped:
// the caller simply asks "can this go to the cloud?" and gets one of three
// answers, as process exit codes for scripts and harness rules:
//   DISPATCHED (0) — a cloud session was created; do not also run it locally;
//   RUN_LOCAL  (3) — definitively not sent (no credit, repo not eligible,
//                    secret in the task, the launcher never started, ...);
//                    run the task locally;
//   AMBIGUOUS  (4) — the launcher ran but printed no session link, so a
//                    session may exist; check claude.ai before running the
//                    task locally.
// Only a printed session link proves a session exists: an exit status alone
// says nothing about what the server already created.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLOUD_ACCOUNT_LOOKUP_INCOMPLETE,
  appendCloudLedger,
  buildCloudEnv,
  defaultRunGit,
  fetchCloudCredits,
  findCloudAccount,
  handoffBranchName,
  hasFreshToken,
  inspectHandoffRepo,
  isExecutableFile,
  remoteUrlIsFixedPoint,
  pushHandoffSnapshot,
} from './cloud-handoff.js';
import { scanSnapshotForSecrets, textHasSecret } from './snapshot-scan.js';

export const DISPATCH_EXIT = Object.freeze({ DISPATCHED: 0, RUN_LOCAL: 3, AMBIGUOUS: 4 });
export const DISPATCH_TASK_MAX_BYTES = 32 * 1024;
export const DISPATCH_LAUNCH_TIMEOUT_MS = 5 * 60 * 1000;

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
// `<vendor> --cloud` reports a created session on its own lines (observed
// 2026-10-18, Claude Code 2.1.302):
//   View: https://claude.ai/code/session_<id>?from=cli&m=0
//   Resume with: claude --teleport session_<id>
// Only that exact, whole "Resume with" line counts; a link anywhere else
// (an error hint, an echoed task) proves nothing.
const RESUME_LINE_RE = /^Resume with: claude --teleport (session_[A-Za-z0-9]+)$/;
const SESSION_ID_RE = /session_[A-Za-z0-9]+/g;

// `--cloud` in a folder Claude Code has never trusted stops at the trust
// prompt (default "No, exit") and never prints a session link, so such a
// launch would only time out as AMBIGUOUS. Read-only check of Claude Code's
// own record for exactly this folder: inside a git repository Claude Code
// does not count trust given to folders above the repository root, so a
// trusted parent proves nothing here.
export async function isFolderTrusted(dir, {
  env = process.env,
  readText = path => readFile(path, 'utf8'),
  resolvePath = realpath,
} = {}) {
  let projects;
  try {
    const configDir = env.CLAUDE_CONFIG_DIR || homedir();
    projects = JSON.parse(await readText(join(configDir, '.claude.json')))?.projects;
  } catch {
    return false;
  }
  if (!projects || typeof projects !== 'object') return false;
  try {
    return projects[await resolvePath(dir)]?.hasTrustDialogAccepted === true;
  } catch {
    return false;
  }
}

export function buildDispatchPrompt({ branch, task, prTarget = null }) {
  const target = prTarget ? `\`${prTarget}\` 브랜치` : '기본 브랜치';
  return [
    '로컬 Claude Code 세션이 이 작업을 클라우드 세션에 맡깁니다.',
    `브랜치 ${branch}에서 시작해 작업하고, 같은 브랜치에 커밋·push한 뒤 ${target} 대상 PR을 여세요.`,
    'PR 본문에 무엇을 바꿨고 무엇을 어떻게 검증했는지 적으세요. 머지는 하지 마세요(로컬에서 교차 검증 뒤 머지합니다).',
    '',
    '작업:',
    task,
  ].join('\n');
}

// The created session's link, from the launcher's "Resume with" line, or
// null. Session ids that were already in what we sent (a terminal may echo
// the prompt) never count.
export function extractSessionUrl(output, { sent = '' } = {}) {
  if (typeof output !== 'string') return null;
  const echoed = new Set(String(sent).replace(ANSI_RE, '').match(SESSION_ID_RE) ?? []);
  const ids = output.replace(ANSI_RE, '')
    .split(/\r?\n|\r/)
    .map(line => line.trim().match(RESUME_LINE_RE)?.[1])
    .filter(id => id && !echoed.has(id));
  return ids.length > 0 ? `https://claude.ai/code/${ids[ids.length - 1]}` : null;
}

// `cloud-dispatch [--cwd DIR] [--dry-run] [--task-file FILE|-] [--] TASK`.
// The task comes from exactly one source; a flag missing its value, an
// unknown flag, or both a task file and task words is refused rather than
// guessed at (dropping half of what the caller wrote would be silent loss).
export function parseDispatchArgs(argv) {
  const bad = { reason: 'bad-arguments' };
  const parsed = { cwd: null, dryRun: false, taskFile: null, base: null, words: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      parsed.words.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--cwd' || arg === '--task-file' || arg === '--base') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value === '' || (value.startsWith('--') && value !== '-')) return bad;
      // Each takes one value; a repeat would silently replace the first.
      const key = { '--cwd': 'cwd', '--task-file': 'taskFile', '--base': 'base' }[arg];
      if (parsed[key] !== null) return bad;
      parsed[key] = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      return bad;
    } else {
      parsed.words.push(arg);
    }
  }
  if (parsed.taskFile !== null && parsed.words.length > 0) return bad;
  return parsed;
}

// A new task usually should not carry whatever happens to be uncommitted in
// the caller's checkout. With `--base <ref>` the cloud session starts from
// exactly that commit (e.g. origin/main): it is pushed as the dispatch branch
// after the same secret scan as a snapshot, and the working tree is ignored.
export async function pushBaseCommit({ root, ref, branch, remote = 'origin', runGit = defaultRunGit, gitEnv = process.env }) {
  if (typeof ref !== 'string' || ref.length === 0 || ref.startsWith('-')) return { ok: false, reason: 'base-not-found' };
  const resolved = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, env: gitEnv });
  const commit = resolved.status === 0 ? resolved.stdout.trim() : '';
  if (!/^[0-9a-f]{40,64}$/.test(commit)) return { ok: false, reason: 'base-not-found' };
  const scan = await scanSnapshotForSecrets({ root, commit, runGit, gitEnv, remote });
  if (!scan.ok) return { ok: false, reason: scan.reason };
  if (remote !== 'origin' && !(await remoteUrlIsFixedPoint({ root, url: remote, runGit, gitEnv }))) {
    return { ok: false, reason: 'origin-push-differs' };
  }
  const pushed = await runGit(
    // Only the one branch: no tags (push.followTags), no submodule pushes
    // (push.recurseSubmodules) — neither is covered by the scan.
    ['push', '--quiet', '--no-follow-tags', '--recurse-submodules=no', '--', remote, `${commit}:refs/heads/${branch}`],
    { cwd: root, env: gitEnv, timeoutMs: 120_000 },
  );
  if (pushed.status !== 0) return { ok: false, reason: 'push-failed' };
  return { ok: true, branch, commit };
}

// Reads at most DISPATCH_TASK_MAX_BYTES + 1 bytes from a file path or a
// stream (stdin), so an oversized or endless input is refused without being
// buffered whole. Returns { task } or { reason }.
export async function readTaskInput(source, { maxBytes = DISPATCH_TASK_MAX_BYTES } = {}) {
  const chunks = [];
  let total = 0;
  const take = chunk => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buffer);
    total += buffer.length;
    return total > maxBytes;
  };
  try {
    if (typeof source === 'string') {
      const handle = await open(source, 'r');
      try {
        const buffer = Buffer.alloc(maxBytes + 1);
        let filled = 0;
        while (filled < buffer.length) {
          const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        take(buffer.subarray(0, filled));
      } finally {
        await handle.close();
      }
    } else {
      for await (const chunk of source) {
        if (take(chunk)) {
          source.destroy?.();
          break;
        }
      }
    }
  } catch {
    return { reason: 'task-unreadable' };
  }
  if (total > maxBytes) return { reason: 'task-too-large' };
  // Strict: text in another encoding must not reach the cloud garbled.
  try {
    return { task: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) };
  } catch {
    return { reason: 'task-invalid-encoding' };
  }
}

// `--cloud` needs a TTY; `script` supplies one and records the terminal
// output to a private temp file, read back for the session link and removed.
export async function launchCloudCapturing({ vendorBin, args, env, cwd }) {
  const scratch = await mkdtemp(join(tmpdir(), 'teamclaude-dispatch-'));
  const outputPath = join(scratch, 'out');
  try {
    const result = spawnSync('script', ['-q', outputPath, vendorBin, ...args], {
      env,
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: DISPATCH_LAUNCH_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    });
    const output = await readFile(outputPath, 'utf8').catch(() => '');
    return { ...result, output };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function attemptCloudDispatch({
  task,
  cwd,
  baseEnv,
  vendorBin,
  binExists = isExecutableFile,
  runGit = defaultRunGit,
  gitEnv = process.env,
  loadAccounts,
  creditLookup = fetchCloudCredits,
  launchCloud = launchCloudCapturing,
  folderTrusted = isFolderTrusted,
  platform = process.platform,
  ledgerPath = null,
  dryRun = false,
  // null: snapshot HEAD plus uncommitted changes; a ref: start from exactly it.
  base = null,
  // Branch the PR should target (default: the repository's default branch).
  prTarget = null,
  now = new Date(),
  // `now` also fixes the branch name (it must match whatever the caller may
  // already have recorded before invoking this), so it can be stale by the
  // time a slow collection phase (listing repos, issues, PRs...) reaches this
  // call. Credential freshness must use the real clock at THIS moment, not
  // that frozen value, or an account whose token expired while we were busy
  // collecting work would still look eligible. Defaults to `now` so other
  // callers that pass a live clock keep working unchanged.
  eligibilityNow = now,
  // Re-checked again right before the actual launcher call: `eligibilityNow`
  // only proves freshness at account-selection time, but the snapshot push
  // (git network I/O, up to 120s) can still let the token lapse before
  // launchCloud is invoked. A function, not a value, so each call sees a fresh
  // clock even though dispatch is async. Defaults to `eligibilityNow` (no
  // additional drift assumed) so a caller that injects only `eligibilityNow`
  // keeps its existing behavior; a real caller should pass `() => Date.now()`.
  liveNow = () => eligibilityNow.getTime(),
  // A caller's own hard deadline (e.g. the credit feeder's cfg.expiresAt), as
  // an epoch ms number. Re-checked against `liveNow()` right before launch,
  // alongside the account's own token freshness. null/omitted: no such limit.
  programDeadline = null,
  random = Math.random,
  newId = randomUUID,
  creditLookupOptions = {},
}) {
  const local = reason => ({ ok: false, exit: DISPATCH_EXIT.RUN_LOCAL, reason });
  // Snapshot, scan and push all read stored objects, never `git replace`
  // substitutes (push would send the originals).
  gitEnv = { ...gitEnv, GIT_NO_REPLACE_OBJECTS: '1' };
  if (typeof task !== 'string' || task.trim().length === 0) return local('task-empty');
  if (Buffer.byteLength(task, 'utf8') > DISPATCH_TASK_MAX_BYTES) return local('task-too-large');
  // A NUL cannot travel in a process argument; the launch would only throw.
  if (task.includes('\0')) return local('task-invalid-content');
  if (textHasSecret(task)) return local('task-has-secret');
  // The launcher drives `script` with BSD (macOS) arguments; refuse elsewhere
  // before anything is pushed.
  if (platform !== 'darwin') return local('platform-unsupported');
  if (!(await binExists(vendorBin))) return local('vendor-missing');
  const repo = await inspectHandoffRepo({ cwd, runGit, gitEnv });
  if (!repo.ok) return local(repo.reason);
  if (!(await folderTrusted(repo.root))) return local('folder-not-trusted');

  let accounts = null;
  try {
    accounts = typeof loadAccounts === 'function' ? await loadAccounts() : null;
  } catch {}
  // An operator-disabled account is out of use, its cloud credits included.
  if (Array.isArray(accounts)) accounts = accounts.filter(account => account?.enabled !== false);
  const account = await findCloudAccount({
    accounts,
    creditLookup,
    now: eligibilityNow.getTime(),
    random,
    ...creditLookupOptions,
  });
  if (account === CLOUD_ACCOUNT_LOOKUP_INCOMPLETE) return local('credit-lookup-incomplete');
  if (!account) return local('no-credit-account');
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      exit: DISPATCH_EXIT.DISPATCHED,
      account: account.name,
      remainingDollars: account.remainingDollars,
    };
  }

  const dispatchId = newId();
  const snapshot = base === null
    ? await pushHandoffSnapshot({
      root: repo.root,
      head: repo.head,
      remote: repo.remoteUrl,
      sessionId: dispatchId,
      runGit,
      gitEnv,
      now,
    })
    : await pushBaseCommit({
      root: repo.root,
      ref: base,
      branch: handoffBranchName(dispatchId, now),
      remote: repo.remoteUrl,
      runGit,
      gitEnv,
    });
  if (!snapshot.ok) return local(snapshot.reason);

  // A rejection past this point still leaves the just-pushed branch behind
  // with no cloud session ever started to use it. Best-effort delete it
  // (nothing else can ever reference it, so there is nothing to lose), and
  // report its name regardless of whether the delete itself succeeds — a
  // RUN_LOCAL caller must still be able to find/clean it up if the delete
  // push fails too, instead of an untracked branch silently accumulating on
  // every retry.
  const abortAfterPush = async reason => {
    await runGit(
      ['push', '--quiet', '--', repo.remoteUrl, `:refs/heads/${snapshot.branch}`],
      { cwd: repo.root, env: gitEnv, timeoutMs: 30_000 },
    ).catch(() => {});
    return { ...local(reason), branch: snapshot.branch };
  };

  // Re-verify against the live clock now that the snapshot push has spent
  // however long it spent. `account.expiresAt` is the exact credential
  // findCloudAccount already resolved — checked directly, never by re-finding
  // the account in `accounts` by name/uuid (every such re-find kept being a
  // fresh source of account-identity bugs: a same-name pair, a uuid present
  // on only one side, array order...). Nothing has been launched yet, so a
  // failure here is safely retryable (RUN_LOCAL), unlike an uncertain
  // post-launch result (AMBIGUOUS).
  if (!hasFreshToken(account.expiresAt, liveNow())) {
    return abortAfterPush('token-expired-before-launch');
  }
  // Likewise the caller's own program deadline (e.g. the credit feeder's
  // cfg.expiresAt), re-checked at the same late point rather than only once
  // long before this push started.
  if (Number.isFinite(programDeadline) && !(liveNow() < programDeadline)) {
    return abortAfterPush('program-expired-before-launch');
  }

  const prompt = buildDispatchPrompt({ branch: snapshot.branch, task, prTarget });
  let result = null;
  try {
    result = await launchCloud({
      vendorBin,
      args: ['--cloud', prompt],
      env: buildCloudEnv(baseEnv, account.accessToken),
      cwd: repo.root,
    });
  } catch {
    result = null;
  }
  const url = extractSessionUrl(result?.output, { sent: prompt });
  const neverSpawned = Boolean(result?.error
    && (result.error.code === 'ENOENT' || result.error.code === 'EACCES')
    && !result.pid);
  if (url === null) {
    if (neverSpawned) return local('launch-failed');
    return { ok: false, exit: DISPATCH_EXIT.AMBIGUOUS, reason: 'launch-uncertain', branch: snapshot.branch };
  }
  let ledgerRecorded = false;
  if (ledgerPath) {
    try {
      await appendCloudLedger(ledgerPath, {
        source: 'dispatch',
        ts: now.toISOString(),
        sessionId: dispatchId,
        account: account.name,
        branch: snapshot.branch,
        cwd: repo.root,
        url,
      });
      ledgerRecorded = true;
    } catch {}
  }
  return {
    ok: true,
    exit: DISPATCH_EXIT.DISPATCHED,
    account: account.name,
    branch: snapshot.branch,
    url,
    ledgerRecorded,
  };
}
