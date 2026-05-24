/* ── Agenda ─────────────────────────────────────────────────────────── */

let _agendaAnno  = null;
let _agendaMese  = null;
let _dragCard    = null;   // riferimento DOM della card in drag

const MESI_AGENDA = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
                     'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
const GIORNI_TH   = ['Lun','Mar','Mer','Gio','Ven','Sab'];

// Mappa nome italiano giorno → indice 1..6 (1=Lun, 6=Sab)
function giornoToIdx(s) {
  if (!s) return null;
  const l = s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  if (l.startsWith('lun')) return 1;
  if (l.startsWith('mar')) return 2;
  if (l.startsWith('mer')) return 3;
  if (l.startsWith('gio')) return 4;
  if (l.startsWith('ven')) return 5;
  if (l.startsWith('sab')) return 6;
  return null;
}

// Restituisce le settimane del mese: array di array [Lun…Sab] (6 date)
function getCalWeeks(anno, mese) {
  const weeks    = [];
  const firstDay = new Date(anno, mese - 1, 1);
  const lastDay  = new Date(anno, mese, 0);
  const dow      = firstDay.getDay(); // 0=Dom
  const offset   = dow === 0 ? -6 : 1 - dow;
  let monday = new Date(firstDay);
  monday.setDate(monday.getDate() + offset);
  while (monday <= lastDay) {
    const week = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(monday);
      d.setDate(d.getDate() + i);
      week.push(d);
    }
    weeks.push(week);
    monday.setDate(monday.getDate() + 7);
  }
  return weeks;
}

// Priorità per l'algoritmo di scheduling (valore basso = da visitare prima)
function getPriority(r) {
  if (!r) return 3;
  const ord = { da_visitare: 0, indietro: 1, da_stimolare: 2, nuovo: 2,
                in_linea: 3, ottimo: 3, inattivo: 4 };
  return ord[r._stato?.id] ?? 3;
}

// Classe CSS card in base allo stato rolling
function cardStatoCls(r) {
  if (!r) return 'ac-neutral';
  const id = r._stato?.id;
  if (id === 'da_visitare' || id === 'indietro') return 'ac-red';
  if (id === 'da_stimolare' || id === 'nuovo')    return 'ac-orange';
  if (id === 'in_linea' || id === 'ottimo')        return 'ac-green';
  if (id === 'inattivo')                           return 'ac-gray';
  return 'ac-neutral';
}

// ── Algoritmo pianificazione ─────────────────────────────────────────
function algoritmoAgenda(anno, mese, clientiList, rollingMap) {
  const weeks       = getCalWeeks(anno, mese);
  const assignments = [];

  // Raggruppa per indice giorno (1-6)
  const byDay = {};
  for (const c of clientiList) {
    const idx = giornoToIdx(c.giorno_visita);
    if (idx === null) continue;
    if (!byDay[idx]) byDay[idx] = [];
    byDay[idx].push(c);
  }

  for (const [idxStr, clients] of Object.entries(byDay)) {
    const weekIdx = parseInt(idxStr) - 1; // 0-based index into week array

    // Date disponibili del mese per questo giorno della settimana
    const dates = weeks
      .map(w => w[weekIdx])
      .filter(d => d.getMonth() === mese - 1)
      .map(d => d.toISOString().split('T')[0]);

    if (!dates.length) continue;

    // Ordina per priorità (urgenti prima)
    const sorted = [...clients].sort((a, b) =>
      getPriority(rollingMap[a.codice_cliente]) - getPriority(rollingMap[b.codice_cliente])
    );

    // Distribuisce round-robin sulle date: i più urgenti vanno alle prime settimane
    sorted.forEach((c, i) => {
      assignments.push({
        codice_cliente: c.codice_cliente,
        data_visita:    dates[i % dates.length],
      });
    });
  }

  return assignments;
}

// ── Rendering calendar ───────────────────────────────────────────────
function renderCard(v, clientiMap, rollingMap) {
  const c = clientiMap[v.codice_cliente];
  if (!c) return '';
  const r    = rollingMap[v.codice_cliente];
  const cls  = cardStatoCls(r);
  const nome = c.ragione_sociale || v.codice_cliente;
  const sub  = c.settori?.nome || r?._stato?.label || '';
  return `
    <div class="agenda-card ${cls}${v.completata ? ' ac-done' : ''}"
         draggable="true"
         data-id="${v.id}"
         data-codice="${v.codice_cliente}"
         data-date="${v.data_visita}"
         ondragstart="agendaDragStart(event)">
      <div class="ac-body" onclick="agendaToggleDone('${v.id}',this)">
        <div class="ac-nome" title="${nome}">${nome}</div>
        ${sub ? `<div class="ac-sub">${sub}</div>` : ''}
      </div>
      <button class="ac-del" onclick="agendaElimina('${v.id}',event)" title="Rimuovi">×</button>
    </div>`;
}

