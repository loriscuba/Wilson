// ── Budget page ───────────────────────────────────────────────────────────────

let _budgetTab      = 'mensile';
let _bcFilter       = null;   // stato filter chip attivo
let _bcSort         = { col: 'priority', dir: 1 };
let _bcRows         = [];
let _bcQuery        = '';

// ── Tab switch ────────────────────────────────────────────────────────────────
function swBudget(tab, btn) {
  _budgetTab = tab;
  document.querySelectorAll('.budget-tab').forEach(t => t.classList.remove('on'));
  document.querySelectorAll('.budget-pane').forEach(p => p.classList.remove('on'));
  document.getElementById('bpane-' + tab)?.classList.add('on');
  btn.classList.add('on');
}

async function loadBudget() {
  await Promise.all([loadBudgetMensile(), loadBudgetClienti()]);
}

// ── Helpers formatters ────────────────────────────────────────────────────────
const _eur  = n => n != null ? '€ ' + Math.round(n).toLocaleString('it-IT') : '—';
const _pct  = n => n != null ? (n >= 0 ? '+' : '') + Number(n).toFixed(1).replace('.', ',') + '%' : '—';
const _cls  = n => n == null ? '' : n >= 0 ? 'pos' : 'neg';
const _mini = (val, tot, color) => {
  const w = tot > 0 ? Math.min(100, (val / tot) * 100) : 0;
  return `<div class="b-bbg"><div class="b-bfill" style="width:${w.toFixed(1)}%;background:${color}"></div></div>`;
};
const _nomeMese = s => {
  if (!s) return '';
  const nomi = ['gennaio','febbraio','marzo','aprile','maggio','giugno',
                'luglio','agosto','settembre','ottobre','novembre','dicembre'];
  const d = new Date(s); return isNaN(d) ? '' : nomi[d.getMonth()] + ' ' + d.getFullYear();
};

