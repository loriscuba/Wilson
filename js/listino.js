// ── Griglie Netti (prezzi netti a quantità / Fuori Listino) ──────────────────

let _listinoRows     = [];
let _listinoEdizioni = [];
let _listinoQuery    = '';
let _listinoCateg    = null;   // sezione selezionata (null = tutte)
let _listinoEdiz     = null;
let _listinoSoloFL   = false;
let _listinoCollapsed = new Set();
let _listinoDebTimer = null;

async function loadListino() {
  const root = document.getElementById('listino-root');
  if (!root) return;
  root.innerHTML = '<div class="loading">Caricamento griglie…</div>';

  try {
    const { data: edizioni, error: edzErr } = await sb.from('listino_fl')
      .select('edizione, data_listino')
      .order('data_listino', { ascending: false })
      .limit(1000);
    if (edzErr) throw edzErr;
    if (!edizioni?.length) {
      root.innerHTML = '<p style="color:var(--text2);padding:1rem">Nessuna griglia importata.<br>Carica il PDF "Griglie_FL_listino…" nella cartella Drive oppure lancia <code>python parse_listino.py &lt;file.pdf&gt;</code></p>';
      return;
    }

    _listinoEdizioni = [...new Map(edizioni.map(e => [e.edizione, e])).values()];
    _listinoEdiz = _listinoEdiz || _listinoEdizioni[0].edizione;

    // select('*'): funziona anche se la migration 007 non è ancora stata applicata
    const { data, error } = await sb.from('listino_fl')
      .select('*')
      .eq('edizione', _listinoEdiz)
      .limit(5000);
    if (error) throw error;

    _listinoRows = (data || []).sort((a, b) =>
      (a.ordine ?? 1e9) - (b.ordine ?? 1e9) ||
      (a.categoria || '').localeCompare(b.categoria || '') ||
      (a.descrizione || '').localeCompare(b.descrizione || ''));

    _renderListino(root);
  } catch (err) {
    root.innerHTML = `<p style="color:var(--red);padding:1rem">Errore: ${_lEsc(err.message)}</p>`;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _lEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const _lEur = n => n != null ? '€ ' + Number(n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';

// Scaglioni di un articolo; fallback per edizioni importate col vecchio parser
function _lScaglioni(r) {
  if (Array.isArray(r.scaglioni) && r.scaglioni.length) return r.scaglioni;
  return (r.prezzi_netti || []).map((v, i) => ({ label: `Netto ${i + 1}`, tipo: 'netto', valore: v }));
}

// Colonne della griglia di una sezione, nell'ordine in cui compaiono
function _lColonne(rows) {
  const isQtySconto = s => s.tipo === 'sconto' && /^\d/.test(s.label || '');
  const cols = [];
  for (const r of rows)
    for (const s of _lScaglioni(r))
      if (!isQtySconto(s) && !cols.includes(s.label)) cols.push(s.label);

  // Scaglioni numerici (60 CZ, 1.000 pz…) in ordine crescente di quantità
  const qty = l => { const m = String(l).match(/^(\d[\d.]*)/); return m ? Number(m[1].replace(/\./g, '')) : null; };
  if (cols.length > 1 && cols.every(c => qty(c) != null)) cols.sort((a, b) => qty(a) - qty(b));

  // "Extra sconto per quantità" con quantità diverse per riga → una colonna per %
  const pcts = [];
  rows.forEach(r => _lScaglioni(r).forEach(s => {
    if (isQtySconto(s) && s.valore != null && !pcts.includes(s.valore)) pcts.push(s.valore);
  }));
  pcts.sort((a, b) => a - b).forEach(p => cols.push(`%${p}`));
  return cols;
}

function _lSezioni(rows) {
  const map = new Map();
  for (const r of rows) {
    const k = r.categoria || 'Altro';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

function _lMatch(r, tokens) {
  if (!tokens.length) return true;
  const hay = [r.codice_articolo, r.descrizione, r.codice_ean, r.categoria, r.art_equivalente, r.nota]
    .filter(Boolean).join(' ').toLowerCase();
  return tokens.every(t => hay.includes(t));
}

function _lFiltrate() {
  const tokens = _listinoQuery.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return _listinoRows.filter(r =>
    (!_listinoCateg || (r.categoria || 'Altro') === _listinoCateg) &&
    (!_listinoSoloFL || r.fuori_listino) &&
    _lMatch(r, tokens));
}

// ── Render ───────────────────────────────────────────────────────────────────

function _renderListino(root) {
  const sezioni = _lSezioni(_listinoRows);
  const edizSelect = _listinoEdizioni.length > 1
    ? `<select class="gn-select" onchange="switchListinoEdiz(this.value)">
        ${_listinoEdizioni.map(e => `<option value="${_lEsc(e.edizione)}" ${e.edizione === _listinoEdiz ? 'selected' : ''}>Ed. ${_lEsc(e.edizione)}</option>`).join('')}
       </select>`
    : `<span class="gn-ediz">Ed. ${_lEsc(_listinoEdiz)}</span>`;

  const secOptions = [...sezioni.entries()].map(([k, rows]) =>
    `<option value="${_lEsc(k)}" ${_listinoCateg === k ? 'selected' : ''}>${_lEsc(k)} (${rows.length})</option>`).join('');

  root.innerHTML = `
    <div class="gn-toolbar">
      <div class="gn-search-wrap">
        <i class="ti ti-search"></i>
        <input type="search" id="listino-srch" placeholder="Cerca codice, descrizione, EAN…"
          value="${_lEsc(_listinoQuery)}" oninput="onListinoSearch(this.value)" autocomplete="off">
      </div>
      <select class="gn-select" id="listino-sez" onchange="setListinoCateg(this.value || null)">
        <option value="">Tutte le sezioni (${_listinoRows.length})</option>
        ${secOptions}
      </select>
      <label class="gn-toggle"><input type="checkbox" ${_listinoSoloFL ? 'checked' : ''} onchange="setListinoSoloFL(this.checked)"> Solo Fuori listino</label>
      ${edizSelect}
      <button class="gn-btn" onclick="toggleListinoAll()" title="Espandi / comprimi tutte le sezioni"><i class="ti ti-arrows-vertical"></i></button>
    </div>
    <div class="gn-layout">
      <nav class="gn-index" id="listino-index"></nav>
      <div id="listino-body" class="gn-body"></div>
    </div>`;

  _renderListinoBody();
}

function _renderListinoBody() {
  const body  = document.getElementById('listino-body');
  const index = document.getElementById('listino-index');
  if (!body) return;

  const visible = _lFiltrate();
  const countEl = document.getElementById('listino-count');
  if (countEl) countEl.textContent = visible.length === _listinoRows.length
    ? `${visible.length} articoli`
    : `${visible.length} di ${_listinoRows.length}`;

  const sezioni = _lSezioni(visible);
  const searching = !!_listinoQuery.trim();

  if (index) {
    const all = _lSezioni(_listinoRows);
    index.innerHTML = [...all.entries()].map(([k, rows], i) => {
      const n = sezioni.get(k)?.length || 0;
      const on = _listinoCateg === k ? 'on' : '';
      return `<button class="gn-idx ${on} ${n ? '' : 'dim'}" onclick="jumpListinoSez(${i})" data-sez="${_lEsc(k)}">
        <span>${_lEsc(k)}</span><span class="gn-idx-n">${n}</span></button>`;
    }).join('');
  }

  if (!visible.length) {
    body.innerHTML = '<div class="loading">Nessun articolo trovato</div>';
    return;
  }

  const allKeys = [..._lSezioni(_listinoRows).keys()];
  body.innerHTML = [...sezioni.entries()].map(([sez, rows]) => {
    const idx = allKeys.indexOf(sez);
    const collapsed = !searching && _listinoCollapsed.has(sez);
    const titolo = rows.find(r => r.titolo_prezzi)?.titolo_prezzi || '';
    const cols = _lColonne(rows);
    const nFL = rows.filter(r => r.fuori_listino).length;
    const hasEquiv = rows.some(r => r.art_equivalente);
    const hasLordo = rows.some(r => r.prezzo_lordo != null);
    const lordoPer = rows.find(r => r.lordo_per)?.lordo_per;
    // evidenzia il netto più basso solo se le colonne sono scaglioni di quantità
    const qtyTiers = cols.length > 1 && cols.every(c => /^\d/.test(c));

    const head = `
      <tr>
        <th class="gn-c-code">Codice</th>
        <th>Descrizione</th>
        <th class="gn-c-um">UM</th>
        <th class="gn-c-num gn-c-min">Min.</th>
        ${hasLordo ? `<th class="gn-c-num">Lordo${lordoPer ? `<div class="gn-sub">${_lEsc(lordoPer)}</div>` : ''}</th>` : ''}
        ${cols.map(c => `<th class="gn-c-tier">${_lColLabel(c)}</th>`).join('')}
      </tr>`;

    const bodyRows = rows.map(r => {
      const sc = _lScaglioni(r);
      const bestNet = Math.min(...sc.filter(s => s.tipo === 'netto' && s.valore != null).map(s => s.valore));
      const tiers = cols.map(c => {
        if (c.startsWith('%')) {
          const pct = Number(c.slice(1));
          const s = sc.find(s => s.tipo === 'sconto' && /^\d/.test(s.label) && s.valore === pct);
          return `<td class="gn-c-tier">${s ? `<span class="gn-qty">${_lEsc(s.label)}</span>` : ''}</td>`;
        }
        const s = sc.find(s => s.label === c);
        if (!s) return '<td class="gn-c-tier"></td>';
        if (s.tipo === 'sconto') return `<td class="gn-c-tier"><span class="gn-pct">-${String(s.valore).replace('.', ',')}%</span></td>`;
        const disc = r.prezzo_lordo > 0 ? (1 - s.valore / r.prezzo_lordo) * 100 : null;
        const best = qtyTiers && sc.length > 1 && s.valore === bestNet ? ' best' : '';
        return `<td class="gn-c-tier"><span class="gn-net${best}">${_lEur(s.valore)}</span>${disc != null && disc > 0 && disc < 95 ? `<div class="gn-disc">-${disc.toFixed(0)}%</div>` : ''}</td>`;
      }).join('');

      const badges = [
        r.fuori_listino ? '<span class="gn-badge fl">Fuori listino</span>' : '',
        r.nota ? `<span class="gn-badge note" title="${_lEsc(r.nota)}">${_lEsc(r.nota.length > 28 ? r.nota.slice(0, 26) + '…' : r.nota)}</span>` : '',
      ].join('');
      const equiv = hasEquiv && r.art_equivalente ? `<div class="gn-equiv">≈ Fischer ${_lEsc(r.art_equivalente)}</div>` : '';

      return `<tr${r.fuori_listino ? ' class="gn-row-fl"' : ''}>
        <td class="gn-c-code"><button class="gn-code" onclick="copyListinoCode(this, '${_lEsc(r.codice_articolo)}')" title="Copia codice">${_lEsc(r.codice_articolo)}</button></td>
        <td><div class="gn-desc">${_lHighlight(r.descrizione || '—')}</div>${badges ? `<div class="gn-badges">${badges}</div>` : ''}${equiv}</td>
        <td class="gn-c-um">${_lEsc(r.unita_misura || '')}</td>
        <td class="gn-c-num gn-c-min">${r.acquisto_minimo ?? ''}</td>
        ${hasLordo ? `<td class="gn-c-num gn-lordo">${r.prezzo_lordo != null ? _lEur(r.prezzo_lordo) : ''}</td>` : ''}
        ${tiers}
      </tr>`;
    }).join('');

    return `
      <section class="gn-sec${collapsed ? ' collapsed' : ''}" id="gn-sec-${idx}">
        <header class="gn-sec-h" onclick="toggleListinoSez('${_lEsc(sez).replace(/'/g, "\\'")}')">
          <i class="ti ti-chevron-down gn-chev"></i>
          <h3>${_lEsc(sez)}</h3>
          <span class="gn-sec-n">${rows.length} art.${nFL ? ` · ${nFL} FL` : ''}</span>
          ${titolo ? `<span class="gn-sec-t">${_lEsc(titolo)}</span>` : ''}
        </header>
        <div class="gn-tbl-wrap"><table class="gn-tbl"><thead>${head}</thead><tbody>${bodyRows}</tbody></table></div>
      </section>`;
  }).join('');
}

function _lColLabel(c) {
  if (c.startsWith('%')) return `Extra sconto<div class="gn-sub">-${c.slice(1).replace('.', ',')}% da</div>`;
  // "DISTRIBUTORI I° Liv senza stock" → titolo + sottotitolo
  const m = c.match(/^(DISTRIBUTORI|UTILIZZATORI|Fascia cliente TO generato dalla SBU 510|Netto a sistema|Netto q\.tà)\s*(.*)$/);
  if (m) {
    const top = m[1].startsWith('Fascia') ? 'Fascia TO' : m[1];
    return `${_lEsc(top)}${m[2] ? `<div class="gn-sub">${_lEsc(m[2])}</div>` : ''}`;
  }
  return _lEsc(c);
}

function _lHighlight(text) {
  const tokens = _listinoQuery.toLowerCase().trim().split(/\s+/).filter(t => t.length > 1);
  let html = _lEsc(text);
  if (!tokens.length) return html;
  for (const t of tokens) {
    const rx = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
    html = html.replace(rx, '<mark>$1</mark>');
  }
  return html;
}

// ── Event handlers ───────────────────────────────────────────────────────────

function onListinoSearch(q) {
  _listinoQuery = q;
  clearTimeout(_listinoDebTimer);
  _listinoDebTimer = setTimeout(_renderListinoBody, 150);
}

function setListinoCateg(cat) {
  _listinoCateg = cat || null;
  const sel = document.getElementById('listino-sez');
  if (sel) sel.value = _listinoCateg || '';
  _renderListinoBody();
}

function setListinoSoloFL(on) {
  _listinoSoloFL = on;
  _renderListinoBody();
}

function toggleListinoSez(sez) {
  if (_listinoCollapsed.has(sez)) _listinoCollapsed.delete(sez);
  else _listinoCollapsed.add(sez);
  _renderListinoBody();
}

function toggleListinoAll() {
  const keys = [..._lSezioni(_listinoRows).keys()];
  if (_listinoCollapsed.size >= keys.length / 2) _listinoCollapsed.clear();
  else keys.forEach(k => _listinoCollapsed.add(k));
  _renderListinoBody();
}

function jumpListinoSez(i) {
  const keys = [..._lSezioni(_listinoRows).keys()];
  const sez = keys[i];
  if (_listinoCateg && _listinoCateg !== sez) setListinoCateg(null);
  _listinoCollapsed.delete(sez);
  _renderListinoBody();
  document.getElementById(`gn-sec-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function copyListinoCode(btn, code) {
  navigator.clipboard?.writeText(code).then(() => {
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 900);
  }).catch(() => {});
}

function switchListinoEdiz(ediz) {
  _listinoEdiz = ediz;
  _listinoRows = [];
  loadListino();
}
