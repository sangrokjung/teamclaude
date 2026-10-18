// Proactive cloud dispatch: hand a self-contained task to a Claude Code cloud
// session on a pooled account that still has cloud credits, instead of
// running it locally on the (scarcer) weekly quota.
//
// Unlike the exhaustion handoff (cloud-handoff.js), nothing local is stopped:
// the caller simply asks "can this go to the cloud?" and gets one of three
// answers, as process exit codes for scripts and harness rules:
//   DISPATCHED (0) — a cloud session was created; do not also run it locally;
//   RUN_LOCAL  (3) — definitively not sent (no credit, repo not eligible,
//                    secret in the task, ...); run the task locally;
//   AMBIGUOUS  (4) — the launch may have created a session; check claude.ai
//                    before running the task locally.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLOUD_ACCOUNT_LOOKUP_INCOMPLETE,
  appendCloudLedger,
  buildCloudEnv,
  defaultRunGit,
  fetchCloudCredits,
  findCloudAccount,
  inspectHandoffRepo,
  isExecutableFile,
  pushHandoffSnapshot,
} from './cloud-handoff.js';
import { textHasSecret } from './snapshot-scan.js';

export const DISPATCH_EXIT = Object.freeze({ DISPATCHED: 0, RUN_LOCAL: 3, AMBIGUOUS: 4 });
export const DISPATCH_TASK_MAX_BYTES = 32 * 1024;
export const DISPATCH_LAUNCH_TIMEOUT_MS = 5 * 60 * 1000;

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const SESSION_URL_RE = /https:\/\/claude\.ai\/code\/[A-Za-z0-9_\-/]+/;

export function buildDispatchPrompt({ branch, task }) {
  return [
    '로컬 Claude Code 세션이 이 작업을 클라우드 세션에 맡깁니다.',
    `브랜치 ${branch}에서 시작해 작업하고, 같은 브랜치에 커밋·push한 뒤 기본 브랜치 대상 PR을 여세요.`,
    'PR 본문에 무엇을 바꿨고 무엇을 어떻게 검증했는지 적으세요. 머지는 하지 마세요(로컬에서 교차 검증 뒤 머지합니다).',
    '',
    '작업:',
    task,
  ].join('\n');
}

// The cloud session link printed by `<vendor> --cloud`, if any.
export function extractSessionUrl(output) {
  if (typeof output !== 'string') return null;
  const match = output.replace(ANSI_RE, '').match(SESSION_URL_RE);
  return match ? match[0] : null;
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
  ledgerPath = null,
  dryRun = false,
  now = new Date(),
  random = Math.random,
  newId = randomUUID,
  creditLookupOptions = {},
}) {
  const local = reason => ({ ok: false, exit: DISPATCH_EXIT.RUN_LOCAL, reason });
  if (typeof task !== 'string' || task.trim().length === 0) return local('task-empty');
  if (Buffer.byteLength(task, 'utf8') > DISPATCH_TASK_MAX_BYTES) return local('task-too-large');
  if (textHasSecret(task)) return local('task-has-secret');
  if (!(await binExists(vendorBin))) return local('vendor-missing');
  const repo = await inspectHandoffRepo({ cwd, runGit, gitEnv });
  if (!repo.ok) return local(repo.reason);

  let accounts = null;
  try {
    accounts = typeof loadAccounts === 'function' ? await loadAccounts() : null;
  } catch {}
  const account = await findCloudAccount({
    accounts,
    creditLookup,
    now: now.getTime(),
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
  const snapshot = await pushHandoffSnapshot({
    root: repo.root,
    head: repo.head,
    sessionId: dispatchId,
    runGit,
    gitEnv,
    now,
  });
  if (!snapshot.ok) return local(snapshot.reason);

  let result = null;
  try {
    result = await launchCloud({
      vendorBin,
      args: ['--cloud', buildDispatchPrompt({ branch: snapshot.branch, task })],
      env: buildCloudEnv(baseEnv, account.accessToken),
      cwd: repo.root,
    });
  } catch {
    result = null;
  }
  const url = extractSessionUrl(result?.output);
  const neverSpawned = Boolean(result?.error
    && (result.error.code === 'ENOENT' || result.error.code === 'EACCES')
    && !result.pid);
  const exitedCleanly = Boolean(result
    && !result.error
    && result.signal == null
    && typeof result.status === 'number');
  const dispatched = exitedCleanly && (result.status === 0 || url !== null);
  if (!dispatched) {
    // A clean failing exit with no session link, or a spawn that never
    // happened, created nothing; a kill, timeout or unreadable result might
    // have.
    if (neverSpawned || exitedCleanly) return local('launch-failed');
    return { ok: false, exit: DISPATCH_EXIT.AMBIGUOUS, reason: 'launch-uncertain', branch: snapshot.branch };
  }
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
    } catch {}
  }
  return {
    ok: true,
    exit: DISPATCH_EXIT.DISPATCHED,
    account: account.name,
    branch: snapshot.branch,
    url,
  };
}