function renderCalendario(container, anno, mese, visite, clientiMap, rollingMap) {
  const weeks   = getCalWeeks(anno, mese);
  const today   = new Date(); today.setHours(0,0,0,0);
  const byDate  = {};
  for (const v of visite) {
    if (!byDate[v.data_visita]) byDate[v.data_visita] = [];
    byDate[v.data_visita].push(v);
  }

  const clientiConGiorno = Object.values(clientiMap).filter(c => giornoToIdx(c.giorno_visita));

  const toolbar = visite.length
    ? `<div class="ag-toolbar">
        <span class="ag-count">${visite.length} visite · ${visite.filter(v=>v.completata).length} completate</span>
        <button class="ag-btn-sec" onclick="agendaRigenera()">↺ Rigenera</button>
       </div>`
    : `<div class="ag-empty">
        <div class="ag-empty-icon">📅</div>
        <div class="ag-empty-text">Nessuna visita pianificata</div>
        ${clientiConGiorno.length
          ? `<button class="ag-btn-prim" onclick="agendaGenera()">✦ Genera agenda automatica</button>`
          : `<p style="font-size:13px;color:var(--text2)">Imposta il giorno di visita nelle schede clienti (Impostazioni) per generare l'agenda.</p>`}
       </div>`;

  container.innerHTML = `
    ${toolbar}
    <div class="cal-grid">
      <div class="cal-header-row">
        ${GIORNI_TH.map(g => `<div class="cal-th">${g}</div>`).join('')}
      </div>
      ${weeks.map(week => `
        <div class="cal-week-row">
          ${week.map(date => {
            const ds     = date.toISOString().split('T')[0];
            const inMese = date.getMonth() === mese - 1;
            const isToday = date.getTime() === today.getTime();
            const isPast  = date < today && inMese;
            const dayV    = byDate[ds] || [];
            return `
              <div class="cal-day${!inMese ? ' cal-out' : ''}${isToday ? ' cal-today' : ''}${isPast ? ' cal-past' : ''}"
                   data-date="${ds}"
                   ondragover="event.preventDefault();this.classList.add('cal-dragover')"
                   ondragleave="this.classList.remove('cal-dragover')"
                   ondrop="agendaDrop(event,'${ds}')">
                <div class="cal-num${isToday ? ' cal-num-today' : ''}">${date.getDate()}</div>
                <div class="cal-cards" id="cal-${ds}">
                  ${dayV.map(v => renderCard(v, clientiMap, rollingMap)).join('')}
                </div>
              </div>`;
          }).join('')}
        </div>`).join('')}
    </div>`;
}

// ── Entry point ───────────────────────────────────────────────────────
async function loadAgenda() {
  const now = new Date();
  if (!_agendaAnno) _agendaAnno = now.getFullYear();
  if (!_agendaMese) _agendaMese = now.getMonth() + 1;

  document.getElementById('agenda-mese-label').textContent =
    MESI_AGENDA[_agendaMese - 1] + ' ' + _agendaAnno;

  const container = document.getElementById('agenda-cal');
  container.innerHTML = '<div class="loading">Caricamento…</div>';

  const y  = _agendaAnno;
  const m  = String(_agendaMese).padStart(2,'0');
  const d1 = `${y}-${m}-01`;
  const d2 = new Date(y, _agendaMese, 0).toISOString().split('T')[0];

  try {
    const [{ data: visite }, { data: clientiRaw }, rolling] = await Promise.all([
      sb.from('agenda_visite')
        .select('id, codice_cliente, data_visita, completata, note')
        .gte('data_visita', d1).lte('data_visita', d2),
      sb.from('clienti')
        .select('codice_cliente, ragione_sociale, giorno_visita, settori(nome)')
        .eq('attivo', true),
      loadRollingEnriched(),
    ]);

    const clientiMap = Object.fromEntries((clientiRaw || []).map(c => [c.codice_cliente, c]));
    const rollingMap = Object.fromEntries(rolling.map(r => [r.codice_cliente, r]));

    renderCalendario(container, y, _agendaMese, visite || [], clientiMap, rollingMap);
  } catch (err) {
    container.innerHTML = `<div class="loading">Errore: ${err.message}</div>`;
  }
}

// ── Genera / Rigenera ─────────────────────────────────────────────────
async function _eseguiGenera(conferma) {
  if (conferma && !confirm(`Genera agenda automatica per ${MESI_AGENDA[_agendaMese-1]}? Verranno sovrascritte le visite esistenti.`)) return;

  const container = document.getElementById('agenda-cal');
  container.innerHTML = '<div class="loading">Generazione in corso…</div>';

  try {
    const [{ data: clientiRaw }, rolling] = await Promise.all([
      sb.from('clienti').select('codice_cliente, giorno_visita').eq('attivo', true),
      loadRollingEnriched(),
    ]);

    const clientiList = (clientiRaw || []).filter(c => giornoToIdx(c.giorno_visita));
    const rollingMap  = Object.fromEntries(rolling.map(r => [r.codice_cliente, r]));
    const assignments = algoritmoAgenda(_agendaAnno, _agendaMese, clientiList, rollingMap);

    if (!assignments.length) {
      container.innerHTML = `<div class="loading">Nessun cliente ha il giorno di visita impostato.</div>`;
      return;
    }

    const y = _agendaAnno, m = String(_agendaMese).padStart(2,'0');
    await sb.from('agenda_visite').delete()
      .gte('data_visita',`${y}-${m}-01`)
      .lte('data_visita', new Date(y, _agendaMese, 0).toISOString().split('T')[0]);

    await sb.from('agenda_visite').insert(
      assignments.map(a => ({ ...a, completata: false, generata_auto: true }))
    );

    await loadAgenda();
  } catch (err) {
    container.innerHTML = `<div class="loading">Errore: ${err.message}</div>`;
  }
}

function agendaGenera()   { _eseguiGenera(false); }
function agendaRigenera() { _eseguiGenera(true);  }

// ── Navigazione mese ──────────────────────────────────────────────────
function agendaMesePrev() {
  _agendaMese--;
  if (_agendaMese < 1)  { _agendaMese = 12; _agendaAnno--; }
  loadAgenda();
}
function agendaMeseNext() {
  _agendaMese++;
  if (_agendaMese > 12) { _agendaMese = 1;  _agendaAnno++; }
  loadAgenda();
}

// ── Drag & Drop ───────────────────────────────────────────────────────
function agendaDragStart(e) {
  _dragCard = e.currentTarget;
  _dragCard.classList.add('ac-dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', _dragCard.dataset.id);
}

async function agendaDrop(e, newDate) {
  e.preventDefault();
  e.currentTarget.classList.remove('cal-dragover');
  if (!_dragCard) return;

  const oldDate = _dragCard.dataset.date;
  _dragCard.classList.remove('ac-dragging');
  if (oldDate === newDate) { _dragCard = null; return; }

  const id  = _dragCard.dataset.id;
  const card = _dragCard;
  _dragCard  = null;

  // Sposta DOM subito (ottimistico)
  const targetCards = document.getElementById('cal-' + newDate);
  card.dataset.date = newDate;
  targetCards?.appendChild(card);

  try {
    await sb.from('agenda_visite').update({ data_visita: newDate }).eq('id', id);
  } catch (err) {
    alert('Errore nel salvare lo spostamento: ' + err.message);
    await loadAgenda();
  }
}

// ── Toggle completata ─────────────────────────────────────────────────
async function agendaToggleDone(id, bodyEl) {
  const card = bodyEl.closest('.agenda-card');
  const done = !card.classList.contains('ac-done');
  card.classList.toggle('ac-done', done);
  try {
    await sb.from('agenda_visite').update({ completata: done }).eq('id', id);
  } catch (err) {
    card.classList.toggle('ac-done', !done);
    alert('Errore: ' + err.message);
  }
}

// ── Elimina visita ────────────────────────────────────────────────────
async function agendaElimina(id, e) {
  e.stopPropagation();
  const card = e.target.closest('.agenda-card');
  card.style.opacity = '0.3';
  try {
    await sb.from('agenda_visite').delete().eq('id', id);
    card.remove();
  } catch (err) {
    card.style.opacity = '';
    alert('Errore: ' + err.message);
  }
}
