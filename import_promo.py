"""
WILSON - Import Promozione
Inserisce una promo mensile Fischer su Supabase dalla sessione Claude.

Uso:
  python import_promo.py

Prima di eseguire, imposta SUPABASE_URL e SUPABASE_KEY nell'env o nel file .env
"""

from supabase import create_client
import os
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]

# ── Dati promo (compilati da Claude dopo parsing PDF) ──────────────────────────
# Modifica PROMOS con le promo estratte dal PDF, poi esegui lo script.
# "famiglie" e "codici_extra" restano vuoti: l'utente li seleziona nell'app
# (setup "Famiglie prodotto") alla prima apertura della promo.

PROMOS = [
    {
        "nome":           "DISCHI da TAGLIO e DISCHI ABRASIVI",
        "mese":           4,
        "anno":           2026,
        "data_inizio":    "2026-04-01",
        "data_fine":      "2026-04-30",
        "settore":        "Edilizia",
        "divisione":      "11",
        "famiglie":       [],     # da selezionare nell'app (suggerito: "Dischi da taglio e da molatura")
        "codici_extra":   [],
        "condizioni":     (
            "Condizioni standard: sconto base, volume.\n"
            "• Per un acquisto di minimo €100 di DISCHI su un ordine minimo di €650 viene riconosciuto uno sconto in testata del 5%.\n"
            "• Per ordini di importo superiori a €3.000 viene riconosciuto uno sconto massimo ad importo di €150.\n"
            "• NON CUMULABILE AD ALTRE OPERAZIONI PROMOZIONALI IN CORSO.\n"
            "A supporto della PROMO DISCHI: display da banco formato A4, art. 578435."
        ),
        "note_ordine":    "ORDINE PROMO DISCHI",
        "non_cumulabile": True,
        "attiva":         True,
        "pdf_nome":       "Promo_APRILE_2026_EDILIZIA.pdf",
    },
    {
        "nome":           "SDX D-SDX — Punte",
        "mese":           4,
        "anno":           2026,
        "data_inizio":    "2026-04-01",
        "data_fine":      "2026-04-30",
        "settore":        "Edilizia",
        "divisione":      "11",
        "famiglie":       [],     # da selezionare nell'app (suggerito: "Punte")
        "codici_extra":   ["5044590"],  # HAG incluso direttamente
        "condizioni":     (
            "Condizioni standard: base, volume, sconto Famiglia (HAG art. 5044590).\n"
            "• Extra sconto 10% per acquisti di minimo 100 punte, anche assortite.\n"
            "• Extra sconto 15% per acquisti di minimo 150 punte, anche assortite.\n"
            "• NON CUMULABILE AD ALTRE OPERAZIONI PROMOZIONALI IN CORSO."
        ),
        "note_ordine":    "",
        "non_cumulabile": True,
        "attiva":         True,
        "pdf_nome":       "Promo_APRILE_2026_EDILIZIA.pdf",
    },
]

# ── Insert ─────────────────────────────────────────────────────────────────────

client = create_client(SUPABASE_URL, SUPABASE_KEY)

print(f"🚀 Inserimento {len(PROMOS)} promo su Supabase…")
for p in PROMOS:
    try:
        res = client.table("promozioni").upsert(
            p,
            on_conflict="nome,anno,mese",
        ).execute()
        print(f"  ✅ {p['nome']}")
    except Exception as e:
        print(f"  ❌ {p['nome']}: {e}")

print("\nDone. Apri la sezione Promozioni nell'app per configurare le famiglie prodotto.")
