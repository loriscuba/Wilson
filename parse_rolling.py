"""
WILSON - Parser Rolling Fatturato
File: ordini_mancanti_su_rolling_consuntivo-DD-MM-YYYY_XXXXXXXX.xlsx

Legge il file rolling e carica i dati di fatturato mensile per cliente su Supabase.
Le colonne vengono trovate per nome di intestazione, non per indice fisso, così il parser
regge automaticamente all'aggiunta di nuove colonne mensili da parte di Fischer.
"""

import argparse
import os
import re
from datetime import datetime

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client


# ── Costanti mesi ─────────────────────────────────────────────────────────────

MESI_IT = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC']
MESI_DB = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic']

# Colonne fisse che non cambiano mai (prima della sezione GTO/mese corrente)
_FIXED = {
    'divisione':    2,
    'cod_cliente':  5,
    'rag_sociale':  6,
    'fatt_2024':    7,
    'fatt_2025':    8,
    # mensile 2025: gen=9 … dic=20 (12 mesi stabili)
    **{f'fatt_{MESI_DB[i]}_2025': 9 + i for i in range(12)},
    # progressivo 2026 (prima colonna della sezione 2026)
    'fatt_prog_gen_apr_2026': 21,
}


# ── Rilevamento intestazioni ───────────────────────────────────────────────────

def _find_header_row(df):
    """
    Trova la riga che contiene più abbreviazioni di mese (almeno 3).
    Scansiona le prime 5 righe; se nessuna supera la soglia restituisce la riga 2.
    """
    best_row, best_count = 2, 0
    for i in range(min(5, len(df))):
        vals = [str(v).upper().strip() for v in df.iloc[i]]
        count = sum(
            1 for v in vals
            for m in MESI_IT
            if v == m or v.startswith(m + ' ') or v.endswith(' ' + m) or ('GTO' in v and m in v)
        )
        if count > best_count:
            best_count, best_row = count, i
    return best_row


def _build_col_map(df):
    """
    Restituisce un dict {header_normalizzato: indice_colonna} dalla riga header rilevata.
    Stampa le intestazioni trovate per facilitare il debug.
    """
    hr = _find_header_row(df)
    raw = [str(v).strip() if str(v) != 'nan' else '' for v in df.iloc[hr]]
    col_map = {}
    for i, h in enumerate(raw):
        if h:
            key = re.sub(r'\s+', ' ', h.upper())
            col_map[key] = i

    found = [h for h in raw if h]
    print(f"  📋 Intestazioni (riga {hr}, {len(found)} colonne): {found}")
    return col_map


def _col(col_map, *patterns, fallback=None):
    """
    Cerca il primo indice colonna il cui nome contiene uno dei pattern (case-insensitive).
    Se nessuno viene trovato usa il fallback (con avviso).
    """
    for p in patterns:
        pu = p.upper().strip()
        for name, idx in col_map.items():
            if pu == name or pu in name:
                return idx
    if fallback is not None:
        print(f"  ⚠️  Colonna non trovata ({list(patterns)}) → fallback indice {fallback}")
    return fallback


def _build_gto_map(col_map):
    """
    Mappa ogni mese DB (gen…dic) al suo indice colonna GTO 2026.
    Cerca intestazioni del tipo 'GTO GEN', 'GTO GEN 2026', 'GEN 2026' (nella sezione GTO), ecc.
    """
    gto = {}
    for db, it in zip(MESI_DB, MESI_IT):
        idx = _col(col_map,
                   f'GTO {it}',
                   f'GTO {it} 2026',
                   f'{it} 2026 GTO',
                   f'OBIETTIVO {it}',
                   f'OBIETTIVO {it} 2026')
        gto[db] = idx
        if idx is None:
            print(f"  ⚠️  GTO {it} 2026 non trovato nelle intestazioni (sarà None)")
    return gto


# ── Parser principale ─────────────────────────────────────────────────────────

