// ── Budget page ───────────────────────────────────────────────────────────────

let _budgetTab      = 'mensile';
let _bcFilter       = null;   // stato filter chip attivo
let _bcSort         = { col: 'priority', dir: 1 };
let _bcRows         = [];
let _bcQuery        = '';
let _bcRitmi        = {};     // codice_cliente → ritmo (calcolaRitmoOrdini result)
let _plModifiche    = {};     // codice_cliente → { escluso, gapPersonalizzato, stati }

// ── Tab switch ────────────────────────────────────────────────────────────────
function swBudget(tab, btn) {
  _budgetTab = tab;
  document.querySelectorAll('.budget-tab').forEach(t => t.classList.remove('on'));
  document.querySelectorAll('.budget-pane').forEach(p => p.classList.remove('on'));
  document.getElementById('bpane-' + tab)?.classList.add('on');
  btn.classList.add('on');
  if (tab === 'dettaglio') renderDettaglioPipeline();
}

async function loadBudget() {
  await Promise.all([loadBudgetMensile(), loadBudgetClienti(), loadBudgetPremio()]);
}

// ── Helpers formatters ────────────────────────────────────────────────────────
const _eur  = n => n != null ? '€ ' + Math.round(n).toLocaleString('it-IT') : '—';
const _pct  = n => n != null ? (n >= 0 ? '+' : '') + Number(n).toFixed(1).replace('.', ',') + '%' : '—';
const _cls  = n => n == null ? '' : n >= 0 ? 'pos' : 'neg';
const _mini = (val, tot, color) => {
  const w = tot > 0 ? Math.min(100, (val / tot) * 100) : 0;
  return `<div class="b-bbg"><div class="b-bfill" style="width:${w.toFixed(1)}%;background:${color}"></div></div>`;
};
const _nomeMese = s => {
  if (!s) return '';
  const nomi = ['gennaio','febbraio','marzo','aprile','maggio','giugno',
                'luglio','agosto','settembre','ottobre','novembre','dicembre'];
  const d = new Date(s); return isNaN(d) ? '' : nomi[d.getMonth()] + ' ' + d.getFullYear();
};

// ── TAB PREMIO ────────────────────────────────────────────────────────────────

const PR_BASE  = 833.3333333333334;
const PR_FASCE = [
  { label: 'minima',    delta: -0.2, mult: 0   },
  { label: 'bassa',     delta: -0.1, mult: 0.5 },
  { label: 'obiettivo', delta:  0,   mult: 1   },
  { label: 'alta',      delta:  0.1, mult: 1.5 },
  { label: 'massima',   delta:  0.2, mult: 2   },
];
const PR_C4C_FISSO = PR_BASE * 0.20 * 2;  // €333 fisso max

let _prObjFat = 0;
let _prObjStr = 0;

function _prInterpola(val, obj) {
  if (obj <= 0) return 0;
  const ratio = (val - obj) / obj;
  if (ratio <= -0.2) return 0;
  if (ratio >= 0.2)  return 2;
  for (let i = 1; i < PR_FASCE.length; i++) {
    if (ratio <= PR_FASCE[i].delta) {
      const t = (ratio - PR_FASCE[i-1].delta) / (PR_FASCE[i].delta - PR_FASCE[i-1].delta);
      return PR_FASCE[i-1].mult + t * (PR_FASCE[i].mult - PR_FASCE[i-1].mult);
    }
  }
  return 0;
}

function prCalc() {
  const fat    = parseFloat(document.getElementById('pr-inp-fat')?.value) || 0;
  const str    = parseFloat(document.getElementById('pr-inp-str')?.value) || 0;
  const newCli = parseFloat(document.getElementById('pr-inp-new')?.value) || 0;

  const mFat = _prInterpola(fat, _prObjFat);
  const mStr = _prInterpola(str, _prObjStr);

  const pFat = PR_BASE * 0.65 * mFat;
  const pStr = PR_BASE * 0.15 * mStr;
  const pNew = newCli * 0.02;
  const tot  = pFat + pStr + PR_C4C_FISSO + pNew;
  const rag  = PR_BASE > 0 ? tot / PR_BASE : 0;

  const pctFat = _prObjFat > 0 ? fat / _prObjFat : 0;
  const pctStr = _prObjStr > 0 ? str / _prObjStr : 0;
  const _fmtPct = n => (n * 100).toFixed(1).replace('.', ',') + '%';
  const _barClr = pct => pct >= 1 ? '#2D7D4F' : pct >= 0.8 ? '#378ADD' : '#C84B2F';
  const el = id => document.getElementById(id);
  if (!el('pr-pct-fat')) return;

  el('pr-pct-fat').textContent      = _fmtPct(pctFat) + ' obj';
  el('pr-pct-str').textContent      = _fmtPct(pctStr) + ' obj';
  el('pr-bar-fat').style.width      = Math.min(pctFat * 100, 100) + '%';
  el('pr-bar-fat').style.background = _barClr(pctFat);
  el('pr-bar-str').style.width      = Math.min(pctStr * 100, 100) + '%';
  el('pr-bar-str').style.background = _barClr(pctStr);
  el('pr-bar-new').style.width      = Math.min(newCli / 5000 * 100, 100) + '%';
  el('pr-val-fat').textContent      = _eur(pFat);
  el('pr-val-fat').style.color      = pFat > 0 ? '#2D7D4F' : '#C84B2F';
  el('pr-val-str').textContent      = _eur(pStr);
  el('pr-val-str').style.color      = pStr > 0 ? '#2D7D4F' : '#C84B2F';
  el('pr-val-new').textContent      = _eur(pNew);
  el('pr-tot-val').textContent      = _eur(tot);
  el('pr-tot-val').style.color      = rag >= 1 ? '#2D7D4F' : rag >= 0.5 ? '#D97706' : '#C84B2F';
  el('pr-tot-pct').textContent      = Math.round(rag * 100) + '%';

  let fascia = '—';
  if      (rag >= 2)    fascia = 'fascia massima (+20%)';
  else if (rag >= 1.5)  fascia = 'fascia alta (+10%)';
  else if (rag >= 1)    fascia = 'fascia obiettivo';
  else if (rag >= 0.5)  fascia = 'fascia intermedia (–10%)';
  else                  fascia = 'sotto soglia minima';
  el('pr-tot-fascia').textContent = fascia;

  // Tabella fasce
  const tbody = el('pr-fascia-tbody');
  if (!tbody) return;
  const ratioFat = _prObjFat > 0 ? (fat - _prObjFat) / _prObjFat : -1;
  tbody.innerHTML = PR_FASCE.map(f => {
    const pF    = PR_BASE * 0.65 * f.mult;
    const pS    = PR_BASE * 0.15 * f.mult;
    const totF  = pF + pS + PR_C4C_FISSO;
    const isAct = ratioFat >= f.delta - 0.05 && ratioFat < f.delta + 0.05;
    return `<tr class="${isAct ? 'pr-active' : ''}">
      <td>${f.label}</td>
      <td>${f.delta >= 0 ? '+' : ''}${(f.delta * 100).toFixed(0)}%</td>
      <td>${f.mult}x</td>
      <td>${_eur(pF)}</td>
      <td>${_eur(pS)}</td>
      <td>${_eur(PR_C4C_FISSO)}</td>
      <td>${_eur(totF)}</td>
    </tr>`;
  }).join('');
}

