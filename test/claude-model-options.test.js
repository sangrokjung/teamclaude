import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOOTSTRAP_URL,
  MODEL_OPTIONS_REFRESH_MS,
  acquireConfigLock,
  claudeGlobalConfigPath,
  fetchBootstrapModelFields,
  modelFieldsFromBootstrap,
  persistModelFields,
  pickBootstrapAccount,
  refreshClaudeModelOptions,
} from '../src/claude-model-options.js';

const NOW = 1_800_000_000_000;
const STALE_OPTION = {
  value: 'claude-fable-5-1[1m]',
  label: 'Fable',
  description: 'Fable 5.1 · Most capable',
};

function account(overrides = {}) {
  return {
    name: 'a',
    accountUuid: 'uuid-a',
    provider: 'anthropic',
    type: 'oauth',
    accessToken: 'token-a',
    expiresAt: NOW + 3_600_000,
    ...overrides,
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

async function tempHome(t, config) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-model-options-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, '.claude.json');
  if (config !== undefined) await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  return { dir, path };
}

test('claudeGlobalConfigPath honors CLAUDE_CONFIG_DIR like Claude Code', () => {
  assert.equal(claudeGlobalConfigPath({}, '/home/u'), join('/home/u', '.claude.json'));
  assert.equal(claudeGlobalConfigPath({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/u'), join('/cfg', '.claude.json'));
});

test('pickBootstrapAccount prefers the seeded account and skips unusable ones', () => {
  const accounts = [
    account({ accountUuid: 'expired', accessToken: 'x', expiresAt: NOW + 1000 }),
    account({ accountUuid: 'disabled', enabled: false }),
    account({ accountUuid: 'blocked', subscriptionDisabled: true }),
    account({ accountUuid: 'apikey', type: 'apikey' }),
    account({ accountUuid: 'codex', provider: 'codex' }),
    account({ accountUuid: 'no-token', accessToken: null }),
    account({ accountUuid: 'first', accessToken: 'token-first', provider: undefined }),
    account({ accountUuid: 'seeded', accessToken: 'token-seeded', expiresAt: (NOW + 3_600_000) / 1000 }),
  ];
  assert.deepEqual(
    [pickBootstrapAccount(accounts, 'seeded', NOW)].map(p => [p.account.accountUuid, p.token]),
    [['seeded', 'token-seeded']],
  );
  assert.equal(pickBootstrapAccount(accounts, 'disabled', NOW).account.accountUuid, 'first');
  assert.equal(pickBootstrapAccount(accounts, null, NOW).token, 'token-first');
  // In-memory AccountManager entries call the token `credential`.
  const live = { ...account(), accessToken: undefined, credential: 'live-token' };
  assert.equal(pickBootstrapAccount([live], null, NOW).token, 'live-token');
  assert.equal(pickBootstrapAccount([accounts[0], accounts[1]], null, NOW), null);
  assert.equal(pickBootstrapAccount(undefined, null, NOW), null);
});

test('fetchBootstrapModelFields sends the OAuth bootstrap request and maps null to empty', async () => {
  let seen;
  const fields = await fetchBootstrapModelFields('tok', {
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return jsonResponse(200, {
        additional_model_options: null,
        additional_model_costs: null,
        model_access: null,
        org_model_default: null,
      });
    },
  });
  assert.equal(seen.url, BOOTSTRAP_URL);
  assert.equal(seen.init.headers.Authorization, 'Bearer tok');
  assert.equal(seen.init.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.deepEqual(fields, {
    additionalModelOptionsCache: [],
    additionalModelCostsCache: {},
    modelAccessCache: [],
    orgModelDefaultCache: null,
  });
});

test('fetchBootstrapModelFields keeps server-provided options and rejects bad answers', async () => {
  const option = { value: 'claude-fable-6', label: 'Fable', description: 'Fable 6' };
  const fields = await fetchBootstrapModelFields('tok', {
    fetchImpl: async () => jsonResponse(200, { additional_model_options: [option] }),
  });
  assert.deepEqual(fields.additionalModelOptionsCache, [option]);
  assert.equal(await fetchBootstrapModelFields('tok', {
    fetchImpl: async () => jsonResponse(401, {}),
  }), null);
  assert.equal(await fetchBootstrapModelFields('tok', {
    fetchImpl: async () => jsonResponse(200, { additional_model_options: 'nope' }),
  }), null);
  assert.equal(await fetchBootstrapModelFields('tok', {
    fetchImpl: async () => jsonResponse(200, [1, 2]),
  }), null);
});

test('refreshClaudeModelOptions replaces a stale Fable entry and keeps every other key', async t => {
  const { dir, path } = await tempHome(t, {
    numStartups: 7,
    oauthAccount: { emailAddress: 'kept' },
    additionalModelOptionsCache: [STALE_OPTION],
    additionalModelOptionsAnsweredAt: NOW - 6 * 24 * 3_600_000,
  });
  const result = await refreshClaudeModelOptions({
    loadAccounts: async () => [account()],
    preferredUuid: 'uuid-a',
    env: {},
    home: dir,
    now: NOW,
    fetchImpl: async () => jsonResponse(200, { additional_model_options: null }),
  });
  assert.equal(result, 'updated');
  const after = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(after.additionalModelOptionsCache, []);
  assert.equal(after.additionalModelOptionsAnsweredAt, NOW);
  assert.equal(after.numStartups, 7);
  assert.deepEqual(after.oauthAccount, { emailAddress: 'kept' });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('refreshClaudeModelOptions skips the network while the cache is fresh', async t => {
  const { dir } = await tempHome(t, {
    additionalModelOptionsCache: [],
    additionalModelOptionsAnsweredAt: NOW - MODEL_OPTIONS_REFRESH_MS + 1000,
  });
  let calls = 0;
  const result = await refreshClaudeModelOptions({
    loadAccounts: async () => [account()],
    env: {},
    home: dir,
    now: NOW,
    fetchImpl: async () => { calls += 1; return jsonResponse(200, {}); },
  });
  assert.equal(result, 'fresh');
  assert.equal(calls, 0);
});

test('refreshClaudeModelOptions never touches the file when the fetch fails', async t => {
  const original = { additionalModelOptionsCache: [STALE_OPTION], additionalModelOptionsAnsweredAt: 1 };
  const { dir, path } = await tempHome(t, original);
  const before = await readFile(path, 'utf8');
  for (const fetchImpl of [
    async () => jsonResponse(500, {}),
    async () => { throw new Error('offline'); },
  ]) {
    const result = await refreshClaudeModelOptions({
      loadAccounts: async () => [account()], env: {}, home: dir, now: NOW, fetchImpl,
    });
    assert.ok(['fetch-failed', 'error'].includes(result), result);
    assert.equal(await readFile(path, 'utf8'), before);
  }
  assert.equal(await refreshClaudeModelOptions({
    loadAccounts: async () => [], env: {}, home: dir, now: NOW, accountWaitMs: 0,
    fetchImpl: async () => jsonResponse(200, {}),
  }), 'no-account');
});

test('persistModelFields leaves missing or corrupt configs alone', async t => {
  const { dir, path } = await tempHome(t);
  assert.equal(await persistModelFields(join(dir, '.claude.json'), { additionalModelOptionsCache: [] }, { now: NOW }), 'missing');
  await writeFile(path, '{"half": ');
  assert.equal(await persistModelFields(path, { additionalModelOptionsCache: [] }, { now: NOW }), 'unparseable');
  assert.equal(await readFile(path, 'utf8'), '{"half": ');
});

test('persistModelFields abandons the write when another writer changed the file', async t => {
  const { dir, path } = await tempHome(t, { additionalModelOptionsCache: [STALE_OPTION] });
  const snapshot = await stat(path);
  // A concurrent Claude Code write lands between our read and our rename.
  const result = await persistModelFields(path, { additionalModelOptionsCache: [] }, {
    now: NOW,
    beforeCommit: async () => {
      await writeFile(path, JSON.stringify({ other: 'writer', additionalModelOptionsCache: [STALE_OPTION] }));
      await utimes(path, new Date(), new Date(snapshot.mtimeMs + 5000));
    },
  });
  assert.equal(result, 'raced');
  const content = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(content.other, 'writer');
  assert.deepEqual((await readdir(dir)).filter(name => name.includes('.tmp.') || name.endsWith('.lock')), []);
});

test('persistModelFields removes its temp file and lock when the commit step fails', async t => {
  const { dir, path } = await tempHome(t, { additionalModelOptionsCache: [STALE_OPTION] });
  const before = await readFile(path, 'utf8');
  await assert.rejects(persistModelFields(path, { additionalModelOptionsCache: [] }, {
    now: NOW,
    beforeCommit: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
  }), /disk full/);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual((await readdir(dir)).filter(name => name !== '.claude.json'), []);
});

test('persistModelFields holds Claude Code\'s config lock for the whole read-modify-write', async t => {
  const { dir, path } = await tempHome(t, { additionalModelOptionsCache: [STALE_OPTION] });
  let lockSeen = false;
  let rivalBlocked = false;
  const result = await persistModelFields(path, { additionalModelOptionsCache: [] }, {
    now: NOW,
    beforeCommit: async () => {
      lockSeen = (await readdir(dir)).includes('.claude.json.lock');
      // A Claude Code writer (proper-lockfile mkdir) cannot get in meanwhile.
      try {
        await mkdir(`${path}.lock`);
      } catch (err) {
        rivalBlocked = err.code === 'EEXIST';
      }
    },
  });
  assert.equal(result, 'updated');
  assert.equal(lockSeen, true);
  assert.equal(rivalBlocked, true);
  assert.equal((await readdir(dir)).includes('.claude.json.lock'), false);
});

test('persistModelFields waits for, and never steals, a lock held by Claude Code', async t => {
  const { path } = await tempHome(t, { additionalModelOptionsCache: [STALE_OPTION] });
  const before = await readFile(path, 'utf8');
  await mkdir(`${path}.lock`);
  assert.equal(await persistModelFields(path, { additionalModelOptionsCache: [] }, { now: NOW, lockWaitMs: 120 }), 'locked');
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal((await stat(`${path}.lock`)).isDirectory(), true);

  // Released mid-wait: we get the lock and write.
  setTimeout(() => { rmdir(`${path}.lock`); }, 60);
  assert.equal(await persistModelFields(path, { additionalModelOptionsCache: [] }, { now: NOW, lockWaitMs: 1000 }), 'updated');
  const lock = await acquireConfigLock(path, { waitMs: 0 });
  assert.ok(lock, 'lock released after the write');
  await lock();
});

test('modelFieldsFromBootstrap rejects answers that do not match Claude Code\'s cache shape', () => {
  assert.deepEqual(modelFieldsFromBootstrap({}), {
    additionalModelOptionsCache: [],
    additionalModelCostsCache: {},
    modelAccessCache: [],
    orgModelDefaultCache: null,
  });
  assert.equal(modelFieldsFromBootstrap({ org_model_default: 'claude-opus-5-5' }).orgModelDefaultCache, 'claude-opus-5-5');
  for (const bad of [
    { additional_model_options: [null] },
    { additional_model_options: [{ label: 'no value' }] },
    { model_access: 'invalid' },
    { additional_model_costs: 42 },
    { additional_model_costs: [] },
    { org_model_default: 7 },
    null,
    [],
  ]) {
    assert.equal(modelFieldsFromBootstrap(bad), null, JSON.stringify(bad));
  }
});

test('refreshClaudeModelOptions re-reads accounts until a freshly refreshed token appears', async t => {
  const { dir, path } = await tempHome(t, { additionalModelOptionsCache: [STALE_OPTION] });
  // The launcher's snapshot holds an expired token; the proxy it just started
  // refreshes and persists a new one a moment later.
  const loads = [
    [account({ accessToken: 'old', expiresAt: NOW - 1000 })],
    [account({ accessToken: 'old', expiresAt: NOW - 1000 })],
    [account({ accessToken: 'refreshed' })],
  ];
  let usedToken = null;
  const result = await refreshClaudeModelOptions({
    loadAccounts: async () => loads.shift() ?? [],
    env: {},
    home: dir,
    now: NOW,
    accountWaitMs: 2000,
    accountRetryMs: 5,
    fetchImpl: async (url, init) => {
      usedToken = init.headers.Authorization;
      return jsonResponse(200, {});
    },
  });
  assert.equal(result, 'updated');
  assert.equal(usedToken, 'Bearer refreshed');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).additionalModelOptionsCache, []);
});

test('refreshClaudeModelOptions gives up after the account wait and leaves the cache alone', async t => {
  const { dir, path } = await tempHome(t, { additionalModelOptionsCache: [STALE_OPTION] });
  const before = await readFile(path, 'utf8');
  let loads = 0;
  const result = await refreshClaudeModelOptions({
    loadAccounts: async () => { loads += 1; throw new Error('config unreadable'); },
    env: {},
    home: dir,
    now: NOW,
    accountWaitMs: 30,
    accountRetryMs: 5,
    fetchImpl: async () => { throw new Error('must not fetch'); },
  });
  assert.equal(result, 'no-account');
  assert.ok(loads >= 2);
  assert.equal(await readFile(path, 'utf8'), before);
});
