let _ordiniDebounceTimer = null;
let _filtroStatoOrdine  = null;

function debounceOrdini() {
  clearTimeout(_ordiniDebounceTimer);
  _ordiniDebounceTimer = setTimeout(loadOrdini, 350);
}

function _initOrdiniDates() {
  const da = document.getElementById('filtro-da');
  const a  = document.getElementById('filtro-a');
  if (!da || !a) return;
  if (!da.value && !a.value) {
    const now = new Date();
    da.value = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    a.value  = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
  }
}

function setFiltroStatoOrdine(stato) {
  _filtroStatoOrdine = stato || null;
  document.querySelectorAll('.ord-stato-chip').forEach(c =>
    c.classList.toggle('on', c.dataset.stato === (stato || ''))
  );
  loadOrdini();
}

function resetFiltriOrdini() {
  const now = new Date();
  document.getElementById('filtro-da').value      = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  document.getElementById('filtro-a').value       = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
  document.getElementById('filtro-cliente').value  = '';
  const fp = document.getElementById('filtro-prodotto'); if (fp) fp.value = '';
  _filtroStatoOrdine = null;
  document.querySelectorAll('.ord-stato-chip').forEach(c => c.classList.toggle('on', c.dataset.stato === ''));
  loadOrdini();
}

function azzeraFiltriOrdini() {
  document.getElementById('filtro-da').value       = '';
  document.getElementById('filtro-a').value        = '';
  document.getElementById('filtro-cliente').value  = '';
  const fp = document.getElementById('filtro-prodotto'); if (fp) fp.value = '';
  _filtroStatoOrdine = null;
  document.querySelectorAll('.ord-stato-chip').forEach(c => c.classList.toggle('on', c.dataset.stato === ''));
  loadOrdini();
}

