// TUI 소비 지점(B10): API 키 행에 추정 남은 금액·만료일·소진을 한 줄로 그린다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';
import { formatApiCreditCompact } from '../src/api-credit.js';

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const HOUR = 3600_000;

function setup(accounts) {
  const am = new AccountManager(accounts, 0.98, 0, 3);
  const tui = new TUI({ accountManager: am, config: { accounts: [] }, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {} });
  return { am, tui };
}

test('formatApiCreditCompact: 남은/충전, 소진, 충전 미입력', () => {
  assert.equal(formatApiCreditCompact({ usd: 50, spentUsd: 37.7, exhausted: false }), '$12.3/50');
  assert.equal(formatApiCreditCompact({ usd: 2500, spentUsd: 300, exhausted: false }), '$2.2k/2.5k');
  assert.equal(formatApiCreditCompact({ usd: 150, spentUsd: 10, exhausted: false }), '$140/150');
  assert.equal(formatApiCreditCompact({ usd: 10, spentUsd: 15, exhausted: false }), '$0/10');
  assert.equal(formatApiCreditCompact({ usd: null, spentUsd: 1.5, exhausted: false }), 'sp $1.5');
  assert.equal(formatApiCreditCompact({ usd: 50, spentUsd: 0, exhausted: true }), 'out');
  assert.equal(formatApiCreditCompact(null), '-');
});

test('TUI: API 키 행은 Cr 칸에 남은 금액, 뒤에 추정 표시와 만료일을 붙인다', () => {
  const expires = new Date(2026, 11, 31, 23, 59, 59, 999).getTime();
  const { am, tui } = setup([
    { name: 'sub-1', type: 'oauth', accessToken: 'tok-1', refreshToken: 'r', expiresAt: Date.now() + HOUR },
    { name: 'api-1', type: 'apikey', apiKey: 'test-key-tui-1', creditUsd: 50, creditSince: 1, creditExpiresAt: expires },
  ]);
  const api = am.accounts[1];
  api.quota.apiSpendUsd = 37.7;
  for (const [showBoth, showThree] of [[true, true], [true, false], [false, false]]) {
    const row = stripAnsi(tui._renderAcct(api, 1, 10, showBoth, showThree));
    assert.match(row, /Cr\s+\$12\.3\/50/, `showThree=${showThree}`);
    assert.match(row, /est\. exp 2026-12-31/);
    assert.equal(row.includes('test-key'), false);
  }
  // 넓은 화면에서 Cr 칸은 고정 폭이라 구독 행과 같은 지점까지 정렬된다.
  const subRow = stripAnsi(tui._renderAcct(am.accounts[0], 0, 10, true, true));
  const apiRow = stripAnsi(tui._renderAcct(api, 1, 10, true, true));
  assert.equal(apiRow.indexOf(' est.'), subRow.length, '추정 표시는 고정 칸 뒤에 붙는다');
});

test('TUI: 크레딧 소진 키는 상태 no credit, Cr 칸 out', () => {
  const { am, tui } = setup([
    { name: 'api-1', type: 'apikey', apiKey: 'test-key-tui-2', creditExhausted: { reason: 'billing', at: 1 } },
  ]);
  const row = stripAnsi(tui._renderAcct(am.accounts[0], 0, 10, true, true));
  assert.match(row, /no credit/);
  assert.match(row, /Cr\s+out/);
});

test('TUI: 구독 계정 행에는 크레딧 표시가 없다', () => {
  const { am, tui } = setup([
    { name: 'sub-1', type: 'oauth', accessToken: 'tok-1', refreshToken: 'r', expiresAt: Date.now() + HOUR },
  ]);
  const row = stripAnsi(tui._renderAcct(am.accounts[0], 0, 10, true, true));
  assert.doesNotMatch(row, /Cr\s/);
  assert.doesNotMatch(row, /est\./);
});
