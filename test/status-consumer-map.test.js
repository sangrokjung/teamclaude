// status 필드 × 소비자(CLI·TUI·메뉴바) 지도.
//
// AccountManager.getStatus({ includeIdentity: true })가 내보내는 필드마다 세 소비자가 그 값을
// 실제로 화면에 그리는지 실행으로 확인한다. "필드를 계산해 놓고 일부 소비자에만 보여 주는" 회귀를 막는다.
//
// 판정은 소스 문자열 검색이 아니라 차분 렌더다. 필드 하나만 표식 값으로 바꾼 상태를 실제 렌더 경로에
// 넣고, 바꾸기 전 렌더와 문자열이 달라지는지 본다. 값을 읽어 로그·계산에만 쓰고 그리지 않으면 같은
// 문자열이 나오므로 실패한다.
//  - CLI: `teamcodex status`를 자식 프로세스로 띄우고, 가짜 프록시가 표식 status를 응답한다(서버 응답 대체).
//  - TUI: 실제 AccountManager 상태에 표식을 넣고 TUI.render()가 stdout에 쓰는 프레임을 캡처한다.
//  - 메뉴바: 같은 표식을 menubar/Tests/Fixtures/status-consumer-sentinel.json으로 내보내고
//    menubar/Tests/StatusConsumerMapTests.swift가 메뉴바 디코딩·표시 로직에 넣어 판정한다.
//
// 필드 목록은 손으로 적지 않는다. 실제 getStatus 결과에서 모은다(최상위 키 + 계정 키, 중첩 객체는 1단계).
// 보이지 않는 게 맞는 필드는 test/status-consumer-exemptions.json에 사유·만료·승인과 함께 등록한다.
//
// 표식 fixture가 실제 getStatus와 달라지면(필드 추가·삭제·값 변화) 실패한다. 갱신:
//   TC_UPDATE_STATUS_SENTINEL=1 node --test test/status-consumer-map.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';

