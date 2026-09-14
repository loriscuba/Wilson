// ── Promozioni ────────────────────────────────────────────────────────────────

let _promoList      = [];   // promozioni caricate
let _promoAperta    = null; // id promo espansa
let _promoFiltro    = '';   // filtro stato clienti
let _promoQuery     = '';   // ricerca clienti
let _promoClienti   = {};   // { promoId: [rows dal DB] }
let _promoIdonei    = {};   // { promoId: [clienti idonei dallo storico ordini] }
let _promoSetup     = null; // id promo in setup famiglie
let _famiglieLiv2   = [];   // [{nome, sottofamiglie:[{nome,count}]}]

const PROMO_STATI = [
  { id: 'da_contattare',  label: 'Da contattare', color: '#9B9B97' },
  { id: 'proposta',       label: 'Proposta',       color: '#D97706' },
  { id: 'in_attesa',      label: 'In attesa',      color: '#378ADD' },
  { id: 'ordinato',       label: 'Ordinato ✓',     color: '#2D7D4F' },
  { id: 'non_interessato',label: 'Non interess.',  color: '#C84B2F' },
];

async function loadPromozioni() {
  const root = document.getElementById('promo-root');
  if (!root) return;
  root.innerHTML = '<div class="loading">Caricamento promozioni…</div>';

  try {
    const { data: promos, error } = await sb.from('promozioni')
      .select('*')
      .eq('attiva', true)
      .order('data_inizio', { ascending: false });
    if (error) throw error;
    _promoList = promos || [];
    await _loadFamiglieLiv2();
    _renderPromoRoot(root);
  } catch (err) {
    root.innerHTML = `<p style="color:var(--red);padding:1rem">Errore: ${err.message}</p>`;
  }
}

async function _loadFamiglieLiv2() {
  if (_famiglieLiv2.length) return;
  try {
    const { data } = await sb.from('sottofamiglie_prodotto')
      .select('id, nome, famiglie_prodotto(nome)')
      .order('nome');
    if (!data) return;
    const map = {};
    for (const r of data) {
      const fam = r.famiglie_prodotto?.nome || 'Altro';
      if (!map[fam]) map[fam] = [];
      map[fam].push(r.nome);
    }
    _famiglieLiv2 = Object.entries(map).sort((a, b) => a[0].localeCompare(b[0])).map(([nome, subs]) => ({ nome, subs }));
  } catch { /* non bloccante */ }
}

