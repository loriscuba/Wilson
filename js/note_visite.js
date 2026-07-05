// ── Note Visite ──────────────────────────────────────────────────────────────

let _nvStops = [];
let _nvWeek = _nvDefaultWeekLabel();
let _nvRawHeaders = [], _nvRawRows = [];
let _nvHistHeaders = [], _nvHistRows = [];
let _nvHistoryIndex = {};        // normName -> [{dateRaw, dateObj, nota}] sorted desc
let _nvHistoryOriginalName = {}; // normName -> original display name

function _nvDefaultWeekLabel() {
  const d = new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const days = Math.floor((d - jan1) / 86400000);
  const week = Math.ceil((days + jan1.getDay() + 1) / 7);
  return d.getFullYear() + '-W' + String(week).padStart(2, '0');
}

async function loadNoteVisite() {
  const input = document.getElementById('nv-week-input');
  if (input && !input.value) input.value = _nvWeek;
  await _nvLoadWeek(_nvWeek);
}

function _nvNormalizeName(s) {
  return (s || '').toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function _nvGuessColumn(headers, candidates) {
  const lower = headers.map(h => (h || '').toLowerCase());
  for (const cand of candidates) {
    const idx = lower.findIndex(h => h.includes(cand));
    if (idx !== -1) return idx;
  }
  return -1;
}

const NV_HEADER_KEYWORDS = ['cliente', 'organizzazione', 'ragione', 'rivendita', 'nome',
  'codice', 'stato', 'indirizzo', 'oggetto', 'note', 'nota', 'data', 'giorno',
  'ora', 'inizio', 'fine', 'responsabile'];

function _nvFindHeaderRowIndex(rows) {
  const scanLimit = Math.min(rows.length, 15);
  let bestIdx = 0, bestScore = -1;
  for (let i = 0; i < scanLimit; i++) {
    const cells = (rows[i] || []).map(c => (c || '').toString().trim().toLowerCase());
    const nonEmpty = cells.filter(c => c.length > 0);
    if (nonEmpty.length < 2) continue;
    let score = 0;
    cells.forEach(c => { if (c && NV_HEADER_KEYWORDS.some(k => c === k || c.includes(k))) score++; });
    const numericCount = nonEmpty.filter(c => /^[\d.,\/\-\s:]+$/.test(c)).length;
    if (numericCount > 0) score -= numericCount;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestScore >= 2 ? bestIdx : 0;
}

function _nvParseDateFlexible(s) {
  if (!s) return null;
  s = s.trim();
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    const dt = new Date(parseInt(y), parseInt(mo) - 1, parseInt(d));
    if (!isNaN(dt)) return dt;
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const dt = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
    if (!isNaN(dt)) return dt;
  }
  const dt = new Date(s);
  return isNaN(dt) ? null : dt;
}

function _nvParseSpreadsheetFile(file, onDone, onError) {
  const isExcel = /\.(xlsx|xls)$/i.test(file.name);
  if (isExcel) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(new Uint8Array(ev.target.result), { type: 'array', cellDates: false });
        const firstSheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, raw: false, defval: '' });
        const cleaned = rows
          .map(r => r.map(c => (c === null || c === undefined) ? '' : String(c).trim()))
          .filter(r => r.some(c => c.trim().length > 0));
        onDone(cleaned);
      } catch (err) {
        console.error(err);
        onError('Errore nella lettura del file Excel. Prova ad esportarlo come CSV.');
      }
    };
    reader.onerror = () => onError('Errore nella lettura del file.');
    reader.readAsArrayBuffer(file);
  } else {
    Papa.parse(file, {
      complete: (results) => {
        const rows = results.data.filter(r => r.some(c => (c || '').trim().length > 0));
        onDone(rows);
      },
      error: () => onError('Errore nella lettura del file.'),
    });
  }
}

// ── Storico import (ephemeral, solo in sessione) ───────────────────────────

function nvHandleHistFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const hint = document.getElementById('nv-hist-hint');
  hint.textContent = 'Lettura file...';
  _nvParseSpreadsheetFile(file, (rows) => _nvFinishHistParse(rows, hint), (msg) => { hint.textContent = msg; });
}

function _nvFinishHistParse(rows, hint) {
  if (rows.length < 2) { hint.textContent = 'File vuoto o non leggibile.'; return; }
  const headerIdx = _nvFindHeaderRowIndex(rows);
  _nvHistHeaders = rows[headerIdx].map(h => (h || '').trim());
  _nvHistRows = rows.slice(headerIdx + 1);
  if (_nvHistRows.length === 0) { hint.textContent = 'Nessuna riga trovata sotto le intestazioni.'; return; }
  _nvRenderHistMapping();
  const skippedNote = headerIdx > 0 ? ` (saltate ${headerIdx} righe di intestazione file)` : '';
  hint.textContent = _nvHistRows.length + ' righe lette' + skippedNote + '. Conferma le colonne sotto.';
}

function _nvRenderHistMapping() {
  const mapDiv = document.getElementById('nv-hist-mapping');
  mapDiv.style.display = 'flex';
  const dataGuess = _nvGuessColumn(_nvHistHeaders, ['data', 'date']);
  const clienteGuess = _nvGuessColumn(_nvHistHeaders, ['cliente', 'organizzazione', 'ragione', 'nome', 'rivendita']);
  const notaGuess = _nvGuessColumn(_nvHistHeaders, ['nota', 'note', 'commento', 'visita', 'osservazioni']);

  function opt(headers, guess) {
    return headers.map((h, i) => `<option value="${i}" ${i === guess ? 'selected' : ''}>${_nvEsc(h)}</option>`).join('');
  }
  mapDiv.innerHTML = `
    <div class="nv-field"><label>Data *</label><select id="nv-hmap-data">${opt(_nvHistHeaders, dataGuess === -1 ? 0 : dataGuess)}</select></div>
    <div class="nv-field"><label>Cliente *</label><select id="nv-hmap-cliente">${opt(_nvHistHeaders, clienteGuess === -1 ? 0 : clienteGuess)}</select></div>
    <div class="nv-field"><label>Nota *</label><select id="nv-hmap-nota">${opt(_nvHistHeaders, notaGuess === -1 ? 0 : notaGuess)}</select></div>
    <div class="nv-field nv-field-btn"><button class="btn-secondary" id="nv-hist-confirm">Costruisci storico</button></div>
  `;
  document.getElementById('nv-hist-confirm').addEventListener('click', _nvBuildHistoryIndex);
}

function _nvBuildHistoryIndex() {
  const dIdx = parseInt(document.getElementById('nv-hmap-data').value, 10);
  const cIdx = parseInt(document.getElementById('nv-hmap-cliente').value, 10);
  const nIdx = parseInt(document.getElementById('nv-hmap-nota').value, 10);

  _nvHistoryIndex = {};
  _nvHistoryOriginalName = {};
  let count = 0;
  _nvHistRows.forEach(r => {
    const cliente = (r[cIdx] || '').trim();
    const nota = (r[nIdx] || '').trim();
    if (!cliente) return;
    const norm = _nvNormalizeName(cliente);
    const dateRaw = (r[dIdx] || '').trim();
    const dateObj = _nvParseDateFlexible(dateRaw);
    if (!_nvHistoryIndex[norm]) { _nvHistoryIndex[norm] = []; _nvHistoryOriginalName[norm] = cliente; }
    _nvHistoryIndex[norm].push({ dateRaw, dateObj, nota });
    count++;
  });
  Object.keys(_nvHistoryIndex).forEach(k => {
    _nvHistoryIndex[k].sort((a, b) => {
      if (a.dateObj && b.dateObj) return b.dateObj - a.dateObj;
      return 0;
    });
  });
  document.getElementById('nv-hist-badge').textContent = count + ' visite · ' + Object.keys(_nvHistoryIndex).length + ' clienti';
  document.getElementById('nv-hist-mapping').style.display = 'none';
  document.getElementById('nv-hist-hint').textContent = 'Storico pronto.';
  _nvRenderStops();
}

