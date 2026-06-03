// ── Statistiche ───────────────────────────────────────────────────────────────

let _statChart      = null;
let _statClienti    = [];
let _currentStatId  = null;
let _currentStatTipo = null;

const TIPO_LABEL = {
  prezzo_prodotto:    'Prezzo prodotto nel tempo per cliente',
  fatturato_articolo: 'Fatturato articolo per anno',
  fatturato_cliente:  'Fatturato cliente mese per mese',
  prodotti_top:       'Prodotti più acquistati da un cliente',
  trend_ordini:       'Trend ordini per periodo',
};

// ── Entry point ───────────────────────────────────────────────────────────────

async function loadStatistiche() {
  await _renderStatList();
}

// ── Lista ─────────────────────────────────────────────────────────────────────

async function _renderStatList() {
  const wrap = document.getElementById('stat-list-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="loading">Caricamento statistiche…</div>';

  try {
    const { data, error } = await sb.from('statistiche_salvate')
      .select('*').order('created_at', { ascending: false });
    if (error) throw error;

    if (!data.length) {
      wrap.innerHTML = `
        <div class="placeholder">
          <div class="placeholder-icon">📈</div>
          <h3>Nessuna statistica salvata</h3>
          <p>Clicca "+ Nuova Statistica" per crearne una.</p>
        </div>`;
      return;
    }

    wrap.innerHTML = `
      <p class="b-sec" style="margin-top:0">statistiche salvate — ${data.length}</p>
      <div class="stat-card-grid">${data.map(_statCardHTML).join('')}</div>`;
  } catch (err) {
    wrap.innerHTML = `<p style="color:var(--red);padding:1rem">Errore: ${err.message}</p>`;
  }
}

function _statCardHTML(s) {
  const date = new Date(s.created_at).toLocaleDateString('it-IT',
    { day: '2-digit', month: '2-digit', year: 'numeric' });
  const params = s.parametri || {};
  const sub = [
    params.codice_cliente ? `Cliente: ${params.codice_cliente}` : '',
    params.codice_articolo ? `Art: ${params.codice_articolo}` : '',
    params.top_n ? `Top ${params.top_n}` : '',
  ].filter(Boolean).join(' · ');

  return `
    <div class="stat-card" onclick='_openStat(${JSON.stringify(s)})'>
      <div class="stat-card-body">
        <div class="stat-card-nome">${_esc(s.nome)}</div>
        <div class="stat-card-tipo">${TIPO_LABEL[s.tipo] || s.tipo}</div>
        ${sub ? `<div class="stat-card-date" style="margin-top:4px">${sub}</div>` : ''}
        <div class="stat-card-date">${date}</div>
      </div>
      <button class="stat-card-del" onclick="eliminaStat('${s.id}',event)" title="Elimina">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>
        </svg>
      </button>
    </div>`;
}

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Elimina ───────────────────────────────────────────────────────────────────

async function eliminaStat(id, event) {
  event.stopPropagation();
  if (!confirm('Eliminare questa statistica?')) return;
  const { error } = await sb.from('statistiche_salvate').delete().eq('id', id);
  if (error) { alert('Errore: ' + error.message); return; }
  if (_currentStatId === id) chiudiGrafico();
  await _renderStatList();
}

// ── Modal nuova statistica ────────────────────────────────────────────────────

async function openStatModal() {
  if (!_statClienti.length) {
    const { data } = await sb.from('clienti')
      .select('codice_cliente, ragione_sociale')
      .order('ragione_sociale').limit(500);
    _statClienti = data || [];
  }

  const overlay = document.getElementById('stat-modal-overlay');
  overlay.innerHTML = `
    <div class="stat-modal" onclick="event.stopPropagation()">
      <div class="stat-modal-header">
        <span class="stat-modal-title">Nuova Statistica</span>
        <button class="stat-modal-close" onclick="closeStatModal()">✕</button>
      </div>
      <div class="stat-modal-body">
        <div class="stat-field">
          <label class="stat-label">Nome</label>
          <input type="text" id="stat-nome" class="filter-input" style="width:100%"
            placeholder="Es. Prezzi FIS A · Cliente X">
        </div>
        <div class="stat-field">
          <label class="stat-label">Tipo di analisi</label>
          <select id="stat-tipo" class="filter-input" style="width:100%" onchange="onStatTipoChange()">
            <option value="">— seleziona —</option>
            <option value="prezzo_prodotto">Prezzo prodotto nel tempo per cliente</option>
            <option value="fatturato_articolo">Fatturato articolo per anno</option>
            <option value="fatturato_cliente">Fatturato cliente mese per mese</option>
            <option value="prodotti_top">Prodotti più acquistati da un cliente</option>
            <option value="trend_ordini">Trend ordini per periodo</option>
          </select>
        </div>
        <div id="stat-params"></div>
        <button class="btn-nuova-stat" onclick="salvaStatistica()" style="width:100%;justify-content:center;margin-top:6px">
          Salva e Visualizza
        </button>
      </div>
    </div>`;
  overlay.classList.add('open');
}

function closeStatModal() {
  document.getElementById('stat-modal-overlay').classList.remove('open');
}

function handleStatModalOverlay(event) {
  if (event.target.id === 'stat-modal-overlay') closeStatModal();
}

function onStatTipoChange() {
  const tipo = document.getElementById('stat-tipo').value;
  const clientiOpts = _statClienti.map(c =>
    `<option value="${_esc(c.codice_cliente)}">${_esc(c.ragione_sociale)} (${_esc(c.codice_cliente)})</option>`
  ).join('');

  const clienteField = `
    <div class="stat-field">
      <label class="stat-label">Cliente</label>
      <select id="stat-p-cliente" class="filter-input" style="width:100%">
        <option value="">— seleziona cliente —</option>${clientiOpts}
      </select>
    </div>`;

  const artField = `
    <div class="stat-field">
      <label class="stat-label">Codice o Descrizione Articolo</label>
      <input type="text" id="stat-p-articolo" class="filter-input" style="width:100%"
        placeholder="Es. 9285 o FIXATURA">
    </div>`;

  const html = {
    prezzo_prodotto: `${clienteField}${artField}`,
    fatturato_articolo: artField,
    fatturato_cliente: clienteField,
    prodotti_top: `${clienteField}
      <div class="stat-field">
        <label class="stat-label">Mostra top N prodotti</label>
        <select id="stat-p-topn" class="filter-input" style="width:100%">
          <option value="5">Top 5</option>
          <option value="10" selected>Top 10</option>
          <option value="20">Top 20</option>
        </select>
      </div>`,
    trend_ordini: '',
  }[tipo] || '';

  document.getElementById('stat-params').innerHTML = html;
}

// ── Salva ─────────────────────────────────────────────────────────────────────

async function salvaStatistica() {
  const nome = document.getElementById('stat-nome')?.value.trim();
  const tipo = document.getElementById('stat-tipo')?.value;
  if (!nome) { alert('Inserisci un nome per la statistica.'); return; }
  if (!tipo)  { alert('Seleziona un tipo di analisi.'); return; }

  const params = _raccogliParams(tipo);
  if (!params) return;

  const { data, error } = await sb.from('statistiche_salvate')
    .insert({ nome, tipo, parametri: params }).select().single();
  if (error) { alert('Errore salvataggio: ' + error.message); return; }

  closeStatModal();
  await _renderStatList();
  await _openStat(data);
}

function _raccogliParams(tipo) {
  const g = id => document.getElementById(id)?.value?.trim() || null;

  if (tipo === 'prezzo_prodotto') {
    const codice_cliente   = g('stat-p-cliente');
    const codice_articolo  = g('stat-p-articolo');
    if (!codice_cliente)  { alert('Seleziona un cliente.');      return null; }
    if (!codice_articolo) { alert('Inserisci il codice articolo.'); return null; }
    return { codice_cliente, codice_articolo };
  }
  if (tipo === 'fatturato_articolo') {
    const codice_articolo = g('stat-p-articolo');
    if (!codice_articolo) { alert('Inserisci il codice o la descrizione articolo.'); return null; }
    return { codice_articolo };
  }
  if (tipo === 'fatturato_cliente') {
    const codice_cliente = g('stat-p-cliente');
    if (!codice_cliente) { alert('Seleziona un cliente.'); return null; }
    return { codice_cliente };
  }
  if (tipo === 'prodotti_top') {
    const codice_cliente = g('stat-p-cliente');
    if (!codice_cliente) { alert('Seleziona un cliente.'); return null; }
    const top_n = parseInt(document.getElementById('stat-p-topn')?.value) || 10;
    return { codice_cliente, top_n };
  }
  if (tipo === 'trend_ordini') {
    return { data_inizio: g('stat-p-da'), data_fine: g('stat-p-a') };
  }
  return {};
}

// ── Visualizzazione ───────────────────────────────────────────────────────────

let _aggDebounce = null;

async function _openStat(stat) {
  _currentStatId   = stat.id;
  _currentStatTipo = stat.tipo;
  const wrap = document.getElementById('stat-chart-wrap');
  if (!wrap) return;

  // Carica clienti se non ancora disponibili
  if (!_statClienti.length) {
    const { data } = await sb.from('clienti')
      .select('codice_cliente, ragione_sociale').order('ragione_sociale').limit(500);
    _statClienti = data || [];
  }

  wrap.style.display = 'block';
  wrap.innerHTML = `
    <div class="table-wrapper" style="padding:18px 20px 16px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px">
        <div>
          <div style="font-family:'Syne',sans-serif;font-size:16px;font-weight:700">${_esc(stat.nome)}</div>
          <div style="font-size:12px;color:var(--text2);margin-top:2px">${TIPO_LABEL[stat.tipo] || stat.tipo}</div>
        </div>
        <button onclick="chiudiGrafico()"
          style="background:none;border:none;cursor:pointer;color:var(--text2);font-size:18px;line-height:1;padding:2px 6px;border-radius:6px;flex-shrink:0"
          title="Chiudi">✕</button>
      </div>
      ${_buildInlineParams(stat.tipo, stat.parametri || {})}
      <div id="stat-loading" class="loading" style="margin-top:14px">Caricamento dati…</div>
      <div id="stat-content" style="margin-top:14px"></div>
      <div id="stat-no-data" style="display:none" class="placeholder">
        <div class="placeholder-icon">📭</div>
        <h3>Nessun dato</h3>
        <p>Nessun risultato per i parametri selezionati.</p>
      </div>
    </div>`;

  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    await _disegnaGrafico(stat.tipo, stat.parametri || {});
  } catch (err) {
    const el = document.getElementById('stat-loading');
    if (el) el.innerHTML = `<span style="color:var(--red)">Errore: ${err.message}</span>`;
  }
}

