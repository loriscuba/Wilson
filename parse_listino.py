"""
WILSON - Parser Griglie Netti FL (Prezzi netti a quantità / Fuori Listino)
File: Griglie_FL_listino_<mese><anno>_ed_<NN>_<ANNO>.pdf

Legge il PDF Fischer e carica la tabella `listino_fl` su Supabase.
Conflict key: (codice_articolo, edizione) → aggiorna i prezzi senza perdere storico.

Il parser lavora sulla geometria del PDF (PyMuPDF):
  - le tabelle prodotto a sinistra (Descrizione / Art / um / EAN / lordo…)
    danno una riga per articolo;
  - le colonne "Prezzo netto minimo per quantità" / "Extra sconto" /
    "Fascia cliente" ecc. vengono lette per posizione x, così ogni prezzo
    resta associato al proprio scaglione (60 CZ, 120 CZ, 2 box, …);
  - le fasce rosse / titoli rossi definiscono la sezione (categoria).

Schema: tabella listino_fl (vedi README) + colonne di migrations/007_listino_griglie.sql

Uso:
    python parse_listino.py <file.pdf>            # importa su Supabase
    python parse_listino.py <file.pdf> --json out.json   # solo estrazione
"""

import argparse
import json
import os
import re
from collections import defaultdict

import pymupdf


# ── Helpers ───────────────────────────────────────────────────────────────────

def _num(s):
    """'16,10' → 16.10 · '1.024,29' → 1024.29 · None se non parsabile."""
    if s is None:
        return None
    s = str(s).strip().replace('€', '').replace(' ', '')
    if not s:
        return None
    s = s.replace('.', '').replace(',', '.')
    try:
        return float(s)
    except ValueError:
        return None


def _clean(s):
    return re.sub(r'\s+', ' ', (s or '').replace('\n', ' ')).strip()


ART_RE   = re.compile(r'^\d{4,6}$')
EAN_RE   = re.compile(r'^\d{12,14}$')
PRICE_RE = re.compile(r'^\d{1,3}(?:\.\d{3})*,\d{2}$')
PCT_RE   = re.compile(r'^(\d+(?:,\d+)?)\s*%$')
PRICE_HDR_RE = re.compile(r'prezzo netto|extra sconto|distributori|netto a|rivendita|sconto speciale|fascia', re.I)
TITLE_HDR_RE = re.compile(r'prezzo netto|extra sconto', re.I)
QTY_RE   = re.compile(r'^\d[\d.]*\s*[A-Za-z]', re.I)
UM_SET   = {'CZ', 'PZ', 'BOX', 'CF', 'MT', 'KG', 'PZT', 'BU', 'M', 'PAA'}

# Header colonna tabella prodotto → campo
MAIN_COLS = [
    ('descrizione',     re.compile(r'^descrizione', re.I)),
    ('note',            re.compile(r'^(n?o?te|n|no|not|note|ote|te|e)$', re.I)),
    ('art',             re.compile(r'^art\.?$', re.I)),
    ('um',              re.compile(r'^u\.?m\.?$', re.I)),
    ('ean',             re.compile(r'(codice )?ean', re.I)),
    ('acquisto_minimo', re.compile(r'^acq', re.I)),
    ('prezzo_lordo',    re.compile(r'^prezzo\s*lordo', re.I)),
]


def _is_white(color):
    return color == 0xFFFFFF


def _is_red(color):
    r, g, b = (color >> 16) & 255, (color >> 8) & 255, color & 255
    return r > 200 and g < 60 and b < 60


# ── Estrazione per pagina ─────────────────────────────────────────────────────

def _sections(page):
    """[(y, titolo)] ordinati — fasce rosse (testo bianco) o titoli rossi grandi."""
    out = []
    for b in page.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            spans = [s for s in l['spans'] if s['text'].strip()]
            if not spans:
                continue
            s0 = spans[0]
            if (s0['size'] >= 17 and _is_white(s0['color'])) or \
               (s0['size'] >= 22 and _is_red(s0['color'])):
                txt = _clean(' '.join(s['text'] for s in spans))
                if 'DIVULGABILE' in txt.upper():
                    continue
                out.append((l['bbox'][1], txt))
    return sorted(out)


def _phrases(words):
    """Unisce parole contigue sulla stessa riga → [(x0,y0,x1,y1,text)]."""
    words = sorted(words, key=lambda w: (round((w[1] + w[3]) / 2 / 4), w[0]))
    out = []
    for w in words:
        x0, y0, x1, y1, t = w[:5]
        if out:
            p = out[-1]
            same_line = abs((p[1] + p[3]) / 2 - (y0 + y1) / 2) < 4
            if same_line and x0 - p[2] < max(6, (y1 - y0) * 0.6):
                out[-1] = (p[0], min(p[1], y0), x1, max(p[3], y1), p[4] + ' ' + t)
                continue
        out.append((x0, y0, x1, y1, t))
    return out


