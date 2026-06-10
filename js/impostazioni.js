// ── Impostazioni → Token GitHub ───────────────────────────────────────────────

function _renderTokenSection() {
  const root = document.getElementById('cfg-token-root');
  if (!root) return;
  const saved = localStorage.getItem('github_token') || '';
  root.innerHTML = `
    <p class="b-sec" style="margin-top:0">token github — aggiorna dati</p>
    <div class="b-panel" style="padding:1rem 1.25rem;display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap">
      <div style="display:flex;flex-direction:column;gap:5px;flex:1;min-width:220px">
        <label style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text2);letter-spacing:.06em">
          Personal Access Token (scope: workflow)
        </label>
        <input type="password" id="cfg-github-token" class="filter-input" style="width:100%;font-family:monospace"
          value="${saved}" placeholder="ghp_…">
      </div>
      <button class="btn-nuova-stat" onclick="salvaGithubToken()" style="flex-shrink:0">
        Salva token
      </button>
      <span id="cfg-token-status" style="font-size:13px;color:var(--text2);align-self:center">
        ${saved ? '✓ Token configurato' : '— Non configurato'}
      </span>
    </div>`;
}

function salvaGithubToken() {
  const val = document.getElementById('cfg-github-token')?.value.trim() || '';
  if (val) {
    localStorage.setItem('github_token', val);
  } else {
    localStorage.removeItem('github_token');
  }
  const status = document.getElementById('cfg-token-status');
  if (status) status.textContent = val ? '✓ Salvato' : '— Rimosso';
}

// ── Impostazioni → Gestione clienti ──────────────────────────────────────────

let _cfgRows      = [];
let _cfgQuery     = '';
let _cfgSettori   = [];   // [{id, nome}]
let _cfgCategorie = [];   // [{id, nome}]

async function _loadLookups() {
  if (_cfgSettori.length && _cfgCategorie.length) return;
  const [sRes, cRes] = await Promise.all([
    sb.from('settori').select('id, nome').order('nome'),
    sb.from('categorie').select('id, nome').order('nome'),
  ]);
  _cfgSettori   = sRes.data  || [];
  _cfgCategorie = cRes.data  || [];
}

async function loadImpostazioni() {
  _renderTokenSection();
  const root = document.getElementById('cfg-clienti-root');
  if (!root) return;
  root.innerHTML = '<div class="loading">Caricamento…</div>';

  try {
    const [rollingRes, cfgRes, clientiRes] = await Promise.all([
      sb.from('rolling_fatturato')
        .select('codice_cliente, ragione_sociale')
        .eq('data_aggiornamento', await getLatestRollingDate())
        .order('ragione_sociale'),
      sb.from('clienti_config').select('codice_cliente, ragione_sociale, attivo, note, ordina_di_persona'),
      sb.from('clienti').select('codice_cliente, ragione_sociale, indirizzo, civico, citta, provincia, cap, settore_id, categoria_id, attivo, solo_destinazione, settori(nome), categorie(nome)'),
      _loadLookups(),
    ]);

    const cfgMap = Object.fromEntries(
      (cfgRes.data || []).map(r => [String(r.codice_cliente), r])
    );
    const clientiMap = Object.fromEntries(
      (clientiRes.data || []).map(r => [String(r.codice_cliente), r])
    );

    const rollingCodes = new Set((rollingRes.data || []).map(r => String(r.codice_cliente)));
    const cfgCodes     = new Set((cfgRes.data || []).map(r => String(r.codice_cliente)));

    const onlyCfg = (cfgRes.data || [])
      .filter(r => !rollingCodes.has(String(r.codice_cliente)));

    const onlyClienti = (clientiRes.data || [])
      .filter(r => !rollingCodes.has(String(r.codice_cliente)) && !cfgCodes.has(String(r.codice_cliente)));

    const _mkRow = (codice, nome, cli, cfg) => ({
      codice,
      nome:              cfg?.ragione_sociale || nome || cli?.ragione_sociale || '—',
      citta:             cli?.citta      || '—',
      provincia:         cli?.provincia  || '',
      cap:               cli?.cap        || '',
      indirizzo:         cli?.indirizzo  || '',
      civico:            cli?.civico     || '',
      settoreId:         cli?.settore_id || null,
      settoreNome:       cli?.settori?.nome || '—',
      categoriaId:       cli?.categoria_id || null,
      categoriaNome:     cli?.categorie?.nome || '—',
      attivo:            cfg ? cfg.attivo : true,
      note:              cfg?.note || '',
      ordinaDiPersona:   cfg?.ordina_di_persona || false,
      soloDestinazione:  cli?.solo_destinazione || false,
      inCfg:             !!cfg,
      anagraficaAttiva:  cli ? cli.attivo : true,
      inAnag:            !!cli,
    });

    _cfgRows = [
      ...(rollingRes.data || []).map(r => {
        const cod = String(r.codice_cliente);
        return _mkRow(cod, r.ragione_sociale, clientiMap[cod], cfgMap[cod]);
      }),
      ...onlyCfg.map(r => {
        const cod = String(r.codice_cliente);
        return _mkRow(cod, r.ragione_sociale, clientiMap[cod], r);
      }),
      ...onlyClienti.map(r => _mkRow(String(r.codice_cliente), r.ragione_sociale, r, null)),
    ];

    _cfgQuery = '';
    _renderImpostazioni(root);
  } catch (err) {
    root.innerHTML = `<p style="color:var(--red);padding:1rem">Errore: ${err.message}</p>`;
  }
}

