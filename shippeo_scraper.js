const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

function extractToken(shippeoUrl) {
    return shippeoUrl.split('/').filter(Boolean).pop();
}

function mapStatus(currentStatus) {
    if (!currentStatus) return null;
    if (currentStatus.toLowerCase().includes('delivery')) return 'consegnato';
    if (currentStatus.toLowerCase().includes('transit') || currentStatus.toLowerCase().includes('loading')) return 'spedito';
    return null;
}

function findPlannedDate(stops) {
    const delivery = stops?.find(s => s.stopType === 'delivery' || s.stopType === 'unloading');
    if (!delivery) return null;
    return (
        delivery.dates?.plannedArrivalStartDate ||
        delivery.dates?.plannedArrivalEndDate ||
        delivery.etas?.[0]?.value ||
        null
    );
}

async function getShippeoData(shippeoUrl) {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        headless: 'new',
    });

    const page = await browser.newPage();
    let overview = null;
    let etaData = null;

    page.on('response', async response => {
        const url = response.url();
        if (!url.includes('sf.core.prod.shippeo.com')) return;
        try {
            const body = await response.json();
            if (url.includes('/goods/order/overview')) overview = body;
            if (url.includes('/orders/eta')) etaData = body;
            if (process.env.DEBUG) {
                console.log(`    [DEBUG] ${url}`);
                console.log(`    [DEBUG] ${JSON.stringify(body).slice(0, 800)}`);
            }
        } catch (_) {}
    });

    try {
        await page.goto(shippeoUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    } catch (_) {}

    await browser.close();

    const status = overview?.status?.currentStatus || null;
    const deliveredAt = overview?.status?.occurredOn || null;
    const etaRaw =
        (etaData && Object.keys(etaData).length > 0 ? etaData?.estimatedDeliveryDate || etaData?.eta : null) ||
        findPlannedDate(overview?.stops);

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

        console.log(`  status: ${status || '—'} → ${statoMapped || '—'}`);
        console.log(`  ETA: ${etaRaw || '—'}`);
        console.log(`  Consegnato: ${deliveredAt || '—'}`);

        const now = new Date();
        const etaDate = etaRaw ? new Date(etaRaw) : null;
        const etaPassed = etaDate && etaDate < now;
        const isConsegnato = statoMapped === 'consegnato' || etaPassed;

        const update = {};
        if (etaRaw) update.eta_shippeo = etaDate.toISOString();
        if (status) update.stato_shippeo = status;

        if (isConsegnato) {
            update.stato = 'consegnato';
            const consegnaDate = deliveredAt || (etaPassed ? etaDate.toISOString() : null);
            if (consegnaDate) update.data_consegna_effettiva = new Date(consegnaDate).toISOString();
            await supabase.from('ordini').update({ stato: 'consegnato' }).eq('numero_ordine', ddt.numero_ordine);
            console.log(`  ✓ CONSEGNATO il ${consegnaDate}`);
        } else {
            update.stato = 'spedito';
            console.log(`  → In transito, consegna prevista ${etaRaw || '—'}`);
        }

        if (Object.keys(update).length > 0) {
            await supabase.from('ddt').update(update).eq('id', ddt.id);
            console.log(`  ✓ DDT aggiornato`);
        } else {
            console.log(`  ⚠ Nessun dato`);
        }
        console.log();
    }

    console.log('Sync Shippeo completato.');
}

main().catch(err => { console.error(err); process.exit(1); });
