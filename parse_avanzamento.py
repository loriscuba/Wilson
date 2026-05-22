"""
WILSON - Parser Avanzamento Fatturati Giornalieri
File: Avanzamento_fatturati_giornalieri_DD-MM-YY_*.pdf

Legge il PDF Fischer "Avanzamento fatturati" e carica i dati nella tabella `budget`.
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


# ── Helpers ──────────────────────────────────────────────────────────────────

def _num(s):
    """'435.773' / '-30.514' / '12,0%' → float, oppure None."""
    if s is None:
        return None
    s = str(s).strip().replace('%', '').replace(' ', '')
    s = s.replace('.', '').replace(',', '.')
    try:
        return float(s)
    except ValueError:
        return None


def _extract_date_from_filename(filepath):
    """Avanzamento_fatturati_giornalieri_20-05-26_*.pdf → '2026-05-20'"""
    name = os.path.basename(filepath)
    m = re.search(r'(\d{2})-(\d{2})-(\d{2})', name)
    if m:
        gg, mm, aa = m.group(1), m.group(2), m.group(3)
        return f"20{aa}-{mm}-{gg}"
    return None


# ── Parser PDF ────────────────────────────────────────────────────────────────

def parse_avanzamento(filepath):
    """
    Ritorna un dict con tutti i campi della tabella `budget`, oppure None.
    """
    with pdfplumber.open(filepath) as pdf:
        text = "\n".join(page.extract_text() or "" for page in pdf.pages)

    lines = [l.strip() for l in text.splitlines() if l.strip()]
    full = " ".join(lines)

    # ── Data aggiornamento ──────────────────────────────────────────────────
    data_agg = None
    # "al 20/05/2026" oppure "20/05/2026"
    m = re.search(r'al\s+(\d{2}/\d{2}/\d{4})', full)
    if not m:
        m = re.search(r'(\d{2}/\d{2}/\d{4})', full)
    if m:
        data_agg = datetime.strptime(m.group(1), "%d/%m/%Y").strftime("%Y-%m-%d")
    else:
        data_agg = _extract_date_from_filename(filepath)

    if not data_agg:
        print("  ❌  Impossibile determinare la data dal PDF/nome file")
        return None

    # ── Giorno lavorativo / giorni totali ────────────────────────────────────
    giorno_lav = None
    giorni_tot = None
    m = re.search(r'giorno\s+(\d+)\s*/\s*(\d+)', full, re.IGNORECASE)
    if m:
        giorno_lav = int(m.group(1))
        giorni_tot = int(m.group(2))

    # ── Blocco 1: progressivo gen-apr ────────────────────────────────────────
    # Riga tipo: "400542 Cubaiu Loris 435.773 488.039 52.266 12,0% 52.950 12,2%"
    budget_gen_apr = fatturato_gen_apr = delta_b_eur = delta_b_pct = None
    m = re.search(
        r'400542\s+\S+\s+\S+\s+'       # codice + nome (2 token)
        r'([\d.]+)\s+'                  # budget gen-apr
        r'([\d.]+)\s+'                  # fatturato gen-apr
        r'([\d.]+)\s+'                  # delta EUR
        r'([\d,]+%)\s+'                 # delta %
        r'[\d.]+\s+'                    # delta vs 2025 EUR (ignorato)
        r'[\d,]+%',                     # delta vs 2025 % (ignorato)
        full
    )
    if m:
        budget_gen_apr    = _num(m.group(1))
        fatturato_gen_apr = _num(m.group(2))
        delta_b_eur       = _num(m.group(3))
        delta_b_pct       = _num(m.group(4))
    else:
        # Fallback: cerca i numeri della prima riga dati del blocco gen-apr
        m2 = re.search(
            r'([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d,]+%)\s+[\d.]+\s+[\d,]+%',
            full
        )
        if m2:
            budget_gen_apr    = _num(m2.group(1))
            fatturato_gen_apr = _num(m2.group(2))
            delta_b_eur       = _num(m2.group(3))
            delta_b_pct       = _num(m2.group(4))

    # ── Blocco 2: avanzamento mese ───────────────────────────────────────────
    # Riga tipo: "400542 Cubaiu Loris 109.244 117.192 74.540 12.269 103 -131 86.678 -30.514 -26,0%"
    fat_prec = budget_mese = evaso = ord_mese = ord_oltre = resi = evaso_ord_resi = None
    delta_m_eur = delta_m_pct = None

    m = re.search(
        r'(\d{1,3}(?:\.\d{3})+)\s+'    # fatturato anno prec
        r'(\d{1,3}(?:\.\d{3})+)\s+'    # budget mese
        r'(\d{1,3}(?:\.\d{3})+)\s+'    # evaso
        r'(\d{1,3}(?:\.\d{3})+)\s+'    # ordinato nel mese
        r'(\d+)\s+'                     # ordinato oltre mese (può essere < 1000)
        r'(-?\d+)\s+'                   # resi (negativo o zero)
        r'(\d{1,3}(?:\.\d{3})+)\s+'    # evaso+ordinato-resi
        r'(-?[\d.]+)\s+'               # delta mese EUR (pos o neg)
        r'(-?[\d,]+%)',                 # delta mese % (pos o neg)
        full
    )
    if m:
        fat_prec        = _num(m.group(1))
        budget_mese     = _num(m.group(2))
        evaso           = _num(m.group(3))
        ord_mese        = _num(m.group(4))
        ord_oltre       = _num(m.group(5))
        resi            = _num(m.group(6))
        evaso_ord_resi  = _num(m.group(7))
        delta_m_eur     = _num(m.group(8))
        delta_m_pct     = _num(m.group(9))

    # ── Blocco 3: avanzamento giornaliero ────────────────────────────────────
    # Riga tipo: "400542 Cubaiu Loris 5.860 5.951 1.525 3"
    obiettivo = fat_giorno = val_ord_ieri = nr_ord_ieri = None
    # Cerca dopo "Avanzamento giornaliero" o pattern di 4 numeri piccoli in fondo
    m = re.search(
        r'(\d{1,3}(?:\.\d{3})?)\s+'    # obiettivo
        r'(\d{1,3}(?:\.\d{3})?)\s+'    # fatturato giorno
        r'(\d{1,3}(?:\.\d{3})?)\s+'    # valore ordini ieri
        r'(\d{1,2})(?:\s|$)',           # nr ordini ieri
        full
    )
    if m:
        obiettivo     = _num(m.group(1))
        fat_giorno    = _num(m.group(2))
        val_ord_ieri  = _num(m.group(3))
        nr_ord_ieri   = int(m.group(4))

    record = {
        "data_aggiornamento":      data_agg,
        "giorno_lavorativo":       giorno_lav,
        "giorni_totali":           giorni_tot,
        "budget_gen_apr":          budget_gen_apr,
        "fatturato_gen_apr":       fatturato_gen_apr,
        "delta_budget_eur":        delta_b_eur,
        "delta_budget_pct":        delta_b_pct,
        "budget_mese":             budget_mese,
        "fatturato_mese_anno_prec": fat_prec,
        "evaso":                   evaso,
        "ordinato_nel_mese":       ord_mese,
        "ordinato_oltre_mese":     ord_oltre,
        "resi":                    resi,
        "evaso_ordinato_resi":     evaso_ord_resi,
        "delta_mese_eur":          delta_m_eur,
        "delta_mese_pct":          delta_m_pct,
        "obiettivo_giornaliero":   obiettivo,
        "fatturato_giorno":        fat_giorno,
        "valore_ordini_ieri":      val_ord_ieri,
        "nr_ordini_ieri":          nr_ord_ieri,
    }

    print(f"  📅  data: {data_agg}  giorno: {giorno_lav}/{giorni_tot}")
    print(f"  📊  budget gen-apr: {budget_gen_apr}  fatturato: {fatturato_gen_apr}  Δ: {delta_b_eur} ({delta_b_pct}%)")
    print(f"  📆  budget mese: {budget_mese}  evaso: {evaso}  Δ: {delta_m_eur} ({delta_m_pct}%)")
    print(f"  📈  obiettivo: {obiettivo}  fat.giorno: {fat_giorno}  ordini ieri: {val_ord_ieri} ({nr_ord_ieri})")

    return record


# ── Import Supabase ───────────────────────────────────────────────────────────

def importa_avanzamento(filepath, client):
    record = parse_avanzamento(filepath)
    if not record:
        return False

    # Rimuovi campi None per non sovrascrivere valori esistenti con NULL
    payload = {k: v for k, v in record.items() if v is not None}

    client.table("budget").upsert(
        payload,
        on_conflict="data_aggiornamento"
    ).execute()

    print(f"  ✅  budget upserted per {record['data_aggiornamento']}")
    return True


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Parser Avanzamento Fatturati → tabella budget")
    parser.add_argument("file", help="PDF da importare")
    args = parser.parse_args()

    client = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])
    importa_avanzamento(args.file, client)
