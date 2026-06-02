let _ddtRows          = [];
let _ddtClienti       = {};
let _ddtFilter        = null;
let _pendingDDTFilter = null;

async function loadDDT() {
  const tbody   = document.querySelector('#ddt-table tbody');
  const countEl = document.getElementById('ddt-count');
  const todayMs = new Date().setHours(0, 0, 0, 0);
  tbody.innerHTML = '<tr><td colspan="8" class="loading">Caricamento…</td></tr>';

  try {
    const [{ data, error }, { data: clientiRaw }] = await Promise.all([
      sb.from('ddt')
        .select('numero_consegna, numero_ddt, data_ddt, codice_cliente, numero_ordine, corriere, stato, stato_shippeo, shippeo_url, eta_shippeo, data_consegna_effettiva')
        .order('data_ddt', { ascending: false }),
      sb.from('clienti').select('codice_cliente, ragione_sociale').eq('attivo', true),
    ]);
    if (error) throw error;

    _ddtClienti = Object.fromEntries((clientiRaw || []).map(c => [c.codice_cliente, c.ragione_sociale]));
    _ddtRows    = data || [];
    _ddtFilter  = _pendingDDTFilter;
    _pendingDDTFilter = null;

    countEl.textContent = _ddtRows.length;
    _renderDDTFiltri();
    _renderDDTTabella(todayMs);
  } catch (err) {
    document.querySelector('#ddt-table tbody').innerHTML =
      `<tr><td colspan="8" class="loading">Errore: ${err.message}</td></tr>`;
  }
}

function navToDDTFiltro(filtro) {
  _pendingDDTFilter = filtro;
  navToPage('ddt');
}

function _isRitardo(d, todayMs) {
  const isConsegnato = d.stato === 'consegnato' ||
    (d.stato_shippeo && d.stato_shippeo.toLowerCase().includes('delivery'));
  // ORDER_CONFIRMED = non ancora ritirato dal corriere → ETA non affidabile, non è "in ritardo"
  const isPreTransito = d.stato_shippeo && d.stato_shippeo.toUpperCase().includes('CONFIRMED');
  return !isConsegnato && !isPreTransito && d.eta_shippeo &&
    new Date(d.eta_shippeo).setHours(0,0,0,0) < todayMs;
}

function _renderDDTFiltri() {
  const bar     = document.getElementById('ddt-filter-bar');
  if (!bar) return;

  const todayMs = new Date().setHours(0, 0, 0, 0);
  const stati   = [...new Set(_ddtRows.map(r => r.stato).filter(Boolean))].sort();
  if (!stati.length) { bar.innerHTML = ''; return; }

  const ritardoCount = _ddtRows.filter(r => _isRitardo(r, todayMs)).length;

  // Mostra il chip 'in_ritardo' se ci sono DDT in ritardo OPPURE se il filtro è già attivo
  const showRitardo = ritardoCount > 0 || _ddtFilter === 'in_ritardo';
  const allKeys = ['tutti', ...stati, ...(showRitardo ? ['in_ritardo'] : [])];
  const chips = allKeys.map(s => {
    const active = (s === 'tutti' && !_ddtFilter) || s === _ddtFilter;
    const label  = s === 'tutti' ? 'Tutti' : s === 'in_ritardo' ? `⚠ In ritardo (${ritardoCount})` : _labelStato(s);
    const style  = s === 'in_ritardo' && !active ? ' style="color:#C84B2F;border-color:#C84B2F40;"' : '';
    return `<button class="ddt-chip${active ? ' active' : ''}"${style} onclick="filtraDDT(${s === 'tutti' ? 'null' : `'${s}'`})">${label}</button>`;
  }).join('');

  bar.innerHTML = chips;
}

function _labelStato(s) {
  return { consegnato: 'Consegnato', spedito: 'Spedito', in_preparazione: 'In preparazione',
           annullato: 'Annullato' }[s] || s.replace(/_/g, ' ');
}

function filtraDDT(stato) {
  _ddtFilter = stato;
  const todayMs = new Date().setHours(0, 0, 0, 0);
  _renderDDTFiltri();
  _renderDDTTabella(todayMs);
}

function _renderDDTTabella(todayMs) {
  const tbody   = document.querySelector('#ddt-table tbody');
  const countEl = document.getElementById('ddt-count');

  const rows = !_ddtFilter
    ? _ddtRows
    : _ddtFilter === 'in_ritardo'
      ? _ddtRows.filter(r => _isRitardo(r, todayMs))
      : _ddtRows.filter(r => r.stato === _ddtFilter);
  countEl.textContent = rows.length;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="loading">Nessun DDT trovato</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(d => {
    let statoBadge;
    const isConsegnato = d.stato === 'consegnato' ||
      (d.stato_shippeo && d.stato_shippeo.toLowerCase().includes('delivery'));
    if (isConsegnato) {
      const dt = d.data_consegna_effettiva ? ' · ' + fmtDate(d.data_consegna_effettiva) : '';
      statoBadge = `<span class="badge badge-green">✓ Consegnato${dt}</span>`;
    } else if (d.eta_shippeo) {
      const isLate = new Date(d.eta_shippeo).setHours(0,0,0,0) < todayMs;
      statoBadge = `<span class="eta-chip ${isLate ? 'eta-late' : 'eta-future'}">${isLate ? '⚠ Ritardo · ' : 'Arr. prev. '}${fmtDate(d.eta_shippeo)}</span>`;
    } else {
      statoBadge = statoBadgeOrdine(d.stato);
    }
    const nome = _ddtClienti[d.codice_cliente] || d.codice_cliente || '—';
    const ordineCell = d.numero_ordine
      ? `<a class="ord-link" href="#" onclick="goToOrdineFromDDT('${d.numero_ordine}');return false;">${d.numero_ordine}</a>`
      : '—';
    return `
    <tr>
      <td><strong>${d.numero_consegna || '—'}</strong></td>
      <td>${d.numero_ddt || '—'}</td>
      <td>${fmtDate(d.data_ddt)}</td>
      <td><span title="${d.codice_cliente || ''}">${nome}</span></td>
      <td>${ordineCell}</td>
      <td>${d.corriere || '—'}</td>
      <td>${statoBadge}</td>
      <td>${d.shippeo_url ? `<a class="shippeo-link" href="${d.shippeo_url}" target="_blank" rel="noopener">Traccia →</a>` : '—'}</td>
    </tr>`;
  }).join('');
}
