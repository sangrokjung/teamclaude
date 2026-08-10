import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';

// The fake proxy below serves from THIS process's event loop, so the CLI must be
// spawned asynchronously — spawnSync would block the loop and the probe would
// time out as "not running".
function runCli(cliArgs, env) {
  return new Promise(resolve => {
    execFile(process.execPath, cliArgs, { encoding: 'utf8', env }, (err, stdout, stderr) =>
      resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

function account(name, extra = {}) {
  return {
    name,
    accountUuid: `uuid-${name}`,
    type: 'oauth',
    provider: 'anthropic',
    status: 'active',
    errorReason: null,
    usable: true,
    enabled: true,
    priority: null,
    quota: {
      tokensLimit: null, tokensRemaining: null,
      requestsLimit: null, requestsRemaining: null,
      unified5h: 0.1, unified7d: 0.2,
      unified5hReset: null, unified7dReset: null,
      unifiedStatus: null, codexUsageAt: null,
      modelWeekly: {}, resetsAt: null, tokensReset: null, requestsReset: null,
    },
    usage: { totalInputTokens: 10, totalOutputTokens: 2, totalRequests: 3, lastUsed: null },
    inflight: 0,
    maxConcurrent: 3,
    rateLimitedUntil: null,
    ...extra,
  };
}

/** Serve one fixed /teamclaude/status payload; returns { port, close }. */
async function startFakeProxy(payload) {
  const server = createServer((req, res) => {
    if (!req.url.startsWith('/teamclaude/status')) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function runStatusAgainst(payload) {
  const proxy = await startFakeProxy(payload);
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-statuscli-'));
  const configPath = join(dir, 'teamclaude.json');
  await writeFile(configPath, JSON.stringify({
    provider: 'anthropic',
    proxy: { port: proxy.port, apiKey: 'k' },
    accounts: [],
  }, null, 2));

  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
  delete env.TEAMCLAUDE_PROVIDER;
  try {
    return await runCli([entry, 'status'], env);
  } finally {
    await proxy.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const basePayload = accounts => ({
  currentAccount: accounts[0].name,
  currentAccountUuid: accounts[0].accountUuid,
  switchThreshold: 0.98,
  usableCount: accounts.filter(a => a.usable).length,
  totalCount: accounts.length,
  accounts,
});

// Regression: an account parked as 'error' made statusCommand read the
// module-level ERROR_REASON_LABELS while the top-level command dispatch was
// still running — a TDZ ReferenceError swallowed by the catch, which printed
// the misleading "Server: unreachable" and exited 1 mid-listing.
test('status renders an error account reason instead of dying as "unreachable"', async () => {
  const res = await runStatusAgainst(basePayload([
    account('revoked@example.com', { status: 'error', errorReason: 'auth-revoked', usable: false }),
    account('good@example.com'),
  ]));

  assert.equal(res.status, 0, `exit ${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.doesNotMatch(res.stdout, /unreachable/, 'must not report a live server as unreachable');
  assert.match(res.stdout, /revoked@example\.com/);
  assert.match(res.stdout, /인증무효/, 'error reason label must be rendered');
  // Listing must continue past the error account.
  assert.match(res.stdout, /good@example\.com/);
});

test('status lists healthy accounts with quota lines', async () => {
  const res = await runStatusAgainst(basePayload([account('a@example.com'), account('b@example.com')]));

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Usable now:\s+2\/2 accounts/);
  assert.match(res.stdout, /Session:\s+10\.0% used\s+Weekly: 20\.0% used/);
  assert.match(res.stdout, /b@example\.com/);
});
