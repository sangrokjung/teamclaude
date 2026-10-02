import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ Intl });
vm.runInContext(readFileSync(new URL('../assets/pricing-core.js', import.meta.url), 'utf8'), context);
const core = context.PriceCore;
const rates = { fresh: 2, write: 3, cached: 0.2, output: 10, write1h: 4,
  long: { fresh: 4, write: 6, cached: 0.4, output: 15 } };
const rows = [{ vendor: 'Codex', model: 'fixture', fresh: 1e6, write: 1e6, cached: 1e6, output: 1e6, total: 4e6 }];
test('four components, cache scenarios and custom rates', () => {
  assert.equal(core.calculate(rows, { 'Codex:fixture': rates }).usd, 15.2);
  assert.equal(core.calculate(rows, { 'Codex:fixture': rates }, {}, { cache: '1h' }).usd, 16.2);
  assert.equal(core.calculate(rows, { 'Codex:fixture': rates }, {}, { context: 'long' }).usd, 25.4);
  assert.equal(core.calculate(rows, {}, { 'Codex:fixture': { fresh: 0, write: 0, cached: 0, output: 0 } }).covered, 4e6);
});
test('unknown prices remain missing; invalid FX is never zero won', () => {
  const result = core.calculate(rows, {});
  assert.equal(result.missing, 4e6);
  assert.equal(result.covered, 0);
  assert.equal(core.money(10, 'KRW', null), '환율 미설정');
  assert.equal(core.money(10, 'KRW', 1400), '₩14,000');
  assert.equal(core.validRates({ ...rates, fresh: NaN }), false);
});
test('all browser scripts parse without runtime dependencies', () => {
  for (const file of ['insights.js', 'trends.js', 'pricing-ui.js', 'share.js']) {
    new vm.Script(readFileSync(new URL('../assets/' + file, import.meta.url), 'utf8'));
  }
});
