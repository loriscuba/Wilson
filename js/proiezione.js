// ── Proiezione Fatturato ──────────────────────────────────────────────────────
//
// Proiezione di fine mese del fatturato (fonte: rolling_fatturato), su tutti i
// clienti del rolling (disattivati compresi), escluso il CEDI ridistribuito.
// Clienti CEDI (presenti in cedi_ridistribuito): gli ordini diretti sono
// eccezionali, quindi non entrano nella previsione (previsto = 0, niente
// azioni); se nel mese ce ne sono, contano solo come acquisito (lo
// spedito+ordinato del rolling durante il mese è già solo diretto).
//
// Algoritmo (backtest mag–set 2026 sugli snapshot giornalieri del rolling:
// errore medio assoluto ~4% sul totale, bias ~+1%):
//
//  1. Base cliente      = 50% stesso mese anno scorso + 50% media mensile anno
//                         scorso × indice stagionale del portafoglio.
//  2. Trend cliente     = (ultimi 6 mesi anno corr. + K·Tp) / (stessi 6 mesi anno
//                         prec. + K), limitato 0.4–1.8 (K = €8.000 → i clienti
//                         piccoli restano vicini al trend del portafoglio Tp).
//                         Il trend cliente distribuisce il previsto; il totale è
//                         ancorato al trend del portafoglio (evita sovrastime).
//  3. Referenze perse   = riduce il previsto del cliente di metà del peso delle
//                         referenze che non compra più (max −30%).
//  4. Proiezione        = 0.97 × acquisito (una parte dell'ordinato slitta al mese
//                         dopo) + quota mancante del previsto × giorni lavorativi
//                         rimasti; chi ha già superato il previsto aggiunge una
//                         piccola coda (15% del previsto × giorni rimasti).

const PF_MESI      = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
const PF_MESI_FULL = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
const PF_K_TREND   = 8000;
const PF_SLIP      = 0.97;
const PF_TAIL      = 0.15;

const PF_AZIONI = {
  sollecita: { icon: 'ti-phone',            label: 'Sollecita ordine', cls: 'badge-orange' },
  visita:    { icon: 'ti-car',              label: 'Visita',           cls: 'badge-red'    },
  persa:     { icon: 'ti-package-off',      label: 'Referenza persa',  cls: 'badge-yellow' },
  calo:      { icon: 'ti-trending-down',    label: 'Prodotto in calo', cls: 'badge-gray'   },
};

let _pfChart  = null;
let _pfState  = null;   // { righe, totali, azioni, ... }
let _pfFiltro = '';     // tipo azione filtrata
let _pfSort   = { col: 'mancante', dir: -1 };

// ── Calendario lavorativo ────────────────────────────────────────────────────

const _pfYmd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function _pfPasqua(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}

function _pfFestivi(y) {
  const pasquetta = _pfPasqua(y);
  pasquetta.setDate(pasquetta.getDate() + 1);
  return new Set([
    `${y}-01-01`, `${y}-01-06`, `${y}-04-25`, `${y}-05-01`, `${y}-06-02`,
    `${y}-08-15`, `${y}-11-01`, `${y}-12-08`, `${y}-12-25`, `${y}-12-26`,
    _pfYmd(pasquetta),
  ]);
}