function _nvFindHistoryMatch(clientName) {
  const norm = _nvNormalizeName(clientName);
  if (_nvHistoryIndex[norm]) return { key: norm, mode: 'exact' };
  const candidates = Object.keys(_nvHistoryIndex).filter(k => k.includes(norm) || norm.includes(k));
  if (candidates.length === 1) return { key: candidates[0], mode: 'fuzzy' };
  if (candidates.length > 1) return { key: null, candidates, mode: 'ambiguous' };
  return { key: null, mode: 'none' };
}

// ── Giro settimanale import (persistito su Supabase) ───────────────────────

function nvHandleRouteFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const hint = document.getElementById('nv-import-hint');
  hint.textContent = 'Lettura file...';
  _nvParseSpreadsheetFile(file, (rows) => _nvFinishRouteParse(rows, hint), (msg) => { hint.textContent = msg; });
}

function _nvFinishRouteParse(rows, hint) {
  if (rows.length < 1) { hint.textContent = 'Nessuna riga trovata.'; return; }
  const headerIdx = _nvFindHeaderRowIndex(rows);
  _nvRawHeaders = rows[headerIdx].map(h => (h || '').trim());
  _nvRawRows = rows.slice(headerIdx + 1);
  if (_nvRawRows.length === 0) { hint.textContent = 'Nessuna riga trovata sotto le intestazioni.'; return; }
  const skippedNote = headerIdx > 0 ? ` (saltate ${headerIdx} righe di intestazione file)` : '';
  hint.textContent = _nvRawRows.length + ' righe lette' + skippedNote + '. Conferma le colonne sotto.';
  _nvRenderRouteMapping();
}

function _nvRenderRouteMapping() {
  const mapDiv = document.getElementById('nv-mapping');
  mapDiv.style.display = 'flex';
  const clienteGuess = _nvGuessColumn(_nvRawHeaders, ['cliente', 'organizzazione', 'ragione', 'nome', 'rivendita']);
  const codiceGuess = _nvGuessColumn(_nvRawHeaders, ['codice', 'cod.', 'cod ', 'agente', 'id ']);
  const giornoGuess = _nvGuessColumn(_nvRawHeaders, ['giorno', 'data', 'day']);

  function fieldHtml(id, label, guess, allowNone) {
    const opts = _nvRawHeaders.map((h, i) => `<option value="${i}" ${i === guess ? 'selected' : ''}>${_nvEsc(h)}</option>`).join('');
    const none = allowNone ? `<option value="-1" ${guess === -1 ? 'selected' : ''}>— nessuna —</option>` : '';
    return `<div class="nv-field"><label>${label}</label><select id="${id}">${none}${opts}</select></div>`;
  }
  mapDiv.innerHTML =
    fieldHtml('nv-map-cliente', 'Cliente *', clienteGuess === -1 ? 0 : clienteGuess, false) +
    fieldHtml('nv-map-codice', 'Codice', codiceGuess, true) +
    fieldHtml('nv-map-giorno', 'Giorno', giornoGuess, true) +
    `<div class="nv-field nv-field-btn"><button class="btn-secondary" id="nv-confirm-mapping">Crea tappe</button></div>`;
  document.getElementById('nv-confirm-mapping').addEventListener('click', _nvBuildStopsFromMapping);
}