async function loadBudgetPremio() {
  const root = document.getElementById('bpane-premio');
  if (!root) return;
  try {
    const now       = new Date();
    const today     = now.toISOString().split('T')[0];
    const startMese = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const endMese   = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
    const [{ data: bArr }, { data: focus }, rows, { data: cediRaw }] = await Promise.all([
      sb.from('budget').select('budget_mese,evaso,data_aggiornamento')
        .lte('data_aggiornamento', today)
        .not('budget_mese', 'is', null)
        .order('data_aggiornamento', { ascending: false }).limit(1),
      sb.from('budget_focus').select('*')
        .lte('data_aggiornamento', today)
        .order('data_aggiornamento', { ascending: false }),
      loadRollingEnriched(),
      sb.from('cedi_ridistribuito')
        .select('valore_ridistribuito, data_aggiornamento')
        .gte('data_aggiornamento', startMese).lte('data_aggiornamento', endMese)
        .order('data_aggiornamento', { ascending: false }),
    ]);

    const b        = bArr?.[0];
    const g1       = focus?.find(f => f.gruppo_prodotti.startsWith('Gruppo 1'));
    const meseNome = _nomeMese(b?.data_aggiornamento);

    // Consegnato del mese = stesso calcolo della dashboard (rolling + CEDI)
    const totCons   = rows.reduce((s, r) => s + (r.mese_consegnato || 0), 0);
    const cediArr   = cediRaw || [];
    const cediDate  = cediArr.length ? cediArr[0].data_aggiornamento : '';
    const totCEDI   = cediArr.filter(r => r.data_aggiornamento === cediDate)
                             .reduce((s, r) => s + (r.valore_ridistribuito || 0), 0);
    const consMese  = totCons + totCEDI;

    _prObjFat = b?.budget_mese    || 117192;
    _prObjStr = g1?.target_eur    || 4217.75;
    const initFat = consMese  || b?.evaso || 0;
    const initStr = g1?.consegnato_eur || 0;

    root.innerHTML = `
      <p class="b-sec">simulatore premio variabile — Cubaiu Loris 400542</p>
      <p style="font-size:12px;color:var(--text2);margin-bottom:1rem">
        Premio annuo: <strong>€ 10.000</strong> · mensile base: <strong>€ 833</strong> ·
        Fatturato zona e prodotti strategici precompilati da Supabase (${meseNome || '—'}) e modificabili.
        C4C e task fissi al massimo (20%).
      </p>

      <div class="b-panel">
        <div class="pr-row">
          <div class="pr-row-name">
            <div class="pr-row-title">fatturato zona di competenza</div>
            <div class="pr-row-sub">obiettivo ${_eur(_prObjFat)} · peso 65% · <span style="color:var(--text)">consegnato mese: ${_eur(consMese)}</span></div>
          </div>
          <div class="pr-row-input">
            <input type="number" id="pr-inp-fat" value="${Math.round(initFat)}" step="1" min="0" readonly oninput="prCalc()">
            <span class="pr-row-pct" id="pr-pct-fat">—</span>
          </div>
          <div class="pr-bbg"><div class="pr-bfill" id="pr-bar-fat" style="background:#378ADD;width:0%"></div></div>
          <div class="pr-val" id="pr-val-fat">€ 0</div>
        </div>

        <div class="pr-row">
          <div class="pr-row-name">
            <div class="pr-row-title">prodotti strategici (focus)</div>
            <div class="pr-row-sub">DUOBLADE · DuoHM · FBS II · HybridPower · FIS EM Plus · FIS A · PowerFast II · PowerFull II · obiettivo ${_eur(_prObjStr)} · peso 15%</div>
          </div>
          <div class="pr-row-input">
            <input type="number" id="pr-inp-str" value="${initStr}" step="100" min="0" oninput="prCalc()">
            <span class="pr-row-pct" id="pr-pct-str">—</span>
          </div>
          <div class="pr-bbg"><div class="pr-bfill" id="pr-bar-str" style="background:#378ADD;width:0%"></div></div>
          <div class="pr-val" id="pr-val-str">€ 0</div>
        </div>

        <div class="pr-row">
          <div class="pr-row-name">
            <div class="pr-row-title">note visite C4C <span class="pr-fisso">fisso max</span></div>
            <div class="pr-row-sub">obiettivo 90% · peso 10% · valore fisso: 100%</div>
          </div>
          <div class="pr-row-input"><span style="font-size:13px;color:var(--text2)">100%</span></div>
          <div class="pr-bbg"><div class="pr-bfill" style="background:#2D7D4F;width:100%"></div></div>
          <div class="pr-val" style="color:#2D7D4F">€ 167</div>
        </div>

        <div class="pr-row">
          <div class="pr-row-name">
            <div class="pr-row-title">task C4C quantità <span class="pr-fisso">fisso max</span></div>
            <div class="pr-row-sub">obiettivo 10 task · peso 5% · valore fisso: 18</div>
          </div>
          <div class="pr-row-input"><span style="font-size:13px;color:var(--text2)">18</span></div>
          <div class="pr-bbg"><div class="pr-bfill" style="background:#2D7D4F;width:100%"></div></div>
          <div class="pr-val" style="color:#2D7D4F">€ 83</div>
        </div>

        <div class="pr-row">
          <div class="pr-row-name">
            <div class="pr-row-title">task C4C qualità <span class="pr-fisso">fisso max</span></div>
            <div class="pr-row-sub">obiettivo 90% · peso 5% · valore fisso: 100%</div>
          </div>
          <div class="pr-row-input"><span style="font-size:13px;color:var(--text2)">100%</span></div>
          <div class="pr-bbg"><div class="pr-bfill" style="background:#2D7D4F;width:100%"></div></div>
          <div class="pr-val" style="color:#2D7D4F">€ 83</div>
        </div>

        <div class="pr-row">
          <div class="pr-row-name">
            <div class="pr-row-title">clienti nuovi</div>
            <div class="pr-row-sub">peso 2% sul fatturato · clienti senza fatturato 2024/2025</div>
          </div>
          <div class="pr-row-input">
            <input type="number" id="pr-inp-new" value="0" step="100" min="0" oninput="prCalc()">
            <span class="pr-row-pct">fat. clienti nuovi</span>
          </div>
          <div class="pr-bbg"><div class="pr-bfill" id="pr-bar-new" style="background:#378ADD;width:0%"></div></div>
          <div class="pr-val" id="pr-val-new">€ 0</div>
        </div>
      </div>

      <div class="pr-totale">
        <div>
          <div class="pr-tot-label">premio stimato ${meseNome || '—'}</div>
          <div class="pr-tot-val" id="pr-tot-val">€ 0</div>
          <div class="pr-tot-sub">base mensile: € 833 · annuo: € 10.000</div>
        </div>
        <div style="text-align:right">
          <div class="pr-tot-label">raggiungimento obiettivo</div>
          <div class="pr-tot-pct" id="pr-tot-pct">0%</div>
          <div class="pr-fascia" id="pr-tot-fascia">—</div>
        </div>
      </div>

      <p class="b-sec" style="margin-top:1.5rem">tabella fasce premio mensile</p>
      <div class="b-panel">
        <table class="pr-ftbl">
          <thead><tr>
            <th>fascia</th><th>scostamento obj</th><th>moltiplicatore</th>
            <th>fatturato zona (65%)</th><th>prod. strategici (15%)</th>
            <th>C4C + task (20%)</th><th>totale premio</th>
          </tr></thead>
          <tbody id="pr-fascia-tbody"></tbody>
        </table>
      </div>`;

    prCalc();

  } catch(err) {
    document.getElementById('bpane-premio').innerHTML =
      `<p style="color:var(--red);padding:1rem">Errore: ${err.message}</p>`;
  }
}

