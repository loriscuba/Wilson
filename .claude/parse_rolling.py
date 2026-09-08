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

    # ── Data aggiornamento: priorità al nome file ─────────────────────────────
    # La cella Excel contiene la data dell'ultimo batch interno Fischer,
    # che può essere settimane precedente rispetto alla data effettiva del file.
    data_agg = None
    m = re.search(r'consuntivo-(\d{2}-\d{2}-\d{4})', os.path.basename(filepath))
    if m:
        data_agg = datetime.strptime(m.group(1), "%d-%m-%Y").strftime("%Y-%m-%d")
        print(f"  📅 Data da nome file: {data_agg}")

    # Fallback alla cella Excel solo se il nome file non ha una data valida
    if not data_agg:
        data_raw = df.iloc[1][2]
        today_str = datetime.today().strftime("%Y-%m-%d")
        if hasattr(data_raw, 'strftime'):
            candidate = data_raw.strftime("%Y-%m-%d")
            if candidate <= today_str:
                data_agg = candidate
                print(f"  📅 Data da cella Excel: {data_agg}")
            else:
                print(f"  ⚠️  Data cella Excel futura ({candidate}), nessuna data disponibile")
        elif isinstance(data_raw, str):
            for fmt in ("%d/%m/%Y", "%d/%m/%y", "%Y-%m-%d", "%d-%m-%Y"):
                try:
                    today_str = datetime.today().strftime("%Y-%m-%d")
                    candidate = datetime.strptime(data_raw.strip(), fmt).strftime("%Y-%m-%d")
                    if candidate <= today_str:
                        data_agg = candidate
                        print(f"  📅 Data da cella Excel (stringa): {data_agg}")
                    else:
                        print(f"  ⚠️  Data cella Excel futura ({candidate}), nessuna data disponibile")
                    break
                except ValueError:
                    continue

    def n(val):
        """Converte in float, None se nan."""
        try:
            v = float(val)
            return v if v == v else None  # NaN check
        except:
            return None

    def safe(row, idx):
        return row[idx] if 0 <= idx < len(row) else None

    # ── Rilevamento posizioni colonne dal header (riga 2) ─────────────────────
    # Le etichette cambiano ogni mese (hanno la data incorporata, es. "al 05/06/2026"),
    # quindi non possiamo matchare per nome esatto ma usiamo keyword.
    # Offset fisso: header_index + 5 = data_index (es. header[2]="Fatturato 2024" → data[7]).
    COL_OFFSET = 5
    raw_hdr = df.iloc[2].tolist()
    header  = [str(c).strip().replace('\n', ' ') if pd.notna(c) else '' for c in raw_hdr]

    # GTO: cerca tutte le colonne "GTO <mese>'26" nel header
    MESI_ABBR = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic']
    gto_idx = {i: 22 + i for i in range(12)}   # fallback: gen=22 … dic=33
    gto_trovati = 0
    for hi, lbl in enumerate(header):
        if not lbl or 'gto' not in lbl.lower():
            continue
        for mi, abbr in enumerate(MESI_ABBR):
            if abbr in lbl.lower():
                gto_idx[mi] = hi + COL_OFFSET
                gto_trovati += 1
                break

    # Blocco "mese corrente": ancorato alla colonna "MESE: Consegnato …"
    # I 9 campi successivi sono SEMPRE nello stesso ordine relativo.
    i_cons = next(
        (hi + COL_OFFSET for hi, lbl in enumerate(header)
         if lbl and 'mese' in lbl.lower() and 'consegnato' in lbl.lower()),
        34  # fallback storico
    )
    i_prep  = i_cons + 1   # in preparazione
    i_sped  = i_cons + 2   # da spedire
    i_oltre = i_cons + 3   # ordinato oltre mese
    i_prec  = i_cons + 4   # fatt_mese_anno_prec  (stesso mese anno scorso)
    i_mord  = i_cons + 5   # spedito_ordinato_mese
    i_varm  = i_cons + 6   # variazione_mese
    i_pprec = i_cons + 7   # fatt_prog_anno_prec
    i_pcorr = i_cons + 8   # fatt_prog_anno_corr
    i_vprog = i_cons + 9   # variazione_progressivo

    print(f"  📋 Header: {len(header)} col · GTO rilevati: {gto_trovati}/12 · blocco mese a col {i_cons}")

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

            # Progressivo 2026 (gen–mese corrente, etichetta cambia col mese)
            "fatt_prog_gen_apr_2026": n(row[21]),

            # GTO 2026 – tutti e 12 i mesi letti dinamicamente dal header
            "gto_gen_2026":           n(safe(row, gto_idx[0])),
            "gto_feb_2026":           n(safe(row, gto_idx[1])),
            "gto_mar_2026":           n(safe(row, gto_idx[2])),
            "gto_apr_2026":           n(safe(row, gto_idx[3])),
            "gto_mag_2026":           n(safe(row, gto_idx[4])),
            "gto_giu_2026":           n(safe(row, gto_idx[5])),
            "gto_lug_2026":           n(safe(row, gto_idx[6])),
            "gto_ago_2026":           n(safe(row, gto_idx[7])),
            "gto_set_2026":           n(safe(row, gto_idx[8])),
            "gto_ott_2026":           n(safe(row, gto_idx[9])),
            "gto_nov_2026":           n(safe(row, gto_idx[10])),
            "gto_dic_2026":           n(safe(row, gto_idx[11])),

            # Mese corrente – posizioni rilevate dinamicamente dal header
            "mese_consegnato":        n(safe(row, i_cons)),
            "mese_in_preparazione":   n(safe(row, i_prep)),
            "mese_da_spedire":        n(safe(row, i_sped)),
            "ordinato_oltre_mese":    n(safe(row, i_oltre)),

            # Confronto mese
            "fatt_mese_anno_prec":    n(safe(row, i_prec)),
            "spedito_ordinato_mese":  n(safe(row, i_mord)),
            "variazione_mese":        n(safe(row, i_varm)),

            # Confronto progressivo
            "fatt_prog_anno_prec":    n(safe(row, i_pprec)),
            "fatt_prog_anno_corr":    n(safe(row, i_pcorr)),
            "variazione_progressivo": n(safe(row, i_vprog)),
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
