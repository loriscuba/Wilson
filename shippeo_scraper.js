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

function parseDataIT(s) {
    if (!s) return null;
    s = s.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
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
    // "22/05" senza anno → anno corrente
    const shortSlash = s.match(/^(\d{1,2})[\/\.](\d{2})$/);
    if (shortSlash) {
        const anno = new Date().getFullYear();
        return `${anno}-${shortSlash[2].padStart(2,'0')}-${shortSlash[1].padStart(2,'0')}`;
    }
    return null;
}

function normalizeShippeoUrl(url) {
    const tokenM = url.match(/orderPublic\/([A-Z0-9]+)/i);
    if (!tokenM) return url;
    return `https://view.shippeo.com/road/orderPublic/${tokenM[1]}/overview`;
}

function extractToken(url) {
    const m = url.match(/orderPublic\/([A-Z0-9]+)/i);
    return m ? m[1] : null;
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

// Tenta di leggere lo stato direttamente dalle API Shippeo senza browser.
// Ritorna { status, etaRaw, deliveredAt } solo se la consegna è confermata
// (status 'delivery*' O data effettiva nel passato); altrimenti { _partial: true, etaRaw }
// per passare l'ETA a Puppeteer senza saltare il controllo testo pagina.
async function tryDirectApi(token) {
    const endpoints = [
        `https://view.shippeo.com/api/road/orderPublic/${token}`,
        `https://view.shippeo.com/api/orderPublic/${token}`,
        `https://api.shippeo.com/road/orderPublic/${token}`,
    ];
    const headers = {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };
    for (const url of endpoints) {
        try {
            const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
            if (!res.ok) continue;
            const ct = res.headers.get('content-type') || '';
            if (!ct.includes('json')) continue;
            const body = await res.json();
            const sRaw = body?.status?.currentStatus || body?.currentStatus ||
                         (typeof body?.status === 'string' ? body.status : null);
            const s = (sRaw && sRaw.toLowerCase() !== 'status') ? sRaw : null;
            // Solo campi che indicano data effettiva di consegna (NON planned/estimated)
            const da  = findField(body, ['occurredon','deliveredat','actualdelivery']);
            const eta = findField(body, ['estimateddelivery','estimatedarrival','eta','planned']) ||
                        etaDaStops(body?.stops) || etaDaStops(body?.order?.stops);

            // Consegna confermata: status 'delivery*' oppure data effettiva nel passato
            const daIsActual = da && !isNaN(new Date(da)) && new Date(da) < new Date();
            const deliveryConfirmed = (s && s.toLowerCase().startsWith('delivery')) || daIsActual;

            if (deliveryConfirmed) {
                const statusFinal = daIsActual && !s?.toLowerCase().startsWith('delivery')
                    ? 'deliveryCompliant' : s;
                console.log(`  [direct-api] CONFERMATO ${url} → status=${statusFinal} deliveredAt=${da}`);
                return { status: statusFinal, etaRaw: eta, deliveredAt: da };
            }

            // Status non-delivery (transit/exception/loading…): passa solo l'ETA
            // Puppeteer verificherà il testo pagina per rilevare consegne non ancora agganciate
            if (s || eta) {
                console.log(`  [direct-api] parziale ${url} → status=${s} eta=${eta}`);
                return { _partial: true, etaRaw: eta };
            }
        } catch (_) {}
    }
    return null;
}

async function getShippeoData(rawUrl) {
    const shippeoUrl = normalizeShippeoUrl(rawUrl);
    const token = extractToken(rawUrl);
    console.log(`  [url] ${shippeoUrl}`);

    let partialEta = null;

    if (token) {
        const direct = await tryDirectApi(token);
        if (direct && !direct._partial) return direct;   // consegna confermata → salta Puppeteer
        if (direct?._partial && direct.etaRaw) partialEta = direct.etaRaw;  // salva ETA per dopo
    }

    // Puppeteer: gira sempre per DDT non ancora confermati consegnati
    let puppeteer;
    try {
        const extra = require('puppeteer-extra');
        const Stealth = require('puppeteer-extra-plugin-stealth');
        extra.use(Stealth());
        puppeteer = extra;
    } catch (_) {
        puppeteer = require('puppeteer');
    }

    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
               '--disable-blink-features=AutomationControlled'],
        headless: 'new',
    });
    const page = await browser.newPage();

    // Simula un browser reale
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8' });

    const captured = [];
    page.on('response', async res => {
        const url = res.url();
        const ct = res.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        try {
            const body = await res.json();
            captured.push({ url, body });
        } catch (_) {}
    });

    try {
        await page.goto(shippeoUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (_) {}

    // Attendi che il contenuto dinamico si carichi (max 8s)
    await new Promise(r => setTimeout(r, 8000));

    const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    await browser.close();

    let status = null, etaRaw = null, deliveredAt = null;

    for (const { body } of captured) {
        const sRaw = body?.status?.currentStatus || body?.currentStatus ||
                     (typeof body?.status === 'string' ? body.status : null);
        const s = (sRaw && sRaw.toLowerCase() !== 'status') ? sRaw : null;
        if (s && !status) status = s;
        // Solo campi di data effettiva (non planned/estimated)
        const da = findField(body, ['occurredon','deliveredat','actualdelivery']);
        if (da && !deliveredAt) deliveredAt = da;
        const eta = findField(body, ['estimateddelivery','estimatedarrival','eta','planned']) ||
                    etaDaStops(body?.stops) || etaDaStops(body?.order?.stops);
        if (eta && !etaRaw) etaRaw = eta;
    }

    // deliveredAt da API Puppeteer: valida solo se data nel passato
    const daIsActual = deliveredAt && !isNaN(new Date(deliveredAt)) && new Date(deliveredAt) < new Date();
    if (daIsActual) status = 'deliveryCompliant';

    // Analisi testo pagina: sempre eseguita
    const t  = pageText;
    const tl = t.toLowerCase();
    const alreadyDelivery = status && status.toLowerCase().startsWith('delivery');

    if (!alreadyDelivery) {
        // "Consegnato il 20 maggio" / "Consegnato il 20/05" — pattern specifico con data
        const consM = t.match(/consegnat\w{0,3}\s+(?:il\s+)?(\d{1,2}[\s\/\.](?:[a-z]+|\d{2})[\s\/\.]?\d{0,4})/i);
        if (consM) {
            status = 'deliveryCompliant';
            // La data dal testo pagina sovrascrive sempre quella API (che può venire da stop sbagliato)
            deliveredAt = parseDataIT(consM[1].trim());
        } else if (
            tl.includes('consegnato') || tl.includes('consegnata') ||
            tl.includes('delivery compliant')  // label Shippeo esplicita
        ) {
            status = 'deliveryCompliant';
        }
    }

    // ETA dal blocco "Delivery: MM/DD/YYYY" nella pagina
    const delivPageM = t.match(/\bDelivery[:\s]+(\d{2}\/\d{2}\/\d{4})/i);
    if (delivPageM) {
        const [mm, dd, yyyy] = delivPageM[1].split('/');
        etaRaw = `${yyyy}-${mm}-${dd}`;
    }

    // Fallback italiano: "Prevista il 22 maggio" / "Consegna prevista 22/05"
    if (!etaRaw) {
        const etaM = t.match(/(?:prevista?|stimata?|estimated?)\s*(?:il\s+)?(\d{1,2}[\s\/\.](?:[a-z]+|\d{2})[\s\/\.]?\d{0,4})/i);
        if (etaM) etaRaw = parseDataIT(etaM[1].trim());
    }

    // Usa l'ETA dalla direct API se Puppeteer non ne ha trovata una
    if (!etaRaw && partialEta) etaRaw = partialEta;

    if (process.env.DEBUG) {
        console.log(`  [pageText excerpt] ${t.slice(0, 300)}`);
    }

    console.log(`  [result] status=${status} eta=${etaRaw} deliveredAt=${deliveredAt} (${captured.length} API)`);
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
        const etaOk      = etaDate && !isNaN(etaDate);
        const etaPassed  = etaOk && etaDate < now;
        // Consegnato solo se Shippeo (o il testo pagina) conferma esplicitamente
        const isConsegnato = statoMapped === 'consegnato';

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
            // Aggiorna data_consegna_prevista nelle righe prodotto
            if (consegnaDate) {
                const deliveryDateStr = consegnaDate.split('T')[0];
                const { data: ordRow } = await supabase
                    .from('ordini').select('id')
                    .eq('numero_ordine', ddt.numero_ordine)
                    .single();
                if (ordRow?.id) {
                    await supabase.from('righe_ordine')
                        .update({ data_consegna_prevista: deliveryDateStr })
                        .eq('ordine_id', ordRow.id);
                    console.log(`  ✓ Righe ordine aggiornate`);
                }
            }
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
