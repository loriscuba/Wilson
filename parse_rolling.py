"""
WILSON - Parser Rolling Fatturato
File: ordini_mancanti_su_rolling_consuntivo-DD-MM-YYYY_XXXXXXXX.xlsx

Legge il file rolling e carica i dati di fatturato mensile per cliente su Supabase.
"""

import argparse
import os
import re
from datetime import datetime

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client


def parse_rolling(filepath):
    """Legge il file rolling e restituisce lista di record per cliente."""
    df = pd.read_excel(filepath, sheet_name='REPORT', header=None)

    # Data aggiornamento dalla riga 1 (colonna 2)
    # Fallback sempre al nome file: celle Excel con date italiane (DD/MM/YYYY) vengono
    # lette come MM/DD/YYYY da openpyxl e producono date future (es. 05/11 → 5 nov).
    data_raw = df.iloc[1][2]
    data_agg = None
    if hasattr(data_raw, 'strftime'):
        candidate = data_raw.strftime("%Y-%m-%d")
        if candidate <= datetime.today().strftime("%Y-%m-%d"):
            data_agg = candidate
        else:
            print(f"  ⚠️  Data cella Excel futura ({candidate}), uso nome file come fallback")
    if not data_agg:
        m = re.search(r'consuntivo-(\d{2}-\d{2}-\d{4})', os.path.basename(filepath))
        data_agg = datetime.strptime(m.group(1), "%d-%m-%Y").strftime("%Y-%m-%d") if m else None

    def n(val):
        """Converte in float, None se nan."""
        try:
            v = float(val)
            return v if v == v else None  # NaN check
        except:
            return None

    records = []
    # Righe dati: dalla riga 4 in poi (indice 4), salta riga 3 che è totale agente
    for i in range(4, len(df)):
        row = df.iloc[i].tolist()

        cod_cliente = row[5]
        if not cod_cliente or str(cod_cliente) == 'nan':
            continue

        records.append({
            "codice_cliente":         str(int(float(cod_cliente))),
            "ragione_sociale":        str(row[6]).strip() if str(row[6]) != 'nan' else None,
            "divisione":              str(row[2]).strip() if str(row[2]) != 'nan' else None,
            "data_aggiornamento":     data_agg,

            # Fatturato annuale
            "fatturato_2024":         n(row[7]),
            "fatturato_2025":         n(row[8]),

            # Mensile 2025
            "fatt_gen_2025":          n(row[9]),
            "fatt_feb_2025":          n(row[10]),
            "fatt_mar_2025":          n(row[11]),
            "fatt_apr_2025":          n(row[12]),
            "fatt_mag_2025":          n(row[13]),
            "fatt_giu_2025":          n(row[14]),
            "fatt_lug_2025":          n(row[15]),
            "fatt_ago_2025":          n(row[16]),
            "fatt_set_2025":          n(row[17]),
            "fatt_ott_2025":          n(row[18]),
            "fatt_nov_2025":          n(row[19]),
            "fatt_dic_2025":          n(row[20]),

            # Progressivo 2026
            "fatt_prog_gen_apr_2026": n(row[21]),

            # GTO 2026
            "gto_gen_2026":           n(row[22]),
            "gto_feb_2026":           n(row[23]),
            "gto_mar_2026":           n(row[24]),
            "gto_apr_2026":           n(row[25]),
            "gto_mag_2026":           n(row[26]),
            "gto_giu_2026":           None,  # Non disponibile ancora
            "gto_lug_2026":           None,  # Non disponibile ancora
            "gto_ago_2026":           None,  # Non disponibile ancora
            "gto_set_2026":           None,  # Non disponibile ancora
            "gto_ott_2026":           None,  # Non disponibile ancora
            "gto_nov_2026":           None,  # Non disponibile ancora
            "gto_dic_2026":           None,  # Non disponibile ancora

            # Mese corrente
            "mese_consegnato":        n(row[34]),
            "mese_in_preparazione":   n(row[35]),
            "mese_da_spedire":        n(row[36]),
            "ordinato_oltre_mese":    n(row[37]),

            # Confronto mese
            "fatt_mese_anno_prec":    n(row[38]),
            "spedito_ordinato_mese":  n(row[39]),
            "variazione_mese":        n(row[40]),

            # Confronto progressivo
            "fatt_prog_anno_prec":    n(row[41]),
            "fatt_prog_anno_corr":    n(row[42]),
            "variazione_progressivo": n(row[43]),
        })

    return records


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
        batch = records[i:i+BATCH]
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
        raise RuntimeError('SUPABASE_URL e SUPABASE_KEY devono essere definiti in .claude/.env o nell\'ambiente')

    client = create_client(supabase_url, supabase_key)
    success = importa_rolling(args.file, client)
    exit(0 if success else 1)


if __name__ == '__main__':
    main()