function _renderImpostazioni(root) {
  const esclusi      = _cfgRows.filter(r => !r.attivo).length;
  const disattivi    = _cfgRows.filter(r => !r.anagraficaAttiva).length;
  const diPersona    = _cfgRows.filter(r => r.ordinaDiPersona).length;
  const soloDest     = _cfgRows.filter(r => r.soloDestinazione).length;
  root.innerHTML = `
    <p class="b-sec">gestione clienti — inclusi/esclusi da dashboard e budget</p>
    <p style="font-size:12px;color:var(--text2);margin-bottom:1rem">
      <strong>Visibile</strong>: compare nella sezione Clienti.
      <strong>Dashboard</strong>: compare nel top-15 e nel budget.
      <strong>Solo DDT</strong>: destinazione pura, esclusa da statistiche e clienti.
      · <strong>${disattivi}</strong> disattivati · <strong>${esclusi}</strong> esclusi da dashboard
      · <strong>${diPersona}</strong> ordinano di persona · <strong>${soloDest}</strong> solo destinazione
    </p>
    <div class="cfg-toolbar" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:.75rem">
      <input type="text" class="b-srch" id="cfg-srch" placeholder="cerca cliente…"
        value="${_cfgQuery}" oninput="onCfgSearch(this.value)" style="flex:1;min-width:180px">
      <button class="btn-nuova-stat" onclick="openNuovoClienteModal()" style="white-space:nowrap">
        + Nuovo cliente
      </button>
    </div>
    <div class="b-panel" style="padding:.5rem 1rem;overflow-x:auto">
      <table class="b-tbl" id="cfg-table">
        <thead><tr>
          <th>Codice</th>
          <th>Ragione sociale</th>
          <th>Città</th>
          <th style="text-align:center">Visibile</th>
          <th style="text-align:center">Dashboard</th>
          <th style="text-align:center">Di persona</th>
          <th style="text-align:center">Solo DDT</th>
          <th>Note</th>
          <th></th>
        </tr></thead>
        <tbody id="cfg-tbody"></tbody>
      </table>
    </div>`;
  _renderCfgRows();
}

