"""
WILSON - Dispatcher principale
Legge i file dalla cartella /allegati (o da Gmail) e li smista al parser giusto.

Uso manuale su cartella:
  python dispatcher.py --cartella ./allegati/

Uso su file singolo:
  python dispatcher.py --file Conferma_Ordine_0221562795.PDF

Il dispatcher riconosce automaticamente il tipo di file dal nome:
  Conferma_Ordine_*.PDF       → parse_ordine.py
  Consegna_*_-_Bolla_*.PDF   → parse_ddt.py
  XXXXXXXXXX.txt              → parse_tracking.py (numero = consegna DDT)
  *rolling_consuntivo*.xlsx   → parse_rolling.py
  *Monitoraggio_cedi*.xlsx    → parse_cedi.py

Dipendenze:
  pip install pdfplumber openpyxl supabase
"""

import os
import re
import glob
import argparse
from supabase import create_client
from dotenv import load_dotenv

# Carica .env dalla directory di lavoro (o da quella dello script)
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]

# Import parser
from parse_ordine   import importa        as importa_ordine
from parse_ddt      import importa_ddt
from parse_tracking import importa_tracking


# ============================================================
# RICONOSCIMENTO TIPO FILE
# ============================================================

def tipo_file(filename):
    """
    Ritorna il tipo di file in base al nome.
    Valori: 'ordine' | 'ddt' | 'tracking' | 'rolling' | 'cedi' | 'sconosciuto'
    """
    nome = os.path.basename(filename).lower()
    nome_norm = re.sub(r'\s+', '_', nome)  # "Conferma Ordine" → "conferma_ordine"
    ext  = os.path.splitext(nome)[1]

    # PDF
    if ext == '.pdf':
        if nome_norm.startswith('conferma_ordine_'):
            return 'ordine'
        if nome_norm.startswith('consegna_') and '_bolla_' in nome_norm:
            return 'ddt'
        return 'sconosciuto'

    # TXT: nome = solo cifre (numero consegna)
    if ext == '.txt':
        base = os.path.splitext(os.path.basename(filename))[0]
        if base.isdigit() and len(base) == 10:
            return 'tracking'
        return 'sconosciuto'

    # PDF budget Fischer
    if ext == '.pdf':
        if nome_norm.startswith('avanzamento_fatturati'):
            return 'avanzamento'
        if 'monitoraggio_promo' in nome_norm:
            return 'monitoraggio'

    # Excel
    if ext in ('.xlsx', '.xls'):
        if 'rolling_consuntivo' in nome:
            return 'rolling'
        if 'monitoraggio_cedi' in nome:
            return 'cedi'
        return 'sconosciuto'

    return 'sconosciuto'


# ============================================================
# LOG IMPORTAZIONE
# ============================================================

def log_importazione(client, filename, tipo, esito, errore=None):
    """Salva il log di ogni file processato."""
    try:
        client.table("importazioni").insert({
            "file_nome":  os.path.basename(filename),
            "tipo":       tipo,
            "esito":      esito,
            "errore":     errore,
        }).execute()
    except:
        pass  # il log non deve bloccare il flusso


# ============================================================
# DISPATCHER
# ============================================================

