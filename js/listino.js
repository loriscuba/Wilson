// ── Listino FL ────────────────────────────────────────────────────────────────

let _listinoRows     = [];
let _listinoQuery    = '';
let _listinoCateg    = null;
let _listinoEdiz     = null;
let _listinoDebTimer = null;

async function loadListino() {
  const root = document.getElementById('listino-root');
  if (!root) return;
  root.innerHTML = '<div class="loading">Caricamento listino…</div>';

  try {
    // Legge tutte le edizioni disponibili e i prodotti dell'ultima
    const { data: edizioni, error: edzErr } = await sb.from('listino_fl')
      .select('edizione, data_listino')
      .order('data_listino', { ascending: false })
      .limit(10);

    if (edzErr) throw edzErr;
    if (!edizioni?.length) {
      root.innerHTML = '<p style="color:var(--text2);padding:1rem">Nessun listino importato.<br>Importa il PDF con <code>python parse_listino.py &lt;file.pdf&gt;</code></p>';
      return;
    }

    const edizioniUnique = [...new Map(edizioni.map(e => [e.edizione, e])).values()];
    _listinoEdiz = _listinoEdiz || edizioniUnique[0].edizione;

    const { data, error } = await sb.from('listino_fl')
      .select('codice_articolo, descrizione, categoria, unita_misura, acquisto_minimo, prezzo_lordo, prezzi_netti, fuori_listino')
      .eq('edizione', _listinoEdiz)
      .order('categoria')
      .order('descrizione');
    if (error) throw error;

    _listinoRows   = data || [];
    _listinoQuery  = '';
    _listinoCateg  = null;

    _renderListino(root, edizioniUnique);
  } catch (err) {
    root.innerHTML = `<p style="color:var(--red);padding:1rem">Errore: ${err.message}</p>`;
  }
}

