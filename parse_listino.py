"""
WILSON - Parser Griglia Prezzi FL (Fuori Listino / Prezzi netti a quantità)
File: Griglie_FL_listino_<mese><anno>_ed_<NN>_<ANNO>.pdf

Legge il PDF Fischer e carica la tabella `listino_fl` su Supabase.
Conflict key: (codice_articolo, edizione) → aggiorna i prezzi senza perdere storico.

SQL da eseguire una volta su Supabase:
    CREATE TABLE IF NOT EXISTS listino_fl (
        id               BIGSERIAL PRIMARY KEY,
        codice_articolo  TEXT NOT NULL,
        descrizione      TEXT,
        categoria        TEXT,
        unita_misura     TEXT,
        codice_ean       TEXT,
        acquisto_minimo  INTEGER,
        prezzo_lordo     NUMERIC(10,2),
        prezzi_netti     JSONB DEFAULT '[]',
        fuori_listino    BOOLEAN DEFAULT FALSE,
        edizione         TEXT,
        data_listino     DATE,
        updated_at       TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(codice_articolo, edizione)
    );
"""

import argparse
import os
import re
import subprocess
from datetime import datetime

from dotenv import load_dotenv
from supabase import create_client


# ── Helpers ───────────────────────────────────────────────────────────────────

def _num(s):
    """'16,10' → 16.10 · '1.024,29' → 1024.29 · None se non parsabile."""
    if s is None:
        return None
    s = str(s).strip().replace('.', '').replace(',', '.')
    try:
        return float(s)
    except ValueError:
        return None


# ── Pattern ───────────────────────────────────────────────────────────────────

EAN_PAT  = re.compile(r'\b(\d{13})\b')
PRICE_IT = re.compile(r'\b\d{1,3}(?:\.\d{3})*,\d{2}\b')   # decimali italiani
NUM_IT   = re.compile(r'\b\d{1,3}(?:\.\d{3})*(?:,\d+)?\b')
UM_SET   = {'CZ', 'PZ', 'BOX', 'CF', 'MT', 'KG', 'PZT'}

CAT_RE = re.compile(
    r'^(Ancoranti chimici|Barre filettate|Schiume poliuretaniche|Sigillanti|'
    r'Fissaggi|Tasselli a percussione|Viti PowerFast|Viti per cartongesso|'
    r'FIS-HK|Pistola pneumatica).*$'
)


# ── Parser ────────────────────────────────────────────────────────────────────

def parse_listino(filepath):
    """Restituisce lista di record pronti per Supabase."""
    result = subprocess.run(
        ['pdftotext', '-layout', filepath, '-'],
        capture_output=True, text=True, check=True
    )
    lines = result.stdout.splitlines()

    # Edizione e data
    edition = edition_date = None
    for line in lines:
        m = re.search(r'Ed\.(\d{2}/\d{4})', line)
        if m:
            ed = m.group(1)                          # "04/2026"
            mm, yy = ed.split('/')
            edition      = ed
            edition_date = f"{yy}-{mm}-01"
            break

    if not edition:
        name = os.path.basename(filepath)
        m = re.search(r'(\d{2})_(\d{4})', name)
        if m:
            edition      = f"{m.group(1)}/{m.group(2)}"
            edition_date = f"{m.group(2)}-{m.group(1)}-01"

    print(f"  📋 Edizione: {edition} · data: {edition_date}")

    current_cat = None
    fuori_next  = False
    records     = []

    for line in lines:
        stripped = line.strip()

        if CAT_RE.match(stripped):
            current_cat = stripped
            continue
        if 'Fuori' in stripped and 'listino' in stripped.lower():
            fuori_next = True
            continue

        m_ean = EAN_PAT.search(line)
        if not m_ean:
            continue

        ean    = m_ean.group(1)
        before = line[:m_ean.start()]
        after  = line[m_ean.end():]

        # Artcode e UM da before (backwards: ultimo token UM, penultimo artcode)
        tokens = [t for t in before.split() if t != '*']
        um = artcode = None
        desc_toks = []
        for t in reversed(tokens):
            if um is None and t.upper() in UM_SET:
                um = t.upper()
                continue
            if artcode is None and re.match(r'^\d{4,8}$', t):
                artcode = t
                continue
            desc_toks.append(t)
        if artcode is None:
            fuori_next = False
            continue
        descrizione = ' '.join(reversed(desc_toks)).strip()

        # acq_min e prezzo_lordo: primi 2 numeri dopo EAN
        nums_all     = NUM_IT.findall(after)
        acq_min      = int(_num(nums_all[0])) if nums_all else None
        prezzo_lordo = _num(nums_all[1]) if len(nums_all) > 1 else None

        # Prezzi netti: decimali italiani dopo il 2° numero, prima del repeat artcode
        after_clean = after
        art_repeat  = re.search(rf'\b{re.escape(artcode)}\b', after[len(after)//2:])
        if art_repeat:
            after_clean = after[:len(after)//2 + art_repeat.start()]

        # Salta i primi 2 numeri (acq_min + lordo)
        first2_end = 0
        for cnt, pm in enumerate(NUM_IT.finditer(after_clean)):
            if cnt == 1:
                first2_end = pm.end()
                break

        prezzi_raw = PRICE_IT.findall(after_clean[first2_end:])
        prezzi = [_num(p) for p in prezzi_raw
                  if _num(p) and _num(p) < (prezzo_lordo or 9999)]

        records.append({
            'codice_articolo': artcode,
            'descrizione':     descrizione,
            'categoria':       current_cat,
            'unita_misura':    um,
            'codice_ean':      ean,
            'acquisto_minimo': acq_min,
            'prezzo_lordo':    prezzo_lordo,
            'prezzi_netti':    prezzi,
            'fuori_listino':   fuori_next,
            'edizione':        edition,
            'data_listino':    edition_date,
        })
        fuori_next = False

    return records


# ── Import Supabase ───────────────────────────────────────────────────────────

def importa_listino(filepath, client):
    print(f"\n📄 {os.path.basename(filepath)}")
    records = parse_listino(filepath)
    if not records:
        print("  ❌ Nessun prodotto trovato")
        return False

    print(f"  Prodotti trovati: {len(records)}")

    ok = errori = 0
    BATCH = 100
    for i in range(0, len(records), BATCH):
        batch = records[i:i + BATCH]
        try:
            client.table('listino_fl').upsert(
                batch,
                on_conflict='codice_articolo,edizione'
            ).execute()
            ok += len(batch)
        except Exception as e:
            print(f"  ❌ Batch {i}: {e}")
            errori += len(batch)

    print(f"  ✅ Importati: {ok} | ❌ Errori: {errori}")
    return errori == 0


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Importa griglia prezzi FL (PDF) in Supabase"
    )
    parser.add_argument('file', help='Path al PDF da importare')
    args = parser.parse_args()

    load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))
    load_dotenv()

    url = os.environ.get('SUPABASE_URL')
    key = os.environ.get('SUPABASE_KEY')
    if not url or not key:
        raise RuntimeError('SUPABASE_URL e SUPABASE_KEY devono essere definiti in .env')

    client = create_client(url, key)
    success = importa_listino(args.file, client)
    exit(0 if success else 1)


if __name__ == '__main__':
    main()
