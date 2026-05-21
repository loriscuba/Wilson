const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

const MESI_IT = {
    gennaio:1, febbraio:2, marzo:3, aprile:4, maggio:5, giugno:6,
    luglio:7, agosto:8, settembre:9, ottobre:10, novembre:11, dicembre:12,
    jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
    jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

// Converte "22 maggio 2026" o "22/05/2026" in ISO string
function parseDataIT(s) {
    if (!s) return null;
    s = s.trim();

    // ISO già pronta
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

    // "22/05/2026" o "22.05.2026"
    const slashM = s.match(/^(\d{1,2})[\/\.](\d{1,2})[\/\.](\d{4})/);
    if (slashM) return `${slashM[3]}-${slashM[2].padStart(2,'0')}-${slashM[1].padStart(2,'0')}`;

    // "22 maggio 2026" o "22 maggio" (anno corrente)
    const wordM = s.match(/(\d{1,2})\s+([a-zéè]+)\s*(\d{4})?/i);
    if (wordM) {
        const mese = MESI_IT[wordM[2].toLowerCase()];
        if (mese) {
            const anno = wordM[3] || new Date().getFullYear();
            return `${anno}-${String(mese).padStart(2,'0')}-${wordM[1].padStart(2,'0')}`;
        }
    }

    return null;
}

// Normalizza URL Shippeo al formato /road/orderPublic/TOKEN/overview
function normalizeShippeoUrl(url) {
    const tokenM = url.match(/orderPublic\/([A-Z0-9]+)/i);
    if (!tokenM) return url;
    return `https://view.shippeo.com/road/orderPublic/${tokenM[1]}/overview`;
}

function mapStatus(s) {
    if (!s) return null;
    const l = s.toLowerCase();
    if (l.includes('delivery')) return 'consegnato';
    if (l.includes('transit'))  return 'spedito';
    if (l.includes('loading'))  return 'spedito';
    if (l.includes('pickup'))   return 'spedito';
    if (l.includes('exception')) return 'spedito';
    return null;
}

function etaDaStops(stops) {
    if (!Array.isArray(stops)) return null;
    const dest = stops.find(s =>
        s.stopType === 'delivery' || s.stopType === 'unloading' ||
        s.type     === 'delivery' || s.role      === 'delivery'
    );
    if (!dest) return null;
    return (
        dest.dates?.plannedArrivalStartDate ||
        dest.dates?.plannedArrivalEndDate   ||
        dest.dates?.estimatedArrivalDate    ||
        dest.etas?.[0]?.value               ||
        dest.eta || dest.estimatedArrivalDate || null
    );
}

// Ricerca ricorsiva di campi data in oggetti JSON
function findField(obj, keys, depth = 0) {
    if (depth > 5 || !obj || typeof obj !== 'object') return null;
    for (const k of Object.keys(obj)) {
        if (keys.some(kk => k.toLowerCase().includes(kk))) {
            const v = obj[k];
            if (typeof v === 'string' && /\d{4}-\d{2}-\d{2}/.test(v)) return v;
            if (typeof v === 'number' && v > 1e12) return new Date(v).toISOString();
        }
        if (typeof obj[k] === 'object') {
            const found = findField(obj[k], keys, depth + 1);
            if (found) return found;
        }
    }
    return null;
}

async function getShippeoData(rawUrl) {
    const shippeoUrl = normalizeShippeoUrl(rawUrl);
    if (process.env.DEBUG) console.log(`  [url] ${shippeoUrl}`);

    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        headless: 'new',
    });
    const page = await browser.newPage();

    const captured = [];
    page.on('response', async res => {
        const url = res.url();
        if (!url.includes('shippeo')) return;
        const ct = res.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        try {
            const body = await res.json();
            captured.push({ url, body });
            if (process.env.DEBUG) {
                console.log(`  [api] ${url}`);
                console.log(`  [api] ${JSON.stringify(body).slice(0, 500)}`);
            }
        } catch (_) {}
    });

    try {
        await page.goto(shippeoUrl, { waitUntil: 'networkidle0', timeout: 50000 });
    } catch (_) {}

    // Attende che il contenuto sia visibile (max 5s extra)
    await page.waitForSelector('body', { timeout: 5000 }).catch(() => {});
    const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');

    await browser.close();

    // Analizza risposte API
    let status = null, etaRaw = null, deliveredAt = null;

    for (const { body } of captured) {
        const s = body?.status?.currentStatus || body?.currentStatus ||
                  (typeof body?.status === 'string' ? body.status : null);
        if (s && !status) status = s;

        const da = findField(body, ['occurredon','deliveredat','actualdelivery','consegnato']);
        if (da && !deliveredAt) deliveredAt = da;

        const eta = findField(body, ['estimateddelivery','estimatedarrival','eta','planned']) ||
                    etaDaStops(body?.stops) || etaDaStops(body?.order?.stops);
        if (eta && !etaRaw) etaRaw = eta;
    }

    // Fallback: estrai dal testo visibile della pagina
    if (!status || !etaRaw) {
        const t = pageText;
        const tl = t.toLowerCase();

        // Cerca "Consegnato il 20 maggio" o "Consegnato il 20/05"
        const consM = t.match(/consegnat\w{0,2}\s+(?:il\s+)?(\d{1,2}[\/\s\.][a-z]+[\/\s\.]\d{0,4}|\d{1,2}[\/\.]\d{2}[\/\.]\d{2,4})/i);
        if (consM) {
            if (!status) status = 'deliveryCompliant';
            if (!deliveredAt) deliveredAt = parseDataIT(consM[1]);
        } else if (tl.includes('consegnat') || tl.includes('delivered')) {
            if (!status) status = 'deliveryCompliant';
        }

        // Cerca "Prevista il 22 maggio" o "Consegna prevista 22/05"
        const etaM = t.match(/(?:prevista?|stimata?|estimated?)\s*(?:il\s+)?(\d{1,2}[\/\s\.][a-z]+[\/\s\.]\d{0,4}|\d{1,2}[\/\.]\d{2}[\/\.]\d{2,4})/i);
        if (etaM && !etaRaw) etaRaw = parseDataIT(etaM[1]);
    }

    if (process.env.DEBUG) {
        console.log(`  [result] status=${status} eta=${etaRaw} deliveredAt=${deliveredAt} (${captured.length} API)`);
    }

    return { status, etaRaw, deliveredAt };
}

