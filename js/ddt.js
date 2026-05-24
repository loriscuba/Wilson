async function loadDDT() {
  const tbody   = document.querySelector('#ddt-table tbody');
  const countEl = document.getElementById('ddt-count');
  tbody.innerHTML = '<tr><td colspan="8" class="loading">Caricamento…</td></tr>';

  try {
    const [{ data, error }, { data: clientiRaw }] = await Promise.all([
      sb.from('ddt')
        .select('numero_consegna, numero_ddt, data_ddt, codice_cliente, numero_ordine, corriere, stato, shippeo_url, eta_shippeo, data_consegna_effettiva')
        .order('data_ddt', { ascending: false }),
      sb.from('clienti').select('codice_cliente, ragione_sociale').eq('attivo', true),
    ]);
    if (error) throw error;

    const nomeCliente = Object.fromEntries((clientiRaw || []).map(c => [c.codice_cliente, c.ragione_sociale]));

    countEl.textContent = data?.length || 0;

    if (!data?.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="loading">Nessun DDT trovato</td></tr>';
      return;
    }

    tbody.innerHTML = data.map(d => {
      let statoBadge;
      if (d.stato === 'consegnato') {
        const dt = d.data_consegna_effettiva ? ' · ' + fmtDate(d.data_consegna_effettiva) : '';
        statoBadge = `<span class="badge badge-green">✓ Consegnato${dt}</span>`;
      } else if (d.eta_shippeo) {
        statoBadge = `<span class="eta-chip eta-future">Arr. prev. ${fmtDate(d.eta_shippeo)}</span>`;
      } else {
        statoBadge = statoBadgeOrdine(d.stato);
      }
      const nome = nomeCliente[d.codice_cliente] || d.codice_cliente || '—';
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
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="loading">Errore: ${err.message}</td></tr>`;
  }
}