function _buildInlineParams(tipo, params) {
  if (tipo === 'trend_ordini') return '';

  const clientiOpts = _statClienti.map(c => {
    const sel = c.codice_cliente === params.codice_cliente ? ' selected' : '';
    return `<option value="${_esc(c.codice_cliente)}"${sel}>${_esc(c.ragione_sociale)} (${_esc(c.codice_cliente)})</option>`;
  }).join('');

  const clienteSel = `
    <div style="display:flex;flex-direction:column;gap:3px;min-width:180px;flex:2">
      <label class="stat-label">Cliente</label>
      <select id="ip-cliente" class="filter-input" style="width:100%" onchange="aggiornaGraficoDa()">
        <option value="">— seleziona —</option>${clientiOpts}
      </select>
    </div>`;

  if (tipo === 'fatturato_articolo') return `
    <div style="display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;flex-direction:column;gap:3px;flex:1;min-width:160px">
        <label class="stat-label">Codice o Descrizione Articolo</label>
        <input type="text" id="ip-articolo" class="filter-input" style="width:100%"
          value="${_esc(params.codice_articolo || '')}" placeholder="Es. 9285 o FIXATURA"
          oninput="scheduleAggiornaGrafico()">
      </div>
    </div>`;

  if (tipo === 'prezzo_prodotto') return `
    <div style="display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;flex-direction:column;gap:3px;min-width:120px">
        <label class="stat-label">Cliente (nome o codice)</label>
        <input type="text" id="ip-cliente" class="filter-input" style="width:100%"
          value="${_esc(params.codice_cliente || '')}" placeholder="Es. 609790 o Rossi"
          oninput="scheduleAggiornaGrafico()">
      </div>
      <div style="display:flex;flex-direction:column;gap:3px;flex:1;min-width:160px">
        <label class="stat-label">Codice o Descrizione Articolo</label>
        <input type="text" id="ip-articolo" class="filter-input" style="width:100%"
          value="${_esc(params.codice_articolo || '')}" placeholder="Es. 9285 oppure FIS A"
          oninput="scheduleAggiornaGrafico()">
      </div>
    </div>`;

  if (tipo === 'fatturato_cliente') return `
    <div style="display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--border)">
      ${clienteSel}
    </div>`;

  if (tipo === 'prodotti_top') return `
    <div style="display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--border)">
      ${clienteSel}
      <div style="display:flex;flex-direction:column;gap:3px">
        <label class="stat-label">Top N</label>
        <select id="ip-topn" class="filter-input" onchange="aggiornaGraficoDa()">
          ${[5,10,20].map(n => `<option value="${n}"${n === (params.top_n||10) ? ' selected' : ''}>${n}</option>`).join('')}
        </select>
      </div>
    </div>`;

  return '';
}

