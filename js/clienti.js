let _clientiData        = [];   // raw clienti records
let _clientiFiltrati    = [];   // subset attualmente visibile (usato per bulk edit)
let _rollingByCode      = {};   // codice_cliente → enriched rolling record
let _pendingOpenCodice  = null; // auto-espandi questo cliente dopo il caricamento

const _GIORNI_VISITA = ['Lunedì','Martedì','Mercoledì','Giovedì','Venerdì','Sabato'];

function apriClienteDaDashboard(codice) {
  _pendingOpenCodice = codice;
  const el = document.getElementById('filtro-clienti');
  if (el) el.value = codice;
  const sel = document.getElementById('filtro-stato');
  if (sel) sel.value = '';
  showPage('clienti', { preventDefault: () => {} });
}

function filtraPerStato(statoId) {
  showPage('clienti', { preventDefault: () => {} });
  const sel = document.getElementById('filtro-stato');
  if (sel) sel.value = statoId;
  filterClienti(document.getElementById('filtro-clienti')?.value || '');
}

function filterClienti(q) {
  const countEl   = document.getElementById('clienti-count');
  const statoFilt = document.getElementById('filtro-stato')?.value || '';
  const needle    = q.trim().toLowerCase();

  _clientiFiltrati = _clientiData.filter(c => {
    const matchQ = !needle ||
      (c.ragione_sociale || '').toLowerCase().includes(needle) ||
      (c.citta           || '').toLowerCase().includes(needle) ||
      (c.provincia       || '').toLowerCase().includes(needle) ||
      (c.settori?.nome   || '').toLowerCase().includes(needle) ||
      (c.codice_cliente  || '').includes(needle);
    const rolling   = _rollingByCode[c.codice_cliente];
    const matchSt   = !statoFilt || rolling?._stato?.id === statoFilt;
    return matchQ && matchSt;
  });

  countEl.textContent = _clientiFiltrati.length;
  renderClientiRows(_clientiFiltrati);
  _aggiornaBulkBar();
}

function _aggiornaBulkBar() {
  const lbl = document.getElementById('bulk-giorno-label');
  if (!lbl) return;
  const n = _clientiFiltrati.length;
  lbl.textContent = n > 0 ? `${n} visibili` : '';
}

function renderClientiRows(data) {
  const tbody = document.querySelector('#clienti-table tbody');
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="loading">Nessun cliente trovato</td></tr>';
    return;
  }
  tbody.innerHTML = data.map(c => {
    const cod     = c.codice_cliente || '';
    const nome    = (c.ragione_sociale || '').replace(/'/g, "\\'");
    const rolling = _rollingByCode[cod];
    const stBadge = rolling
      ? `<span class="badge ${statoBadgeCls(rolling._stato.id)}">${rolling._stato.label}</span>`
      : '<span class="badge badge-gray">—</span>';
    const giornoOpts = '<option value="">—</option>' +
      _GIORNI_VISITA.map(g => `<option${c.giorno_visita === g ? ' selected' : ''}>${g}</option>`).join('');
    return `
    <tr class="cliente-row" onclick="toggleClienteDetail('${cod}', '${nome}', this)">
      <td><button class="expand-btn" id="cexp-${cod}">▶</button></td>
      <td><strong>${c.ragione_sociale || '—'}</strong></td>
      <td>${c.citta || '—'}</td>
      <td>${c.provincia || '—'}</td>
      <td>${c.settori?.nome || '—'}</td>
      <td>${c.categorie?.nome || '—'}</td>
      <td class="td-giorno" onclick="event.stopPropagation()">
        <select class="giorno-sel" id="gsel-${cod}" onchange="salvaGiornoVisita('${cod}',this.value)">
          ${giornoOpts}
        </select>
      </td>
      <td>${stBadge}</td>
    </tr>
    <tr class="cliente-detail-row" id="cdetail-row-${cod}">
      <td colspan="8"><div class="cliente-detail-inner" id="cdetail-${cod}"></div></td>
    </tr>`;
  }).join('');
}

