import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const SESSION_ID = '01900000-0000-7000-8000-000000000001';

async function fixture(binding) {
  const dir = await mkdtemp(join(tmpdir(), 'teamcodex-resume-'));
  const codexLog = join(dir, 'codex.json');
  const cmuxLog = join(dir, 'cmux.json');
  await writeFile(join(dir, 'codex'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CODEX_LOG, JSON.stringify({
  args: process.argv.slice(2),
  openaiApiKey: process.env.OPENAI_API_KEY ?? null,
  codexApiKey: process.env.CODEX_API_KEY ?? null,
  codexAccessToken: process.env.CODEX_ACCESS_TOKEN ?? null,
}));
`);
  await writeFile(join(dir, 'cmux'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const credentials = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'TEAMCLAUDE_CODEX_PROXY_TOKEN',
];
if (credentials.some((key) => process.env[key])) process.exit(70);
writeFileSync(process.env.CMUX_LOG, JSON.stringify(process.argv.slice(2)));
process.stdout.write(process.env.CMUX_BINDING);
`);
  await Promise.all([
    chmod(join(dir, 'codex'), 0o755),
    chmod(join(dir, 'cmux'), 0o755),
    writeFile(join(dir, 'teamcodex.json'), JSON.stringify({
      provider: 'codex',
      proxy: { port: 4567, apiKey: 'proxy-key' },
    })),
  ]);
  return {
    dir,
    codexLog,
    cmuxLog,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      TEAMCLAUDE_CONFIG: join(dir, 'teamcodex.json'),
      CODEX_LOG: codexLog,
      CMUX_LOG: cmuxLog,
      CMUX_BINDING: JSON.stringify(binding),
      OPENAI_API_KEY: 'must-not-reach-child',
      CODEX_API_KEY: 'must-not-reach-child',
      CODEX_ACCESS_TOKEN: 'must-not-reach-child',
    },
  };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('codex resume launches an explicit session through TeamCodex', async () => {
  // Given
  const fx = await fixture({});

  try {
    // When
    const result = spawnSync(
      process.execPath,
      [entry, 'codex', 'resume', SESSION_ID, '-c', 'model_provider="openai"'],
      { encoding: 'utf8', env: fx.env },
    );

    // Then
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await exists(fx.cmuxLog), false);
    const child = JSON.parse(await readFile(fx.codexLog, 'utf8'));
    const resumeIndex = child.args.indexOf('resume');
    const providerIndex = child.args.indexOf('model_provider="teamcodex_proxy"');
    const bypassIndex = child.args.indexOf('model_provider="openai"');
    assert.deepEqual(child.args.slice(resumeIndex, resumeIndex + 2), ['resume', SESSION_ID]);
    assert.ok(providerIndex > bypassIndex);
    assert.equal(child.openaiApiKey, null);
    assert.equal(child.codexApiKey, null);
    assert.equal(child.codexAccessToken, null);
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test('codex resume rejects options that bypass TeamCodex provider routing', async () => {
  // Given
  const fx = await fixture({});
  const unsafeArgs = [
    ['--remote', 'ws://127.0.0.1:9999'],
    ['--remote=ws://127.0.0.1:9999'],
    ['--remote-auth-token-env', 'REMOTE_TOKEN'],
    ['--remote-auth-token-env=REMOTE_TOKEN'],
    ['--oss'],
    ['--local-provider', 'ollama'],
    ['--local-provider=ollama'],
  ];

  try {
    for (const args of unsafeArgs) {
      // When
      const result = spawnSync(
        process.execPath,
        [entry, 'codex', 'resume', SESSION_ID, ...args],
        { encoding: 'utf8', env: fx.env },
      );

      // Then
      assert.notEqual(result.status, 0, args.join(' '));
      assert.match(result.stderr, /bypasses TeamCodex provider routing/);
      assert.equal(await exists(fx.codexLog), false);
    }
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test('codex resume uses the exact current cmux checkpoint without a selector', async () => {
  // Given
  const fx = await fixture({
    resume_binding: {
      kind: 'codex',
      checkpoint_id: SESSION_ID,
    },
  });

  try {
    // When
    const result = spawnSync(
      process.execPath,
      [entry, 'codex', 'resume'],
      { encoding: 'utf8', env: fx.env },
    );

    // Then
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(await readFile(fx.cmuxLog, 'utf8')),
      ['surface', 'resume', 'get', '--json'],
    );
    const child = JSON.parse(await readFile(fx.codexLog, 'utf8'));
    const resumeIndex = child.args.indexOf('resume');
    assert.deepEqual(child.args.slice(resumeIndex, resumeIndex + 2), ['resume', SESSION_ID]);
    assert.equal(child.args.includes('--all'), false);
    assert.equal(child.args.includes('--last'), false);
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test('codex resume fails closed when the current surface has no Codex checkpoint', async () => {
  // Given
  const fx = await fixture({
    resume_binding: {
      kind: 'codex',
      checkpoint_id: 'not-a-codex-session-id',
    },
  });

  try {
    // When
    const result = spawnSync(
      process.execPath,
      [entry, 'codex', 'resume'],
      { encoding: 'utf8', env: fx.env },
    );

    // Then
    assert.notEqual(result.status, 0);
    assert.equal(await exists(fx.codexLog), false);
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});
