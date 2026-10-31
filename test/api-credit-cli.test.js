// CLI 크레딧 명령(B2)과 CLI status 표시(B10), 실행 중 서버의 영속·재적용 배선.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const KEY = 'test-key-cli-0001';

function cleanEnv(configPath, extra = {}) {
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath, ...extra };
  delete env.TEAMCLAUDE_PROVIDER;
  delete env.TEAMCLAUDE_SESSION_SUPERVISED;
  return env;
}

async function fixture(config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-api-credit-cli-'));
  const configPath = join(dir, 'teamclaude.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port: 1, apiKey: 'fixture-key' },
    accounts: [],
    ...config,
  }, null, 2));
  return {
    dir,
    configPath,
    read: async () => JSON.parse(await readFile(configPath, 'utf8')),
    run: (args, input = '', env = {}) => spawnSync(process.execPath, [entry, ...args], {
      encoding: 'utf8', input, env: cleanEnv(configPath, env), timeout: 20_000,
    }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const endOfLocalDay = (y, m, d) => new Date(y, m - 1, d, 23, 59, 59, 999).getTime();

test('api --name --credit --expires: 키를 프롬프트로 받고 크레딧 필드를 쓴다(키는 출력 안 함)', async () => {
  const fx = await fixture();
  try {
    const before = Date.now();
    const r = fx.run(['api', '--name', 'api-1', '--credit', '50', '--expires', '2026-12-31'], `${KEY}\n`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(`${r.stdout}${r.stderr}`.includes(KEY), false, '키 값이 출력에 나오면 안 된다');
    const acct = (await fx.read()).accounts[0];
    assert.equal(acct.name, 'api-1');
    assert.equal(acct.type, 'apikey');
    assert.equal(acct.apiKey, KEY);
    assert.equal(acct.creditUsd, 50);
    assert.ok(acct.creditSince >= before && acct.creditSince <= Date.now());
    assert.equal(acct.creditExpiresAt, endOfLocalDay(2026, 12, 31));
    assert.match(r.stdout, /credit \$50\.00/);
  } finally {
    await fx.cleanup();
  }
});

test('login --api도 --credit을 받고, 크레딧 없이 등록하면 필드를 쓰지 않는다', async () => {
  const fx = await fixture();
  try {
    assert.equal(fx.run(['login', '--api', '--name', 'api-2', '--credit', '12.5'], `${KEY}\n`).status, 0);
    assert.equal(fx.run(['api', '--name', 'api-3'], `${KEY}-b\n`).status, 0);
    const [a2, a3] = (await fx.read()).accounts;
    assert.equal(a2.creditUsd, 12.5);
    assert.equal('creditUsd' in a3, false);
    assert.equal('creditSince' in a3, false);
  } finally {
    await fx.cleanup();
  }
});

test('api 등록: 잘못된 --credit·--expires는 키를 묻기 전에 거절한다', async () => {
  const fx = await fixture();
  try {
    for (const args of [['--credit', '-5'], ['--credit', 'abc'], ['--expires', '2026-13-40'], ['--expires', 'tomorrow']]) {
      const r = fx.run(['api', '--name', 'api-x', ...args], `${KEY}\n`);
      assert.equal(r.status, 1, args.join(' '));
    }
    assert.deepEqual((await fx.read()).accounts, []);
    // 경로 없는 api는 등록 프롬프트다. 빈 입력이면 등록하지 않는다.
    const empty = fx.run(['api'], '\n');
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /No API key provided/);
  } finally {
    await fx.cleanup();
  }
});

test('api-credit: 금액 재설정은 creditSince를 지금으로, 소진 플래그를 지운다. clear·만료·오류 처리', async () => {
  const fx = await fixture({
    accounts: [
      { name: 'api-1', type: 'apikey', apiKey: KEY, creditUsd: 10, creditSince: 1, creditExpiresAt: 5,
        creditExhausted: { reason: 'credit-exhausted', at: 2 } },
      { name: 'sub-1', type: 'oauth', accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    ],
  });
  try {
    const before = Date.now();
    const r = fx.run(['api-credit', 'api-1', '50']);
    assert.equal(r.status, 0, r.stderr);
    let a = (await fx.read()).accounts[0];
    assert.equal(a.creditUsd, 50);
    assert.ok(a.creditSince >= before);
    assert.equal(a.creditExpiresAt, 5, '--expires 없으면 만료일은 그대로');
    assert.equal('creditExhausted' in a, false);
    assert.equal(a.apiKey, KEY);

    assert.equal(fx.run(['api-credit', 'api-1', '80', '--expires', '2027-01-15']).status, 0);
    a = (await fx.read()).accounts[0];
    assert.equal(a.creditUsd, 80);
    assert.equal(a.creditExpiresAt, endOfLocalDay(2027, 1, 15));

    assert.equal(fx.run(['api-credit', 'api-1', '80', '--expires', 'none']).status, 0);
    a = (await fx.read()).accounts[0];
    assert.equal('creditExpiresAt' in a, false);

    assert.equal(fx.run(['api-credit', 'api-1', 'clear']).status, 0);
    a = (await fx.read()).accounts[0];
    assert.equal('creditUsd' in a, false);
    assert.ok(Number.isFinite(a.creditSince), 'clear도 원장을 새로 시작한다');

    assert.equal(fx.run(['api-credit', 'nobody', '5']).status, 1);
    assert.equal(fx.run(['api-credit', 'sub-1', '5']).status, 1, '구독 계정은 거절');
    assert.equal(fx.run(['api-credit', 'api-1', '0']).status, 1);
    assert.equal(fx.run(['api-credit', 'api-1']).status, 1);
  } finally {
    await fx.cleanup();
  }
});

test('codex 모드는 api 등록과 api-credit을 거절한다', async () => {
  const fx = await fixture({
    provider: 'codex',
    accounts: [{ name: 'api-1', type: 'apikey', apiKey: KEY }],
  });
  try {
    const a = fx.run(['codex', 'api-credit', 'api-1', '5']);
    assert.equal(a.status, 1);
    assert.match(a.stderr, /Claude/);
    const b = fx.run(['codex', 'api', '--name', 'api-2', '--credit', '5'], `${KEY}\n`);
    assert.equal(b.status, 1);
    assert.equal((await fx.read()).accounts.length, 1);
  } finally {
    await fx.cleanup();
  }
});

// ── CLI status 표시 ────────────────────────────────────────────────────────

function runCli(cliArgs, env) {
  return new Promise(resolve => {
    execFile(process.execPath, cliArgs, { encoding: 'utf8', env }, (err, stdout, stderr) =>
      resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}

function statusAccount(name, extra = {}) {
  return {
    name, accountUuid: null, type: 'apikey', provider: 'anthropic', status: 'active', errorReason: null,
    usable: true, enabled: true, priority: null,
    quota: { tokensLimit: 1000, tokensRemaining: 900, requestsLimit: null, requestsRemaining: null,
      unified5h: null, unified7d: null, modelWeekly: {}, apiSpendUsd: 0, apiUnpricedTokens: 0 },
    usage: { totalInputTokens: 1, totalOutputTokens: 1, totalRequests: 1, lastUsed: null },
    inflight: 0, maxConcurrent: 3, rateLimitedUntil: null,
    ...extra,
  };
}

async function statusOutput(accounts) {
  const payload = {
    currentAccount: accounts[0].name, switchThreshold: 0.98,
    usableCount: 1, totalCount: accounts.length, accounts,
  };
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fx = await fixture({ proxy: { port: server.address().port, apiKey: 'k' } });
  try {
    return await runCli([entry, 'status'], cleanEnv(fx.configPath));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fx.cleanup();
  }
}

test('CLI status: API 키 행에 추정 남은 금액·만료일·소진 표시', async () => {
  const expires = endOfLocalDay(2026, 12, 31);
  const r = await statusOutput([
    statusAccount('api-1', { credit: { usd: 50, spentUsd: 37.7, remainingUsd: 12.3, since: 1, expiresAt: expires,
      exhausted: false, exhaustedReason: null, unpricedTokens: 0 } }),
    statusAccount('api-2', { status: 'error', errorReason: 'credit-exhausted', usable: false,
      credit: { usd: null, spentUsd: 1.5, remainingUsd: null, since: null, expiresAt: null,
        exhausted: true, exhaustedReason: 'spend-limit', unpricedTokens: 1234 } }),
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Credit: {3}~\$12\.30 left of \$50\.00 \(est\.\), expires 2026-12-31/);
  assert.match(r.stdout, /Credit: {3}no top-up recorded \(~\$1\.50 spent, est\.\), 1,234 unpriced tokens \[credit exhausted: spend-limit\]/);
  assert.match(r.stdout, /Status: {3}error \[크레딧 소진\]/);
  assert.equal(r.stdout.includes('test-key'), false);
});

test('CLI status: 소진 차단을 설정에 쓰지 못했으면 그렇게 말한다', async () => {
  const r = await statusOutput([
    statusAccount('api-1', { status: 'error', errorReason: 'credit-exhausted', usable: false,
      credit: { usd: 50, spentUsd: 1, remainingUsd: 49, since: 1, expiresAt: null,
        exhausted: true, exhaustedReason: 'billing', unpricedTokens: 0, persistFailed: true } }),
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[credit exhausted: billing\] \(not saved to config; lost on restart, retried\)/);
});

test('CLI status: credit 블록이 없는 옛 서버 응답도 그대로 출력된다', async () => {
  const r = await statusOutput([statusAccount('api-1')]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.includes('Credit:'), false);
});

// ── 실행 중 서버: 소진 영속 → api-credit 재설정이 SIGHUP으로 반영 ─────────────

function unusedPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitUntil(fn, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function liveStatus(port) {
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, {
    headers: { 'x-api-key': 'tc-test', 'x-teamcodex-status-identity': '1' },
    signal: AbortSignal.timeout(1000),
  });
  return res.ok ? res.json() : null;
}

test('실행 중 서버: 크레딧 거절이 설정에 영속되고 api-credit이 해제한다', { timeout: 30_000 }, async () => {
  const upstream = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
        message: 'Your credit balance is too low to access the Anthropic API.' } }));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = await unusedPort();
  const fx = await fixture({
    proxy: { port, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstream.address().port}`,
    activeWarmup: false,
    accounts: [{ name: 'api-1', type: 'apikey', apiKey: KEY, creditUsd: 20, creditSince: 1000 }],
  });
  const env = cleanEnv(fx.configPath);
  const child = spawn(process.execPath, [entry, 'server'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    await waitUntil(() => liveStatus(port), `proxy did not start: ${output}`);
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [] }),
    });
    assert.equal(res.status, 429);
    await res.text();
    const disk = await waitUntil(async () => {
      const cfg = await fx.read();
      return cfg.accounts[0].creditExhausted ? cfg : null;
    }, 'creditExhausted was not persisted');
    assert.equal(disk.accounts[0].creditExhausted.reason, 'credit-exhausted');
    assert.equal(disk.accounts[0].apiKey, KEY, '영속 쓰기가 키를 잃으면 안 된다');

    const statusCli = await runCli([entry, 'status'], env);
    assert.match(statusCli.stdout, /\[credit exhausted: credit-exhausted\]/);
    assert.equal(statusCli.stdout.includes(KEY), false);

    const rearm = spawnSync(process.execPath, [entry, 'api-credit', 'api-1', '50'], { encoding: 'utf8', env, timeout: 15_000 });
    assert.equal(rearm.status, 0, rearm.stderr);
    const live = await waitUntil(async () => {
      const body = await liveStatus(port);
      return body && body.accounts[0].credit.exhausted === false ? body : null;
    }, `api-credit was not applied live: ${output}`);
    assert.equal(live.accounts[0].credit.usd, 50);
    assert.equal(live.accounts[0].status, 'active');
    assert.equal(JSON.stringify(live).includes(KEY), false);

    // 키 교체: 디스크에 옛 키의 소진 플래그가 남은 채 새 키로 바꾸고 재적용하면 새 키는 막히지 않는다.
    const cfg = await fx.read();
    cfg.accounts[0] = { ...cfg.accounts[0], apiKey: `${KEY}-new`, creditExhausted: { reason: 'billing', at: 1 } };
    await writeFile(fx.configPath, JSON.stringify(cfg, null, 2));
    const state = JSON.parse(await readFile(`${fx.configPath.replace(/\.json$/, '')}.server.json`, 'utf8'));
    process.kill(state.workerPid, 'SIGHUP');
    const replaced = await waitUntil(async () => {
      const disk = await fx.read();
      const body = await liveStatus(port);
      return body && !disk.accounts[0].creditExhausted && body.accounts[0].credit.exhausted === false ? body : null;
    }, `key replacement did not re-arm: ${output}`);
    assert.equal(replaced.accounts[0].status, 'active');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => upstream.close(resolve));
    await fx.cleanup();
  }
});