function _renderListino(root, edizioniUnique) {
  const categorie = [...new Set(_listinoRows.map(r => r.categoria).filter(Boolean))].sort();

  const edizSelect = edizioniUnique.length > 1
    ? `<select id="listino-ediz-sel" onchange="switchListinoEdiz(this.value)" style="font-size:13px;padding:4px 8px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);color:var(--text)">
        ${edizioniUnique.map(e => `<option value="${e.edizione}" ${e.edizione === _listinoEdiz ? 'selected' : ''}>Ed. ${e.edizione}</option>`).join('')}
       </select>`
    : `<span style="font-size:12px;color:var(--text2)">Ed. ${_listinoEdiz}</span>`;

  const chipHtml = [
    { id: null,  label: `Tutti (${_listinoRows.length})` },
    ...categorie.map(c => ({
      id: c,
      label: `${_shortCat(c)} (${_listinoRows.filter(r => r.categoria === c).length})`
    }))
  ].map(c => {
    const on = (_listinoCateg === c.id) ? 'on' : '';
    return `<button class="ddt-chip ${on}" onclick="setListinoCateg(${c.id ? `'${c.id.replace(/'/g,"\\'")}` : 'null'}')">${c.label}</button>`;
  }).join('');

  root.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <input type="text" id="listino-srch" placeholder="cerca codice o descrizione…"
        value="${_listinoQuery}"
        oninput="onListinoSearch(this.value)"
        style="flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--border);border-radius:var(--r);font-size:14px;background:var(--surface);color:var(--text)">
      ${edizSelect}
    </div>
    <div class="ddt-filter-bar" id="listino-chips" style="margin-bottom:12px">${chipHtml}</div>
    <div id="listino-table-wrap" style="overflow-x:auto">
      <table class="b-tbl" id="listino-table" style="min-width:600px">
        <thead>
          <tr>
            <th style="width:90px">Codice</th>
            <th>Descrizione</th>
            <th style="width:80px">Categoria</th>
            <th style="width:40px;text-align:center">UM</th>
            <th style="width:80px;text-align:right">Listino</th>
            <th>Prezzi netti</th>
          </tr>
        </thead>
        <tbody id="listino-tbody"></tbody>
      </table>
    </div>`;

  _renderListinoRows();
}

function _shortCat(cat) {
  const MAP = {
    'Ancoranti chimici in cartuccia': 'Ancoranti CZ',
    'Ancoranti chimici in box':       'Ancoranti BOX',
    'FIS-HK Accessori certificati':   'FIS-HK',
    'Barre filettate da metro':        'Barre filt.',
    'Schiume poliuretaniche':          'Schiume PU',
    'Sigillanti e adesivi':            'Sigillanti',
    'Fissaggi universali in CZ industriale - tasselli in nylon con o senza vite': 'Fissaggi CZ',
    'Tasselli a percussione N':        'Tasselli N',
    'Fissaggi per serramenti':         'Serramenti',
    'Fissaggi per ponteggi':           'Ponteggi',
    'Viti PowerFast II CTP':           'PowerFast CTP',
    'Viti per cartongesso':            'Cartongesso',
  };
  return MAP[cat] || cat.slice(0, 18);
}

function _renderListinoRows() {
  const tbody = document.getElementById('listino-tbody');
  if (!tbody) return;

  const q   = _listinoQuery.toLowerCase().trim();
  const cat = _listinoCateg;

  const visible = _listinoRows.filter(r => {
    if (cat && r.categoria !== cat) return false;
    if (q) return (
      r.codice_articolo?.toLowerCase().includes(q) ||
      r.descrizione?.toLowerCase().includes(q)
    );
    return true;
  });

  const countEl = document.getElementById('listino-count');
  if (countEl) countEl.textContent = visible.length;

  if (!visible.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="loading">Nessun prodotto trovato</td></tr>';
    return;
  }

  tbody.innerHTML = visible.map(r => {
    const lordo = r.prezzo_lordo != null ? `€ ${Number(r.prezzo_lordo).toFixed(2).replace('.', ',')}` : '—';
    const prezzi = (r.prezzi_netti || []);
    let prezziHtml = '—';
    if (prezzi.length) {
      prezziHtml = prezzi.map((p, i) => {
        const color = i === 0 ? '#378ADD' : i === prezzi.length - 1 ? '#2D7D4F' : '#6B5552';
        return `<span style="display:inline-block;margin:1px 3px 1px 0;padding:2px 7px;border-radius:10px;font-size:12px;font-weight:500;background:${color}18;color:${color};border:1px solid ${color}30">€ ${Number(p).toFixed(2).replace('.', ',')}</span>`;
      }).join('');
    }
    const flBadge = r.fuori_listino ? '<span style="font-size:10px;color:#C84B2F;margin-left:4px">FL</span>' : '';
    return `<tr>
      <td><strong>${r.codice_articolo || '—'}</strong></td>
      <td>${r.descrizione || '—'}${flBadge}</td>
      <td style="font-size:11px;color:var(--text2)">${_shortCat(r.categoria || '')}</td>
      <td style="text-align:center;color:var(--text2);font-size:12px">${r.unita_misura || '—'}</td>
      <td style="text-align:right;color:var(--text2)">${lordo}</td>
      <td>${prezziHtml}</td>
    </tr>`;
  }).join('');
}

function onListinoSearch(q) {
  _listinoQuery = q;
  clearTimeout(_listinoDebTimer);
  _listinoDebTimer = setTimeout(_renderListinoRows, 200);
}

function setListinoCateg(cat) {
  _listinoCateg = cat;
  document.querySelectorAll('#listino-chips .ddt-chip').forEach(c => {
    const val = c.getAttribute('onclick').includes('null') ? null : c.textContent.split(' (')[0];
    c.classList.toggle('on', cat === null ? c.getAttribute('onclick').includes('null') : c.textContent.startsWith(_shortCat(cat)));
  });
  // Re-render chips cleanly via full re-render
  const root = document.getElementById('listino-root');
  const edizioniUnique = null; // chips re-render only
  _renderListinoRows();
  // Update chip active state
  document.querySelectorAll('#listino-chips .ddt-chip').forEach(c => {
    const onclick = c.getAttribute('onclick') || '';
    const chipCat = onclick.includes('null') ? null : onclick.match(/'(.+?)'\)/)?.[1] || null;
    c.classList.toggle('on', chipCat === cat);
  });
}

function switchListinoEdiz(ediz) {
  _listinoEdiz = ediz;
  _listinoRows = [];
  loadListino();
}
