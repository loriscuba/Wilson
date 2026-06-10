let _ddtRows          = [];
let _ddtClienti       = {};
let _ddtFilter        = null;
let _ddtMese          = null;   // 'YYYY-MM' oppure '' per tutti
let _pendingDDTFilter = null;
const _trkRegistry    = new Map();

function _meseCorrente() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

async function loadDDT() {
  const tbody   = document.querySelector('#ddt-table tbody');
  const countEl = document.getElementById('ddt-count');
  const todayMs = new Date().setHours(0, 0, 0, 0);
  tbody.innerHTML = '<tr><td colspan="8" class="loading">Caricamento…</td></tr>';

  try {
    const [{ data, error }, { data: clientiRaw }] = await Promise.all([
      sb.from('ddt')
        .select('numero_consegna, numero_ddt, data_ddt, codice_cliente, numero_ordine, corriere, stato, stato_shippeo, shippeo_url, eta_shippeo, data_consegna_effettiva, fercam_url, fercam_dati')
        .order('data_ddt', { ascending: false }),
      sb.from('clienti').select('codice_cliente, ragione_sociale'),
    ]);
    if (error) throw error;

    _ddtClienti = Object.fromEntries((clientiRaw || []).map(c => [c.codice_cliente, c.ragione_sociale]));
    _ddtRows    = data || [];

    // Fallback: per i codici non trovati in clienti, cerca destinazione_ragione_sociale
    // tramite numero_ordine (il codice può essere una destinazione, non il cliente ordinante)
    const righeOrfane = _ddtRows.filter(d => d.codice_cliente && !_ddtClienti[d.codice_cliente]);
    const numeriOrdine = [...new Set(righeOrfane.map(d => d.numero_ordine).filter(Boolean))];
    if (numeriOrdine.length) {
      const { data: ordFallback } = await sb.from('ordini')
        .select('numero_ordine, destinazione_ragione_sociale')
        .in('numero_ordine', numeriOrdine)
        .not('destinazione_ragione_sociale', 'is', null);
      // Mappa numero_ordine → nome destinazione
      const nomeByOrdine = Object.fromEntries(
        (ordFallback || []).map(o => [o.numero_ordine, o.destinazione_ragione_sociale])
      );
      // Propaga il nome al codice_cliente corrispondente
      for (const d of righeOrfane) {
        const nome = nomeByOrdine[d.numero_ordine];
        if (nome && !_ddtClienti[d.codice_cliente]) _ddtClienti[d.codice_cliente] = nome;
      }
    }

    if (_ddtMese === null) _ddtMese = _meseCorrente();
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
    (d.stato_shippeo && d.stato_shippeo.toLowerCase() === 'deliverycompliant');
  const etaMs = d.eta_shippeo ? new Date(d.eta_shippeo).setHours(0,0,0,0) : null;
  // ORDER_CONFIRMED = non ancora ritirato dal corriere → ETA non affidabile solo se ETA è futura.
  // Se l'ETA è già scaduta, è in ritardo a prescindere dallo stato.
  const isPreTransito = d.stato_shippeo &&
    d.stato_shippeo.toUpperCase().includes('CONFIRMED') &&
    etaMs !== null && etaMs >= todayMs;
  return !isConsegnato && !isPreTransito && etaMs !== null && etaMs < todayMs;
}

function _renderDDTFiltri() {
  const bar = document.getElementById('ddt-filter-bar');
  if (!bar) return;

  const todayMs = new Date().setHours(0, 0, 0, 0);

  // Mesi disponibili dai dati, ordinati decrescenti
  const mesiDisp = [...new Set(
    _ddtRows.map(r => r.data_ddt?.substring(0, 7)).filter(Boolean)
  )].sort().reverse();

  const meseOpts = [
    `<option value="">Tutti i mesi</option>`,
    ...mesiDisp.map(m => {
      const [y, mo] = m.split('-');
      const label = new Date(+y, +mo - 1, 1).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
      return `<option value="${m}" ${_ddtMese === m ? 'selected' : ''}>${label}</option>`;
    }),
  ].join('');

  const stati = [...new Set(_ddtRows.map(r => r.stato).filter(Boolean))].sort();
  const rowsFiltroMese = _ddtMese
    ? _ddtRows.filter(r => r.data_ddt?.startsWith(_ddtMese))
    : _ddtRows;
  const ritardoCount = rowsFiltroMese.filter(r => _isRitardo(r, todayMs)).length;
  const showRitardo  = ritardoCount > 0 || _ddtFilter === 'in_ritardo';
  const allKeys      = ['tutti', ...stati, ...(showRitardo ? ['in_ritardo'] : [])];
  const chips        = allKeys.map(s => {
    const active = (s === 'tutti' && !_ddtFilter) || s === _ddtFilter;
    const label  = s === 'tutti' ? 'Tutti' : s === 'in_ritardo' ? `⚠ In ritardo (${ritardoCount})` : _labelStato(s);
    const style  = s === 'in_ritardo' && !active ? ' style="color:#C84B2F;border-color:#C84B2F40;"' : '';
    return `<button class="ddt-chip${active ? ' active' : ''}"${style} onclick="filtraDDT(${s === 'tutti' ? 'null' : `'${s}'`})">${label}</button>`;
  }).join('');

  bar.innerHTML = `
    <select class="ddt-mese-sel" onchange="onDDTMeseChange(this.value)">${meseOpts}</select>
    <div style="display:flex;gap:6px;flex-wrap:wrap;">${chips}</div>`;
}

function onDDTMeseChange(val) {
  _ddtMese = val;
  _ddtFilter = null;
  const todayMs = new Date().setHours(0, 0, 0, 0);
  _renderDDTFiltri();
  _renderDDTTabella(todayMs);
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

  const base = _ddtMese
    ? _ddtRows.filter(r => r.data_ddt?.startsWith(_ddtMese))
    : _ddtRows;
  const rows = !_ddtFilter
    ? base
    : _ddtFilter === 'in_ritardo'
      ? base.filter(r => _isRitardo(r, todayMs))
      : base.filter(r => r.stato === _ddtFilter);
  countEl.textContent = rows.length;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="loading">Nessun DDT trovato</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(d => {
    let statoBadge;
    const isConsegnato = d.stato === 'consegnato' ||
      (d.stato_shippeo && d.stato_shippeo.toLowerCase() === 'deliverycompliant');
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
    _trkRegistry.set(d.numero_consegna, d);
    const _isFercam = d.corriere?.trim() === 'DACHSER & FERCAM ITALIA S.R.L.';
    let trkCell;
    if (_isFercam && (d.shippeo_url || d.fercam_url)) {
      trkCell = `<button class="trk-btn" onclick="openTrackingModal('${d.numero_consegna}')">Traccia →</button>`;
    } else if (d.shippeo_url) {
      trkCell = `<a class="shippeo-link" href="${d.shippeo_url}" target="_blank" rel="noopener">Traccia →</a>`;
    } else {
      trkCell = '—';
    }
    return `
    <tr>
      <td><strong>${d.numero_consegna || '—'}</strong></td>
      <td>${d.numero_ddt || '—'}</td>
      <td>${fmtDate(d.data_ddt)}</td>
      <td><span title="${d.codice_cliente || ''}">${nome}</span></td>
      <td>${ordineCell}</td>
      <td>${d.corriere || '—'}</td>
      <td>${statoBadge}</td>
      <td>${trkCell}</td>
    </tr>`;
  }).join('');
}

// ── Tracking Modal ──────────────────────────────────────────────

function openTrackingModal(numConsegna) {
  const d = _trkRegistry.get(numConsegna)
         || _ddtRows.find(r => r.numero_consegna === numConsegna);
  if (!d) return;

  const overlay = document.getElementById('trk-overlay');
  const box     = document.getElementById('trk-modal-box');
  const f       = d.fercam_dati || {};
  const eventi  = f.eventi || [];

  const todayMs    = new Date().setHours(0,0,0,0);
  const isConsegnato = d.stato === 'consegnato' ||
    (d.stato_shippeo && d.stato_shippeo.toLowerCase() === 'deliverycompliant');

  let statoHtml;
  if (isConsegnato) {
    const dt = d.data_consegna_effettiva ? ' · ' + fmtDate(d.data_consegna_effettiva) : '';
    statoHtml = `<span class="badge badge-green">✓ Consegnato${dt}</span>`;
  } else if (d.eta_shippeo) {
    const late = new Date(d.eta_shippeo).setHours(0,0,0,0) < todayMs;
    statoHtml = `<span class="eta-chip ${late ? 'eta-late' : 'eta-future'}">${late ? '⚠ Ritardo · ' : 'Arr. prev. '}${fmtDate(d.eta_shippeo)}</span>`;
  } else {
    statoHtml = `<span class="badge badge-gray">${d.stato || 'spedito'}</span>`;
  }

  const hasFercam   = d.fercam_url || f.numero_spedizione;
  const metaBits    = [
    f.colli     ? `<div class="trk-info-card"><div class="trk-info-val">${f.colli}</div><div class="trk-info-lbl">Colli</div></div>` : '',
    f.peso_kg   ? `<div class="trk-info-card"><div class="trk-info-val">${String(f.peso_kg.toFixed(2)).replace('.',',')} kg</div><div class="trk-info-lbl">Peso</div></div>` : '',
    f.volume_mc ? `<div class="trk-info-card"><div class="trk-info-val">${f.volume_mc} mc</div><div class="trk-info-lbl">Volume</div></div>` : '',
  ].filter(Boolean).join('');

  const eventiHtml = eventi.length
    ? `<div class="trk-section-title" style="padding-top:.5rem">Cronologia</div>
       <div class="trk-eventi">${eventi.map(e =>
         `<div class="trk-evento">
            <span class="trk-ev-data">${e.data}</span>
            <span class="trk-ev-ora">${e.ora}</span>
            <span class="trk-ev-desc">${e.descrizione}</span>
          </div>`).join('')}</div>`
    : `<div style="font-size:12px;color:var(--text2);padding:.4rem 0">Nessun evento disponibile — il prossimo sync aggiornerà i dati.</div>`;

  const fercamSection = hasFercam
    ? `<div class="trk-section-title">Merci${f.numero_spedizione ? ` · ${f.numero_spedizione}` : ''}</div>
       ${f.destinatario ? `<div style="font-size:13px;margin-bottom:.6rem"><span class="trk-meta-lbl">Destinatario</span><br>${f.destinatario}</div>` : ''}
       ${metaBits ? `<div class="trk-info-grid">${metaBits}</div>` : ''}
       ${f.note ? `<div class="trk-nota">⚠ ${f.note}</div>` : ''}
       ${eventiHtml}`
    : `<div style="font-size:12px;color:var(--text2);padding:.5rem 0">Dati Fercam non ancora disponibili — verranno caricati al prossimo sync.</div>`;

  box.innerHTML = `
    <div class="trk-hdr">
      <div style="display:flex;align-items:center;gap:8px">
        <h2>DDT ${d.numero_consegna || d.numero_ddt || '—'}</h2>
        ${d.corriere ? `<span class="trk-corriere-badge">${d.corriere}</span>` : ''}
      </div>
      <button class="pl-close" onclick="closeTrackingModal()">×</button>
    </div>
    <div class="trk-body">
      <div style="padding:.75rem 0 .6rem;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${statoHtml}
        ${d.numero_ordine ? `<span style="font-size:12px;color:var(--text2)">Ordine ${d.numero_ordine}</span>` : ''}
      </div>
      ${fercamSection}
    </div>
    <div class="trk-footer">
      ${d.fercam_url  ? `<a class="trk-ext-link" href="${d.fercam_url}"  target="_blank" rel="noopener">Fercam →</a>`  : ''}
      ${d.shippeo_url ? `<a class="trk-ext-link" href="${d.shippeo_url}" target="_blank" rel="noopener">Shippeo →</a>` : ''}
    </div>`;

  overlay.style.display = 'flex';
}

function closeTrackingModal() {
  document.getElementById('trk-overlay').style.display = 'none';
}
