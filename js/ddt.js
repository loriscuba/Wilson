async function loadDDT() {
  const tbody   = document.querySelector('#ddt-table tbody');
  const countEl = document.getElementById('ddt-count');
  tbody.innerHTML = '<tr><td colspan="8" class="loading">Caricamento…</td></tr>';

  try {
    const { data, error } = await sb.from('ddt')
      .select('numero_consegna, numero_ddt, data_ddt, codice_cliente, numero_ordine, corriere, stato, shippeo_url, eta_shippeo, data_consegna_effettiva')
      .order('data_ddt', { ascending: false });
    if (error) throw error;

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
      return `
      <tr>
        <td><strong>${d.numero_consegna || '—'}</strong></td>
        <td>${d.numero_ddt || '—'}</td>
        <td>${fmtDate(d.data_ddt)}</td>
        <td>${d.codice_cliente || '—'}</td>
        <td>${d.numero_ordine || '—'}</td>
        <td>${d.corriere || '—'}</td>
        <td>${statoBadge}</td>
        <td>${d.shippeo_url ? `<a class="shippeo-link" href="${d.shippeo_url}" target="_blank" rel="noopener">Traccia →</a>` : '—'}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="loading">Errore: ${err.message}</td></tr>`;
  }
}