const ENTRY = fileURLToPath(new URL('../src/index.js', import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL('../menubar/Tests/Fixtures/status-consumer-sentinel.json', import.meta.url));
const EXEMPTIONS_PATH = fileURLToPath(new URL('./status-consumer-exemptions.json', import.meta.url));

// 실패 메시지에 넣는 "표시 지점을 추가할 파일".
const CONSUMER_FILES = {
  cli: 'src/index.js',
  tui: 'src/tui.js',
  menubar: 'menubar/Sources/TeamCodexPoolStatus.swift',
};

// 고정 시계 기준. fixture가 실행 시각과 무관하게 같은 내용이 되도록 먼 미래의 고정 시각을 쓴다.
// (지금보다 미래라 리셋·만료·스로틀 창은 모두 "아직 열려 있음"으로 계산된다.)
const T0 = Date.UTC(2099, 0, 1);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// 시각 표식: 날짜(YYYY-MM-DD)·시·분 단위 표시가 모두 바뀌는 이동량.
const SHIFT_MS = DAY + 2 * HOUR + 9 * MIN + 37 * SEC;
const iso = ms => new Date(ms).toISOString();
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// ── 표식 상태의 바탕: 값이 비지 않은 계정 3종(Claude OAuth · Codex OAuth · Anthropic API 키) ──

function buildManager() {
  const am = new AccountManager([
    {
      name: 'acct-claude', accountUuid: 'uuid-claude', type: 'oauth', provider: 'anthropic',
      accessToken: 'tok-a', refreshToken: 'ref-a', expiresAt: T0, planType: 'max', priority: 0, maxConcurrent: 3,
    },
    {
      name: 'acct-codex', accountUuid: 'uuid-codex', type: 'oauth', provider: 'codex',
      accessToken: 'tok-c', refreshToken: 'ref-c', expiresAt: T0, planType: 'plus', priority: 1, maxConcurrent: 4,
      subscriptionCancellation: { status: 'scheduled', recordedAt: iso(T0 - DAY), endsAt: iso(T0 + 10 * DAY) },
    },
    {
      name: 'acct-apikey', accountUuid: 'uuid-apikey', type: 'apikey', provider: 'anthropic', apiKey: 'key-k',
      maxConcurrent: 2, creditUsd: 50, creditSince: T0 - 5 * DAY, creditExpiresAt: T0 + 30 * DAY,
    },
  ], 0.98, 0, 3);
  const [claude, codex, apikey] = am.accounts;
  Object.assign(claude.quota, {
    unified5h: 0.25, unified7d: 0.35, unified5hReset: T0 + 3 * HOUR, unified7dReset: T0 + 50 * HOUR,
    unifiedStatus: 'allowed', sessionWindowStated: true,
    modelWeekly: { '7d_oi': { utilization: 0.45, reset: T0 + 60 * HOUR } },
  });
  Object.assign(claude.usage, { totalInputTokens: 1200, totalOutputTokens: 340, totalRequests: 17, lastUsed: T0 - MIN });
  claude.inflight = 1;
  Object.assign(codex.quota, {
    unified5h: 0.15, unified7d: 0.2, unified5hReset: T0 + 2 * HOUR, unified7dReset: T0 + 70 * HOUR,
    unifiedStatus: 'allowed', codexUsageAt: T0 - 30 * SEC,
    codexResetCredits: 2, codexResetCreditsAt: T0 - 30 * SEC, codexResetCreditLastAt: T0 - 2 * HOUR,
    codexResetCreditLastOutcome: 'reset', codexResetCreditsConsumed: 1, codexResetCreditResetAt: T0 - 2 * HOUR,
    codexCredits: { balance: 1250, hasCredits: true, unlimited: false, overageLimitReached: false },
    codexCreditsAt: T0 - 30 * SEC,
  });
  Object.assign(codex.usage, { totalInputTokens: 800, totalOutputTokens: 90, totalRequests: 9, lastUsed: T0 - 2 * MIN });
  codex.inflight = 2;
  Object.assign(apikey.quota, {
    tokensLimit: 100000, tokensRemaining: 60000, requestsLimit: 1000, requestsRemaining: 700,
    resetsAt: iso(T0 + HOUR), tokensReset: iso(T0 + HOUR), requestsReset: iso(T0 + 2 * HOUR),
    apiSpendUsd: 3.5, apiUnpricedTokens: 12,
  });
  Object.assign(apikey.usage, { totalInputTokens: 300, totalOutputTokens: 40, totalRequests: 4, lastUsed: T0 - 3 * MIN });
  return am;
}

const statusOf = am => am.getStatus({ includeIdentity: true });

// ── 필드 경로: 실제 getStatus에서 모은다 ─────────────────────────────

const isPlainObject = v => v != null && typeof v === 'object' && !Array.isArray(v);

function collectFieldPaths(status) {
  const paths = Object.keys(status).filter(k => k !== 'accounts');
  const accountKeys = [];
  for (const account of status.accounts) {
    for (const k of Object.keys(account)) if (!accountKeys.includes(k)) accountKeys.push(k);
  }
  for (const k of accountKeys) {
    const nested = status.accounts.filter(a => isPlainObject(a[k]));
    if (nested.length === 0) { paths.push(`accounts.${k}`); continue; }
    const subKeys = [];
    for (const a of nested) for (const s of Object.keys(a[k])) if (!subKeys.includes(s)) subKeys.push(s);
    for (const s of subKeys) paths.push(`accounts.${k}.${s}`);
  }
  return paths;
}

function parsePath(path) {
  const parts = path.split('.');
  if (parts[0] !== 'accounts') return { scope: 'top', key: parts[0] };
  return { scope: 'account', key: parts[1], sub: parts[2] ?? null };
}

const MISSING = Symbol('missing');

function readField(status, path, index) {
  const p = parsePath(path);
  if (p.scope === 'top') return p.key in status ? status[p.key] : MISSING;
  const account = status.accounts[index];
  if (!account || !(p.key in account)) return MISSING;
  if (p.sub == null) return account[p.key];
  if (!isPlainObject(account[p.key]) || !(p.sub in account[p.key])) return MISSING;
  return account[p.key][p.sub];
}

function writeField(status, path, index, value) {
  const p = parsePath(path);
  if (p.scope === 'top') { status[p.key] = value; return; }
  const account = status.accounts[index];
  if (p.sub == null) account[p.key] = value;
  else account[p.key][p.sub] = value;
}

/** `from` → `to`로 바뀐 칸만 담은 패치. 메뉴바 fixture도 같은 형식을 쓴다. */
function diffPatch(from, to, paths) {
  const patch = [];
  for (const path of paths) {
    if (parsePath(path).scope === 'top') {
      const a = readField(from, path), b = readField(to, path);
      if (a !== MISSING && b !== MISSING && !isDeepStrictEqual(a, b)) patch.push({ field: path, value: b });
      continue;
    }
    for (let i = 0; i < Math.max(from.accounts.length, to.accounts.length); i++) {
      const a = readField(from, path, i), b = readField(to, path, i);
      if (a !== MISSING && b !== MISSING && !isDeepStrictEqual(a, b)) patch.push({ field: path, index: i, value: b });
    }
  }
  return patch;
}

function applyPatch(status, patch) {
  const out = structuredClone(status);
  for (const entry of patch) writeField(out, entry.field, entry.index, structuredClone(entry.value));
  return out;
}

// ── 표식 값: 기본은 타입에서 만든다. 파생값·열거형·빈 기본값만 아래 SCENARIOS가 정한다 ──

function genericSentinel(path, value, index) {
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') {
    if (value > 1e12) return value + SHIFT_MS;                 // ms 시각
    // 개수·한도: 두 배 + 37. 남은 양/한도 비율처럼 반올림된 % 표시에서도 차이가 보이게 크게 바꾼다.
    if (Number.isInteger(value)) return value * 2 + 37;
    if (value > 0 && value < 1) {                              // 비율
      return Math.round((value < 0.5 ? value + 0.4321 : value - 0.4321) * 1e4) / 1e4;
    }
    return value + 37;
  }
  if (typeof value === 'string') {
    if (ISO_RE.test(value) && Number.isFinite(Date.parse(value))) return iso(Date.parse(value) + SHIFT_MS);
    return `__TC_${path}_${index ?? 'top'}__`;
  }
  return undefined; // null · 객체 · 배열은 시나리오가 필요하다
}