function _renderCfgRows() {
  const tbody = document.getElementById('cfg-tbody');
  if (!tbody) return;
  const q = _cfgQuery.toLowerCase();
  const visible = q
    ? _cfgRows.filter(r => r.nome.toLowerCase().includes(q) || r.codice.includes(q))
    : _cfgRows;

  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="padding:1.5rem;text-align:center;color:var(--text2)">Nessun cliente trovato</td></tr>`;
    return;
  }

  tbody.innerHTML = visible.map(r => `
    <tr class="${!r.anagraficaAttiva ? 'cfg-row-off' : r.soloDestinazione ? 'cfg-row-dest' : !r.attivo ? 'cfg-row-nodash' : ''}">
      <td style="font-size:12px;color:var(--text2)">${r.codice}</td>
      <td>${r.nome}</td>
      <td style="font-size:12px;color:var(--text2)">${r.citta}</td>
      <td style="text-align:center">
        <label class="cfg-toggle" title="${r.anagraficaAttiva ? 'Visibile in Clienti — clicca per disattivare' : 'Disattivato — clicca per riattivare'}">
          <input type="checkbox" ${r.anagraficaAttiva ? 'checked' : ''}
            onchange="toggleAnagraficaAttiva('${r.codice}', this.checked)">
          <span class="cfg-slider"></span>
        </label>
      </td>
      <td style="text-align:center">
        <label class="cfg-toggle" title="${r.attivo ? 'Clicca per escludere da dashboard' : 'Clicca per includere in dashboard'}">
          <input type="checkbox" ${r.attivo ? 'checked' : ''}
            onchange="toggleClienteAttivo('${r.codice}', this.checked)">
          <span class="cfg-slider"></span>
        </label>
      </td>
      <td style="text-align:center">
        <label class="cfg-toggle" title="${r.ordinaDiPersona ? 'Ordina di persona (clicca per rimuovere)' : 'Clicca per segnare come ordina di persona'}">
          <input type="checkbox" ${r.ordinaDiPersona ? 'checked' : ''}
            onchange="toggleOrdinaDiPersona('${r.codice}', this.checked)">
          <span class="cfg-slider"></span>
        </label>
      </td>
      <td style="text-align:center">
        <label class="cfg-toggle" title="${r.soloDestinazione ? 'Solo destinazione DDT — clicca per rimuovere' : 'Clicca per marcare come solo destinazione DDT'}">
          <input type="checkbox" ${r.soloDestinazione ? 'checked' : ''}
            onchange="toggleSoloDestinazione('${r.codice}', this.checked)">
          <span class="cfg-slider"></span>
        </label>
      </td>
      <td>
        <input class="cfg-note-inp" type="text" value="${r.note}"
          placeholder="es. filiale, intercompany…"
          onchange="saveClienteNote('${r.codice}', this.value)">
      </td>
      <td style="text-align:right;padding-right:4px">
        <button class="cfg-edit-btn" onclick="openEditClienteModal('${r.codice}')" title="Modifica anagrafica">
          <i class="ti ti-pencil"></i>
        </button>
      </td>
    </tr>`).join('');
}

// ── Toggle handlers ───────────────────────────────────────────────────────────

async function toggleAnagraficaAttiva(codice, attivo) {
  const row = _cfgRows.find(r => r.codice === codice);
  if (row) row.anagraficaAttiva = attivo;
  _renderCfgRows();
  try {
    await sb.from('clienti').update({ attivo }).eq('codice_cliente', codice);
    _clientiData = [];
  } catch (err) {
    if (row) row.anagraficaAttiva = !attivo;
    _renderCfgRows();
    console.error('Errore:', err.message);
  }
}

async function toggleClienteAttivo(codice, attivo) {
  const row = _cfgRows.find(r => r.codice === codice);
  if (row) { row.attivo = attivo; row.inCfg = true; }
  _renderCfgRows();
  try {
    const nome = row?.nome && row.nome !== '—' ? row.nome : null;
    await sb.from('clienti_config').upsert(
      { codice_cliente: codice, ragione_sociale: nome, attivo, note: row?.note || null,
        ordina_di_persona: row?.ordinaDiPersona || false },
      { onConflict: 'codice_cliente' }
    );
    _clientiEsclusi     = null;
    _ordinaDiPersonaSet = null;
    _rollingEnriched    = null;
  } catch (err) {
    console.error('Errore salvataggio:', err.message);
  }
}

async function toggleOrdinaDiPersona(codice, val) {
  const row = _cfgRows.find(r => r.codice === codice);
  if (row) { row.ordinaDiPersona = val; row.inCfg = true; }
  try {
    const nome = row?.nome && row.nome !== '—' ? row.nome : null;
    await sb.from('clienti_config').upsert(
      { codice_cliente: codice, ragione_sociale: nome, attivo: row?.attivo ?? true,
        note: row?.note || null, ordina_di_persona: val },
      { onConflict: 'codice_cliente' }
    );
    _ordinaDiPersonaSet = null;
    _rollingEnriched    = null;
  } catch (err) {
    console.error('Errore salvataggio:', err.message);
  }
}

async function toggleSoloDestinazione(codice, val) {
  const row = _cfgRows.find(r => r.codice === codice);
  if (row) row.soloDestinazione = val;
  _renderCfgRows();
  try {
    if (row?.inAnag) {
      await sb.from('clienti').update({ solo_destinazione: val }).eq('codice_cliente', codice);
    } else {
      // Cliente non ancora in anagrafica: crea il record minimo
      await sb.from('clienti').upsert(
        { codice_cliente: codice, ragione_sociale: row?.nome || codice, solo_destinazione: val, attivo: true },
        { onConflict: 'codice_cliente' }
      );
      if (row) row.inAnag = true;
    }
    _rollingEnriched = null;
  } catch (err) {
    if (row) row.soloDestinazione = !val;
    _renderCfgRows();
    console.error('Errore salvataggio:', err.message);
  }
}

async function saveClienteNote(codice, note) {
  const row = _cfgRows.find(r => r.codice === codice);
  if (row) row.note = note;
  try {
    await sb.from('clienti_config').upsert(
      { codice_cliente: codice, note: note || null, attivo: row?.attivo ?? true,
        ordina_di_persona: row?.ordinaDiPersona || false },
      { onConflict: 'codice_cliente' }
    );
  } catch (err) {
    console.error('Errore salvataggio nota:', err.message);
  }
}

function onCfgSearch(q) {
  _cfgQuery = q;
  _renderCfgRows();
}

// ── Modal modifica / nuovo cliente ────────────────────────────────────────────

function _getOverlay() {
  let el = document.getElementById('cfg-cliente-modal-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'cfg-cliente-modal-overlay';
    el.className = 'cfg-modal-overlay';
    el.addEventListener('click', e => { if (e.target === el) closeCfgClienteModal(); });
    document.body.appendChild(el);
  }
  return el;
}

function closeCfgClienteModal() {
  const el = document.getElementById('cfg-cliente-modal-overlay');
  if (el) el.classList.remove('open');
}

function _buildClienteModalHTML(row, isNew) {
  const settoreOpts = _cfgSettori.map(s =>
    `<option value="${s.id}" ${row?.settoreId === s.id ? 'selected' : ''}>${s.nome}</option>`
  ).join('');
  const catOpts = _cfgCategorie.map(c =>
    `<option value="${c.id}" ${row?.categoriaId === c.id ? 'selected' : ''}>${c.nome}</option>`
  ).join('');

  return `
    <div class="cfg-modal" onclick="event.stopPropagation()">
      <div class="stat-modal-header">
        <span class="stat-modal-title">${isNew ? 'Nuovo cliente' : 'Modifica cliente'}</span>
        <button class="stat-modal-close" onclick="closeCfgClienteModal()">✕</button>
      </div>
      <div class="stat-modal-body">
        ${isNew ? `
        <div class="stat-field">
          <label class="stat-label">Codice cliente *</label>
          <input type="text" id="cmod-codice" class="filter-input" style="width:100%"
            placeholder="Es. 123456" value="">
        </div>` : `
        <div class="stat-field">
          <label class="stat-label">Codice cliente</label>
          <input type="text" class="filter-input" style="width:100%;opacity:.6" value="${row.codice}" disabled>
        </div>`}
        <div class="stat-field">
          <label class="stat-label">Ragione sociale *</label>
          <input type="text" id="cmod-nome" class="filter-input" style="width:100%"
            value="${row?.nome && row.nome !== '—' ? _esc(row.nome) : ''}">
        </div>
        <div style="display:grid;grid-template-columns:1fr 80px;gap:10px">
          <div class="stat-field">
            <label class="stat-label">Indirizzo</label>
            <input type="text" id="cmod-indirizzo" class="filter-input" style="width:100%"
              value="${_esc(row?.indirizzo || '')}">
          </div>
          <div class="stat-field">
            <label class="stat-label">Civico</label>
            <input type="text" id="cmod-civico" class="filter-input" style="width:100%"
              value="${_esc(row?.civico || '')}">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 80px 80px;gap:10px">
          <div class="stat-field">
            <label class="stat-label">Città</label>
            <input type="text" id="cmod-citta" class="filter-input" style="width:100%"
              value="${_esc(row?.citta && row.citta !== '—' ? row.citta : '')}">
          </div>
          <div class="stat-field">
            <label class="stat-label">Prov.</label>
            <input type="text" id="cmod-provincia" class="filter-input" style="width:100%;text-transform:uppercase"
              maxlength="2" value="${_esc(row?.provincia || '')}">
          </div>
          <div class="stat-field">
            <label class="stat-label">CAP</label>
            <input type="text" id="cmod-cap" class="filter-input" style="width:100%"
              maxlength="5" value="${_esc(row?.cap || '')}">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="stat-field">
            <label class="stat-label">Settore</label>
            <select id="cmod-settore" class="filter-input" style="width:100%">
              <option value="">— nessuno —</option>
              ${settoreOpts}
            </select>
          </div>
          <div class="stat-field">
            <label class="stat-label">Categoria</label>
            <select id="cmod-categoria" class="filter-input" style="width:100%">
              <option value="">— nessuna —</option>
              ${catOpts}
            </select>
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:4px">
          <button class="btn-secondary" onclick="closeCfgClienteModal()">Annulla</button>
          <button class="btn-nuova-stat" onclick="${isNew ? 'saveNuovoCliente()' : `saveEditCliente('${row.codice}')`}">
            ${isNew ? 'Crea cliente' : 'Salva modifiche'}
          </button>
        </div>
      </div>
    </div>`;
}

async function openEditClienteModal(codice) {
  await _loadLookups();
  const row = _cfgRows.find(r => r.codice === codice);
  const overlay = _getOverlay();
  overlay.innerHTML = _buildClienteModalHTML(row, false);
  overlay.classList.add('open');
}

async function openNuovoClienteModal() {
  await _loadLookups();
  const overlay = _getOverlay();
  overlay.innerHTML = _buildClienteModalHTML(null, true);
  overlay.classList.add('open');
}

async function saveEditCliente(codice) {
  const nome      = document.getElementById('cmod-nome')?.value.trim();
  const indirizzo = document.getElementById('cmod-indirizzo')?.value.trim() || null;
  const civico    = document.getElementById('cmod-civico')?.value.trim()    || null;
  const citta     = document.getElementById('cmod-citta')?.value.trim()     || null;
  const provincia = document.getElementById('cmod-provincia')?.value.trim().toUpperCase() || null;
  const cap       = document.getElementById('cmod-cap')?.value.trim()       || null;
  const settoreId   = document.getElementById('cmod-settore')?.value   || null;
  const categoriaId = document.getElementById('cmod-categoria')?.value || null;

  if (!nome) { alert('La ragione sociale è obbligatoria.'); return; }

  try {
    const payload = { ragione_sociale: nome, indirizzo, civico, citta, provincia, cap,
      settore_id: settoreId || null, categoria_id: categoriaId || null };

    const row = _cfgRows.find(r => r.codice === codice);
    if (row?.inAnag) {
      await sb.from('clienti').update(payload).eq('codice_cliente', codice);
    } else {
      await sb.from('clienti').insert({ ...payload, codice_cliente: codice, attivo: true });
    }

    // Aggiorna la riga locale
    if (row) {
      Object.assign(row, {
        nome, indirizzo: indirizzo || '', civico: civico || '',
        citta: citta || '—', provincia: provincia || '', cap: cap || '',
        settoreId: settoreId || null,
        settoreNome: _cfgSettori.find(s => s.id === settoreId)?.nome || '—',
        categoriaId: categoriaId || null,
        categoriaNome: _cfgCategorie.find(c => c.id === categoriaId)?.nome || '—',
        inAnag: true,
      });
    }

    closeCfgClienteModal();
    _renderCfgRows();
    _clientiData = [];
  } catch (err) {
    alert('Errore nel salvataggio: ' + err.message);
  }
}

async function saveNuovoCliente() {
  const codice    = document.getElementById('cmod-codice')?.value.trim();
  const nome      = document.getElementById('cmod-nome')?.value.trim();
  const indirizzo = document.getElementById('cmod-indirizzo')?.value.trim() || null;
  const civico    = document.getElementById('cmod-civico')?.value.trim()    || null;
  const citta     = document.getElementById('cmod-citta')?.value.trim()     || null;
  const provincia = document.getElementById('cmod-provincia')?.value.trim().toUpperCase() || null;
  const cap       = document.getElementById('cmod-cap')?.value.trim()       || null;
  const settoreId   = document.getElementById('cmod-settore')?.value   || null;
  const categoriaId = document.getElementById('cmod-categoria')?.value || null;

  if (!codice) { alert('Il codice cliente è obbligatorio.'); return; }
  if (!nome)   { alert('La ragione sociale è obbligatoria.'); return; }
  if (_cfgRows.find(r => r.codice === codice)) {
    alert(`Il codice cliente "${codice}" esiste già.`); return;
  }

  try {
    await sb.from('clienti').insert({
      codice_cliente: codice, ragione_sociale: nome,
      indirizzo, civico, citta, provincia, cap,
      settore_id: settoreId || null, categoria_id: categoriaId || null,
      attivo: true, solo_destinazione: false,
    });

    _cfgRows.unshift({
      codice, nome, citta: citta || '—', provincia: provincia || '', cap: cap || '',
      indirizzo: indirizzo || '', civico: civico || '',
      settoreId: settoreId || null,
      settoreNome: _cfgSettori.find(s => s.id === settoreId)?.nome || '—',
      categoriaId: categoriaId || null,
      categoriaNome: _cfgCategorie.find(c => c.id === categoriaId)?.nome || '—',
      attivo: true, note: '', ordinaDiPersona: false, soloDestinazione: false,
      inCfg: false, anagraficaAttiva: true, inAnag: true,
    });

    closeCfgClienteModal();
    _renderCfgRows();
    _clientiData = [];
  } catch (err) {
    alert('Errore nel salvataggio: ' + (err.message || JSON.stringify(err)));
  }
}

function _esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}
