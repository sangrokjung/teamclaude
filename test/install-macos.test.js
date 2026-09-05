import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = new URL('..', import.meta.url).pathname;
const installer = join(root, 'scripts', 'install-macos.sh');
const execFileAsync = promisify(execFile);

function runScript(script, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

function runInstaller(args = [], env = {}) {
  return runScript(installer, args, env);
}

test('macOS installer is shipped and check-only validates prerequisites without changing config', async () => {
  await access(installer, constants.R_OK | constants.X_OK);
  const configDir = await mkdtemp(join(tmpdir(), 'teamcodex-installer-'));
  try {
    const result = await runInstaller(['--check-only'], {
      TEAMCLAUDE_CONFIG: join(configDir, 'teamclaude.json'),
      XDG_CONFIG_HOME: configDir,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /check-only/i);
    assert.match(result.stdout, /credential|token|config/i);
    await assert.rejects(access(join(configDir, 'teamclaude.json')));
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('macOS installer rejects non-macOS hosts before invoking npm', async () => {
  await access(installer, constants.R_OK | constants.X_OK);
  const fakeBin = await mkdtemp(join(tmpdir(), 'teamcodex-installer-bin-'));
  try {
    const unamePath = join(fakeBin, 'uname');
    const npmPath = join(fakeBin, 'npm');
    await writeFile(unamePath, '#!/bin/sh\nprintf Linux\n');
    await writeFile(npmPath, '#!/bin/sh\nprintf npm-invoked >&2\n; exit 99\n');
    await chmod(unamePath, 0o755);
    await chmod(npmPath, 0o755);
    const result = await runInstaller(['--check-only'], {
      PATH: `${fakeBin}:${process.env.PATH}`,
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /macOS|Darwin/i);
    assert.doesNotMatch(result.stderr, /npm-invoked/);
  } finally {
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test('npm package ships the macOS installer', async () => {
  await access(installer, constants.R_OK | constants.X_OK);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.ok(manifest.files.includes('scripts/install-macos.sh'));
});

test('macOS installer requires an explicit package source for writes', async () => {
  await access(installer, constants.R_OK | constants.X_OK);
  const result = await runInstaller();
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--source is required/i);
});

test('macOS installer does not accept a package source from the environment', async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), 'teamcodex-installer-env-'));
  try {
    await writeFile(join(fakeBin, 'uname'), '#!/bin/sh\nprintf Darwin\n');
    await writeFile(join(fakeBin, 'npm'), '#!/bin/sh\nprintf "npm-invoked" >&2\nexit 99\n');
    await chmod(join(fakeBin, 'uname'), 0o755);
    await chmod(join(fakeBin, 'npm'), 0o755);
    const result = await runInstaller([], {
      PATH: `${fakeBin}:${process.env.PATH}`,
      TEAMCODEX_PACKAGE_SPEC: 'teamcodex@untrusted',
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--source is required/i);
    assert.doesNotMatch(result.stderr, /npm-invoked/);
  } finally {
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test('macOS installer rejects an option-shaped package source', async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), 'teamcodex-installer-options-'));
  try {
    await writeFile(join(fakeBin, 'uname'), '#!/bin/sh\nprintf Darwin\n');
    await writeFile(join(fakeBin, 'npm'), '#!/bin/sh\nprintf "npm-invoked" >&2\nexit 99\n');
    await chmod(join(fakeBin, 'uname'), 0o755);
    await chmod(join(fakeBin, 'npm'), 0o755);
    const result = await runInstaller(['--source', '--force'], {
      PATH: `${fakeBin}:${process.env.PATH}`,
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /source.*option|option.*source/i);
    assert.doesNotMatch(result.stderr, /npm-invoked/);
  } finally {
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test('packed installer installs its own tarball into an isolated prefix', async () => {
  const qaDir = await mkdtemp(join(tmpdir(), 'teamcodex-packed-installer-'));
  const prefix = join(qaDir, 'prefix');
  const configPath = join(qaDir, 'teamclaude.json');
  try {
    const packed = await execFileAsync('npm', [
      'pack', '--silent', '--pack-destination', qaDir,
    ], { cwd: root });
    const tarball = join(qaDir, packed.stdout.trim().split('\n').at(-1));
    const extracted = await execFileAsync('tar', [
      '-xOf', tarball, 'package/scripts/install-macos.sh',
    ]);
    const packedInstaller = join(qaDir, 'install-macos.sh');
    await writeFile(packedInstaller, extracted.stdout);
    await chmod(packedInstaller, 0o755);

    const installed = await runScript(packedInstaller, [
      '--source', tarball, '--prefix', prefix,
    ], { TEAMCLAUDE_CONFIG: configPath });
    assert.equal(installed.code, 0, installed.stderr);
    await execFileAsync(join(prefix, 'bin', 'teamclaude'), ['help'], {
      env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    });
    await execFileAsync(join(prefix, 'bin', 'teamcodex'), ['codex', 'help'], {
      env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    });
    await assert.rejects(access(configPath));
  } finally {
    await rm(qaDir, { recursive: true, force: true });
  }
});
