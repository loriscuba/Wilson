"""
WILSON - Parser Monitoraggio Prodotti Focus / Promo
File: monitoraggio_promo&trimestrale_Area_No_DDMMYYYY.pdf

Legge il PDF area Nord-Ovest, estrae i dati dell'agente 400542 (Cubaiu Loris)
dalla tabella "Monitoraggio prodotti FOCUS" e li carica in `budget_focus`.

Struttura tabella `budget_focus`:
  data_aggiornamento, mese, gruppo_prodotti, target_eur, consegnato_eur
"""

import os
import re
import argparse
from datetime import datetime

import pdfplumber
from dotenv import load_dotenv
from supabase import create_client

load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))
load_dotenv()

# Codice agente da filtrare
CODICE_AGENTE = "400542"

# Nomi dei gruppi prodotto (label usata in DB)
GRUPPO_1 = "Gruppo 1 (DUOBLADE · DuoHM · FBS II · HP · FIS EM+ · FIS A · PowerFast II · PowerFull II)"
GRUPPO_2 = "Gruppo 2 (FBS II D6 · FIS V ZERO · FLS · Antisismici · Fissaggi WC · TCS · FUS)"


def _num(s):
    if s is None:
        return None
    s = str(s).strip().replace('.', '').replace(',', '.')
    try:
        return float(s)
    except ValueError:
        return None


def _extract_date_from_filename(filepath):
    """monitoraggio_promo&trimestrale_Area_No_20052026.pdf → '2026-05-20'"""
    name = os.path.basename(filepath)
    m = re.search(r'(\d{2})(\d{2})(\d{4})', name)
    if m:
        return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    return None


MESI_IT = {
    "gennaio": "01", "febbraio": "02", "marzo": "03", "aprile": "04",
    "maggio": "05", "giugno": "06", "luglio": "07", "agosto": "08",
    "settembre": "09", "ottobre": "10", "novembre": "11", "dicembre": "12",
}


def parse_monitoraggio(filepath):
    """
    Ritorna lista di record per budget_focus (uno per gruppo), oppure [].

    Struttura tabella pdfplumber (6 righe x 15 colonne):
      row[0] = header codici agente (col 3–13)
      row[2] = Gruppo 1 Target
      row[3] = Gruppo 1 Consegnato
      row[4] = Gruppo 2 Target
      row[5] = Gruppo 2 Consegnato
    """
    with pdfplumber.open(filepath) as pdf:
        text = "\n".join(page.extract_text() or "" for page in pdf.pages)
        page = pdf.pages[0]
        tables = page.extract_tables()

    lines = [l.strip() for l in text.splitlines() if l.strip()]
    full  = " ".join(lines)

    # ── Data aggiornamento ──────────────────────────────────────────────────
    data_agg = None
    m = re.search(r'dati al\s+(\d{2}/\d{2}/\d{4})', full, re.IGNORECASE)
    if m:
        data_agg = datetime.strptime(m.group(1), "%d/%m/%Y").strftime("%Y-%m-%d")
    else:
        data_agg = _extract_date_from_filename(filepath)

    if not data_agg:
        print("  ❌  Impossibile determinare la data")
        return []

    # ── Mese ────────────────────────────────────────────────────────────────
    mese_str = None
    m = re.search(r'Obiettivi\s*/\s*Risultati\s+(\w+)', full, re.IGNORECASE)
    if m:
        mese_str = m.group(1).capitalize()
    else:
        for nome in MESI_IT:
            if nome in full.lower():
                mese_str = nome.capitalize()
                break

    # ── Trova colonna agente 400542 nella tabella ───────────────────────────
    if not tables:
        print("  ❌  Nessuna tabella trovata nel PDF")
        return []

    tbl = tables[0]
    col_idx = None

    # L'header (row[0]) contiene celle tipo "400542\nCubaiu\nLoris"
    for cell_idx, cell in enumerate(tbl[0]):
        if cell and CODICE_AGENTE in str(cell):
            col_idx = cell_idx
            break

    if col_idx is None:
        print(f"  ❌  Agente {CODICE_AGENTE} non trovato nell'header della tabella")
        return []

    print(f"  🔍  Agente {CODICE_AGENTE} trovato a colonna {col_idx}")

    def _cell(row, idx):
        if idx < len(row) and row[idx]:
            return _num(str(row[idx]).strip())
        return None

    def _is_target(row):
        return any("target" in str(c).lower() for c in row if c)

    def _is_consegnato(row):
        return any("consegnat" in str(c).lower() for c in row if c)

    def _is_g1(row):
        """Riga appartiene al Gruppo 1 (DUOBLADE ecc.)"""
        txt = " ".join(str(c).lower() for c in row if c)
        return "duoblade" in txt or "powerfull" in txt

    def _is_g2(row):
        """Riga appartiene al Gruppo 2 (FBS II D6 ecc.)"""
        txt = " ".join(str(c).lower() for c in row if c)
        return "fbs ii d6" in txt or "fis v zero" in txt or "fls sistema" in txt

    records = []
    current_group = None

    for row in tbl:
        if _is_g1(row):
            current_group = 1
        elif _is_g2(row):
            current_group = 2

        if current_group is None:
            continue

        if _is_target(row):
            t_val = _cell(row, col_idx)
            # Cerca la riga consegnato successiva per lo stesso gruppo
            # (può già trovarsi dopo nella stessa iterazione — lo gestiamo sotto)
            _pending_target = (current_group, t_val)
            records.append({
                "data_aggiornamento": data_agg,
                "mese":              mese_str,
                "gruppo_prodotti":   GRUPPO_1 if current_group == 1 else GRUPPO_2,
                "target_eur":        t_val,
                "consegnato_eur":    None,
                "_group":            current_group,
            })
        elif _is_consegnato(row):
            c_val = _cell(row, col_idx)
            # Aggiorna l'ultimo record dello stesso gruppo
            for rec in reversed(records):
                if rec.get("_group") == current_group:
                    rec["consegnato_eur"] = c_val
                    break

    # Rimuovi la chiave interna di lavoro
    for rec in records:
        rec.pop("_group", None)

    for r in records:
        print(f"  📌  {r['gruppo_prodotti'][:40]}…  target={r['target_eur']}  consegnato={r['consegnato_eur']}")

    return records


# ── Import Supabase ───────────────────────────────────────────────────────────

def importa_monitoraggio(filepath, client):
    records = parse_monitoraggio(filepath)
    if not records:
        print("  ⚠️  Nessun dato estratto dal PDF monitoraggio")
        return False

    for r in records:
        payload = {k: v for k, v in r.items() if v is not None}
        client.table("budget_focus").upsert(
            payload,
            on_conflict="data_aggiornamento,gruppo_prodotti"
        ).execute()
        print(f"  ✅  budget_focus upserted: {r['data_aggiornamento']} / {r['gruppo_prodotti'][:30]}…")

    return True


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Parser Monitoraggio Promo → tabella budget_focus")
    parser.add_argument("file", help="PDF da importare")
    args = parser.parse_args()

    client = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])
    importa_monitoraggio(args.file, client)
