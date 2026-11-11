// ── Prossima visita in Agenda per cliente ─────────────────────────────────────
// Fonte unica della data mostrata (e modificabile) in Proiezione fatturato e in
// Pipeline clienti: la tabella agenda_visite, letta e scritta solo da qui.
//
// Regola: la "prossima visita" di un cliente è la prima visita con data da oggi
// in poi non ancora completata (a parità di data, quella con id più basso).
//
// Ogni salvataggio rilegge lo stato dal database (mai dalla cache della pagina,
// che può essere vecchia se la data è stata cambiata altrove), controlla che la
// riga sia stata davvero scritta, aggiorna tutti i campi a video dello stesso
// cliente e lancia l'evento window "agenda:prossima" { codice, id, data } così
// ogni pagina allinea il proprio stato.

function _apOggi() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function _apEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Visite future non completate, in ordine (paginato: l'Agenda può generarne molte)
function _apQueryFuture() {
  return sb.from('agenda_visite')
    .select('id, codice_cliente, data_visita')
    .gte('data_visita', _apOggi())
    .not('completata', 'is', true)
    .order('data_visita', { ascending: true })
    .order('id', { ascending: true });
}

// { codice_cliente: { id, data } } con la prossima visita di ogni cliente
async function agendaProssimeVisite() {
  const out = {};
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await _apQueryFuture().range(from, from + size - 1);
    if (error) throw error;
    for (const v of data || []) {
      const cod = String(v.codice_cliente || '').trim();
      if (cod && !out[cod]) out[cod] = { id: v.id, data: v.data_visita };
    }
    if (!data || data.length < size) break;
  }
  return out;
}

async function _apProssimaCliente(codice) {
  const { data, error } = await _apQueryFuture().eq('codice_cliente', codice).limit(1);
  if (error) throw error;
  const v = data?.[0];
  return v ? { id: v.id, data: v.data_visita } : null;
}

// Crea, sposta o toglie (data vuota) la prossima visita del cliente.
// Restituisce la prossima visita risultante ({ id, data } o null).
async function agendaImpostaProssima(codice, data) {
  codice = String(codice).trim();
  data = data || '';
  const prossima = await _apProssimaCliente(codice);

  if (!data) {
    if (prossima) {
      const { data: del, error } = await sb.from('agenda_visite').delete().eq('id', prossima.id).select('id');
      if (error) throw error;
      if (!del?.length) throw new Error('la visita non è stata tolta dal database');
    }
  } else if (prossima) {
    if (prossima.data !== data) {
      const { data: upd, error } = await sb.from('agenda_visite')
        .update({ data_visita: data }).eq('id', prossima.id).select('id');
      if (error) throw error;
      if (!upd?.length) throw new Error('la visita non è stata spostata nel database');
    }
  } else {
    const { error } = await sb.from('agenda_visite')
      .insert({ codice_cliente: codice, data_visita: data, completata: false, generata_auto: false });
    if (error) {
      // Visita già presente in quella data (es. segnata come completata): la riattiva
      const { data: upd, error: e2 } = await sb.from('agenda_visite')
        .update({ completata: false })
        .eq('codice_cliente', codice).eq('data_visita', data).select('id');
      if (e2 || !upd?.length) throw error;
    }
  }

  const nuova = await _apProssimaCliente(codice);
  _apAggiornaCampi(codice, nuova?.data || '');
  window.dispatchEvent(new CustomEvent('agenda:prossima', {
    detail: { codice, id: nuova?.id || null, data: nuova?.data || null },
  }));
  return nuova;
}

// ── Campo data condiviso ─────────────────────────────────────────────────────
// La data si salva solo col pulsante "Salva": su iPad/iPhone il selettore imposta
// subito la data di oggi e lancia change/blur all'apertura, quindi niente
// salvataggi automatici. Testo sempre visibile (su iPad un campo data vuoto non
// mostra nulla): il campo data è trasparente sopra icona+testo e apre il
// calendario al tocco. La × toglie la visita (con conferma).
function agendaCampoHtml(codice, data, opts = {}) {
  const cod = _apEsc(codice);
  const d   = data || '';
  return `<div class="pf-agenda${d ? ' on' : ''}${opts.compact ? ' compact' : ''}" data-cod="${cod}"${opts.compact ? ' data-compact="1"' : ''}
               title="${d ? 'Prossima visita in Agenda' : 'Programma una visita in Agenda'}">
    <label class="pf-ag-field">
      <i class="ti ${d ? 'ti-calendar-check' : 'ti-calendar-plus'}"></i>
      <span class="pf-ag-txt">${d ? fmtDate(d) : 'Programma visita'}</span>
      <input type="date" value="${d}" data-saved="${d}" onclick="agApriCalendario(this)" oninput="agCampoCambiato(this)" onchange="agCampoCambiato(this)">
    </label>
    <button type="button" class="pf-ag-btn pf-ag-ok" hidden onclick="agCampoSalva(this)">Salva</button>
    ${d ? `<button type="button" class="pf-ag-btn pf-ag-del" title="Togli la visita dall'Agenda" onclick="agCampoTogli(this)">×</button>` : ''}
  </div>`;
}

// Su PC (Chrome/Edge/Firefox) cliccando sul campo data il calendario si apre solo
// sull'iconcina a destra, che qui è invisibile: lo apriamo noi al clic.
// Solo con mouse/trackpad: su iPad/iPhone il tocco lo apre già da sé.
function agApriCalendario(el) {
  if (!window.matchMedia?.('(pointer: fine)').matches || typeof el.showPicker !== 'function') return;
  try { el.showPicker(); } catch { /* browser senza supporto: resta il comportamento normale */ }
}

// Mostra "Salva" solo se la data scelta è diversa da quella in Agenda
function agCampoCambiato(el) {
  const box = el.closest('.pf-agenda');
  const txt = box.querySelector('.pf-ag-txt');
  if (txt) txt.textContent = el.value ? fmtDate(el.value) : (el.dataset.saved ? fmtDate(el.dataset.saved) : 'Programma visita');
  const ok = box.querySelector('.pf-ag-ok');
  if (ok) ok.hidden = !el.value || el.value === el.dataset.saved;
}

async function agCampoSalva(btn) {
  const box = btn.closest('.pf-agenda');
  await _apSalvaDaCampo(box, box.querySelector('input').value);
}

async function agCampoTogli(btn) {
  if (!confirm('Togliere la visita dall\'Agenda?')) return;
  await _apSalvaDaCampo(btn.closest('.pf-agenda'), '');
}

async function _apSalvaDaCampo(box, data) {
  const codice = box.dataset.cod;
  box.querySelectorAll('button, input').forEach(x => { x.disabled = true; });
  try {
    await agendaImpostaProssima(codice, data);
  } catch (e) {
    alert('Errore salvataggio agenda: ' + (e.message || e));
    // Riallinea comunque il campo a quello che c'è davvero in Agenda
    try { const v = await _apProssimaCliente(String(codice)); _apAggiornaCampi(codice, v?.data || ''); }
    catch { box.querySelectorAll('button, input').forEach(x => { x.disabled = false; }); }
  }
}

// Ridisegna tutti i campi a video dello stesso cliente (Proiezione, Pipeline, Dettaglio)
function _apAggiornaCampi(codice, data) {
  document.querySelectorAll('.pf-agenda[data-cod]').forEach(box => {
    if (box.dataset.cod !== String(codice)) return;
    box.outerHTML = agendaCampoHtml(codice, data, { compact: box.dataset.compact === '1' });
  });
}