// ── TAB MENSILE ───────────────────────────────────────────────────────────────

let _bmData   = null;
let _bmFocus  = null;
let _bmCedi   = 0;
let _bmCediOn = false;

async function loadBudgetMensile() {
  const root = document.getElementById('bpane-mensile');
  if (!root) return;
  try {
    const now       = new Date();
    const today     = now.toISOString().split('T')[0];
    const startMese = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const endMese   = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
    const [{ data: latestArr, error: bErr }, { data: bMonthArr }, { data: cediRaw }] = await Promise.all([
      sb.from('budget').select('*').lte('data_aggiornamento', today)
        .order('data_aggiornamento', { ascending: false }).limit(1),
      sb.from('budget').select('*').lte('data_aggiornamento', today)
        .not('budget_mese', 'is', null)
        .order('data_aggiornamento', { ascending: false }).limit(1),
      sb.from('cedi_ridistribuito').select('valore_ridistribuito, data_aggiornamento')
        .gte('data_aggiornamento', startMese).lte('data_aggiornamento', endMese)
        .order('data_aggiornamento', { ascending: false }),
    ]);
    if (bErr) throw bErr;
    const latest = latestArr?.[0];
    const bMonth = bMonthArr?.[0];
    _bmData = bMonth
      ? { ...bMonth, ...Object.fromEntries(Object.entries(latest || {}).filter(([, v]) => v != null)) }
      : latest;
    const { data: focus } = _bmData
      ? await sb.from('budget_focus').select('*').eq('data_aggiornamento', _bmData.data_aggiornamento).order('gruppo_prodotti')
      : { data: [] };
    _bmFocus = focus;
    const cediArr  = cediRaw || [];
    const cediDate = cediArr.length ? cediArr[0].data_aggiornamento : '';
    _bmCedi   = cediArr.filter(r => r.data_aggiornamento === cediDate)
                       .reduce((s, r) => s + (r.valore_ridistribuito || 0), 0);
    _bmCediOn = false;

    if (!_bmData) {
      root.innerHTML = '<p style="color:var(--text2);padding:1rem">Nessun dato budget.<br>Importa il PDF Avanzamento tramite il flusso Wilson Sync.</p>';
      return;
    }
    _renderBudgetMensile(root);
  } catch(err) {
    document.getElementById('bpane-mensile').innerHTML =
      `<p style="color:var(--red);padding:1rem">Errore: ${err.message}</p>`;
  }
}

function toggleCediMensile() {
  _bmCediOn = !_bmCediOn;
  _renderBudgetMensile(document.getElementById('bpane-mensile'));
}

