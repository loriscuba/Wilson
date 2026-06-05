"""
WILSON - Update Anagrafica Clienti
Aggiorna ragione_sociale, indirizzo, cap, citta, provincia
dai dati del file Clienti_Update.xlsx.
Usa upsert su codice_cliente; non tocca settore, categoria, giorno_visita, note.
"""

import pandas as pd
from supabase import create_client
import os
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
FILE = "allegati/Clienti_Update.xlsx"

client = create_client(SUPABASE_URL, SUPABASE_KEY)

print("📖 Lettura file Excel...")
df = pd.read_excel(FILE)
df.columns = [c.strip() for c in df.columns]
print(f"   {len(df)} righe trovate")

ok = 0
errori = 0

for _, row in df.iterrows():
    codice = str(int(row["Cliente"]))
    record = {
        "codice_cliente":  codice,
        "ragione_sociale": str(row["Nome 1"]).strip() if pd.notna(row["Nome 1"]) else None,
        "indirizzo":       str(row["Via"]).strip()    if pd.notna(row["Via"])    else None,
        "cap":             str(row["CAP"]).strip()    if pd.notna(row["CAP"])    else None,
        "citta":           str(row["Città"]).strip()  if pd.notna(row["Città"])  else None,
        "provincia":       str(row["Prov"]).strip()   if pd.notna(row["Prov"])   else None,
    }
    try:
        client.table("clienti").upsert(record, on_conflict="codice_cliente").execute()
        ok += 1
    except Exception as e:
        print(f"  ❌ {codice}: {e}")
        errori += 1

print(f"\n✅ Aggiornati: {ok} | ❌ Errori: {errori}")
