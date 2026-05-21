let _ordiniDebounceTimer = null;

function debounceOrdini() {
  clearTimeout(_ordiniDebounceTimer);
  _ordiniDebounceTimer = setTimeout(loadOrdini, 350);
}

function resetFiltriOrdini() {
  document.getElementById('filtro-da').value = '';
  document.getElementById('filtro-a').value = '';
  document.getElementById('filtro-cliente').value = '';
  loadOrdini();
}

async function loadOrdini() {
  const tbody   = document.querySelector('#ordini-table tbody');
  const countEl = document.getElementById('ordini-count');
  tbody.innerHTML = '<tr><td colspan="8" class="loading">Caricamento…</td></tr>';

  const da      = document.getElementById('filtro-da')?.value;
  const a       = document.getElementById('filtro-a')?.value;
  const cliente = document.getElementById('filtro-cliente')?.value?.trim();

  try {
    let q = sb.from('ordini')
      .select('id, numero_ordine, data_ordine, codice_cliente, destinazione_ragione_sociale, tipo_ordine, totale_ordine, stato')
      .order('data_ordine', { ascending: false });

    if (da)      q = q.gte('data_ordine', da);
    if (a)       q = q.lte('data_ordine', a);
    if (cliente) q = q.or(`codice_cliente.ilike.%${cliente}%,destinazione_ragione_sociale.ilike.%${cliente}%`);

    const { data, error } = await q;
    if (error) throw error;

    countEl.textContent = data?.length || 0;

    if (!data?.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="loading">Nessun ordine trovato</td></tr>';
      return;
    }

    tbody.innerHTML = data.map(o => `
      <tr class="ordine-row" onclick="toggleRighe('${o.id}','${o.numero_ordine}',this)">
        <td><button class="expand-btn" id="expand-${o.id}">▶</button></td>
        <td><strong>${o.numero_ordine || '—'}</strong></td>
        <td>${fmtDate(o.data_ordine)}</td>
        <td>${o.codice_cliente || '—'}</td>
        <td>${o.destinazione_ragione_sociale || '—'}</td>
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
        .select('codice_articolo, descrizione_articolo, quantita, unita_misura, prezzo_unitario, importo_eur, data_consegna_prevista')
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
            const etaChip = etaOk
              ? `<span class="eta-chip ${etaFutura ? 'eta-future' : 'eta-past'}">ETA ${fmtDate(d.eta_shippeo)}</span>`
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
      </div>` : '';

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

    inner.innerHTML = spedizioniHTML + `
      <table class="righe-table">
        <thead><tr>
          <th>Codice</th><th>Descrizione</th>
          <th class="num-right">Qtà</th><th>U.M.</th>
          <th class="num-right">Prezzo unit.</th><th class="num-right">Importo €</th>
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
              // Se c'è l'ETA Shippeo, sovrascrive la data prevista dell'ordine
              if (etaOk) dataConsegna = ddt.eta_shippeo;
              const label = statoLabel || 'In transito';
              if (ddt.shippeo_url) {
                shippeoCell = `<a class="shippeo-link" href="${ddt.shippeo_url}" target="_blank" rel="noopener">${label} →</a>`;
              } else {
                shippeoCell = `<span class="badge badge-orange">${label}</span>`;
              }
            }
          }

          return `
          <tr class="${rowCls}">
            <td><strong>${r.codice_articolo || '—'}</strong></td>
            <td>${r.descrizione_articolo || '—'}</td>
            <td class="num-right">${r.quantita ?? '—'}</td>
            <td>${r.unita_misura || '—'}</td>
            <td class="num-right">€${fmt(r.prezzo_unitario)}</td>
            <td class="num-right"><strong>€${fmt(r.importo_eur)}</strong></td>
            <td>${fmtDate(dataConsegna)}</td>
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