async function loadClienti() {
  const tbody  = document.querySelector('#clienti-table tbody');
  const countEl = document.getElementById('clienti-count');
  tbody.innerHTML = '<tr><td colspan="8" class="loading">Caricamento…</td></tr>';

  try {
    const [{ data: clienti, error }, rolling] = await Promise.all([
      sb.from('clienti')
        .select('codice_cliente, ragione_sociale, citta, provincia, giorno_visita, settori(nome), categorie(nome), attivo')
        .eq('attivo', true)
        .order('ragione_sociale', { ascending: true }),
      loadRollingEnriched(),
    ]);
    if (error) throw error;

    _clientiData   = clienti || [];
    _clientiFiltrati = _clientiData;
    _rollingByCode = Object.fromEntries(rolling.map(r => [r.codice_cliente, r]));

    countEl.textContent = _clientiData.length;
    const q = document.getElementById('filtro-clienti')?.value || '';
    if (q || document.getElementById('filtro-stato')?.value) {
      filterClienti(q);
    } else {
      renderClientiRows(_clientiData);
      _aggiornaBulkBar();
    }

    if (_pendingOpenCodice) {
      const cod = _pendingOpenCodice;
      _pendingOpenCodice = null;
      const c = _clientiData.find(x => String(x.codice_cliente) === String(cod));
      if (c) toggleClienteDetail(cod, c.ragione_sociale || '', document.body);
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="loading">Errore: ${err.message}</td></tr>`;
  }
}

async function toggleClienteDetail(codice, nome, triggerEl) {
  if (triggerEl.tagName === 'BUTTON') return;
  const detailRow = document.getElementById('cdetail-row-' + codice);
  const expandBtn = document.getElementById('cexp-' + codice);
  const isOpen    = detailRow.classList.contains('open');

  detailRow.classList.toggle('open', !isOpen);
  expandBtn.classList.toggle('open', !isOpen);
  if (isOpen) return;

  const inner = document.getElementById('cdetail-' + codice);
  if (inner.dataset.loaded) return;
  inner.innerHTML = '<div class="loading" style="padding:16px 0">Caricamento scheda…</div>';
  await loadClienteDetail(codice, nome, inner);
}

async function loadClienteDetail(codice, nome, container) {
  try {
    const now     = new Date();
    const annoP   = now.getFullYear() - 1;
    const [latestDate, gammaDates] = await Promise.all([
      getLatestRollingDate(),
      getGammaDates(),
    ]);
    const latestGammaDate = gammaDates[0] || null;
    const prevGammaDate   = gammaDates[1] || null;

    const [{ data: rollingRec }, { data: ordiniAttivi }, { data: gammaData }, { data: ordiniStorico }, { data: gammaRefData }, { data: gammaPrevData }] =
      await Promise.all([
        sb.from('rolling_fatturato')
          .select([
            'fatturato_2025, mese_consegnato, mese_in_preparazione, mese_da_spedire, ordinato_oltre_mese',
            'spedito_ordinato_mese, fatt_mese_anno_prec, variazione_mese',
            'fatt_prog_anno_prec, fatt_prog_anno_corr, variazione_progressivo',
            MESI_2025_KEYS.join(', '),
          ].join(', '))
          .eq('codice_cliente', codice)
          .eq('data_aggiornamento', latestDate)
          .maybeSingle(),
        sb.from('ordini')
          .select('id, totale_ordine, stato')
          .eq('codice_cliente', codice)
          .not('stato', 'in', '("consegnato","annullato")'),
        sb.from('gamma_penetrazione')
          .select('settore, pct_immancabili, pct_strategiche, fatturato_anno, prodotti_acquistati, data_aggiornamento')
          .eq('codice_cliente', codice)
          .eq('data_aggiornamento', latestGammaDate)
          .order('settore'),
        sb.from('ordini')
          .select('data_ordine, totale_ordine')
          .eq('codice_cliente', codice)
          .neq('stato', 'annullato')
          .order('data_ordine', { ascending: false })
          .limit(24),
        sb.from('gamma_penetrazione')
          .select('settore, prodotti_acquistati')
          .eq('data_aggiornamento', latestGammaDate),
        prevGammaDate
          ? sb.from('gamma_penetrazione')
              .select('settore, prodotti_acquistati')
              .eq('codice_cliente', codice)
              .eq('data_aggiornamento', prevGammaDate)
          : Promise.resolve({ data: [] }),
      ]);

    const r       = enrichRecord(rollingRec || {});
    const meseSped = r.spedito_ordinato_mese || 0;
    const mesePrec = r.fatt_mese_anno_prec   || 0;
    const mesePrep = r.mese_in_preparazione  || 0;
    const meseCons = r.mese_consegnato       || 0;
    const varMese  = mesePrec > 0 ? ((meseSped - mesePrec) / mesePrec) * 100 : null;
    const nOrdini  = ordiniAttivi?.length || 0;
    const valOrdini = (ordiniAttivi || []).reduce((s, o) => s + (o.totale_ordine || 0), 0);

    // Stato badge
    const stBadge = `<span class="badge ${statoBadgeCls(r._stato.id)}" style="font-size:13px;padding:4px 12px;">${r._stato.label}</span>`;

    // Costruisce mappa di riferimento: settore → Map<key_normalizzata, nome_display>
    const gammaRef = {};
    for (const row of (gammaRefData || [])) {
      if (!gammaRef[row.settore]) gammaRef[row.settore] = new Map();
      for (const prod of Object.keys(row.prodotti_acquistati || {})) {
        const key = prod.toLowerCase();
        if (!gammaRef[row.settore].has(key)) gammaRef[row.settore].set(key, prod);
      }
    }

    // Mappa prodotti mese precedente per evidenziare i nuovi: settore → Set(label.lower)
    const prevProdMap = {};
    for (const row of (gammaPrevData || [])) {
      prevProdMap[row.settore] = new Set(Object.keys(row.prodotti_acquistati || {}).map(p => p.toLowerCase()));
    }

    // Gamma HTML
    const gamma = gammaData || [];
    const gammaHTML = gamma.length
      ? `<div class="gamma-settori">${gamma.map(g => {
          const prods       = g.prodotti_acquistati ? Object.entries(g.prodotti_acquistati) : [];
          const acquistatiK = new Set(Object.keys(g.prodotti_acquistati || {}).map(p => p.toLowerCase()));
          const refMap      = gammaRef[g.settore] || new Map();
          const mancanti    = [...refMap.entries()].filter(([k]) => !acquistatiK.has(k)).map(([, v]) => v);
          const pctImm = g.pct_immancabili != null ? (g.pct_immancabili * 100).toFixed(0) : null;
          const pctStr = g.pct_strategiche  != null ? (g.pct_strategiche  * 100).toFixed(0) : null;
          const prevProds = prevProdMap[g.settore] || new Set();
          return `<div class="gamma-settore-card">
            <div class="gamma-settore-header">
              <span class="gamma-settore-nome">${g.settore}</span>
              <div class="gamma-pct-badges">
                ${pctImm != null ? `<span class="gamma-pct-badge imm">Immancabili ${pctImm}%</span>` : ''}
                ${pctStr != null ? `<span class="gamma-pct-badge str">Strategiche ${pctStr}%</span>` : ''}
              </div>
            </div>
            ${(prods.length || mancanti.length) ? `<div class="gamma-prodotti">
              ${prods.map(([l, v]) => {
                const isNew = prevGammaDate && prevProds.size > 0 && !prevProds.has(l.toLowerCase());
                return `<span class="gamma-prod-tag${isNew ? ' gamma-prod-new' : ''}" title="€${fmt(v)}">✓ ${l}</span>`;
              }).join('')}
              ${mancanti.map(l => `<span class="gamma-prod-tag gamma-prod-missing">✗ ${l}</span>`).join('')}
            </div>` : ''}
          </div>`;
        }).join('')}</div>`
      : `<div class="cks">Nessun dato gamma per questo cliente</div>`;

    // Ritmo ordini
    const ritmo       = calcolaRitmoOrdini(ordiniStorico || []);
    const ritmoHTML   = ritmo ? buildRitmoHTML(ritmo) : '<div class="cks">Nessun ordine in Wilson</div>';
    const ordineMedio = ritmo?.ultimi12m > 0 ? ritmo.totaleAnno / ritmo.ultimi12m : null;

    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px;">
        <div style="display:flex;align-items:center;gap:10px;">
          ${stBadge}
          <span class="cks">${r._stato.desc}${r._gap > 0 ? ` · gap €${fmt(r._gap)}` : ''}</span>
        </div>
        <button class="btn-ordini" onclick="refreshClienteDetail('${codice}','${nome.replace(/'/g,"\\'")}')">↺ Aggiorna</button>
      </div>
      <div class="cliente-kpi-grid">
        <div class="cliente-kpi-card">
          <h4>Fatturato ${annoP}</h4>
          <div class="ckv">€${fmt(r.fatturato_2025)}</div>
        </div>
        <div class="cliente-kpi-card">
          <h4>Ordine medio</h4>
          <div class="ckv">${ordineMedio != null ? '€' + fmt(ordineMedio) : '—'}</div>
          <div class="cks">${ritmo?.ultimi12m ? ritmo.ultimi12m + ' ordini ultimi 12 mesi' : 'Nessun ordine'}</div>
        </div>
        <div class="cliente-kpi-card">
          <h4>Mese corrente</h4>
          <div class="ckv">€${fmt(meseSped)}</div>
          <div class="cks">Cons. €${fmt(meseCons)} · Prep. €${fmt(mesePrep)}</div>
          ${varMese != null ? `<div class="ckc ${varMese >= 0 ? 'pos' : 'neg'}">${varMese >= 0 ? '+' : ''}${varMese.toFixed(1)}% vs ${annoP} (€${fmt(mesePrec)})</div>` : '<div class="cks">Nessun dato anno prec.</div>'}
        </div>
        <div class="cliente-kpi-card">
          <h4>GAP mese vs ${annoP}</h4>
          <div class="ckv" style="color:${(r.variazione_mese||0) >= 0 ? 'var(--green)' : 'var(--red)'}">€${fmt(r.variazione_mese)}</div>
          <div class="cks">${mesePrec > 0 ? `Prev. ${annoP}: €${fmt(mesePrec)}` : 'Nessun dato anno prec.'}</div>
        </div>
        <div class="cliente-kpi-card">
          <h4>GAP progressivo vs ${annoP}</h4>
          <div class="ckv" style="color:${(r.variazione_progressivo||0) >= 0 ? 'var(--green)' : 'var(--red)'}">€${fmt(r.variazione_progressivo)}</div>
          <div class="cks">Prog. ${annoP}: €${fmt(r.fatt_prog_anno_prec)}</div>
        </div>
        <div class="cliente-kpi-card" style="cursor:pointer;" onclick="goToOrdiniFiltered('${codice}')">
          <h4>Storico Ordini</h4>
          <div class="ckv">${nOrdini}</div>
          <div class="cks">${nOrdini > 0 ? '€' + fmt(valOrdini) + ' in corso' : 'Nessun ordine attivo'}</div>
        </div>
      </div>
      <div class="gamma-section" style="margin-bottom:18px;">
        <h4>Ritmo ordini (Wilson)</h4>
        ${ritmoHTML}
      </div>
      <div class="gamma-section">
        <h4>Penetrazione gamma${gamma.length ? ' · agg. ' + fmtDate(gamma[0].data_aggiornamento) : ''}</h4>
        ${gammaHTML}
      </div>`;

    container.dataset.loaded = '1';
  } catch (err) {
    container.innerHTML = `<div class="loading" style="padding:12px 0">Errore: ${err.message}</div>`;
  }
}

function buildRitmoHTML(ritmo) {
  const { ultOrd, giorniDaUltimo, freqMedia, ultimi12m, totaleAnno, prossimo, urgenza } = ritmo;

  const urgLabel = { ok: '●', urgente: '⚑ Urgente', scaduto: '⚠ Scaduto' }[urgenza];
  const urgCls   = { ok: 'badge-green', urgente: 'badge-orange', scaduto: 'badge-red' }[urgenza];
  const prossimoStr = prossimo
    ? prossimo.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })
    : '—';

  return `<div class="cliente-kpi-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));">
    <div class="cliente-kpi-card">
      <h4>Ultimo ordine</h4>
      <div class="ckv" style="font-size:18px;">${giorniDaUltimo} gg fa</div>
      <div class="cks">${ultOrd.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
    </div>
    <div class="cliente-kpi-card">
      <h4>Frequenza media</h4>
      <div class="ckv" style="font-size:18px;">${freqMedia ? 'ogni ' + freqMedia + ' gg' : '—'}</div>
      <div class="cks">${ultimi12m} ordini ultimi 12 mesi · €${fmt(totaleAnno)}</div>
    </div>
    <div class="cliente-kpi-card">
      <h4>Prossimo stimato</h4>
      <div class="ckv" style="font-size:16px;">${prossimoStr}</div>
      <div class="cks"><span class="badge ${urgCls}">${urgLabel}</span></div>
    </div>
  </div>`;
}