/** 표식 값을 AccountManager 상태에 쓴다(상태 키가 status 키와 같은 경우). */
function genericStateWrite(am, path, index, value) {
  const p = parsePath(path);
  if (p.scope === 'top') {
    if (!(p.key in am)) return false;
    am[p.key] = value;
    return true;
  }
  const account = am.accounts[index];
  if (p.sub == null) {
    if (!(p.key in account)) return false;
    account[p.key] = value;
    return true;
  }
  if (p.key === 'quota' || p.key === 'usage') { account[p.key][p.sub] = value; return true; }
  return false;
}

const byName = (am, name) => am.accounts.find(a => a.name === name);
const codexOf = am => byName(am, 'acct-codex');
const apikeyOf = am => byName(am, 'acct-apikey');
const stub = (am, method, wrap) => { const orig = am[method].bind(am); am[method] = a => wrap(orig(a)); };
const endCancellation = a => {
  a.subscriptionCancellation = {
    status: 'ended', recordedAt: iso(T0 - DAY), endsAt: iso(T0 + 10 * DAY),
    endedAt: iso(T0 - HOUR), evidence: 'auth-failure-after-cancellation',
  };
};
const shiftCancellation = (key) => am => {
  const c = codexOf(am).subscriptionCancellation;
  c[key] = iso(Date.parse(c[key]) + SHIFT_MS);
};
const exhaustCredit = am => { const k = apikeyOf(am); k.creditExhausted = { reason: 'credit-exhausted', at: T0 }; k._creditFlagPersisted = true; };

