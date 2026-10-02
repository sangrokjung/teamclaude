(() => {
  const originalDraw = window.draw;
  const periodMeta = {
    '1': { title: '최근 1시간 추이', unit: '5분별', step: 300 },
    '24': { title: '최근 24시간 추이', unit: '시간별', step: 3600 },
    '168': { title: '최근 7일 추이', unit: '시간별', step: 3600 },
    '720': { title: '최근 30일 일별 추이', unit: '일별', step: 86400 },
    '8760': { title: '최근 1년 월별 추이', unit: '월별', step: 0 },
  };
  const format = n => {
    n = Number(n) || 0;
    return Math.abs(n) >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : Math.round(n).toLocaleString('ko-KR');
  };
  const dateLabel = ts => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'short', day: 'numeric' }).format(new Date(ts * 1000));
  const monthLabel = ts => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'short' }).format(new Date(ts * 1000));
  const label = ts => H === '8760' ? monthLabel(ts) : H === '720' ? dateLabel(ts) : kst(ts);
  const drawLong = w => {
    const meta = periodMeta[H];
    if (!meta) return originalDraw(w);
    const rows = list(w.timeline || []);
    const by = new Map();
    rows.forEach(row => {
      const key = Number(row.ts);
      const current = by.get(key) || { ts: key, Claude: 0, Codex: 0 };
      current[row.vendor] = metric(row);
      by.set(key, current);
    });
    const cursor = new Date(w.start * 1000 + 9 * 3600000);
    cursor.setUTCHours(0, 0, 0, 0);
    if (H === '8760') cursor.setUTCDate(1);
    const points = [];
    if (Number(H) < 720) {
      for (let ts = Math.floor(w.start / meta.step) * meta.step; ts <= w.end; ts += meta.step) points.push(by.get(ts) || { ts, Claude: null, Codex: null });
    }
    while (Number(H) >= 720 && cursor.getTime() / 1000 - 9 * 3600 <= w.end) {
      const ts = cursor.getTime() / 1000 - 9 * 3600;
      const row = by.get(ts);
      points.push(row || { ts, Claude: null, Codex: null });
      if (H === '8760') cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      else cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const W = 760, HH = 250, p = { l: 52, r: 18, t: 18, b: 42 };
    const max = Math.max(1, ...points.map(point => point.Claude + point.Codex));
    const x = i => p.l + (i / Math.max(1, points.length - 1)) * (W - p.l - p.r);
    const y = value => HH - p.b - value / max * (HH - p.t - p.b);
    let svg = '<svg viewBox="0 0 ' + W + ' ' + HH + '" role="img" aria-label="' + meta.title + '"><path d="M' + p.l + ' ' + p.t + 'V' + (HH - p.b) + 'H' + (W - p.r) + '" stroke="var(--line)" fill="none"/>';
    for (const vendor of ['Claude', 'Codex']) {
      if (V !== 'all' && V !== vendor) continue;
      let path = '', open = false;
      points.forEach((point, i) => {
        if (!rows.some(row => row.ts === point.ts && row.vendor === vendor)) { open = false; return; }
        path += (open ? 'L' : 'M') + x(i) + ' ' + y(point[vendor]);
        open = true;
        svg += '<circle cx="' + x(i) + '" cy="' + y(point[vendor]) + '" r="4" fill="' + C[vendor] + '"><title>' + esc(label(point.ts) + ' · ' + vendor + ' · ' + Math.round(point[vendor]).toLocaleString('ko-KR') + ' 토큰') + '</title></circle>';
      });
      svg += '<path d="' + path + '" fill="none" stroke="' + C[vendor] + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>';
    }
    const labels = points.length > 8 ? points.filter((_, i) => i % Math.ceil(points.length / 6) === 0) : points;
    labels.forEach(point => {
      const index = points.indexOf(point);
      svg += '<text x="' + x(index) + '" y="' + (HH - 12) + '" text-anchor="middle" fill="var(--muted)" font-size="11">' + label(point.ts) + '</text>';
    });
    svg += '<text x="' + (p.l - 8) + '" y="' + (p.t + 4) + '" text-anchor="end" fill="var(--muted)" font-size="11">' + format(max) + '</text><text x="' + (p.l - 8) + '" y="' + (HH - p.b + 4) + '" text-anchor="end" fill="var(--muted)" font-size="11">0</text></svg>';
    const table = points.map(point => '<tr><td>' + label(point.ts) + '</td>' + ['Claude', 'Codex'].filter(vendor => V === 'all' || V === vendor).map(vendor => '<td class="num">' + (rows.some(row => row.ts === point.ts && row.vendor === vendor) ? format(point[vendor]) : '기록 없음') + '</td>').join('') + '</tr>').join('');
    document.querySelector('#chart').innerHTML = svg + '<details><summary>추이 데이터 보기</summary><div class="tablewrap"><table><thead><tr><th>KST 기간</th>' + ['Claude', 'Codex'].filter(vendor => V === 'all' || V === vendor).map(vendor => '<th>' + vendor + '</th>').join('') + '</tr></thead><tbody>' + table + '</tbody></table></div></details>';
  };
  window.draw = w => drawLong(w);
  const prior = window.render;
  window.render = function () {
    prior.apply(this, arguments);
    const meta = periodMeta[H];
    const context = document.querySelector('#trend-context');
    const title = document.querySelector('#trend-title');
    if (!context || !title) return;
    if (!meta) { title.textContent = '시간별 소진 속도'; context.textContent = ''; return; }
    const details = D.windows[H].metadata || {};
    title.textContent = meta.title;
    const observed = V === 'all' ? details : (details.vendors?.[V] || {});
    const start = observed.observedStart ? new Date(observed.observedStart * 1000).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' }) : '없음';
    const end = observed.observedEnd ? new Date(observed.observedEnd * 1000).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' }) : '없음';
    const coverage = observed.coverage || details.coverage;
    context.textContent = 'KST ' + meta.unit + ' · 관측 ' + start + '–' + end + ' · ' + (coverage === 'limited' ? '보관 로그 범위 제한' : '관측 기록 없음') + ' · 빈 구간은 실제 0 사용으로 해석하지 않습니다.';
    document.querySelector('#rateHint').textContent = meta.unit + ' 합계 · 처음과 마지막은 부분 기간';
  };
})();
