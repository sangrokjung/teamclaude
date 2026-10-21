import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX = fileURLToPath(new URL('../src/index.js', import.meta.url));

test('cloud-feed refuses options it does not exactly understand, before any work', async t => {
  const home = await mkdtemp(join(tmpdir(), 'teamclaude-feed-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({ accounts: [], cloudFeed: { enabled: true } }), { mode: 0o600 });
  const env = { ...process.env, HOME: home, TEAMCLAUDE_CONFIG: config, PATH: '/usr/bin:/bin' };
  for (const argv of [
    ['run', '--dry-run=true'], ['run', '--max'], ['run', '--max', '1x'], ['run', '--max', '1', '--max', '2'],
    ['run', '--dry-run', '--dry-run'], ['tick', '--force'], ['merge'],
  ]) {
    const result = spawnSync(process.execPath, [INDEX, 'cloud-feed', ...argv], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 1, argv.join(' '));
    assert.match(result.stderr, /Usage: teamclaude cloud-feed/, argv.join(' '));
  }
  // Nothing was written next to the (isolated) home config.
  assert.deepEqual((await readdir(home)).sort(), ['config.json']);
});
