import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_VENDOR_SIGNATURE,
  CLAUDE_WRAPPER_SIGNATURE,
  findNewestClaudeVendor,
  installClaudeWrapper,
  uninstallClaudeWrapper,
} from '../src/claude-wrapper.js';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

async function makeFixture(prefix = 'teamclaude wrapper ') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const homeDir = join(root, 'home with space');
  const binDir = join(homeDir, '.local', 'bin');
  const versionsDir = join(homeDir, '.local', 'share', 'claude', 'versions');
  const teamcodexBin = join(root, 'team codex');
  await mkdir(binDir, { recursive: true });
  await mkdir(versionsDir, { recursive: true });
  await writeFile(teamcodexBin, `#!/bin/zsh
print -r -- teamcodex >> "$TEAMCLAUDE_CALL_LOG"
if [[ "$1" != run || "$2" != -- ]]; then
  print -u2 -- "unexpected TeamCodex invocation"
  exit 64
fi
shift 2
exec "$TEAMCLAUDE_CLAUDE_BIN" "$@"
`);
  await chmod(teamcodexBin, 0o755);
  return {
    root,
    homeDir,
    binDir,
    versionsDir,
    teamcodexBin,
    wrapperPath: join(binDir, 'claude'),
    vendorShimPath: join(binDir, 'claude-vendor'),
    callLog: join(root, 'calls.log'),
  };
}

async function writeNative(fixture, version, { executable = true } = {}) {
  const path = join(fixture.versionsDir, version);
  await writeFile(path, `#!/bin/zsh
exec /usr/bin/env node --input-type=commonjs -e '
const { appendFileSync, writeFileSync } = require("node:fs");
const record = { kind: "vendor", version: process.argv[1], args: process.argv.slice(2) };
if (process.env.TEAMCLAUDE_CALL_LOG) {
  appendFileSync(process.env.TEAMCLAUDE_CALL_LOG, JSON.stringify(record) + "\\n");
}
if (process.env.TEAMCLAUDE_NATIVE_PID_FILE) {
  writeFileSync(process.env.TEAMCLAUDE_NATIVE_PID_FILE, String(process.pid));
}
if (process.env.TEAMCLAUDE_NATIVE_WAIT === "1") {
  setInterval(() => {}, 1000);
} else {
  process.exit(Number(process.env.TEAMCLAUDE_NATIVE_EXIT || "0"));
}
' ${JSON.stringify(version)} "$@"
`);
  await chmod(path, executable ? 0o755 : 0o644);
  return path;
}

async function cleanup(fixture) {
  await rm(fixture.root, { recursive: true, force: true });
}

