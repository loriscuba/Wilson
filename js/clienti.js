let _clientiData        = [];   // raw clienti records
let _rollingByCode      = {};   // codice_cliente → enriched rolling record
let _pendingOpenCodice  = null; // auto-espandi questo cliente dopo il caricamento

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

  const filtered = _clientiData.filter(c => {
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

  countEl.textContent = filtered.length;
  renderClientiRows(filtered);
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
    return `
    <tr class="cliente-row" onclick="toggleClienteDetail('${cod}', '${nome}', this)">
      <td><button class="expand-btn" id="cexp-${cod}">▶</button></td>
      <td><strong>${c.ragione_sociale || '—'}</strong></td>
      <td>${c.citta || '—'}</td>
      <td>${c.provincia || '—'}</td>
      <td>${c.settori?.nome || '—'}</td>
      <td>${c.categorie?.nome || '—'}</td>
      <td>${c.giorno_visita || '—'}</td>
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
    _rollingByCode = Object.fromEntries(rolling.map(r => [r.codice_cliente, r]));

    countEl.textContent = _clientiData.length;
    const q = document.getElementById('filtro-clienti')?.value || '';
    if (q || document.getElementById('filtro-stato')?.value) {
      filterClienti(q);
    } else {
      renderClientiRows(_clientiData);
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
    const latestDate = await getLatestRollingDate();

    const [{ data: rollingRec }, { data: ordiniAttivi }, { data: gammaData }, { data: ordiniStorico }, { data: gammaRefData }, { data: gammaCfgData }] =
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
          .order('settore'),
        sb.from('ordini')
          .select('data_ordine, totale_ordine')
          .eq('codice_cliente', codice)
          .neq('stato', 'annullato')
          .order('data_ordine', { ascending: false })
          .limit(24),
        sb.from('gamma_penetrazione')
          .select('settore, prodotti_acquistati'),
        sb.from('gamma_config')
          .select('settore, codice_articolo, nome_prodotto, tipo, immagine_url, ordine')
          .eq('attivo', true)
          .order('settore').order('ordine'),
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

    // Gamma config map: settore → array of configured products
    const gammaConfigMap = {};
    for (const row of (gammaCfgData || [])) {
      if (!gammaConfigMap[row.settore]) gammaConfigMap[row.settore] = [];
      gammaConfigMap[row.settore].push(row);
    }

    const gamma = gammaData || [];

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
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <h4 style="margin-bottom:0">Penetrazione gamma${gamma.length ? ' · agg. ' + fmtDate(gamma[0].data_aggiornamento) : ''}</h4>
          ${gamma.length ? `<button class="gamma-detail-btn" id="gamma-det-btn-${codice}" onclick="toggleGammaDettaglio('${codice}')">Dettaglio ↓</button>` : ''}
        </div>
        <div id="gamma-compact-${codice}">
          ${gamma.length ? _buildGammaCompact(gamma, gammaRef) : '<div class="cks">Nessun dato gamma per questo cliente</div>'}
        </div>
        ${gamma.length ? `<div id="gamma-det-${codice}" style="display:none;margin-top:12px;">${_buildGammaDettaglio(gamma, gammaRef, gammaConfigMap)}</div>` : ''}
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

function toggleGammaDettaglio(codice) {
  const det     = document.getElementById('gamma-det-'     + codice);
  const compact = document.getElementById('gamma-compact-' + codice);
  const btn     = document.getElementById('gamma-det-btn-' + codice);
  if (!det) return;
  const open = det.style.display !== 'none';
  det.style.display     = open ? 'none'  : 'block';
  compact.style.display = open ? 'block' : 'none';
  if (btn) btn.textContent = open ? 'Dettaglio ↓' : 'Compatto ↑';
}

function _buildGammaCompact(gamma, gammaRef) {
  return `<div class="gamma-settori">${gamma.map(g => {
    const acquistatiK = new Set(Object.keys(g.prodotti_acquistati || {}).map(p => p.toLowerCase()));
    const prods = g.prodotti_acquistati ? Object.entries(g.prodotti_acquistati) : [];
    const refMap = gammaRef[g.settore] || new Map();
    const mancanti = [...refMap.entries()].filter(([k]) => !acquistatiK.has(k)).map(([, v]) => v);
    const tot = acquistatiK.size + mancanti.length;
    const pctImm = g.pct_immancabili != null ? (g.pct_immancabili * 100).toFixed(0) : null;
    const pctStr = g.pct_strategiche  != null ? (g.pct_strategiche  * 100).toFixed(0) : null;
    return `<div class="gamma-settore-card">
      <div class="gamma-settore-header">
        <span class="gamma-settore-nome">${g.settore}</span>
        <div style="display:flex;align-items:center;gap:8px;">
          ${tot > 0 ? `<span style="font-size:12px;color:var(--text2)">${acquistatiK.size}/${tot}</span>` : ''}
          <div class="gamma-pct-badges">
            ${pctImm != null ? `<span class="gamma-pct-badge imm">Imm. ${pctImm}%</span>` : ''}
            ${pctStr != null ? `<span class="gamma-pct-badge str">Str. ${pctStr}%</span>` : ''}
          </div>
        </div>
      </div>
      ${(prods.length || mancanti.length) ? `<div class="gamma-prodotti">
        ${prods.map(([l, v]) => `<span class="gamma-prod-tag" title="€${fmt(v)}">✓ ${l}</span>`).join('')}
        ${mancanti.map(l => `<span class="gamma-prod-tag gamma-prod-missing">✗ ${l}</span>`).join('')}
      </div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

function _buildGammaDettaglio(gamma, gammaRef, gammaConfigMap) {
  return `<div class="gamma-det-root">${gamma.map(g => {
    const acquistatiV = {};
    for (const [k, v] of Object.entries(g.prodotti_acquistati || {})) acquistatiV[k.toLowerCase()] = v;
    const acquistatiK = new Set(Object.keys(acquistatiV));
    const pctImm = g.pct_immancabili != null ? (g.pct_immancabili * 100).toFixed(0) : null;
    const pctStr = g.pct_strategiche  != null ? (g.pct_strategiche  * 100).toFixed(0) : null;
    let products = [];
    const cfgRows = gammaConfigMap[g.settore];
    if (cfgRows && cfgRows.length) {
      products = cfgRows.map(row => {
        const key = (row.nome_prodotto || '').toLowerCase();
        const acq = acquistatiK.has(key);
        return { nome: row.nome_prodotto, codice: row.codice_articolo || '', tipo: row.tipo || '',
          img: row.immagine_url || '', acquistato: acq, valore: acq ? acquistatiV[key] : null };
      });
    } else {
      const refMap = gammaRef[g.settore] || new Map();
      const allKeys = new Set([...acquistatiK, ...[...refMap.keys()]]);
      allKeys.forEach(k => {
        const nome = refMap.get(k) || k;
        products.push({ nome, codice: '', tipo: '', img: '', acquistato: acquistatiK.has(k), valore: acquistatiV[k] || null });
      });
    }
    const tot = products.length;
    const acq = products.filter(p => p.acquistato).length;
    const pct = tot > 0 ? Math.round((acq / tot) * 100) : 0;
    return `<div class="gamma-det-settore">
      <div class="gamma-det-settore-header">
        <span class="gamma-settore-nome">${g.settore}</span>
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="gamma-pct-badges">
            ${pctImm != null ? `<span class="gamma-pct-badge imm">Imm. ${pctImm}%</span>` : ''}
            ${pctStr != null ? `<span class="gamma-pct-badge str">Str. ${pctStr}%</span>` : ''}
          </div>
          <span style="font-size:12px;color:var(--text2)">${acq}/${tot}</span>
        </div>
      </div>
      ${tot > 0 ? `<div class="gamma-det-progress"><div class="gamma-det-progress-bar" style="width:${pct}%"></div></div>` : ''}
      <div class="gamma-det-cards">
        ${products.map(p => `<div class="gamma-det-card ${p.acquistato ? 'gamma-det-acquired' : 'gamma-det-missing'}">
          <div class="gamma-det-img-wrap">
            ${p.img ? `<img class="gamma-det-img" src="${p.img}" alt="${p.nome}" loading="lazy">` : `<div class="gamma-det-img-placeholder">${p.nome.charAt(0).toUpperCase()}</div>`}
          </div>
          <div class="gamma-det-info">
            <div class="gamma-det-nome">${p.nome}</div>
            ${p.codice ? `<div class="gamma-det-cod">${p.codice}</div>` : ''}
            ${p.tipo   ? `<div class="gamma-det-tipo">${p.tipo}</div>`   : ''}
            <div class="gamma-det-stato ${p.acquistato ? 'gamma-det-ok' : 'gamma-det-no'}">
              ${p.acquistato ? `✓ Acquistato${p.valore ? ' · €' + fmt(p.valore) : ''}` : '✗ Non acquistato'}
            </div>
          </div>
        </div>`).join('')}
      </div>
    </div>`;
  }).join('')}</div>`;
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