// 시나리오: setup은 바탕·표식 양쪽에 적용하는 맥락(예: errorReason은 status가 error일 때만 실린다),
// mutate는 표식 쪽 상태만 바꾼다. payloadOnly는 상태 하나로 따로 움직일 수 없는 집계값이라
// 응답(JSON)에서만 바꾼다 — 계정 상태를 직접 그리는 TUI에는 주입 경로가 없다.
const SCENARIOS = {
  // 현재 계정의 이름·UUID는 currentIndex 하나에서 함께 나온다(독립 주입 불가 — TUI 판정은 연동으로 남는다).
  currentAccount: { mutate: am => { am.currentIndex = 1; } },
  currentAccountUuid: { mutate: am => { am.currentIndex = 1; } },
  // 현재 계정(0번)은 건드리지 않는다. 바꾸면 currentAccount·currentAccountUuid가 함께 바뀐다.
  'accounts.name': { mutate: am => am.accounts.forEach((a, i) => { if (i !== am.currentIndex) a.name = `__TC_accounts.name_${i}__`; }) },
  'accounts.accountUuid': {
    mutate: am => am.accounts.forEach((a, i) => { if (i !== am.currentIndex) a.accountUuid = `__TC_accounts.accountUuid_${i}__`; }),
  },
  // false가 되면 getStatus가 5시간 값(unified5h·리셋)을 비운다. 양쪽 모두 미측정에서 시작해 이 필드만 바뀌게 한다.
  'accounts.quota.sessionWindowStated': {
    setup: am => { Object.assign(byName(am, 'acct-claude').quota, { unified5h: null, unified5hReset: null }); },
    mutate: am => { byName(am, 'acct-claude').quota.sessionWindowStated = false; },
  },
  // 문턱이 일부 계정 사용률(Claude 25%/35%) 아래로 내려와야 문턱을 쓰는 표시(한도 판정·호박색)가 바뀐다.
  switchThreshold: { mutate: am => { am.switchThreshold = 0.3; } },
  usableCount: { payloadOnly: v => v + 37 },
  creditBackedCount: { payloadOnly: v => v + 37 },
  totalCount: { payloadOnly: v => v + 37 },
  'accounts.status': { mutate: am => am.accounts.forEach(a => { a.status = 'throttled'; }) },
  'accounts.errorReason': {
    setup: am => am.accounts.forEach(a => { a.status = 'error'; a.errorReason = 'auth-revoked'; }),
    mutate: am => am.accounts.forEach(a => { a.errorReason = 'subscription-disabled'; }),
  },
  'accounts.subscription.state': { mutate: am => endCancellation(codexOf(am)) },
  'accounts.subscription.endsAt': { mutate: shiftCancellation('endsAt') },
  'accounts.subscription.recordedAt': { mutate: shiftCancellation('recordedAt') },
  'accounts.subscription.endedAt': { setup: am => endCancellation(codexOf(am)), mutate: shiftCancellation('endedAt') },
  'accounts.subscription.evidence': { mutate: am => endCancellation(codexOf(am)) },
  'accounts.usable': { mutate: am => stub(am, '_isUsableNow', v => !v) },
  'accounts.creditBacked': { mutate: am => stub(am, '_isCreditBackedNow', v => !v) },
  'accounts.creditRecoverable': { mutate: am => stub(am, '_creditPathRecoverable', v => !v) },
  'accounts.creditRefusedUntil': { mutate: am => { codexOf(am)._creditRefusedUntil = T0 + 2 * HOUR; } },
  'accounts.priority': { mutate: am => am.accounts.forEach(a => { a.priority = a.priority == null ? 2 : 1 - a.priority; }) },
  'accounts.rateLimitedUntil': { mutate: am => am.accounts.forEach(a => { a.rateLimitedUntil = T0 + 2 * HOUR; }) },
  'accounts.unsupportedModels': {
    mutate: am => am.accounts.forEach(a => { a.unsupportedModels = new Map([['__TC_unsupportedModels__', T0]]); }),
  },
  'accounts.quota.unifiedStatus': { mutate: am => am.accounts.forEach(a => { if (a.quota.unifiedStatus) a.quota.unifiedStatus = 'allowed_warning'; }) },
  'accounts.quota.codexResetCreditLastOutcome': { mutate: am => { codexOf(am).quota.codexResetCreditLastOutcome = 'no_credit'; } },
  'accounts.quota.modelWeekly': {
    mutate: am => { byName(am, 'acct-claude').quota.modelWeekly = { '7d_oi': { utilization: 0.8765, reset: T0 + 60 * HOUR + SHIFT_MS } }; },
  },
  'accounts.quota.codexCredits': {
    mutate: am => { codexOf(am).quota.codexCredits = { ...codexOf(am).quota.codexCredits, balance: 98765 }; },
  },
  'accounts.credit.usd': { mutate: am => { apikeyOf(am).creditUsd = 87; } },
  'accounts.credit.spentUsd': { mutate: am => { apikeyOf(am).quota.apiSpendUsd = 40.5; } },
  'accounts.credit.remainingUsd': { mutate: am => { apikeyOf(am).creditUsd = 87; } },
  'accounts.credit.since': { mutate: am => { apikeyOf(am).creditSince += SHIFT_MS; } },
  'accounts.credit.expiresAt': { mutate: am => { apikeyOf(am).creditExpiresAt += SHIFT_MS; } },
  'accounts.credit.exhausted': { mutate: exhaustCredit },
  'accounts.credit.exhaustedReason': { setup: exhaustCredit, mutate: am => { apikeyOf(am).creditExhausted.reason = 'billing'; } },
  'accounts.credit.persistFailed': { setup: exhaustCredit, mutate: am => { apikeyOf(am)._creditFlagPersisted = false; } },
  'accounts.credit.unpricedTokens': { mutate: am => { apikeyOf(am).quota.apiUnpricedTokens += 37; } },
};