// ── Previsione articoli ───────────────────────────────────────────────────────

async function loadPrevisioneArticoli(codice) {
  const now       = new Date();
  const cutoffStr = new Date(now.getFullYear(), now.getMonth() - 18, 1).toISOString().split('T')[0];

  const [{ data: ordiniConRighe }, { data: gammaClient }] = await Promise.all([
    sb.from('ordini')
      .select('data_ordine, righe_ordine(codice_articolo, descrizione_articolo, quantita, unita_misura)')
      .eq('codice_cliente', codice)
      .neq('stato', 'annullato')
      .gte('data_ordine', cutoffStr)
      .order('data_ordine'),
    sb.from('gamma_penetrazione')
      .select('settore, prodotti_acquistati, data_aggiornamento')
      .eq('codice_cliente', codice)
      .order('data_aggiornamento', { ascending: false })
      .limit(10),
  ]);

  let mancanti = [];
  if (gammaClient?.length) {
    const latestDate = gammaClient[0].data_aggiornamento;
    const settori    = [...new Set(gammaClient.map(g => g.settore))];
    const { data: gammaRef } = await sb.from('gamma_penetrazione')
      .select('settore, prodotti_acquistati')
      .eq('data_aggiornamento', latestDate)
      .in('settore', settori);

    const refMap = {};
    for (const row of (gammaRef || [])) {
      if (!refMap[row.settore]) refMap[row.settore] = new Map();
      for (const p of Object.keys(row.prodotti_acquistati || {}))
        refMap[row.settore].set(p.toLowerCase(), p);
    }
    for (const g of gammaClient) {
      const acquired = new Set(Object.keys(g.prodotti_acquistati || {}).map(p => p.toLowerCase()));
      const ref      = refMap[g.settore] || new Map();
      const missing  = [...ref.entries()].filter(([k]) => !acquired.has(k)).map(([, v]) => v);
      if (missing.length) mancanti.push({ settore: g.settore, prodotti: missing });
    }
  }

  return { ..._calcolaPrevioneArticoli(ordiniConRighe || [], now), mancanti };
}

