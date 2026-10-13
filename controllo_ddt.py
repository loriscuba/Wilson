"""
WILSON - Controllo DDT mancanti
Trova per quali clienti e ordini non arrivano i DDT da associare all'ordine
e crea un Excel in allegati/ (cartella esclusa da git: i dati restano in locale).

Logica:
  1. Ogni ordine è collegato ai DDT tramite il numero d'ordine scritto sul DDT.
  2. Per ogni articolo dell'ordine si controlla se compare in almeno uno di
     quei DDT (consegne parziali comprese).
  3. Un articolo senza DDT conta come mancante solo se la consegna prevista è
     passata da più di TOLLERANZA giorni (senza data prevista: GIORNI_SENZA_DATA
     dalla data ordine). Prima è "in attesa".
  4. Per cliente: nessun ordine scaduto con DDT → "NESSUN DDT RICEVUTO";
     oltre il 30% degli ordini scaduti senza DDT → "solo per alcuni ordini".

Uso:  python controllo_ddt.py [--dal 2026-05-11] [--out file.xlsx]
"""

import argparse
import os
import re
from collections import Counter, defaultdict
from datetime import date, timedelta

from dotenv import load_dotenv
from openpyxl import Workbook
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo
from supabase import create_client

load_dotenv()

DAL_DEFAULT       = "2026-05-11"   # da quando Wilson riceve i DDT
TOLLERANZA        = 7
GIORNI_SENZA_DATA = 15
MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic']

OK  = 'OK - DDT completo'
ATT = 'In attesa (non ancora scaduto)'
MAN = 'DDT MANCANTE'
PAR = 'DDT PARZIALE'


def fetch_all(build, page=1000):
    out = []
    start = 0
    while True:
        data = build().range(start, start + page - 1).execute().data or []
        out.extend(data)
        if len(data) < page:
            return out
        start += page


def art_key(cod):
    s = str(cod or '').strip()
    return s.lstrip('0') or s


def to_date(s):
    return date.fromisoformat(s[:10]) if s else None


# ── Analisi ───────────────────────────────────────────────────────────────────

def carica(client, dal):
    print("📥 Lettura dati da Supabase...")
    ordini = fetch_all(lambda: client.table("ordini")
        .select("id, numero_ordine, data_ordine, codice_cliente, destinazione_ragione_sociale, "
                "destinazione_citta, tipo_ordine, importo_totale, stato, "
                "righe_ordine(codice_articolo, descrizione_articolo, quantita, importo_eur, data_consegna_prevista)")
        .gte("data_ordine", dal).order("data_ordine").order("id"), page=300)
    ordini = [o for o in ordini if (o.get("stato") or "") != "annullato"]
    ddt = fetch_all(lambda: client.table("ddt")
        .select("id, numero_ddt, data_ddt, numero_ordine, data_ordine, codice_cliente, righe_ddt(codice_articolo)")
        .order("data_ddt").order("id"), page=300)
    clienti = {c["codice_cliente"]: c["ragione_sociale"] for c in fetch_all(lambda: client.table("clienti")
        .select("codice_cliente, ragione_sociale").order("codice_cliente"))}
    cedi = {str(c["codice_cliente"]) for c in fetch_all(lambda: client.table("cedi_ridistribuito")
        .select("codice_cliente").order("codice_cliente"))}
    last = client.table("rolling_fatturato").select("data_aggiornamento") \
        .order("data_aggiornamento", desc=True).limit(1).execute().data
    rolling = []
    if last:
        rolling = fetch_all(lambda: client.table("rolling_fatturato").select("*")
            .eq("data_aggiornamento", last[0]["data_aggiornamento"]).order("codice_cliente"))
    print(f"   {len(ordini)} ordini, {len(ddt)} DDT, {len(rolling)} righe rolling")
    return ordini, ddt, clienti, cedi, rolling