def dispatch(filepath, client):
    """Processa un singolo file e lo smista al parser corretto."""
    filename = os.path.basename(filepath)
    t = tipo_file(filepath)

    print(f"\n{'='*55}")
    print(f"📂 {filename}")
    print(f"   Tipo: {t.upper()}")

    if t == 'ordine':
        ok = importa_ordine(filepath, client)
        log_importazione(client, filepath, t, 'ok' if ok else 'errore')
        return ok

    elif t == 'ddt':
        from parse_ddt import importa_ddt
        ok = importa_ddt(filepath, client)
        log_importazione(client, filepath, t, 'ok' if ok else 'errore')
        return ok

    elif t == 'tracking':
        ok = importa_tracking(filepath, client)
        log_importazione(client, filepath, t, 'ok' if ok else 'errore')
        return ok

    elif t == 'rolling':
        try:
            from parse_rolling import importa_rolling
            ok = importa_rolling(filepath, client)
            log_importazione(client, filepath, t, 'ok' if ok else 'errore')
            return ok
        except ImportError:
            print("  ⚠️  parse_rolling.py non ancora disponibile — file ignorato")
            log_importazione(client, filepath, t, 'skip', 'parser non disponibile')
            return False

    elif t == 'cedi':
        try:
            from parse_cedi import importa_cedi
            ok = importa_cedi(filepath, client)
            log_importazione(client, filepath, t, 'ok' if ok else 'errore')
            return ok
        except ImportError:
            print("  ⚠️  parse_cedi.py non ancora disponibile — file ignorato")
            log_importazione(client, filepath, t, 'skip', 'parser non disponibile')
            return False

    elif t == 'avanzamento':
        try:
            from parse_avanzamento import importa_avanzamento
            ok = importa_avanzamento(filepath, client)
            log_importazione(client, filepath, t, 'ok' if ok else 'errore')
            return ok
        except ImportError:
            print("  ⚠️  parse_avanzamento.py non disponibile — file ignorato")
            log_importazione(client, filepath, t, 'skip', 'parser non disponibile')
            return False

    elif t == 'monitoraggio':
        try:
            from parse_monitoraggio import importa_monitoraggio
            ok = importa_monitoraggio(filepath, client)
            log_importazione(client, filepath, t, 'ok' if ok else 'errore')
            return ok
        except ImportError:
            print("  ⚠️  parse_monitoraggio.py non disponibile — file ignorato")
            log_importazione(client, filepath, t, 'skip', 'parser non disponibile')
            return False

    else:
        print(f"  ⚠️  Tipo non riconosciuto — file ignorato")
        log_importazione(client, filepath, t, 'skip', 'tipo non riconosciuto')
        return False


# ============================================================
# MAIN
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description="Wilson Dispatcher — smista i file Fischer al parser giusto"
    )
    parser.add_argument("--file",     help="Singolo file da processare")
    parser.add_argument("--cartella", help="Cartella con tutti i file da processare")
    args = parser.parse_args()

    client = create_client(SUPABASE_URL, SUPABASE_KEY)

    # Raccoglie i file
    files = []
    if args.cartella:
        for ext in ('*.PDF', '*.pdf', '*.xlsx', '*.xls', '*.txt'):
            files += glob.glob(os.path.join(args.cartella, ext))
        files = sorted(set(files))
    elif args.file:
        files = [args.file]
    else:
        parser.print_help()
        return

    if not files:
        print("❌ Nessun file trovato")
        return

    # Riepilogo tipi trovati
    print(f"\n📦 {len(files)} file trovati:")
    contatori = {}
    for f in files:
        t = tipo_file(f)
        contatori[t] = contatori.get(t, 0) + 1
    for t, n in sorted(contatori.items()):
        print(f"   {t}: {n}")

    # Ordine di processing importante:
    # 1. Ordini (prima)
    # 2. DDT (collegati agli ordini)
    # 3. Tracking (collegati ai DDT)
    # 4. Excel (indipendenti)
    ORDINE_PROCESSING = ['ordine', 'ddt', 'tracking', 'rolling', 'cedi', 'avanzamento', 'monitoraggio', 'sconosciuto']
    files_ordinati = sorted(files, key=lambda f: ORDINE_PROCESSING.index(tipo_file(f))
                            if tipo_file(f) in ORDINE_PROCESSING else 99)

    # Processa
    ok = errori = skip = 0
    for f in files_ordinati:
        t = tipo_file(f)
        if t == 'sconosciuto':
            skip += 1
            continue
        result = dispatch(f, client)
        if result:
            ok += 1
        else:
            errori += 1

    print(f"\n{'='*55}")
    print(f"✅ OK: {ok} | ❌ Errori: {errori} | ⏭️  Skip: {skip}")


if __name__ == "__main__":
    main()