function modeBits(stats) {
  return stats.mode & 0o777;
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function failOnceAt(expectedStep) {
  let failed = false;
  return step => {
    if (!failed && step === expectedStep) {
      failed = true;
      throw new Error(`injected transaction failure at ${step}`);
    }
  };
}

async function assertManagedSetMatchesState(installed) {
  const state = JSON.parse(await readFile(installed.statePath, 'utf8'));
  const wrapper = await readFile(installed.wrapperPath);
  const vendor = await readFile(installed.vendorShimPath);
  assert.equal(state.installed.wrapperSha256, sha256(wrapper));
  assert.equal(state.installed.vendorSha256, sha256(vendor));
  assert.equal(modeBits(await lstat(installed.wrapperPath)), 0o755);
  assert.equal(modeBits(await lstat(installed.vendorShimPath)), 0o755);
  return state;
}

async function waitForFile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test('findNewestClaudeVendor uses semantic version order and ignores non-version entries', async () => {
  const fixture = await makeFixture();
  try {
    await writeNative(fixture, '2.1.9');
    await writeNative(fixture, '2.1.10');
    await writeNative(fixture, '2.2.0-beta.1');
    const newest = await writeNative(fixture, '2.2.0');
    await writeNative(fixture, '3.0.0', { executable: false });
    await writeNative(fixture, 'latest');

    assert.equal(await findNewestClaudeVendor({ homeDir: fixture.homeDir }), newest);
  } finally {
    await cleanup(fixture);
  }
});

test('vendor shim ignores malformed SemVer build metadata at runtime', async () => {
  const fixture = await makeFixture();
  try {
    await writeNative(fixture, '1.0.0');
    await writeNative(fixture, '999.0.0+bad..meta');
    const installed = await installClaudeWrapper({
      homeDir: fixture.homeDir,
      teamcodexBin: fixture.teamcodexBin,
    });
    const result = spawnSync(installed.vendorShimPath, [], {
      encoding: 'utf8',
      env: { ...process.env, TEAMCLAUDE_CALL_LOG: fixture.callLog },
    });

    assert.equal(result.status, 0, result.stderr);
    const calls = (await readFile(fixture.callLog, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.deepEqual(calls.map(call => call.version), ['1.0.0']);
  } finally {
    await cleanup(fixture);
  }
});

const invalidRuntimeSemvers = [
  '999.0.0-alpha..beta',
  '999.0.0-.alpha',
  '999.0.0-alpha.',
  '999.0.0+',
  '999.0.0+bad..meta',
  '999.0.0+.meta',
  '999.0.0+meta.',
  '999.0.0-alpha_beta',
  '01.0.0',
  '1.0.0-01',
];

test('vendor shim rejects the complete invalid SemVer corpus at runtime', async t => {
  for (const invalidVersion of invalidRuntimeSemvers) {
    await t.test(invalidVersion, async () => {
      const fixture = await makeFixture();
      try {
        const normal = await writeNative(fixture, '1.0.0');
        const installed = await installClaudeWrapper({
          homeDir: fixture.homeDir,
          teamcodexBin: fixture.teamcodexBin,
        });
        await writeNative(fixture, invalidVersion);
        const withNormal = spawnSync(installed.vendorShimPath, [], {
          encoding: 'utf8',
          env: { ...process.env, TEAMCLAUDE_CALL_LOG: fixture.callLog },
        });

        assert.equal(withNormal.status, 0, withNormal.stderr);
        const calls = (await readFile(fixture.callLog, 'utf8'))
          .trim()
          .split('\n')
          .map(line => JSON.parse(line));
        assert.deepEqual(calls.map(call => call.version), ['1.0.0']);

        await rm(normal);
        const invalidOnly = spawnSync(installed.vendorShimPath, [], { encoding: 'utf8' });
        assert.equal(invalidOnly.status, 75, invalidOnly.stderr);
        assert.match(invalidOnly.stderr, /no semantic-version native candidate/i);
      } finally {
        await cleanup(fixture);
      }
    });
  }
});

test('vendor shim preserves valid prerelease and build metadata precedence', async t => {
  const scenarios = [
    {
      versions: ['2.0.0-alpha.2+build.7', '2.0.0-alpha.10+meta.1'],
      expected: '2.0.0-alpha.10+meta.1',
    },
    {
      versions: ['3.0.0-rc.9+build.7', '3.0.0+release.1'],
      expected: '3.0.0+release.1',
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.expected, async () => {
      const fixture = await makeFixture();
      try {
        await writeNative(fixture, '1.0.0');
        const installed = await installClaudeWrapper({
          homeDir: fixture.homeDir,
          teamcodexBin: fixture.teamcodexBin,
        });
        for (const version of scenario.versions) await writeNative(fixture, version);
        const result = spawnSync(installed.vendorShimPath, [], {
          encoding: 'utf8',
          env: { ...process.env, TEAMCLAUDE_CALL_LOG: fixture.callLog },
        });

        assert.equal(result.status, 0, result.stderr);
        const calls = (await readFile(fixture.callLog, 'utf8'))
          .trim()
          .split('\n')
          .map(line => JSON.parse(line));
        assert.deepEqual(calls.map(call => call.version), [scenario.expected]);
      } finally {
        await cleanup(fixture);
      }
    });
  }
});

test('install writes signed executable files and 0600 state idempotently', async () => {
  const fixture = await makeFixture();
  try {
    await writeNative(fixture, '2.1.9');
    const first = await installClaudeWrapper({
      homeDir: fixture.homeDir,
      teamcodexBin: fixture.teamcodexBin,
    });
    const before = {
      wrapper: await readFile(first.wrapperPath, 'utf8'),
      vendor: await readFile(first.vendorShimPath, 'utf8'),
      state: await readFile(first.statePath, 'utf8'),
      entries: readdir(fixture.binDir),
    };
    before.entries = (await before.entries).sort();

    assert.match(before.wrapper, new RegExp(`^# ${CLAUDE_WRAPPER_SIGNATURE}$`, 'm'));
    assert.match(before.vendor, new RegExp(`^# ${CLAUDE_VENDOR_SIGNATURE}$`, 'm'));
    assert.match(before.wrapper, /exec .* run -- "\$@"/);
    assert.doesNotMatch(before.wrapper, /localhost|127\.0\.0\.1|TEAMCLAUDE_PORT/);
    assert.equal(modeBits(await lstat(first.wrapperPath)), 0o755);
    assert.equal(modeBits(await lstat(first.vendorShimPath)), 0o755);
    assert.equal(modeBits(await lstat(first.statePath)), 0o600);

    const second = await installClaudeWrapper({
      homeDir: fixture.homeDir,
      teamcodexBin: fixture.teamcodexBin,
    });
    assert.deepEqual(second, first);
    assert.equal(await readFile(first.wrapperPath, 'utf8'), before.wrapper);
    assert.equal(await readFile(first.vendorShimPath, 'utf8'), before.vendor);
    assert.equal(await readFile(first.statePath, 'utf8'), before.state);
    assert.deepEqual((await readdir(fixture.binDir)).sort(), before.entries);
  } finally {
    await cleanup(fixture);
  }
});

test('same-digest reinstall repairs wrapper and vendor executable modes', async () => {
  const fixture = await makeFixture();
  try {
    await writeNative(fixture, '2.1.9');
    const installed = await installClaudeWrapper({
      homeDir: fixture.homeDir,
      teamcodexBin: fixture.teamcodexBin,
    });
    await chmod(installed.wrapperPath, 0o644);
    await chmod(installed.vendorShimPath, 0o644);

    await installClaudeWrapper({
      homeDir: fixture.homeDir,
      teamcodexBin: fixture.teamcodexBin,
    });

    await assertManagedSetMatchesState(installed);
  } finally {
    await cleanup(fixture);
  }
});

test('interrupted first installs converge without losing original targets', async t => {
  for (const failureStep of [
    'install:fresh:wrapper',
    'install:fresh:vendor',
    'install:fresh:state',
  ]) {
    await t.test(failureStep, async () => {
      const fixture = await makeFixture();
      try {
        await writeNative(fixture, '2.1.9');
        const originalLink = '../share/claude/versions/2.1.9';
        const originalVendor = Buffer.from('original vendor bytes\n');
        const transactionPath = join(
          fixture.binDir,
          '.teamclaude-claude-wrapper-transaction.json',
        );
        await symlink(originalLink, fixture.wrapperPath);
        await writeFile(fixture.vendorShimPath, originalVendor);
        await chmod(fixture.vendorShimPath, 0o700);

        await assert.rejects(
          installClaudeWrapper({
            homeDir: fixture.homeDir,
            teamcodexBin: fixture.teamcodexBin,
            transactionHook: failOnceAt(failureStep),
          }),
          /injected transaction failure/,
        );
        assert.equal(modeBits(await lstat(transactionPath)), 0o600);

        const installed = await installClaudeWrapper({
          homeDir: fixture.homeDir,
          teamcodexBin: fixture.teamcodexBin,
        });
        await assertManagedSetMatchesState(installed);
        await assert.rejects(readFile(transactionPath, 'utf8'), { code: 'ENOENT' });

        await uninstallClaudeWrapper({ homeDir: fixture.homeDir });
        assert.equal((await lstat(fixture.wrapperPath)).isSymbolicLink(), true);
        assert.equal(await readlink(fixture.wrapperPath), originalLink);
        assert.deepEqual(await readFile(fixture.vendorShimPath), originalVendor);
        assert.equal(modeBits(await lstat(fixture.vendorShimPath)), 0o700);
        assert.doesNotMatch(
          await readFile(fixture.wrapperPath, 'utf8'),
          new RegExp(CLAUDE_WRAPPER_SIGNATURE),
        );
        assert.doesNotMatch(
          await readFile(fixture.vendorShimPath, 'utf8'),
          new RegExp(CLAUDE_VENDOR_SIGNATURE),
        );
        await assert.rejects(readFile(installed.statePath, 'utf8'), { code: 'ENOENT' });
        await assert.rejects(readFile(transactionPath, 'utf8'), { code: 'ENOENT' });
      } finally {
        await cleanup(fixture);
      }
    });
  }
});

test('interrupted existing install updates converge on the next install', async t => {
  for (const failureStep of ['install:update:vendor', 'install:update:state']) {
    await t.test(failureStep, async () => {
      const fixture = await makeFixture();
      try {
        await writeNative(fixture, '2.1.9');
        const installed = await installClaudeWrapper({
          homeDir: fixture.homeDir,
          teamcodexBin: fixture.teamcodexBin,
        });
        const nextTeamcodexBin = join(fixture.root, 'team codex next');
        await writeFile(nextTeamcodexBin, await readFile(fixture.teamcodexBin));
        await chmod(nextTeamcodexBin, 0o755);
        const transactionPath = join(
          fixture.binDir,
          '.teamclaude-claude-wrapper-transaction.json',
        );

        await assert.rejects(
          installClaudeWrapper({
            homeDir: fixture.homeDir,
            teamcodexBin: nextTeamcodexBin,
            transactionHook: failOnceAt(failureStep),
          }),
          /injected transaction failure/,
        );
        assert.equal(modeBits(await lstat(transactionPath)), 0o600);
        const interruptedState = JSON.parse(await readFile(installed.statePath, 'utf8'));
        assert.notEqual(
          interruptedState.installed.wrapperSha256,
          sha256(await readFile(installed.wrapperPath)),
        );

        await installClaudeWrapper({
          homeDir: fixture.homeDir,
          teamcodexBin: nextTeamcodexBin,
        });
        await assertManagedSetMatchesState(installed);
        assert.ok((await readFile(installed.wrapperPath, 'utf8')).includes(nextTeamcodexBin));
        await assert.rejects(readFile(transactionPath, 'utf8'), { code: 'ENOENT' });
      } finally {
        await cleanup(fixture);
      }
    });
  }
});

test('installed wrapper dynamically adopts a new vendor and preserves argv and exit status', async () => {
  const fixture = await makeFixture();
  try {
    await writeNative(fixture, '2.1.9');
    const installed = await installClaudeWrapper({
      homeDir: fixture.homeDir,
      teamcodexBin: fixture.teamcodexBin,
    });
    await writeNative(fixture, '2.1.10');
    const argv = ['space value', '한글', '*.js', '--', '--model', 'fable'];

    for (const exitCode of [0, 17, 127]) {
      await writeFile(fixture.callLog, '');
      const result = spawnSync(installed.wrapperPath, argv, {
        encoding: 'utf8',
        env: {
          ...process.env,
          TEAMCLAUDE_CALL_LOG: fixture.callLog,
          TEAMCLAUDE_NATIVE_EXIT: String(exitCode),
        },
      });
      assert.equal(result.status, exitCode, result.stderr);
      const lines = (await readFile(fixture.callLog, 'utf8')).trim().split('\n');
      assert.equal(lines.filter(line => line === 'teamcodex').length, 1);
      const vendorCalls = lines.filter(line => line.startsWith('{')).map(line => JSON.parse(line));
      assert.equal(vendorCalls.length, 1);
      assert.equal(vendorCalls[0].version, '2.1.10');
      assert.deepEqual(vendorCalls[0].args, argv);
    }
  } finally {
    await cleanup(fixture);
  }
});

test('install backs up unknown targets and uninstall atomically restores the original symlink and file', async () => {
  const fixture = await makeFixture();
  try {
    const native = await writeNative(fixture, '2.1.9');
    const originalLink = '../share/claude/versions/2.1.9';
    const originalVendor = Buffer.from('original vendor bytes\n');
    await symlink(originalLink, fixture.wrapperPath);
    await writeFile(fixture.vendorShimPath, originalVendor);
    await chmod(fixture.vendorShimPath, 0o700);

    const installed = await installClaudeWrapper({
      homeDir: fixture.homeDir,
      teamcodexBin: fixture.teamcodexBin,
    });
    const state = JSON.parse(await readFile(installed.statePath, 'utf8'));
    assert.match(state.originals.wrapper.backupPath, /teamclaude-backup-/);
    assert.match(state.originals.vendor.backupPath, /teamclaude-backup-/);

    await uninstallClaudeWrapper({ homeDir: fixture.homeDir });
    assert.equal((await lstat(fixture.wrapperPath)).isSymbolicLink(), true);
    assert.equal(await readlink(fixture.wrapperPath), originalLink);
    assert.deepEqual(await readFile(fixture.vendorShimPath), originalVendor);
    assert.equal(modeBits(await lstat(fixture.vendorShimPath)), 0o700);
    assert.equal((await lstat(native)).isFile(), true);
    await assert.rejects(readFile(installed.statePath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await cleanup(fixture);
  }
});

test('interrupted uninstall resumes and restores both originals on the next uninstall', async () => {
  const fixture = await makeFixture();
  try {
    await writeNative(fixture, '2.1.9');
    const originalLink = '../share/claude/versions/2.1.9';
    const originalVendor = Buffer.from('original vendor bytes\n');
    await symlink(originalLink, fixture.wrapperPath);
    await writeFile(fixture.vendorShimPath, originalVendor);
    await chmod(fixture.vendorShimPath, 0o700);
    const installed = await installClaudeWrapper({
      homeDir: fixture.homeDir,
      teamcodexBin: fixture.teamcodexBin,
    });
    const transactionPath = join(
      fixture.binDir,
      '.teamclaude-claude-wrapper-transaction.json',
    );

    await assert.rejects(
      uninstallClaudeWrapper({
        homeDir: fixture.homeDir,
        transactionHook: failOnceAt('uninstall:vendor'),
      }),
      /injected transaction failure/,
    );
    assert.equal((await lstat(fixture.wrapperPath)).isSymbolicLink(), true);
    assert.equal(await readlink(fixture.wrapperPath), originalLink);
    assert.match(await readFile(fixture.vendorShimPath, 'utf8'), new RegExp(CLAUDE_VENDOR_SIGNATURE));
    assert.equal(modeBits(await lstat(transactionPath)), 0o600);
    assert.equal((await lstat(installed.statePath)).isFile(), true);

    await uninstallClaudeWrapper({ homeDir: fixture.homeDir });
    assert.equal((await lstat(fixture.wrapperPath)).isSymbolicLink(), true);
    assert.equal(await readlink(fixture.wrapperPath), originalLink);
    assert.deepEqual(await readFile(fixture.vendorShimPath), originalVendor);
    assert.equal(modeBits(await lstat(fixture.vendorShimPath)), 0o700);
    await assert.rejects(readFile(installed.statePath, 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(transactionPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await cleanup(fixture);
  }
});

test('uninstall fails closed when a managed file was edited after installation', async () => {
  const fixture = await makeFixture();
  try {
    await writeNative(fixture, '2.1.9');
    await symlink('../share/claude/versions/2.1.9', fixture.wrapperPath);
    await writeFile(fixture.vendorShimPath, 'original vendor\n');
    const installed = await installClaudeWrapper({
      homeDir: fixture.homeDir,
      teamcodexBin: fixture.teamcodexBin,
    });
    await writeFile(installed.wrapperPath, `${await readFile(installed.wrapperPath, 'utf8')}# user edit\n`);

    await assert.rejects(
      uninstallClaudeWrapper({ homeDir: fixture.homeDir }),
      /changed after installation|refusing to uninstall/i,
    );
    assert.equal((await lstat(installed.wrapperPath)).isFile(), true);
    assert.match(await readFile(installed.wrapperPath, 'utf8'), /# user edit/);
    assert.match(await readFile(installed.vendorShimPath, 'utf8'), new RegExp(CLAUDE_VENDOR_SIGNATURE));
    assert.equal((await lstat(installed.statePath)).isFile(), true);
  } finally {
    await cleanup(fixture);
  }
});

test('uninstall fails closed when an original backup changed after installation', async () => {
  const fixture = await makeFixture();
  try {
    await writeNative(fixture, '2.1.9');
    await writeFile(fixture.vendorShimPath, 'original vendor\n');
    const installed = await installClaudeWrapper({
      homeDir: fixture.homeDir,
      teamcodexBin: fixture.teamcodexBin,
    });
    const state = JSON.parse(await readFile(installed.statePath, 'utf8'));
    await writeFile(state.originals.vendor.backupPath, 'changed backup\n');

    await assert.rejects(
      uninstallClaudeWrapper({ homeDir: fixture.homeDir }),
      /original backup changed|refusing to uninstall/i,
    );
    assert.match(await readFile(installed.wrapperPath, 'utf8'), new RegExp(CLAUDE_WRAPPER_SIGNATURE));
    assert.match(await readFile(installed.vendorShimPath, 'utf8'), new RegExp(CLAUDE_VENDOR_SIGNATURE));
    assert.equal(await readFile(state.originals.vendor.backupPath, 'utf8'), 'changed backup\n');
  } finally {
    await cleanup(fixture);
  }
});

test('uninstall fails closed when managed files remain but state is missing', async () => {
  const fixture = await makeFixture();
  try {
    await writeNative(fixture, '2.1.9');
    const installed = await installClaudeWrapper({
      homeDir: fixture.homeDir,
      teamcodexBin: fixture.teamcodexBin,
    });
    await rm(installed.statePath);

    await assert.rejects(
      uninstallClaudeWrapper({ homeDir: fixture.homeDir }),
      /state.*missing|refusing to uninstall/i,
    );
    assert.match(await readFile(installed.wrapperPath, 'utf8'), new RegExp(CLAUDE_WRAPPER_SIGNATURE));
    assert.match(await readFile(installed.vendorShimPath, 'utf8'), new RegExp(CLAUDE_VENDOR_SIGNATURE));
  } finally {
    await cleanup(fixture);
  }
});

test('vendor shim fails closed for wrapper recursion, a non-executable candidate, and a symlink loop', async t => {
  await t.test('same realpath as transparent wrapper or vendor shim exits 75', async () => {
    const fixture = await makeFixture();
    try {
      await writeNative(fixture, '1.0.0');
      const installed = await installClaudeWrapper({
        homeDir: fixture.homeDir,
        teamcodexBin: fixture.teamcodexBin,
      });
      await symlink(installed.wrapperPath, join(fixture.versionsDir, '9.0.0'));
      const wrapperResult = spawnSync(installed.vendorShimPath, [], { encoding: 'utf8' });
      assert.equal(wrapperResult.status, 75, wrapperResult.stderr);
      assert.match(wrapperResult.stderr, /same realpath|recursion/i);
      await rm(join(fixture.versionsDir, '9.0.0'));
      await symlink(installed.vendorShimPath, join(fixture.versionsDir, '10.0.0'));
      const shimResult = spawnSync(installed.vendorShimPath, [], { encoding: 'utf8' });
      assert.equal(shimResult.status, 75, shimResult.stderr);
      assert.match(shimResult.stderr, /same realpath|recursion/i);
    } finally {
      await cleanup(fixture);
    }
  });

  await t.test('only non-executable candidate exits 126', async () => {
    const fixture = await makeFixture();
    try {
      const native = await writeNative(fixture, '1.0.0');
      const installed = await installClaudeWrapper({
        homeDir: fixture.homeDir,
        teamcodexBin: fixture.teamcodexBin,
      });
      await chmod(native, 0o644);
      const result = spawnSync(installed.vendorShimPath, [], { encoding: 'utf8' });
      assert.equal(result.status, 126, result.stderr);
      assert.match(result.stderr, /not executable/i);
    } finally {
      await cleanup(fixture);
    }
  });

  await t.test('only symlink-loop candidates exit 75', async () => {
    const fixture = await makeFixture();
    try {
      const native = await writeNative(fixture, '1.0.0');
      const installed = await installClaudeWrapper({
        homeDir: fixture.homeDir,
        teamcodexBin: fixture.teamcodexBin,
      });
      await rm(native);
      await symlink('1.0.1', join(fixture.versionsDir, '1.0.0'));
      await symlink('1.0.0', join(fixture.versionsDir, '1.0.1'));
      const result = spawnSync(installed.vendorShimPath, [], { encoding: 'utf8' });
      assert.equal(result.status, 75, result.stderr);
      assert.match(result.stderr, /symlink loop|cannot resolve/i);
    } finally {
      await cleanup(fixture);
    }
  });
});

test('exec chain preserves SIGINT and SIGTERM without leaving an orphan native process', async t => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    await t.test(signal, async () => {
      const fixture = await makeFixture();
      try {
        await writeNative(fixture, '1.0.0');
        const installed = await installClaudeWrapper({
          homeDir: fixture.homeDir,
          teamcodexBin: fixture.teamcodexBin,
        });
        const pidFile = join(fixture.root, `${signal}.pid`);
        const child = spawn(installed.wrapperPath, ['signal arg'], {
          env: {
            ...process.env,
            TEAMCLAUDE_CALL_LOG: fixture.callLog,
            TEAMCLAUDE_NATIVE_PID_FILE: pidFile,
            TEAMCLAUDE_NATIVE_WAIT: '1',
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        const nativePid = Number(await waitForFile(pidFile));
        assert.equal(nativePid, child.pid);
        child.kill(signal);
        const [, signalCode] = await once(child, 'exit');
        assert.equal(signalCode, signal);
        assert.throws(() => process.kill(nativePid, 0), { code: 'ESRCH' });
      } finally {
        await cleanup(fixture);
      }
    });
  }
});

test('installer validates an absolute executable TeamCodex entry and at least one native', async () => {
  const fixture = await makeFixture();
  try {
    await assert.rejects(
      installClaudeWrapper({ homeDir: fixture.homeDir, teamcodexBin: 'relative/teamcodex' }),
      /absolute/i,
    );
    await assert.rejects(
      installClaudeWrapper({ homeDir: fixture.homeDir, teamcodexBin: fixture.teamcodexBin }),
      /native|version/i,
    );
    await writeNative(fixture, '1.0.0');
    await chmod(fixture.teamcodexBin, 0o644);
    await assert.rejects(
      installClaudeWrapper({ homeDir: fixture.homeDir, teamcodexBin: fixture.teamcodexBin }),
      /executable/i,
    );
    await assert.rejects(lstat(fixture.wrapperPath), { code: 'ENOENT' });
    await assert.rejects(lstat(fixture.vendorShimPath), { code: 'ENOENT' });
  } finally {
    await cleanup(fixture);
  }
});

test('CLI dispatch installs and uninstalls in either provider mode and prints paths only', async () => {
  const fixture = await makeFixture();
  try {
    await writeNative(fixture, '1.0.0');
    const install = spawnSync(process.execPath, [entry, 'install-claude-wrapper'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fixture.homeDir },
    });
    assert.equal(install.status, 0, install.stderr);
    assert.deepEqual(install.stdout.trim().split('\n'), [fixture.wrapperPath, fixture.vendorShimPath]);
    assert.equal(install.stderr, '');

    const help = spawnSync(process.execPath, [entry, 'help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /install-claude-wrapper/);
    assert.match(help.stdout, /uninstall-claude-wrapper/);

    const uninstall = spawnSync(process.execPath, [entry, 'codex', 'uninstall-claude-wrapper'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fixture.homeDir },
    });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.deepEqual(uninstall.stdout.trim().split('\n'), [fixture.wrapperPath, fixture.vendorShimPath]);
    assert.equal(uninstall.stderr, '');
  } finally {
    await cleanup(fixture);
  }
});