async function main() {
    const { data: ddts, error } = await supabase
        .from('ddt')
        .select('id, numero_ddt, numero_ordine, shippeo_url, stato')
        .not('shippeo_url', 'is', null)
        .neq('stato', 'consegnato');

    if (error) { console.error('Errore Supabase:', error); process.exit(1); }
    if (!ddts?.length) { console.log('Nessun DDT con tracking da aggiornare.'); return; }

    console.log(`DDT da verificare: ${ddts.length}\n`);

    for (const ddt of ddts) {
        console.log(`DDT ${ddt.numero_ddt} | Ordine ${ddt.numero_ordine}`);

        const { status, etaRaw, deliveredAt } = await getShippeoData(ddt.shippeo_url);
        const statoMapped = mapStatus(status);

        console.log(`  status raw : ${status || '—'}`);
        console.log(`  stato      : ${statoMapped || '(non mappato)'}`);
        console.log(`  ETA        : ${etaRaw || '—'}`);
        console.log(`  Consegnato : ${deliveredAt || '—'}`);

        const now       = new Date();
        const etaDate   = etaRaw ? new Date(etaRaw) : null;
        const etaOk     = etaDate && !isNaN(etaDate);
        const etaPassed = etaOk && etaDate < now;
        const isConsegnato = statoMapped === 'consegnato' || etaPassed;

        const update = {};
        if (status) update.stato_shippeo = status;
        if (etaOk)  update.eta_shippeo  = etaDate.toISOString();

        if (isConsegnato) {
            update.stato = 'consegnato';
            const consegnaDate = deliveredAt
                ? new Date(deliveredAt).toISOString()
                : (etaPassed ? etaDate.toISOString() : null);
            if (consegnaDate) update.data_consegna_effettiva = consegnaDate;
            await supabase.from('ordini')
                .update({ stato: 'consegnato' })
                .eq('numero_ordine', ddt.numero_ordine);
            console.log(`  ✓ CONSEGNATO il ${consegnaDate || '—'}`);
        } else {
            update.stato = statoMapped || 'spedito';
            console.log(`  → In transito / ETA ${etaRaw || '—'}`);
        }

        if (Object.keys(update).length > 0) {
            await supabase.from('ddt').update(update).eq('id', ddt.id);
            console.log(`  ✓ DDT aggiornato`);
        }
        console.log();
    }

    console.log('Sync Shippeo completato.');
}

main().catch(err => { console.error(err); process.exit(1); });
