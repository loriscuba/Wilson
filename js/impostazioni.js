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

let _cfgRows  = [];
let _cfgQuery = '';

async function loadImpostazioni() {
  _renderTokenSection();
  const root = document.getElementById('cfg-clienti-root');
  if (!root) return;
  root.innerHTML = '<div class="loading">Caricamento…</div>';

  try {
    // Legge tutti i clienti dall'ultimo rolling + config attuale + anagrafica attivo
    const [rollingRes, cfgRes, clientiRes] = await Promise.all([
      sb.from('rolling_fatturato')
        .select('codice_cliente, ragione_sociale')
        .eq('data_aggiornamento', await getLatestRollingDate())
        .order('ragione_sociale'),
      sb.from('clienti_config').select('codice_cliente, ragione_sociale, attivo, note, ordina_di_persona'),
      sb.from('clienti').select('codice_cliente, ragione_sociale, citta, attivo'),
    ]);

    const cfgMap = Object.fromEntries(
      (cfgRes.data || []).map(r => [String(r.codice_cliente), r])
    );
    const clientiMap = Object.fromEntries(
      (clientiRes.data || []).map(r => [String(r.codice_cliente), r])
    );

    const rollingCodes = new Set((rollingRes.data || []).map(r => String(r.codice_cliente)));
    const cfgCodes     = new Set((cfgRes.data || []).map(r => String(r.codice_cliente)));

    // Merge: rolling + config-only + clienti-only (non in rolling né in config)
    const onlyCfg = (cfgRes.data || [])
      .filter(r => !rollingCodes.has(String(r.codice_cliente)));

    const onlyClienti = (clientiRes.data || [])
      .filter(r => !rollingCodes.has(String(r.codice_cliente)) && !cfgCodes.has(String(r.codice_cliente)));

    _cfgRows = [
      ...(rollingRes.data || []).map(r => {
        const cfg = cfgMap[String(r.codice_cliente)];
        const cli = clientiMap[String(r.codice_cliente)];
        return {
          codice:           String(r.codice_cliente),
          nome:             cfg?.ragione_sociale || r.ragione_sociale || '—',
          citta:            cli?.citta || '—',
          attivo:           cfg ? cfg.attivo : true,
          note:             cfg?.note || '',
          ordinaDiPersona:  cfg?.ordina_di_persona || false,
          inCfg:            !!cfg,
          anagraficaAttiva: cli ? cli.attivo : true,
        };
      }),
      ...onlyCfg.map(r => {
        const cli = clientiMap[String(r.codice_cliente)];
        return {
          codice:           String(r.codice_cliente),
          nome:             r.ragione_sociale || '—',
          citta:            cli?.citta || '—',
          attivo:           r.attivo,
          note:             r.note || '',
          ordinaDiPersona:  r.ordina_di_persona || false,
          inCfg:            true,
          anagraficaAttiva: cli ? cli.attivo : true,
        };
      }),
      ...onlyClienti.map(r => ({
        codice:           String(r.codice_cliente),
        nome:             r.ragione_sociale || '—',
        citta:            r.citta || '—',
        attivo:           true,
        note:             '',
        ordinaDiPersona:  false,
        inCfg:            false,
        anagraficaAttiva: r.attivo,
      })),
    ];

    _cfgQuery = '';
    _renderImpostazioni(root);
  } catch (err) {
    root.innerHTML = `<p style="color:var(--red);padding:1rem">Errore: ${err.message}</p>`;
  }
}

function _renderImpostazioni(root) {
  const esclusi   = _cfgRows.filter(r => !r.attivo).length;
  const disattivi = _cfgRows.filter(r => !r.anagraficaAttiva).length;
  const diPersona = _cfgRows.filter(r => r.ordinaDiPersona).length;
  root.innerHTML = `
    <p class="b-sec">gestione clienti — inclusi/esclusi da dashboard e budget</p>
    <p style="font-size:12px;color:var(--text2);margin-bottom:1rem">
      <strong>Visibile</strong>: compare nella sezione Clienti.
      <strong>Dashboard</strong>: compare nel top-15 e nel budget.
      · <strong>${disattivi}</strong> disattivati · <strong>${esclusi}</strong> esclusi da dashboard
      · <strong>${diPersona}</strong> ordinano di persona
    </p>
    <div class="cfg-toolbar">
      <input type="text" class="b-srch" id="cfg-srch" placeholder="cerca cliente…"
        value="${_cfgQuery}" oninput="onCfgSearch(this.value)">
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
          <th>Note</th>
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
    tbody.innerHTML = `<tr><td colspan="7" style="padding:1.5rem;text-align:center;color:var(--text2)">Nessun cliente trovato</td></tr>`;
    return;
  }

  tbody.innerHTML = visible.map(r => `
    <tr class="${!r.anagraficaAttiva ? 'cfg-row-off' : !r.attivo ? 'cfg-row-nodash' : ''}">
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
      <td>
        <input class="cfg-note-inp" type="text" value="${r.note}"
          placeholder="es. filiale, intercompany…"
          onchange="saveClienteNote('${r.codice}', this.value)">
      </td>
    </tr>`).join('');
}

async function toggleAnagraficaAttiva(codice, attivo) {
  const row = _cfgRows.find(r => r.codice === codice);
  if (row) row.anagraficaAttiva = attivo;
  _renderCfgRows();
  try {
    await sb.from('clienti').update({ attivo }).eq('codice_cliente', codice);
    _clientiData = [];  // forza ricarica clienti
  } catch (err) {
    if (row) row.anagraficaAttiva = !attivo;
    _renderCfgRows();
    console.error('Errore:', err.message);
  }
}

async function toggleClienteAttivo(codice, attivo) {
  const row = _cfgRows.find(r => r.codice === codice);
  if (row) { row.attivo = attivo; row.inCfg = true; }

  const root = document.getElementById('cfg-clienti-root');
  const esclusi   = _cfgRows.filter(r => !r.attivo).length;
  const diPersona = _cfgRows.filter(r => r.ordinaDiPersona).length;
  const info = root?.querySelector('p:nth-child(2)');
  if (info) info.innerHTML = `
    Clienti con <strong>Attivo = NO</strong> non compaiono nel top-15 da ordinare né nel budget clienti.
    · <strong>${esclusi}</strong> esclusi · <strong>${_cfgRows.length - esclusi}</strong> attivi
    · <strong>${diPersona}</strong> ordinano di persona`;

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

  const root = document.getElementById('cfg-clienti-root');
  const esclusi   = _cfgRows.filter(r => !r.attivo).length;
  const diPersona = _cfgRows.filter(r => r.ordinaDiPersona).length;
  const info = root?.querySelector('p:nth-child(2)');
  if (info) info.innerHTML = `
    Clienti con <strong>Attivo = NO</strong> non compaiono nel top-15 da ordinare né nel budget clienti.
    · <strong>${esclusi}</strong> esclusi · <strong>${_cfgRows.length - esclusi}</strong> attivi
    · <strong>${diPersona}</strong> ordinano di persona`;

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
