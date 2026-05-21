// ── Budget page ───────────────────────────────────────────────────────────────

let _budgetTab = 'mensile';

function swBudget(tab, btn) {
  _budgetTab = tab;
  document.querySelectorAll('.budget-tab').forEach(t => t.classList.remove('on'));
  document.querySelectorAll('.budget-pane').forEach(p => p.classList.remove('on'));
  document.getElementById('bpane-' + tab)?.classList.add('on');
  btn.classList.add('on');
}

async function loadBudget() {
  // Carica entrambi i tab in parallelo
  await Promise.all([loadBudgetMensile(), loadBudgetClienti()]);
}

// ── Tab Mensile ───────────────────────────────────────────────────────────────

async function loadBudgetMensile() {
  const root = document.getElementById('bpane-mensile');
  if (!root) return;

  try {
    const today = new Date().toISOString().split('T')[0];

    // Prende il record più recente di budget
    const { data: bArr, error: bErr } = await sb.from('budget')
      .select('*')
      .lte('data_aggiornamento', today)
      .order('data_aggiornamento', { ascending: false })
      .limit(1);
    if (bErr) throw bErr;
    const b = bArr?.[0];

    // Focus prodotti
    const { data: focus } = b
      ? await sb.from('budget_focus')
          .select('*')
          .eq('data_aggiornamento', b.data_aggiornamento)
          .order('gruppo_prodotti')
      : { data: [] };

    if (!b) {
      root.innerHTML = '<p style="color:var(--text2);padding:1rem">Nessun dato budget disponibile.<br>Importa il PDF Avanzamento per popolare i dati.</p>';
      return;
    }

    const dataFmt = fmtDate(b.data_aggiornamento);
    const meseNome = _nomeMese(b.data_aggiornamento);

    // Helper per valori
    const eur = n => n != null ? '€ ' + Number(n).toLocaleString('it-IT', {minimumFractionDigits: 0, maximumFractionDigits: 0}) : '—';
    const pct = n => n != null ? (n >= 0 ? '+' : '') + Number(n).toFixed(1).replace('.', ',') + '%' : '—';
    const cls = n => n == null ? '' : n >= 0 ? 'pos' : 'neg';
    const bar = (val, tot, color) => {
      const w = tot > 0 ? Math.min(100, (val / tot) * 100) : 0;
      return `<div class="b-bbg"><div class="b-bfill" style="width:${w.toFixed(1)}%;background:${color}"></div></div>`;
    };

    // ── Progressivo gen-apr
    const secLabel = `progressivo gen – apr · ${dataFmt}`;
    const secMese  = `${meseNome} · giorno ${b.giorno_lavorativo ?? '?'} di ${b.giorni_totali ?? '?'}`;

    // ── Avanzamento mese: calcolo % evaso su budget
    const pctEvaso = b.budget_mese > 0 ? (b.evaso / b.budget_mese) * 100 : null;
    const pctFull  = b.budget_mese > 0 ? (b.evaso_ordinato_resi / b.budget_mese) * 100 : null;
    const pctGiorno = b.obiettivo_giornaliero > 0 ? (b.fatturato_giorno / b.obiettivo_giornaliero) * 100 : null;

    // ── Focus prodotti HTML
    const focusHTML = (focus && focus.length)
      ? focus.map(f => {
          const pctF = f.target_eur > 0 ? (f.consegnato_eur / f.target_eur) * 100 : null;
          const w = Math.min(100, pctF ?? 0);
          const label = f.gruppo_prodotti.length > 55 ? f.gruppo_prodotti.slice(0, 55) + '…' : f.gruppo_prodotti;
          return `<tr>
            <td style="font-size:12px;color:var(--text2)">${label}</td>
            <td class="num-right">${eur(f.target_eur)}</td>
            <td class="num-right">
              <div class="b-inline-bar">
                <div class="b-mini-bg"><div class="b-mini-fill" style="width:${w.toFixed(0)}%;background:#378ADD"></div></div>
                ${eur(f.consegnato_eur)}
              </div>
            </td>
            <td class="num-right" style="color:#378ADD;font-weight:500">${pctF != null ? pctF.toFixed(0) + '%' : '—'}</td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="4" style="color:var(--text2);font-size:12px;padding:8px 0">Nessun dato focus prodotti per questa data</td></tr>';

    root.innerHTML = `
      <p class="b-sec">${secLabel}</p>
      <div class="b-g4">
        <div class="b-kcard"><p class="b-klabel">budget gen–apr</p><p class="b-kval">${eur(b.budget_gen_apr)}</p></div>
        <div class="b-kcard"><p class="b-klabel">fatturato gen–apr</p><p class="b-kval">${eur(b.fatturato_gen_apr)}</p></div>
        <div class="b-kcard"><p class="b-klabel">delta su budget</p><p class="b-kval ${cls(b.delta_budget_eur)}">${b.delta_budget_eur >= 0 ? '+' : ''}${eur(b.delta_budget_eur)}</p><p class="b-ksub ${cls(b.delta_budget_pct)}">${pct(b.delta_budget_pct)}</p></div>
      </div>

      <p class="b-sec">${secMese}</p>
      <div class="b-panel">
        <div class="b-prow"><span class="b-prow-label">evaso al ${dataFmt}</span><span class="b-prow-val">${eur(b.evaso)} <span>/ ${eur(b.budget_mese)}</span></span></div>
        ${bar(b.evaso, b.budget_mese, '#378ADD')}
        <div style="margin-bottom:12px"></div>
        <div class="b-prow"><span class="b-prow-label">evaso + ordinato – resi</span><span class="b-prow-val">${eur(b.evaso_ordinato_resi)} <span>/ ${eur(b.budget_mese)}</span></span></div>
        ${bar(b.evaso_ordinato_resi, b.budget_mese, '#2D7D4F')}
        <div class="b-hint"><span>fat. ${meseNome} anno prec: ${eur(b.fatturato_mese_anno_prec)}</span><span class="${cls(b.delta_mese_eur)}">delta budget: ${pct(b.delta_mese_pct)} (${b.delta_mese_eur >= 0 ? '+' : ''}${eur(b.delta_mese_eur)})</span></div>
      </div>

      <div class="b-g4">
        <div class="b-kcard"><p class="b-klabel">ordinato nel mese</p><p class="b-kval" style="font-size:17px">${eur(b.ordinato_nel_mese)}</p></div>
        <div class="b-kcard"><p class="b-klabel">ordinato oltre mese</p><p class="b-kval" style="font-size:17px">${eur(b.ordinato_oltre_mese)}</p></div>
        <div class="b-kcard"><p class="b-klabel">resi / correzioni</p><p class="b-kval neg" style="font-size:17px">${eur(b.resi)}</p></div>
        <div class="b-kcard"><p class="b-klabel">fat. ${meseNome} anno prec</p><p class="b-kval" style="font-size:17px">${eur(b.fatturato_mese_anno_prec)}</p></div>
      </div>

      <p class="b-sec">avanzamento giornaliero — giorno ${b.giorno_lavorativo ?? '?'}</p>
      <div class="b-panel">
        <div class="b-g4" style="margin-bottom:12px">
          <div style="text-align:center"><p class="b-klabel" style="text-align:center">obiettivo</p><p class="b-kval" style="font-size:17px;text-align:center">${eur(b.obiettivo_giornaliero)}</p></div>
          <div style="text-align:center"><p class="b-klabel" style="text-align:center">fatturato giorno ${b.giorno_lavorativo ?? '?'}</p><p class="b-kval ${cls(b.fatturato_giorno - b.obiettivo_giornaliero)}" style="font-size:17px;text-align:center">${eur(b.fatturato_giorno)}</p></div>
          <div style="text-align:center"><p class="b-klabel" style="text-align:center">ordini inseriti ieri</p><p class="b-kval" style="font-size:17px;text-align:center">${eur(b.valore_ordini_ieri)}</p></div>
          <div style="text-align:center"><p class="b-klabel" style="text-align:center">nr ordini ieri</p><p class="b-kval" style="font-size:17px;text-align:center">${b.nr_ordini_ieri ?? '—'}</p></div>
        </div>
        ${bar(b.fatturato_giorno, b.obiettivo_giornaliero, '#378ADD')}
        <div class="b-hint">
          <span>obiettivo: ${eur(b.obiettivo_giornaliero)}</span>
          <span>fatturato: ${eur(b.fatturato_giorno)} <span class="${cls(b.fatturato_giorno - b.obiettivo_giornaliero)}">(${pct(pctGiorno ? pctGiorno - 100 : null)})</span></span>
        </div>
      </div>

      <p class="b-sec">prodotti focus — ${meseNome}</p>
      <div class="b-panel">
        <table class="b-tbl">
          <thead><tr><th>gruppo prodotti</th><th style="text-align:right">target</th><th style="text-align:right">consegnato</th><th style="text-align:right">%</th></tr></thead>
          <tbody>${focusHTML}</tbody>
        </table>
      </div>
    `;

  } catch (err) {
    document.getElementById('bpane-mensile').innerHTML =
      `<p style="color:var(--red);padding:1rem">Errore caricamento budget: ${err.message}</p>`;
  }
}

// ── Tab Clienti ───────────────────────────────────────────────────────────────

async function loadBudgetClienti() {
  const root = document.getElementById('bpane-clienti');
  if (!root) return;

  try {
    const rows = await loadRollingEnriched();
    if (!rows.length) {
      root.innerHTML = '<p style="color:var(--text2);padding:1rem">Nessun dato rolling disponibile.</p>';
      return;
    }

    // Usa fatturato anno prec del mese corrente come "budget" cliente
    // (stesso approccio del tab clienti nel mock budget_wilson_tabs.html)
    const enriched = rows
      .filter(r => r.fatt_mese_anno_prec > 0 || r.mese_consegnato > 0)
      .map(r => ({
        cliente:  r.ragione_sociale || '—',
        bud:      r.fatt_mese_anno_prec || 0,    // fat anno scorso = riferimento budget
        fat:      r.mese_consegnato || 0,         // evaso mese corrente
        stato:    r._stato,
      }));

    const totBud = enriched.reduce((s, r) => s + r.bud, 0);
    const totFat = enriched.reduce((s, r) => s + r.fat, 0);
    const totDelta = totBud > 0 ? (totFat - totBud) / totBud * 100 : null;

    const eur = n => n != null ? '€ ' + Number(n).toLocaleString('it-IT', {minimumFractionDigits: 0, maximumFractionDigits: 0}) : '—';
    const pct = n => n != null ? (n >= 0 ? '+' : '') + Number(n).toFixed(1).replace('.', ',') + '%' : '—';
    const clsN = n => n == null ? '' : n >= 0 ? 'pos' : 'neg';

    // Pill stato
    const pill = (bud, fat) => {
      if (fat === 0) return '<span class="badge badge-red">nessun fat.</span>';
      const d = bud > 0 ? (fat - bud) / bud * 100 : 0;
      if (d >= 10)  return '<span class="badge badge-green">sopra target</span>';
      if (d >= -10) return '<span class="badge badge-gray">in linea</span>';
      return '<span class="badge badge-red">sotto target</span>';
    };

    const rows_html = [...enriched]
      .sort((a, b) => b.bud - a.bud)
      .map(r => {
        const d = r.bud > 0 ? (r.fat - r.bud) / r.bud * 100 : null;
        const w = r.bud > 0 ? Math.min(100, r.fat / r.bud * 100) : 0;
        const bc = d == null ? '#6B6860' : d >= 10 ? '#2D7D4F' : d >= -10 ? '#378ADD' : '#C84B2F';
        return `<tr>
          <td>${r.cliente}</td>
          <td class="num-right">${eur(r.bud)}</td>
          <td class="num-right">
            <div class="b-inline-bar">
              <div class="b-mini-bg"><div class="b-mini-fill" style="width:${w.toFixed(0)}%;background:${bc}"></div></div>
              ${eur(r.fat)}
            </div>
          </td>
          <td class="num-right ${clsN(d)}" style="font-weight:500">${pct(d)}</td>
          <td>${pill(r.bud, r.fat)}</td>
        </tr>`;
      }).join('');

    root.innerHTML = `
      <p class="b-sec">fat. mese anno prec vs evaso mese corrente</p>
      <div class="b-g2">
        <div class="b-kcard"><p class="b-klabel">fat. mese anno prec (budget)</p><p class="b-kval">${eur(totBud)}</p></div>
        <div class="b-kcard"><p class="b-klabel">evaso mese corrente</p><p class="b-kval">${eur(totFat)}</p><p class="b-ksub ${clsN(totDelta)}">${pct(totDelta)}</p></div>
      </div>
      <input type="text" class="b-srch" placeholder="cerca cliente…" oninput="filterBudgetClienti(this.value)" id="b-srch-input">
      <div class="b-panel" style="padding:.75rem 1.25rem">
        <table class="b-tbl" id="b-clienti-tbl">
          <thead><tr>
            <th>cliente</th>
            <th style="text-align:right">fat. anno prec</th>
            <th style="text-align:right">evaso 2026</th>
            <th style="text-align:right">delta %</th>
            <th>stato</th>
          </tr></thead>
          <tbody id="b-clienti-body">${rows_html}</tbody>
        </table>
      </div>
    `;

    // Salva righe per il filtro
    window._budgetClientiRows = enriched;

  } catch (err) {
    document.getElementById('bpane-clienti').innerHTML =
      `<p style="color:var(--red);padding:1rem">Errore: ${err.message}</p>`;
  }
}

function filterBudgetClienti(q) {
  const rows = (window._budgetClientiRows || [])
    .filter(r => r.cliente.toLowerCase().includes(q.toLowerCase()));

  const eur = n => n != null ? '€ ' + Number(n).toLocaleString('it-IT', {minimumFractionDigits: 0, maximumFractionDigits: 0}) : '—';
  const pct = n => n != null ? (n >= 0 ? '+' : '') + Number(n).toFixed(1).replace('.', ',') + '%' : '—';
  const clsN = n => n == null ? '' : n >= 0 ? 'pos' : 'neg';
  const pill = (bud, fat) => {
    if (fat === 0) return '<span class="badge badge-red">nessun fat.</span>';
    const d = bud > 0 ? (fat - bud) / bud * 100 : 0;
    if (d >= 10)  return '<span class="badge badge-green">sopra target</span>';
    if (d >= -10) return '<span class="badge badge-gray">in linea</span>';
    return '<span class="badge badge-red">sotto target</span>';
  };

  document.getElementById('b-clienti-body').innerHTML = rows
    .sort((a, b) => b.bud - a.bud)
    .map(r => {
      const d = r.bud > 0 ? (r.fat - r.bud) / r.bud * 100 : null;
      const w = r.bud > 0 ? Math.min(100, r.fat / r.bud * 100) : 0;
      const bc = d == null ? '#6B6860' : d >= 10 ? '#2D7D4F' : d >= -10 ? '#378ADD' : '#C84B2F';
      return `<tr>
        <td>${r.cliente}</td>
        <td class="num-right">${eur(r.bud)}</td>
        <td class="num-right">
          <div class="b-inline-bar">
            <div class="b-mini-bg"><div class="b-mini-fill" style="width:${w.toFixed(0)}%;background:${bc}"></div></div>
            ${eur(r.fat)}
          </div>
        </td>
        <td class="num-right ${clsN(d)}" style="font-weight:500">${pct(d)}</td>
        <td>${pill(r.bud, r.fat)}</td>
      </tr>`;
    }).join('');
}

// ── Helper ────────────────────────────────────────────────────────────────────

function _nomeMese(dateStr) {
  if (!dateStr) return '';
  const nomi = ['gennaio','febbraio','marzo','aprile','maggio','giugno',
                'luglio','agosto','settembre','ottobre','novembre','dicembre'];
  const d = new Date(dateStr);
  return isNaN(d) ? '' : nomi[d.getMonth()] + ' ' + d.getFullYear();
}
