import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

test('run preserves OAuth while clearing higher-precedence API credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-run-env-'));
  try {
    const fakeClaude = join(dir, 'claude');
    const configPath = join(dir, 'config.json');
    await writeFile(fakeClaude, `#!/usr/bin/env node
console.log(JSON.stringify({
  apiKey: process.env.ANTHROPIC_API_KEY ?? null,
  authToken: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
  oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
  baseUrl: process.env.ANTHROPIC_BASE_URL,
  args: process.argv.slice(2),
}));
`);
    await chmod(fakeClaude, 0o755);
    await writeFile(configPath, JSON.stringify({ proxy: { port: 4567, apiKey: 'proxy-key' } }));

    const result = spawnSync(process.execPath, [entry, 'run', '--', '--model', 'fable'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        TEAMCLAUDE_CONFIG: configPath,
        ANTHROPIC_API_KEY: 'must-not-reach-child',
        ANTHROPIC_AUTH_TOKEN: 'must-not-reach-child',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-must-reach-child',
        ANTHROPIC_BASE_URL: 'https://wrong.example',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const child = JSON.parse(result.stdout.trim());
    assert.equal(child.apiKey, null);
    assert.equal(child.authToken, null);
    assert.equal(child.oauthToken, 'oauth-must-reach-child');
    assert.equal(child.baseUrl, 'http://localhost:4567');
    assert.deepEqual(child.args, ['--model', 'fable']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
