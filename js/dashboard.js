async function loadDashboard() {
  const kpiGrid = document.getElementById('kpi-grid');
  const topBody = document.querySelector('#top-clienti-table tbody');

  kpiGrid.innerHTML = '<div class="loading">Caricamento KPI…</div>';
  topBody.innerHTML = '<tr><td colspan="7" class="loading">Caricamento…</td></tr>';
  document.getElementById('stato-mese').innerHTML = '';

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    kpiGrid.innerHTML = '<div class="loading">Configurazione Supabase mancante</div>';
    return;
  }

  try {
    const now   = new Date();
    const annoC = now.getFullYear();
    const annoP = annoC - 1;

    // Parallel fetch: rolling + ordini mese + ddt + cedi + budget
    const startMese = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const endMese   = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
    const today     = now.toISOString().split('T')[0];

    const [rows, { data: ordiniData }, { data: ddtData }, { data: cediData }, { data: budgetArr }] = await Promise.all([
      loadRollingEnriched(),
      sb.from('ordini').select('totale_ordine, data_ordine')
        .gte('data_ordine', startMese).lte('data_ordine', endMese),
      sb.from('ddt').select('id, stato').eq('stato', 'spedito'),
      sb.from('cedi_ridistribuito')
        .select('ragione_sociale, valore_ridistribuito, data_aggiornamento')
        .order('valore_ridistribuito', { ascending: false }),
      sb.from('budget').select('budget_mese, evaso, giorno_lavorativo, giorni_totali, data_aggiornamento')
        .lte('data_aggiornamento', today)
        .not('budget_mese', 'is', null)
        .order('data_aggiornamento', { ascending: false })
        .limit(1),
    ]);

    // KPI aggregati
    const totProg26  = rows.reduce((s, r) => s + (r.fatt_prog_anno_corr || 0), 0);
    const totProg25  = rows.reduce((s, r) => s + (r.fatt_prog_anno_prec || 0), 0);
    const totCons    = rows.reduce((s, r) => s + (r.mese_consegnato     || 0), 0);
    const totPrep    = rows.reduce((s, r) => s + (r.mese_in_preparazione || 0), 0);
    const totMese26  = rows.reduce((s, r) => s + (r.spedito_ordinato_mese || 0), 0);
    const totMese25  = rows.reduce((s, r) => s + (r.fatt_mese_anno_prec   || 0), 0);
    const varMesePct = totMese25 > 0 ? ((totMese26 - totMese25) / totMese25) * 100 : null;
    const varProgPct = totProg25 > 0 ? ((totProg26 - totProg25) / totProg25) * 100 : null;

    const ordiniCount  = ordiniData?.length || 0;
    const ordiniValue  = (ordiniData || []).reduce((s, o) => s + (o.totale_ordine || 0), 0);
    const ddtCount     = ddtData?.length || 0;
    const totCEDI      = (cediData || []).reduce((s, r) => s + (r.valore_ridistribuito || 0), 0);
    const cediDate     = (cediData || []).reduce((d, r) => (r.data_aggiornamento > d ? r.data_aggiornamento : d), '');
    const budget       = budgetArr?.[0] || null;
    const budgetPct    = budget?.budget_mese > 0 ? (budget.evaso / budget.budget_mese) * 100 : null;
    const budgetColor  = budgetPct == null ? 'var(--text2)' : budgetPct >= 100 ? 'var(--green)' : budgetPct >= 80 ? '#378ADD' : budgetPct >= 40 ? '#D97706' : 'var(--red)';

    const cediSub = totCEDI > 0
      ? `<div class="kpi-sub" style="margin-top:4px;font-size:11px;color:var(--text2)">di cui CEDI: €${fmt(totCEDI)}${cediDate ? ' · ' + fmtDate(cediDate) : ''}</div>`
      : '';

    kpiGrid.innerHTML = `
      <div class="kpi-card">
        <h3>Fatturato del mese</h3>
        <div class="kpi-value">€${fmt(totMese26)}</div>
        <div class="kpi-sub">Cons. €${fmt(totCons)} · Prep. €${fmt(totPrep)}</div>
        ${cediSub}
        ${varMesePct != null ? `<div class="kpi-change ${varMesePct >= 0 ? 'positive' : 'negative'}">${varMesePct >= 0 ? '+' : ''}${varMesePct.toFixed(1)}% vs ${annoP}</div>` : ''}
      </div>
      <div class="kpi-card">
        <h3>Progressivo ${annoC}</h3>
        <div class="kpi-value">€${fmt(totProg26)}</div>
        <div class="kpi-sub">Stesso periodo ${annoP}: €${fmt(totProg25)}</div>
        ${varProgPct != null ? `<div class="kpi-change ${varProgPct >= 0 ? 'positive' : 'negative'}">${varProgPct >= 0 ? '+' : ''}${varProgPct.toFixed(1)}%</div>` : ''}
      </div>
      ${budget ? `
      <div class="kpi-card">
        <h3>vs Budget mese</h3>
        <div class="kpi-value" style="color:${budgetColor}">${budgetPct != null ? budgetPct.toFixed(1) + '%' : '—'}</div>
        <div class="kpi-sub">Evaso €${fmt(budget.evaso)} / €${fmt(budget.budget_mese)}</div>
        <div class="kpi-sub" style="font-size:11px">Giorno ${budget.giorno_lavorativo ?? '?'}/${budget.giorni_totali ?? '?'} · ${fmtDate(budget.data_aggiornamento)}</div>
      </div>` : ''}
      <div class="kpi-card">
        <h3>Ordini del mese</h3>
        <div class="kpi-value">${ordiniCount}</div>
        <div class="kpi-sub">€${fmt(ordiniValue)}</div>
      </div>
      <div class="kpi-card">
        <h3>DDT in transito</h3>
        <div class="kpi-value">${ddtCount}</div>
        <div class="kpi-sub">Stato: spedito</div>
      </div>`;

    renderStatoMese(rows);

    // Top 10 gap progressivo
    const meseCorrLabel = MESI_LABEL[now.getMonth()];
    document.getElementById('top-clienti-h2').textContent = `Top 10 da recuperare vs ${annoP}`;

    const top10 = [...rows]
      .filter(r => !r._escluso && r.ragione_sociale && (r.variazione_progressivo || 0) < 0)
      .sort((a, b) => (a.variazione_progressivo || 0) - (b.variazione_progressivo || 0))
      .slice(0, 10);

    topBody.innerHTML = top10.length
      ? top10.map((r, i) => {
          const p25    = r.fatt_prog_anno_prec || 0;
          const p26    = r.fatt_prog_anno_corr || 0;
          const gapEUR = r.variazione_progressivo || 0;
          const gapPct = p25 > 0 ? (gapEUR / p25) * 100 : null;
          const stBadge = `<span class="badge ${statoBadgeCls(r._stato.id)}">${r._stato.label}</span>`;
          return `
          <tr class="ordine-row" onclick="apriClienteDaDashboard('${r.codice_cliente}','${(r.ragione_sociale||'').replace(/'/g,"\\'")}')" style="cursor:pointer;">
            <td><strong>${i + 1}</strong></td>
            <td style="color:var(--accent);text-decoration:underline;">${r.ragione_sociale}</td>
            <td class="num-right">€${fmt(p25)}</td>
            <td class="num-right">€${fmt(p26)}</td>
            <td class="num-right" style="color:var(--red);font-weight:600">€${fmt(gapEUR)}</td>
            <td class="num-right">${gapPct != null ? `<span style="color:var(--red);font-weight:600">${gapPct.toFixed(1)}%</span>` : '—'}</td>
            <td>${stBadge}</td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="7" class="loading">Nessun dato disponibile</td></tr>';

  } catch (err) {
    console.error('Errore dashboard:', err);
    kpiGrid.innerHTML = `<div class="loading">Errore: ${err.message}</div>`;
  }
}

function renderStatoMese(rows) {
  const el = document.getElementById('stato-mese');
  if (!el || !rows?.length) return;

  const ries       = riepilogoStato(rows);
  const pctFill    = ries.totPrec > 0 ? Math.min(100, (ries.totCorr / ries.totPrec) * 100) : 0;
  const barColor   = pctFill >= 80 ? 'var(--green)' : pctFill >= 40 ? '#D97706' : 'var(--red)';
  const meseLabel  = MESI_LABEL[new Date().getMonth()];
  const totMedia   = rows.reduce((s, r) => s + r._media, 0);
  const gapMedia   = Math.max(0, totMedia - ries.totCorr);
  const daAttivare = (ries.byStato.da_visitare?.count || 0) +
                     (ries.byStato.indietro?.count      || 0) +
                     (ries.byStato.da_stimolare?.count  || 0);

  const CHIP_ORDER = ['ottimo','in_linea','da_stimolare','indietro','da_visitare','nuovo','inattivo'];

  const chips = CHIP_ORDER.map(id => {
    const info = ries.byStato[id];
    if (!info?.count) return '';
    const cls   = statoBadgeCls(id);
    const color = { 'badge-blue': '#1A56DB', 'badge-green': 'var(--green)',
                    'badge-orange': '#D97706', 'badge-red': 'var(--red)',
                    'badge-gray': '#6B6860' }[cls] || '#6B6860';
    return `<button class="stato-chip" style="color:${color};border-color:${color};"
        onclick="filtraPerStato('${id}')" title="${STATI[id].desc}">
      <span class="stato-chip-count">${info.count}</span>
      <span class="stato-chip-label">${STATI[id].label}</span>
    </button>`;
  }).join('');

  el.innerHTML = `
    <div class="stato-mese-card">
      <h3 style="font-family:'DM Sans',sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text2);margin-bottom:12px;">
        Stato ordini · ${meseLabel} ${new Date().getFullYear()}
      </h3>
      <div class="stato-mese-header">
        <div>
          <span class="stato-mese-total">€${fmt(ries.totCorr)}</span>
          <span style="font-size:14px;color:var(--text2);margin-left:10px;">/ €${fmt(ries.totPrec)} anno scorso</span>
        </div>
        <span class="stato-mese-pct" style="color:${barColor};">${pctFill.toFixed(1)}%</span>
      </div>
      <div class="mese-progress-bar">
        <div class="mese-progress-fill" style="width:${pctFill.toFixed(1)}%;background:${barColor};"></div>
      </div>
      <div class="stato-chips">${chips}</div>
      <div class="gap-row">
        <span class="gap-row-text">
          Gap vs anno scorso: <strong style="color:var(--red);">€${fmt(ries.totGap)}</strong>
          &nbsp;·&nbsp; ${daAttivare} clienti da attivare
          ${gapMedia > 0 ? `&nbsp;·&nbsp; vs media mensile: <strong>€${fmt(gapMedia)}</strong>` : '&nbsp;·&nbsp; <strong style="color:var(--green);">Sopra la media ✓</strong>'}
        </span>
        <button class="gap-row-btn" onclick="filtraPerStato('da_visitare')">Vedi lista →</button>
      </div>
    </div>`;
}

// ── Seed ─────────────────────────────────────────────────────────────────────

async function seedRollingFatturato() {
  const kpiGrid = document.getElementById('kpi-grid');
  kpiGrid.innerHTML = '<div class="loading">Popolamento rolling_fatturato in corso…</div>';
  try {
    const { data: ordiniData, error } = await sb.from('ordini')
      .select('data_ordine, totale_ordine').order('data_ordine', { ascending: true });
    if (error) throw error;
    if (!ordiniData?.length) throw new Error('Nessun ordine disponibile.');

    function mkKey(ds) {
      const d = new Date(ds);
      if (isNaN(d)) return null;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    const totByMonth = (ordiniData).reduce((acc, o) => {
      const k = mkKey(o.data_ordine);
      if (k) acc[k] = (acc[k] || 0) + Number(o.totale_ordine || 0);
      return acc;
    }, {});

    const records = Object.keys(totByMonth).sort().map(k => {
      const [y, m] = k.split('-').map(Number);
      const curr  = totByMonth[k];
      const lyKey = `${y - 1}-${String(m).padStart(2, '0')}`;
      const ly    = totByMonth[lyKey] || 0;
      const ytd   = Object.keys(totByMonth)
        .filter(kk => kk.startsWith(`${y}-`) && kk <= k)
        .reduce((s, kk) => s + totByMonth[kk], 0);
      return {
        data_aggiornamento: `${y}-${String(m).padStart(2, '0')}-01`,
        mese_consegnato:    +curr.toFixed(2),
        fatt_mese_anno_prec: +ly.toFixed(2),
        variazione_mese:    +(ly ? ((curr - ly) / ly * 100) : 0).toFixed(2),
        fatt_prog_anno_corr: +ytd.toFixed(2),
        gto_mag_2026:       y === 2026 ? +ytd.toFixed(2) : 0,
      };
    });

    const { error: ie } = await sb.from('rolling_fatturato').insert(records);
    if (ie) throw ie;
    _latestRollingDate = null;
    _rollingEnriched   = null;
    await loadDashboard();
  } catch (err) {
    document.getElementById('kpi-grid').innerHTML = `<div class="loading">Errore: ${err.message}</div>`;
  }
}
