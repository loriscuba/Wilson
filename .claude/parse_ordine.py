"""
WILSON - Parser Conferma Ordine Fischer
File: Conferma Ordine XXXXXXXXXX.PDF
"""

import re
import os
from datetime import datetime

try:
    import pdfplumber
except ImportError:
    raise ImportError("pip install pdfplumber")


def num_it(val):
    if not val:
        return None
    try:
        return float(str(val).strip().replace('.', '').replace(',', '.'))
    except:
        return None

def data_it(val):
    if not val:
        return None
    try:
        return datetime.strptime(val.strip(), "%d.%m.%Y").strftime("%Y-%m-%d")
    except:
        return None


RE_DATA      = re.compile(r'Data\s+(\d{2}\.\d{2}\.\d{4})')
RE_NUM_CLI   = re.compile(r'Numero di cliente\s+(\d+)')
RE_NUM_ORD   = re.compile(r"Numero d'ordine\s+(\d+)")
RE_TIPO_ORD  = re.compile(r'Tipo ordine acquisto:\s+(.+?)(?:\n|$)')
RE_MAGAZZINO = re.compile(r'Magazzino:\s+(.+?)(?:\n|$)')
RE_PESO      = re.compile(r'Peso totale:\s+([\d,]+)\s+KG')
RE_BANCA     = re.compile(r'Su Banca:\s+(.+?)(?:\n|$)')
RE_IMP_TOT   = re.compile(r'Importo totale EUR\s+([\d\.,]+)')
RE_IVA       = re.compile(r'IVA Vend\.\s+\d+%\s+([\d,]+)\s+%\s+imponibile:\s+[\d\.,]+\s+([\d\.,]+)')
RE_TOT_ORD   = re.compile(r'Totale ordine EUR\s+([\d\.,]+)')
RE_COND_PAG  = re.compile(r'Condizioni Pagamento\s*(.+?)(?:\n|$)')
RE_CORRIERE  = re.compile(r'Spediz\./Corriere\s+(.+?)(?:\n|$)')
RE_PORTO     = re.compile(r'Porto / Resa\s+(.+?)(?:\n|$)')
RE_DEST      = re.compile(
    r'Destinazione merce\n(.+)\n(.+)\n(\d{5})\s+(.+?)\s+([A-Z]{2})\n',
    re.MULTILINE
)
RE_DATA_CONS = re.compile(r'Data presunta consegna il (\d{2}\.\d{2}\.\d{4})')

UM_PRICED = {'PZ', 'CZ', 'ST', 'PAK', 'KG', 'MT'}


def parse_riga(tokens):
    codice = tokens[0]
    if not re.match(r'^\d{8}$', codice):
        return None

    # Find UM position: must be preceded by an integer (qty)
    um_idx = None
    for i in range(2, len(tokens)):
        if tokens[i] in UM_PRICED | {'IMB'}:
            try:
                int(tokens[i - 1])
                um_idx = i
                break
            except ValueError:
                continue

    if um_idx is None:
        return None

    um = tokens[um_idx]
    qty = int(tokens[um_idx - 1])
    descrizione = ' '.join(tokens[1:um_idx - 1])

    # IMB rows: no pricing info, skip for DB insert
    if um == 'IMB':
        return None

    rest = tokens[um_idx + 1:]
    if len(rest) < 4:
        return None

    try:
        iva_pct  = float(rest[-1])
        importo  = num_it(rest[-2])
        prezzo   = num_it(rest[0])
        um_prezzo = f"{rest[1]} {rest[2]}"

        sconti = []
        for t in rest[3:-2]:
            s = t.rstrip('/')
            if s:
                v = num_it(s)
                if v is not None:
                    sconti.append(v)

        return {
            'codice_articolo':     codice,
            'descrizione_articolo': descrizione,
            'quantita':            qty,
            'unita_misura':        um,
            'prezzo_unitario':     prezzo,
            'um_prezzo':           um_prezzo,
            'sconto1':             sconti[0] if len(sconti) > 0 else None,
            'sconto2':             sconti[1] if len(sconti) > 1 else None,
            'sconto3':             sconti[2] if len(sconti) > 2 else None,
            'importo_eur':         importo,
            'iva_pct':             iva_pct,
            'data_consegna_prevista': None,
            'note_riga':           None,
        }
    except Exception:
        return None