async function _nvBuildStopsFromMapping() {
  const cIdx = parseInt(document.getElementById('nv-map-cliente').value, 10);
  const codeIdx = parseInt(document.getElementById('nv-map-codice').value, 10);
  const dayIdx = parseInt(document.getElementById('nv-map-giorno').value, 10);
  const hint = document.getElementById('nv-import-hint');

  const rows = _nvRawRows.filter(r => r[cIdx] && r[cIdx].trim().length > 0);
  const payload = rows.map(r => {
    const clienteName = r[cIdx].trim();
    return {
      settimana: _nvWeek,
      cliente: clienteName,
      cliente_norm: _nvNormalizeName(clienteName),
      codice: codeIdx >= 0 ? (r[codeIdx] || null) : null,
      giorno: dayIdx >= 0 ? (r[dayIdx] || null) : null,
    };
  });

  if (!payload.length) { hint.textContent = 'Nessuna tappa da creare.'; return; }

  hint.textContent = 'Salvataggio tappe...';
  const { error } = await sb.from('visite_note_bozze')
    .upsert(payload, { onConflict: 'settimana,cliente_norm' });
  if (error) { hint.textContent = 'Errore salvataggio: ' + error.message; return; }

  document.getElementById('nv-mapping').style.display = 'none';
  await _nvLoadWeek(_nvWeek);
  hint.textContent = payload.length + ' tappe caricate.';
}

// ── Rendering ───────────────────────────────────────────────────────────────