// ── TAB MENSILE ───────────────────────────────────────────────────────────────
async function loadBudgetMensile() {
  const root = document.getElementById('bpane-mensile');
  if (!root) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: bArr, error: bErr } = await sb.from('budget')
      .select('*').lte('data_aggiornamento', today)
      .order('data_aggiornamento', { ascending: false }).limit(1);
    if (bErr) throw bErr;
    const b = bArr?.[0];
    const { data: focus } = b
      ? await sb.from('budget_focus').select('*').eq('data_aggiornamento', b.data_aggiornamento).order('gruppo_prodotti')
      : { data: [] };

    if (!b) {
      root.innerHTML = '<p style="color:var(--text2);padding:1rem">Nessun dato budget.<br>Importa il PDF Avanzamento tramite il flusso Wilson Sync.</p>';
      return;
    }

    const meseNome = _nomeMese(b.data_aggiornamento);
    const pctGiorno = b.obiettivo_giornaliero > 0 ? (b.fatturato_giorno / b.obiettivo_giornaliero) * 100 : null;

    const focusHTML = (focus && focus.length)
      ? focus.map(f => {
          const pF = f.target_eur > 0 ? (f.consegnato_eur / f.target_eur) * 100 : null;
          const w  = Math.min(100, pF ?? 0);
          const lbl = f.gruppo_prodotti.length > 60 ? f.gruppo_prodotti.slice(0, 60) + '…' : f.gruppo_prodotti;
          return `<tr>
            <td style="font-size:12px;color:var(--text2)">${lbl}</td>
            <td class="num-right">${_eur(f.target_eur)}</td>
            <td class="num-right">
              <div class="b-inline-bar">
                <div class="b-mini-bg"><div class="b-mini-fill" style="width:${w.toFixed(0)}%;background:#378ADD"></div></div>
                ${_eur(f.consegnato_eur)}
              </div>
            </td>
            <td class="num-right" style="color:#378ADD;font-weight:500">${pF != null ? pF.toFixed(0) + '%' : '—'}</td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="4" style="color:var(--text2);font-size:12px;padding:8px 0">Nessun dato focus per questa data</td></tr>';

    root.innerHTML = `
      <p class="b-sec">progressivo gen–apr · ${fmtDate(b.data_aggiornamento)}</p>
      <div class="b-g4">
        <div class="b-kcard"><p class="b-klabel">budget gen–apr</p><p class="b-kval">${_eur(b.budget_gen_apr)}</p></div>
        <div class="b-kcard"><p class="b-klabel">fatturato gen–apr</p><p class="b-kval">${_eur(b.fatturato_gen_apr)}</p></div>
        <div class="b-kcard"><p class="b-klabel">delta su budget</p><p class="b-kval ${_cls(b.delta_budget_eur)}">${b.delta_budget_eur >= 0 ? '+' : ''}${_eur(b.delta_budget_eur)}</p><p class="b-ksub ${_cls(b.delta_budget_pct)}">${_pct(b.delta_budget_pct)}</p></div>
      </div>

      <p class="b-sec">${meseNome} · giorno ${b.giorno_lavorativo ?? '?'} di ${b.giorni_totali ?? '?'}</p>
      <div class="b-panel">
        <div class="b-prow"><span class="b-prow-label">evaso al ${fmtDate(b.data_aggiornamento)}</span><span class="b-prow-val">${_eur(b.evaso)} <span>/ ${_eur(b.budget_mese)}</span></span></div>
        ${_mini(b.evaso, b.budget_mese, '#378ADD')}
        <div style="margin-bottom:10px"></div>
        <div class="b-prow"><span class="b-prow-label">evaso + ordinato – resi</span><span class="b-prow-val">${_eur(b.evaso_ordinato_resi)} <span>/ ${_eur(b.budget_mese)}</span></span></div>
        ${_mini(b.evaso_ordinato_resi, b.budget_mese, '#2D7D4F')}
        <div class="b-hint"><span>fat. ${meseNome} anno prec: ${_eur(b.fatturato_mese_anno_prec)}</span><span class="${_cls(b.delta_mese_eur)}">delta budget: ${_pct(b.delta_mese_pct)} (${b.delta_mese_eur >= 0 ? '+' : ''}${_eur(b.delta_mese_eur)})</span></div>
      </div>

      <div class="b-g4">
        <div class="b-kcard"><p class="b-klabel">ordinato nel mese</p><p class="b-kval" style="font-size:17px">${_eur(b.ordinato_nel_mese)}</p></div>
        <div class="b-kcard"><p class="b-klabel">ordinato oltre mese</p><p class="b-kval" style="font-size:17px">${_eur(b.ordinato_oltre_mese)}</p></div>
        <div class="b-kcard"><p class="b-klabel">resi / correzioni</p><p class="b-kval neg" style="font-size:17px">${_eur(b.resi)}</p></div>
        <div class="b-kcard"><p class="b-klabel">fat. ${meseNome} anno prec</p><p class="b-kval" style="font-size:17px">${_eur(b.fatturato_mese_anno_prec)}</p></div>
      </div>

      <p class="b-sec">avanzamento giornaliero — giorno ${b.giorno_lavorativo ?? '?'}</p>
      <div class="b-panel">
        <div class="b-g4" style="margin-bottom:10px">
          <div style="text-align:center"><p class="b-klabel" style="text-align:center">obiettivo</p><p class="b-kval" style="font-size:17px;text-align:center">${_eur(b.obiettivo_giornaliero)}</p></div>
          <div style="text-align:center"><p class="b-klabel" style="text-align:center">fatturato giorno ${b.giorno_lavorativo}</p><p class="b-kval ${_cls(b.fatturato_giorno - b.obiettivo_giornaliero)}" style="font-size:17px;text-align:center">${_eur(b.fatturato_giorno)}</p></div>
          <div style="text-align:center"><p class="b-klabel" style="text-align:center">ordini inseriti ieri</p><p class="b-kval" style="font-size:17px;text-align:center">${_eur(b.valore_ordini_ieri)}</p></div>
          <div style="text-align:center"><p class="b-klabel" style="text-align:center">nr ordini ieri</p><p class="b-kval" style="font-size:17px;text-align:center">${b.nr_ordini_ieri ?? '—'}</p></div>
        </div>
        ${_mini(b.fatturato_giorno, b.obiettivo_giornaliero, '#378ADD')}
        <div class="b-hint"><span>obiettivo: ${_eur(b.obiettivo_giornaliero)}</span><span>fatturato: ${_eur(b.fatturato_giorno)} <span class="${_cls(b.fatturato_giorno - b.obiettivo_giornaliero)}">(${_pct(pctGiorno ? pctGiorno - 100 : null)})</span></span></div>
      </div>

      <p class="b-sec">prodotti focus — ${meseNome}</p>
      <div class="b-panel">
        <table class="b-tbl">
          <thead><tr><th>gruppo</th><th style="text-align:right">target</th><th style="text-align:right">consegnato</th><th style="text-align:right">%</th></tr></thead>
          <tbody>${focusHTML}</tbody>
        </table>
      </div>`;
  } catch(err) {
    document.getElementById('bpane-mensile').innerHTML =
      `<p style="color:var(--red);padding:1rem">Errore: ${err.message}</p>`;
  }
}

// ── TAB CLIENTI ───────────────────────────────────────────────────────────────

const STATO_ORDER = { indietro: 1, da_visitare: 2, da_stimolare: 3, in_linea: 4, ottimo: 5, nuovo: 6, inattivo: 7 };
const STATO_COLOR = { ottimo: '#2D7D4F', in_linea: '#378ADD', da_stimolare: '#D97706', indietro: '#C84B2F', da_visitare: '#9B9B97', nuovo: '#378ADD', inattivo: '#9B9B97' };

async function loadBudgetClienti() {
  const root = document.getElementById('bpane-clienti');
  if (!root) return;
  root.innerHTML = '<div class="loading">Caricamento clienti…</div>';
  try {
    const rows = await loadRollingEnriched();
    if (!rows.length) {
      root.innerHTML = '<p style="color:var(--text2);padding:1rem">Nessun dato rolling disponibile.</p>';
      return;
    }

    _bcRows = rows.map(r => ({
      cliente:    r.ragione_sociale || '—',
      divisione:  r.divisione || '',
      stato:      r._stato,
      bud:        r.fatt_mese_anno_prec    || 0,
      ord:        r.spedito_ordinato_mese  || 0,   // evaso+prep+da spedire
      cons:       r.mese_consegnato        || 0,
      prep:       r.mese_in_preparazione   || 0,
      sped:       r.mese_da_spedire        || 0,
      oltre:      r.ordinato_oltre_mese    || 0,
      prog26:     r.fatt_prog_anno_corr    || 0,
      prog25:     r.fatt_prog_anno_prec    || 0,
      varProg:    r.variazione_progressivo,
      gap:        r._gap                  || 0,    // max(0, bud - ord)
      priority:   STATO_ORDER[r._stato?.id] || 9,
    }));

    _bcFilter = null;
    _bcQuery  = '';
    _bcSort   = { col: 'priority', dir: 1 };
    _renderClienti(root);
  } catch(err) {
    root.innerHTML = `<p style="color:var(--red);padding:1rem">Errore: ${err.message}</p>`;
  }
}

function _renderClienti(root) {
  const rows = _bcRows;
  if (!rows.length) return;

  // Aggregati totali
  const totBud   = rows.reduce((s, r) => s + r.bud,    0);
  const totOrd   = rows.reduce((s, r) => s + r.ord,    0);
  const totGap   = rows.reduce((s, r) => s + r.gap,    0);
  const totP26   = rows.reduce((s, r) => s + r.prog26, 0);
  const totP25   = rows.reduce((s, r) => s + r.prog25, 0);
  const dProg    = totP25 > 0 ? (totP26 - totP25) / totP25 * 100 : null;
  const dMese    = totBud > 0 ? (totOrd - totBud) / totBud * 100 : null;

  // Aggrega per stato
  const byStato = {};
  for (const r of rows) {
    const id = r.stato?.id || 'inattivo';
    if (!byStato[id]) byStato[id] = { count: 0, gap: 0 };
    byStato[id].count++;
    byStato[id].gap += r.gap;
  }

  // Chip html
  const allCount = rows.length;
  const chipHtml = [
    { id: '',            label: 'Tutti',         color: '#6B6860' },
    { id: 'indietro',    label: 'Indietro',       color: STATO_COLOR.indietro },
    { id: 'da_visitare', label: 'Da visitare',    color: STATO_COLOR.da_visitare },
    { id: 'da_stimolare',label: 'Da stimolare',   color: STATO_COLOR.da_stimolare },
    { id: 'in_linea',    label: 'In linea',       color: STATO_COLOR.in_linea },
    { id: 'ottimo',      label: 'Ottimo',         color: STATO_COLOR.ottimo },
    { id: 'inattivo',    label: 'Inattivo/Nuovo', color: STATO_COLOR.inattivo },
  ].map(c => {
    const cnt  = c.id ? (byStato[c.id]?.count || 0) : allCount;
    const gap  = c.id ? (byStato[c.id]?.gap   || 0) : totGap;
    if (c.id && cnt === 0) return '';
    const on      = (_bcFilter || '') === c.id ? 'on' : '';
    const gapStr  = gap > 0 ? ` · –${_eur(gap)}` : '';
    // data-stato invece di inline JSON per evitare quoting HTML
    return `<button class="bc-chip ${on}" data-stato="${c.id}" style="--chip-c:${c.color}" onclick="setBcFilter(this.dataset.stato)">${c.label} <span class="bc-chip-cnt">${cnt}${gapStr}</span></button>`;
  }).join('');

  // Filtro + sort + render righe
  const html = `
    <div class="bc-kpi-strip">
      <div class="bc-kpi"><div class="bc-kpi-label">budget mese</div><div class="bc-kpi-val">${_eur(totBud)}</div></div>
      <div class="bc-kpi"><div class="bc-kpi-label">ordinato mese</div><div class="bc-kpi-val ${_cls(dMese)}">${_eur(totOrd)}</div><div class="bc-kpi-sub ${_cls(dMese)}">${_pct(dMese)} vs anno prec</div></div>
      <div class="bc-kpi bc-kpi-neg"><div class="bc-kpi-label">gap da recuperare</div><div class="bc-kpi-val neg">–${_eur(totGap)}</div></div>
      <div class="bc-kpi"><div class="bc-kpi-label">progressivo 2026</div><div class="bc-kpi-val">${_eur(totP26)}</div><div class="bc-kpi-sub ${_cls(dProg)}">${_pct(dProg)} vs 2025</div></div>
    </div>
    <div class="bc-chips" id="bc-chips">${chipHtml}</div>
    <div class="bc-toolbar">
      <input type="text" class="b-srch" id="bc-srch" placeholder="cerca cliente…" value="${_bcQuery}" oninput="onBcSearch(this.value)">
    </div>
    <div class="b-panel" style="padding:.5rem 1rem;overflow-x:auto">
      <table class="b-tbl bc-tbl" id="bc-table">
        <thead><tr>
          <th class="bc-th-stato bc-srt" onclick="onBcSort('priority')">STATO ${_sortArrow('priority')}</th>
          <th class="bc-th-cliente bc-srt" onclick="onBcSort('cliente')">CLIENTE ${_sortArrow('cliente')}</th>
          <th class="bc-th-num bc-srt" onclick="onBcSort('ord')">ORDINATO MESE ${_sortArrow('ord')}</th>
          <th class="bc-th-narrow bc-srt" onclick="onBcSort('varMese')">Δ% MESE ${_sortArrow('varMese')}</th>
          <th class="bc-th-num bc-srt" onclick="onBcSort('gap')">GAP ${_sortArrow('gap')}</th>
          <th class="bc-th-detail">CONS · PREP · SPED</th>
          <th class="bc-th-num bc-srt" onclick="onBcSort('prog26')">PROG 2026 ${_sortArrow('prog26')}</th>
          <th class="bc-th-narrow bc-srt" onclick="onBcSort('varProg')">Δ% PROG ${_sortArrow('varProg')}</th>
        </tr></thead>
        <tbody id="bc-tbody"></tbody>
      </table>
    </div>`;

  root.innerHTML = html;
  _renderBcRows();
}

function _sortArrow(col) {
  if (_bcSort.col !== col) return '<span style="opacity:.3">↕</span>';
  return _bcSort.dir === 1 ? '↓' : '↑';
}

function _renderBcRows() {
  const tbody = document.getElementById('bc-tbody');
  if (!tbody) return;

  // Filtro stato + ricerca
  let visible = _bcRows.filter(r => {
    if (_bcFilter) {
      const id = r.stato?.id || 'inattivo';
      // chip "inattivo" copre anche "nuovo"
      if (_bcFilter === 'inattivo' ? (id !== 'inattivo' && id !== 'nuovo') : id !== _bcFilter) return false;
    }
    if (_bcQuery) return r.cliente.toLowerCase().includes(_bcQuery.toLowerCase());
    return true;
  });

  // Sort
  const { col, dir } = _bcSort;
  visible.sort((a, b) => {
    let va, vb;
    if (col === 'priority') { va = a.priority; vb = b.priority; }
    else if (col === 'cliente') { return dir * a.cliente.localeCompare(b.cliente, 'it'); }
    else if (col === 'ord')     { va = a.ord;    vb = b.ord; }
    else if (col === 'gap')     { va = a.gap;    vb = b.gap; }
    else if (col === 'prog26')  { va = a.prog26; vb = b.prog26; }
    else if (col === 'varMese') { va = a.bud > 0 ? (a.ord - a.bud) / a.bud : -999; vb = b.bud > 0 ? (b.ord - b.bud) / b.bud : -999; }
    else if (col === 'varProg') { va = a.varProg ?? -999; vb = b.varProg ?? -999; }
    else { va = a.priority; vb = b.priority; }
    // Dentro stesso gruppo di stato (solo per sort priority), gap desc
    if (col === 'priority' && va === vb) return b.gap - a.gap;
    return dir * (va - vb);
  });

  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="padding:1.5rem;text-align:center;color:var(--text2)">Nessun cliente trovato</td></tr>`;
    return;
  }

  tbody.innerHTML = visible.map(r => {
    const statoId    = r.stato?.id || 'inattivo';
    const statoColor = STATO_COLOR[statoId] || '#9B9B97';
    const statoBadge = `<span class="bc-stato" style="background:${statoColor}20;color:${statoColor};border-color:${statoColor}40">${r.stato?.label || '—'}</span>`;

    const barColor   = statoColor;
    const barW       = r.bud > 0 ? Math.min(100, r.ord / r.bud * 100) : 0;
    const varMese    = r.bud > 0 ? (r.ord - r.bud) / r.bud * 100 : null;
    const varMeseBadge = varMese != null
      ? `<span class="bc-badge ${varMese >= 0 ? 'bc-bdg-pos' : varMese >= -20 ? 'bc-bdg-neu' : 'bc-bdg-neg'}">${_pct(varMese)}</span>`
      : '<span class="bc-badge bc-bdg-gray">—</span>';
    const varProgBadge = r.varProg != null
      ? `<span class="bc-badge ${r.varProg >= 0 ? 'bc-bdg-pos' : 'bc-bdg-neg'}">${_pct(r.varProg)}</span>`
      : '<span class="bc-badge bc-bdg-gray">—</span>';

    const gapCell = r.gap > 0
      ? `<span class="neg" style="font-weight:500">–${_eur(r.gap)}</span>`
      : `<span class="pos" style="font-size:11px">in target</span>`;

    const dettaglio = [
      r.cons > 0 ? `<span class="bc-det-item">Cons. ${_eur(r.cons)}</span>` : '',
      r.prep > 0 ? `<span class="bc-det-item bc-det-prep">Prep. ${_eur(r.prep)}</span>` : '',
      r.sped > 0 ? `<span class="bc-det-item bc-det-sped">Sped. ${_eur(r.sped)}</span>` : '',
      r.oltre > 0 ? `<span class="bc-det-item bc-det-oltre">+${_eur(r.oltre)} oltre</span>` : '',
    ].filter(Boolean).join(' ');

    return `<tr class="bc-row bc-row-${statoId}">
      <td>${statoBadge}</td>
      <td>
        <div class="bc-cliente-nome">${r.cliente}</div>
        ${r.divisione ? `<div class="bc-cliente-div">${r.divisione}</div>` : ''}
      </td>
      <td>
        <div class="bc-bar-wrap">
          <div class="b-bbg bc-barline"><div class="b-bfill" style="width:${barW.toFixed(1)}%;background:${barColor}"></div></div>
          <div class="bc-bar-vals">${_eur(r.ord)} <span class="bc-bud">/ ${_eur(r.bud)}</span></div>
        </div>
      </td>
      <td>${varMeseBadge}</td>
      <td>${gapCell}</td>
      <td><div class="bc-det">${dettaglio || '<span style="color:var(--text2);font-size:11px">—</span>'}</div></td>
      <td>
        <div style="font-weight:500">${_eur(r.prog26)}</div>
        <div style="font-size:11px;color:var(--text2)">${_eur(r.prog25)} 2025</div>
      </td>
      <td>${varProgBadge}</td>
    </tr>`;
  }).join('');
}

// ── Event handlers clienti ────────────────────────────────────────────────────
function setBcFilter(stato) {
  _bcFilter = stato || null;  // stringa vuota '' → null (chip "Tutti")
  document.querySelectorAll('.bc-chip').forEach(c => {
    c.classList.toggle('on', c.dataset.stato === (stato || ''));
  });
  _renderBcRows();
}

function onBcSearch(q) {
  _bcQuery = q;
  _renderBcRows();
}

function onBcSort(col) {
  if (_bcSort.col === col) _bcSort.dir *= -1;
  else { _bcSort.col = col; _bcSort.dir = col === 'priority' ? 1 : -1; }
  // Aggiorna frecce in tutti gli header
  document.querySelectorAll('.bc-tbl thead th[onclick]').forEach(th => {
    const m = th.getAttribute('onclick')?.match(/onBcSort\('(.+)'\)/);
    if (!m) return;
    const arrow = th.querySelector('span');
    if (arrow) arrow.outerHTML = _sortArrow(m[1]);
  });
  _renderBcRows();
}
