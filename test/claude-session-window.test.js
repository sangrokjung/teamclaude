// 5시간 창이 없는 Claude 구독 계정(2026-10-30부터 검증된 Ultra 계정은
// anthropic-ratelimit-unified-5h-* 헤더 없이 7d 헤더만 받는다)을 프록시가
// quota.sessionWindowStated로 기록하고, 측정 판정·표시에만 반영하는지 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';
import { createProxyServer } from '../src/server.js';

const HOUR = 3600_000;
const futureSec = ms => String(Math.floor((Date.now() + ms) / 1000));

const oauth = (name = 'ultra-1', extra = {}) => ({
  name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + HOUR, ...extra,
});

function makeManager(accounts = [oauth()]) {
  return new AccountManager(accounts, 0.98, 0, 5);
}

const WEEKLY_ONLY = () => ({
  'anthropic-ratelimit-unified-7d-utilization': '0.4',
  'anthropic-ratelimit-unified-7d-reset': futureSec(24 * HOUR),
  'anthropic-ratelimit-unified-status': 'allowed',
});

const BOTH = () => ({
  'anthropic-ratelimit-unified-5h-utilization': '0.1',
  'anthropic-ratelimit-unified-5h-reset': futureSec(HOUR),
  'anthropic-ratelimit-unified-7d-utilization': '0.4',
  'anthropic-ratelimit-unified-7d-reset': futureSec(24 * HOUR),
  'anthropic-ratelimit-unified-status': 'allowed',
});

// ── Task 1: 기록과 측정 판정 ────────────────────────────────────────────────

test('새 계정의 sessionWindowStated는 null이다', () => {
  const am = makeManager();
  assert.equal(am.accounts[0].quota.sessionWindowStated, null);
});

test('weekly-only success sets flag false', () => {
  const am = makeManager();
  const a = am.accounts[0];
  am.updateQuota(a, WEEKLY_ONLY(), { status: 200 });
  assert.equal(a.quota.sessionWindowStated, false);
  assert.equal(am._fullyMeasured(a), true, '7d 완전 + 5h 없음 확인 = 완전 측정');
});

test('5h header sets flag true', () => {
  const am = makeManager();
  const a = am.accounts[0];
  am.updateQuota(a, BOTH(), { status: 200 });
  assert.equal(a.quota.sessionWindowStated, true);
  assert.equal(am._fullyMeasured(a), true);
});

test('5h reset 헤더 하나만 와도 true다', () => {
  const am = makeManager();
  const a = am.accounts[0];
  am.updateQuota(a, {
    ...WEEKLY_ONLY(),
    'anthropic-ratelimit-unified-5h-reset': futureSec(HOUR),
  }, { status: 200 });
  assert.equal(a.quota.sessionWindowStated, true);
});

test('rejected 429 keeps flag', () => {
  const am = makeManager();
  const a = am.accounts[0];
  am.updateQuota(a, {
    'anthropic-ratelimit-unified-7d-utilization': '1.0',
    'anthropic-ratelimit-unified-7d-reset': futureSec(24 * HOUR),
    'anthropic-ratelimit-unified-status': 'rejected',
  }, { status: 429 });
  assert.equal(a.quota.sessionWindowStated, null, '주간 소진 거절은 5h 창 유무의 증거가 아니다');
});

test('rejected 상태의 성공 코드 응답도 플래그를 false로 바꾸지 않는다', () => {
  const am = makeManager();
  const a = am.accounts[0];
  am.updateQuota(a, {
    ...WEEKLY_ONLY(),
    'anthropic-ratelimit-unified-status': 'rejected',
  }, { status: 200 });
  assert.equal(a.quota.sessionWindowStated, null);
});

test('error without headers keeps flag', () => {
  const am = makeManager();
  const a = am.accounts[0];
  am.updateQuota(a, WEEKLY_ONLY(), { status: 200 });
  assert.equal(a.quota.sessionWindowStated, false);
  am.updateQuota(a, {}, { status: 500 });
  assert.equal(a.quota.sessionWindowStated, false);
});

test('7d만 온 4xx/5xx 응답은 null 플래그를 바꾸지 않는다', () => {
  const am = makeManager();
  const a = am.accounts[0];
  am.updateQuota(a, WEEKLY_ONLY(), { status: 500 });
  assert.equal(a.quota.sessionWindowStated, null);
});