/** 값이 비지 않은 칸에 타입 기반 표식을 넣는 기본 시나리오. 넣을 칸이 없으면 null. */
function genericScenario(path, base) {
  const p = parsePath(path);
  const indices = p.scope === 'top' ? [undefined] : base.accounts.map((_, i) => i);
  const writes = [];
  for (const i of indices) {
    const v = readField(base, path, i);
    if (v === MISSING || v == null) continue;
    const sentinel = genericSentinel(path, v, i);
    if (sentinel !== undefined) writes.push({ index: i, value: sentinel });
  }
  if (writes.length === 0) return null;
  return {
    mutate: am => {
      for (const w of writes) {
        if (!genericStateWrite(am, path, w.index, w.value)) throw new Error(`${path}: 상태 키가 없어 기본 표식을 쓸 수 없음`);
      }
    },
  };
}

// 다른 필드에서 계산되는 파생값. 바꾼 필드의 함수라 따라 바뀌는 게 정상이고, 그 표시 변화는 바꾼 필드의
// 표시 효과다. 그래서 "연동"으로 세지 않는다. 반대로 이 필드 자체를 바꾸는 시나리오는 메서드 stub이라 입력이 따로 안 바뀐다.
const DERIVED_FIELDS = new Set([
  'usableCount', 'creditBackedCount', 'totalCount',
  'accounts.usable', 'accounts.creditBacked', 'accounts.creditRecoverable', 'accounts.credit.remainingUsd',
]);

/**
 * 필드 하나의 바탕/표식 쌍. 응답 소비자(CLI·메뉴바)에는 바탕 응답에서 그 필드 칸만 바꾼 응답을,
 * TUI에는 바탕·표식 AccountManager 쌍을 준다.
 */
