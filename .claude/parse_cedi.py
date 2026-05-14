"""
WILSON - Parser Cedi Ridistribuito
File: Agente_Nord_Ovest_Monitoraggio_cedi.xlsx

Legge il file cedi e carica i dati di redistribuzione per cliente su Supabase.
"""

import os
from datetime import datetime
import pandas as pd


def parse_cedi(filepath):
    """Legge il file cedi e restituisce lista di record."""
    df = pd.read_excel(filepath, header=None)

    # Data aggiornamento dalla riga 0, colonna 2
    data_raw = df.iloc[0][2]
    if hasattr(data_raw, 'strftime'):
        data_agg = data_raw.strftime("%Y-%m-%d")
    else:
        data_agg = datetime.today().strftime("%Y-%m-%d")

    records = []
    # Struttura reale (colonne 0-11):
    # 0=x, 1=Dati al, 2=data, 3=nan, 4=cod_agenzia, 5=nome_agenzia,
    # 6=area, 7=cod_venditore, 8=nome_venditore, 9=cod_cliente, 10=desc_cliente, 11=cedi_ridistribuito
    for i in range(1, len(df)):
        row = df.iloc[i].tolist()

        cod_cliente = row[9]
        if not cod_cliente or str(cod_cliente) == 'nan':
            continue
        try:
            cod_cliente_str = str(int(float(cod_cliente)))
        except (ValueError, TypeError):
            continue  # salta righe totale/intestazione

        cod_venditore = row[7]
        try:
            cod_venditore_str = str(int(float(cod_venditore))) if str(cod_venditore) != 'nan' else None
        except (ValueError, TypeError):
            continue  # salta righe subtotale tipo "400141 Totale"

        if cod_venditore_str != '400542':  # solo Cubaiu Loris
            continue

        try:
            valore = float(row[11]) if str(row[11]) != 'nan' else 0.0
        except:
            valore = 0.0

        records.append({
            "codice_cliente":        cod_cliente_str,
            "ragione_sociale":       str(row[10]).strip() if str(row[10]) != 'nan' else None,
            "area":                  str(row[6]).strip() if str(row[6]) != 'nan' else None,
            "cod_venditore":         cod_venditore_str,
            "nome_venditore":        str(row[8]).strip() if str(row[8]) != 'nan' else None,
            "valore_ridistribuito":  valore,
            "data_aggiornamento":    data_agg,
        })

    return records


def importa_cedi(filepath, client):
    print(f"\n🏪 {os.path.basename(filepath)}")

    records = parse_cedi(filepath)
    if not records:
        print("  ❌ Nessun dato trovato")
        return False

    print(f"  Righe trovate: {len(records)}")

    ok = errori = 0
    BATCH = 50
    for i in range(0, len(records), BATCH):
        batch = records[i:i+BATCH]
        try:
            client.table("cedi_ridistribuito").upsert(
                batch,
                on_conflict="codice_cliente,cod_venditore,data_aggiornamento"
            ).execute()
            ok += len(batch)
        except Exception as e:
            print(f"  ❌ Batch {i}: {e}")
            errori += len(batch)

    print(f"  ✅ Importati: {ok} | ❌ Errori: {errori}")
    return errori == 0