def analizza(ordini, ddt, clienti, cedi, oggi):
    ddt_by_ord = defaultdict(list)
    for d in ddt:
        ddt_by_ord[d["numero_ordine"]].append(d)

    for o in ordini:
        dd = sorted(ddt_by_ord.get(o["numero_ordine"], []), key=lambda d: d["data_ddt"] or "")
        spediti = {art_key(r["codice_articolo"]) for d in dd for r in d.get("righe_ddt") or []}
        righe = [r for r in o.get("righe_ordine") or [] if r.get("codice_articolo")]
        art = {}
        for r in righe:
            a = art.setdefault(art_key(r["codice_articolo"]), {"imp": 0.0, "cp": None})
            a["imp"] += float(r.get("importo_eur") or 0)
            cp = to_date(r.get("data_consegna_prevista"))
            if cp and (not a["cp"] or cp < a["cp"]):
                a["cp"] = cp
        scop = {k: a for k, a in art.items() if k not in spediti}
        cps = [a["cp"] for a in art.values() if a["cp"]]
        cps_scop = [a["cp"] for a in scop.values() if a["cp"]]
        cp = min(cps_scop) if cps_scop else (min(cps) if cps else None)

        o["rs"] = clienti.get(o["codice_cliente"]) or o.get("destinazione_ragione_sociale")
        o["imp"] = float(o.get("importo_totale") or 0)
        o["n_art"], o["n_art_ddt"] = len(art), len(art) - len(scop)
        o["scop"] = sum(a["imp"] for a in scop.values())
        o["cp"] = cp
        o["scad"] = cp + timedelta(TOLLERANZA) if cp else to_date(o["data_ordine"]) + timedelta(GIORNI_SENZA_DATA)
        o["n_ddt"] = len(dd)
        o["ddts"] = ", ".join(f"{d['numero_ddt']} ({to_date(d['data_ddt']):%d/%m})" for d in dd if d.get("data_ddt"))
        o["ultimo"] = max((to_date(d["data_ddt"]) for d in dd if d.get("data_ddt")), default=None)
        o["cedi"] = o["codice_cliente"] in cedi
        o["righe_scop"] = [r for r in righe if art_key(r["codice_articolo"]) in scop]
        completo = (o["n_art"] > 0 and not scop) or (o["n_art"] == 0 and dd)
        o["esito"] = OK if completo else ATT if o["scad"] >= oggi else MAN if not dd else PAR
        o["giorni"] = (oggi - o["scad"]).days if o["esito"] in (MAN, PAR) else None

    numeri = {o["numero_ordine"] for o in ordini}
    ddt_orfani = [d for d in ddt if d["numero_ordine"] not in numeri
                  and (d.get("data_ordine") or "") >= min((o["data_ordine"] for o in ordini), default="")]
    return ddt_orfani


def per_cliente(ordini, fatt):
    cli = defaultdict(list)
    for o in ordini:
        cli[o["codice_cliente"]].append(o)
    out = []
    for c, L in cli.items():
        ver = [o for o in L if o["esito"] != ATT]
        n_ok  = sum(o["esito"] == OK for o in ver)
        n_par = sum(o["esito"] == PAR for o in ver)
        n_man = sum(o["esito"] == MAN for o in ver)
        nv = len(ver)
        if nv == 0:                 diag, pri = 'Solo ordini in attesa', 5
        elif n_ok + n_par == 0:     diag, pri = 'NESSUN DDT RICEVUTO', 1
        elif n_man / nv >= 0.3:     diag, pri = 'DDT ricevuti solo per alcuni ordini', 2
        elif n_par / nv >= 0.5:     diag, pri = 'DDT spesso incompleti (righe mancanti)', 3
        elif n_man + n_par:         diag, pri = 'Qualche mancanza', 4
        else:                       diag, pri = 'OK', 6
        out.append(dict(
            c=c, rs=L[0]["rs"], diag=diag, pri=pri, nv=nv, ok=n_ok, par=n_par, man=n_man, att=len(L) - nv,
            scop=sum(o["scop"] for o in ver if o["esito"] in (MAN, PAR)), fatt=fatt.get(c),
            ult=max((o["ultimo"] for o in L if o["ultimo"]), default=None),
            tipo=Counter(o["tipo_ordine"] for o in L).most_common(1)[0][0], cedi='Sì' if L[0]["cedi"] else ''))
    out.sort(key=lambda x: (x["pri"], -x["scop"]))
    return out


