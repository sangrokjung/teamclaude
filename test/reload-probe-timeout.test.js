import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

function runCli(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [entry, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { out += c; });
    child.on('close', code => resolve({ code, out }));
  });
}

// An account change made while the proxy is under load must still find the
// running server: the 30s reload budget has to apply to each status probe, not
// only to the overall loop, or a status answer slower than 1.5s reads as "no
// server" and the change silently stays on disk only.
test('account reload finds a running server whose status answers slowly', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-reload-probe-'));
  const server = http.createServer((req, res) => {
    if (req.url !== '/teamclaude/status') { res.writeHead(404); res.end(); return; }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accounts: [], switchThreshold: 0.98 }));
    }, 2500);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections?.();
    server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port: server.address().port },
    accounts: [{ name: 'a0', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
  }));
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
  for (const key of ['TEAMCLAUDE_SESSION_SUPERVISED', 'TEAMCLAUDE_CLAUDE_BIN', 'TEAMCLAUDE_PROVIDER', 'TEAMCLAUDE_STATUS_PROBE_TIMEOUT_MS']) {
    delete env[key];
  }

  const { out } = await runCli(['disable', 'a0'], env);
  // The fake server owns no lifecycle state, so a found server reports that it
  // cannot live-reload; a missed server prints nothing about the running proxy.
  assert.match(out, /restart/, `the running server was found and the restart hint printed:\n${out}`);
});