function buildCase(path, defaultBase, paths) {
  const scenario = SCENARIOS[path] ?? genericScenario(path, defaultBase);
  if (!scenario) throw new Error(`${path}: 표식 시나리오 없음 — test/status-consumer-map.test.js SCENARIOS에 추가`);
  const baseAm = buildManager();
  scenario.setup?.(baseAm);
  const base = statusOf(baseAm);
  let patch;
  let variantAm = null;
  let coupled = [];
  if (scenario.payloadOnly) {
    patch = [{ field: path, value: scenario.payloadOnly(readField(base, path)) }];
  } else {
    variantAm = buildManager();
    scenario.setup?.(variantAm);
    scenario.mutate(variantAm, base);
    const variantStatus = statusOf(variantAm);
    patch = diffPatch(base, variantStatus, [path]);
    if (patch.length === 0) throw new Error(`${path}: 표식 주입이 getStatus 값을 바꾸지 못함 — SCENARIOS 확인`);
    // 같은 주입으로 함께 바뀐 다른(파생 아닌) 필드. 있으면 TUI 화면 차이가 이 필드 때문인지 가릴 수 없다.
    coupled = [...new Set(diffPatch(base, variantStatus, paths).map(e => e.field))]
      .filter(f => f !== path && !DERIVED_FIELDS.has(f));
  }
  return {
    field: path,
    coupled,
    basePatch: diffPatch(defaultBase, base, paths),
    patch,
    base,
    variant: applyPatch(base, patch),
    baseAm,
    variantAm,
  };
}

let cachedMap = null;
function statusMap() {
  if (cachedMap) return cachedMap;
  const defaultBase = statusOf(buildManager());
  const paths = collectFieldPaths(defaultBase);
  const cases = paths.map(path => buildCase(path, defaultBase, paths));
  cachedMap = { defaultBase, paths, cases };
  return cachedMap;
}