function _renderBudgetMensile(root) {
  const b        = _bmData;
  const focus    = _bmFocus;
  const cediAdd  = _bmCediOn ? _bmCedi : 0;
  const meseNome = _nomeMese(b.data_aggiornamento);
  const pctGiorno = b.obiettivo_giornaliero > 0 ? (b.fatturato_giorno / b.obiettivo_giornaliero) * 100 : null;

  const evaso         = (b.evaso            || 0) + cediAdd;
  const evasoOrdinato = (b.evaso_ordinato_resi || 0) + cediAdd;

  const deltaEur = b.budget_mese > 0 ? evasoOrdinato - b.budget_mese : b.delta_mese_eur;
  const deltaPct = b.budget_mese > 0 ? (evasoOrdinato - b.budget_mese) / b.budget_mese * 100 : b.delta_mese_pct;

  const cediBtn = _bmCedi > 0
    ? `<button onclick="toggleCediMensile()" style="
        margin-left:auto;padding:3px 10px;border-radius:20px;border:1px solid;cursor:pointer;font-size:12px;font-weight:500;
        background:${_bmCediOn ? '#2D7D4F' : 'transparent'};
        color:${_bmCediOn ? '#fff' : 'var(--text2)'};
        border-color:${_bmCediOn ? '#2D7D4F' : 'var(--border)'}">
        + CEDI ${_bmCediOn ? '✓ ' : ''}${_eur(_bmCedi)}
      </button>`
    : '';

  const focusHTML = (focus && focus.length)
    ? focus.map(f => {
        const pF = f.target_eur > 0 ? (f.consegnato_eur / f.target_eur) * 100 : null;
        const w  = Math.min(100, pF ?? 0);
        const lbl = f.gruppo_prodotti.length > 60 ? f.gruppo_prodotti.slice(0, 60) + '…' : f.gruppo_prodotti;
        return `<tr>
          <td style="font-size:12px;color:var(--text2)">${lbl}</td>
          <td class="num-right">${_eur(f.target_eur)}</td>
          <td class="num-right">
            <div class="b-inline-bar">
              <div class="b-mini-bg"><div class="b-mini-fill" style="width:${w.toFixed(0)}%;background:#378ADD"></div></div>
              ${_eur(f.consegnato_eur)}
            </div>
          </td>
          <td class="num-right" style="color:#378ADD;font-weight:500">${pF != null ? pF.toFixed(0) + '%' : '—'}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="4" style="color:var(--text2);font-size:12px;padding:8px 0">Nessun dato focus per questa data</td></tr>';

  root.innerHTML = `
      <p class="b-sec">progressivo gen–apr · ${fmtDate(b.data_aggiornamento)}</p>
      <div class="b-g4">
        <div class="b-kcard"><p class="b-klabel">budget gen–apr</p><p class="b-kval">${_eur(b.budget_gen_apr)}</p></div>
        <div class="b-kcard"><p class="b-klabel">fatturato gen–apr</p><p class="b-kval">${_eur(b.fatturato_gen_apr)}</p></div>
        <div class="b-kcard"><p class="b-klabel">delta su budget</p><p class="b-kval ${_cls(b.delta_budget_eur)}">${b.delta_budget_eur >= 0 ? '+' : ''}${_eur(b.delta_budget_eur)}</p><p class="b-ksub ${_cls(b.delta_budget_pct)}">${_pct(b.delta_budget_pct)}</p></div>
      </div>

      <p class="b-sec" style="display:flex;align-items:center">${meseNome} · giorno ${b.giorno_lavorativo ?? '?'} di ${b.giorni_totali ?? '?'}${cediBtn}</p>
      <div class="b-panel">
        <div class="b-prow"><span class="b-prow-label">consegnato al ${fmtDate(b.data_aggiornamento)}${_bmCediOn ? ' <span style="color:#2D7D4F;font-size:11px">+CEDI</span>' : ''}</span><span class="b-prow-val">${_eur(evaso)} <span>/ ${_eur(b.budget_mese)}</span></span></div>
        ${_mini(evaso, b.budget_mese, '#378ADD')}
        <div style="margin-bottom:10px"></div>
        <div class="b-prow"><span class="b-prow-label">consegnato + ordinato – resi${_bmCediOn ? ' <span style="color:#2D7D4F;font-size:11px">+CEDI</span>' : ''}</span><span class="b-prow-val">${_eur(evasoOrdinato)} <span>/ ${_eur(b.budget_mese)}</span></span></div>
        ${_mini(evasoOrdinato, b.budget_mese, '#2D7D4F')}
        <div class="b-hint"><span>Budget ${meseNome}: ${_eur(b.budget_mese)}</span><span class="${_cls(deltaEur)}">delta budget: ${_pct(deltaPct)} (${deltaEur >= 0 ? '+' : ''}${_eur(deltaEur)})</span></div>
      </div>

      <div class="b-g4">
        <div class="b-kcard"><p class="b-klabel">ordinato nel mese</p><p class="b-kval" style="font-size:17px">${_eur(b.ordinato_nel_mese)}</p></div>
        <div class="b-kcard"><p class="b-klabel">ordinato oltre mese</p><p class="b-kval" style="font-size:17px">${_eur(b.ordinato_oltre_mese)}</p></div>
        <div class="b-kcard"><p class="b-klabel">resi / correzioni</p><p class="b-kval neg" style="font-size:17px">${_eur(b.resi)}</p></div>
        <div class="b-kcard"><p class="b-klabel">fat. ${meseNome} anno prec</p><p class="b-kval" style="font-size:17px">${_eur(b.fatturato_mese_anno_prec)}</p></div>
      </div>

      <p class="b-sec">avanzamento giornaliero — giorno ${b.giorno_lavorativo ?? '?'}</p>
      <div class="b-panel">
        <div class="b-g4" style="margin-bottom:10px">
          <div style="text-align:center"><p class="b-klabel" style="text-align:center">obiettivo</p><p class="b-kval" style="font-size:17px;text-align:center">${_eur(b.obiettivo_giornaliero)}</p></div>
          <div style="text-align:center"><p class="b-klabel" style="text-align:center">fatturato giorno ${b.giorno_lavorativo}</p><p class="b-kval ${_cls(b.fatturato_giorno - b.obiettivo_giornaliero)}" style="font-size:17px;text-align:center">${_eur(b.fatturato_giorno)}</p></div>
          <div style="text-align:center"><p class="b-klabel" style="text-align:center">ordini inseriti ieri</p><p class="b-kval" style="font-size:17px;text-align:center">${_eur(b.valore_ordini_ieri)}</p></div>
          <div style="text-align:center"><p class="b-klabel" style="text-align:center">nr ordini ieri</p><p class="b-kval" style="font-size:17px;text-align:center">${b.nr_ordini_ieri ?? '—'}</p></div>
        </div>
        ${_mini(b.fatturato_giorno, b.obiettivo_giornaliero, '#378ADD')}
        <div class="b-hint"><span>obiettivo: ${_eur(b.obiettivo_giornaliero)}</span><span>fatturato: ${_eur(b.fatturato_giorno)} <span class="${_cls(b.fatturato_giorno - b.obiettivo_giornaliero)}">(${_pct(pctGiorno ? pctGiorno - 100 : null)})</span></span></div>
      </div>

      <p class="b-sec">prodotti focus — ${meseNome}</p>
      <div class="b-panel">
        <table class="b-tbl">
          <thead><tr><th>gruppo</th><th style="text-align:right">target</th><th style="text-align:right">consegnato</th><th style="text-align:right">%</th></tr></thead>
          <tbody>${focusHTML}</tbody>
        </table>
      </div>`;
}

// ── TAB CLIENTI ───────────────────────────────────────────────────────────────

// Priorità visita/stimolo: 0=massima urgenza
// 0 ordina_di_persona + non ha ancora ordinato
// 1 non ha ordinato questo mese ma lo scorso anno sì
// 2 indietro (ha ordinato ma < 40% anno scorso)
// 3 non ha ordinato, nessuno storico mensile
// 4 da_stimolare (40-79%)
// 5 in_linea  6 ottimo  7 nuovo  8 inattivo
function _bcPriority(r) {
  const statoId = r._stato?.id || 'inattivo';
  if (statoId === 'da_visitare') {
    if (r._ordinaDiPersona) return 0;
    if (r.bud > 0)          return 1;
    return 3;
  }
  return { indietro: 2, da_stimolare: 4, in_linea: 5, ottimo: 6, nuovo: 7, inattivo: 8 }[statoId] ?? 9;
}
const STATO_COLOR = { ottimo: '#2D7D4F', in_linea: '#378ADD', da_stimolare: '#D97706', indietro: '#C84B2F', da_visitare: '#9B9B97', nuovo: '#378ADD', inattivo: '#9B9B97' };

async function loadBudgetClienti() {
  const root = document.getElementById('bpane-clienti');
  if (!root) return;
  root.innerHTML = '<div class="loading">Caricamento pipeline…</div>';
  try {
    _latestRollingDate = null;
    _rollingEnriched   = null;

    const cutoff = new Date(Date.now() - 730 * 86400000).toISOString().split('T')[0];
    const [rows, { data: ordiniAll }] = await Promise.all([
      loadRollingEnriched(),
      sb.from('ordini')
        .select('codice_cliente, data_ordine, totale_ordine')
        .neq('stato', 'annullato')
        .gte('data_ordine', cutoff)
        .order('data_ordine', { ascending: false })
        .limit(5000),
    ]);

    if (!rows.length) {
      root.innerHTML = '<p style="color:var(--text2);padding:1rem">Nessun dato rolling disponibile.</p>';
      return;
    }

    // Raggruppa ordini per cliente e calcola ritmo
    const ordiniByCliente = {};
    for (const o of (ordiniAll || [])) {
      if (!ordiniByCliente[o.codice_cliente]) ordiniByCliente[o.codice_cliente] = [];
      ordiniByCliente[o.codice_cliente].push(o);
    }
    _bcRitmi = {};
    for (const [cod, ordini] of Object.entries(ordiniByCliente)) {
      _bcRitmi[cod] = calcolaRitmoOrdini(ordini);
    }

    _bcRows = rows.filter(r => !r._escluso).map(r => {
      const ritmo = _bcRitmi[r.codice_cliente] || null;
      const row = {
        cliente:          r.ragione_sociale || '—',
        codice:           r.codice_cliente  || '',
        divisione:        r.divisione || '',
        stato:            r._stato,
        _ordinaDiPersona: r._ordinaDiPersona || false,
        _media:     r._media                 || 0,
        bud:        r.fatt_mese_anno_prec    || 0,
        ord:        r.spedito_ordinato_mese  || 0,
        cons:       r.mese_consegnato        || 0,
        prep:       r.mese_in_preparazione   || 0,
        sped:       r.mese_da_spedire        || 0,
        oltre:      r.ordinato_oltre_mese    || 0,
        prog26:     r.fatt_prog_anno_corr    || 0,
        prog25:     r.fatt_prog_anno_prec    || 0,
        varProg:    r.fatt_prog_anno_prec > 0
                      ? (r.fatt_prog_anno_corr - r.fatt_prog_anno_prec) / r.fatt_prog_anno_prec * 100
                      : null,
        gap:        r._gap || 0,
        ritmo,
        urgenza:    ritmo?.urgenza || 'nessun_ordine',
      };
      row.priority = _bcPriority(row);
      // Applica modifiche salvate se esistono
      const modifica = _plModifiche[row.codice] || {};
      row._esclusoManuale = modifica.escluso === true ? true : false;
      row._gapPersonalizzato = modifica.gapPersonalizzato ?? null;
      row._statiPipeline = modifica.stati || {};
      return row;
    });

    _bcFilter = null;
    _bcQuery  = '';
    _bcSort   = { col: 'priority', dir: 1 };
    _renderClienti(root);
    renderDettaglioPipeline();
  } catch(err) {
    root.innerHTML = `<p style="color:var(--red);padding:1rem">Errore: ${err.message}</p>`;
  }
}

function _renderClienti(root) {
  const rows = _bcRows;
  if (!rows.length) return;

  // Aggregati totali
  const totBud   = rows.reduce((s, r) => s + r.bud,    0);
  const totOrd   = rows.reduce((s, r) => s + r.ord,    0);
  const totGap   = rows.reduce((s, r) => s + r.gap,    0);
  const totP26   = rows.reduce((s, r) => s + r.prog26, 0);
  const totP25   = rows.reduce((s, r) => s + r.prog25, 0);
  const dProg    = totP25 > 0 ? (totP26 - totP25) / totP25 * 100 : null;
  const dMese    = totBud > 0 ? (totOrd - totBud) / totBud * 100 : null;

  // Aggrega per stato
  const byStato = {};
  for (const r of rows) {
    const id = r.stato?.id || 'inattivo';
    if (!byStato[id]) byStato[id] = { count: 0, gap: 0 };
    byStato[id].count++;
    byStato[id].gap += r.gap;
  }

  // Chip html
  const allCount = rows.length;
  const chipHtml = [
    { id: '',            label: 'Tutti',         color: '#6B6860' },
    { id: 'indietro',    label: 'Indietro',       color: STATO_COLOR.indietro },
    { id: 'da_visitare', label: 'Da visitare',    color: STATO_COLOR.da_visitare },
    { id: 'da_stimolare',label: 'Da stimolare',   color: STATO_COLOR.da_stimolare },
    { id: 'in_linea',    label: 'In linea',       color: STATO_COLOR.in_linea },
    { id: 'ottimo',      label: 'Ottimo',         color: STATO_COLOR.ottimo },
    { id: 'inattivo',    label: 'Inattivo/Nuovo', color: STATO_COLOR.inattivo },
  ].map(c => {
    const cnt  = c.id ? (byStato[c.id]?.count || 0) : allCount;
    const gap  = c.id ? (byStato[c.id]?.gap   || 0) : totGap;
    if (c.id && cnt === 0) return '';
    const on      = (_bcFilter || '') === c.id ? 'on' : '';
    const gapStr  = gap > 0 ? ` · –${_eur(gap)}` : '';
    // data-stato invece di inline JSON per evitare quoting HTML
    return `<button class="bc-chip ${on}" data-stato="${c.id}" style="--chip-c:${c.color}" onclick="setBcFilter(this.dataset.stato)">${c.label} <span class="bc-chip-cnt">${cnt}${gapStr}</span></button>`;
  }).join('');

  // Filtro + sort + render righe
  // Clienti con ordini scaduti o urgenti (per KPI strip)
  const nUrgenti  = rows.filter(r => r.urgenza === 'urgente').length;
  const nScaduti  = rows.filter(r => r.urgenza === 'scaduto').length;

  const html = `
    <div class="bc-kpi-strip">
      <div class="bc-kpi"><div class="bc-kpi-label">budget mese</div><div class="bc-kpi-val">${_eur(totBud)}</div></div>
      <div class="bc-kpi"><div class="bc-kpi-label">ordinato mese</div><div class="bc-kpi-val ${_cls(dMese)}">${_eur(totOrd)}</div><div class="bc-kpi-sub ${_cls(dMese)}">${_pct(dMese)} vs anno prec</div></div>
      <div class="bc-kpi bc-kpi-neg"><div class="bc-kpi-label">gap da recuperare</div><div class="bc-kpi-val neg">–${_eur(totGap)}</div></div>
      <div class="bc-kpi"><div class="bc-kpi-label">progressivo 2026</div><div class="bc-kpi-val">${_eur(totP26)}</div><div class="bc-kpi-sub ${_cls(dProg)}">${_pct(dProg)} vs 2025</div></div>
      ${nScaduti > 0 ? `<div class="bc-kpi bc-kpi-neg"><div class="bc-kpi-label">ordine scaduto</div><div class="bc-kpi-val neg">${nScaduti} clienti</div></div>` : ''}
      ${nUrgenti > 0 ? `<div class="bc-kpi bc-kpi-warn"><div class="bc-kpi-label">ordine urgente</div><div class="bc-kpi-val warn">${nUrgenti} clienti</div></div>` : ''}
    </div>
    <div class="bc-chips" id="bc-chips">${chipHtml}</div>
    <div class="bc-toolbar">
      <input type="text" class="b-srch" id="bc-srch" placeholder="cerca cliente…" value="${_bcQuery}" oninput="onBcSearch(this.value)">
    </div>
    <div class="b-panel" style="padding:.5rem 1rem;overflow-x:auto">
      <table class="b-tbl bc-tbl" id="bc-table">
        <thead><tr>
          <th class="bc-th-stato bc-srt" onclick="onBcSort('priority')">STATO ${_sortArrow('priority')}</th>
          <th class="bc-th-cliente bc-srt" onclick="onBcSort('cliente')">CLIENTE ${_sortArrow('cliente')}</th>
          <th class="bc-th-quando bc-srt" onclick="onBcSort('urgenza')">PROSSIMO ORDINE ${_sortArrow('urgenza')}</th>
          <th class="bc-th-num bc-srt" onclick="onBcSort('ord')">ORDINATO MESE ${_sortArrow('ord')}</th>
          <th class="bc-th-narrow bc-srt" onclick="onBcSort('varMese')">Δ% MESE ${_sortArrow('varMese')}</th>
          <th class="bc-th-num bc-srt" onclick="onBcSort('gap')">GAP ${_sortArrow('gap')}</th>
          <th class="bc-th-detail">CONS · PREP · SPED</th>
          <th class="bc-th-num bc-srt" onclick="onBcSort('prog26')">PROG 2026 ${_sortArrow('prog26')}</th>
          <th class="bc-th-narrow bc-srt" onclick="onBcSort('varProg')">Δ% PROG ${_sortArrow('varProg')}</th>
          <th style="width:36px"></th>
        </tr></thead>
        <tbody id="bc-tbody"></tbody>
      </table>
    </div>`;

  root.innerHTML = html;
  _renderBcRows();
}

function _sortArrow(col) {
  if (_bcSort.col !== col) return '<span style="opacity:.3">↕</span>';
  return _bcSort.dir === 1 ? '↓' : '↑';
}

function _renderBcRows() {
  const tbody = document.getElementById('bc-tbody');
  if (!tbody) return;

  // Filtro stato + ricerca
  let visible = _bcRows.filter(r => {
    if (_bcFilter) {
      const id = r.stato?.id || 'inattivo';
      // chip "inattivo" copre anche "nuovo"
      if (_bcFilter === 'inattivo' ? (id !== 'inattivo' && id !== 'nuovo') : id !== _bcFilter) return false;
    }
    if (_bcQuery) return r.cliente.toLowerCase().includes(_bcQuery.toLowerCase());
    return true;
  });

  const _urgScore = u => ({ scaduto: 0, urgente: 1, ok: 2, nessun_ordine: 3 }[u] ?? 3);

  // Sort
  const { col, dir } = _bcSort;
  visible.sort((a, b) => {
    let va, vb;
    if (col === 'priority') { va = a.priority; vb = b.priority; }
    else if (col === 'cliente') { return dir * a.cliente.localeCompare(b.cliente, 'it'); }
    else if (col === 'urgenza') { va = _urgScore(a.urgenza); vb = _urgScore(b.urgenza); }
    else if (col === 'ord')     { va = a.ord;    vb = b.ord; }
    else if (col === 'gap')     { va = a.gap;    vb = b.gap; }
    else if (col === 'prog26')  { va = a.prog26; vb = b.prog26; }
    else if (col === 'varMese') { va = a.bud > 0 ? (a.ord - a.bud) / a.bud : -999; vb = b.bud > 0 ? (b.ord - b.bud) / b.bud : -999; }
    else if (col === 'varProg') { va = a.varProg ?? -999; vb = b.varProg ?? -999; }
    else { va = a.priority; vb = b.priority; }
    // Tiebreaker: urgenza dentro stesso gruppo, poi gap desc
    if (col === 'priority' && va === vb) {
      const us = _urgScore(a.urgenza) - _urgScore(b.urgenza);
      if (us !== 0) return us;
      return b.gap - a.gap;
    }
    return dir * (va - vb);
  });

  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="padding:1.5rem;text-align:center;color:var(--text2)">Nessun cliente trovato</td></tr>`;
    return;
  }

  tbody.innerHTML = visible.map(r => {
    const statoId    = r.stato?.id || 'inattivo';
    const statoColor = STATO_COLOR[statoId] || '#9B9B97';
    const statoBadge = `<span class="bc-stato" style="background:${statoColor}20;color:${statoColor};border-color:${statoColor}40">${r.stato?.label || '—'}</span>`;

    const barColor   = statoColor;
    const barW       = r.bud > 0 ? Math.min(100, r.ord / r.bud * 100) : 0;
    const varMese    = r.bud > 0 ? (r.ord - r.bud) / r.bud * 100 : null;
    const varMeseBadge = varMese != null
      ? `<span class="bc-badge ${varMese >= 0 ? 'bc-bdg-pos' : varMese >= -20 ? 'bc-bdg-neu' : 'bc-bdg-neg'}">${_pct(varMese)}</span>`
      : '<span class="bc-badge bc-bdg-gray">—</span>';
    const varProgBadge = r.varProg != null
      ? `<span class="bc-badge ${r.varProg >= 0 ? 'bc-bdg-pos' : 'bc-bdg-neg'}">${_pct(r.varProg)}</span>`
      : '<span class="bc-badge bc-bdg-gray">—</span>';

    const gapCell = r.gap > 0
      ? `<span class="neg" style="font-weight:500">–${_eur(r.gap)}</span>`
      : `<span class="pos" style="font-size:11px">in target</span>`;

    const dettaglio = [
      r.cons > 0 ? `<span class="bc-det-item">Cons. ${_eur(r.cons)}</span>` : '',
      r.prep > 0 ? `<span class="bc-det-item bc-det-prep">Prep. ${_eur(r.prep)}</span>` : '',
      r.sped > 0 ? `<span class="bc-det-item bc-det-sped">Sped. ${_eur(r.sped)}</span>` : '',
      r.oltre > 0 ? `<span class="bc-det-item bc-det-oltre">+${_eur(r.oltre)} oltre</span>` : '',
    ].filter(Boolean).join(' ');

    // Quando / prossimo ordine
    let quandoCell = '<span style="color:var(--text2);font-size:11px">nessun ordine</span>';
    if (r.ritmo) {
      const { giorniDaUltimo, freqMedia, prossimo, urgenza } = r.ritmo;
      const urgCls  = { ok: 'bc-urg-ok', urgente: 'bc-urg-urgente', scaduto: 'bc-urg-scaduto' }[urgenza] || '';
      const urgLbl  = { ok: '✓ in tempo', urgente: '⚑ urgente', scaduto: '⚠ scaduto' }[urgenza] || '';
      const proxStr = prossimo
        ? prossimo.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })
        : '—';
      const freqStr = freqMedia ? `ogni ${freqMedia} gg` : '—';
      quandoCell = `<div class="bc-quando">
        <div class="bc-quando-pross">${proxStr} <span class="bc-urg-badge ${urgCls}">${urgLbl}</span></div>
        <div class="bc-quando-sub">${freqStr} · ${giorniDaUltimo} gg fa</div>
      </div>`;
    }

    const nomeEsc = r.cliente.replace(/'/g, "\\'");
    return `<tr class="bc-row bc-row-${statoId} bc-row-click" onclick="apriClienteDaBudget('${r.codice}','${nomeEsc}')">
      <td>${statoBadge}</td>
      <td>
        <div class="bc-cliente-nome">${r.cliente}${r._ordinaDiPersona ? ' <span class="bc-persona-tag">&#9734; di persona</span>' : ''}</div>
        ${r.divisione ? `<div class="bc-cliente-div">${r.divisione}</div>` : ''}
      </td>
      <td>${quandoCell}</td>
      <td>
        <div class="bc-bar-wrap">
          <div class="b-bbg bc-barline"><div class="b-bfill" style="width:${barW.toFixed(1)}%;background:${barColor}"></div></div>
          <div class="bc-bar-vals">${_eur(r.ord)} <span class="bc-bud">/ ${_eur(r.bud)}</span></div>
        </div>
      </td>
      <td>${varMeseBadge}</td>
      <td>${gapCell}</td>
      <td><div class="bc-det">${dettaglio || '<span style="color:var(--text2);font-size:11px">—</span>'}</div></td>
      <td>
        <div style="font-weight:500">${_eur(r.prog26)}</div>
        <div style="font-size:11px;color:var(--text2)">${_eur(r.prog25)} 2025</div>
      </td>
      <td>${varProgBadge}</td>
      <td style="text-align:center">
        <button class="pl-art-btn" title="Verifica articoli" onclick="apriVerificaArticoli('${cod}','${nom}')">📋</button>
      </td>
    </tr>`;
  }).join('');
}

