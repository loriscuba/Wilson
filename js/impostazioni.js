// ── Impostazioni → Gestione clienti ──────────────────────────────────────────

let _cfgRows  = [];
let _cfgQuery = '';

async function loadImpostazioni() {
  const root = document.getElementById('cfg-clienti-root');
  if (!root) return;
  root.innerHTML = '<div class="loading">Caricamento…</div>';

  try {
    // Legge tutti i clienti dall'ultimo rolling + config attuale
    const [rollingRes, cfgRes] = await Promise.all([
      sb.from('rolling_fatturato')
        .select('codice_cliente, ragione_sociale')
        .eq('data_aggiornamento', await getLatestRollingDate())
        .order('ragione_sociale'),
      sb.from('clienti_config').select('codice_cliente, ragione_sociale, attivo, note, ordina_di_persona'),
    ]);

    const cfgMap = Object.fromEntries(
      (cfgRes.data || []).map(r => [String(r.codice_cliente), r])
    );

    // Merge: rolling + config (clienti solo in config ma non più nel rolling)
    const onlyCfg = (cfgRes.data || [])
      .filter(r => !(rollingRes.data || []).some(x => String(x.codice_cliente) === String(r.codice_cliente)));

    _cfgRows = [
      ...(rollingRes.data || []).map(r => {
        const cfg = cfgMap[String(r.codice_cliente)];
        return {
          codice:          String(r.codice_cliente),
          nome:            cfg?.ragione_sociale || r.ragione_sociale || '—',
          attivo:          cfg ? cfg.attivo : true,
          note:            cfg?.note || '',
          ordinaDiPersona: cfg?.ordina_di_persona || false,
          inCfg:           !!cfg,
        };
      }),
      ...onlyCfg.map(r => ({
        codice:          String(r.codice_cliente),
        nome:            r.ragione_sociale || '—',
        attivo:          r.attivo,
        note:            r.note || '',
        ordinaDiPersona: r.ordina_di_persona || false,
        inCfg:           true,
      })),
    ];

    _cfgQuery = '';
    _renderImpostazioni(root);
  } catch (err) {
    root.innerHTML = `<p style="color:var(--red);padding:1rem">Errore: ${err.message}</p>`;
  }
}

function _renderImpostazioni(root) {
  const esclusi  = _cfgRows.filter(r => !r.attivo).length;
  const diPersona = _cfgRows.filter(r => r.ordinaDiPersona).length;
  root.innerHTML = `
    <p class="b-sec">gestione clienti — inclusi/esclusi da dashboard e budget</p>
    <p style="font-size:12px;color:var(--text2);margin-bottom:1rem">
      Clienti con <strong>Attivo = NO</strong> non compaiono nel top-15 da ordinare né nel budget clienti.
      · <strong>${esclusi}</strong> esclusi · <strong>${_cfgRows.length - esclusi}</strong> attivi
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
          <th style="text-align:center">Attivo</th>
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
    tbody.innerHTML = `<tr><td colspan="5" style="padding:1.5rem;text-align:center;color:var(--text2)">Nessun cliente trovato</td></tr>`;
    return;
  }

  tbody.innerHTML = visible.map(r => `
    <tr class="${r.attivo ? '' : 'cfg-row-off'}">
      <td style="font-size:12px;color:var(--text2)">${r.codice}</td>
      <td>${r.nome}</td>
      <td style="text-align:center">
        <label class="cfg-toggle" title="${r.attivo ? 'Clicca per escludere' : 'Clicca per includere'}">
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
