// Pure data-processing module — zero I/O, zero DOM access.

const MESI_2025_KEYS = [
  'fatt_gen_2025','fatt_feb_2025','fatt_mar_2025','fatt_apr_2025',
  'fatt_mag_2025','fatt_giu_2025','fatt_lug_2025','fatt_ago_2025',
  'fatt_set_2025','fatt_ott_2025','fatt_nov_2025','fatt_dic_2025',
];

const GTO_2026_KEYS = [
  'gto_gen_2026','gto_feb_2026','gto_mar_2026','gto_apr_2026','gto_mag_2026',
  null, null, null, null, null, null, null,
];

const MESI_LABEL = ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'];

const STATI = {
  ottimo:       { id: 'ottimo',       label: 'Ottimo',       desc: '≥ 100% anno scorso' },
  in_linea:     { id: 'in_linea',     label: 'In linea',     desc: '80–99% anno scorso'  },
  da_stimolare: { id: 'da_stimolare', label: 'Da stimolare', desc: '40–79% anno scorso' },
  indietro:     { id: 'indietro',     label: 'Indietro',     desc: '1–39% anno scorso'   },
  da_visitare:  { id: 'da_visitare',  label: 'Da visitare',  desc: '0% questo mese'     },
  nuovo:        { id: 'nuovo',        label: 'Nuovo',        desc: 'nessuno storico 2025'},
  inattivo:     { id: 'inattivo',     label: 'Inattivo',     desc: 'nessun fatturato'   },
};

function mediaAnnua(rec) {
  return MESI_2025_KEYS.reduce((s, k) => s + (rec[k] || 0), 0) / 12;
}

function statoCliente(rec) {
  const ord    = rec.spedito_ordinato_mese || 0;
  const prec   = rec.fatt_mese_anno_prec   || 0;
  const media  = mediaAnnua(rec);
  const target = prec > 0 ? prec : media;

  if (target <= 0) {
    return { ...STATI[ord > 0 ? 'nuovo' : 'inattivo'], pct: null, target: 0 };
  }
  const r = ord / target;
  if (ord === 0)  return { ...STATI.da_visitare,  pct: 0,  target };
  if (r >= 1.00)  return { ...STATI.ottimo,       pct: r,  target };
  if (r >= 0.80)  return { ...STATI.in_linea,     pct: r,  target };
  if (r >= 0.40)  return { ...STATI.da_stimolare, pct: r,  target };
  return            { ...STATI.indietro,     pct: r,  target };
}

// Adds computed fields to a raw rolling_fatturato record.
function enrichRecord(rec) {
  const stato = statoCliente(rec);
  return {
    ...rec,
    _media: mediaAnnua(rec),
    _stato: stato,
    _gap:   Math.max(0, (rec.fatt_mese_anno_prec || 0) - (rec.spedito_ordinato_mese || 0)),
  };
}

function riepilogoStato(records) {
  const totPrec = records.reduce((s, r) => s + (r.fatt_mese_anno_prec   || 0), 0);
  const totCorr = records.reduce((s, r) => s + (r.spedito_ordinato_mese || 0), 0);
  const totGap  = records.reduce((s, r) => s + (r._gap || 0), 0);

  const byStato = Object.fromEntries(
    Object.keys(STATI).map(id => [id, { count: 0, gap: 0 }])
  );
  for (const r of records) {
    const id = r._stato?.id;
    if (byStato[id]) { byStato[id].count++; byStato[id].gap += r._gap || 0; }
  }
  return { totPrec, totCorr, totGap, byStato };
}

// Computes order rhythm stats from a sorted (desc) array of ordini records.
function calcolaRitmoOrdini(ordini) {
  if (!ordini.length) return null;
  const oggi  = new Date();
  const dates = ordini.map(o => new Date(o.data_ordine)).sort((a, b) => a - b);
  const ultOrd = dates[dates.length - 1];
  const giorniDaUltimo = Math.floor((oggi - ultOrd) / 86400000);

  const intervals = [];
  for (let i = 1; i < dates.length; i++)
    intervals.push(Math.floor((dates[i] - dates[i - 1]) / 86400000));
  const freqMedia = intervals.length
    ? Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length)
    : null;

  const ultimi12m  = ordini.filter(o => (oggi - new Date(o.data_ordine)) / 86400000 <= 365);
  const totaleAnno = ultimi12m.reduce((s, o) => s + (o.totale_ordine || 0), 0);
  const prossimo   = freqMedia ? new Date(ultOrd.getTime() + freqMedia * 86400000) : null;

  let urgenza = 'ok';
  if (freqMedia && prossimo) {
    const gg = Math.floor((prossimo - oggi) / 86400000);
    if (gg < 0)   urgenza = 'scaduto';
    else if (gg < 7) urgenza = 'urgente';
  }

  return { ultOrd, giorniDaUltimo, freqMedia, ultimi12m: ultimi12m.length,
           totaleAnno, prossimo, urgenza };
}