async function loadOrdini() {
  const tbody   = document.querySelector('#ordini-table tbody');
  const countEl = document.getElementById('ordini-count');
  tbody.innerHTML = '<tr><td colspan="8" class="loading">Caricamento…</td></tr>';

  const da       = document.getElementById('filtro-da')?.value;
  const a        = document.getElementById('filtro-a')?.value;
  const cliente  = document.getElementById('filtro-cliente')?.value?.trim();
  const prodotto = document.getElementById('filtro-prodotto')?.value?.trim();

  try {
    // Pre-query prodotto: trova i numero_ordine che contengono l'articolo cercato
    let ordiniNums = null;
    if (prodotto) {
      const { data: righe } = await sb.from('righe_ordine')
        .select('numero_ordine')
        .or(`codice_articolo.ilike.%${prodotto}%,descrizione_articolo.ilike.%${prodotto}%`);
      ordiniNums = [...new Set((righe || []).map(r => r.numero_ordine).filter(Boolean))];
      if (!ordiniNums.length) {
        countEl.textContent = 0;
        tbody.innerHTML = '<tr><td colspan="8" class="loading">Nessun ordine trovato</td></tr>';
        return;
      }
    }

    let q = sb.from('ordini')
      .select('id, numero_ordine, data_ordine, codice_cliente, destinazione_ragione_sociale, tipo_ordine, totale_ordine, stato')
      .order('data_ordine', { ascending: false });

    if (da)                 q = q.gte('data_ordine', da);
    if (a)                  q = q.lte('data_ordine', a);
    if (cliente)            q = q.or(`codice_cliente.ilike.%${cliente}%,destinazione_ragione_sociale.ilike.%${cliente}%,numero_ordine.ilike.%${cliente}%`);
    if (ordiniNums)         q = q.in('numero_ordine', ordiniNums);
    if (_filtroStatoOrdine) q = q.eq('stato', _filtroStatoOrdine);

    const { data, error } = await q;
    if (error) throw error;

    countEl.textContent = data?.length || 0;

    if (!data?.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="loading">Nessun ordine trovato</td></tr>';
      return;
    }

    // Fallback nome cliente per ordini senza destinazione_ragione_sociale
    const nullCodes = [...new Set((data).filter(o => !o.destinazione_ragione_sociale).map(o => o.codice_cliente).filter(Boolean))];
    let nomeFallback = {};
    if (nullCodes.length) {
      const { data: cli } = await sb.from('clienti').select('codice_cliente, ragione_sociale').in('codice_cliente', nullCodes);
      nomeFallback = Object.fromEntries((cli || []).map(c => [c.codice_cliente, c.ragione_sociale]));
    }

    tbody.innerHTML = data.map(o => `
      <tr class="ordine-row" onclick="toggleRighe('${o.id}','${o.numero_ordine}',this)">
        <td><button class="expand-btn" id="expand-${o.id}">▶</button></td>
        <td><strong>${o.numero_ordine || '—'}</strong></td>
        <td>${fmtDate(o.data_ordine)}</td>
        <td>${o.codice_cliente || '—'}</td>
        <td><span class="ord-cliente-link" onclick="event.stopPropagation();apriClienteDaDashboard('${o.codice_cliente||''}')">${o.destinazione_ragione_sociale || nomeFallback[o.codice_cliente] || '—'}</span></td>
        <td>${o.tipo_ordine || '—'}</td>
        <td class="num-right"><strong>€${fmt(o.totale_ordine)}</strong></td>
        <td>${statoBadgeOrdine(o.stato)}</td>
      </tr>
      <tr class="righe-row" id="righe-${o.id}">
        <td colspan="8"><div class="righe-inner" id="righe-inner-${o.id}"></div></td>
      </tr>`).join('');

  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="loading">Errore: ${err.message}</td></tr>`;
  }
}

async function toggleRighe(ordineId, numeroOrdine, triggerEl) {
  if (triggerEl.tagName === 'BUTTON') return;
  const righeRow  = document.getElementById('righe-' + ordineId);
  const expandBtn = document.getElementById('expand-' + ordineId);
  const isOpen    = righeRow.classList.contains('open');

  righeRow.classList.toggle('open', !isOpen);
  expandBtn.classList.toggle('open', !isOpen);
  if (isOpen) return;

  const inner = document.getElementById('righe-inner-' + ordineId);
  if (inner.dataset.loaded) return;

  inner.innerHTML = '<div class="loading" style="padding:12px 0">Caricamento righe…</div>';
  try {
    const [{ data, error }, { data: ddtRaw, error: ddtErr }] = await Promise.all([
      sb.from('righe_ordine')
        .select('codice_articolo, descrizione_articolo, quantita, unita_misura, prezzo_unitario, sconto1, sconto2, sconto3, prezzo_netto_pezzo, importo_eur, data_consegna_prevista')
        .eq('ordine_id', ordineId)
        .order('codice_articolo'),
      sb.from('ddt')
        .select('id, numero_ddt, numero_consegna, data_ddt, shippeo_url, corriere, eta_shippeo, stato, stato_shippeo, data_consegna_effettiva')
        .eq('numero_ordine', numeroOrdine)
        .order('numero_ddt'),
    ]);
    if (error) throw error;
    if (ddtErr) throw ddtErr;

    const now = new Date();
    const ddtList = ddtRaw || [];

    // Fetch righe_ddt separately to avoid PostgREST relationship issues
    let righeDdt = [];
    if (ddtList.length) {
      const ddtIds = ddtList.map(d => d.id);
      const { data: rd } = await sb.from('righe_ddt')
        .select('ddt_id, codice_articolo')
        .in('ddt_id', ddtIds);
      righeDdt = rd || [];
    }

    // Attach righe_ddt to each DDT
    const ddts = ddtList.map(d => ({
      ...d,
      righe_ddt: righeDdt.filter(r => r.ddt_id === d.id),
    }));

    // Calcola stato ordine a livello di singolo articolo
    const ordineSet = new Set(
      (data || []).map(r => (String(r.codice_articolo || '').replace(/^0+/, '') || String(r.codice_articolo))).filter(Boolean)
    );
    const speditiSet    = new Set();
    const consegnatiSet = new Set();
    for (const d of ddts) {
      for (const riga of (d.righe_ddt || [])) {
        const key = String(riga.codice_articolo || '').replace(/^0+/, '') || String(riga.codice_articolo);
        if (!key) continue;
        speditiSet.add(key);
        if (d.stato === 'consegnato') consegnatiSet.add(key);
      }
    }
    const tot        = ordineSet.size;
    const spediti    = [...ordineSet].filter(k => speditiSet.has(k)).length;
    const consegnati = [...ordineSet].filter(k => consegnatiSet.has(k)).length;

    let nuovoStato;
    if (tot > 0 && consegnati === tot)    nuovoStato = 'consegnato';
    else if (tot > 0 && spediti === tot)  nuovoStato = 'spedito';
    else if (spediti > 0)                 nuovoStato = 'parzialmente spedito';
    else                                  nuovoStato = 'confermato';

    // Aggiorna badge UI e Supabase se lo stato è cambiato
    const parentRow = document.getElementById('righe-' + ordineId)?.previousElementSibling;
    if (parentRow) {
      const badgeEl = parentRow.querySelector('.badge');
      if (badgeEl && badgeEl.textContent.trim() !== nuovoStato) {
        badgeEl.outerHTML = statoBadgeOrdine(nuovoStato);
        sb.from('ordini').update({ stato: nuovoStato }).eq('id', ordineId).then(() => {});
      }
    }

    // Mappa stato_shippeo raw → etichetta italiana
    const SHIPPEO_LABEL = {
      deliveryCompliant:      'Consegnato',
      deliveryLate:           'Consegnato in ritardo',
      deliveryAttemptFailed:  'Tentativo fallito',
      inTransit:              'In transito',
      loading:                'In carico',
      pickup:                 'Ritiro in corso',
      exception:              'Anomalia',
    };
    function corriereBreve(c) {
      if (!c) return '—';
      return c.replace(/\s+(S\.?R\.?L\.?|S\.?P\.?A\.?|S\.?A\.?S\.?)\.?\s*$/i, '').trim();
    }

    // Sezione spedizioni DDT
    const _noDdtHtml = (() => {
      const primaData = (data || []).filter(r => r.data_consegna_prevista).map(r => r.data_consegna_prevista).sort()[0];
      if (!primaData) return '';
      const noDdtLate = new Date(primaData).setHours(0,0,0,0) < now;
      return `<div class="spedizioni-bar"><div class="spedizione-chip"><div class="sped-meta"><strong class="sped-ddt" style="color:var(--text2);">Nessun DDT</strong></div><div class="sped-status"><span class="eta-chip ${noDdtLate ? 'eta-late' : 'eta-future'}">${noDdtLate ? '⚠ Ritardo · ' : 'Arrivo prev. '}${fmtDate(primaData)}</span></div></div></div>`;
    })();
    const spedizioniHTML = ddts.length ? `
      <div class="spedizioni-bar">
        ${ddts.map(d => {
          const isConsegnato = d.stato === 'consegnato';
          const eta  = d.eta_shippeo ? new Date(d.eta_shippeo) : null;
          const etaOk = eta && !isNaN(eta);
          const etaFutura = etaOk && eta > now;
          const statoLabel = SHIPPEO_LABEL[d.stato_shippeo] || null;

          let statusHTML;
          if (isConsegnato) {
            const quando = d.data_consegna_effettiva || d.eta_shippeo;
            statusHTML = `<span class="badge badge-green">✓ ${statoLabel || 'Consegnato'}${quando ? ' · ' + fmtDate(quando) : ''}</span>`;
          } else if (d.shippeo_url) {
            const etaLate = etaOk && !etaFutura;
            const etaChip = etaOk
              ? `<span class="eta-chip ${etaLate ? 'eta-late' : 'eta-future'}">${etaLate ? '⚠ Ritardo · ' : 'Arr. '}${fmtDate(d.eta_shippeo)}</span>`
              : '';
            const statoChip = statoLabel
              ? `<span class="badge badge-blue" style="font-size:11px;">${statoLabel}</span>`
              : '';
            statusHTML = `${statoChip}<a class="shippeo-link" href="${d.shippeo_url}" target="_blank" rel="noopener">Traccia →</a>${etaChip}`;
          } else {
            statusHTML = `<span class="badge badge-gray">${statoLabel || d.stato || 'in attesa'}</span>`;
          }

          return `<div class="spedizione-chip">
            <div class="sped-meta">
              <strong class="sped-ddt">DDT ${d.numero_ddt || d.numero_consegna || '—'}</strong>
              <span class="sped-corriere">${corriereBreve(d.corriere)}</span>
              ${d.data_ddt ? `<span class="sped-data">Spedito il ${fmtDate(d.data_ddt)}</span>` : ''}
            </div>
            <div class="sped-status">${statusHTML}</div>
          </div>`;
        }).join('')}
      </div>` : _noDdtHtml;

    // Mappa codice_articolo (senza zeri iniziali) → DDT con priorità a "consegnato"
    const articoloDDT = {};
    for (const ddt of ddts) {
      for (const riga of (ddt.righe_ddt || [])) {
        const key = String(riga.codice_articolo || '').replace(/^0+/, '') || String(riga.codice_articolo);
        if (!articoloDDT[key] || ddt.stato === 'consegnato') {
          articoloDDT[key] = ddt;
        }
      }
    }
    function getDDTArticolo(codice) {
      const key = String(codice || '').replace(/^0+/, '') || String(codice);
      return articoloDDT[key] || null;
    }

    if (!data?.length) {
      inner.innerHTML = spedizioniHTML + '<div class="loading" style="padding:12px 0">Nessuna riga trovata</div>';
      inner.dataset.loaded = '1';
      return;
    }

    const oggi = new Date(); oggi.setHours(0, 0, 0, 0);
    inner.innerHTML = spedizioniHTML + `
      <table class="righe-table">
        <thead><tr>
          <th>Codice</th><th>Descrizione</th>
          <th class="num-right">Qtà</th><th>U.M.</th>
          <th class="num-right">Listino</th><th>Sconto</th>
          <th class="num-right">Netto/pz</th><th class="num-right">Importo €</th>
          <th>Cons. prevista</th><th>Shippeo</th>
        </tr></thead>
        <tbody>${data.map(r => {
          const ddt = getDDTArticolo(r.codice_articolo);
          let rowCls = '';
          let shippeoCell = '<span style="color:var(--text2)">—</span>';

          let dataConsegna = r.data_consegna_prevista; // default: data da ordine

          if (ddt) {
            const eta = ddt.eta_shippeo ? new Date(ddt.eta_shippeo) : null;
            const etaOk = eta && !isNaN(eta);
            const statoLabel = SHIPPEO_LABEL[ddt.stato_shippeo] || null;

            if (ddt.stato === 'consegnato') {
              rowCls = 'riga-consegnata';
              const quando = ddt.data_consegna_effettiva || ddt.eta_shippeo;
              if (quando) dataConsegna = quando;
              shippeoCell = `<span class="badge badge-green">✓ ${statoLabel || 'Consegnato'}</span>`;
            } else if (ddt.shippeo_url || etaOk) {
              rowCls = 'riga-in-transito';
              if (etaOk) dataConsegna = ddt.eta_shippeo;
              const label = statoLabel || 'In transito';
              if (ddt.shippeo_url) {
                shippeoCell = `<a class="shippeo-link" href="${ddt.shippeo_url}" target="_blank" rel="noopener">${label} →</a>`;
              } else {
                shippeoCell = `<span class="badge badge-orange">${label}</span>`;
              }
            }
          }

          const sconti = [r.sconto1, r.sconto2, r.sconto3]
            .filter(s => s != null && Number(s) !== 0)
            .map(s => fmt(s) + '%')
            .join('+');
          const nettoCell = r.prezzo_netto_pezzo != null ? `€${fmt(r.prezzo_netto_pezzo)}` : '—';

          return `
          <tr class="${rowCls}">
            <td><strong>${r.codice_articolo || '—'}</strong></td>
            <td>${r.descrizione_articolo || '—'}</td>
            <td class="num-right">${r.quantita ?? '—'}</td>
            <td>${r.unita_misura || '—'}</td>
            <td class="num-right">€${fmt(r.prezzo_unitario)}</td>
            <td style="color:var(--text2);font-size:12px;">${sconti || '—'}</td>
            <td class="num-right">${nettoCell}</td>
            <td class="num-right"><strong>€${fmt(r.importo_eur)}</strong></td>
            <td style="${dataConsegna && rowCls !== 'riga-consegnata' && new Date(dataConsegna) < oggi ? 'color:#e53935;font-weight:600' : ''}">${fmtDate(dataConsegna)}</td>
            <td>${shippeoCell}</td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>`;
    inner.dataset.loaded = '1';
  } catch (err) {
    inner.innerHTML = `<div class="loading" style="padding:12px 0">Errore: ${err.message}</div>`;
  }
}
