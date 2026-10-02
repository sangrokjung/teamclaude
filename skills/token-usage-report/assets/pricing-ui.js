(() => {
  'use strict';
  const STORE = 'token-report-prices-v2';
  const fields = PriceCore.fields;
  const labels = ['입력', '캐시 생성', '캐시 읽기', '출력'];
  let catalog, fxSource, loadError = '', storageError = '';
  let state = { on: false, currency: 'USD', fx: null, manualFx: false, overrides: {}, context: 'short', cache: '5m' };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved && typeof saved === 'object') {
      state.on = saved.on === true;
      state.currency = saved.currency === 'KRW' ? 'KRW' : 'USD';
      state.fx = Number.isFinite(saved.fx) && saved.fx > 0 && saved.fx <= 1e6 ? saved.fx : null;
      state.manualFx = saved.manualFx === true && state.fx !== null;
      state.context = saved.context === 'long' ? 'long' : 'short';
      state.cache = saved.cache === '1h' ? '1h' : '5m';
      for (const [key, rate] of Object.entries(saved.overrides || {})) if (PriceCore.validRates(rate)) state.overrides[key] = rate;
    }
  } catch (_) { storageError = '브라우저 저장소를 읽지 못했습니다. 현재 탭에서 설정할 수 있습니다.'; }
  const panel = document.createElement('section');
  panel.id = 'pricing-panel'; panel.className = 'card panel';
  panel.innerHTML = `
    <div class="panel-head"><div><h2>토큰을 가격으로 환산</h2><p class="price-note">공식 API 단가로 계산하는 비교용 추정액입니다. 실제 구독 청구액과 다릅니다.</p></div>
      <button id="price-toggle" type="button" aria-pressed="false" disabled>가격표 불러오는 중</button></div>
    <div id="cost-toolbar" class="price-controls">
      <label for="currency">표시 통화 <select id="currency"><option value="USD">USD · 달러</option><option value="KRW">KRW · 원화</option></select></label>
      <label for="fx-rate">1 USD = <input id="fx-rate" type="number" min="0.000001" max="1000000" step="any" required> 원</label>
      <button id="fx-reset" type="button">조회 환율 복원</button><span id="fx-status"></span>
    </div>
    <p id="price-status" role="status" aria-live="polite"></p>
    <div id="cost-summary"></div><details id="model-breakdown"><summary>모델별 토큰·환산액 펼치기</summary><div id="model-costs" class="tablewrap"></div></details>
    <details id="price-settings"><summary>계산 기준·모델별 단가 설정</summary>
      <p class="price-note">단위: USD / 100만 토큰. 기준일 현재 정가를 선택 기간 전체에 적용합니다. 직접 입력한 단가는 선택한 시나리오보다 우선합니다.</p>
      <div class="price-controls"><label for="context-price">OpenAI 컨텍스트 가정 <select id="context-price"><option value="short">짧은 컨텍스트</option><option value="long">긴 컨텍스트</option></select></label>
        <label for="cache-price">Claude 캐시 생성 가정 <select id="cache-price"><option value="5m">5분 보관</option><option value="1h">1시간 보관</option></select></label></div>
      <p class="price-note">원천 집계에 요청별 서비스 등급·캐시 보관시간이 없으므로 위 가정을 일괄 적용합니다. Fast·우선 처리·지역 추가 요금·도구 호출료·세금은 미포함입니다. 캐시 제외 토큰을 선택해도 환산액에는 캐시 비용을 포함합니다.</p>
      <div class="tablewrap"><table id="price-table"><thead><tr><th>모델</th><th>입력</th><th>캐시 생성</th><th>캐시 읽기</th><th>출력</th><th>적용</th></tr></thead><tbody></tbody></table></div>
      <p id="price-source" class="price-source"></p>
    </details>`;
  const kpis = document.querySelector('#kpis');
  kpis.parentNode.insertBefore(panel, kpis);
  const el = id => panel.querySelector('#' + id);
  const keyOf = r => r.vendor + ':' + r.model;
  const compute = rows => PriceCore.calculate(rows, catalog.models, state.overrides, state);
  const money = usd => PriceCore.money(usd, state.currency, state.fx);
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); storageError = ''; }
    catch (_) { storageError = '설정 저장 실패: 현재 탭에서만 적용됩니다.'; }
  }
  function costText(rows, divisor = 1) {
    const r = compute(rows);
    if (r.missing && !r.covered) return '가격 미등록';
    return (r.missing ? '일부 ' : '') + money(r.usd / divisor);
  }
  function addCost(node, rows, divisor = 1, suffix = '') {
    if (!node) return;
    const value = document.createElement('span');
    value.className = 'cost-value'; value.textContent = costText(rows, divisor) + suffix;
    node.append(value);
  }
  function effectiveRate(row) {
    const key = keyOf(row);
    if (state.overrides[key]) return state.overrides[key];
    const base = catalog.models[key];
    if (!base) return null;
    let rate = state.context === 'long' && base.long ? base.long : base;
    if (state.cache === '1h' && rate.write1h !== undefined) rate = { ...rate, write: rate.write1h };
    return rate;
  }
  function drawPricing() {
    el('currency').value = state.currency;
    el('fx-rate').value = state.fx ?? '';
    el('context-price').value = state.context;
    el('cache-price').value = state.cache;
    el('price-status').textContent = loadError || storageError;
    if (!catalog || !D) return;
    el('price-toggle').disabled = false;
    el('price-toggle').textContent = state.on ? '가격 숨기기' : '가격 표시';
    el('price-toggle').classList.toggle('active', state.on);
    el('price-toggle').setAttribute('aria-pressed', String(state.on));
    const asOf = fxSource.asOf ? new Date(fxSource.asOf).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '';
    el('fx-status').textContent = !state.fx ? '환율 미설정 · 원화 환산하려면 입력하세요' : state.manualFx ? '직접 입력 환율' : fxSource.source === 'manual' ? '생성 시 지정한 환율' : '조회 기준 ' + asOf + ' KST · 실시간 아님';
    const w = D.windows[H], rows = list(w.models).filter(r => r.total > 0), total = compute(rows);
    const coverage = total.total ? (total.covered / total.total * 100).toFixed(2) : '0.00';
    el('cost-summary').hidden = !state.on;
    el('model-breakdown').hidden = !state.on;
    el('model-costs').hidden = !state.on;
    el('cost-summary').innerHTML = `<div class="price-summary">
      <div><span>${total.missing ? '등록 모델 환산 소계' : '전체 환산 추정액'}</span><strong>${esc(costText(rows))}</strong></div>
      <div><span>시간당 환산 속도</span><strong>${esc(costText(rows, Number(H)))}/h</strong></div>
      <div><span>단가 확인 범위 · 토큰 기준</span><strong>${coverage}%</strong></div></div>
      <p class="price-note">${esc(state.context === 'long' ? 'OpenAI 긴 컨텍스트' : 'OpenAI 짧은 컨텍스트')} · Claude 캐시 ${state.cache === '1h' ? '1시간' : '5분'} 가정 · ${esc(catalog.asOf)} 정가${M === 'noncached' ? ' · 표시 토큰은 캐시 제외, 환산액은 캐시 비용 포함' : ''}</p>
      ${total.missing ? '<p class="cost-warning">미등록 ' + esc(f(total.missing)) + ' 토큰 제외: ' + esc([...total.missingModels].join(', ')) + '</p>' : ''}`;
    el('model-costs').innerHTML = '<table><thead><tr><th>모델별 사용량</th><th class="num">처리 토큰 · 환산액</th><th class="num">캐시 읽기 비중</th><th>단가 출처</th></tr></thead><tbody>' + rows.map(r =>
      '<tr><td>' + esc(r.vendor + ' · ' + r.model) + '</td><td class="num">' + f(r.total) + '<span class="cost-value">' + esc(costText([r])) + '</span></td><td class="num">' + (r.cached / r.total * 100).toFixed(1) + '%</td><td>' + (state.overrides[keyOf(r)] ? '직접 입력' : effectiveRate(r) ? '공식 가격표' : '가격 미등록') + '</td></tr>').join('') + '</tbody></table>';
    el('price-table').querySelector('tbody').innerHTML = rows.map(r => {
      const key = keyOf(r), rate = effectiveRate(r);
      return '<tr data-key="' + esc(key) + '"><td>' + esc(r.model) + '<small>' + (state.overrides[key] ? '직접 입력' : rate ? '공식 가격표' : '가격 미등록') + '</small></td>' + fields.map((field, i) =>
        '<td><input type="number" required min="0" max="1000000" step="any" data-field="' + field + '" value="' + (rate ? rate[field] : '') + '" aria-label="' + esc(r.model + ' ' + labels[i] + ' 단가') + '"></td>').join('') +
        '<td><button type="button" data-save>저장</button> <button type="button" data-reset>기본값</button></td></tr>';
    }).join('');
    el('price-source').innerHTML = '단가 기준 ' + esc(catalog.asOf || '사용자 가격표') + ' · <a href="https://platform.claude.com/docs/en/about-claude/pricing" target="_blank" rel="noreferrer">Claude 공식 가격표</a> · <a href="https://openai.com/api/pricing/" target="_blank" rel="noreferrer">OpenAI 공식 가격표</a> · 환율 <a href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer">ExchangeRate-API</a> (선택 조회, 환전 수수료 미포함)';
  }
  function annotate() {
    if (!state.on || !catalog || !D) return;
    const w = D.windows[H], vs = list(w.vendors);
    const projects = list(w.projects).sort((a, b) => metric(b) - metric(a));
    const matches = (x, category = false) => (category ? [x.project, x.branch, x.task, x.id, x.category].join(' ') : x.project + ' ' + x.branch + ' ' + x.task + ' ' + x.id).toLowerCase().includes(Q.toLowerCase());
    const sessions = list(w.sessions).filter(x => matches(x)).sort((a, b) => metric(b) - metric(a));
    const cards = document.querySelectorAll('#kpis .kpi');
    addCost(cards[0], vs); if (projects[0]) addCost(cards[1], [projects[0]]);
    addCost(cards[2], vs, Number(H), '/h'); addCost(cards[3], list(D.windows['1'].vendors), 1, '/h');
    document.querySelectorAll('#projects .bar .meta').forEach((node, i) => addCost(node, [projects[i]]));
    document.querySelectorAll('#sessions tr').forEach((node, i) => { if (sessions[i]) { addCost(node.cells[5], [sessions[i]]); addCost(node.cells[7], [sessions[i]], Number(H), '/h'); } });
    document.querySelectorAll('.ins-cat').forEach(node => {
      const name = node.querySelector('.ins-name').textContent;
      addCost(node.querySelector('.ins-val'), list(w.categories).filter(r => r.category === name));
    });
    document.querySelectorAll('.ins-col').forEach((node, h) => {
      const rows = list(w.hourOfDay).filter(r => r.hour === h);
      if (!rows.some(r => r.exposureHours > 0 && r.requests > 0)) return;
      node.dataset.tip += ' · ' + costText(rows); node.setAttribute('aria-label', node.dataset.tip);
    });
    document.querySelectorAll('.ins-tc').forEach(node => {
      const match = node.querySelector('small').textContent.match(/· (\d{2}):/);
      if (match) addCost(node.querySelector('b'), list(w.hourOfDay).filter(r => r.hour === Number(match[1])));
    });
    document.querySelectorAll('.ins-cell[data-tip]').forEach(node => {
      const match = node.dataset.tip.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):/);
      if (match && !node.classList.contains('no-record')) { node.dataset.tip += ' · ' + costText(list(w.dailyHours).filter(r => r.date === match[1] && r.hour === Number(match[2]))); node.setAttribute('aria-label', node.dataset.tip); }
    });
    const evidenceSessions = list(w.sessions).filter(x => matches(x, true)).sort((a, b) => metric(b) - metric(a));
    document.querySelectorAll('#insights tbody').forEach(body => {
      if (body.querySelector('.ins-basis')) body.querySelectorAll('tr').forEach((row, i) => addCost(row.cells[5], [evidenceSessions[i]]));
      else body.querySelectorAll('tr').forEach(row => {
        if (row.cells.length !== 5) return;
        addCost(row.cells[2], list(w.dailyHours).filter(r => r.date === row.cells[0].textContent && r.hour === Number(row.cells[1].textContent.slice(0, 2))));
      });
    });
    const chart = document.querySelector('#chart');
    const detail = document.createElement('details');
    const periodLabel = w.metadata && w.metadata.timelineBucket === 'month' ? '월별' : w.metadata && w.metadata.timelineBucket === 'day' ? '일별' : '시간별';
    detail.innerHTML = '<summary>' + periodLabel + ' 토큰·환산액 보기</summary><div class="tablewrap"><table><thead><tr><th>KST 시각</th><th>벤더</th><th class="num">토큰 · 환산액</th></tr></thead><tbody>' + list(w.timeline).map(r =>
      '<tr><td>' + new Date(r.ts * 1000).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + '</td><td>' + esc(r.vendor) + '</td><td class="num">' + f(metric(r)) + '<span class="cost-value">' + esc(costText([r])) + '</span></td></tr>').join('') + '</tbody></table></div>';
    chart.append(detail);
  }
  const prior = render;
  render = function () { prior.apply(this, arguments); drawPricing(); annotate(); };
  el('price-toggle').addEventListener('click', () => { state.on = !state.on; save(); render(); });
  el('currency').addEventListener('change', e => { state.currency = e.target.value; save(); render(); });
  el('fx-rate').addEventListener('change', e => {
    if (!e.target.checkValidity()) { e.target.reportValidity(); el('price-status').textContent = '환율은 0보다 큰 유한한 숫자로 입력하세요. 직전 환율을 유지합니다.'; return; }
    state.fx = Number(e.target.value); state.manualFx = true; save(); render();
  });
  el('fx-reset').addEventListener('click', () => { if (!fxSource) return; state.fx = fxSource.rate; state.manualFx = false; save(); render(); });
  for (const [id, field] of [['context-price', 'context'], ['cache-price', 'cache']]) el(id).addEventListener('change', e => { state[field] = e.target.value; save(); render(); });
  el('price-table').addEventListener('click', e => {
    const button = e.target.closest('button'); if (!button) return;
    const row = button.closest('tr'), key = row.dataset.key;
    if (button.hasAttribute('data-reset')) delete state.overrides[key];
    else {
      const rate = {};
      for (const input of row.querySelectorAll('input')) {
        if (!input.checkValidity()) { input.reportValidity(); el('price-status').textContent = '단가 4개를 모두 0 이상의 숫자로 입력하세요.'; return; }
        rate[input.dataset.field] = Number(input.value);
      }
      if (!PriceCore.validRates(rate)) return;
      state.overrides[key] = rate;
    }
    save(); render();
  });
  const bundled = window.REPORT_PRICING && window.REPORT_FX ? Promise.resolve([window.REPORT_PRICING, window.REPORT_FX]) : Promise.all(['pricing.json', 'fx.json'].map(file => fetch(file).then(r => { if (!r.ok) throw new Error(file); return r.json(); })));
  bundled
    .then(([prices, fx]) => {
      catalog = prices; fxSource = fx;
      if (!state.manualFx) state.fx = fx.rate;
      if (D) render();
    }).catch(() => { loadError = '가격표 또는 환율 데이터를 불러오지 못했습니다. 새로고침해 다시 시도하세요.'; el('price-toggle').textContent = '가격표 로딩 실패'; el('price-status').textContent = loadError; });
})();
