async function loadFatturato() {
  const tbody   = document.querySelector('#fatturato-table tbody');
  const countEl = document.getElementById('fatturato-count');
  tbody.innerHTML = '<tr><td colspan="9" class="loading">Caricamento…</td></tr>';

  try {
    const rows = await loadRollingEnriched();
    countEl.textContent = rows.length;

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="loading">Nessun dato disponibile</td></tr>';
      return;
    }

    const sorted = [...rows].sort((a, b) => (b.fatt_prog_anno_corr || 0) - (a.fatt_prog_anno_corr || 0));

    tbody.innerHTML = sorted.map(r => {
      const progPrec   = r.fatt_prog_anno_prec || 0;
      const progGap    = r.variazione_progressivo || 0;
      const varProgPct = progPrec > 0 ? (progGap / progPrec) * 100 : null;
      const mesePrec   = r.fatt_mese_anno_prec || 0;
      const meseGap    = r.variazione_mese || 0;
      const varMesePct = mesePrec > 0 ? (meseGap / mesePrec) * 100 : null;
      const stBadge    = `<span class="badge ${statoBadgeCls(r._stato.id)}">${r._stato.label}</span>`;
      return `
      <tr>
        <td><strong>${r.ragione_sociale || '—'}</strong></td>
        <td>${r.divisione || '—'}</td>
        <td>${stBadge}</td>
        <td class="num-right"><strong>€${fmt(r.fatt_prog_anno_corr)}</strong></td>
        <td class="num-right">€${fmt(r.fatt_prog_anno_prec)}</td>
        <td class="num-right">${variazioneBadge(varProgPct)}</td>
        <td class="num-right">€${fmt(r.spedito_ordinato_mese)}</td>
        <td class="num-right">${variazioneBadge(varMesePct)}</td>
        <td class="num-right">€${fmt(r.mese_consegnato)}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" class="loading">Errore: ${err.message}</td></tr>`;
  }
}