function _nvEsc(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _nvFieldRow(stop, key, label, placeholder, full) {
  return `<div class="${full ? 'nv-full' : ''}">
    <label>${label}</label>
    <input type="text" data-id="${stop.id}" data-key="${key}" value="${_nvEsc(stop[key] || '')}" placeholder="${placeholder}" />
  </div>`;
}

function _nvHistoryBlockHtml(stop) {
  const hasHist = Object.keys(_nvHistoryIndex).length > 0;
  if (!hasHist) {
    return `<div class="nv-history-block"><div class="nv-history-status nv-muted">Nessuno storico caricato in questa sessione.</div></div>`;
  }
  let match = stop.historyKey !== undefined
    ? { key: stop.historyKey, mode: stop.historyKey ? 'set' : 'none' }
    : _nvFindHistoryMatch(stop.cliente);
  if (stop.historyKey === undefined) stop.historyKey = match.key || null;

  if (match.mode === 'ambiguous' && stop.historyKey === null) {
    const opts = ['<option value="">-- scegli corrispondenza --</option>']
      .concat(match.candidates.map(k => `<option value="${_nvEsc(k)}">${_nvEsc(_nvHistoryOriginalName[k])} (${_nvHistoryIndex[k].length} visite)</option>`))
      .concat(['<option value="__none__">Nessuna corrispondenza</option>']).join('');
    return `<div class="nv-history-block">
      <div class="nv-history-status">Trovate ${match.candidates.length} possibili corrispondenze nello storico.</div>
      <div class="nv-history-match-select"><select data-histmatch="${stop.id}">${opts}</select></div>
    </div>`;
  }

  const key = stop.historyKey;
  if (!key || !_nvHistoryIndex[key]) {
    return `<div class="nv-history-block"><div class="nv-history-status nv-muted">Nessuno storico trovato per questo cliente.</div></div>`;
  }
  const visits = _nvHistoryIndex[key];
  const last = visits[0];
  const listHtml = visits.slice(0, 5).map(v => `
    <div class="nv-h-item"><span class="nv-h-date">${_nvEsc(v.dateRaw || '')}</span> — ${_nvEsc(v.nota || '(senza testo)')}</div>
  `).join('');
  const summaryHtml = stop.historySummary
    ? `<div class="nv-history-summary ${stop.summaryOpen ? 'nv-open' : ''}">${_nvEsc(stop.historySummary)}</div>`
    : '';

  return `<div class="nv-history-block">
    <div class="nv-history-row">
      <div class="nv-history-status">${visits.length} visite storiche · ultima ${_nvEsc(last.dateRaw || 'n/d')}</div>
      <div class="nv-history-actions">
        <button class="btn-secondary nv-btn-small" data-toggle-hist="${stop.id}">${stop.historyOpen ? 'Nascondi note' : 'Mostra ultime note'}</button>
        <button class="btn-secondary nv-btn-small" data-summarize="${stop.id}">${stop.historySummary ? 'Rigenera riassunto' : 'Riassumi con AI'}</button>
      </div>
    </div>
    <div class="nv-history-list ${stop.historyOpen ? 'nv-open' : ''}" data-histlist="${stop.id}">${listHtml}</div>
    ${summaryHtml}
  </div>`;
}

function _nvDupWarningHtml(dateRaw) {
  return `⚠️ Uguale a una nota già scritta il ${_nvEsc(dateRaw)} — modificala prima di salvarla.`;
}

function _nvCheckDuplicateNote(stop, text) {
  if (!stop.historyKey || !_nvHistoryIndex[stop.historyKey]) return null;
  const norm = (text || '').trim().toLowerCase();
  if (!norm) return null;
  const match = _nvHistoryIndex[stop.historyKey].find(v => (v.nota || '').trim().toLowerCase() === norm);
  return match || null;
}

function _nvUpdateDuplicateWarning(stop) {
  const dup = _nvCheckDuplicateNote(stop, stop.nota);
  stop.duplicateWarning = dup ? (dup.dateRaw || 'data n/d') : null;
  const el = document.querySelector(`[data-dupwarn="${stop.id}"]`);
  if (el) el.innerHTML = stop.duplicateWarning ? _nvDupWarningHtml(stop.duplicateWarning) : '';
}

function _nvRenderStops() {
  const routeDiv = document.getElementById('nv-route');
  const emptyDiv = document.getElementById('nv-empty');
  const footerBar = document.getElementById('nv-footer-bar');
  if (!routeDiv) return;

  if (_nvStops.length === 0) {
    routeDiv.innerHTML = '';
    emptyDiv.style.display = 'block';
    footerBar.style.display = 'none';
    document.getElementById('nv-route-toolbar').style.display = 'none';
    return;
  }
  emptyDiv.style.display = 'none';
  footerBar.style.display = 'flex';
  document.getElementById('nv-route-toolbar').style.display = 'flex';

  const total = _nvStops.length;
  _nvStops.forEach(stop => {
    if (stop.historyKey && _nvHistoryIndex[stop.historyKey]) {
      const dup = _nvCheckDuplicateNote(stop, stop.nota);
      stop.duplicateWarning = dup ? (dup.dateRaw || 'data n/d') : null;
    }
  });

  routeDiv.innerHTML = '<div class="nv-route-line"></div>' + _nvStops.map((stop, i) => `
    <div class="nv-stop" data-stop="${stop.id}">
      <div class="nv-stop-marker">TAPPA<br/>${String(i + 1).padStart(2, '0')}/${String(total).padStart(2, '0')}<div class="nv-dot"></div></div>
      <div class="table-wrapper nv-stop-card">
        <div class="nv-client-name">${_nvEsc(stop.cliente)}</div>
        <div class="nv-client-meta">${[stop.codice, stop.giorno].filter(Boolean).map(_nvEsc).join(' · ') || '&nbsp;'}</div>
        ${_nvHistoryBlockHtml(stop)}
        <details class="nv-extra">
          <summary>Dettagli extra (opzionali)</summary>
          <div class="nv-fields">
            ${_nvFieldRow(stop, 'prodotti', 'Prodotti / linee discusse', 'es. UPAT fissaggi chimici, gamma premium', true)}
            ${_nvFieldRow(stop, 'ordini', 'Ordini raccolti o previsti', 'es. ordine tasselli 500pz, preventivo in corso', true)}
            ${_nvFieldRow(stop, 'step', 'Prossimi step', 'es. richiamare dopo campionatura', true)}
          </div>
        </details>
        <div class="nv-note-box">
          <textarea data-note-id="${stop.id}" placeholder="La bozza generata comparirà qui, modificabile liberamente...">${_nvEsc(stop.nota)}</textarea>
          <div class="nv-dup-warn" data-dupwarn="${stop.id}">${stop.duplicateWarning ? _nvDupWarningHtml(stop.duplicateWarning) : ''}</div>
          <div class="nv-note-actions">
            <button class="btn-secondary nv-btn-small" data-gen="${stop.id}">${stop.nota ? 'Rigenera nota' : 'Genera nota'}</button>
            <button class="btn-secondary nv-btn-small" data-copy="${stop.id}">Copia</button>
            <span class="nv-status" data-status="${stop.id}">${stop.status || ''}</span>
          </div>
        </div>
      </div>
    </div>
  `).join('');

  routeDiv.querySelectorAll('input[data-key]').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const stop = _nvStops.find(s => s.id === e.target.getAttribute('data-id'));
      if (stop) {
        const key = e.target.getAttribute('data-key');
        stop[key] = e.target.value;
        _nvDebouncedFieldSave(stop.id, key, e.target.value);
      }
    });
  });
  routeDiv.querySelectorAll('textarea[data-note-id]').forEach(ta => {
    ta.addEventListener('input', (e) => {
      const stop = _nvStops.find(s => s.id === e.target.getAttribute('data-note-id'));
      if (stop) {
        stop.nota = e.target.value;
        _nvUpdateDuplicateWarning(stop);
        _nvDebouncedFieldSave(stop.id, 'nota', e.target.value);
      }
    });
  });
  routeDiv.querySelectorAll('button[data-gen]').forEach(btn => {
    btn.addEventListener('click', (e) => _nvGenerateNote(e.target.getAttribute('data-gen')));
  });
  routeDiv.querySelectorAll('button[data-copy]').forEach(btn => {
    btn.addEventListener('click', (e) => _nvCopyNote(e.target.getAttribute('data-copy'), e.target));
  });
  routeDiv.querySelectorAll('button[data-toggle-hist]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const stop = _nvStops.find(s => s.id === e.target.getAttribute('data-toggle-hist'));
      if (stop) { stop.historyOpen = !stop.historyOpen; _nvRenderStops(); }
    });
  });
  routeDiv.querySelectorAll('button[data-summarize]').forEach(btn => {
    btn.addEventListener('click', (e) => _nvSummarizeHistory(e.target.getAttribute('data-summarize')));
  });
  routeDiv.querySelectorAll('select[data-histmatch]').forEach(sel => {
    sel.addEventListener('change', async (e) => {
      const stop = _nvStops.find(s => s.id === e.target.getAttribute('data-histmatch'));
      if (!stop) return;
      stop.historyKey = e.target.value === '__none__' ? null : (e.target.value || null);
      await sb.from('visite_note_bozze').update({ history_key: stop.historyKey }).eq('id', stop.id);
      _nvRenderStops();
    });
  });
}