function _renderPromoRoot(root) {
  const toolbar = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:1rem">
      <button class="bc-btn-primary" onclick="apriFondoPdf()">📄 Carica PDF promo</button>
    </div>`;

  if (!_promoList.length) {
    root.innerHTML = toolbar + `
      <div style="text-align:center;padding:3rem;color:var(--text2)">
        <div style="font-size:36px;margin-bottom:1rem">🏷️</div>
        <div style="font-size:15px;font-weight:600;margin-bottom:.5rem">Nessuna promozione attiva</div>
        <div style="font-size:12px">Carica il PDF di una promo con il pulsante qui sopra.</div>
      </div>`;
    return;
  }
  root.innerHTML = toolbar + _promoList.map(p => _promoCardHtml(p)).join('');
}

function _promoCardHtml(p) {
  const needsSetup = !p.famiglie?.length && !p.codici_extra?.length;
  const di = p.data_inizio ? new Date(p.data_inizio + 'T00:00:00').toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' }) : '';
  const df = p.data_fine   ? new Date(p.data_fine   + 'T00:00:00').toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '';

  const famChips = (p.famiglie || []).map(f =>
    `<span class="promo-fam-chip">${f}</span>`).join('');
  const extraChips = (p.codici_extra || []).filter(Boolean).map(c =>
    `<span class="promo-cod-chip">art. ${c}</span>`).join('');

  const isOpen   = _promoAperta === p.id;
  const inSetup  = _promoSetup  === p.id;

  let bodyHtml = '';
  if (inSetup) {
    bodyHtml = _setupFamiglieHtml(p);
  } else if (isOpen) {
    bodyHtml = _promoDettaglioHtml(p);
  }

  return `
    <div class="promo-card" id="promo-card-${p.id}">
      <div class="promo-card-hdr" onclick="togglePromoCard(${p.id})">
        <div style="flex:1;min-width:0">
          <div class="promo-card-nome">${p.nome}</div>
          <div class="promo-card-meta">
            ${di}–${df}
            ${p.settore  ? ` · ${p.settore}`         : ''}
            ${p.divisione ? ` · Div. ${p.divisione}` : ''}
            ${p.non_cumulabile ? ' · <span class="promo-nc">NON CUM.</span>' : ''}
          </div>
          ${famChips || extraChips ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">${famChips}${extraChips}</div>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
          ${needsSetup ? '<span class="promo-setup-badge">⚙ Setup</span>' : ''}
          <span class="promo-chev ${isOpen || inSetup ? 'open' : ''}">▾</span>
        </div>
      </div>
      ${isOpen || inSetup ? `<div class="promo-card-body">${bodyHtml}</div>` : ''}
    </div>`;
}

async function togglePromoCard(id) {
  if (_promoAperta === id || _promoSetup === id) {
    _promoAperta = null;
    _promoSetup  = null;
  } else {
    const promo = _promoList.find(p => p.id === id);
    if (!promo) return;
    const needsSetup = !promo.famiglie?.length && !promo.codici_extra?.length;
    _promoAperta = needsSetup ? null : id;
    _promoSetup  = needsSetup ? id   : null;
    _promoFiltro = '';
    _promoQuery  = '';
    if (!needsSetup && !_promoClienti[id]) {
      await _loadPromoClienti(id);
      await _loadPromoIdonei(promo);
    }
  }
  _rerenderRoot();
}

function _rerenderRoot() {
  const root = document.getElementById('promo-root');
  if (root) _renderPromoRoot(root);
}

// ── Setup famiglie ─────────────────────────────────────────────────────────────

function _setupFamiglieHtml(p) {
  const famOptions = _famiglieLiv2.map(f =>
    `<option value="${_esc(f.nome)}">${f.nome}</option>`
  ).join('');

  const selFam = document.getElementById(`psetup-fam-${p.id}`)?.value || '';
  const subs = selFam
    ? (_famiglieLiv2.find(f => f.nome === selFam)?.subs || [])
    : _famiglieLiv2.flatMap(f => f.subs);

  const subChecks = subs.sort((a, b) => a.localeCompare(b)).map(s =>
    `<label class="promo-check-lbl">
      <input type="checkbox" name="psetup-sub-${p.id}" value="${_esc(s)}"> ${s}
     </label>`
  ).join('');

  const curExtra = (p.codici_extra || []).filter(Boolean).join(', ');

  return `
    <div class="promo-setup" id="psetup-${p.id}">
      <p class="promo-setup-title">⚙ Setup famiglie prodotto — <em>${_esc(p.nome)}</em></p>
      <p style="font-size:12px;color:var(--text2);margin-bottom:1rem">
        Seleziona le famiglie / sottofamiglie associate a questa promo (una sola volta).<br>
        Verranno usate per trovare i clienti idonei in base allo storico ordini.
      </p>

      <div style="margin-bottom:1rem">
        <label class="promo-label">Filtra per famiglia (liv. 2)</label>
        <select id="psetup-fam-${p.id}" onchange="_onSetupFamChange(${p.id})"
                style="display:block;margin-top:4px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);color:var(--text);font-size:13px;width:100%;max-width:300px">
          <option value="">— tutte le famiglie —</option>
          ${famOptions}
        </select>
      </div>

      <div style="margin-bottom:1rem">
        <label class="promo-label">Sottofamiglie associate (desc. liv. 3)</label>
        <div id="psetup-subs-${p.id}" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;max-height:200px;overflow-y:auto;padding:8px;border:1px solid var(--border);border-radius:var(--r);background:var(--bg)">
          ${subChecks || '<span style="color:var(--text2);font-size:12px">Seleziona una famiglia per filtrare</span>'}
        </div>
      </div>

      <div style="margin-bottom:1.5rem">
        <label class="promo-label">Codici articolo aggiuntivi (opzionale, separati da virgola)</label>
        <input type="text" id="psetup-extra-${p.id}" value="${_esc(curExtra)}"
               placeholder="es. 5044590, 5044591"
               style="display:block;margin-top:4px;width:100%;max-width:350px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box">
      </div>

      <button class="bc-btn-primary" onclick="_saveSetupFamiglie(${p.id})">Salva e mostra clienti idonei</button>
      <button class="bc-btn-secondary" style="margin-left:8px" onclick="_cancelSetup()">Annulla</button>
    </div>`;
}

function _onSetupFamChange(promoId) {
  const promo = _promoList.find(p => p.id === promoId);
  if (!promo) return;
  const selFam = document.getElementById(`psetup-fam-${promoId}`)?.value || '';
  const subs = selFam
    ? (_famiglieLiv2.find(f => f.nome === selFam)?.subs || [])
    : _famiglieLiv2.flatMap(f => f.subs);

  const container = document.getElementById(`psetup-subs-${promoId}`);
  if (!container) return;
  container.innerHTML = subs.sort((a, b) => a.localeCompare(b)).map(s =>
    `<label class="promo-check-lbl">
      <input type="checkbox" name="psetup-sub-${promoId}" value="${_esc(s)}"> ${s}
     </label>`
  ).join('');
}

async function _saveSetupFamiglie(promoId) {
  const checked = [...document.querySelectorAll(`input[name="psetup-sub-${promoId}"]:checked`)].map(c => c.value);
  const extraRaw = document.getElementById(`psetup-extra-${promoId}`)?.value || '';
  const extra    = extraRaw.split(',').map(s => s.trim()).filter(Boolean);

  if (!checked.length && !extra.length) {
    alert('Seleziona almeno una sottofamiglia o inserisci dei codici articolo.');
    return;
  }

  try {
    const { error } = await sb.from('promozioni')
      .update({ famiglie: checked, codici_extra: extra })
      .eq('id', promoId);
    if (error) throw error;

    const promo = _promoList.find(p => p.id === promoId);
    if (promo) { promo.famiglie = checked; promo.codici_extra = extra; }

    _promoSetup  = null;
    _promoAperta = promoId;
    await _loadPromoClienti(promoId);
    await _loadPromoIdonei(_promoList.find(p => p.id === promoId));
    _rerenderRoot();
  } catch (e) {
    alert('Errore salvataggio: ' + e.message);
  }
}

function _cancelSetup() {
  _promoSetup = null;
  _rerenderRoot();
}

// ── Caricamento dati ──────────────────────────────────────────────────────────

async function _loadPromoClienti(promoId) {
  const { data } = await sb.from('promo_clienti')
    .select('*').eq('promo_id', promoId);
  _promoClienti[promoId] = data || [];
}

async function _loadPromoIdonei(promo) {
  if (!promo) return;
  if (_promoIdonei[promo.id]) return;  // già caricati

  try {
    const famiglie    = promo.famiglie    || [];
    const codiciExtra = (promo.codici_extra || []).filter(Boolean);

    // Codici articolo dalle famiglie selezionate
    let codiciPromo = [...codiciExtra];
    if (famiglie.length) {
      const { data: sfData } = await sb.from('sottofamiglie_prodotto')
        .select('id').in('nome', famiglie);
      const sfIds = (sfData || []).map(s => s.id);
      if (sfIds.length) {
        const { data: prodData } = await sb.from('prodotti')
          .select('codice_articolo').in('sottofamiglia_id', sfIds);
        codiciPromo = [...new Set([...codiciPromo, ...(prodData || []).map(p => String(p.codice_articolo))])];
      }
    }

    if (!codiciPromo.length) { _promoIdonei[promo.id] = []; return; }

    // Ordini che includono quei codici negli ultimi 24 mesi
    const since = new Date();
    since.setFullYear(since.getFullYear() - 2);
    const sinceStr = since.toISOString().split('T')[0];

    const { data: righe } = await sb.from('righe_ordine')
      .select('ordine_id, codice_articolo, importo_eur, ordini!inner(codice_cliente, destinazione_ragione_sociale, data_ordine)')
      .in('codice_articolo', codiciPromo)
      .gte('ordini.data_ordine', sinceStr);

    // Aggrega per cliente
    const map = {};
    for (const r of (righe || [])) {
      const ord = r.ordini;
      if (!ord) continue;
      const cod = ord.codice_cliente;
      if (!cod) continue;
      if (!map[cod]) {
        map[cod] = {
          codice_cliente:  cod,
          ragione_sociale: ord.destinazione_ragione_sociale || '',
          ultimo_acquisto: ord.data_ordine,
          n_ordini:        0,
          tot_importo:     0,
        };
      }
      if (ord.data_ordine > map[cod].ultimo_acquisto) map[cod].ultimo_acquisto = ord.data_ordine;
      map[cod].n_ordini++;
      map[cod].tot_importo += r.importo_eur || 0;
    }

    _promoIdonei[promo.id] = Object.values(map).sort((a, b) =>
      (b.ultimo_acquisto || '').localeCompare(a.ultimo_acquisto || '')
    );
  } catch (e) {
    console.warn('loadPromoIdonei error:', e);
    _promoIdonei[promo.id] = [];
  }
}

// ── Dettaglio promo ────────────────────────────────────────────────────────────

function _promoDettaglioHtml(promo) {
  const id       = promo.id;
  const tracking = _promoClienti[id]  || [];
  const idonei   = _promoIdonei[id]   || null;  // null = ancora in caricamento

  // Mappa stato per codice_cliente
  const statoMap = Object.fromEntries(tracking.map(r => [r.codice_cliente, r]));

  // Stats
  const byCounts = {};
  for (const s of PROMO_STATI) byCounts[s.id] = 0;
  for (const r of tracking) byCounts[r.stato] = (byCounts[r.stato] || 0) + 1;

  const chipHtml = PROMO_STATI.map(s => {
    const cnt = byCounts[s.id] || 0;
    const on  = _promoFiltro === s.id ? 'on' : '';
    return `<button class="bc-chip ${on}" style="--chip-c:${s.color}" onclick="setPromoFiltro('${s.id}',${id})">${s.label} <span class="bc-chip-cnt">${cnt}</span></button>`;
  });
  chipHtml.unshift(`<button class="bc-chip ${_promoFiltro === '' ? 'on' : ''}" style="--chip-c:#6B6860" onclick="setPromoFiltro('',${id})">Tutti <span class="bc-chip-cnt">${tracking.length}</span></button>`);

  // Clienti da mostrare: idonei (con storico) + quelli già in tracking non in lista
  let rows = [];
  if (idonei === null) {
    rows = tracking;
  } else {
    const idoneiCodici = new Set(idonei.map(c => c.codice_cliente));
    const trackedSet   = new Set(tracking.map(r => r.codice_cliente));
    // Idonei con eventuale tracking sovrapposto
    rows = idonei.map(c => ({
      ...c,
      _tracking: statoMap[c.codice_cliente] || null,
    }));
    // Aggiungi quelli già in tracking ma non in lista idonei
    for (const t of tracking) {
      if (!idoneiCodici.has(t.codice_cliente)) {
        rows.push({ codice_cliente: t.codice_cliente, ragione_sociale: t.ragione_sociale || '', _tracking: t, _manuale: true });
      }
    }
  }

  // Filtro stato
  if (_promoFiltro) {
    rows = rows.filter(r => {
      const stato = r._tracking?.stato || 'da_contattare';
      return stato === _promoFiltro;
    });
  }

  // Ricerca
  if (_promoQuery) {
    const q = _promoQuery.toLowerCase();
    rows = rows.filter(r => (r.ragione_sociale || r._tracking?.ragione_sociale || '').toLowerCase().includes(q) || r.codice_cliente.includes(q));
  }

  const condHtml = (promo.condizioni || '').split('\n').filter(Boolean).map(l =>
    `<div style="margin-bottom:4px">${_esc(l)}</div>`
  ).join('');

  const tbodyHtml = rows.length
    ? rows.map(r => _promoRigaHtml(r, promo)).join('')
    : `<tr><td colspan="7" style="padding:1.5rem;text-align:center;color:var(--text2)">Nessun cliente trovato</td></tr>`;

  return `
    <div style="padding:1rem 0">
      <div class="promo-condizioni">${condHtml}
        ${promo.note_ordine ? `<div style="margin-top:8px;font-weight:600;color:#D97706">Nota ordine: "${_esc(promo.note_ordine)}"</div>` : ''}
      </div>

      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <span style="font-size:12px;color:var(--text2)">Famiglie:</span>
        ${(promo.famiglie || []).map(f => `<span class="promo-fam-chip">${_esc(f)}</span>`).join('')}
        ${(promo.codici_extra || []).filter(Boolean).map(c => `<span class="promo-cod-chip">art. ${_esc(c)}</span>`).join('')}
        <button class="bc-btn-secondary" style="padding:2px 8px;font-size:11px" onclick="_riapriSetup(${id})">✏ Modifica famiglie</button>
      </div>

      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px" id="promo-chips-${id}">
        ${chipHtml.join('')}
      </div>

      <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center">
        <input type="text" placeholder="cerca cliente…" value="${_esc(_promoQuery)}"
               oninput="setPromoQuery(this.value,${id})"
               style="flex:1;max-width:280px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r);font-size:13px;background:var(--surface);color:var(--text)">
        <button class="bc-btn-secondary" onclick="apriAggiungiClientePromo(${id})">+ Aggiungi cliente</button>
      </div>

      ${idonei === null ? '<div class="loading" style="padding:.5rem">Analisi storico ordini…</div>' : ''}

      <div style="overflow-x:auto">
        <table class="b-tbl" style="min-width:700px">
          <thead><tr>
            <th>Cliente</th>
            <th style="text-align:center">Ultimo acq.</th>
            <th style="text-align:right">N° ordini</th>
            <th style="text-align:right">Importo medio</th>
            <th style="text-align:center">Stato</th>
            <th style="text-align:center">Data proposta</th>
            <th style="width:32px"></th>
          </tr></thead>
          <tbody id="promo-tbody-${id}">${tbodyHtml}</tbody>
        </table>
      </div>
    </div>`;
}

function _promoRigaHtml(r, promo) {
  const t          = r._tracking;
  const stato      = t?.stato || 'da_contattare';
  const statoInfo  = PROMO_STATI.find(s => s.id === stato) || PROMO_STATI[0];
  const statoBadge = `<span class="bc-stato" style="background:${statoInfo.color}20;color:${statoInfo.color};border-color:${statoInfo.color}40;white-space:nowrap">${statoInfo.label}</span>`;
  const nome       = _esc(r.ragione_sociale || t?.ragione_sociale || r.codice_cliente);
  const dtUlt      = r.ultimo_acquisto ? new Date(r.ultimo_acquisto).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' }) : (r._manuale ? '—' : '—');
  const dtProp     = t?.data_proposta   ? new Date(t.data_proposta  + 'T00:00:00').toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—';
  const media      = r.n_ordini > 0 && r.tot_importo > 0 ? '€ ' + Math.round(r.tot_importo / r.n_ordini).toLocaleString('it-IT') : '—';
  const cod        = r.codice_cliente.replace(/'/g, "\\'");
  const nomeEsc    = nome.replace(/'/g, "\\'");

  return `<tr class="bc-row">
    <td>
      <div class="bc-cliente-nome">${nome}</div>
      <div class="bc-cliente-div">${r.codice_cliente}</div>
    </td>
    <td style="text-align:center;font-size:12px;color:var(--text2)">${dtUlt}</td>
    <td style="text-align:right;font-size:12px;color:var(--text2)">${r.n_ordini || (r._manuale ? '—' : '—')}</td>
    <td style="text-align:right;font-size:12px">${media}</td>
    <td style="text-align:center">${statoBadge}</td>
    <td style="text-align:center;font-size:12px;color:var(--text2)">${dtProp}</td>
    <td style="text-align:center">
      <button class="pl-art-btn" title="Modifica stato" onclick="apriEditPromoCliente(${promo.id},'${cod}','${nomeEsc}')">✏</button>
    </td>
  </tr>`;
}

// ── Event handlers ─────────────────────────────────────────────────────────────

function setPromoFiltro(stato, promoId) {
  _promoFiltro = stato;
  const promo = _promoList.find(p => p.id === promoId);
  if (!promo) return;
  const bodyEl = document.querySelector(`#promo-card-${promoId} .promo-card-body`);
  if (bodyEl) bodyEl.innerHTML = _promoDettaglioHtml(promo);
}

function setPromoQuery(q, promoId) {
  _promoQuery = q;
  const promo = _promoList.find(p => p.id === promoId);
  if (!promo) return;
  const bodyEl = document.querySelector(`#promo-card-${promoId} .promo-card-body`);
  if (bodyEl) bodyEl.innerHTML = _promoDettaglioHtml(promo);
}

function _riapriSetup(promoId) {
  _promoAperta = null;
  _promoSetup  = promoId;
  _rerenderRoot();
}

// ── Modal edit cliente promo ───────────────────────────────────────────────────

function apriEditPromoCliente(promoId, codice, nome) {
  const tracking = (_promoClienti[promoId] || []).find(r => r.codice_cliente === codice) || {};

  const opzioni = PROMO_STATI.map(s =>
    `<option value="${s.id}" ${tracking.stato === s.id || (!tracking.stato && s.id === 'da_contattare') ? 'selected' : ''}>${s.label}</option>`
  ).join('');

  const html = `
    <div class="pl-modal-overlay" id="promo-edit-modal" onclick="if(event.target===this)chiudiEditPromoCliente()">
      <div class="pl-modal-content" style="max-width:420px">
        <div class="pl-modal-hdr">
          <span style="font-weight:600">${nome}</span>
          <button class="pl-modal-close" onclick="chiudiEditPromoCliente()">×</button>
        </div>
        <div style="padding:1.25rem;display:flex;flex-direction:column;gap:14px">
          <div>
            <label class="promo-label">Stato</label>
            <select id="pedit-stato" style="display:block;margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);color:var(--text);font-size:13px">
              ${opzioni}
            </select>
          </div>
          <div>
            <label class="promo-label">Data proposta</label>
            <input type="date" id="pedit-data" value="${tracking.data_proposta || ''}"
                   style="display:block;margin-top:4px;padding:7px 10px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);color:var(--text);font-size:13px">
          </div>
          <div>
            <label class="promo-label">Nota</label>
            <textarea id="pedit-nota" rows="3"
              style="display:block;margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);color:var(--text);font-size:13px;resize:vertical;box-sizing:border-box">${tracking.nota || ''}</textarea>
          </div>
          <div style="display:flex;gap:8px">
            <button class="bc-btn-primary" style="flex:1" onclick="salvaEditPromoCliente(${promoId},'${codice.replace(/'/g,"\\'")}','${nome.replace(/'/g,"\\'")}')">Salva</button>
            <button class="bc-btn-secondary" onclick="chiudiEditPromoCliente()">Annulla</button>
          </div>
        </div>
      </div>
    </div>`;

  document.body.insertAdjacentHTML('beforeend', html);
}

function chiudiEditPromoCliente() {
  document.getElementById('promo-edit-modal')?.remove();
}

async function salvaEditPromoCliente(promoId, codice, nome) {
  const stato     = document.getElementById('pedit-stato')?.value;
  const data_prop = document.getElementById('pedit-data')?.value  || null;
  const nota      = document.getElementById('pedit-nota')?.value  || null;

  try {
    const record = {
      promo_id:        promoId,
      codice_cliente:  codice,
      ragione_sociale: nome,
      stato,
      data_proposta:   data_prop,
      nota,
    };
    const { error } = await sb.from('promo_clienti')
      .upsert(record, { onConflict: 'promo_id,codice_cliente' });
    if (error) throw error;

    // Aggiorna cache locale
    const list = _promoClienti[promoId] || [];
    const idx  = list.findIndex(r => r.codice_cliente === codice);
    if (idx >= 0) list[idx] = { ...list[idx], ...record };
    else          list.push(record);
    _promoClienti[promoId] = list;

    chiudiEditPromoCliente();
    const promo  = _promoList.find(p => p.id === promoId);
    const bodyEl = document.querySelector(`#promo-card-${promoId} .promo-card-body`);
    if (bodyEl && promo) bodyEl.innerHTML = _promoDettaglioHtml(promo);
  } catch (e) {
    alert('Errore salvataggio: ' + e.message);
  }
}

// ── Aggiungi cliente manuale ──────────────────────────────────────────────────

function apriAggiungiClientePromo(promoId) {
  const html = `
    <div class="pl-modal-overlay" id="promo-add-modal" onclick="if(event.target===this)chiudiAggiungiClientePromo()">
      <div class="pl-modal-content" style="max-width:420px">
        <div class="pl-modal-hdr">
          <span style="font-weight:600">Aggiungi cliente</span>
          <button class="pl-modal-close" onclick="chiudiAggiungiClientePromo()">×</button>
        </div>
        <div style="padding:1.25rem;display:flex;flex-direction:column;gap:12px">
          <div>
            <label class="promo-label">Codice cliente</label>
            <input type="text" id="padd-cod" placeholder="es. 570123"
                   style="display:block;margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box">
          </div>
          <div>
            <label class="promo-label">Ragione sociale</label>
            <input type="text" id="padd-nome" placeholder="es. EDILCO SRL"
                   style="display:block;margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box">
          </div>
          <div style="display:flex;gap:8px">
            <button class="bc-btn-primary" style="flex:1" onclick="salvaAggiungiClientePromo(${promoId})">Aggiungi</button>
            <button class="bc-btn-secondary" onclick="chiudiAggiungiClientePromo()">Annulla</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

function chiudiAggiungiClientePromo() {
  document.getElementById('promo-add-modal')?.remove();
}

async function salvaAggiungiClientePromo(promoId) {
  const cod  = document.getElementById('padd-cod')?.value.trim();
  const nome = document.getElementById('padd-nome')?.value.trim();
  if (!cod) { alert('Inserisci il codice cliente.'); return; }

  await salvaEditPromoCliente(promoId, cod, nome || cod);
  chiudiAggiungiClientePromo();
  if (!_promoIdonei[promoId]) _promoIdonei[promoId] = [];
  if (!_promoIdonei[promoId].find(r => r.codice_cliente === cod)) {
    _promoIdonei[promoId].push({ codice_cliente: cod, ragione_sociale: nome || '', n_ordini: 0, tot_importo: 0, _manuale: true });
  }
}

// ── PDF Upload ────────────────────────────────────────────────────────────────

const MESI_IT = {
  gennaio:1, febbraio:2, marzo:3, aprile:4, maggio:5, giugno:6,
  luglio:7, agosto:8, settembre:9, ottobre:10, novembre:11, dicembre:12,
};

function apriFondoPdf() {
  let inp = document.getElementById('promo-pdf-input');
  if (!inp) {
    inp = document.createElement('input');
    inp.type    = 'file';
    inp.id      = 'promo-pdf-input';
    inp.accept  = '.pdf';
    inp.style.display = 'none';
    inp.addEventListener('change', () => { if (inp.files[0]) _caricaPdfFile(inp.files[0]); inp.value = ''; });
    document.body.appendChild(inp);
  }
  inp.click();
}

async function _caricaPdfFile(file) {
  const root   = document.getElementById('promo-root');
  const banner = document.createElement('div');
  banner.id = 'pdf-loading-banner';
  banner.style.cssText = 'padding:.75rem 1rem;background:var(--surface);border-bottom:1px solid var(--border);font-size:13px;color:var(--text2);border-radius:var(--r);margin-bottom:.75rem';
  banner.textContent = '📄 Lettura PDF in corso…';
  root.prepend(banner);

  try {
    if (!window.pdfjsLib) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src     = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        s.onload  = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    const arrayBuffer = await file.arrayBuffer();
    const pdf         = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(it => it.str).join(' ') + '\n';
    }

    banner.remove();
    const parsed = _parsePdfPromo(text, file.name);
    _mostraReviewModal(parsed, text);
  } catch (e) {
    banner.remove();
    alert('Errore lettura PDF: ' + e.message);
  }
}

function _parsePdfPromo(text, fileName) {
  const tl = text.toLowerCase();

  // Month/year
  let mese = null, anno = null;
  for (const [nome, num] of Object.entries(MESI_IT)) {
    const m = tl.match(new RegExp(nome + '\\s+(\\d{4})'));
    if (m) { mese = num; anno = parseInt(m[1]); break; }
  }
  if (!anno) { const m = text.match(/\b(20\d\d)\b/); if (m) anno = parseInt(m[1]); }

  // Date range dd/mm/yyyy
  let data_inizio = null, data_fine = null;
  const dates = [...text.matchAll(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/g)]
    .map(m => `${m[3]}-${m[2]}-${m[1]}`);
  if (dates.length >= 2) {
    data_inizio = dates[0];
    data_fine   = dates[1];
  } else if (mese && anno) {
    data_inizio = `${anno}-${String(mese).padStart(2,'0')}-01`;
    const last  = new Date(anno, mese, 0).getDate();
    data_fine   = `${anno}-${String(mese).padStart(2,'0')}-${last}`;
  }

  // Settore / divisione
  let settore   = /edilizia/i.test(text) ? 'Edilizia' : /industria/i.test(text) ? 'Industria' : '';
  let divisione = '';
  const divM    = text.match(/div(?:isione)?\.?\s*(\d+)/i);
  if (divM) divisione = divM[1];

  const non_cumulabile = /non\s+cumulabile/i.test(text);
  const pdf_nome       = fileName;

  // Heuristic: all-caps short lines as promo titles
  const lines  = text.split(/\n/).map(l => l.trim()).filter(Boolean);
  const titleRe = /^[A-ZÀÈÉÌÒÙA-Z0-9 \-\/—–&.,:;()'°]{5,70}$/;
  const skipRe  = /^(PROMO|PROMOZIONI?|CONDIZIONI|OFFERTA|FISCHER|EDILIZIA|INDUSTRIA|PAGINA|PAGE|\d+)$/i;

  const entries = [];
  let i = 0;
  while (i < lines.length) {
    if (titleRe.test(lines[i]) && !skipRe.test(lines[i].trim())) {
      const nome    = lines[i].trim();
      const cLines  = [];
      i++;
      while (i < lines.length && !titleRe.test(lines[i])) {
        cLines.push(lines[i]);
        i++;
      }
      const condizioni  = cLines.join('\n').trim();
      const noteM       = condizioni.match(/ORDINE\s+[A-Z ]+/);
      entries.push({ nome, condizioni, note_ordine: noteM ? noteM[0].trim() : '' });
    } else {
      i++;
    }
  }

  if (!entries.length) entries.push({ nome: '', condizioni: '', note_ordine: '' });

  return { mese, anno, data_inizio, data_fine, settore, divisione, non_cumulabile, pdf_nome, entries };
}

let _promoEntryCount = 0;

function _mostraReviewModal(parsed, rawText) {
  document.getElementById('promo-review-modal')?.remove();
  _promoEntryCount = parsed.entries.length - 1;

  const entriesHtml = parsed.entries.map((e, idx) => _entryFormHtml(idx, e)).join('');

  const html = `
    <div class="pl-modal-overlay" id="promo-review-modal" onclick="if(event.target===this)chiudiReviewModal()">
      <div class="pl-modal-content" style="max-width:620px;max-height:90vh;overflow-y:auto">
        <div class="pl-modal-hdr">
          <span style="font-weight:600">📄 Nuova promozione da PDF</span>
          <button class="pl-modal-close" onclick="chiudiReviewModal()">×</button>
        </div>
        <div style="padding:1.25rem;display:flex;flex-direction:column;gap:14px">

          <fieldset style="border:1px solid var(--border);border-radius:var(--r);padding:.75rem;margin:0">
            <legend style="font-size:12px;font-weight:600;color:var(--text2);padding:0 4px">Dati comuni</legend>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <label class="promo-label">Settore</label>
                <input type="text" id="prev-settore" value="${_esc(parsed.settore)}"
                       style="display:block;margin-top:3px;width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box">
              </div>
              <div>
                <label class="promo-label">Divisione</label>
                <input type="text" id="prev-divisione" value="${_esc(parsed.divisione)}" placeholder="es. 11"
                       style="display:block;margin-top:3px;width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box">
              </div>
              <div>
                <label class="promo-label">Data inizio</label>
                <input type="date" id="prev-dinizio" value="${parsed.data_inizio || ''}"
                       style="display:block;margin-top:3px;width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box">
              </div>
              <div>
                <label class="promo-label">Data fine</label>
                <input type="date" id="prev-dfine" value="${parsed.data_fine || ''}"
                       style="display:block;margin-top:3px;width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box">
              </div>
            </div>
            <div style="margin-top:10px">
              <label class="promo-check-lbl" style="display:flex;align-items:center;gap:6px;cursor:pointer">
                <input type="checkbox" id="prev-noncum" ${parsed.non_cumulabile ? 'checked' : ''}> Non cumulabile
              </label>
            </div>
          </fieldset>

          <div id="prev-entries">${entriesHtml}</div>

          <button class="bc-btn-secondary" style="align-self:flex-start" onclick="_aggiungiEntryPromo()">+ Aggiungi voce promo</button>

          <details style="font-size:11px;color:var(--text2)">
            <summary style="cursor:pointer;font-size:12px;font-weight:600;color:var(--text2);user-select:none">Testo estratto dal PDF ▸</summary>
            <pre style="margin-top:8px;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--r);white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto;font-size:11px">${_esc(rawText.slice(0, 8000))}</pre>
          </details>

          <div style="display:flex;gap:8px">
            <button class="bc-btn-primary" style="flex:1" onclick="_salvaTutti()">Salva promozione</button>
            <button class="bc-btn-secondary" onclick="chiudiReviewModal()">Annulla</button>
          </div>
        </div>
      </div>
    </div>`;

  document.body.insertAdjacentHTML('beforeend', html);
  window._promoPdfParsed = parsed;
}

function _entryFormHtml(idx, e) {
  return `
    <div class="promo-entry-box" id="prev-entry-${idx}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:12px;font-weight:600;color:var(--text2)">Voce promo ${idx + 1}</span>
        ${idx > 0 ? `<button class="bc-btn-secondary" style="padding:2px 8px;font-size:11px" onclick="this.closest('.promo-entry-box').remove()">Rimuovi</button>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;gap:10px">
        <div>
          <label class="promo-label">Nome promo *</label>
          <input type="text" class="prev-nome" value="${_esc(e.nome || '')}" placeholder="es. DISCHI DA TAGLIO"
                 style="display:block;margin-top:3px;width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box">
        </div>
        <div>
          <label class="promo-label">Condizioni</label>
          <textarea class="prev-cond" rows="4"
            style="display:block;margin-top:3px;width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);color:var(--text);font-size:13px;resize:vertical;box-sizing:border-box">${_esc(e.condizioni || '')}</textarea>
        </div>
        <div>
          <label class="promo-label">Nota ordine</label>
          <input type="text" class="prev-nota" value="${_esc(e.note_ordine || '')}" placeholder="es. ORDINE PROMO DISCHI"
                 style="display:block;margin-top:3px;width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box">
        </div>
      </div>
    </div>`;
}

function _aggiungiEntryPromo() {
  _promoEntryCount++;
  const container = document.getElementById('prev-entries');
  if (!container) return;
  container.insertAdjacentHTML('beforeend', _entryFormHtml(_promoEntryCount, { nome: '', condizioni: '', note_ordine: '' }));
}

function chiudiReviewModal() {
  document.getElementById('promo-review-modal')?.remove();
  window._promoPdfParsed = null;
}

async function _salvaTutti() {
  const settore     = document.getElementById('prev-settore')?.value.trim()  || '';
  const divisione   = document.getElementById('prev-divisione')?.value.trim() || '';
  const data_inizio = document.getElementById('prev-dinizio')?.value || null;
  const data_fine   = document.getElementById('prev-dfine')?.value   || null;
  const non_cum     = document.getElementById('prev-noncum')?.checked ?? true;
  const pdf_nome    = window._promoPdfParsed?.pdf_nome || '';

  let mese = null, anno = null;
  if (data_inizio) {
    const d = new Date(data_inizio + 'T00:00:00');
    mese = d.getMonth() + 1;
    anno = d.getFullYear();
  }

  const boxes  = [...document.querySelectorAll('#prev-entries .promo-entry-box')];
  const promos = boxes.map(box => ({
    nome:           box.querySelector('.prev-nome')?.value.trim() || '',
    condizioni:     box.querySelector('.prev-cond')?.value.trim() || null,
    note_ordine:    box.querySelector('.prev-nota')?.value.trim() || null,
    settore, divisione, mese, anno, data_inizio, data_fine,
    non_cumulabile: non_cum, attiva: true, pdf_nome,
    famiglie: [], codici_extra: [],
  })).filter(p => p.nome);

  if (!promos.length) {
    alert('Inserisci almeno una voce promo con un nome.');
    return;
  }

  const btn = document.querySelector('#promo-review-modal .bc-btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Salvataggio…'; }

  try {
    const { error } = await sb.from('promozioni')
      .upsert(promos, { onConflict: 'nome,anno,mese' });
    if (error) throw error;

    chiudiReviewModal();
    _promoList    = [];
    _famiglieLiv2 = [];
    await loadPromozioni();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Salva promozione'; }
    alert('Errore salvataggio: ' + e.message);
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