def parse_rolling(filepath):
    """Legge il file rolling e restituisce lista di record per cliente."""
    df = pd.read_excel(filepath, sheet_name='REPORT', header=None)

    # ── Data aggiornamento (riga 1, colonna 2) ──────────────────────────────
    data_raw  = df.iloc[1][2]
    data_agg  = None
    today_str = datetime.today().strftime("%Y-%m-%d")

    if hasattr(data_raw, 'strftime'):
        candidate = data_raw.strftime("%Y-%m-%d")
        if candidate <= today_str:
            data_agg = candidate
        else:
            print(f"  ⚠️  Data cella Excel futura ({candidate}), uso nome file come fallback")
    elif isinstance(data_raw, str):
        for fmt in ("%d/%m/%Y", "%d/%m/%y", "%Y-%m-%d", "%d-%m-%Y"):
            try:
                candidate = datetime.strptime(data_raw.strip(), fmt).strftime("%Y-%m-%d")
                if candidate <= today_str:
                    data_agg = candidate
                else:
                    print(f"  ⚠️  Data cella Excel futura ({candidate}), uso nome file come fallback")
                break
            except ValueError:
                continue

    if not data_agg:
        m = re.search(r'consuntivo-(\d{2}-\d{2}-\d{4})', os.path.basename(filepath))
        data_agg = datetime.strptime(m.group(1), "%d-%m-%Y").strftime("%Y-%m-%d") if m else None

    # ── Mappa intestazioni ──────────────────────────────────────────────────
    col_map = _build_col_map(df)
    gto_map = _build_gto_map(col_map)

    # Colonne mese corrente e confronti — cercate per nome con fallback agli indici
    # storici (validi finché non ci sono nuove colonne GTO oltre maggio 2026)
    c_cons  = _col(col_map, 'CONSEGNATO', 'CONS.', 'CONS ',  fallback=34)
    c_prep  = _col(col_map, 'PREPARAZIONE', 'IN PREP', 'PREP.', fallback=35)
    c_sped  = _col(col_map, 'DA SPEDIRE', 'DA SPED', 'SPED.', fallback=36)
    c_oltre = _col(col_map, 'OLTRE MESE', 'OLTRE',           fallback=37)

    c_prec_mese = _col(col_map, 'ANNO PREC', 'PREC MESE', 'F.TO PREC', fallback=38)
    c_sped_ord  = _col(col_map, 'SPED+ORD', 'SPEDITO ORD', 'ORDINATO MESE', fallback=39)
    c_var_mese  = _col(col_map, 'VAR MESE', 'VARIAZ MESE', 'VAR%',       fallback=40)

    c_prog_prec = _col(col_map, 'PROG PREC', 'PROGRESSIVO PREC', 'PROG ANNO PREC', fallback=41)
    c_prog_corr = _col(col_map, 'PROG CORR', 'PROGRESSIVO CORR', 'PROG ANNO CORR', fallback=42)
    c_var_prog  = _col(col_map, 'VAR PROG', 'VARIAZ PROG', 'VAR PROGRESSIVO',      fallback=43)

    def n(val):
        """Converte in float, None se nan/assente."""
        if val is None:
            return None
        try:
            v = float(val)
            return v if v == v else None   # NaN check
        except (TypeError, ValueError):
            return None

    def get(row, idx):
        """Legge row[idx] in sicurezza; None se idx è None o fuori range."""
        if idx is None or idx >= len(row):
            return None
        return row[idx]

    # ── Scansione righe dati: dalla riga 4 in poi (la 3 è totale agente) ───
    records = []
    for i in range(4, len(df)):
        row = df.iloc[i].tolist()

        cod_cliente = row[_FIXED['cod_cliente']]
        if not cod_cliente or str(cod_cliente) == 'nan':
            continue

        records.append({
            "codice_cliente":         str(int(float(cod_cliente))),
            "ragione_sociale":        str(row[_FIXED['rag_sociale']]).strip()
                                      if str(row[_FIXED['rag_sociale']]) != 'nan' else None,
            "divisione":              str(row[_FIXED['divisione']]).strip()
                                      if str(row[_FIXED['divisione']]) != 'nan' else None,
            "data_aggiornamento":     data_agg,

            # Fatturato annuale (colonne fisse)
            "fatturato_2024":         n(row[_FIXED['fatt_2024']]),
            "fatturato_2025":         n(row[_FIXED['fatt_2025']]),

            # Mensile 2025 (12 mesi fissi)
            **{f"fatt_{m}_2025": n(row[_FIXED[f'fatt_{m}_2025']]) for m in MESI_DB},

            # Progressivo 2026 (colonna fissa)
            "fatt_prog_gen_apr_2026": n(row[_FIXED['fatt_prog_gen_apr_2026']]),

            # GTO 2026 — trovati per nome intestazione
            **{f"gto_{m}_2026": n(get(row, gto_map.get(m))) for m in MESI_DB},

            # Mese corrente
            "mese_consegnato":        n(get(row, c_cons)),
            "mese_in_preparazione":   n(get(row, c_prep)),
            "mese_da_spedire":        n(get(row, c_sped)),
            "ordinato_oltre_mese":    n(get(row, c_oltre)),

            # Confronto mese
            "fatt_mese_anno_prec":    n(get(row, c_prec_mese)),
            "spedito_ordinato_mese":  n(get(row, c_sped_ord)),
            "variazione_mese":        n(get(row, c_var_mese)),

            # Confronto progressivo
            "fatt_prog_anno_prec":    n(get(row, c_prog_prec)),
            "fatt_prog_anno_corr":    n(get(row, c_prog_corr)),
            "variazione_progressivo": n(get(row, c_var_prog)),
        })

    return records


# ── Import su Supabase ────────────────────────────────────────────────────────

def importa_rolling(filepath, client):
    print(f"\n📊 {os.path.basename(filepath)}")

    records = parse_rolling(filepath)
    if not records:
        print("  ❌ Nessun dato trovato")
        return False

    print(f"  Clienti trovati: {len(records)}")

    ok = errori = 0
    BATCH = 50
    for i in range(0, len(records), BATCH):
        batch = records[i:i + BATCH]
        try:
            client.table("rolling_fatturato").upsert(
                batch,
                on_conflict="codice_cliente,data_aggiornamento"
            ).execute()
            ok += len(batch)
        except Exception as e:
            print(f"  ❌ Batch {i}: {e}")
            errori += len(batch)

    print(f"  ✅ Importati: {ok} | ❌ Errori: {errori}")
    return errori == 0


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Importa un file rolling Excel in Supabase"
    )
    parser.add_argument("file", help="Path al file Excel rolling da importare")
    args = parser.parse_args()

    load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))
    load_dotenv()

    supabase_url = os.environ.get('SUPABASE_URL')
    supabase_key = os.environ.get('SUPABASE_KEY')
    if not supabase_url or not supabase_key:
        raise RuntimeError(
            'SUPABASE_URL e SUPABASE_KEY devono essere definiti in .claude/.env o nell\'ambiente'
        )

    client = create_client(supabase_url, supabase_key)
    success = importa_rolling(args.file, client)
    exit(0 if success else 1)


if __name__ == '__main__':
    main()
