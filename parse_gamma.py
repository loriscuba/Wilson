"""
WILSON - Parser Gamma Penetrazione Prodotti
File: *_report_penetrazione_gamma_prodotti_MM-YYYY*.xlsx

Legge il report di penetrazione gamma per settore cliente e carica i dati
su Supabase nella tabella gamma_penetrazione.

Struttura file:
  - Un foglio per settore cliente (ITS, Ferr Serr Legno, Edile, ecc.)
  - Riga "MACROAREA": intestazione colonne
  - Col 0: macroarea   Col 1: cod_agente   Col 2: nome_agente
  - Col 3: %immancabili  Col 4: %strategiche
  - Col 5: cod_cliente   Col 6: ragione_sociale   Col 7: localita
  - Col 8: online        Col 9: fatturato_anno
  - Col 10+: valore per singolo prodotto strategico/immancabile

Uso standalone:
  python parse_gamma.py <file.xlsx>
  python parse_gamma.py <file.xlsx> --agente 400542
"""

import argparse
import os
from collections import Counter

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client


COD_AGENTE_DEFAULT = '400542'   # Cubaiu Loris
SKIP_SHEETS = {'Riassunto'}


def _n(val):
    """Converte in float, None se nan/vuoto."""
    try:
        v = float(val)
        return v if v == v else None  # NaN guard
    except (ValueError, TypeError):
        return None


def parse_gamma(filepath, cod_agente=COD_AGENTE_DEFAULT):
    """
    Legge il file gamma e restituisce lista di record per (cliente, settore).
    Se cod_agente è None importa tutti gli agenti.
    """
    xl = pd.ExcelFile(filepath)
    records = []

    for sheet_name in xl.sheet_names:
        if sheet_name in SKIP_SHEETS:
            continue

        df = xl.parse(sheet_name, header=None)
        rows = df.values.tolist()

        # Data aggiornamento: riga "Periodo:", colonna 2 = fine periodo
        data_agg = None
        for row in rows:
            if row[0] == 'Periodo:':
                raw = row[2]
                if hasattr(raw, 'strftime'):
                    data_agg = raw.strftime("%Y-%m-%d")
                break

        # Trova riga intestazione (col 0 == 'MACROAREA')
        hdr_idx = next((i for i, row in enumerate(rows) if row[0] == 'MACROAREA'), None)
        if hdr_idx is None:
            print(f"  ⚠️  [{sheet_name}] intestazione non trovata, skip")
            continue

        hdr = rows[hdr_idx]

        # Mappa colonne prodotto: indice → etichetta (col 10 in poi, non nulle)
        prod_cols = {
            i: str(hdr[i]).strip()
            for i in range(10, len(hdr))
            if hdr[i] is not None and str(hdr[i]).strip() not in ('', 'nan', 'None')
        }

        for row in rows[hdr_idx + 1:]:
            # Col 1 = cod_agente
            agente_raw = row[1]
            if agente_raw is None or str(agente_raw) == 'nan':
                continue
            agente = str(agente_raw).strip()

            # Salta righe di subtotale (es. "400141 Totale")
            try:
                int(float(agente))
            except (ValueError, TypeError):
                continue

            if cod_agente is not None and agente != cod_agente:
                continue

            # Col 5 = codice cliente
            cod_raw = row[5]
            if cod_raw is None or str(cod_raw) == 'nan':
                continue
            try:
                cod_cliente = str(int(float(cod_raw)))
            except (ValueError, TypeError):
                continue

            # Prodotti acquistati: dizionario {etichetta: valore} solo se > 0
            prodotti = {
                label: round(_n(row[col_idx]), 2)
                for col_idx, label in prod_cols.items()
                if col_idx < len(row) and _n(row[col_idx]) is not None and _n(row[col_idx]) > 0
            }

            records.append({
                "codice_cliente":       cod_cliente,
                "ragione_sociale":      str(row[6]).strip() if row[6] is not None and str(row[6]) != 'nan' else None,
                "settore":              sheet_name,
                "macroarea":            str(row[0]).strip() if row[0] is not None and str(row[0]) != 'nan' else None,
                "cod_agente":           agente,
                "pct_immancabili":      _n(row[3]),
                "pct_strategiche":      _n(row[4]),
                "fatturato_anno":       _n(row[9]),
                "prodotti_acquistati":  prodotti if prodotti else None,
                "data_aggiornamento":   data_agg,
            })

    return records


def importa_gamma(filepath, client):
    print(f"\n🎯 {os.path.basename(filepath)}")

    records = parse_gamma(filepath)
    if not records:
        print("  ❌ Nessun dato trovato")
        return False

    # Riepilogo per settore
    cnt = Counter(r['settore'] for r in records)
    for settore, n in sorted(cnt.items()):
        print(f"  [{settore}] {n} clienti")
    print(f"  Totale: {len(records)} record")

    ok = errori = 0
    BATCH = 50
    for i in range(0, len(records), BATCH):
        batch = records[i:i + BATCH]
        try:
            client.table("gamma_penetrazione").upsert(
                batch,
                on_conflict="codice_cliente,settore,data_aggiornamento"
            ).execute()
            ok += len(batch)
        except Exception as e:
            print(f"  ❌ Batch {i}: {e}")
            errori += len(batch)

    print(f"  ✅ Importati: {ok} | ❌ Errori: {errori}")
    return errori == 0


def main():
    parser = argparse.ArgumentParser(
        description="Importa un file gamma penetrazione prodotti in Supabase"
    )
    parser.add_argument("file", help="Path al file Excel gamma da importare")
    parser.add_argument(
        "--agente", default=COD_AGENTE_DEFAULT,
        help=f"Codice agente da filtrare (default: {COD_AGENTE_DEFAULT}). "
             "Usa 'tutti' per importare tutti gli agenti."
    )
    args = parser.parse_args()

    load_dotenv(os.path.join(os.path.dirname(__file__), '.claude', '.env'))
    load_dotenv()

    supabase_url = os.environ.get('SUPABASE_URL')
    supabase_key = os.environ.get('SUPABASE_KEY')
    if not supabase_url or not supabase_key:
        raise RuntimeError(
            'SUPABASE_URL e SUPABASE_KEY devono essere definiti in .claude/.env o nell\'ambiente'
        )

    cod = None if args.agente == 'tutti' else args.agente
    client = create_client(supabase_url, supabase_key)
    success = importa_gamma(args.file, client)
    exit(0 if success else 1)


if __name__ == '__main__':
    main()