const _nvFieldSaveTimers = {};
function _nvDebouncedFieldSave(id, key, value) {
  const timerKey = id + ':' + key;
  clearTimeout(_nvFieldSaveTimers[timerKey]);
  _nvFieldSaveTimers[timerKey] = setTimeout(async () => {
    await sb.from('visite_note_bozze').update({ [key]: value }).eq('id', id);
  }, 500);
}

// ── AI: riassunto storico ───────────────────────────────────────────────────

async function _nvSummarizeHistory(id) {
  const stop = _nvStops.find(s => s.id === id);
  if (!stop || !stop.historyKey || !_nvHistoryIndex[stop.historyKey]) return;
  const btn = document.querySelector(`button[data-summarize="${id}"]`);
  btn.disabled = true;
  btn.textContent = 'Riassumo...';
  const visits = _nvHistoryIndex[stop.historyKey].slice(0, 15);
  const visitsText = visits.map(v => `- ${v.dateRaw || 'data n/d'}: ${v.nota || '(senza testo)'}`).join('\n');
  const clienteNome = _nvHistoryOriginalName[stop.historyKey];

  try {
    const { data, error } = await sb.functions.invoke('nota-visita', {
      body: { action: 'riassumi_storico', cliente: clienteNome, visitsText },
    });
    if (error) throw error;
    const text = (data && data.text || '').trim();
    if (!text) throw new Error('vuoto');
    stop.historySummary = text;
    stop.summaryOpen = true;
    await sb.from('visite_note_riassunti_cache')
      .upsert({ cliente_norm: stop.historyKey, cliente_nome: clienteNome, riassunto: text });
    _nvRenderStops();
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = 'Riassumi con AI';
  }
}

