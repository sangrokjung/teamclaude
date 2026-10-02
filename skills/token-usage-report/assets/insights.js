(() => {
  'use strict';
  if (typeof render !== 'function' || window.__insightsMounted) return;
  window.__insightsMounted = true;

  const U = '분류 미확정';
  const CAT = ['개발·구현', '하네스·자동화', '콘텐츠 제작', '검토·검증', '조사·분석', '문서·운영', U];
  const PAL = ['#213f95', '#2f56b8', '#3d5cc8', '#5b7be0', '#7d97e3', '#4f6aa8'];
  const PERIOD = { '1': '최근 1시간', '24': '최근 24시간', '168': '최근 7일', '720': '최근 30일', '8760': '최근 1년' };
  const hh = h => String(h).padStart(2, '0');
  const n = v => Math.round(Number(v) || 0).toLocaleString('ko-KR');
  const pct = (a, b) => (b > 0 ? (a / b * 100).toFixed(1) : '0.0') + '%';
  const color = k => (k === U ? '#9aa1b3' : PAL[Math.max(0, CAT.indexOf(k)) % PAL.length]);
  const span = h => hh(h) + ':00–' + hh(h) + ':59';

  const css = document.createElement('style');
  css.textContent = [
    '#insights{--ins-bar:#a9bbec;--ins-peak:#213f95;--ins-rgb:61 92 200;margin-top:13px;display:grid;gap:13px;font-size:1.0625rem;line-height:1.6;font-family:"Pretendard Variable",Pretendard,-apple-system,system-ui,sans-serif;word-break:keep-all;overflow-wrap:anywhere}',
    '#insights h2{font-size:1.25rem}#insights .panel-head{flex-wrap:wrap}',
    '.ins-ctx{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;color:var(--muted)}.ins-ctx b{color:var(--ink)}',
    '.ins-pill{border:1px solid var(--line);border-radius:99px;padding:3px 12px;background:var(--card)}',
    '.ins-split{display:grid;grid-template-columns:minmax(0,1fr);gap:13px}.ins-categories{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 28px}',
    '.ins-note{color:var(--muted);margin:0 0 14px}.ins-hint{color:var(--muted);font-size:.9375rem}',
    '.ins-warn{color:#b4233c;font-weight:700}',
    '.ins-cat{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;margin-bottom:16px}',
    '.ins-cat .track{grid-column:1/-1}.ins-name{font-weight:700}.ins-cat.unk .ins-name{color:var(--muted)}',
    '.ins-val{text-align:right;font-variant-numeric:tabular-nums}.ins-proj{grid-column:1/-1;color:var(--muted)}',
    '.ins-scroll{overflow-x:auto;max-width:100%;padding:4px 2px 8px;-webkit-overflow-scrolling:touch}',
    '.ins-hours{display:grid;grid-template-columns:repeat(24,minmax(34px,1fr));gap:5px;min-width:912px;height:210px;align-items:end}',
    '.ins-col{display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:6px;height:100%;border-radius:6px;cursor:default}',
    '.ins-colbar{width:100%;background:var(--ins-bar);border-radius:5px 5px 0 0}.ins-col.peak .ins-colbar{background:var(--ins-peak)}',
    '.ins-col.none .ins-colbar{height:14px!important;background:transparent;border:1.5px dashed var(--muted);border-radius:4px}',
    '.ins-hl{font-variant-numeric:tabular-nums;color:var(--muted)}.ins-col.peak .ins-hl{color:var(--ink);font-weight:800}',
    '.ins-top{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-top:14px}',
    '.ins-tc{border:1px solid var(--line);border-radius:10px;padding:11px 12px}.ins-tc.peak{border:2px solid var(--ins-peak)}',
    '.ins-tc b{display:block;font-size:1.25rem;font-variant-numeric:tabular-nums}.ins-tc small{color:var(--muted);font-size:.9375rem;display:block}',
    '.ins-heat{display:grid;grid-template-columns:118px repeat(24,minmax(32px,1fr));gap:3px;min-width:960px;align-items:center}',
    '.ins-heat .ins-hl{text-align:center}.ins-date{font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.ins-cell{height:34px;border-radius:5px;display:flex;align-items:center;justify-content:center;background:rgb(var(--ins-rgb)/var(--a,0));border:1px solid var(--line)}',
    '.ins-cell.out{background:var(--line);color:var(--muted);border-color:transparent}.ins-cell.part{border:2px dashed var(--ins-peak)}',
    '.ins-legend{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:12px;color:var(--muted);font-size:.9375rem;align-items:center}',
    '.ins-sw{display:inline-block;width:18px;height:14px;border-radius:3px;margin-right:6px;vertical-align:-2px;border:1px solid var(--line)}',
    '#insights [tabindex]:focus-visible{outline:3px solid var(--claude);outline-offset:2px}',
    '#insights details{margin-top:14px}#insights summary{cursor:pointer;font-weight:700;padding:6px 0}',
    '#insights table{font-size:1.0625rem}.ins-basis{white-space:normal!important;min-width:240px}',
    '#ins-tip{position:fixed;z-index:30;pointer-events:none;max-width:300px;background:var(--ink);color:var(--card);padding:9px 12px;border-radius:9px;font-size:1.0625rem;line-height:1.5;font-family:"Pretendard Variable",Pretendard,-apple-system,system-ui,sans-serif}',
    '@media(prefers-reduced-motion:no-preference){.ins-fill,.ins-colbar{transition:width .3s ease-out,height .3s ease-out}}',
    '@media(max-width:900px){.ins-split,.ins-categories{grid-template-columns:1fr}}@media(max-width:540px){.ins-top{grid-template-columns:1fr}}',
    '@media(prefers-color-scheme:dark){#insights{--ins-bar:#4c5f96;--ins-peak:#9db4ff;--ins-rgb:125 155 255}.ins-cat .fill{filter:brightness(1.55)}.ins-warn{color:#ff8fa6}}'
  ].join('');
  document.head.append(css);

  const sec = document.createElement('section');
  sec.id = 'insights';
  sec.setAttribute('aria-label', '작업 유형과 하루 시간대 분석');
  sec.innerHTML = '<div class="card ins-note">작업 유형·시간대 분석 데이터를 불러오는 중입니다.</div>';
  const kp = document.querySelector('#kpis');
  (kp ? kp.parentNode : document.querySelector('main') || document.body).insertBefore(sec, kp ? kp.nextSibling : null);

  const tip = document.createElement('div');
  tip.id = 'ins-tip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true;
  document.body.append(tip);
  const hide = () => { tip.hidden = true; };
  const show = e => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t || !sec.contains(t)) return;
    tip.textContent = t.dataset.tip; tip.hidden = false;
    const r = t.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(innerWidth - tw - 8, r.left + r.width / 2 - tw / 2)) + 'px';
    tip.style.top = (r.top - th - 8 < 8 ? r.bottom + 8 : r.top - th - 8) + 'px';
  };
  sec.addEventListener('mouseover', show); sec.addEventListener('focusin', show);
  sec.addEventListener('mouseout', hide); sec.addEventListener('focusout', hide);
  addEventListener('scroll', hide, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });

  const agg = (rows, key) => {
    const m = new Map();
    for (const r of rows) {
      const k = key(r), o = m.get(k) || { v: 0, e: 0 };
      o.v += metric(r); o.e = Math.max(o.e, Number(r.exposureHours) || 0); m.set(k, o);
    }
    return m;
  };
  const tipAttr = s => ' tabindex="0" role="img" aria-label="' + esc(s) + '" data-tip="' + esc(s) + '"';

  function categoryCard(w) {
    const cm = new Map();
    for (const c of list(w.categories || [])) {
      const o = cm.get(c.category) || { v: 0, p: new Map() };
      o.v += metric(c);
      for (const p of c.projects || []) o.p.set(p.project, (o.p.get(p.project) || 0) + metric(p));
      cm.set(c.category, o);
    }
    const cats = [...cm].map(([k, o]) => ({ k, v: o.v, top: [...o.p].filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 2) }))
      .sort((a, b) => (a.k === U) - (b.k === U) || b.v - a.v);
    const tot = cats.reduce((s, x) => s + x.v, 0), all = list(w.vendors || []).reduce((s, x) => s + metric(x), 0);
    const max = Math.max(1, ...cats.map(x => x.v)), diff = Math.abs(tot - all);
    const check = diff > 0.5 ? '<span class="ins-warn">분류 합계가 전체와 ' + esc(n(diff)) + ' 토큰 다릅니다.</span>' : '분류 합계 ' + esc(n(tot)) + ' 토큰, 전체와 일치합니다.';
    const rows = cats.map(x => '<div class="ins-cat' + (x.k === U ? ' unk' : '') + '"><span class="ins-name">' + esc(x.k) + '</span><span class="ins-val">' + esc(pct(x.v, tot)) + ' · <span title="' + esc(n(x.v)) + ' 토큰">' + esc(f(x.v)) + '</span></span><div class="track"><div class="fill ins-fill" style="width:' + (x.v / max * 100) + '%;background:' + color(x.k) + '"></div></div><span class="ins-proj">상위 프로젝트: ' + (x.top.length ? x.top.map(([p, v]) => esc(p) + ' ' + esc(f(v))).join(' · ') : '없음') + '</span></div>').join('');
    return '<article class="card"><div class="panel-head"><h2>어떤 작업에 토큰을 쓰나요?</h2><span class="ins-hint">세션 메타데이터 기반 추정 · 토큰 비중, 업무시간 아님</span></div><p class="ins-note">프로젝트·branch·작업 경로로 자동 분류한 추정치입니다. 근거가 부족한 세션은 숨기지 않고 회색 "분류 미확정"에 넣었습니다. ' + check + '</p>' + ('<div class="ins-categories">' + rows + '</div>') + '</article>';
  }

  function hourCard(w) {
    const hm = agg(list(w.hourOfDay || []), r => Number(r.hour));
    const hrs = Array.from({ length: 24 }, (_, h) => Object.assign({ h }, hm.get(h) || { v: 0, e: 0 }));
    const obs = hrs.filter(x => x.e > 0), tot = obs.reduce((s, x) => s + x.v, 0), max = Math.max(1, ...obs.map(x => x.v));
    const top3 = obs.filter(x => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 3), peak = top3.length ? top3[0].h : -1;
    const avg = x => (H === '168' && x.e > 0 ? ' · 관측 ' + x.e.toFixed(1) + '시간 기준 평균 ' + f(x.v / x.e) + '/h' : '');
    const tipOf = x => span(x.h) + ' KST · ' + (x.e > 0 ? n(x.v) + ' 토큰 · 점유 ' + pct(x.v, tot) + avg(x) : '관측 없음 (0과 다름)');
    const meta = H === '8760' ? '1년 동안 같은 시각을 합산한 값이에요. 로그가 보관된 시점만 관측되며 빈 칸은 0 사용이 아닙니다.'
      : H === '720' ? '30일 동안 같은 시각을 합산한 값이에요. 로그가 보관된 시점만 관측되며 빈 칸은 0 사용이 아닙니다.'
      : H === '168' ? '7일 동안 같은 시각을 합산한 값이에요. 시간대별 평균은 토큰을 그 시각의 관측 시간으로 나눈 값입니다.'
      : H === '24' ? '각 시각 1회분의 합계로 읽으세요. 첫·마지막 시각은 일부만 관측됐을 수 있습니다.'
      : '1시간 창이라 관측한 두 시각에만 값이 있어요. 점선 칸은 0이 아니라 관측 없음입니다.';
    const cols = hrs.map(x => '<div class="ins-col' + (x.h === peak ? ' peak' : '') + (x.e > 0 ? '' : ' none') + '"' + tipAttr(tipOf(x)) + '><div class="ins-colbar" style="height:' + (x.e > 0 ? Math.max(2, x.v / max * 160) : 0) + 'px"></div><span class="ins-hl">' + hh(x.h) + '</span></div>').join('');
    const cards = top3.map((x, i) => '<div class="ins-tc' + (i === 0 ? ' peak' : '') + '"><small>' + (i + 1) + '위 · ' + span(x.h) + '</small><b title="' + esc(n(x.v)) + ' 토큰">' + esc(n(x.v)) + '</b><small>점유 ' + esc(pct(x.v, tot)) + esc(avg(x)) + '</small></div>').join('');
    return '<article class="card"><div class="panel-head"><h2>24시간 중 언제 가장 많이 쓰나요?</h2><span class="ins-hint">KST 0~23시 · 기간 합계</span></div><p class="ins-note">' + esc(meta) + ' 토큰은 사람의 작업시간·비용·쿼터가 아닙니다.</p><div class="ins-scroll"><div class="ins-hours">' + cols + '</div></div>' + (cards ? '<div class="ins-top">' + cards + '</div>' : '<div class="empty">관측된 시간대 기록이 없습니다.</div>') + '</article>';
  }

  function heatCard(w) {
    if (H === '8760') return '<article class="card"><div class="panel-head"><h2>연간 시간대 요약</h2><span class="ins-hint">KST 0~23시 · 월별 추이와 함께 확인</span></div><p class="ins-note">1년 히트맵은 셀 수가 많아 시간대 합계로 요약했습니다. 자세한 월별 사용량은 위 추이 차트를 확인하세요.</p></article>';
    const rows = list(w.dailyHours || []), dm = agg(rows, r => r.date + '|' + Number(r.hour));
    const dates = [...new Set(rows.map(r => r.date))].sort(), vals = [...dm.values()].filter(o => o.e > 0);
    const max = Math.max(1, ...vals.map(o => o.v));
    let grid = '<span></span>' + Array.from({ length: 24 }, (_, h) => '<span class="ins-hl">' + hh(h) + '</span>').join(''), trs = '';
    for (const d of dates) {
      grid += '<span class="ins-date">' + esc(d) + '</span>';
      for (let h = 0; h < 24; h++) {
        const o = dm.get(d + '|' + h) || { v: 0, e: 0 };
        if (o.e <= 0) { grid += '<div class="ins-cell out" aria-hidden="true">-</div>'; continue; }
        if (!rows.some(row => row.date === d && row.hour === h && row.requests > 0)) { grid += '<div class="ins-cell out" aria-label="' + d + ' ' + span(h) + ' 기록 없음">-</div>'; continue; }
        const part = o.e < 0.999, m = Math.round(o.e * 60), a = (o.v > 0 ? 0.12 + 0.88 * o.v / max : 0.03).toFixed(3);
        grid += '<div class="ins-cell' + (part ? ' part' : '') + '" style="--a:' + a + '"' + tipAttr(d + ' ' + span(h) + ' KST · ' + n(o.v) + ' 토큰 · 관측 ' + m + '분' + (part ? ' (부분 관측)' : '')) + '></div>';
        trs += '<tr><td>' + esc(d) + '</td><td>' + span(h) + '</td><td class="num">' + esc(n(o.v)) + '</td><td class="num">' + m + '분</td><td>' + (part ? '부분 관측' : '관측 완료') + '</td></tr>';
      }
    }
    const legend = '<div class="ins-legend"><span><i class="ins-sw" style="background:rgb(var(--ins-rgb)/.75)"></i>관측 완료 (진할수록 많음)</span><span><i class="ins-sw" style="border:2px dashed var(--ins-peak)"></i>부분 관측</span><span><i class="ins-sw" style="background:var(--line)"></i>관측 창 밖 (-)</span></div>';
    return '<article class="card"><div class="panel-head"><h2>날짜별로 보면 언제 몰렸나요?</h2><span class="ins-hint">KST 날짜 × 시각 · 기간 합계</span></div><p class="ins-note">칸에 마우스를 올리거나 Tab으로 이동하면 정확한 값과 관측 시간이 나와요.</p>' + (dates.length ? '<div class="ins-scroll"><div class="ins-heat">' + grid + '</div></div>' + legend + '<details><summary>히트맵 데이터를 표로 보기</summary><div class="tablewrap"><table><thead><tr><th>날짜</th><th>시각 (KST)</th><th class="num">토큰</th><th class="num">관측</th><th>상태</th></tr></thead><tbody>' + trs + '</tbody></table></div></details>' : '<div class="empty">날짜별 시간 데이터가 없습니다.</div>') + '</article>';
  }

  function sessionCard(w, label) {
    const q = String(typeof Q === 'string' ? Q : '').toLowerCase();
    const ss = list(w.sessions || []).filter(x => [x.project, x.branch, x.task, x.id, x.category].join(' ').toLowerCase().includes(q)).sort((a, b) => metric(b) - metric(a)).slice(0, 20);
    const trs = ss.map((x, i) => '<tr><td>' + (i + 1) + '</td><td class="vendor ' + esc(String(x.vendor).toLowerCase()) + '">' + esc(x.vendor) + '</td><td>' + esc(x.category || U) + '</td><td>' + esc(x.project) + '</td><td class="ins-basis">' + esc(x.categoryBasis || '근거 기록 없음') + '</td><td class="num" title="' + esc(n(metric(x))) + ' 토큰">' + esc(f(metric(x))) + '</td></tr>').join('');
    return '<article class="card"><div class="panel-head"><h2>세션은 어떤 작업으로 분류됐나요?</h2><span class="ins-hint">' + esc(label) + '</span></div><p class="ins-note">각 세션을 한 유형으로 분류한 근거입니다. 아래 세션 순위에도 같은 분류를 사용합니다. 기간·벤더·지표 필터는 차트와 표에 적용되고, 세션 검색은 이 상세 표에 적용됩니다.</p><details><summary>상위 20개 세션의 분류 근거 보기</summary><div class="tablewrap"><table><thead><tr><th>#</th><th>벤더</th><th>추정 분류</th><th>프로젝트</th><th>분류 근거</th><th class="num">지표 토큰</th></tr></thead><tbody>' + (trs || '<tr><td colspan="6" class="empty">조건에 맞는 세션이 없습니다.</td></tr>') + '</tbody></table></div></details></article>';
  }

  function drawInsights() {
    if (!D || !D.windows || !D.windows[H]) return;
    hide();
    const w = D.windows[H], period = PERIOD[H] || H + '시간', vendor = V === 'all' ? 'Claude+Codex 합산' : V, mName = M === 'total' ? '처리 토큰' : '캐시 제외 토큰';
    const stamp = D.generatedAt ? new Date(D.generatedAt * 1000).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '시각 미상';
    const label = period + ' · ' + vendor + ' · ' + mName;
    sec.innerHTML = '<div class="ins-ctx"><span class="ins-pill">기간 <b>' + esc(period) + '</b></span><span class="ins-pill">벤더 <b>' + esc(vendor) + '</b></span><span class="ins-pill">지표 <b>' + esc(mName) + '</b></span><span>고정 스냅샷 · ' + esc(stamp) + ' KST 생성, 이후 사용량은 반영되지 않습니다.</span></div>'
      + '<div class="ins-split">' + categoryCard(w) + hourCard(w) + '</div>' + heatCard(w) + sessionCard(w, label);
  }

  const base = render;
  render = function () {
    base.apply(this, arguments);
    try { drawInsights(); } catch (e) {
      console.error('[insights]', e);
      sec.innerHTML = '<div class="card ins-note"><span class="ins-warn">작업 유형·시간대 분석을 그리지 못했습니다.</span> ' + esc(e && e.message) + '</div>';
    }
  };
  if (D) render();
})();