function _calcolaPrevioneArticoli(ordiniConRighe, now) {
  const pad = n => String(n).padStart(2, '0');
  const ym  = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

  const currentYM = ym(now);
  const prevYM    = ym(new Date(now.getFullYear(), now.getMonth() - 1, 1));

  // Ultimi 12 mesi completi (escluso il mese corrente)
  const window12 = [];
  for (let i = 1; i <= 12; i++)
    window12.push(ym(new Date(now.getFullYear(), now.getMonth() - i, 1)));

  // Aggrega per prodotto/mese
  const prodMap = {};
  for (const ord of ordiniConRighe) {
    if (!ord.data_ordine) continue;
    const month = ord.data_ordine.substring(0, 7);
    for (const riga of ord.righe_ordine || []) {
      const cod = riga.codice_articolo;
      if (!cod) continue;
      if (!prodMap[cod]) prodMap[cod] = { descrizione: riga.descrizione_articolo || cod, um: riga.unita_misura || '', byMonth: {} };
      prodMap[cod].byMonth[month] = (prodMap[cod].byMonth[month] || 0) + Number(riga.quantita || 0);
    }
  }

  const results = [];
  for (const [cod, prod] of Object.entries(prodMap)) {
    const activeIn12  = window12.filter(m => (prod.byMonth[m] || 0) > 0);
    if (!activeIn12.length) continue;

    const totalQty    = activeIn12.reduce((s, m) => s + prod.byMonth[m], 0);
    const avgQty      = totalQty / activeIn12.length;
    const rotCycle    = 12 / activeIn12.length;           // mesi tra un ordine e l'altro
    const lastYM      = [...activeIn12].sort().pop();     // mese più recente in window12
    const lastDate    = new Date(lastYM + '-01');
    const mesiDa      = (now.getFullYear() - lastDate.getFullYear()) * 12
                      + (now.getMonth() - lastDate.getMonth());
    const ordNow      = prod.byMonth[currentYM] || 0;
    const isDue       = mesiDa >= rotCycle && ordNow === 0;

    // Carryover solo per articoli mensili (rotCycle ≤ 1.5) con ordine mese precedente < media
    let carryover = 0;
    if (rotCycle <= 1.5 && mesiDa === 1)
      carryover = Math.max(0, avgQty - (prod.byMonth[prevYM] || 0));

    results.push({ cod, descrizione: prod.descrizione, um: prod.um,
      activeIn12: activeIn12.length, avgQty, rotCycle, lastYM,
      mesiDa, isDue, carryover, suggestedQty: Math.round(avgQty + carryover), ordNow });
  }

  results.sort((a, b) => (a.isDue === b.isDue ? b.suggestedQty - a.suggestedQty : a.isDue ? -1 : 1));
  return { products: results, currentYM };
}