def _map_main_columns(table):
    """Restituisce ({campo: col_idx}, n_header_rows) leggendo le prime righe."""
    rows = table.extract()
    mapping, header_rows = {}, 0
    for ri, row in enumerate(rows[:3]):
        found = False
        for ci, cell in enumerate(row):
            txt = _clean(cell)
            if not txt:
                continue
            for field, rx in MAIN_COLS:
                if field not in mapping and rx.search(txt):
                    mapping[field] = ci
                    found = True
                    # "Prezzo lordo 100 pz" / "CZ" → unità del lordo
                    if field == 'prezzo_lordo':
                        m = re.search(r'lordo\s*(.*)$', txt, re.I)
                        if m and m.group(1).strip():
                            mapping['_lordo_per'] = m.group(1).strip()
                    break
            else:
                if 'prezzo_lordo' in mapping and ci == mapping['prezzo_lordo'] and ri > 0:
                    if txt and not _num(txt):
                        mapping['_lordo_per'] = txt
        # Riga di header = contiene almeno un'etichetta e nessun codice articolo
        if found or (ri == 0 and not any(ART_RE.match(_clean(c) or '') for c in row)):
            header_rows = ri + 1
        else:
            break
    if header_rows and 'art' in mapping:
        # riga successiva a header senza codici (es. 'mm', 'CZ') → ancora header
        for row in rows[header_rows:header_rows + 1]:
            if not ART_RE.match(_clean(row[mapping['art']]) or ''):
                cell = row[mapping['prezzo_lordo']] if 'prezzo_lordo' in mapping else None
                if cell and not _num(cell) and '_lordo_per' not in mapping:
                    mapping['_lordo_per'] = _clean(cell)
                header_rows += 1
    return mapping, header_rows


def _infer_columns(table, prev):
    """Tabella senza header: riusa la mappatura precedente allineando le colonne per x."""
    if not prev:
        return {}
    prev_map, prev_cols = prev
    row0 = table.rows[0].cells
    centers = [((c[0] + c[2]) / 2) if c else None for c in row0]
    mapping = {}
    for field, ci in prev_map.items():
        if field.startswith('_'):
            mapping[field] = ci
            continue
        if ci >= len(prev_cols) or prev_cols[ci] is None:
            continue
        target = prev_cols[ci]
        best, bd = None, 1e9
        for j, cx in enumerate(centers):
            if cx is None:
                continue
            if abs(cx - target) < bd:
                best, bd = j, abs(cx - target)
        if best is not None and bd < 40:
            mapping[field] = best
    return mapping


def _row_centers(table):
    row = next((r for r in table.rows if all(r.cells)), table.rows[-1])
    return [((c[0] + c[2]) / 2) if c else None for c in row.cells]


def _value(txt):
    """Interpreta una cella prezzo → dict o None."""
    t = _clean(txt)
    if not t or t in {'-', '\\', 'x', '/'}:
        return None
    if PRICE_RE.match(t):
        return {'tipo': 'netto', 'valore': _num(t)}
    m = PCT_RE.match(t)
    if m:
        return {'tipo': 'sconto', 'valore': _num(m.group(1))}
    if QTY_RE.match(t):
        return {'tipo': 'qta', 'testo': t}
    return None


