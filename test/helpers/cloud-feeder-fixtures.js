import { FEED_DEFAULTS } from '../../src/cloud-feeder.js';

export const cfg = { ...FEED_DEFAULTS, enabled: true, expiresAt: '2026-11-05T07:59:00Z' };
export const NOW = new Date('2026-10-21T00:00:00Z');

export function feedDeps(overrides = {}) {
  const dispatched = [];
  return {
    dispatched,
    deps: {
      loadAccounts: async () => [{ name: 'a', type: 'oauth', accessToken: 'a', expiresAt: Date.now() + 3_600_000 }],
      creditLookup: async () => ({ remainingDollars: 3000 }),
      repoIndex: async () => new Map([['o/a', '/clone/a'], ['o/b', '/clone/b']]),
      listIssues: async () => [{ repository: { nameWithOwner: 'o/a' }, number: 1, title: 'i', body: '', labels: [], authorAssociation: 'OWNER' }],
      listTasks: async () => { throw new Error('ledger down'); },
      listPulls: async () => [],
      defaultBase: async () => 'origin/main',
      dispatch: async request => {
        dispatched.push(request);
        return { ok: true, exit: 0, branch: `teamclaude-handoff/${dispatched.length}`, url: 'u' };
      },
      saveState: async () => {},
      deleteRemoteBranch: () => true,
      ...overrides,
    },
  };
}