async function refreshClienteDetail(codice, nome) {
  const inner = document.getElementById('cdetail-' + codice);
  if (!inner) return;
  delete inner.dataset.loaded;
  // Resetta anche la cache della data rolling: se è stato importato un nuovo file
  // durante la sessione, getLatestRollingDate() deve rileggere la data più recente.
  _latestRollingDate = null;
  _rollingEnriched   = null;
  inner.innerHTML = '<div class="loading" style="padding:16px 0">Aggiornamento…</div>';
  await loadClienteDetail(codice, nome, inner);
}

function goToOrdiniFiltered(codice) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('ordini').classList.add('active');
  _setNavActive('ordini');
  document.getElementById('filtro-da').value = '2020-01-01';
  document.getElementById('filtro-a').value  = '2030-12-31';
  document.getElementById('filtro-cliente').value = codice;
  _filtroStatoOrdine = null;
  document.querySelectorAll('.ord-stato-chip').forEach(c => c.classList.toggle('on', c.dataset.stato === ''));
  loadOrdini();
}

// ── Modifica giorno visita ─────────────────────────────────────────────

async function salvaGiornoVisita(codice, giorno) {
  const valore = giorno || null;
  try {
    await sb.from('clienti').update({ giorno_visita: valore }).eq('codice_cliente', codice);
    const upd = c => { if (c.codice_cliente === codice) c.giorno_visita = valore; };
    _clientiData.forEach(upd);
    _clientiFiltrati.forEach(upd);
  } catch (err) {
    alert('Errore nel salvataggio: ' + err.message);
    // Ripristina la select al valore precedente
    const sel = document.getElementById('gsel-' + codice);
    const prev = (_clientiData.find(c => c.codice_cliente === codice) || {}).giorno_visita || '';
    if (sel) sel.value = prev;
  }
}