def _price_columns(header_phr, value_phr, x_lo, x_hi):
    """Colonne della griglia prezzi: [(x0, x1, label)] + titolo."""
    # Centri colonna dai valori (cluster per x)
    centers = []
    for p in sorted(value_phr, key=lambda p: (p[0] + p[2]) / 2):
        cx = (p[0] + p[2]) / 2
        if centers and abs(centers[-1][0] - cx) < 22:
            c, n = centers[-1]
            centers[-1] = ((c * n + cx) / (n + 1), n + 1)
        else:
            centers.append((cx, 1))
    centers = [c for c, _ in centers]

    # Header "stretti" (una colonna) → aggiungono colonne vuote (scaglioni senza prezzo)
    narrow = [p for p in header_phr if (p[2] - p[0]) < 120]
    for p in narrow:
        cx = (p[0] + p[2]) / 2
        if not any(abs(cx - c) < 30 for c in centers):
            # solo se sulla riga più bassa dell'header (etichette scaglione)
            centers.append(cx)
    centers.sort()
    if not centers:
        return [], ''

    bounds = []
    for i, c in enumerate(centers):
        left  = x_lo if i == 0 else (centers[i - 1] + c) / 2
        right = x_hi if i == len(centers) - 1 else (c + centers[i + 1]) / 2
        bounds.append((left, right))

    labels = [[] for _ in centers]
    title  = []
    last_title = None
    for p in sorted(header_phr, key=lambda p: (p[1], p[0])):
        cx = (p[0] + p[2]) / 2
        idx = next((i for i, (l, r) in enumerate(bounds) if l <= cx < r), None)
        w = p[2] - p[0]
        if idx is None:
            continue
        col_w = bounds[idx][1] - bounds[idx][0]
        # continuazione a capo del titolo (centrata sotto di esso)
        cont = last_title is not None and p[1] - last_title[3] < (p[3] - p[1]) * 1.3 \
            and abs(cx - (last_title[0] + last_title[2]) / 2) < 15 \
            and not re.match(r'^\d', p[4])
        cont = cont or (last_title is not None and p[1] - last_title[3] < (p[3] - p[1]) * 0.8
                        and w > (last_title[2] - last_title[0]) * 0.6 and not re.match(r'^\d', p[4]))
        if len(centers) > 1 and (w > col_w * 1.4 or cont or TITLE_HDR_RE.search(p[4])):
            title.append(p[4])
            last_title = p
        else:
            labels[idx].append(p[4])
    if len(centers) == 1 and len(labels[0]) > 1:
        hp = sorted(header_phr, key=lambda p: p[1])
        bottom_y = hp[-1][1]
        bottom = [p[4] for p in hp if abs(p[1] - bottom_y) < 4]
        title = [p[4] for p in hp if abs(p[1] - bottom_y) >= 4]
        labels = [bottom]
    cols = [(l, r, _clean(' '.join(lb))) for (l, r), lb in zip(bounds, labels)]
    return cols, _clean(' '.join(title))


