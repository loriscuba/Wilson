"""
WILSON - Parser TXT Tracking Shippeo
File: XXXXXXXXXX.txt (numero = numero consegna DDT)
"""

import re
import os
from datetime import datetime


RE_OGGETTO    = re.compile(r'OGGETTO:\s*(.+)')
RE_CONSEGNA   = re.compile(r'-(\d{10})-DDT')
RE_SHIPPEO_ENC = re.compile(r'view\.shippeo\.com%2ForderPublic%2F([A-Z0-9]+)')
RE_SHIPPEO_DIR = re.compile(r'view\.shippeo\.com/orderPublic/([A-Z0-9]+)')


def parse_tracking(filepath):
    try:
        with open(filepath, encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        print(f"  ❌ Errore lettura file: {e}")
        return None

    # Numero consegna dal nome file (più affidabile)
    filename = os.path.basename(filepath)
    num_consegna = os.path.splitext(filename)[0]

    # Fallback: cerca nell'oggetto
    if not num_consegna.isdigit():
        m = RE_CONSEGNA.search(content)
        num_consegna = m.group(1) if m else None

    if not num_consegna:
        print(f"  ❌ Numero consegna non trovato in {filepath}")
        return None

    # Token Shippeo (prima encoded, poi direct)
    shippeo_token = None
    m = RE_SHIPPEO_ENC.search(content)
    if m:
        shippeo_token = m.group(1)
    else:
        m = RE_SHIPPEO_DIR.search(content)
        if m:
            shippeo_token = m.group(1)

    shippeo_url = f"https://view.shippeo.com/orderPublic/{shippeo_token}" if shippeo_token else None

    # Oggetto mail
    oggetto = RE_OGGETTO.search(content)

    return {
        "numero_consegna": num_consegna,
        "shippeo_token":   shippeo_token,
        "shippeo_url":     shippeo_url,
        "oggetto_mail":    oggetto.group(1).strip() if oggetto else None,
        "stato":           "spedito",
        "file_txt":        filename,
    }


def importa_tracking(filepath, client):
    print(f"\n📡 {os.path.basename(filepath)}")

    result = parse_tracking(filepath)
    if not result:
        return False

    print(f"  Consegna: {result['numero_consegna']} | Shippeo: {result['shippeo_token'] or 'N/D'}")

    try:
        # Aggiorna il DDT corrispondente con i dati tracking
        res_ddt = client.table("ddt").update({
            "shippeo_token": result["shippeo_token"],
            "shippeo_url":   result["shippeo_url"],
            "stato":         "spedito",
        }).eq("numero_consegna", result["numero_consegna"]).execute()

        # Aggiorna anche ordini.stato → spedito se ancora confermato
        if res_ddt.data:
            numero_ordine = res_ddt.data[0].get("numero_ordine")
            if numero_ordine:
                client.table("ordini").update({"stato": "spedito"}) \
                    .eq("numero_ordine", numero_ordine) \
                    .eq("stato", "confermato") \
                    .execute()

        # Inserisce anche nella tabella tracking
        client.table("tracking").upsert({
            "numero_consegna": result["numero_consegna"],
            "shippeo_token":   result["shippeo_token"],
            "shippeo_url":     result["shippeo_url"],
            "oggetto_mail":    result["oggetto_mail"],
            "stato":           "spedito",
            "file_txt":        result["file_txt"],
        }, on_conflict="numero_consegna").execute()

        print("  ✅ Tracking salvato")
        return True
    except Exception as e:
        print(f"  ❌ Errore: {e}")
        return False