test('status omitted never sets false', () => {
  const am = makeManager();
  const a = am.accounts[0];
  am.updateQuota(a, WEEKLY_ONLY());
  assert.equal(a.quota.sessionWindowStated, null);
});

test('5h returns after false', () => {
  const am = makeManager();
  const a = am.accounts[0];
  am.updateQuota(a, WEEKLY_ONLY(), { status: 200 });
  assert.equal(a.quota.sessionWindowStated, false);
  am.updateQuota(a, BOTH(), { status: 200 });
  assert.equal(a.quota.sessionWindowStated, true);
  assert.equal(a.quota.unified5h, 0.1);
});

test('lingering 5h cleared when flag false', () => {
  const am = makeManager();
  const a = am.accounts[0];
  a.quota.unified5h = 0;
  a.quota.unified5hReset = null;
  a.quota.sessionWindowStated = false;
  am._isNearQuota(a);
  assert.equal(a.quota.unified5h, null);
  assert.equal(a.quota.unified5hReset, null);
});

test('플래그가 null이면 reset 없는 5h 값을 지우지 않는다', () => {
  const am = makeManager();
  const a = am.accounts[0];
  a.quota.unified5h = 0.3;
  a.quota.unified5hReset = null;
  am._isNearQuota(a);
  assert.equal(a.quota.unified5h, 0.3);
});

test('플래그 false면 미래 reset이 있는 5h 값도 지워지고 계정이 막히지 않는다', () => {
  const am = makeManager();
  const a = am.accounts[0];
  am.updateQuota(a, WEEKLY_ONLY(), { status: 200 });
  a.quota.unified5h = 0.99;
  a.quota.unified5hReset = Date.now() + HOUR;
  am._isNearQuota(a);
  assert.equal(a.quota.unified5h, null);
  assert.equal(a.quota.unified5hReset, null);
  assert.equal(am.getStatus().accounts[0].usable, true);
});

test('스냅샷 복원: 플래그 false + 미래 5h 99%는 복원 시 버려지고 getStatus usable과 화면이 일치한다', () => {
  const src = makeManager();
  const a = src.accounts[0];
  src.updateQuota(a, WEEKLY_ONLY(), { status: 200 });
  const snap = src.exportQuotaState();
  snap[0].quota.unified5h = 0.99;
  snap[0].quota.unified5hReset = Date.now() + HOUR;
  const am = makeManager();
  am.importQuotaState(snap);
  const st = am.getStatus().accounts[0];
  assert.equal(st.quota.sessionWindowStated, false);
  assert.equal(st.quota.unified5h, null);
  assert.equal(st.quota.unified5hReset, null);
  assert.equal(st.usable, true);
});

test('Max→Ultra 전환: 남은 미래 5h 99%는 weekly-only 성공 응답에서 지워지고 계정은 다시 쓸 수 있다', () => {
  const am = makeManager();
  const a = am.accounts[0];
  am.updateQuota(a, BOTH(), { status: 200 });
  a.quota.unified5h = 0.99;
  a.quota.unified5hReset = Date.now() + HOUR;
  assert.equal(am.getStatus().accounts[0].usable, false);
  am.updateQuota(a, WEEKLY_ONLY(), { status: 200 });
  assert.equal(a.quota.sessionWindowStated, false);
  assert.equal(a.quota.unified5h, null);
  assert.equal(a.quota.unified5hReset, null);
  assert.equal(am.getStatus().accounts[0].usable, true);
});

test('weekly-only라도 거절·오류 응답은 남은 5h 값을 지우지 않는다', () => {
  const am = makeManager();
  const a = am.accounts[0];
  a.quota.unified5h = 0.99;
  a.quota.unified5hReset = Date.now() + HOUR;
  am.updateQuota(a, { ...WEEKLY_ONLY(), 'anthropic-ratelimit-unified-status': 'rejected' }, { status: 429 });
  assert.equal(a.quota.unified5h, 0.99);
  am.updateQuota(a, WEEKLY_ONLY(), { status: 500 });
  assert.equal(a.quota.unified5h, 0.99);
});

