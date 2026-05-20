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
    const [{ data, error }, { data: ddtData }] = await Promise.all([
      sb.from('righe_ordine')
        .select('codice_articolo, descrizione_articolo, quantita, unita_misura, prezzo_unitario, importo_eur, data_consegna_prevista')
        .eq('ordine_id', ordineId)
        .order('codice_articolo'),
      sb.from('ddt')
        .select('numero_ddt, numero_consegna, shippeo_url, corriere, eta_shippeo, stato, data_consegna_effettiva')
        .eq('numero_ordine', numeroOrdine)
        .order('numero_ddt'),
    ]);
    if (error) throw error;

    const now = new Date();
    const ddts = ddtData || [];

    // Inferisci stato effettivo ordine dai DDT e aggiorna il badge nella riga padre
    const tuttiConsegnati = ddts.length > 0 && ddts.every(d => d.stato === 'consegnato');
    const almenoSpedito   = ddts.some(d => d.stato === 'spedito' || d.stato === 'consegnato');
    if (tuttiConsegnati) {
      const badge = document.querySelector(`#righe-${ordineId}`
        + ` ~ tr .badge, tr[id="righe-${ordineId}"]`);
      const parentRow = document.getElementById('righe-' + ordineId)?.previousElementSibling;
      if (parentRow) {
        const badgeEl = parentRow.querySelector('.badge');
        if (badgeEl && badgeEl.textContent.trim() === 'confermato') {
          badgeEl.className = 'badge badge-green';
          badgeEl.textContent = 'consegnato';
        }
      }
    } else if (almenoSpedito) {
      const parentRow = document.getElementById('righe-' + ordineId)?.previousElementSibling;
      if (parentRow) {
        const badgeEl = parentRow.querySelector('.badge');
        if (badgeEl && badgeEl.textContent.trim() === 'confermato') {
          badgeEl.className = 'badge badge-blue';
          badgeEl.textContent = 'spedito';
        }
      }
    }

    // Sezione spedizioni DDT
    const spedizioniHTML = ddts.length ? `
      <div class="spedizioni-bar">
        ${ddts.map(d => {
          const isConsegnato = d.stato === 'consegnato';
          const eta = d.eta_shippeo ? new Date(d.eta_shippeo) : null;
          const etaStr = eta ? (eta < now
            ? `<span class="eta-label" style="color:var(--text2);">ETA ${fmtDate(d.eta_shippeo)}</span>`
            : `<span class="eta-label">Prev. ${fmtDate(d.eta_shippeo)}</span>`) : '';
          const consData = d.data_consegna_effettiva || (isConsegnato ? d.eta_shippeo : null);
          const trackHTML = isConsegnato
            ? `<span class="badge badge-green">Consegnato${consData ? ' ' + fmtDate(consData) : ''}</span>`
            : d.shippeo_url
              ? `<a class="shippeo-link" href="${d.shippeo_url}" target="_blank" rel="noopener">Traccia →</a>${etaStr}`
              : `<span class="badge badge-gray">${d.stato || 'in attesa'}</span>`;
          return `<span class="spedizione-chip">
            <strong>${d.numero_ddt || d.numero_consegna || '—'}</strong>
            ${d.corriere ? `<span style="color:var(--text2);">${d.corriere}</span>` : ''}
            ${trackHTML}
          </span>`;
        }).join('')}
      </div>` : '';

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
          <th>Cons. prevista</th>
        </tr></thead>
        <tbody>${data.map(r => `
          <tr>
            <td><strong>${r.codice_articolo || '—'}</strong></td>
            <td>${r.descrizione_articolo || '—'}</td>
            <td class="num-right">${r.quantita ?? '—'}</td>
            <td>${r.unita_misura || '—'}</td>
            <td class="num-right">€${fmt(r.prezzo_unitario)}</td>
            <td class="num-right"><strong>€${fmt(r.importo_eur)}</strong></td>
            <td>${fmtDate(r.data_consegna_prevista)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    inner.dataset.loaded = '1';
  } catch (err) {
    inner.innerHTML = `<div class="loading" style="padding:12px 0">Errore: ${err.message}</div>`;
  }
}