function fixtureContent() {
  const { defaultBase, paths, cases } = statusMap();
  const fixture = {
    _comment: 'test/status-consumer-map.test.js가 실제 AccountManager.getStatus로 생성한다. 손으로 고치지 말고 '
      + 'TC_UPDATE_STATUS_SENTINEL=1 node --test test/status-consumer-map.test.js 로 갱신한다.',
    now: iso(T0),
    fields: paths,
    baseline: defaultBase,
    variants: cases.map(c => ({ field: c.field, basePatch: c.basePatch, patch: c.patch })),
  };
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

// ── 예외 원장 ──────────────────────────────────────────────

const CONSUMERS = Object.keys(CONSUMER_FILES);
const today = () => new Date().toISOString().slice(0, 10);

async function loadExemptions() {
  return JSON.parse(await readFile(EXEMPTIONS_PATH, 'utf8'));
}

function isExempt(exemptions, field, consumer) {
  return exemptions.some(e => e.field === field && e.consumer === consumer);
}

function missingMessage(field, consumer) {
  return `${field} 누락: ${consumer} — 대신 ${CONSUMER_FILES[consumer]}에 표시 지점을 추가하거나 exemptions에 사유·만료·승인 등록`;
}

/**
 * shownByField 값: true(표시) · false(표시 안 함) · { coupled: [...] }(화면은 바뀌었지만 다른 필드가 함께 바뀌어
 * 이 필드 때문인지 가릴 수 없음). 연동은 표시로 세지 않는다 — 단독 시나리오를 만들거나 예외 원장에 연동 사유를 단다.
 */
function judge(consumer, shownByField, exemptions) {
  const failures = [];
  for (const [field, shown] of shownByField) {
    const exempt = isExempt(exemptions, field, consumer);
    if (shown?.coupled) {
      if (!exempt) {
        failures.push(`${field} 독립 주입 불가: ${consumer} — ${shown.coupled.join(', ')}와 함께 바뀜. `
          + 'SCENARIOS에 그 필드만 바꾸는 시나리오를 만들거나 exemptions에 연동 사유 등록');
      }
      continue;
    }
    if (!shown && !exempt) failures.push(missingMessage(field, consumer));
    if (shown && exempt) failures.push(`${field} 불필요한 예외: ${consumer}가 이미 표시함 — exemptions에서 제거`);
  }
  return failures;
}

// ── CLI 렌더: 가짜 프록시가 표식 status를 응답한다 ─────────────────────────

function runCli(cliArgs, env) {
  return new Promise(resolve => {
    execFile(process.execPath, cliArgs, { encoding: 'utf8', env }, (err, stdout, stderr) =>
      resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}

async function renderCli(payload) {
  const server = createServer((req, res) => {
    if (!req.url.startsWith('/teamclaude/status')) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-consumer-map-'));
  const configPath = join(dir, 'teamclaude.json');
  await writeFile(configPath, JSON.stringify({
    provider: 'anthropic',
    proxy: { port: server.address().port, apiKey: 'k' },
    accounts: [],
  }, null, 2));
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
  delete env.TEAMCLAUDE_PROVIDER;
  try {
    const res = await runCli([ENTRY, 'status'], env);
    if (res.status !== 0 || /unreachable/.test(res.stdout)) {
      throw new Error(`status CLI 렌더 실패(exit ${res.status})\n${res.stdout}\n${res.stderr}`);
    }
    // 가짜 프록시 포트는 실행마다 다르다. 필드 표시와 무관한 줄 차이를 없앤다.
    return res.stdout.replace(/\bport \d+/g, 'port N').replace(/\bpid \d+/g, 'pid N');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ── TUI 렌더: 실제 render()가 stdout에 쓰는 프레임을 캡처 ─────────────────────

const FIXED_HOST = { cpu: { usedPct: 12, loadavg: [0.5], cores: 8 }, memory: { usedPct: 40, usedBytes: 4, totalBytes: 10 } };

function renderTui(am) {
  const tui = new TUI({
    accountManager: am,
    config: { provider: 'anthropic', proxy: { port: 3456 }, accounts: [] },
    saveConfig: async () => {},
    syncAccounts: async () => 0,
    onQuit: () => {},
  });
  // 헤더의 호스트 CPU/RAM은 렌더마다 달라지는 실측값이라 고정한다(필드 표시와 무관).
  tui._host = { sample: () => FIXED_HOST };
  tui.running = true;
  const stdout = process.stdout;
  const saved = {
    write: stdout.write,
    columns: Object.getOwnPropertyDescriptor(stdout, 'columns'),
    rows: Object.getOwnPropertyDescriptor(stdout, 'rows'),
  };
  let frame = '';
  // 가장 넓은 배치(막대 3개 + 크레딧 칸)로 그린다.
  Object.defineProperty(stdout, 'columns', { value: 160, configurable: true, writable: true });
  Object.defineProperty(stdout, 'rows', { value: 40, configurable: true, writable: true });
  stdout.write = chunk => { frame += String(chunk); return true; };
  try {
    tui.render();
  } finally {
    stdout.write = saved.write;
    for (const key of ['columns', 'rows']) {
      if (saved[key]) Object.defineProperty(stdout, key, saved[key]);
      else delete stdout[key];
    }
  }
  return frame;
}

// ── 테스트 ──────────────────────────────────────────────────

test('표식 fixture가 실제 getStatus 필드·값과 일치한다(메뉴바 사본 드리프트 방지)', async () => {
  const content = fixtureContent();
  if (process.env.TC_UPDATE_STATUS_SENTINEL === '1') await writeFile(FIXTURE_PATH, content);
  let onDisk = null;
  try { onDisk = await readFile(FIXTURE_PATH, 'utf8'); } catch {}
  assert.ok(onDisk != null, `${FIXTURE_PATH} 없음 — TC_UPDATE_STATUS_SENTINEL=1 로 생성`);
  const diskFields = JSON.parse(onDisk).fields;
  const { paths } = statusMap();
  assert.deepEqual(diskFields, paths,
    '메뉴바 표식 fixture의 필드 목록이 실제 getStatus 키와 다름 — TC_UPDATE_STATUS_SENTINEL=1 로 갱신');
  assert.equal(onDisk, content,
    '메뉴바 표식 fixture 내용이 실제 getStatus 결과와 다름 — TC_UPDATE_STATUS_SENTINEL=1 로 갱신');
});

test('필드 목록은 실제 getStatus에서 나오고 모든 필드에 표식 시나리오가 있다', () => {
  const { paths, cases } = statusMap();
  assert.ok(paths.includes('switchThreshold') && paths.includes('accounts.quota.unified5h'),
    `getStatus 키 수집이 비정상: ${paths.join(', ')}`);
  assert.equal(cases.length, paths.length);
  // 시나리오 표에 실제로 없는 필드가 남아 있으면(필드 삭제·개명) 지운다.
  const stale = Object.keys(SCENARIOS).filter(k => !paths.includes(k));
  assert.deepEqual(stale, [], `getStatus에 없는 필드의 시나리오: ${stale.join(', ')}`);
});

test('예외 원장 형식·만료 검사(만료는 실패, 승인 대기는 경고)', async t => {
  const exemptions = await loadExemptions();
  const { paths } = statusMap();
  assert.ok(Array.isArray(exemptions), 'exemptions는 배열이어야 함');
  const problems = [];
  const seen = new Set();
  for (const e of exemptions) {
    const id = `${e?.field}/${e?.consumer}`;
    if (!e || typeof e !== 'object') { problems.push(`잘못된 항목: ${JSON.stringify(e)}`); continue; }
    if (!paths.includes(e.field)) problems.push(`${id}: getStatus에 없는 필드`);
    if (!CONSUMERS.includes(e.consumer)) problems.push(`${id}: 알 수 없는 consumer (${CONSUMERS.join('|')})`);
    if (typeof e.reason !== 'string' || !e.reason.trim()) problems.push(`${id}: reason 없음`);
    if (/\/Users\/|\/home\//.test(e.reason ?? '')) problems.push(`${id}: reason에 로컬 경로 금지`);
    if (typeof e.approved_by !== 'string' || !e.approved_by.trim()) problems.push(`${id}: approved_by 없음`);
    if (typeof e.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.expires)) problems.push(`${id}: expires는 YYYY-MM-DD`);
    else if (e.expires < today()) problems.push(`${id}: 예외 만료(${e.expires}) — 표시를 추가하거나 사유를 재승인`);
    if (seen.has(id)) problems.push(`${id}: 중복 항목`);
    seen.add(id);
  }
  assert.deepEqual(problems, []);
  const pending = exemptions.filter(e => e.approved_by === 'pending');
  if (pending.length > 0) {
    t.diagnostic(`경고: status 소비자 예외 ${pending.length}건 승인 대기(approved_by=pending) — ${EXEMPTIONS_PATH.replace(/^.*\/(test\/)/, '$1')}`);
  }
});

test('CLI status 출력이 getStatus 필드를 표시한다', async () => {
  const { defaultBase, cases } = statusMap();
  const exemptions = await loadExemptions();
  const cache = new Map();
  const render = payload => {
    const key = JSON.stringify(payload);
    if (!cache.has(key)) cache.set(key, renderCli(payload));
    return cache.get(key);
  };
  // 바탕 응답이 실제로 그려지는지(서버 줄·계정 줄) 먼저 확인한다.
  const baseline = await render(defaultBase);
  assert.match(baseline, /acct-claude/);
  const outputs = await mapLimit(cases, 6, async c => [await render(c.base), await render(c.variant)]);
  const shown = cases.map((c, i) => [c.field, outputs[i][0] !== outputs[i][1]]);
  assert.deepEqual(judge('cli', shown, exemptions), []);
});

test('TUI 화면이 getStatus 필드를 표시한다', async () => {
  const { cases } = statusMap();
  const exemptions = await loadExemptions();
  const baseline = renderTui(buildManager());
  assert.match(baseline, /acct-claude/);
  const shown = cases.map(c => {
    // 상태 하나로 따로 움직일 수 없는 집계값(payloadOnly)은 TUI에 주입 경로가 없다 = 표시하지 않음.
    if (!c.variantAm) return [c.field, false];
    // 바탕을 매번 다시 그려 시각에 따른 리셋 카운트다운 차이를 없앤다.
    const changed = renderTui(c.baseAm) !== renderTui(c.variantAm);
    // TUI는 응답이 아니라 계정 상태를 그린다. 같은 주입으로 다른 필드도 바뀌었으면 차이의 원인을 가릴 수 없다.
    return [c.field, changed && c.coupled.length > 0 ? { coupled: c.coupled } : changed];
  });
  assert.deepEqual(judge('tui', shown, exemptions), []);
});