test('apikey and codex untouched', () => {
  const am = makeManager([
    { name: 'api-1', type: 'apikey', apiKey: 'k' },
    oauth('codex-1', { provider: 'codex' }),
  ]);
  const [api, codex] = am.accounts;
  am.updateQuota(api, WEEKLY_ONLY(), { status: 200 });
  am.updateQuota(codex, WEEKLY_ONLY(), { status: 200 });
  assert.equal(api.quota.sessionWindowStated, null);
  assert.equal(codex.quota.sessionWindowStated, null);
  am.updateQuota(api, BOTH(), { status: 200 });
  am.updateQuota(codex, BOTH(), { status: 200 });
  assert.equal(api.quota.sessionWindowStated, null);
  assert.equal(codex.quota.sessionWindowStated, null);
});

test('플래그가 있어도 계정 선택은 측정값으로만 막는다', () => {
  const am = makeManager();
  const a = am.accounts[0];
  am.updateQuota(a, {
    ...WEEKLY_ONLY(),
    'anthropic-ratelimit-unified-7d-utilization': '0.99',
  }, { status: 200 });
  assert.equal(a.quota.sessionWindowStated, false);
  assert.equal(am._isNearQuota(a), true, '주간 99%는 플래그와 무관하게 가득');
});

test('snapshot round-trip', () => {
  const am = makeManager();
  am.updateQuota(am.accounts[0], WEEKLY_ONLY(), { status: 200 });
  const saved = JSON.parse(JSON.stringify(am.exportQuotaState()));

  const restored = makeManager();
  restored.importQuotaState(saved);
  assert.equal(restored.accounts[0].quota.sessionWindowStated, false);
  assert.equal(restored._fullyMeasured(restored.accounts[0]), true);

  const tampered = saved.map(s => ({ ...s, quota: { ...s.quota, sessionWindowStated: 'false' } }));
  const sanitized = makeManager();
  sanitized.importQuotaState(tampered);
  assert.equal(sanitized.accounts[0].quota.sessionWindowStated, null);

  const legacy = saved.map(s => {
    const quota = { ...s.quota };
    delete quota.sessionWindowStated;
    return { ...s, quota };
  });
  const old = makeManager();
  old.importQuotaState(legacy);
  assert.equal(old.accounts[0].quota.sessionWindowStated, null);
});

test('상태 응답에 sessionWindowStated가 실린다', () => {
  const am = makeManager();
  am.updateQuota(am.accounts[0], WEEKLY_ONLY(), { status: 200 });
  const status = am.getStatus();
  assert.equal(status.accounts[0].quota.sessionWindowStated, false);
});

test('warm-up skips weekly-only', () => {
  const am = makeManager();
  const a = am.accounts[0];
  am.updateQuota(a, WEEKLY_ONLY(), { status: 200 });
  assert.equal(am.needsPartialRemeasure(a), false);
});

test('플래그 null인 7d-only 계정은 여전히 재측정 대상이다', () => {
  const am = makeManager();
  const a = am.accounts[0];
  am.updateQuota(a, WEEKLY_ONLY());
  assert.equal(am._fullyMeasured(a), false);
  assert.equal(am.needsPartialRemeasure(a), true);
});