function scheduleAggiornaGrafico() {
  clearTimeout(_aggDebounce);
  _aggDebounce = setTimeout(aggiornaGraficoDa, 600);
}

async function aggiornaGraficoDa() {
  if (!_currentStatId) return;

  // Leggi i parametri dai controlli inline
  const g = id => document.getElementById(id)?.value?.trim() || null;
  const params = {};
  if (document.getElementById('ip-cliente'))  params.codice_cliente  = g('ip-cliente');
  if (document.getElementById('ip-articolo')) params.codice_articolo = g('ip-articolo');
  if (document.getElementById('ip-topn'))     params.top_n = parseInt(g('ip-topn')) || 10;

  const tipo = _currentStatTipo;
  if (!tipo) return;

  // Salva i nuovi parametri su Supabase (fire & forget)
  sb.from('statistiche_salvate').update({ parametri: params })
    .eq('id', _currentStatId).then(() => {});

  // Resetta area grafico e ridisegna
  const loading = document.getElementById('stat-loading');
  const content = document.getElementById('stat-content');
  const noData  = document.getElementById('stat-no-data');
  if (loading) { loading.style.display = ''; loading.textContent = 'Caricamento dati…'; }
  if (content) content.innerHTML = '';
  if (noData)  noData.style.display = 'none';
  if (_statChart) { _statChart.destroy(); _statChart = null; }

  try {
    await _disegnaGrafico(tipo, params);
  } catch (err) {
    if (loading) loading.innerHTML = `<span style="color:var(--red)">Errore: ${err.message}</span>`;
  }
}

