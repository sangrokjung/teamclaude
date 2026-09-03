import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = process.env.TEAMCLAUDE_TEST_ENTRY
  || fileURLToPath(new URL('../src/index.js', import.meta.url));

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function account(email) {
  return {
    name: email,
    email,
    provider: 'codex',
    type: 'oauth',
    accountUuid: `uuid-${email}`,
    accessToken: `access-${email}`,
    refreshToken: `refresh-${email}`,
  };
}

function runSubscription(configPath, args, timezone = 'Asia/Seoul') {
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath, TZ: timezone };
  delete env.TEAMCLAUDE_SESSION_SUPERVISED;
  return spawnSync(process.execPath, [entry, 'codex', 'subscription', ...args], {
    encoding: 'utf8',
    env,
  });
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-subscription-cli-'));
  const configPath = join(dir, 'teamcodex.json');
  await writeFile(configPath, JSON.stringify({
    provider: 'codex',
    proxy: { port: 1, apiKey: 'fixture-key' },
    accounts: [
      account('sesileo981110@example.com'),
      account('sesileo98@example.com'),
      account('testacountqjc@example.com'),
      account('test981110@example.com'),
    ],
  }, null, 2));
  return {
    configPath,
    read: async () => JSON.parse(await readFile(configPath, 'utf8')),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('subscription cancel selects exact localparts and stores the last usable local date', async () => {
  const fx = await fixture();
  try {
    const exact = runSubscription(fx.configPath, ['cancel', 'sesileo98']);
    assert.equal(exact.status, 0, exact.stderr);
    assert.match(exact.stdout, /sesileo98@example\.com/);

    const dated = runSubscription(fx.configPath, ['cancel', 'test981110', '--ends-on', '2026-09-06']);
    assert.equal(dated.status, 0, dated.stderr);

    const config = await fx.read();
    const longName = config.accounts.find(a => a.email.startsWith('sesileo981110@'));
    const exactName = config.accounts.find(a => a.email.startsWith('sesileo98@'));
    const datedName = config.accounts.find(a => a.email.startsWith('test981110@'));
    assert.equal(longName.subscriptionCancellation, undefined, 'prefix collision must stay untouched');
    assert.equal(exactName.subscriptionCancellation.status, 'scheduled');
    assert.equal(exactName.subscriptionCancellation.endsAt, null);
    assert.equal(datedName.subscriptionCancellation.endsAt, '2026-09-06T15:00:00.000Z');
  } finally {
    await fx.cleanup();
  }
});

test('subscription cancel accepts equals-form identity and end-date flags', async () => {
  const fx = await fixture();
  try {
    const dated = runSubscription(fx.configPath, [
      'cancel', 'test981110',
      '--ends-on=2026-09-06',
      '--account-uuid=uuid-test981110@example.com',
    ]);
    assert.equal(dated.status, 0, dated.stderr);

    const account = (await fx.read()).accounts.find(a => a.email.startsWith('test981110@'));
    assert.equal(account.subscriptionCancellation.endsAt, '2026-09-06T15:00:00.000Z');
  } finally {
    await fx.cleanup();
  }
});

test('subscription cancel stores the KST end boundary on a non-KST host', async () => {
  const fx = await fixture();
  try {
    const result = runSubscription(fx.configPath, [
      'cancel', 'test981110', '--ends-on', '2026-09-06',
    ], 'America/New_York');
    assert.equal(result.status, 0, result.stderr);

    const account = (await fx.read()).accounts.find(a => a.email.startsWith('test981110@'));
    assert.equal(account.subscriptionCancellation.endsAt, '2026-09-06T15:00:00.000Z');
  } finally {
    await fx.cleanup();
  }
});

test('subscription cancel and clear fail closed on typos, invalid dates, and UUID mismatch', async () => {
  const fx = await fixture();
  try {
    const before = await readFile(fx.configPath, 'utf8');
    const typo = runSubscription(fx.configPath, ['cancel', 'testacount']);
    assert.equal(typo.status, 1);
    assert.match(typo.stderr, /not found/);
    assert.equal(await readFile(fx.configPath, 'utf8'), before);

    const invalidDate = runSubscription(fx.configPath, [
      'cancel', 'test981110', '--ends-on', '2026-02-30',
    ]);
    assert.equal(invalidDate.status, 1);
    assert.match(invalidDate.stderr, /valid YYYY-MM-DD/);
    assert.equal(await readFile(fx.configPath, 'utf8'), before);

    const wrongUuid = runSubscription(fx.configPath, [
      'clear', 'sesileo98', '--account-uuid', 'uuid-wrong-account',
    ]);
    assert.equal(wrongUuid.status, 1);
    assert.match(wrongUuid.stderr, /expected identity/);
    assert.equal(await readFile(fx.configPath, 'utf8'), before);

    const wrongEqualsUuid = runSubscription(fx.configPath, [
      'clear', 'sesileo98', '--account-uuid=uuid-wrong-account',
    ]);
    assert.equal(wrongEqualsUuid.status, 1);
    assert.match(wrongEqualsUuid.stderr, /expected identity/);
    assert.equal(await readFile(fx.configPath, 'utf8'), before);
  } finally {
    await fx.cleanup();
  }
});

test('subscription clear removes only cancellation metadata', async () => {
  const fx = await fixture();
  try {
    assert.equal(runSubscription(fx.configPath, ['cancel', 'testacountqjc']).status, 0);
    const tracked = await fx.read();
    const before = tracked.accounts.find(a => a.email.startsWith('testacountqjc@'));

    const cleared = runSubscription(fx.configPath, [
      'clear', 'testacountqjc', '--account-uuid', before.accountUuid,
    ]);
    assert.equal(cleared.status, 0, cleared.stderr);
    const after = (await fx.read()).accounts.find(a => a.email.startsWith('testacountqjc@'));
    assert.equal(after.subscriptionCancellation, undefined);
    assert.equal(after.accessToken, before.accessToken);
    assert.equal(after.refreshToken, before.refreshToken);
    assert.equal(after.accountUuid, before.accountUuid);
  } finally {
    await fx.cleanup();
  }
});

test('Codex re-import preserves subscription cancellation metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-subscription-import-'));
  const authPath = join(dir, 'auth.json');
  const configPath = join(dir, 'teamcodex.json');
  await writeFile(authPath, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt({
        email: 'pool@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'workspace-pool', chatgpt_plan_type: 'pro',
        },
      }),
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      account_id: 'workspace-pool',
    },
  }));
  const runImport = () => spawnSync(process.execPath, [
    entry, 'codex', 'import', '--from', authPath, '--name', 'pooled-pro',
  ], {
    encoding: 'utf8',
    env: { ...process.env, XDG_CONFIG_HOME: dir, TEAMCLAUDE_CONFIG: '' },
  });

  try {
    const first = runImport();
    assert.equal(first.status, 0, first.stderr);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.accounts[0].subscriptionCancellation = {
      status: 'scheduled', recordedAt: '2026-08-31T00:00:00.000Z',
      endsAt: '2026-09-06T15:00:00.000Z',
    };
    await writeFile(configPath, JSON.stringify(config));

    const second = runImport();
    assert.equal(second.status, 0, second.stderr);
    const reimported = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(reimported.accounts[0].subscriptionCancellation,
      config.accounts[0].subscriptionCancellation);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