async function _nvTryLoadCachedSummary(stop) {
  if (!stop.historyKey || stop.historySummary) return;
  const { data } = await sb.from('visite_note_riassunti_cache')
    .select('riassunto').eq('cliente_norm', stop.historyKey).maybeSingle();
  if (data && data.riassunto) stop.historySummary = data.riassunto;
}

async function _nvCopyNote(id, btn) {
  const ta = document.querySelector(`textarea[data-note-id="${id}"]`);
  if (!ta || !ta.value.trim()) return;
  const original = btn.textContent;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(ta.value);
    } else {
      ta.select();
      document.execCommand('copy');
      ta.setSelectionRange(0, 0);
    }
    btn.textContent = 'Copiato ✓';
  } catch (err) {
    console.error(err);
    btn.textContent = 'Errore copia';
  }
  setTimeout(() => { btn.textContent = original; }, 1500);
}

// ── Estrazione nome più ricorrente dallo storico ────────────────────────────

const NV_GENERIC_CONTACT_TERMS = [
  'il referente', 'la referente', 'referente', 'un referente',
  'il titolare', 'la titolare', 'titolare', 'i titolari',
  'il responsabile', 'la responsabile', 'responsabile',
  'il proprietario', 'la proprietaria', 'proprietario', 'proprietaria',
  'il gestore', 'la gestrice', 'gestore',
  'il commesso', 'la commessa', 'commesso', 'commessa',
  'lui', 'lei', 'loro', 'nessuno', 'n a', 'na'
];

function _nvIsGenericContact(norm) {
  return NV_GENERIC_CONTACT_TERMS.some(term => norm === term || norm.endsWith(' ' + term) || norm.startsWith(term + ' '));
}