// ── Event handlers clienti ────────────────────────────────────────────────────
function setBcFilter(stato) {
  _bcFilter = stato || null;  // stringa vuota '' → null (chip "Tutti")
  document.querySelectorAll('.bc-chip').forEach(c => {
    c.classList.toggle('on', c.dataset.stato === (stato || ''));
  });
  _renderBcRows();
}

function onBcSearch(q) {
  _bcQuery = q;
  _renderBcRows();
}

function onBcSort(col) {
  if (_bcSort.col === col) _bcSort.dir *= -1;
  else { _bcSort.col = col; _bcSort.dir = col === 'priority' || col === 'urgenza' ? 1 : -1; }
  document.querySelectorAll('.bc-tbl thead th[onclick]').forEach(th => {
    const m = th.getAttribute('onclick')?.match(/onBcSort\('(.+)'\)/);
    if (!m) return;
    const arrow = th.querySelector('span');
    if (arrow) arrow.outerHTML = _sortArrow(m[1]);
  });
  _renderBcRows();
}

function apriClienteDaBudget(codice, nome) {
  _pendingOpenCodice = codice;
  const el = document.getElementById('filtro-clienti');
  if (el) el.value = codice;
  const sel = document.getElementById('filtro-stato');
  if (sel) sel.value = '';
  showPage('clienti', { preventDefault: () => {} });
}

