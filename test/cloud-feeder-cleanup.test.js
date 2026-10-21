// Orphaned handoff-branch cleanup: durable tracking of a branch a pre-launch
// rejection couldn't delete itself, and the sweep that keeps retrying it.
// Split out of cloud-feeder.test.js to keep that file under the 800-line
// guideline; this sub-feature's tests share no state with the rest of it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runFeed } from '../src/cloud-feeder.js';
import { NOW, cfg, feedDeps } from './helpers/cloud-feeder-fixtures.js';

test('a branch whose inline delete failed goes on a durable cleanup list, separate from the per-task record', async () => {
  const deleteCalls = [];
  const { deps } = feedDeps({
    dispatch: async () => ({
      ok: false, exit: 3, reason: 'token-expired-before-launch',
      branch: 'teamclaude-handoff/x', branchDeleted: false, remoteUrl: 'https://github.com/o/a.git',
    }),
    deleteRemoteBranch: (cwd, branch, remoteUrl) => { deleteCalls.push({ cwd, branch, remoteUrl }); return false; },
  });
  const result = await runFeed({ cfg: { ...cfg, owners: ['o'] }, now: NOW, state: { sent: {} }, dryRun: false, deps });
  assert.deepEqual(result.state.pendingCleanup, [
    { repo: 'o/a', branch: 'teamclaude-handoff/x', remoteUrl: 'https://github.com/o/a.git', ts: NOW.toISOString() },
  ]);
  // The per-task record only keeps the latest outcome for that key — this is
  // exactly the forgetting that makes the separate durable list necessary.
  assert.ok(Object.values(result.state.sent).some(e => e.branch === 'teamclaude-handoff/x'));
  // Nothing was pending BEFORE this tick, so the sweep had nothing to do —
  // the failed delete above was cloud-dispatch's own inline attempt (stubbed
  // here via `dispatch`), not something runFeed's sweep should have touched.
  assert.deepEqual(deleteCalls, []);
});

test('a pending cleanup entry is swept and retried every tick: removed once deleted, kept while it keeps failing, by the exact remote it was pushed to', async () => {
  const deleteCalls = [];
  const state = {
    sent: {},
    pendingCleanup: [
      { repo: 'o/a', branch: 'stale-1', remoteUrl: 'https://github.com/o/a.git', ts: NOW.toISOString() },
      { repo: 'o/b', branch: 'stale-2', remoteUrl: 'https://github.com/o/b.git', ts: NOW.toISOString() },
    ],
  };
  // Dry runs must never touch the remote at all.
  {
    const { deps } = feedDeps({ deleteRemoteBranch: (cwd, branch, remoteUrl) => { deleteCalls.push({ branch, remoteUrl }); return true; } });
    await runFeed({ cfg: { ...cfg, owners: ['o'] }, now: NOW, state, max: 0, dryRun: true, deps });
    assert.deepEqual(deleteCalls, []);
  }
  // o/a's stale-1 deletes successfully; o/b's stale-2 keeps failing.
  const { deps } = feedDeps({
    deleteRemoteBranch: (cwd, branch, remoteUrl) => { deleteCalls.push({ branch, remoteUrl }); return branch === 'stale-1'; },
  });
  const result = await runFeed({ cfg: { ...cfg, owners: ['o'] }, now: NOW, state, dryRun: false, deps });
  assert.deepEqual(deleteCalls, [
    { branch: 'stale-1', remoteUrl: 'https://github.com/o/a.git' },
    { branch: 'stale-2', remoteUrl: 'https://github.com/o/b.git' },
  ]);
  assert.deepEqual(result.state.pendingCleanup, [{ repo: 'o/b', branch: 'stale-2', remoteUrl: 'https://github.com/o/b.git', ts: NOW.toISOString() }]);
});

test('pending cleanup is retried even when the feeder is disabled, out of credit, or simply paced', async () => {
  const pendingCleanup = [{ repo: 'o/a', branch: 'stale-1', remoteUrl: 'https://github.com/o/a.git', ts: NOW.toISOString() }];
  const cases = [
    { label: 'disabled', cfgOverrides: { enabled: false }, depsOverrides: {} },
    { label: 'no credit info', cfgOverrides: {}, depsOverrides: { loadAccounts: async () => [] } },
    { label: 'fully paced', cfgOverrides: { perRun: 0 }, depsOverrides: {} },
  ];
  for (const { label, cfgOverrides, depsOverrides } of cases) {
    const deleteCalls = [];
    const { deps } = feedDeps({
      deleteRemoteBranch: (cwd, branch) => { deleteCalls.push(branch); return true; },
      ...depsOverrides,
    });
    const state = { sent: {}, pendingCleanup: [...pendingCleanup] };
    const result = await runFeed({ cfg: { ...cfg, owners: ['o'], ...cfgOverrides }, now: NOW, state, dryRun: false, deps });
    assert.deepEqual(deleteCalls, ['stale-1'], `${label}: cleanup must still run`);
    assert.deepEqual(result.state.pendingCleanup, [], `${label}: a successful cleanup must still be recorded`);
  }
});

test('a pending cleanup with a verified remoteUrl falls back to any other available clone when its own repo key is gone from the index', async () => {
  // repoIndex no longer lists 'o/stale-repo' at all (its clone's origin
  // drifted to something else, or it was re-cloned under a different key) —
  // but the cleanup's destination is the verified remoteUrl, not whatever
  // 'o/stale-repo' currently maps to, so any other local clone works fine as
  // the scratch directory to run the delete from.
  const deleteCalls = [];
  const { deps } = feedDeps({
    repoIndex: async () => new Map([['o/other', '/clone/other']]),
    deleteRemoteBranch: (cwd, branch, remoteUrl) => { deleteCalls.push({ cwd, branch, remoteUrl }); return true; },
  });
  const state = { sent: {}, pendingCleanup: [{ repo: 'o/stale-repo', branch: 'stale-1', remoteUrl: 'https://github.com/o/stale-repo.git', ts: NOW.toISOString() }] };
  const result = await runFeed({ cfg: { ...cfg, owners: ['o'] }, now: NOW, state, dryRun: false, deps });
  assert.deepEqual(deleteCalls, [{ cwd: '/clone/other', branch: 'stale-1', remoteUrl: 'https://github.com/o/stale-repo.git' }]);
  assert.deepEqual(result.state.pendingCleanup, []);
});

test('a legacy pending entry with no remoteUrl never falls back to another clone (its repo key IS the destination)', async () => {
  const deleteCalls = [];
  const { deps } = feedDeps({
    repoIndex: async () => new Map([['o/other', '/clone/other']]),
    deleteRemoteBranch: (cwd, branch) => { deleteCalls.push({ cwd, branch }); return true; },
  });
  const state = { sent: {}, pendingCleanup: [{ repo: 'o/stale-repo', branch: 'stale-1', ts: NOW.toISOString() }] };
  const result = await runFeed({ cfg: { ...cfg, owners: ['o'] }, now: NOW, state, dryRun: false, deps });
  assert.deepEqual(deleteCalls, []);
  assert.deepEqual(result.state.pendingCleanup, state.pendingCleanup);
});