// Giorni lavorativi (lun–ven, esclusi festivi nazionali) del mese, come 'YYYY-MM-DD'
function _pfGiorniLavorativi(y, m0) {
  const fest = _pfFestivi(y);
  const out  = [];
  for (let d = new Date(y, m0, 1); d.getMonth() === m0; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    const s   = _pfYmd(d);
    if (dow !== 0 && dow !== 6 && !fest.has(s)) out.push(s);
  }
  return out;
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

async function _pfFetchAll(build, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return out;
}

// ── Analisi referenze (da ordini + righe_ordine) ─────────────────────────────

function _pfAnalisiOrdini(ordini, oggi) {
  const DAY   = 86400000;
  const t0    = oggi.getTime();
  const byCli = {};

  for (const o of ordini) {
    const cod = String(o.codice_cliente || '').trim();
    if (!cod || !o.data_ordine) continue;
    const age = (t0 - new Date(o.data_ordine + 'T00:00:00').getTime()) / DAY;
    const c   = byCli[cod] || (byCli[cod] = { date: [], art: {}, valPrec: 0 });
    c.date.push(o.data_ordine);
    if (age >= 90 && age < 455) c.valPrec += Number(o.importo_totale || 0);
    for (const r of o.righe_ordine || []) {
      const art = r.codice_articolo;
      if (!art) continue;
      const a = c.art[art] || (c.art[art] = {
        desc: r.descrizione_articolo || art, ultimo: null,
        nPrec: 0, valPrec: 0, val0_6: 0, val6_12: 0, recente: 0,
      });
      const imp = Number(r.importo_eur || 0);
      if (!a.ultimo || o.data_ordine > a.ultimo) a.ultimo = o.data_ordine;
      if (age < 90) a.recente += imp;
      if (age >= 90 && age < 455) { a.nPrec++; a.valPrec += imp; }
      if (age < 182) a.val0_6 += imp;
      else if (age < 365) a.val6_12 += imp;
    }
  }

  const res = {};
  for (const [cod, c] of Object.entries(byCli)) {
    // Ritmo ordini: intervallo mediano negli ultimi 12 mesi
    const dates = [...new Set(c.date)].sort();
    const last  = dates[dates.length - 1];
    const recenti = dates.filter(d => (t0 - new Date(d + 'T00:00:00').getTime()) / DAY <= 365);
    const gaps = [];
    for (let i = 1; i < recenti.length; i++)
      gaps.push((new Date(recenti[i]) - new Date(recenti[i - 1])) / DAY);
    gaps.sort((a, b) => a - b);
    const freq = gaps.length >= 2 ? gaps[Math.floor(gaps.length / 2)] : null;
    const giorniDaUltimo = last ? Math.floor((t0 - new Date(last + 'T00:00:00').getTime()) / DAY) : null;

    // Referenze perse: ≥2 ordini tra 15 e 3 mesi fa, nessun acquisto negli ultimi 90 gg
    const perse = [], calo = [], nuove = [];
    for (const [art, a] of Object.entries(c.art)) {
      if (a.nPrec >= 2 && a.recente === 0 && a.valPrec >= 100)
        perse.push({ art, desc: a.desc, ultimo: a.ultimo, mensile: a.valPrec / 12 });
      // In calo: comprato in entrambi i semestri, ultimo semestre < 60% del precedente
      if (a.val6_12 >= 150 && a.val0_6 > 0 && a.val0_6 < 0.6 * a.val6_12)
        calo.push({ art, desc: a.desc, pct: (a.val0_6 / a.val6_12 - 1) * 100, mensile: (a.val6_12 - a.val0_6) / 6 });
      if (a.nPrec === 0 && a.recente > 0 && a.val6_12 === 0)
        nuove.push({ art, desc: a.desc, valore: a.recente });
    }
    perse.sort((a, b) => b.mensile - a.mensile);
    calo.sort((a, b) => b.mensile - a.mensile);
    nuove.sort((a, b) => b.valore - a.valore);
    const mensilePrec = c.valPrec / 12;
    const persoMensile = perse.reduce((s, p) => s + p.mensile, 0);

    res[cod] = {
      ultimoOrdine: last, giorniDaUltimo, freq,
      perse, calo, nuove,
      quotaPersa: mensilePrec > 0 ? Math.min(1, persoMensile / mensilePrec) : 0,
    };
  }
  return res;
}

// ── Modello di proiezione ─────────────────────────────────────────────────────

function _pfModello(rolling, anno, m0, frazione, analisi, cediSet = new Set()) {
  const sum  = a => a.reduce((s, x) => s + x, 0);
  const winA = Math.max(0, m0 - 6);           // finestra trend: ultimi 6 mesi chiusi
  const nWin = m0 - winA;

  const clienti = rolling.map(r => {
    const so = Number(r.spedito_ordinato_mese || 0);
    if (cediSet.has(String(r.codice_cliente))) {
      // Cliente CEDI: fuori dalla previsione (storico e anno scorso includono il
      // ridistribuito); gli eventuali ordini diretti del mese contano come acquisito.
      return { r, so, cedi: true, f25: Array(12).fill(0), a25: 0, a26: 0, L: 0, avg25: 0 };
    }
    const f25 = PF_MESI.map(m => Number(r[`fatt_${m}_${anno - 1}`] || 0));
    const g26 = PF_MESI.map(m => Number(r[`gto_${m}_${anno}`] || 0));
    const a25 = sum(f25.slice(winA, m0));
    const a26 = sum(g26.slice(winA, m0));
    return {
      r, f25, a25, a26, so,
      L:     f25[m0],
      avg25: sum(f25) / 12,
    };
  });

  const totL   = sum(clienti.map(c => c.L));
  const totAvg = sum(clienti.map(c => c.avg25));
  const sm     = totAvg > 0 ? totL / totAvg : 1;
  const a25tot = sum(clienti.filter(c => c.a25 > 0).map(c => c.a25));
  const a26tot = sum(clienti.filter(c => c.a25 > 0).map(c => c.a26));
  const tp     = nWin > 0 && a25tot > 0 ? a26tot / a25tot : 1;

  for (const c of clienti) {
    if (c.cedi) { c.base = 0; c.trend = tp; continue; }
    c.base  = c.avg25 > 0 ? 0.5 * c.L + 0.5 * c.avg25 * sm
            : nWin > 0 ? (c.a26 / nWin) * sm : 0;
    c.trend = nWin > 0
      ? Math.min(1.8, Math.max(0.4, (c.a26 + PF_K_TREND * tp) / (c.a25 + PF_K_TREND)))
      : 1;
  }
  const sBaseTp = sum(clienti.map(c => c.base * tp));
  const sBaseTc = sum(clienti.map(c => c.base * c.trend));
  const norm    = sBaseTc > 0 ? sBaseTp / sBaseTc : 1;

  const f = frazione;
  for (const c of clienti) {
    const an = analisi[String(c.r.codice_cliente)] || null;
    c.an = an;
    c.refFactor = 1 - Math.min(0.3, 0.5 * (an?.quotaPersa || 0));
    c.previsto  = c.base * c.trend * norm * c.refFactor;
    const tail  = c.so >= c.previsto ? PF_TAIL * c.previsto * (1 - f) : 0;
    c.mancante  = Math.max(0, c.previsto - c.so) * (1 - f) + tail;
    c.proiezione = PF_SLIP * c.so + c.mancante;
    c.trendPct  = c.a25 > 0 ? (c.a26 / c.a25 - 1) * 100 : null;
  }

  const proiez = sum(clienti.map(c => c.proiezione));
  const manc   = sum(clienti.map(c => c.mancante));
  const spread = 0.03 * proiez + 0.25 * manc;
  return {
    clienti, tp, sm,
    totali: {
      annoScorso: totL,
      acquisito:  sum(clienti.map(c => c.so)),
      consegnato: sum(clienti.map(c => Number(c.r.mese_consegnato || 0))),
      previsto:   sum(clienti.map(c => c.previsto)),
      proiezione: proiez,
      mancante:   manc,
      min:        proiez - spread,
      max:        proiez + spread,
    },
  };
}

// ── Azioni suggerite ─────────────────────────────────────────────────────────

function _pfAzioni(clienti, frazione, visite, oggi) {
  const DAY = 86400000;
  const out = [];
  const _gg = s => Math.floor((oggi - new Date(s + 'T00:00:00')) / DAY);

  for (const c of clienti) {
    const cod  = String(c.r.codice_cliente);
    const nome = c.r.ragione_sociale || cod;
    const an   = c.an;
    const vis  = visite[cod] || {};
    if (c.cedi) continue;   // clienti CEDI: nessuna azione (ordini diretti eccezionali)

    // 📞 Sollecita: ha un previsto rilevante e ha acquisito poco, ed è "in ritardo"
    // rispetto al suo ritmo abituale (o il mese è già avanzato)
    const gap = c.previsto - c.so;
    if (c.previsto >= 300 && c.so < 0.35 * c.previsto) {
      const ritardo = an?.freq && an.giorniDaUltimo != null && an.giorniDaUltimo >= an.freq;
      if (ritardo || frazione >= 0.4) {
        const ritmo = an?.freq
          ? `ordina ogni ~${Math.round(an.freq)} gg, ultimo ordine ${an.giorniDaUltimo} gg fa`
          : (an?.ultimoOrdine ? `ultimo ordine ${fmtDate(an.ultimoOrdine)}` : 'nessun ordine recente');
        out.push({ tipo: 'sollecita', cod, nome, impatto: gap,
          testo: `Previsti €${_pfEur(c.previsto)} nel mese, acquisiti €${_pfEur(c.so)} — ${ritmo}.` });
      }
    }

    // 🚗 Visita: cliente importante in calo e senza visite recenti/programmate
    const mediaMese = c.a25 > 0 ? c.a25 / 6 : c.avg25;
    if (c.trendPct != null && c.trendPct <= -25 && mediaMese >= 600) {
      const ultimaVisita = vis.ultima ? _gg(vis.ultima) : null;
      if (!vis.prossima && (ultimaVisita == null || ultimaVisita > 30)) {
        const perdita = (c.a25 - c.a26) / 6;
        out.push({ tipo: 'visita', cod, nome, impatto: perdita,
          testo: `Ultimi 6 mesi ${c.trendPct.toFixed(0)}% vs anno scorso (€${_pfEur(c.a26)} vs €${_pfEur(c.a25)}).` +
                 (vis.ultima ? ` Ultima visita ${fmtDate(vis.ultima)}.` : ' Nessuna visita registrata.') });
      }
    }

    // 📦 Referenze perse
    if (an?.perse?.length) {
      const tot = an.perse.reduce((s, p) => s + p.mensile, 0);
      if (tot >= 100) {
        const top = an.perse.slice(0, 3).map(p => `${_pfEsc(p.desc)} (ult. ${fmtDate(p.ultimo)})`).join(', ');
        out.push({ tipo: 'persa', cod, nome, impatto: tot,
          testo: `Non compra più ${an.perse.length} referenz${an.perse.length === 1 ? 'a' : 'e'} (~€${_pfEur(tot)}/mese): ${top}${an.perse.length > 3 ? '…' : ''}` });
      }
    }

    // 📉 Prodotto in calo
    if (an?.calo?.length && an.calo[0].mensile >= 80) {
      const p = an.calo[0];
      out.push({ tipo: 'calo', cod, nome, impatto: p.mensile,
        testo: `Compra meno ${_pfEsc(p.desc)}: ${p.pct.toFixed(0)}% nell'ultimo semestre (−€${_pfEur(p.mensile)}/mese). Capire perché.` });
    }
  }
  return out.sort((a, b) => b.impatto - a.impatto);
}

// ── Formatters ───────────────────────────────────────────────────────────────

function _pfEur(n) {
  return Math.round(Number(n) || 0).toLocaleString('it-IT');
}

function _pfEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function _pfVarBadge(curr, prec) {
  if (!prec) return '<span class="badge badge-gray">—</span>';
  return variazioneBadge((curr / prec - 1) * 100);
}

// ── Load & render ────────────────────────────────────────────────────────────

// Calcola (o restituisce dalla cache) lo stato completo della proiezione.
// Condiviso tra la sezione Proiezione Fatturato e il riquadro in Dashboard.
let _pfPromise = null;

async function calcolaProiezione(force) {
  const rollingDate = await getLatestRollingDate();
  if (!rollingDate) return null;
  if (!force && _pfPromise && _pfPromise.rollingDate === rollingDate) return _pfPromise;
  const p = _pfCalcola(rollingDate);
  p.rollingDate = rollingDate;
  _pfPromise = p;
  p.catch(() => { if (_pfPromise === p) _pfPromise = null; });
  return p;
}

async function _pfCalcola(rollingDate) {
  const oggi = new Date();
  oggi.setHours(0, 0, 0, 0);

  const rd    = new Date(rollingDate + 'T00:00:00');
  const anno  = rd.getFullYear();
  const m0    = rd.getMonth();
  const startMese = _pfYmd(new Date(anno, m0, 1));
  const from15 = _pfYmd(new Date(oggi.getTime() - 455 * 86400000));
  const from6  = _pfYmd(new Date(oggi.getTime() - 180 * 86400000));

  const [{ data: rolling, error: rErr }, { data: cediRows }, snapshots, ordini, { data: visiteRows }] = await Promise.all([
    sb.from('rolling_fatturato').select('*').eq('data_aggiornamento', rollingDate),
    sb.from('cedi_ridistribuito').select('codice_cliente').limit(5000),
    _pfFetchAll(() => sb.from('rolling_fatturato')
      .select('data_aggiornamento, codice_cliente, spedito_ordinato_mese')
      .gte('data_aggiornamento', startMese).lte('data_aggiornamento', rollingDate)
      .order('data_aggiornamento').order('codice_cliente')),
    _pfFetchAll(() => sb.from('ordini')
      .select('codice_cliente, data_ordine, importo_totale, righe_ordine(codice_articolo, descrizione_articolo, importo_eur)')
      .gte('data_ordine', from15)
      .neq('stato', 'annullato')
      .order('data_ordine').order('id'), 300),
    sb.from('agenda_visite').select('id, codice_cliente, data_visita, completata').gte('data_visita', from6),
  ]);
  if (rErr) throw rErr;

  const cediSet = new Set((cediRows || []).map(r => String(r.codice_cliente)));
  const righe = rolling || [];

  // Visite: ultima effettuata e prossima programmata per cliente
  const todayStr = _pfYmd(oggi);
  const visite = {};
  for (const v of visiteRows || []) {
    const cod = String(v.codice_cliente);
    const x = visite[cod] || (visite[cod] = {});
    if (v.data_visita <= todayStr && (v.completata || v.data_visita < todayStr)) {
      if (!x.ultima || v.data_visita > x.ultima) x.ultima = v.data_visita;
    } else if (v.data_visita >= todayStr) {
      if (!x.prossima || v.data_visita < x.prossima) { x.prossima = v.data_visita; x.prossimaId = v.id; }
    }
  }

  // Avanzamento del mese in giorni lavorativi (giorni prima della data rolling)
  const gl     = _pfGiorniLavorativi(anno, m0);
  const fatti  = gl.filter(d => d < rollingDate).length;
  const frazione = gl.length ? fatti / gl.length : 0;

  const analisi = _pfAnalisiOrdini(ordini, oggi);
  const mod     = _pfModello(righe, anno, m0, frazione, analisi, cediSet);
  const azioni  = _pfAzioni(mod.clienti, frazione, visite, oggi);

  // Serie giornaliera dell'acquisito (spedito+ordinato: per i CEDI è già solo diretto)
  const perGiorno = {};
  for (const s of snapshots) {
    perGiorno[s.data_aggiornamento] = (perGiorno[s.data_aggiornamento] || 0) + Number(s.spedito_ordinato_mese || 0);
  }

  return { ...mod, azioni, perGiorno, gl, fatti, frazione, rollingDate, anno, m0, visite };
}

async function loadProiezione() {
  const root = document.getElementById('pf-root');
  if (!root) return;
  root.innerHTML = '<div class="loading">Calcolo proiezione…</div>';
  try {
    const state = await calcolaProiezione();
    if (!state) { root.innerHTML = '<div class="loading">Nessun dato rolling disponibile</div>'; return; }
    _pfState = state;
    _pfRender();
  } catch (err) {
    console.error(err);
    root.innerHTML = `<div class="loading">Errore: ${_pfEsc(err.message)}</div>`;
  }
}

// Riquadro sintetico in Dashboard: proiezione, forbice e prime azioni suggerite
async function renderDashProiezione() {
  const el = document.getElementById('dash-proiezione');
  if (!el) return;
  el.innerHTML = '<div class="b-panel"><div class="loading">Calcolo proiezione…</div></div>';
  try {
    const s = await calcolaProiezione();
    if (!s) { el.innerHTML = ''; return; }
    const t = s.totali;
    const varPct = t.annoScorso ? (t.proiezione / t.annoScorso - 1) * 100 : null;
    // Una sola scala per acquisito, proiezione e anno scorso
    const scala   = Math.max(t.max, t.annoScorso, t.acquisito, 1);
    const pctAcq  = 100 * t.acquisito / scala;
    const pctProj = 100 * t.proiezione / scala;
    const pctLy   = 100 * t.annoScorso / scala;
    const top = s.azioni.slice(0, 3).map(a => {
      const tipo = PF_AZIONI[a.tipo];
      return `<div class="pf-dash-az" onclick="apriClienteDaDashboard('${a.cod}')">
        <span class="badge ${tipo.cls}"><i class="ti ${tipo.icon}"></i></span>
        <span class="pf-dash-az-nome">${_pfEsc(a.nome)}</span>
        <span class="pf-dash-az-lbl">${tipo.label}</span>
        <span class="pf-dash-az-imp">€${_pfEur(a.impatto)}</span>
      </div>`;
    }).join('');
    el.innerHTML = `
      <div class="b-panel pf-dash">
        <div class="pf-dash-head">
          <p class="b-sec" style="margin:0">Proiezione ${PF_MESI_FULL[s.m0].toLowerCase()} · senza CEDI ridistribuito</p>
          <a href="#" class="pf-dash-link" onclick="navToPage('proiezione');return false;">Apri <i class="ti ti-arrow-right"></i></a>
        </div>
        <div class="pf-dash-main">
          <span class="pf-dash-val">€${_pfEur(t.proiezione)}</span>
          ${varPct == null ? '' : `<span class="kpi-change ${varPct >= 0 ? 'positive' : 'negative'}">${varPct >= 0 ? '+' : ''}${varPct.toFixed(1)}% vs ${s.anno - 1}</span>`}
        </div>
        <div class="kpi-sub">forbice €${_pfEur(t.min)} – €${_pfEur(t.max)} · acquisito €${_pfEur(t.acquisito)} · anno scorso €${_pfEur(t.annoScorso)} · giorno ${s.fatti} di ${s.gl.length}</div>
        <div class="b-bbg pf-dash-bar">
          <div class="pf-dash-proj" style="width:${pctProj.toFixed(1)}%" title="Proiezione €${_pfEur(t.proiezione)}"></div>
          <div class="b-bfill pf-dash-acq" style="width:${pctAcq.toFixed(1)}%" title="Acquisito €${_pfEur(t.acquisito)}"></div>
          <span class="pf-dash-ly" style="left:${pctLy.toFixed(1)}%" title="Anno scorso €${_pfEur(t.annoScorso)}"></span>
        </div>
        <div class="pf-dash-leg">
          <span><i style="background:var(--accent)"></i>acquisito</span>
          <span><i style="background:rgba(192,57,43,.22)"></i>proiezione</span>
          <span><i class="pf-dash-leg-ly"></i>anno scorso</span>
        </div>
        ${top ? `<div class="pf-dash-azioni">${top}</div>` : ''}
      </div>`;
  } catch (err) {
    console.error(err);
    el.innerHTML = '';
  }
}

function _pfRender() {
  const root = document.getElementById('pf-root');
  const s    = _pfState;
  const t    = s.totali;
  const rimasti = s.gl.length - s.fatti;
  const serveAlGiorno = rimasti > 0 ? Math.max(0, t.annoScorso - t.acquisito) / rimasti : 0;
  const varPct = t.annoScorso ? (t.proiezione / t.annoScorso - 1) * 100 : null;
  const varCls = varPct == null ? '' : varPct >= 0 ? 'positive' : 'negative';
  const varTxt = varPct == null ? '' : `${varPct >= 0 ? '+' : ''}${varPct.toFixed(1)}% vs ${PF_MESI_FULL[s.m0].toLowerCase()} ${s.anno - 1}`;

  const nAz = t => s.azioni.filter(a => a.tipo === t).length;
  const chips = [['', `Tutte (${s.azioni.length})`], ...Object.entries(PF_AZIONI).map(([k, v]) => [k, `${v.label} (${nAz(k)})`])]
    .map(([k, l]) => `<button class="pf-chip${_pfFiltro === k ? ' on' : ''}" onclick="pfFiltraAzioni('${k}')">${l}</button>`).join('');

  root.innerHTML = `
    <p class="pf-sub">${PF_MESI_FULL[s.m0]} ${s.anno} · rolling del ${fmtDate(s.rollingDate)} · giorno lavorativo ${s.fatti} di ${s.gl.length} · CEDI esclusi dalla previsione (contati solo eventuali ordini diretti già arrivati)</p>

    <div class="kpi-grid">
      <div class="kpi-card">
        <h3>Proiezione fine mese</h3>
        <div class="kpi-value">€${_pfEur(t.proiezione)}</div>
        <div class="kpi-sub">forbice €${_pfEur(t.min)} – €${_pfEur(t.max)}</div>
        <div class="kpi-change ${varCls}">${varTxt}</div>
      </div>
      <div class="kpi-card">
        <h3>Acquisito ad oggi</h3>
        <div class="kpi-value">€${_pfEur(t.acquisito)}</div>
        <div class="kpi-sub">spedito + ordinato · consegnato €${_pfEur(t.consegnato)}</div>
        <div class="kpi-sub">${t.annoScorso ? Math.round(100 * t.acquisito / t.annoScorso) : 0}% dell'anno scorso</div>
      </div>
      <div class="kpi-card">
        <h3>${PF_MESI_FULL[s.m0]} ${s.anno - 1}</h3>
        <div class="kpi-value">€${_pfEur(t.annoScorso)}</div>
        <div class="kpi-sub">trend portafoglio ultimi 6 mesi ${s.tp >= 1 ? '+' : ''}${((s.tp - 1) * 100).toFixed(1)}%</div>
      </div>
      <div class="kpi-card">
        <h3>Per pareggiare l'anno scorso</h3>
        <div class="kpi-value">€${_pfEur(serveAlGiorno)}<span class="pf-unit">/giorno</span></div>
        <div class="kpi-sub">${rimasti} giorni lavorativi rimasti · mancano €${_pfEur(Math.max(0, t.annoScorso - t.acquisito))}</div>
      </div>
    </div>

    <div class="b-panel">
      <p class="b-sec" style="margin-top:0">Andamento giornaliero</p>
      <div class="pf-chart-wrap"><canvas id="pf-chart" role="img" aria-label="Acquisito cumulato del mese, ritmo per pareggiare l'anno scorso e proiezione a fine mese"></canvas></div>
    </div>

    <p class="b-sec">Azioni suggerite</p>
    <div class="pf-chips">${chips}</div>
    <div id="pf-azioni" class="pf-azioni"></div>

    <p class="b-sec">Clienti</p>
    <div class="table-wrapper"><div class="table-scroll">
      <table class="table" id="pf-table">
        <thead><tr>
          ${_pfTh('nome', 'Cliente')}
          ${_pfTh('annoScorso', 'Anno scorso', true)}
          ${_pfTh('previsto', 'Previsto', true)}
          ${_pfTh('so', 'Acquisito', true)}
          ${_pfTh('mancante', 'Da acquisire', true)}
          ${_pfTh('proiezione', 'Proiezione', true)}
          ${_pfTh('trend', 'Trend 6m', true)}
          <th>Ritmo</th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div></div>
    <p class="pf-note">Previsto = stesso mese anno scorso + media annua, corretti per il trend degli ultimi 6 mesi e per le referenze perse.
    Proiezione = acquisito + quota del previsto ancora da acquisire, in proporzione ai giorni lavorativi rimasti.
    Clienti CEDI: fuori dalla previsione; eventuali ordini diretti del mese contano solo come acquisito.
    Backtest maggio–settembre 2026: errore medio ~4% sul totale.</p>`;

  _pfRenderAzioni();
  _pfRenderTabella();
  _pfRenderChart();
}

function _pfTh(col, label, num) {
  const arrow = _pfSort.col === col ? (_pfSort.dir < 0 ? ' ↓' : ' ↑') : '';
  return `<th class="${num ? 'num-right ' : ''}pf-sortable" onclick="pfOrdina('${col}')">${label}${arrow}</th>`;
}

function pfOrdina(col) {
  _pfSort = _pfSort.col === col ? { col, dir: -_pfSort.dir } : { col, dir: col === 'nome' ? 1 : -1 };
  _pfRender();
}

function pfFiltraAzioni(tipo) {
  _pfFiltro = tipo;
  document.querySelectorAll('#pf-root .pf-chip').forEach(b => b.classList.toggle('on', b.getAttribute('onclick') === `pfFiltraAzioni('${tipo}')`));
  _pfRenderAzioni();
}

function _pfRenderAzioni() {
  const el = document.getElementById('pf-azioni');
  if (!el) return;
  const list = _pfState.azioni.filter(a => !_pfFiltro || a.tipo === _pfFiltro).slice(0, 30);
  if (!list.length) { el.innerHTML = '<div class="loading">Nessuna azione suggerita 👍</div>'; return; }
  el.innerHTML = list.map(a => {
    const t   = PF_AZIONI[a.tipo];
    const vis = _pfState.visite[a.cod] || {};
    // La data si salva solo col pulsante "Salva": su iPad/iPhone il selettore imposta
    // subito la data di oggi e lancia change/blur all'apertura, quindi niente salvataggi automatici
    // Testo sempre visibile (su iPad un campo data vuoto non mostra nulla): il campo
    // data è trasparente sopra icona+testo e apre il calendario al tocco
    const agenda = `<div class="pf-agenda${vis.prossima ? ' on' : ''}" title="${vis.prossima ? 'Visita in Agenda' : 'Programma una visita in Agenda'}">
           <label class="pf-ag-field">
             <i class="ti ${vis.prossima ? 'ti-calendar-check' : 'ti-calendar-plus'}"></i>
             <span class="pf-ag-txt">${vis.prossima ? fmtDate(vis.prossima) : 'Programma visita'}</span>
             <input type="date" value="${vis.prossima || ''}" data-cod="${_pfEsc(a.cod)}" data-saved="${vis.prossima || ''}"
                    oninput="pfDataCambiata(this)" onchange="pfDataCambiata(this)">
           </label>
           <button type="button" class="pf-ag-btn pf-ag-ok" hidden onclick="pfSalvaVisita(this.closest('.pf-agenda').querySelector('input'))">Salva</button>
           ${vis.prossima ? `<button type="button" class="pf-ag-btn pf-ag-del" title="Togli la visita dall'Agenda" onclick="pfTogliVisita('${_pfEsc(a.cod)}')">×</button>` : ''}
         </div>`;
    return `
      <div class="pf-az">
        <span class="badge ${t.cls} pf-az-tipo"><i class="ti ${t.icon}"></i> ${t.label}</span>
        <div class="pf-az-body">
          <a href="#" class="pf-az-nome" onclick="event.preventDefault();apriClienteDaDashboard('${a.cod}')">${_pfEsc(a.nome)}</a>
          <div class="pf-az-txt">${a.testo}</div>
        </div>
        <div class="pf-az-imp">€${_pfEur(a.impatto)}<span>${a.tipo === 'sollecita' ? 'in gioco' : '/mese'}</span></div>
        ${agenda}
      </div>`;
  }).join('');
}

// Mostra "Salva" solo se la data scelta è diversa da quella in Agenda
function pfDataCambiata(el) {
  const box = el.closest('.pf-agenda');
  const txt = box.querySelector('.pf-ag-txt');
  if (txt) txt.textContent = el.value ? fmtDate(el.value) : (el.dataset.saved ? fmtDate(el.dataset.saved) : 'Programma visita');
  const ok = box.querySelector('.pf-ag-ok');
  if (ok) ok.hidden = !el.value || el.value === el.dataset.saved;
}

async function pfTogliVisita(codice) {
  if (!confirm('Togliere la visita dall\'Agenda?')) return;
  await pfSalvaVisita({ dataset: { cod: codice }, value: '' });
}

// Crea, sposta o toglie la prossima visita in Agenda per il cliente
async function pfSalvaVisita(el) {
  const codice = el.dataset.cod;
  const data   = el.value || '';
  const vis    = _pfState.visite[codice] || (_pfState.visite[codice] = {});
  if (data === (vis.prossima || '')) return;
  try {
    if (!data) {
      if (vis.prossimaId) {
        const { error } = await sb.from('agenda_visite').delete().eq('id', vis.prossimaId);
        if (error) throw error;
      }
      vis.prossima = null; vis.prossimaId = null;
    } else if (vis.prossimaId) {
      const { error } = await sb.from('agenda_visite').update({ data_visita: data }).eq('id', vis.prossimaId);
      if (error) throw error;
      vis.prossima = data;
    } else {
      const { data: row, error } = await sb.from('agenda_visite')
        .insert({ codice_cliente: codice, data_visita: data, completata: false, generata_auto: false })
        .select('id').single();
      if (error) throw error;
      vis.prossima = data; vis.prossimaId = row?.id || null;
    }
  } catch (e) {
    alert('Errore salvataggio agenda: ' + e.message);
  }
  _pfRenderAzioni();
}

function _pfRenderTabella() {
  const tbody = document.querySelector('#pf-table tbody');
  if (!tbody) return;
  const key = {
    nome:       c => (c.r.ragione_sociale || '').toLowerCase(),
    annoScorso: c => c.L,
    previsto:   c => c.previsto,
    so:         c => c.so,
    mancante:   c => c.previsto - c.so,
    proiezione: c => c.proiezione,
    trend:      c => c.trendPct ?? -Infinity,
  }[_pfSort.col];
  const rows = _pfState.clienti
    .filter(c => c.L > 0 || c.previsto >= 50 || c.so !== 0)
    .sort((a, b) => {
      const va = key(a), vb = key(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * _pfSort.dir;
    });

  tbody.innerHTML = rows.map(c => {
    const an  = c.an;
    const gap = c.previsto - c.so;
    let ritmo = '<span class="badge badge-gray">—</span>';
    if (c.so >= c.previsto && c.previsto > 0) ritmo = '<span class="badge badge-green">coperto</span>';
    else if (an?.freq && an.giorniDaUltimo != null) {
      const late = an.giorniDaUltimo >= an.freq;
      ritmo = `<span class="badge ${late ? 'badge-orange' : 'badge-gray'}" title="Ordina ogni ~${Math.round(an.freq)} gg">${an.giorniDaUltimo} gg / ${Math.round(an.freq)}</span>`;
    }
    return `
      <tr>
        <td><a href="#" class="pf-az-nome" onclick="event.preventDefault();apriClienteDaDashboard('${c.r.codice_cliente}')"><strong>${_pfEsc(c.r.ragione_sociale || c.r.codice_cliente)}</strong></a>
            ${c.cedi ? '<span class="pf-ref" title="Cliente CEDI: fuori dalla previsione, contati solo eventuali ordini diretti già arrivati">CEDI</span>' : ''}
            ${c.refFactor < 1 ? `<span class="pf-ref" title="Previsto ridotto per referenze perse">−${Math.round((1 - c.refFactor) * 100)}% ref.</span>` : ''}</td>
        <td class="num-right">${c.cedi ? '<span title="Anno scorso non separabile dal CEDI ridistribuito">—</span>' : '€' + _pfEur(c.L)}</td>
        <td class="num-right">€${_pfEur(c.previsto)}</td>
        <td class="num-right">€${_pfEur(c.so)}</td>
        <td class="num-right ${gap > 0 ? 'pf-neg' : 'pf-pos'}">${gap > 0 ? '€' + _pfEur(gap) : '✓'}</td>
        <td class="num-right"><strong>€${_pfEur(c.proiezione)}</strong></td>
        <td class="num-right">${_pfVarBadge(c.a26, c.a25)}</td>
        <td>${ritmo}</td>
      </tr>`;
  }).join('');
}

function _pfRenderChart() {
  const canvas = document.getElementById('pf-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (_pfChart) { _pfChart.destroy(); _pfChart = null; }

  const s = _pfState, t = s.totali;
  const n = s.gl.length;
  const labels = s.gl.map(d => d.slice(8, 10) + '/' + d.slice(5, 7));

  // Acquisito: valore dello snapshot rolling più recente fino a quel giorno
  const snapDates = Object.keys(s.perGiorno).sort();
  const acquisito = s.gl.map(d => {
    if (d > s.rollingDate) return null;
    const last = snapDates.filter(x => x <= d).pop();
    return last ? Math.round(s.perGiorno[last]) : null;
  });
  // Ritmo per pareggiare l'anno scorso: lineare sui giorni lavorativi
  const ritmo = s.gl.map((_, i) => Math.round(t.annoScorso * (i + 1) / n));
  // Proiezione: dall'ultimo acquisito fino a fine mese (+ forbice)
  const iStart = Math.max(0, s.gl.filter(d => d <= s.rollingDate).length - 1);
  const proj = [], lo = [], hi = [];
  for (let i = 0; i < n; i++) {
    if (i < iStart) { proj.push(null); lo.push(null); hi.push(null); continue; }
    const k = n - 1 === iStart ? 1 : (i - iStart) / (n - 1 - iStart);
    proj.push(Math.round(t.acquisito + (t.proiezione - t.acquisito) * k));
    lo.push(Math.round(t.acquisito + (t.min - t.acquisito) * k));
    hi.push(Math.round(t.acquisito + (t.max - t.acquisito) * k));
  }

  const ACC = '#C0392B', GRAY = '#8C8580';
  _pfChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: `Acquisito ${s.anno}`, data: acquisito, borderColor: ACC, backgroundColor: ACC,
          borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, spanGaps: true, tension: 0 },
        { label: 'Proiezione', data: proj, borderColor: ACC, borderDash: [5, 4], borderWidth: 2,
          pointRadius: 0, pointHoverRadius: 4, tension: 0 },
        { label: 'Forbice max', data: hi, borderWidth: 0, pointRadius: 0, fill: '+1',
          backgroundColor: 'rgba(192,57,43,.10)', tension: 0 },
        { label: 'Forbice min', data: lo, borderWidth: 0, pointRadius: 0, fill: false, tension: 0 },
        { label: `Ritmo per pareggiare ${s.anno - 1}`, data: ritmo, borderColor: GRAY, borderDash: [2, 3],
          borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { boxWidth: 14, boxHeight: 2, filter: i => !i.text.startsWith('Forbice') } },
        tooltip: {
          filter: i => i.raw != null,
          callbacks: { label: c => `${c.dataset.label}: €${_pfEur(c.raw)}` },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 11 } },
        y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,.05)' },
             ticks: { callback: v => '€' + (v >= 1000 ? Math.round(v / 1000) + 'k' : v) } },
      },
    },
  });
}