def fatturato_rolling(rolling, dal, oggi):
    """Fatturato per cliente dal mese di `dal` all'ultimo mese chiuso (colonne gto_<mese>_<anno>)."""
    mesi = []
    y, m = dal.year, dal.month
    while (y, m) < (oggi.year, oggi.month):
        mesi.append(f"gto_{MESI[m - 1]}_{y}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    fatt, mese_corr, rs = {}, {}, {}
    for r in rolling:
        c = str(r["codice_cliente"])
        fatt[c] = sum(float(r.get(k) or 0) for k in mesi)
        mese_corr[c] = float(r.get("spedito_ordinato_mese") or 0)
        rs[c] = r.get("ragione_sociale")
    label = f"{mesi[0][4:7]}-{mesi[-1][4:7]} {mesi[-1][-4:]}" if mesi else ""
    return fatt, mese_corr, rs, label


# ── Excel ─────────────────────────────────────────────────────────────────────

FONT = 'Arial'
HF, HFILL = Font(name=FONT, bold=True, color='FFFFFF'), PatternFill('solid', fgColor='1F4E78')
BF, BOLD = Font(name=FONT), Font(name=FONT, bold=True)
EUR, PCT, DT = '€ #,##0;-€ #,##0;-', '0%', 'DD/MM/YYYY'
RED, YEL = PatternFill('solid', fgColor='F8CBAD'), PatternFill('solid', fgColor='FFE699')
GRN, GRY = PatternFill('solid', fgColor='C6E0B4'), PatternFill('solid', fgColor='E7E6E6')


def foglio(wb, name, headers, data, widths, fmts=None):
    ws = wb.create_sheet(name)
    ws.append(headers)
    for row in data:
        ws.append(row)
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for row in ws.iter_rows():
        for cell in row:
            cell.font = BF
    for cell in ws[1]:
        cell.font, cell.fill = HF, HFILL
        cell.alignment = Alignment(wrap_text=True, vertical='center')
    ws.row_dimensions[1].height = 32
    for col, f in (fmts or {}).items():
        for cell in ws[col][1:]:
            cell.number_format = f
    ws.freeze_panes = 'A2'
    if data:
        t = Table(displayName=re.sub(r'\W', '', name), ref=f"A1:{get_column_letter(len(headers))}{len(data) + 1}")
        t.tableStyleInfo = TableStyleInfo(name='TableStyleLight9', showRowStripes=True)
        ws.add_table(t)
    return ws


def scrivi_excel(path, ordini, clienti, ddt_orfani, senza_ordini, fatt_label, dal, oggi):
    wb = Workbook()
    by_ord = {o["numero_ordine"]: o for o in ordini}

    n = len(clienti)
    ws = foglio(wb, 'Clienti',
        ['Codice cliente', 'Ragione sociale', 'Diagnosi', 'Ordini verificabili', 'Con DDT completo',
         'Con DDT parziale', 'Senza DDT', '% ordini con DDT', 'Importo senza DDT', 'Ordini in attesa',
         f'Fatturato {fatt_label} (rolling)', 'Ultimo DDT ricevuto', 'Tipo ordine prevalente', 'CEDI'],
        [[x["c"], x["rs"], x["diag"], x["nv"], x["ok"], x["par"], x["man"], None, round(x["scop"], 2),
          x["att"], x["fatt"], x["ult"], x["tipo"], x["cedi"]] for x in clienti],
        [13, 38, 36, 12, 12, 12, 11, 12, 15, 11, 16, 13, 24, 7], {'H': PCT, 'I': EUR, 'K': EUR, 'L': DT})
    for i in range(2, n + 2):
        ws[f'H{i}'] = f'=IF(D{i}=0,"",(E{i}+F{i})/D{i})'
        ws[f'H{i}'].number_format, ws[f'H{i}'].font = PCT, BF
    rng = f'A2:N{n + 1}'
    ws.conditional_formatting.add(rng, FormulaRule(formula=['$C2="NESSUN DDT RICEVUTO"'], fill=RED))
    ws.conditional_formatting.add(rng, FormulaRule(formula=['$C2="DDT ricevuti solo per alcuni ordini"'], fill=YEL))
    ws.conditional_formatting.add(rng, FormulaRule(formula=['$C2="OK"'], fill=GRN))

    da = sorted((o for o in ordini if o["esito"] in (MAN, PAR)),
                key=lambda o: (o["esito"] != MAN, o["codice_cliente"], o["data_ordine"]))
    ws = foglio(wb, 'Ordini senza DDT',
        ['Esito', 'N. ordine', 'Data ordine', 'Codice cliente', 'Ragione sociale', 'Città', 'Tipo ordine',
         'Importo ordine', 'Articoli ordine', 'Articoli con DDT', 'Importo senza DDT',
         'Consegna prevista (prima riga scoperta)', 'DDT atteso entro', 'Giorni di ritardo', 'DDT ricevuti', 'CEDI'],
        [[o["esito"], o["numero_ordine"], to_date(o["data_ordine"]), o["codice_cliente"], o["rs"],
          o.get("destinazione_citta"), o["tipo_ordine"], o["imp"], o["n_art"], o["n_art_ddt"], o["scop"],
          o["cp"], o["scad"], o["giorni"], o["ddts"], 'Sì' if o["cedi"] else ''] for o in da],
        [16, 12, 12, 12, 34, 16, 22, 13, 10, 10, 13, 14, 13, 10, 40, 7], {'C': DT, 'H': EUR, 'K': EUR, 'L': DT, 'M': DT})
    ws.conditional_formatting.add(f'A2:P{len(da) + 1}', FormulaRule(formula=['$A2="DDT MANCANTE"'], fill=RED))

    foglio(wb, 'Righe senza DDT',
        ['N. ordine', 'Data ordine', 'Codice cliente', 'Ragione sociale', 'Esito ordine', 'Codice articolo',
         'Descrizione', 'Quantità', 'Importo', 'Consegna prevista'],
        [[o["numero_ordine"], to_date(o["data_ordine"]), o["codice_cliente"], o["rs"], o["esito"],
          r["codice_articolo"], r.get("descrizione_articolo"), float(r.get("quantita") or 0),
          float(r.get("importo_eur") or 0), to_date(r.get("data_consegna_prevista"))]
         for o in da for r in o["righe_scop"]],
        [12, 12, 12, 34, 16, 12, 40, 9, 12, 13], {'B': DT, 'I': EUR, 'J': DT})

    tutti = sorted(ordini, key=lambda o: (o["codice_cliente"], o["data_ordine"]))
    foglio(wb, 'Tutti gli ordini',
        ['Esito', 'N. ordine', 'Data ordine', 'Codice cliente', 'Ragione sociale', 'Tipo ordine', 'Stato in Wilson',
         'Importo ordine', 'Articoli ordine', 'Articoli con DDT', 'Importo senza DDT', 'DDT atteso entro', 'DDT ricevuti'],
        [[o["esito"], o["numero_ordine"], to_date(o["data_ordine"]), o["codice_cliente"], o["rs"], o["tipo_ordine"],
          o["stato"], o["imp"], o["n_art"], o["n_art_ddt"], o["scop"], o["scad"], o["ddts"]] for o in tutti],
        [26, 12, 12, 12, 34, 22, 18, 13, 10, 10, 13, 13, 40], {'C': DT, 'H': EUR, 'K': EUR, 'L': DT})

    foglio(wb, 'Fatturato senza ordini',
        ['Codice cliente', 'Ragione sociale', f'Fatturato {fatt_label} (rolling)', 'Spedito+ordinato mese corrente', 'Nota'],
        [list(x) + [f"Fatturano ma in Wilson non c'è nessun ordine dal {dal:%d/%m/%Y}: mancano sia gli ordini che i DDT"]
         for x in senza_ordini],
        [13, 36, 16, 16, 90], {'C': EUR, 'D': EUR})

    foglio(wb, 'DDT senza ordine',
        ['N. DDT', 'Data DDT', 'N. ordine sul DDT', 'Data ordine sul DDT', 'Codice cliente sul DDT', 'Nota'],
        [[d["numero_ddt"], to_date(d["data_ddt"]), d["numero_ordine"], to_date(d.get("data_ordine")), d["codice_cliente"],
          "Il DDT è arrivato ma l'ordine non è in Wilson: manca la conferma d'ordine"] for d in ddt_orfani],
        [12, 12, 16, 14, 14, 70], {'B': DT, 'D': DT})

    # Riepilogo
    ws = wb['Sheet']
    ws.title = 'Riepilogo'
    for col, w in zip('ABCD', (46, 14, 18, 60)):
        ws.column_dimensions[col].width = w
    ws['A1'] = 'Controllo DDT mancanti'
    ws['A1'].font = Font(name=FONT, bold=True, size=14)
    ws['A2'] = f'Ordini dal {dal:%d/%m/%Y} · dati estratti il {oggi:%d/%m/%Y}'
    ws['A2'].font = Font(name=FONT, italic=True, color='595959')
    ws.append([])
    ws.append(['Esito ordine', 'N. ordini', 'Importo senza DDT', 'Significato'])
    for c in ws[4]:
        c.font, c.fill = HF, HFILL
    T = "'Tutti gli ordini'"
    desc = {
        MAN: f'Nessun DDT arrivato e la consegna prevista è passata da più di {TOLLERANZA} giorni',
        PAR: 'Arrivato almeno un DDT, ma alcuni articoli già scaduti non compaiono in nessun DDT',
        OK:  "Tutti gli articoli dell'ordine compaiono in almeno un DDT",
        ATT: 'Consegna prevista non ancora scaduta: troppo presto per dire',
    }
    for i, (e, fill) in enumerate(zip([MAN, PAR, OK, ATT], [RED, YEL, GRN, GRY]), 5):
        ws[f'A{i}'], ws[f'D{i}'] = e, desc[e]
        ws[f'B{i}'] = f'=COUNTIF({T}!$A:$A,A{i})'
        ws[f'C{i}'] = f'=SUMIF({T}!$A:$A,A{i},{T}!$K:$K)'
        ws[f'A{i}'].fill = fill
    ws['A9'], ws['B9'], ws['C9'] = 'Totale', '=SUM(B5:B8)', '=SUM(C5:C8)'
    for i in range(5, 10):
        for col in 'ABCD':
            ws[f'{col}{i}'].font = BOLD if i == 9 else BF
        ws[f'C{i}'].number_format = EUR
        ws[f'D{i}'].alignment = Alignment(wrap_text=True)
    ws['A11'] = 'Clienti per diagnosi'
    ws['A11'].font = BOLD
    for col, h in zip('ABC', ('Diagnosi', 'N. clienti', 'Importo senza DDT')):
        ws[f'{col}12'] = h
        ws[f'{col}12'].font, ws[f'{col}12'].fill = HF, HFILL
    diagnosi = ['NESSUN DDT RICEVUTO', 'DDT ricevuti solo per alcuni ordini', 'DDT spesso incompleti (righe mancanti)',
                'Qualche mancanza', 'OK', 'Solo ordini in attesa']
    for i, dg in enumerate(diagnosi, 13):
        ws[f'A{i}'] = dg
        ws[f'B{i}'] = f'=COUNTIF(Clienti!$C:$C,A{i})'
        ws[f'C{i}'] = f'=SUMIF(Clienti!$C:$C,A{i},Clienti!$I:$I)'
        for col in 'ABC':
            ws[f'{col}{i}'].font = BF
        ws[f'C{i}'].number_format = EUR
    m = 20
    ws[f'A{m}'] = 'Come funziona il controllo'
    ws[f'A{m}'].font = BOLD
    note = [
        "1. Ogni ordine viene collegato ai DDT tramite il numero d'ordine riportato sul DDT.",
        "2. Per ogni articolo dell'ordine si controlla se compare in almeno uno di quei DDT (consegne parziali comprese).",
        f'3. Un articolo senza DDT conta come mancante solo se la sua consegna prevista è passata da più di {TOLLERANZA} '
        f'giorni (senza data prevista: {GIORNI_SENZA_DATA} giorni dalla data ordine). Prima è "in attesa".',
        '4. Per cliente: "NESSUN DDT RICEVUTO" = nessuno degli ordini scaduti ha un DDT → quasi certamente i DDT di quel '
        'cliente non arrivano nella casella che Wilson legge. "Solo per alcuni ordini" = oltre il 30% degli ordini scaduti senza DDT.',
        f"5. Esclusi gli ordini annullati e quelli precedenti al {dal:%d/%m/%Y}.",
        '6. "Fatturato senza ordini" = clienti che fatturano nel rolling ma senza ordini in Wilson; '
        '"DDT senza ordine" = DDT arrivati per ordini che non sono in Wilson.',
        "7. Un DDT parziale può dipendere anche da un articolo spedito sotto un altro numero d'ordine o sostituito: "
        'controllare il foglio "Righe senza DDT".',
    ]
    for i, t in enumerate(note, m + 1):
        ws.merge_cells(f'A{i}:D{i}')
        ws[f'A{i}'] = t
        ws[f'A{i}'].font = BF
        ws[f'A{i}'].alignment = Alignment(wrap_text=True, vertical='top')
        ws.row_dimensions[i].height = 30

    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    wb.save(path)


def main():
    ap = argparse.ArgumentParser(description="Controllo DDT mancanti")
    ap.add_argument("--dal", default=DAL_DEFAULT, help="data ordine minima (YYYY-MM-DD)")
    ap.add_argument("--out", help="file Excel di uscita")
    args = ap.parse_args()

    oggi = date.today()
    dal = date.fromisoformat(args.dal)
    out = args.out or f"allegati/Controllo_DDT_mancanti_{oggi:%Y%m%d}.xlsx"

    client = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])
    ordini, ddt, anag, cedi, rolling = carica(client, args.dal)
    ddt_orfani = analizza(ordini, ddt, anag, cedi, oggi)
    fatt, mese_corr, rs_roll, fatt_label = fatturato_rolling(rolling, dal, oggi)
    clienti = per_cliente(ordini, fatt)
    con_ordini = {o["codice_cliente"] for o in ordini}
    senza_ordini = sorted(((c, rs_roll[c], fatt[c], mese_corr[c]) for c in fatt
                           if c not in con_ordini and fatt[c] + mese_corr[c] > 0), key=lambda x: -x[2])

    scrivi_excel(out, ordini, clienti, ddt_orfani, senza_ordini, fatt_label, dal, oggi)

    print("\n📊 Esito ordini:")
    for e, k in Counter(o["esito"] for o in ordini).most_common():
        print(f"   {e:32} {k}")
    print("\n👥 Clienti per diagnosi:")
    for d, k in Counter(x["diag"] for x in clienti).most_common():
        print(f"   {d:40} {k}")
    print(f"\n✅ Excel salvato in {out}")


if __name__ == "__main__":
    main()
