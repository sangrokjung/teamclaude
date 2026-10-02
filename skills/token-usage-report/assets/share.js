(() => {
  const repo = 'https://github.com/sangrokjung/teamclaude';
  const button = document.createElement('button');
  button.id = 'share-report';
  button.type = 'button';
  button.textContent = '공유용 요약';
  button.title = '프로젝트·세션 이름을 제외한 요약을 복사하거나 다운로드합니다.';
  document.querySelector('#windows').append(button);
  const style = document.createElement('style');
  style.textContent = '#share-report{border-color:var(--accent);color:var(--accent)}#share-report:hover{background:var(--accent);color:#fff}.share-box{position:fixed;inset:0;z-index:50;background:#18203899;display:grid;place-items:center;padding:20px}.share-dialog{width:min(560px,100%);max-height:90vh;overflow:auto;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:16px;padding:20px;box-shadow:0 20px 60px #0004}.share-dialog h2{margin:0 0 8px}.share-dialog p{color:var(--muted);line-height:1.6}.share-dialog pre{white-space:pre-wrap;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;font:13px/1.5 ui-monospace,monospace}.share-actions{display:flex;gap:8px;flex-wrap:wrap}.share-actions a{display:inline-block;border:1px solid var(--accent);border-radius:9px;padding:9px 12px;color:var(--accent);text-decoration:none}@media(prefers-reduced-motion:reduce){.share-box *{transition:none!important}}';
  document.head.append(style);
  const percent = (value, total) => total ? (value / total * 100).toFixed(1) + '%' : '0.0%';
  const allowed = new Set(['하네스·자동화', '검토·검증', '콘텐츠 제작', '개발·구현', '조사·분석', '문서·운영', '분류 미확정']);
  const grouped = (rows, key) => {
    const totals = new Map();
    for (const row of rows) {
      const name = key(row);
      totals.set(name, (totals.get(name) || 0) + metric(row));
    }
    return [...totals].sort((a, b) => b[1] - a[1]);
  };
  const summary = () => {
    const w = D.windows[H];
    const total = list(w.vendors).reduce((sum, row) => sum + metric(row), 0);
    const categories = grouped(list(w.categories), row => allowed.has(row.category) ? row.category : '분류 미확정').slice(0, 5).map(([name, tokens]) => ({ name, share: percent(tokens, total), tokens }));
    const hours = grouped(list(w.hourOfDay).filter(row => Number.isInteger(row.hour) && row.hour >= 0 && row.hour < 24 && metric(row) > 0), row => row.hour).slice(0, 3).map(([hour, tokens]) => ({ hourKst: String(hour).padStart(2, '0') + ':00', tokens }));
    return { title: 'Claude × Codex 토큰 사용 분석', period: { '1': '최근 1시간', '24': '최근 24시간', '168': '최근 7일', '720': '최근 30일', '8760': '최근 1년' }[H], metric: M === 'total' ? '처리 토큰' : '캐시 제외 토큰', vendor: V === 'all' ? 'Claude + Codex' : V, totalTokens: total, categories, peakHoursKst: hours, github: repo };
  };
  const close = () => { document.querySelector('.share-box')?.remove(); button.focus(); };
  button.addEventListener('click', () => {
    if (!D) return;
    const data = summary();
    const box = document.createElement('div'); box.className = 'share-box';
    box.innerHTML = '<div class="share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-title"><h2 id="share-title">공유용 요약</h2><p>아래 요약만 공유하세요. 원본 report.html에는 프로젝트·브랜치·세션 정보가 포함됩니다.</p><pre></pre><textarea hidden readonly aria-label="공유 요약을 선택해 복사"></textarea><div class="share-actions"><button type="button" data-copy>요약 복사</button><button type="button" data-download>JSON 다운로드</button><a href="' + repo + '" target="_blank" rel="noreferrer">GitHub에서 보기 · Star</a><button type="button" data-close>닫기</button></div></div>';
    box.querySelector('pre').textContent = JSON.stringify(data, null, 2);
    box.querySelector('[data-copy]').addEventListener('click', async event => {
      const copyButton = event.currentTarget;
      try { await navigator.clipboard.writeText(JSON.stringify(data, null, 2)); copyButton.textContent = '복사 완료'; }
      catch (_) { const field = box.querySelector('textarea'); field.hidden = false; field.value = JSON.stringify(data, null, 2); field.focus(); field.select(); copyButton.textContent = '선택된 요약을 복사하세요'; }
    });
    box.querySelector('[data-download]').addEventListener('click', () => { const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'token-usage-summary.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
    box.querySelector('[data-close]').addEventListener('click', close);
    box.addEventListener('click', event => { if (event.target === box) close(); });
    box.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const targets = [...box.querySelectorAll('button,a,textarea:not([hidden])')], first = targets[0], last = targets[targets.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    document.body.append(box); box.querySelector('[data-copy]').focus();
  });
})();
