(function (root) {
  'use strict';
  const fields = ['fresh', 'write', 'cached', 'output'];
  const valid = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1e6;
  const validRates = r => !!r && fields.every(k => valid(r[k]));
  function calculate(rows, catalog, overrides = {}, scenario = {}) {
    const result = { usd: 0, covered: 0, missing: 0, total: 0, missingModels: new Set() };
    for (const row of rows) {
      const usages = row.modelUsage || (row.model ? [row] : []);
      if (!usages.length && row.total > 0) { result.missing += row.total; result.total += row.total; result.missingModels.add('모델 분해 없음'); }
      for (const u of usages) {
        const key = u.vendor + ':' + u.model, custom = overrides[key];
        let r = catalog[key];
        if (r && scenario.context === 'long' && r.long) r = r.long;
        if (r && scenario.cache === '1h' && r.write1h !== undefined) r = { ...r, write: r.write1h };
        if (custom) r = custom;
        const total = u.total || 0;
        result.total += total;
        if (!validRates(r)) { result.missing += total; if (total > 0) result.missingModels.add(key); continue; }
        result.covered += total;
        for (const k of fields) result.usd += (u[k] || 0) * r[k] / 1e6;
      }
    }
    return result;
  }
  function money(usd, currency, fx) {
    if (!Number.isFinite(usd)) return '계산 불가';
    if (currency === 'KRW' && !(Number.isFinite(fx) && fx > 0 && fx <= 1e6)) return '환율 미설정';
    return new Intl.NumberFormat('ko-KR', { style: 'currency', currency,
      minimumFractionDigits: currency === 'KRW' ? 0 : 2, maximumFractionDigits: currency === 'KRW' ? 0 : 2 }).format(currency === 'KRW' ? usd * fx : usd);
  }
  root.PriceCore = { calculate, money, validRates, fields };
})(globalThis);
