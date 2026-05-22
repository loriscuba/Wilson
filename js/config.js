const SUPABASE_URL = window.__env?.SUPABASE_URL || '';
const SUPABASE_KEY = window.__env?.SUPABASE_KEY || '';

function _getSafeStorage() {
  try {
    const k = '__test__';
    window.localStorage.setItem(k, k);
    window.localStorage.removeItem(k);
    return window.localStorage;
  } catch { return { getItem: () => null, setItem: () => {}, removeItem: () => {} }; }
}

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, storage: _getSafeStorage() },
});

// ── Formatters ────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleDateString('it-IT');
}

function variazioneBadge(v) {
  if (v == null) return '<span class="badge badge-gray">—</span>';
  const cls  = v >= 0 ? 'badge-green' : 'badge-red';
  const sign = v >= 0 ? '+' : '';
  return `<span class="badge ${cls}">${sign}${Number(v).toFixed(1)}%</span>`;
}

function statoBadgeOrdine(stato) {
  if (!stato) return '<span class="badge badge-gray">—</span>';
  const map = {
    'confermato':           'badge-blue',
    'parzialmente spedito': 'badge-yellow',
    'spedito':              'badge-orange',
    'consegnato':           'badge-green',
    'annullato':            'badge-red',
    'in preparazione':      'badge-yellow',
  };
  return `<span class="badge ${map[stato.toLowerCase()] || 'badge-gray'}">${stato}</span>`;
}

// Maps analytics stato id → badge CSS class (warm palette)
function statoBadgeCls(id) {
  return { ottimo: 'badge-blue', in_linea: 'badge-green', da_stimolare: 'badge-orange',
           indietro: 'badge-red', da_visitare: 'badge-gray', nuovo: 'badge-blue',
           inattivo: 'badge-gray' }[id] || 'badge-gray';
}

// ── Shared rolling cache ──────────────────────────────────────────────────────

let _latestRollingDate  = null;
let _rollingEnriched    = null;
let _clientiEsclusi     = null;  // Set codici esclusi
let _ordinaDiPersonaSet = null;  // Set codici che ordinano di persona

async function _loadClientiConfigCache() {
  if (_clientiEsclusi) return;
  try {
    const { data } = await sb.from('clienti_config')
      .select('codice_cliente, attivo, ordina_di_persona');
    _clientiEsclusi     = new Set((data || []).filter(r => r.attivo === false).map(r => String(r.codice_cliente)));
    _ordinaDiPersonaSet = new Set((data || []).filter(r => r.ordina_di_persona).map(r => String(r.codice_cliente)));
  } catch {
    _clientiEsclusi     = new Set();
    _ordinaDiPersonaSet = new Set();
  }
}

async function loadClientiEsclusi() {
  await _loadClientiConfigCache();
  return _clientiEsclusi;
}

async function getLatestRollingDate() {
  if (_latestRollingDate) return _latestRollingDate;
  const today = new Date().toISOString().split('T')[0];
  const { data } = await sb.from('rolling_fatturato')
    .select('data_aggiornamento')
    .lte('data_aggiornamento', today)
    .order('data_aggiornamento', { ascending: false })
    .limit(1)
    .single();
  _latestRollingDate = data?.data_aggiornamento || null;
  return _latestRollingDate;
}

async function loadRollingEnriched(force) {
  if (_rollingEnriched && !force) return _rollingEnriched;
  await _loadClientiConfigCache();
  const date = await getLatestRollingDate();
  if (!date) return [];
  const { data, error } = await sb.from('rolling_fatturato')
    .select([
      'ragione_sociale, codice_cliente, divisione, fatturato_2025',
      'mese_consegnato, mese_in_preparazione, mese_da_spedire, ordinato_oltre_mese',
      'spedito_ordinato_mese, fatt_mese_anno_prec, variazione_mese',
      'fatt_prog_anno_prec, fatt_prog_anno_corr, variazione_progressivo',
      'fatt_gen_2025, fatt_feb_2025, fatt_mar_2025, fatt_apr_2025',
      'fatt_mag_2025, fatt_giu_2025, fatt_lug_2025, fatt_ago_2025',
      'fatt_set_2025, fatt_ott_2025, fatt_nov_2025, fatt_dic_2025',
      'gto_gen_2026, gto_feb_2026, gto_mar_2026, gto_apr_2026, gto_mag_2026',
    ].join(', '))
    .eq('data_aggiornamento', date)
    .order('ragione_sociale', { ascending: true });
  if (error) throw error;
  _rollingEnriched = (data || [])
    .map(r => enrichRecord({
      ...r,
      _escluso:         _clientiEsclusi.has(String(r.codice_cliente)),
      _ordinaDiPersona: _ordinaDiPersonaSet.has(String(r.codice_cliente)),
    }));
  return _rollingEnriched;
}
