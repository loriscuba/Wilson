"""
WILSON - Parser DDT (Documenti di Trasporto) Fischer
File: Consegna_XXXXXXXXXX_-_Bolla_XXXXXX.PDF
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


RE_DATA        = re.compile(r'Data:\s+(\d{2}\.\d{2}\.\d{4})')
RE_NUM_CLI     = re.compile(r'Numero di Cliente:\s+(\d+)')
RE_CONSEGNA    = re.compile(r'Consegna:\s+(\d+)')
RE_DDT         = re.compile(r'DDT:\s+(\w+)')
RE_PIVA        = re.compile(r'Partita IVA:\s+(IT\w+)')
RE_NO_ORDINE   = re.compile(r'No\. ordine\s+(\d+)')
RE_DATA_ORD    = re.compile(r'No\. ordine\s+\d+\s+(\d{2}\.\d{2}\.\d{4})')
RE_NO_ACQUISTO = re.compile(r"No\. ord d'acquisto\s+(.+)")
RE_PESO        = re.compile(r'Peso totale\s+([\d,]+)\s+KG')
RE_MAGAZZINO   = re.compile(r'Magazzino\s+(.+)')
RE_COLLI       = re.compile(r'Colli\s+(\d+)\s+/')
RE_CORRIERE    = re.compile(r'Corriere\s+(.+)')
RE_PORTO       = re.compile(r'Porto Resa\s+(.+)')
RE_CAUSALE     = re.compile(r'Causale del trasporto\s+(.+)')
RE_SEGNACOLLO  = re.compile(r'SEGNACOLLO:\s+(.+)')

# Righe articolo: codice Fischer inizia sempre con 0
RE_RIGA_DDT = re.compile(
    r'^(0\d{7})\s+(.+?)\s+([\d\.]+)\s+(PZ|CZ|ST|PAK|IMB)\s*$',
    re.MULTILINE
)


def parse_ddt(filepath):
    try:
        with pdfplumber.open(filepath) as pdf:
            txt = "\n".join(p.extract_text() or "" for p in pdf.pages)
    except Exception as e:
        print(f"  ❌ Errore lettura PDF: {e}")
        return None

    def get(pattern):
        m = pattern.search(txt)
        return m.group(1).strip() if m else None

    ddt = {
        "numero_consegna":    get(RE_CONSEGNA),
        "numero_ddt":         get(RE_DDT),
        "data_ddt":           data_it(get(RE_DATA)),
        "codice_cliente":     get(RE_NUM_CLI),
        "numero_ordine":      get(RE_NO_ORDINE),
        "data_ordine":        data_it(get(RE_DATA_ORD)),
        "riferimento_acquisto": get(RE_NO_ACQUISTO),
        "peso_kg":            num_it(get(RE_PESO)),
        "magazzino":          get(RE_MAGAZZINO),
        "num_colli":          int(get(RE_COLLI)) if get(RE_COLLI) else None,
        "corriere":           get(RE_CORRIERE),
        "porto_resa":         get(RE_PORTO),
        "causale":            get(RE_CAUSALE),
        "segnacollo":         get(RE_SEGNACOLLO),
        "stato":              "spedito",
        "file_pdf":           os.path.basename(filepath),
    }

    if not ddt["numero_consegna"]:
        print(f"  ❌ Numero consegna non trovato in {filepath}")
        return None

    # Righe articoli
    righe = []
    for codice, desc, qty, um in RE_RIGA_DDT.findall(txt):
        righe.append({
            "codice_articolo":  codice.lstrip('0') or codice,
            "descrizione":      desc.strip(),
            "quantita":         num_it(qty),
            "unita_misura":     um,
        })

    return {"ddt": ddt, "righe": righe}


def importa_ddt(filepath, client):
    print(f"\n📦 {os.path.basename(filepath)}")

    result = parse_ddt(filepath)
    if not result:
        return False

    ddt    = result["ddt"]
    righe  = result["righe"]

    print(f"  Consegna: {ddt['numero_consegna']} | DDT: {ddt['numero_ddt']} | Righe: {len(righe)}")

    try:
        res = client.table("ddt").upsert(ddt, on_conflict="numero_consegna").execute()
        if not res.data:
            print("  ❌ Errore inserimento DDT")
            return False
        ddt_id = res.data[0]["id"]
    except Exception as e:
        print(f"  ❌ Errore DDT: {e}")
        return False

    try:
        client.table("righe_ddt").delete().eq("ddt_id", ddt_id).execute()
        for r in righe:
            r["ddt_id"] = ddt_id
        if righe:
            client.table("righe_ddt").insert(righe).execute()
        print(f"  ✅ {len(righe)} righe inserite")
    except Exception as e:
        print(f"  ❌ Errore righe DDT: {e}")
        return False

    return True