function chiudiGrafico() {
  const wrap = document.getElementById('stat-chart-wrap');
  if (wrap) wrap.style.display = 'none';
  if (_statChart) { _statChart.destroy(); _statChart = null; }
  _currentStatId = null;
}

// ── Grafico ───────────────────────────────────────────────────────────────────

async function _disegnaGrafico(tipo, params) {
  if (_statChart) { _statChart.destroy(); _statChart = null; }

  const loading = document.getElementById('stat-loading');
  const content = document.getElementById('stat-content');
  const noData  = document.getElementById('stat-no-data');
  if (!loading || !content) return;

  // ── Prezzo prodotto: tabella ──────────────────────────────────────────────
  if (tipo === 'prezzo_prodotto') {
    const termArt = (params.codice_articolo || '').trim();
    const termCli = (params.codice_cliente  || '').trim();

    if (!termArt) { loading.style.display = 'none'; noData.style.display = ''; return; }

    // Risolvi il termine cliente (nome o codice) → lista codici
    let codiciCliente = [];
    if (termCli) {
      const { data: cli } = await sb.from('clienti').select('codice_cliente')
        .or(`codice_cliente.ilike.%${termCli}%,ragione_sociale.ilike.%${termCli}%`);
      codiciCliente = (cli || []).map(c => c.codice_cliente);
      if (!codiciCliente.length) { loading.style.display = 'none'; noData.style.display = ''; return; }
    }

    let q = sb.from('righe_ordine')
      .select('prezzo_unitario, prezzo_netto_pezzo, sconto1, sconto2, sconto3, quantita, codice_articolo, descrizione_articolo, ordini!inner(data_ordine, numero_ordine, codice_cliente)')
      .or(`codice_articolo.ilike.%${termArt}%,descrizione_articolo.ilike.%${termArt}%`)
      .order('data_ordine', { referencedTable: 'ordini', ascending: false });

    if (codiciCliente.length === 1) {
      q = q.eq('ordini.codice_cliente', codiciCliente[0]);
    } else if (codiciCliente.length > 1) {
      q = q.filter('ordini.codice_cliente', 'in', `(${codiciCliente.join(',')})`);
    }

    const { data, error } = await q;
    if (error) throw error;

    // Risolvi codice_cliente → ragione_sociale per tutti i risultati
    const uniqueCodes = [...new Set((data || []).map(r => r.ordini?.codice_cliente).filter(Boolean))];
    let nomeCliente = {};
    if (uniqueCodes.length) {
      const { data: cli } = await sb.from('clienti').select('codice_cliente, ragione_sociale').in('codice_cliente', uniqueCodes);
      nomeCliente = Object.fromEntries((cli || []).map(c => [c.codice_cliente, c.ragione_sociale]));
    }

    const rows = (data || [])
      .map(r => ({
        date:   r.ordini?.data_ordine    || '',
        ordine: r.ordini?.numero_ordine  || '—',
        codcli: r.ordini?.codice_cliente || '',
        nome:   nomeCliente[r.ordini?.codice_cliente] || r.ordini?.codice_cliente || '—',
        listino: parseFloat(r.prezzo_unitario)    || 0,
        netto:   parseFloat(r.prezzo_netto_pezzo) || 0,
        s1:      parseFloat(r.sconto1) || 0,
        s2:      parseFloat(r.sconto2) || 0,
        s3:      parseFloat(r.sconto3) || 0,
        qty:     parseFloat(r.quantita) || 0,
        desc:    r.descrizione_articolo || r.codice_articolo || '',
      }))
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    loading.style.display = 'none';
    if (!rows.length) { noData.style.display = ''; return; }

    const tbody = rows.map(r => {
      const sconti = [r.s1, r.s2, r.s3]
        .filter(s => s > 0)
        .map(s => s % 1 === 0 ? s + '%' : s.toFixed(2) + '%')
        .join(' + ') || '—';
      const eur = n => '€ ' + n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return `<tr>
        <td>${_fmtDataBreve(r.date)}</td>
        <td><button class="btn-ordini" onclick="apriOrdine('${_esc(r.ordine)}')">${_esc(r.ordine)}</button></td>
        <td style="font-size:.85em">${_esc(r.nome)}</td>
        <td style="color:var(--text2);font-size:.85em">${_esc(r.desc)}</td>
        <td class="num-right" style="color:var(--text2)">${eur(r.listino)}</td>
        <td class="num-right">${sconti}</td>
        <td class="num-right"><strong>${eur(r.netto)}</strong></td>
        <td class="num-right" style="color:var(--text2)">${r.qty % 1 === 0 ? r.qty : r.qty.toFixed(2)}</td>
      </tr>`;
    }).join('');

    content.innerHTML = `
      <div class="table-scroll" style="margin-top:4px">
        <table class="righe-table stat-prezzo-table" style="width:100%">
          <thead><tr>
            <th>Data</th>
            <th>N° Ordine</th>
            <th>Cliente</th>
            <th>Articolo</th>
            <th class="num-right">Listino</th>
            <th class="num-right">Sconti</th>
            <th class="num-right">Prezzo Netto</th>
            <th class="num-right">Q.tà</th>
          </tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>`;

    // Confronto con griglia FL
    await _appendListinoGriglia(content, termArt);
    return;
  }

  // ── Fatturato articolo per anno ───────────────────────────────────────────
  if (tipo === 'fatturato_articolo') {
    const termArt = (params.codice_articolo || '').trim();
    if (!termArt) { loading.style.display = 'none'; noData.style.display = ''; return; }

    const { data, error } = await sb.from('righe_ordine')
      .select('quantita, importo_eur, ordini!inner(data_ordine)')
      .or(`codice_articolo.ilike.%${termArt}%,descrizione_articolo.ilike.%${termArt}%`);
    if (error) throw error;

    const ANNI = ['2023', '2024', '2025', '2026'];
    const byYear = {};
    ANNI.forEach(a => { byYear[a] = { importo: 0, qty: 0, righe: 0 }; });
    for (const r of (data || [])) {
      const yr = (r.ordini?.data_ordine || '').slice(0, 4);
      if (!byYear[yr]) continue;
      byYear[yr].importo += parseFloat(r.importo_eur) || 0;
      byYear[yr].qty     += parseFloat(r.quantita)    || 0;
      byYear[yr].righe   += 1;
    }

    loading.style.display = 'none';
    if (!(data || []).length) { noData.style.display = ''; return; }

    // Grafico a barre
    const canvas = document.createElement('canvas');
    canvas.style.maxHeight = '260px';
    content.appendChild(canvas);
    _statChart = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: ANNI,
        datasets: [{
          label: 'Fatturato (€)',
          data: ANNI.map(a => byYear[a].importo),
          backgroundColor: '#1A56DBCC', borderColor: '#1A56DB', borderWidth: 1, borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => ' € ' + ctx.parsed.y.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) } },
        },
        scales: {
          x: { grid: { color: '#E5E2DA' }, ticks: { font: { family: 'DM Sans', size: 12 } } },
          y: { grid: { color: '#E5E2DA' }, ticks: { font: { family: 'DM Sans', size: 11 }, callback: v => '€ ' + v.toLocaleString('it-IT') } },
        },
      },
    });

    // Tabella riepilogo
    const eur = n => '€ ' + n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const tbody = ANNI.map(a => {
      const d = byYear[a];
      const prezzoMedio = d.qty > 0 ? d.importo / d.qty : 0;
      const qFmt = n => n % 1 === 0 ? n.toLocaleString('it-IT') : n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return `<tr>
        <td><strong>${a}</strong></td>
        <td class="num-right">${d.righe || '—'}</td>
        <td class="num-right">${d.qty ? qFmt(d.qty) : '—'}</td>
        <td class="num-right"><strong>${d.importo ? eur(d.importo) : '—'}</strong></td>
        <td class="num-right" style="color:var(--text2)">${prezzoMedio ? eur(prezzoMedio) : '—'}</td>
      </tr>`;
    }).join('');

    const tableEl = document.createElement('div');
    tableEl.innerHTML = `
      <div class="table-scroll" style="margin-top:16px">
        <table class="righe-table stat-anno-table" style="width:100%">
          <thead><tr>
            <th>Anno</th>
            <th class="num-right">N° Righe</th>
            <th class="num-right">Q.tà</th>
            <th class="num-right">Fatturato</th>
            <th class="num-right">Prezzo medio/pz</th>
          </tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>`;
    content.appendChild(tableEl);

    // Confronto con griglia FL
    await _appendListinoGriglia(content, termArt);
    return;
  }

  // ── Grafici per gli altri tipi ────────────────────────────────────────────
  let labels = [], datasets = [], indexAxis = 'x';

  if (tipo === 'fatturato_cliente') {
    const { data, error } = await sb.from('ordini')
      .select('data_ordine, totale_ordine')
      .eq('codice_cliente', params.codice_cliente)
      .order('data_ordine', { ascending: true });
    if (error) throw error;

    const byMonth = {};
    for (const o of (data || [])) {
      const m = (o.data_ordine || '').slice(0, 7);
      if (!m) continue;
      byMonth[m] = (byMonth[m] || 0) + (parseFloat(o.totale_ordine) || 0);
    }
    const sorted = Object.entries(byMonth).sort();
    labels   = sorted.map(([m]) => _fmtMese(m));
    datasets = [{ label: 'Fatturato (€)', data: sorted.map(([, v]) => v),
      backgroundColor: '#1A56DBCC', borderColor: '#1A56DB', borderWidth: 1, borderRadius: 4 }];
  }

  else if (tipo === 'prodotti_top') {
    const { data, error } = await sb.from('righe_ordine')
      .select('codice_articolo, descrizione_articolo, quantita, importo_eur, ordini!inner(codice_cliente)')
      .eq('ordini.codice_cliente', params.codice_cliente);
    if (error) throw error;

    const byArt = {};
    for (const r of (data || [])) {
      const k = r.codice_articolo;
      if (!byArt[k]) byArt[k] = { desc: r.descrizione_articolo || k, qty: 0, eur: 0 };
      byArt[k].qty += parseFloat(r.quantita)    || 0;
      byArt[k].eur += parseFloat(r.importo_eur) || 0;
    }
    const rows2 = Object.values(byArt).sort((a, b) => b.eur - a.eur).slice(0, params.top_n || 10);
    indexAxis = 'y';
    labels    = rows2.map(r => r.desc.length > 35 ? r.desc.slice(0, 35) + '…' : r.desc);
    datasets  = [{ label: 'Importo (€)', data: rows2.map(r => r.eur),
      backgroundColor: '#2D7D4FCC', borderColor: '#2D7D4F', borderWidth: 1, borderRadius: 4 }];
  }

  else if (tipo === 'trend_ordini') {
    const { data, error } = await sb.from('ordini')
      .select('data_ordine, totale_ordine')
      .order('data_ordine', { ascending: true });
    if (error) throw error;

    const byMonth = {};
    for (const o of (data || [])) {
      const m = (o.data_ordine || '').slice(0, 7);
      if (!m) continue;
      byMonth[m] = (byMonth[m] || 0) + (parseFloat(o.totale_ordine) || 0);
    }
    const sorted = Object.entries(byMonth).sort();
    labels   = sorted.map(([m]) => _fmtMese(m));
    datasets = [{ label: 'Fatturato (€)', data: sorted.map(([, v]) => v),
      borderColor: '#1A56DB', backgroundColor: '#1A56DB18',
      tension: .3, pointRadius: 4, fill: true }];
  }

  const hasData = labels.length > 0;
  loading.style.display = 'none';
  noData.style.display  = hasData ? 'none' : '';
  if (!hasData) return;

  const canvas = document.createElement('canvas');
  canvas.style.maxHeight = '360px';
  content.appendChild(canvas);

  const isLine = tipo === 'trend_ordini';
  _statChart = new Chart(canvas.getContext('2d'), {
    type: isLine ? 'line' : 'bar',
    data: { labels, datasets },
    options: {
      indexAxis,
      responsive: true,
      plugins: {
        legend: { display: false, labels: { font: { family: 'DM Sans' }, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = indexAxis === 'y' ? ctx.parsed.x : ctx.parsed.y;
              return ' ' + ctx.dataset.label + ': ' +
                (v != null ? '€ ' + v.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');
            },
          },
        },
      },
      scales: {
        x: { grid: { color: '#E5E2DA' }, ticks: { font: { family: 'DM Sans', size: 11 } } },
        y: { grid: { color: '#E5E2DA' }, ticks: { font: { family: 'DM Sans', size: 11 } } },
      },
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function apriOrdine(numeroOrdine) {
  navToPage('ordini');
  const input = document.getElementById('filtro-cliente');
  const daEl  = document.getElementById('filtro-da');
  const aEl   = document.getElementById('filtro-a');
  if (daEl) daEl.value = '2020-01-01';
  if (aEl)  aEl.value  = new Date().toISOString().split('T')[0];
  if (input) { input.value = numeroOrdine; loadOrdini(); }
}

function _fmtDataBreve(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function _fmtMese(m) {
  if (!m) return '';
  const [y, mo] = m.split('-');
  const nomi = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
  return (nomi[parseInt(mo) - 1] || mo) + ' ' + y.slice(2);
}

// ── Griglia prezzi FL inline ──────────────────────────────────────────────────

async function _appendListinoGriglia(container, termArt) {
  if (!termArt) return;

  // Query listino_fl per codice o descrizione
  const { data, error } = await sb.from('listino_fl')
    .select('codice_articolo, descrizione, categoria, unita_misura, prezzo_lordo, prezzi_netti, fuori_listino, edizione, data_listino')
    .or(`codice_articolo.ilike.%${termArt}%,descrizione.ilike.%${termArt}%`)
    .order('data_listino', { ascending: false })
    .order('descrizione');

  if (error || !data?.length) return;

  // Raggruppa per edizione e mostra solo la più recente per ogni codice
  const latestEdiz = data[0].edizione;
  const edizLabel  = latestEdiz ? `Ed. ${latestEdiz}` : '';
  const rows       = data.filter(r => r.edizione === latestEdiz);

  const eur = n => n != null ? '€ ' + Number(n).toFixed(2).replace('.', ',') : '—';

  const tbody = rows.map(r => {
    const prezzi = (r.prezzi_netti || []);
    const prezziHtml = prezzi.length
      ? prezzi.map((p, i) => {
          const color = i === 0 ? '#378ADD' : i === prezzi.length - 1 ? '#2D7D4F' : '#6B5552';
          return `<span style="display:inline-block;margin:1px 3px 1px 0;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:500;background:${color}18;color:${color};border:1px solid ${color}30">€ ${Number(p).toFixed(2).replace('.', ',')}</span>`;
        }).join('')
      : '<span style="color:var(--text2);font-size:11px">—</span>';

    const flBadge = r.fuori_listino ? '<span style="font-size:10px;color:#C84B2F;margin-left:3px">FL</span>' : '';
    return `<tr>
      <td><strong>${_esc(r.codice_articolo || '—')}</strong></td>
      <td style="font-size:12px">${_esc(r.descrizione || '—')}${flBadge}</td>
      <td style="text-align:center;color:var(--text2);font-size:11px">${_esc(r.unita_misura || '—')}</td>
      <td style="text-align:right;color:var(--text2);font-size:12px">${eur(r.prezzo_lordo)}</td>
      <td>${prezziHtml}</td>
    </tr>`;
  }).join('');

  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-top:20px;padding-top:16px;border-top:1px solid var(--border)';
  wrap.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text2)">Griglia Prezzi FL</span>
      <span style="font-size:11px;color:var(--text2);background:var(--bg);padding:2px 8px;border-radius:10px;border:1px solid var(--border)">${_esc(edizLabel)}</span>
      <span style="font-size:11px;color:var(--text2)">${rows.length} prodott${rows.length === 1 ? 'o' : 'i'}</span>
    </div>
    <div style="overflow-x:auto">
      <table class="righe-table" style="width:100%;font-size:12px">
        <thead><tr>
          <th style="width:90px">Codice</th>
          <th>Descrizione</th>
          <th style="text-align:center;width:40px">UM</th>
          <th style="text-align:right;width:80px">Listino</th>
          <th>Prezzi netti</th>
        </tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;
  container.appendChild(wrap);
}