async function applicaGiornoMassivo() {
  const raw = document.getElementById('bulk-giorno-select')?.value;
  if (!raw) { alert('Seleziona prima un giorno dal menu "Cambia giorno…".'); return; }
  const giorno = raw === '__rimuovi__' ? null : raw;
  const n = _clientiFiltrati.length;
  if (!n) return;
  const label = giorno ? `"${giorno}"` : 'nessun giorno (rimuovi)';
  if (!confirm(`Impostare ${label} come giorno di visita per ${n} client${n === 1 ? 'e' : 'i'} visibili?`)) return;

  const codici = _clientiFiltrati.map(c => c.codice_cliente);
  try {
    await sb.from('clienti').update({ giorno_visita: giorno }).in('codice_cliente', codici);
    const upd = c => { if (codici.includes(c.codice_cliente)) c.giorno_visita = giorno; };
    _clientiData.forEach(upd);
    _clientiFiltrati.forEach(upd);
    renderClientiRows(_clientiFiltrati);
    document.getElementById('bulk-giorno-select').value = '';
  } catch (err) {
    alert('Errore: ' + err.message);
  }
}

function goToOrdineFromDDT(numeroOrdine) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('ordini').classList.add('active');
  _setNavActive('ordini');
  // Azzera i filtri data per mostrare l'ordine indipendentemente dal mese
  document.getElementById('filtro-da').value = '2020-01-01';
  document.getElementById('filtro-a').value  = '2030-12-31';
  document.getElementById('filtro-cliente').value = numeroOrdine;
  _filtroStatoOrdine = null;
  document.querySelectorAll('.ord-stato-chip').forEach(c => c.classList.toggle('on', c.dataset.stato === ''));
  loadOrdini();
}
