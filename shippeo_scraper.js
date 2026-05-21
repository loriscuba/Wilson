const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

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
        s.stopType === 'delivery' ||
        s.stopType === 'unloading' ||
        s.type     === 'delivery' ||
        s.role     === 'delivery'
    );
    if (!dest) return null;
    return (
        dest.dates?.plannedArrivalStartDate ||
        dest.dates?.plannedArrivalEndDate   ||
        dest.dates?.estimatedArrivalDate    ||
        dest.etas?.[0]?.value               ||
        dest.eta                            ||
        dest.estimatedArrivalDate           ||
        null
    );
}

// Cerca una data valida in un oggetto JSON in modo ricorsivo (max 3 livelli)
function findDate(obj, depth = 0) {
    if (depth > 3 || !obj || typeof obj !== 'object') return null;
    for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v;
        if (typeof v === 'object') {
            const found = findDate(v, depth + 1);
            if (found) return found;
        }
    }
    return null;
}

async function getShippeoData(shippeoUrl) {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        headless: 'new',
    });
    const page = await browser.newPage();

    // Cattura TUTTE le risposte JSON da domini shippeo
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
                console.log(`  [DEBUG] ${url}`);
                console.log(`  [DEBUG] ${JSON.stringify(body).slice(0, 500)}`);
            }
        } catch (_) {}
    });

    try {
        await page.goto(shippeoUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    } catch (_) {
        // networkidle2 può scadere su pagine con polling; va bene lo stesso
    }

    // Estrai testo visibile come fallback
    const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');

    await browser.close();

    // Analizza tutte le risposte catturate
    let status = null, etaRaw = null, deliveredAt = null;

    for (const { body } of captured) {
        // Status: prova percorsi multipli
        const s = body?.status?.currentStatus
               || body?.currentStatus
               || body?.status
               || null;
        if (s && typeof s === 'string' && !status) status = s;

        // Data consegna effettiva
        const da = body?.status?.occurredOn
                || body?.occurredOn
                || body?.deliveredAt
                || body?.actualDeliveryDate
                || null;
        if (da && !deliveredAt) deliveredAt = da;

        // ETA
        const eta = body?.estimatedDeliveryDate
                 || body?.eta
                 || body?.estimatedArrival
                 || etaDaStops(body?.stops)
                 || (body && Object.keys(body).length === 1 ? Object.values(body)[0] : null)
                 || null;
        if (eta && typeof eta === 'string' && !etaRaw) etaRaw = eta;
    }

    // Fallback DOM: se la pagina mostra "consegnato"/"delivered" nel testo visibile
    if (!status) {
        const t = pageText.toLowerCase();
        if (t.includes('consegnat') || t.includes('delivered') || t.includes('delivery')) {
            status = 'deliveryCompliant';
            // Cerca una data nel testo tipo "20/05" o "20 mag"
            const m = pageText.match(/(\d{1,2})[\/\s](\d{2})[\/\s]?(\d{2,4})?/);
            if (m && !deliveredAt) {
                const year = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : new Date().getFullYear();
                deliveredAt = `${year}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
            }
        }
    }

    if (process.env.DEBUG) {
        console.log(`  [result] status=${status} eta=${etaRaw} deliveredAt=${deliveredAt}`);
        console.log(`  [result] captured ${captured.length} risposte JSON`);
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

        const now        = new Date();
        const etaDate    = etaRaw ? new Date(etaRaw) : null;
        const etaOk      = etaDate && !isNaN(etaDate);
        const etaPassed  = etaOk && etaDate < now;
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