def parse_page(page, pn, state):
    W = page.rect.width
    words = page.get_text('words')
    tables = page.find_tables().tables
    sections = _sections(page)

    # Footnote "* ..." della pagina
    footnotes = [_clean(p[4]) for p in _phrases(words) if p[4].startswith('* ')]

    main_tabs = [t for t in tables if t.bbox[0] < W * 0.2 and t.col_count >= 2]
    right_tabs = [t for t in tables if t.bbox[0] > W * 0.4]
    # Tabella "Art. / Descrizione" ripetuta a destra (o Art. UPAT)
    repeat_x0 = None
    for t in right_tabs:
        txt = ' '.join(_clean(c) for r in t.extract()[:2] for c in r if c)
        if t.col_count in (2, 4) and (re.search(r'\bArt\b', txt) or ART_RE.match(_clean(t.extract()[0][0]) or '')):
            repeat_x0 = t.bbox[0] if repeat_x0 is None else min(repeat_x0, t.bbox[0])
    # Tabelle "art equivalente" (UPAT)
    equiv_tabs = [t for t in right_tabs if t.col_count == 4]

    # Celle gialle = "Fuori listino" (anche quando il testo è su più righe fuse)
    yellow = []
    for dr in page.get_drawings():
        f = dr.get('fill')
        if f and len(f) == 3 and f[0] > 0.9 and f[1] > 0.9 and f[2] < 0.3:
            yellow.append(dr['rect'])

    records = []
    prev_bottom = 0
    main_tabs.sort(key=lambda t: t.bbox[1])
    for t in main_tabs:
        mapping, n_hdr = _map_main_columns(t)
        if 'art' in mapping and n_hdr:
            state['main'] = (mapping, _row_centers(t))
        else:
            mapping = _infer_columns(t, state.get('main'))
            n_hdr = 0
        if 'art' not in mapping:
            # pagine "solar": art / descrizione senza header riconosciuto
            if t.col_count >= 2:
                mapping = {'art': 0, 'descrizione': 1}
            else:
                continue

        rows = t.extract()
        data_rows = [i for i in range(n_hdr, len(rows))
                     if mapping['art'] < len(rows[i]) and ART_RE.match(_clean(rows[i][mapping['art']]) or '')]
        if not data_rows:
            prev_bottom = t.bbox[3]
            continue

        art_ci = mapping['art']
        # x della colonna NOTE (le celle fuse risultano None su alcune righe)
        note_cx = None
        if 'note' in mapping:
            nc = next((r.cells[mapping['note']] for r in t.rows
                       if mapping['note'] < len(r.cells) and r.cells[mapping['note']]), None)
            note_cx = (nc[0] + nc[2]) / 2 if nc else None
        cell_box = lambda i: t.rows[i].cells[art_ci] or t.rows[i].bbox
        # Righe di header interne (tabelle fuse) separano gruppi con griglie diverse
        groups, cur = [], [data_rows[0]]
        for i in data_rows[1:]:
            if i == cur[-1] + 1:
                cur.append(i)
            else:
                groups.append(cur)
                cur = [i]
        groups.append(cur)

        for gi, data_rows in enumerate(groups):
            if gi:
                prev_bottom = cell_box(groups[gi - 1][-1])[3]
            first_y = cell_box(data_rows[0])[1]
            hdr_top = max(prev_bottom + 2, t.bbox[1] - 90) if not gi else prev_bottom + 2
            art_x1 = cell_box(data_rows[0])[2]
            x_lo = t.bbox[2] + 5
            x_hi = (repeat_x0 - 5) if repeat_x0 and repeat_x0 > x_lo else W
            # Griglia prezzi dentro la stessa tabella (tabelle fuse): parte dall'header prezzi
            hdr_all = _phrases([w for w in words if hdr_top <= (w[1] + w[3]) / 2 < first_y - 1
                                and w[0] > art_x1])
            kw = [p for p in hdr_all if PRICE_HDR_RE.search(p[4])]
            if kw:
                kx = min(p[0] for p in kw) - 5
                if kx < x_lo:
                    x_lo = kx
                    arts = [p for p in hdr_all if p[0] > kx + 60 and re.match(r'^Art\.?$', p[4])]
                    if arts:
                        x_hi = min(p[0] for p in arts) - 5
            # Nelle pagine "solar" (senza EAN) la griglia prezzi è a destra della tabella
            zone = [w for w in words if x_lo <= (w[0] + w[2]) / 2 <= x_hi]

            # Header griglia: sopra la prima riga dati, sotto la tabella precedente
            header_words = [w for w in zone if hdr_top <= (w[1] + w[3]) / 2 < first_y - 1]
            header_phr = [p for p in _phrases(header_words) if not p[4].startswith('*')]

            # Valori di tutte le righe dati
            row_vals = []
            all_vals = []
            for i in data_rows:
                rb = cell_box(i)
                ws = [w for w in zone if rb[1] - 1 <= (w[1] + w[3]) / 2 <= rb[3] + 1]
                ph = [p for p in _phrases(ws) if _value(p[4])]
                row_vals.append(ph)
                all_vals.extend(ph)

            if header_phr:
                cols, title = _price_columns(header_phr, all_vals, x_lo, x_hi)
                state['grid'] = (cols, title, x_lo, x_hi)
            elif state.get('grid') and all_vals:
                cols, title, gx_lo, gx_hi = state['grid']
                # stessa griglia della tabella precedente se i valori ci cadono dentro
                if not all(any(l <= (p[0] + p[2]) / 2 < r for l, r, _ in cols) for p in all_vals):
                    cols, title = _price_columns([], all_vals, x_lo, x_hi)
            else:
                cols, title = _price_columns([], all_vals, x_lo, x_hi) if all_vals else ([], '')

            # Sezione: ultimo titolo sopra la tabella
            for y, s in sections:
                if y < first_y:
                    state['sezione'] = s

            # Note unite (celle fuse → None) si propagano verso il basso
            last_note = ''
            for i, ph in zip(data_rows, row_vals):
                row = rows[i]
                get = lambda f: _clean(row[mapping[f]]) if f in mapping and mapping[f] < len(row) else ''
                note_raw = row[mapping['note']] if 'note' in mapping and mapping['note'] < len(row) else ''
                if note_raw is None:
                    note = last_note
                else:
                    note = _clean(note_raw)
                    last_note = note
                fuori = bool(re.search(r'fuori|listino|^f\.?l\.?$', note, re.I))
                if note_cx is not None and any(
                        r.contains(pymupdf.Point(note_cx, (cell_box(i)[1] + cell_box(i)[3]) / 2)) for r in yellow):
                    fuori = True
                nota = '' if fuori else note
                if nota == '*':
                    nota = footnotes[0] if footnotes else ''

                scaglioni = []
                for p in ph:
                    v = _value(p[4])
                    cx = (p[0] + p[2]) / 2
                    col = next((c for c in cols if c[0] <= cx < c[1]), None)
                    label = col[2] if col else ''
                    if v['tipo'] == 'qta':
                        # "Extra sconto per quantità": header = %, cella = quantità
                        m = PCT_RE.match(label or '')
                        scaglioni.append({'label': v['testo'], 'tipo': 'sconto',
                                          'valore': _num(m.group(1)) if m else None})
                    elif v['tipo'] == 'sconto':
                        scaglioni.append({'label': label, 'tipo': 'sconto', 'valore': v['valore']})
                    else:
                        scaglioni.append({'label': label, 'tipo': 'netto', 'valore': v['valore']})

                um = get('um').upper() or None
                lordo = _num(get('prezzo_lordo')) if 'prezzo_lordo' in mapping else None
                acq = _num(get('acquisto_minimo')) if 'acquisto_minimo' in mapping else None
                netti = [s['valore'] for s in scaglioni if s['tipo'] == 'netto' and s['valore'] is not None]

                rec = {
                    'codice_articolo': get('art'),
                    'descrizione':     get('descrizione') or None,
                    'categoria':       state.get('sezione'),
                    'unita_misura':    um if um else None,
                    'codice_ean':      get('ean') if EAN_RE.match(get('ean')) else None,
                    'acquisto_minimo': int(acq) if acq is not None else None,
                    'prezzo_lordo':    lordo,
                    'lordo_per':       mapping.get('_lordo_per'),
                    'prezzi_netti':    netti,
                    'scaglioni':       scaglioni,
                    'titolo_prezzi':   title or None,
                    'fuori_listino':   fuori,
                    'nota':            nota or None,
                    'art_equivalente': None,
                    'pagina':          pn + 1,
                }
                # UPAT: articolo Fischer equivalente sulla stessa riga
                ry = (cell_box(i)[1] + cell_box(i)[3]) / 2
                for et in equiv_tabs:
                    for er, erow in zip(et.rows, et.extract()):
                        if er.bbox[1] <= ry <= er.bbox[3] and len(erow) >= 4:
                            a, dsc = _clean(erow[2]), _clean(erow[3])
                            if ART_RE.match(a):
                                rec['art_equivalente'] = f'{a} {dsc}'.strip()
                records.append(rec)
        prev_bottom = t.bbox[3]

    # L'ultima sezione della pagina prosegue sulla pagina successiva
    if sections:
        state['sezione'] = sections[-1][1]
    return records


