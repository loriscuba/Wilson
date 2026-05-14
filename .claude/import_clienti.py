"""
WILSON - Import Clienti
Importa i clienti dal file PORTAFOGLIO.xls su Supabase.

Uso:
  pip install pandas xlrd supabase
  python import_clienti.py
"""

import pandas as pd
from supabase import create_client
import os
import re
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
FILE_XLS     = "Cubaiu Loris_PORTAFOGLIO.xls"
# ------------------------------------------------------------

client = create_client(SUPABASE_URL, SUPABASE_KEY)

print("📖 Lettura file Excel...")
df = pd.read_excel(FILE_XLS, engine="xlrd")
df.columns = [c.strip() for c in df.columns]

# Pulizia civico (colonna ha date spurie tipo 2022-04-16)
def pulisci_civico(val):
    if pd.isna(val):
        return None
    val = str(val).strip()
    # Se è una data in formato timestamp, estrai solo la parte numerica finale
    if re.match(r"\d{4}-\d{2}-\d{2}", val):
        # prende solo i numeri significativi dal timestamp (es. giorno)
        return None
    return val if val else None

# Carica lookup settori
print("🔍 Caricamento lookup settori...")
settori_res = client.table("settori").select("id, nome").execute()
settori_map = {r["nome"]: r["id"] for r in settori_res.data}

print("🔍 Caricamento lookup categorie...")
cat_res = client.table("categorie").select("id, nome").execute()
cat_map = {r["nome"]: r["id"] for r in cat_res.data}

# Importa clienti
print(f"📥 Importazione {len(df)} clienti...")
ok = 0
errori = 0

for _, row in df.iterrows():
    record = {
        "codice_cliente": str(int(row["COD CLIENTE"])),
        "ragione_sociale": str(row["Cliente"]).strip(),
        "indirizzo": str(row["Indirizzo"]).strip() if pd.notna(row["Indirizzo"]) else None,
        "civico": pulisci_civico(row["Indirizzo_Numereo"]),
        "citta": str(row["Citta"]).strip() if pd.notna(row["Citta"]) else None,
        "provincia": str(row["PROV"]).strip() if pd.notna(row["PROV"]) else None,
        "giorno_visita": str(row["GG SETTIMANA"]).strip() if pd.notna(row["GG SETTIMANA"]) else None,
        "settore_id": settori_map.get(str(row["settore"]).strip()),
        "categoria_id": cat_map.get(str(row["categoria"]).strip()),
        "attivo": True,
    }

    try:
        client.table("clienti").upsert(record, on_conflict="codice_cliente").execute()
        ok += 1
    except Exception as e:
        print(f"  ❌ Errore cliente {record['codice_cliente']}: {e}")
        errori += 1

print(f"\n✅ Importati: {ok} | ❌ Errori: {errori}")
