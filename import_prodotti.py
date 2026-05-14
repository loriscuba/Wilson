"""
WILSON - Import Prodotti
Importa i 4940 prodotti dal listino Fischer su Supabase.

Uso:
  pip install pandas openpyxl supabase
  python import_prodotti.py
"""

import pandas as pd
from supabase import create_client
import os
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
FILE_XLSX    = "Listino_generale_fischer_aprile2026_10_digits.xlsx"
DATA_LISTINO = "2026-04-01"
BATCH_SIZE   = 100  # inserimento a batch per velocità
# ------------------------------------------------------------

client = create_client(SUPABASE_URL, SUPABASE_KEY)

print("📖 Lettura listino Fischer...")
df = pd.read_excel(FILE_XLSX)
df.columns = [c.strip() for c in df.columns]

# Carica lookup famiglie
print("🔍 Caricamento lookup famiglie...")
fam_res = client.table("famiglie_prodotto").select("id, nome").execute()
fam_map = {r["nome"]: r["id"] for r in fam_res.data}

# Carica lookup sottofamiglie
print("🔍 Caricamento lookup sottofamiglie...")
sub_res = client.table("sottofamiglie_prodotto").select("id, nome").execute()
sub_map = {r["nome"]: r["id"] for r in sub_res.data}

# Inserisci sottofamiglie mancanti (con famiglia collegata)
print("🔧 Verifica sottofamiglie...")
for _, row in df.drop_duplicates(subset=["desc.liv.3"]).iterrows():
    sf = str(row.get("desc.liv.3", "")).strip()
    fam = str(row.get("desc.liv.2", "")).strip()
    if sf and sf not in sub_map and sf != "nan":
        record = {
            "nome": sf,
            "famiglia_id": fam_map.get(fam)
        }
        try:
            res = client.table("sottofamiglie_prodotto").upsert(record, on_conflict="nome").execute()
            if res.data:
                sub_map[sf] = res.data[0]["id"]
        except Exception as e:
            print(f"  ⚠️ Sottofamiglia '{sf}': {e}")

# Prepara record prodotti
print(f"📦 Preparazione {len(df)} prodotti...")
records = []

for _, row in df.iterrows():
    codice = str(row.get("codice articolo", "")).strip()
    descrizione = str(row.get("descrizione", "")).strip()
    if not codice or not descrizione or codice == "nan":
        continue

    prezzo = row.get("listino con 2 decimali")
    try:
        prezzo = float(prezzo) if pd.notna(prezzo) else None
    except:
        prezzo = None

    def safe_int(val):
        try:
            return int(val) if pd.notna(val) else None
        except:
            return None

    fam_nome = str(row.get("desc.liv.2", "")).strip()
    sub_nome = str(row.get("desc.liv.3", "")).strip()

    records.append({
        "codice_articolo": codice,
        "descrizione": descrizione,
        "descrizione_etichetta": str(row.get("descr. per etic.", "")).strip() or None,
        "ean_confezione": str(row.get("EAN confezione", "")).strip() or None,
        "unita_misura": str(row.get("unità di misura di base", "")).strip() or None,
        "pezzi_per_confezione": safe_int(row.get("pezzi per confezione")),
        "pezzi_per_imballo": safe_int(row.get("pezzi per imballo")),
        "quantita_minima": safe_int(row.get("quantità minima")),
        "moltiplicatore": safe_int(row.get("moltiplicatore")),
        "prezzo_listino": prezzo,
        "famiglia_id": fam_map.get(fam_nome),
        "sottofamiglia_id": sub_map.get(sub_nome),
        "data_listino": DATA_LISTINO,
        "attivo": True,
    })

# Inserimento a batch
print(f"🚀 Inserimento in batch da {BATCH_SIZE}...")
ok = 0
errori = 0

for i in range(0, len(records), BATCH_SIZE):
    batch = records[i:i+BATCH_SIZE]
    try:
        client.table("prodotti").upsert(batch, on_conflict="codice_articolo").execute()
        ok += len(batch)
        print(f"  ✅ {ok}/{len(records)}")
    except Exception as e:
        print(f"  ❌ Batch {i}-{i+BATCH_SIZE}: {e}")
        errori += len(batch)

print(f"\n✅ Importati: {ok} | ❌ Errori: {errori}")