def parse_listino(filepath):
    """Restituisce lista di record pronti per Supabase."""
    doc = pymupdf.open(filepath)

    edition = edition_date = None
    for page in doc:
        m = re.search(r'Ed\.\s*(\d{2})/(\d{4})', page.get_text())
        if m:
            edition, edition_date = f'{m.group(1)}/{m.group(2)}', f'{m.group(2)}-{m.group(1)}-01'
            break
    if not edition:
        m = re.search(r'ed_(\d{2})_(\d{4})', os.path.basename(filepath), re.I)
        if m:
            edition, edition_date = f'{m.group(1)}/{m.group(2)}', f'{m.group(2)}-{m.group(1)}-01'
    print(f"  📋 Edizione: {edition} · data: {edition_date}")

    state, records = {}, []
    for pn, page in enumerate(doc):
        state.pop('grid', None)
        if pn and doc[pn - 1].rect != page.rect:
            state.pop('main', None)
        records.extend(parse_page(page, pn, state))

    # Dedup per codice (tieni la prima occorrenza) + ordine di pagina
    seen, out = set(), []
    for i, r in enumerate(records):
        if r['codice_articolo'] in seen:
            continue
        seen.add(r['codice_articolo'])
        r['ordine'] = i
        r['edizione'] = edition
        r['data_listino'] = edition_date
        out.append(r)
    return out


# ── Import Supabase ───────────────────────────────────────────────────────────

def importa_listino(filepath, client):
    print(f"\n📄 {os.path.basename(filepath)}")
    records = parse_listino(filepath)
    if not records:
        print("  ❌ Nessun prodotto trovato")
        return False

    by_cat = defaultdict(int)
    for r in records:
        by_cat[r['categoria']] += 1
    print(f"  Prodotti trovati: {len(records)} in {len(by_cat)} sezioni")

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
        description="Importa Griglie Netti FL (PDF) in Supabase"
    )
    parser.add_argument('file', help='Path al PDF da importare')
    parser.add_argument('--json', help='Scrive i record estratti in un file JSON (nessun import)')
    args = parser.parse_args()

    if args.json:
        records = parse_listino(args.file)
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(records, f, ensure_ascii=False, indent=1)
        print(f"  {len(records)} record → {args.json}")
        return

    from dotenv import load_dotenv
    from supabase import create_client

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