test('warm-up 프로브 경로: 7d만 오는 200 응답 한 번으로 플래그가 false가 되고 프로브가 멈춘다', async () => {
  let probeCount = 0;
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (raw.includes('"max_tokens":1')) probeCount++;
    res.writeHead(200, {
      'content-type': 'application/json',
      // 주간 99%라 계정은 가득(선택 불가) → 반쪽 재측정 경로만 이 계정을 프로브한다.
      'anthropic-ratelimit-unified-7d-utilization': '0.99',
      'anthropic-ratelimit-unified-7d-reset': futureSec(24 * HOUR),
      'anthropic-ratelimit-unified-status': 'allowed',
    });
    res.end('{"ok":true}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const am = new AccountManager([oauth('ultra-1')], 0.98, 0, 3);
  const proxy = createProxyServer(am, {
    upstream: `http://127.0.0.1:${upstream.address().port}`, warmupIntervalMs: 20,
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const a = am.accounts[0];
    a.quota.unified7d = 0.99;
    a.quota.unified7dReset = Date.now() + 24 * HOUR;
    a._partialProbes = 0;
    assert.equal(proxy.importProbeTemplate({ model: 'claude-x' }), true);
    assert.equal(am.needsPartialRemeasure(a), true, '플래그 null이면 재측정 대상');

    const t0 = Date.now();
    while (a.quota.sessionWindowStated !== false && Date.now() - t0 < 3000) {
      await new Promise(r => setTimeout(r, 15));
    }
    assert.equal(a.quota.sessionWindowStated, false, '프로브 응답의 상태 코드가 updateQuota로 전달됐다');
    assert.equal(am._fullyMeasured(a), true);
    assert.equal(am.needsPartialRemeasure(a), false);
    const settled = probeCount;
    await new Promise(r => setTimeout(r, 200));
    assert.equal(probeCount, settled, '완전 측정 뒤에는 반복 프로브가 없다');
    assert.ok(settled <= 2, `프로브는 한두 번에서 멈춘다 (${settled})`);
  } finally {
    await new Promise(r => proxy.close(r));
    await new Promise(r => upstream.close(r));
  }
});

// ── Task 2: CLI status와 TUI 표시 ──────────────────────────────────────────

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

function runCli(cliArgs, env) {
  return new Promise(resolve => {
    execFile(process.execPath, cliArgs, { encoding: 'utf8', env }, (err, stdout, stderr) =>
      resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}

function statusAccount(name, quota) {
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
      unified5h: null, unified7d: null,
      unified5hReset: null, unified7dReset: null,
      unifiedStatus: null, codexUsageAt: null,
      modelWeekly: {}, resetsAt: null, tokensReset: null, requestsReset: null,
      ...quota,
    },
    usage: { totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 1, lastUsed: null },
    inflight: 0,
    maxConcurrent: 3,
    rateLimitedUntil: null,
  };
}

async function runStatusAgainst(accounts) {
  const payload = {
    currentAccount: accounts[0].name,
    currentAccountUuid: accounts[0].accountUuid,
    switchThreshold: 0.98,
    usableCount: accounts.length,
    totalCount: accounts.length,
    accounts,
  };
  const server = createServer((req, res) => {
    if (!req.url.startsWith('/teamclaude/status')) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-sessionwindow-'));
  const configPath = join(dir, 'teamclaude.json');
  await writeFile(configPath, JSON.stringify({
    provider: 'anthropic',
    proxy: { port, apiKey: 'k' },
    accounts: [],
  }, null, 2));
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
  delete env.TEAMCLAUDE_PROVIDER;
  try {
    return await runCli([entry, 'status'], env);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test('CLI status: 5시간 창 없는 계정은 no 5h limit으로 표시한다', async () => {
  const res = await runStatusAgainst([
    statusAccount('ultra-1', { unified7d: 0.4, sessionWindowStated: false }),
    statusAccount('max-1', { unified5h: 0.1, unified7d: 0.2, sessionWindowStated: null }),
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Session:  no 5h limit\s+Weekly: 40\.0% used/);
  assert.match(res.stdout, /Session:  10\.0% used\s+Weekly: 20\.0% used/, '기존 계정 문자열은 그대로');
});

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

test('TUI: 5시간 창 없는 계정 행은 Ses none을 그리고 폭이 같다', () => {
  const am = makeManager([oauth('ultra-1'), oauth('max-1')]);
  const [ultra, max] = am.accounts;
  am.updateQuota(ultra, WEEKLY_ONLY(), { status: 200 });
  am.updateQuota(max, BOTH(), { status: 200 });
  const tui = new TUI({ accountManager: am, config: { accounts: [] }, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {} });

  for (const [showBoth, showThree] of [[true, true], [true, false], [false, false]]) {
    const ultraRow = stripAnsi(tui._renderAcct(ultra, 0, 10, showBoth, showThree));
    const maxRow = stripAnsi(tui._renderAcct(max, 1, 10, showBoth, showThree));
    assert.match(ultraRow, /Ses\s+none\s/);
    assert.doesNotMatch(ultraRow, /Ses\s+\d+%/);
    assert.equal(ultraRow.length, maxRow.length, `행 길이 동일 (showBoth=${showBoth}, showThree=${showThree})`);
  }
  const maxRow = stripAnsi(tui._renderAcct(max, 1, 10, true, true));
  assert.match(maxRow, /Ses\s+10%/, '5h 창이 있는 계정은 막대 그대로');
});
