import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const assetsDir = fileURLToPath(new URL('../skills/token-usage-report/assets/', import.meta.url));

// The report assets are classic browser scripts excluded from the Node ESLint
// config, so the test suite keeps every one of them syntactically valid.
test('every token-report browser asset parses', () => {
  const scripts = readdirSync(assetsDir).filter(name => name.endsWith('.js'));
  assert.ok(scripts.length > 0, 'assets were found');
  for (const name of scripts) {
    const result = spawnSync(process.execPath, ['--check', join(assetsDir, name)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});