// ── Dettaglio Pipeline ────────────────────────────────────────────────────────

const PIPELINE_GRUPPI = [
  { id: 'da_visitare',  label: 'Da visitare',   color: '#9B9B97' },
  { id: 'indietro',     label: 'Indietro',       color: '#C84B2F' },
  { id: 'da_stimolare', label: 'Da stimolare',   color: '#D97706' },
  { id: 'in_linea',     label: 'In linea',       color: '#378ADD' },
  { id: 'ottimo',       label: 'Ottimo',         color: '#2D7D4F' },
  { id: 'nuovo',        label: 'Nuovo',          color: '#8B5CF6' },
  { id: 'inattivo',     label: 'Inattivo',       color: '#9B9B97' },
];

function renderDettaglioPipeline() {
  const root = document.getElementById('bpane-dettaglio');
  if (!root) return;

  if (!_bcRows.length) {
    root.innerHTML = '<p style="color:var(--text2);padding:1rem">Nessun dato disponibile. Carica prima la pipeline clienti.</p>';
    return;
  }

  const urgLabel = { ok: 'ok', urgente: 'urgente', scaduto: 'scaduto', nessun_ordine: '—' };
  const urgColor = { ok: '#2D7D4F', urgente: '#D97706', scaduto: '#C84B2F', nessun_ordine: '#9B9B97' };

  const byGruppo = {};
  for (const g of PIPELINE_GRUPPI) byGruppo[g.id] = [];
  for (const r of _bcRows) {
    const sid = r.stato?.id || 'inattivo';
    if (byGruppo[sid]) byGruppo[sid].push(r);
  }

  const cols = PIPELINE_GRUPPI.filter(g => byGruppo[g.id].length > 0).map(g => {
    const rows = byGruppo[g.id].slice().sort((a, b) => a.priority - b.priority);
    const cards = rows.map(r => {
      const ritmo = r.ritmo;
      const urg = r.urgenza || 'nessun_ordine';
      const urgC = urgColor[urg] || '#9B9B97';
      const prossLabel = ritmo?.prossimoOrdineData
        ? new Date(ritmo.prossimoOrdineData).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })
        : '—';
      const freqLabel = ritmo?.frequenzaMedia ? `ogni ~${Math.round(ritmo.frequenzaMedia)}gg` : '';
      const gapLabel  = r.gap ? (r.gap > 0 ? `+${_eur(r.gap)}` : _eur(r.gap)) : '';
      const gapCls    = r.gap > 0 ? 'pos' : r.gap < 0 ? 'neg' : '';
      return `<div class="dp-card" onclick="apriClienteDaBudget('${r.codice}','${r.cliente.replace(/'/g,"\\'")}')">
        <div class="dp-card-top">
          <span class="dp-nome">${r.cliente}</span>
          ${urg !== 'nessun_ordine' ? `<span class="bc-urg-badge bc-urg-${urg}">${urgLabel[urg]}</span>` : ''}
        </div>
        <div class="dp-card-meta">
          ${gapLabel ? `<span class="${gapCls}" style="font-size:11px">${gapLabel}</span>` : ''}
          ${prossLabel !== '—' ? `<span style="font-size:11px;color:var(--text2)">prossimo ${prossLabel}</span>` : ''}
          ${freqLabel ? `<span style="font-size:10px;color:var(--text2)">${freqLabel}</span>` : ''}
        </div>
      </div>`;
    }).join('');

    return `<div class="dp-col">
      <div class="dp-col-header" style="border-top:3px solid ${g.color}">
        <span style="color:${g.color};font-weight:600;font-size:12px">${g.label}</span>
        <span class="dp-count">${rows.length}</span>
      </div>
      <div class="dp-cards">${cards}</div>
    </div>`;
  }).join('');

  root.innerHTML = `<div class="dp-board">${cols}</div>`;
}