def parse_ordine(filepath):
    try:
        with pdfplumber.open(filepath) as pdf:
            txt = "\n".join(p.extract_text() or "" for p in pdf.pages)
    except Exception as e:
        print(f"  ❌ Errore lettura PDF: {e}")
        return None

    def get(pattern):
        m = pattern.search(txt)
        return m.group(1).strip() if m else None

    num_ordine = get(RE_NUM_ORD)
    if not num_ordine:
        print(f"  ❌ Numero ordine non trovato in {filepath}")
        return None

    iva_m   = RE_IVA.search(txt)
    dest_m  = RE_DEST.search(txt)

    ordine = {
        "numero_ordine":               num_ordine,
        "data_ordine":                 data_it(get(RE_DATA)),
        "codice_cliente":              get(RE_NUM_CLI),
        "tipo_ordine":                 get(RE_TIPO_ORD),
        "magazzino":                   get(RE_MAGAZZINO),
        "peso_kg":                     num_it(get(RE_PESO)),
        "banca_cliente":               get(RE_BANCA),
        "condizioni_pagamento":        get(RE_COND_PAG),
        "corriere":                    get(RE_CORRIERE),
        "porto_resa":                  get(RE_PORTO),
        "importo_totale":              num_it(get(RE_IMP_TOT)),
        "iva_pct":                     num_it(iva_m.group(1)) if iva_m else None,
        "iva_eur":                     num_it(iva_m.group(2)) if iva_m else None,
        "totale_ordine":               num_it(get(RE_TOT_ORD)),
        "destinazione_ragione_sociale": dest_m.group(1).strip() if dest_m else None,
        "destinazione_indirizzo":      dest_m.group(2).strip() if dest_m else None,
        "destinazione_citta":          dest_m.group(4).strip() if dest_m else None,
        "destinazione_provincia":      dest_m.group(5).strip() if dest_m else None,
        "stato":                       "confermato",
        "file_pdf":                    os.path.basename(filepath),
    }

    # Parse righe line by line
    righe = []
    for line in txt.split('\n'):
        line = line.strip()

        m = RE_DATA_CONS.search(line)
        if m:
            if righe:
                righe[-1]['data_consegna_prevista'] = data_it(m.group(1))
            continue

        if line.startswith('Merce in partenza'):
            if righe:
                righe[-1]['note_riga'] = line
            continue

        tokens = line.split()
        if tokens and re.match(r'^\d{8}$', tokens[0]):
            riga = parse_riga(tokens)
            if riga:
                righe.append(riga)

    return {"ordine": ordine, "righe": righe}


def importa(filepath, client):
    print(f"\n📋 {os.path.basename(filepath)}")

    result = parse_ordine(filepath)
    if not result:
        return False

    ordine = result["ordine"]
    righe  = result["righe"]

    print(f"  Ordine: {ordine['numero_ordine']} | Cliente: {ordine['codice_cliente']} | Righe: {len(righe)}")

    try:
        res = client.table("ordini").upsert(ordine, on_conflict="numero_ordine").execute()
        if not res.data:
            print("  ❌ Errore inserimento ordine")
            return False
        ordine_id = res.data[0]["id"]
    except Exception as e:
        print(f"  ❌ Errore ordine: {e}")
        return False

    try:
        client.table("righe_ordine").delete().eq("ordine_id", ordine_id).execute()
        for r in righe:
            r["ordine_id"] = ordine_id
        if righe:
            client.table("righe_ordine").insert(righe).execute()
        print(f"  ✅ {len(righe)} righe inserite")
    except Exception as e:
        print(f"  ❌ Errore righe: {e}")
        return False

    return True