function _nvExtractMostCommonContact(visits) {
  const counts = {};
  const original = {};
  (visits || []).forEach(v => {
    if (!v.nota) return;
    const m = v.nota.match(/parlato con\s+([^,\.\n]+)/i);
    if (!m) return;
    let name = m[1].trim().split(/\s+/).slice(0, 3).join(' ');
    name = name.replace(/[^a-zA-ZÀ-ÿ' ]+$/, '').trim();
    if (!name) return;
    const norm = name.toLowerCase();
    if (_nvIsGenericContact(norm)) return;
    counts[norm] = (counts[norm] || 0) + 1;
    if (!original[norm]) original[norm] = name;
  });
  let best = null, bestCount = 0;
  Object.keys(counts).forEach(k => { if (counts[k] > bestCount) { bestCount = counts[k]; best = k; } });
  return best ? { nome: original[best], count: bestCount, total: (visits || []).length } : null;
}

// ── AI: nota di visita ───────────────────────────────────────────────────────

async function _nvGenerateNote(id) {
  const stop = _nvStops.find(s => s.id === id);
  if (!stop) return;
  const statusEl = document.querySelector(`[data-status="${id}"]`);
  const btn = document.querySelector(`button[data-gen="${id}"]`);
  if (statusEl) { statusEl.textContent = 'Genero...'; statusEl.className = 'nv-status'; }
  if (btn) btn.disabled = true;

  const visits = (stop.historyKey && _nvHistoryIndex[stop.historyKey]) ? _nvHistoryIndex[stop.historyKey] : [];
  const contatto = _nvExtractMostCommonContact(visits);
  await _nvTryLoadCachedSummary(stop);

  const recentNotes = visits.slice(0, 10).filter(v => v.nota)
    .map(v => `- ${v.dateRaw || 'data n/d'}: ${v.nota}`).join('\n');

  try {
    const { data, error } = await sb.functions.invoke('nota-visita', {
      body: {
        action: 'genera_nota',
        cliente: stop.cliente,
        contatto,
        recentNotes,
        historySummary: stop.historySummary || '',
        prodotti: stop.prodotti,
        ordini: stop.ordini,
        step: stop.step,
      },
    });
    if (error) throw error;
    const text = (data && data.text || '').trim();
    if (!text) throw new Error('Risposta vuota');
    stop.nota = text;
    const ta = document.querySelector(`textarea[data-note-id="${id}"]`);
    if (ta) ta.value = text;
    _nvUpdateDuplicateWarning(stop);
    await sb.from('visite_note_bozze').update({ nota: text }).eq('id', stop.id);
    if (statusEl) {
      if (stop.duplicateWarning) {
        statusEl.textContent = 'Bozza generata — ⚠️ uguale a una nota passata';
        statusEl.className = 'nv-status nv-warn';
      } else {
        statusEl.textContent = 'Bozza generata — modificabile';
        statusEl.className = 'nv-status nv-ok';
      }
    }
    if (btn) btn.textContent = 'Rigenera nota';
  } catch (err) {
    console.error(err);
    if (statusEl) { statusEl.textContent = 'Errore nella generazione, riprova.'; statusEl.className = 'nv-status'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function nvGeneraTutte() {
  const btn = document.getElementById('nv-gen-all');
  const status = document.getElementById('nv-gen-all-status');
  btn.disabled = true;
  for (let i = 0; i < _nvStops.length; i++) {
    status.textContent = `Genero ${i + 1}/${_nvStops.length}...`;
    status.className = 'nv-status';
    await _nvGenerateNote(_nvStops[i].id);
  }
  status.textContent = 'Tutte le bozze generate.';
  status.className = 'nv-status nv-ok';
  btn.disabled = false;
}

// ── Persistenza settimana ────────────────────────────────────────────────────

async function _nvLoadWeek(week) {
  _nvWeek = week;
  const statusEl = document.getElementById('nv-week-status');
  try {
    const { data, error } = await sb.from('visite_note_bozze')
      .select('*').eq('settimana', week).order('created_at', { ascending: true });
    if (error) throw error;
    _nvStops = (data || []).map(r => ({
      id: r.id,
      cliente: r.cliente,
      cliente_norm: r.cliente_norm,
      codice: r.codice || '',
      giorno: r.giorno || '',
      prodotti: r.prodotti || '',
      ordini: r.ordini || '',
      step: r.step || '',
      nota: r.nota || '',
      historyKey: r.history_key,
      historySummary: '',
      historyOpen: false,
      summaryOpen: false,
      status: '',
    }));
    statusEl.textContent = _nvStops.length ? _nvStops.length + ' tappe caricate' : 'Nessuna tappa per questa settimana — carica il file del giro qui sopra.';
    statusEl.className = 'nv-status nv-ok';
  } catch (err) {
    _nvStops = [];
    statusEl.textContent = 'Errore caricamento: ' + err.message;
    statusEl.className = 'nv-status';
  }
  _nvRenderStops();
}

function nvCaricaSettimana() {
  const week = document.getElementById('nv-week-input').value.trim() || _nvDefaultWeekLabel();
  _nvLoadWeek(week);
}

function nvExportTxt() {
  const lines = _nvStops.filter(s => s.nota).map(s => `${s.cliente}${s.codice ? ' (' + s.codice + ')' : ''}\n${s.nota}\n`);
  _nvDownloadBlob(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }), `note-visite-${_nvWeek}.txt`);
}

function nvExportCsv() {
  const esc = (s) => `"${(s || '').replace(/"/g, '""')}"`;
  const header = ['Cliente', 'Codice', 'Giorno', 'Prodotti', 'Ordini', 'Prossimi step', 'Nota'].map(esc).join(',');
  const rows = _nvStops.map(s => [s.cliente, s.codice, s.giorno, s.prodotti, s.ordini, s.step, s.nota].map(esc).join(','));
  _nvDownloadBlob(new Blob([[header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8' }), `note-visite-${_nvWeek}.csv`);
}

function _nvDownloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
