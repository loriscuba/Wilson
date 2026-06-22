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

// Usa le API Shippeo senza browser solo per recuperare l'ETA.
// NON conferma mai la consegna: 'deliveryCompliant' può riferirsi a stop
// intermedi (hub, carico) e non alla consegna finale al cliente.
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
            const eta = findField(body, ['estimateddelivery','estimatedarrival','eta','planned']) ||
                        etaDaStops(body?.stops) || etaDaStops(body?.order?.stops);
            if (eta) {
                console.log(`  [direct-api] eta=${eta}`);
                return { _partial: true, etaRaw: eta };
            }
        } catch (_) {}
    }
    return null;
}

function _htmlText(s) {
    return (s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<')
        .replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&#39;/g,"'")
        .replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
}

function parseFercamHtml(html) {
    const result = {
        numero_spedizione: null,
        destinatario: null,
        colli: null, peso_kg: null, volume_mc: null,
        servizio: null, data_spedizione: null,
        note: null, eventi: [],
        fetched_at: new Date().toISOString(),
    };

    // Shipment number: from page title/heading (e.g. "Shipment O2602453234")
    // or from hidden input, or generic letter+digits pattern
    const numM = html.match(/Shipment\s+([A-Z]\d{6,12})/i)
              || html.match(/Spediz[^:\n<]{0,30}:\s*([A-Z]\d{7,12})/i)
              || html.match(/\b([A-Z]\d{9,12})\b/);
    if (numM) result.numero_spedizione = numM[1];

    // Field extractor: finds label keyword then captures the next div value
    function _field(re) {
        const m = html.match(re);
        return m ? _htmlText(m[1]) : null;
    }

    // Packages / Colli
    const colliVal = _field(/Packages?[\s\S]{0,300}?<div[^>]*>\s*(\d+)\s*<\/div>/i)
                  || _field(/Colli[\s\S]{0,300}?<div[^>]*>\s*(\d+)\s*<\/div>/i);
    if (colliVal) result.colli = parseInt(colliVal);

    // Weight / Peso (value without unit suffix)
    const pesoVal = _field(/Weight[\s\S]{0,300}?<div[^>]*>\s*([\d.,]+)\s*<\/div>/i)
                 || _field(/Peso[\s\S]{0,300}?<div[^>]*>\s*([\d.,]+)\s*(?:kg)?\s*<\/div>/i);
    if (pesoVal) result.peso_kg = parseFloat(pesoVal.replace(',', '.'));

    // Cubic metres / Volume
    const volVal = _field(/Cubic\s+metres[\s\S]{0,300}?<div[^>]*>\s*([\d.,]+)\s*<\/div>/i)
                || _field(/Volume[\s\S]{0,300}?<div[^>]*>\s*([\d.,]+)\s*(?:mc)?\s*<\/div>/i);
    if (volVal) result.volume_mc = parseFloat(volVal.replace(',', '.'));

    // Service / Servizio
    const servVal = _field(/Service[\s\S]{0,300}?<div[^>]*>\s*([A-Z][A-Z\s]{2,40}?)\s*<\/div>/i)
                 || _field(/Servizio[\s\S]{0,300}?<div[^>]*>\s*([A-ZÀÈÌÒÙ][A-ZÀÈÌÒÙ\s]{2,40}?)\s*<\/div>/i);
    if (servVal) result.servizio = servVal.trim();

    // Shipment date (DD/MM/YYYY)
    const dataM = html.match(/for="Shipment_Data"[\s\S]{0,300}?<div[^>]*>\s*(\d{2}\/\d{2}\/\d{4})\s*<\/div>/i)
               || html.match(/Data[\s\S]{0,100}?<div[^>]*>\s*(\d{2}\/\d{2}\/\d{4})\s*<\/div>/i);
    if (dataM) {
        const [d2, m2, y2] = dataM[1].split('/');
        result.data_spedizione = `${y2}-${m2}-${d2}`;
    }

    // Timeline events from <span class="time"> + <span class="descMov"> structure.
    // Time format is DD/MM/YYYY H:MM:SS AM/PM (12h), events are server-rendered.
    const timelineRe = /<span\s+class="time">\s*([\d\/]+)\s+([\d:]+)\s*(AM|PM)?\s*<\/span>([\s\S]*?)<span\s+class="descMov">([\s\S]*?)<\/span>([\s\S]{0,400}?)<\/div>/gi;
    let m;
    while ((m = timelineRe.exec(html)) !== null) {
        const dateStr = m[1].trim();
        const timeStr = m[2].trim();
        const ampm    = (m[3] || '').trim().toUpperCase();
        const desc    = _htmlText(m[5]);
        // Include destination branch if present
        const branchM = m[6].match(/destination_branch[^>]*>([\s\S]*?)<\/span>/i);
        const branch  = branchM ? _htmlText(branchM[1]) : null;
        const fullDesc = branch ? `${desc} — ${branch}` : desc;

        // Convert 12h → 24h
        const tp = timeStr.split(':');
        let hh = parseInt(tp[0]);
        const min = tp[1] || '00';
        if (ampm === 'PM' && hh !== 12) hh += 12;
        if (ampm === 'AM' && hh === 12) hh = 0;
        const displayTime = `${String(hh).padStart(2, '0')}:${min}`;

        if (fullDesc.length >= 2)
            result.eventi.push({ data: dateStr, ora: displayTime, descrizione: fullDesc.substring(0, 250) });
    }

    // Fallback: text-based parsing for older/different Fercam page formats
    if (!result.eventi.length) {
        const clean = html
            .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:tr|p|div|li|h[1-6])\s*>/gi, '\n')
            .replace(/<\/td\s*>/gi, '\t').replace(/<[^>]+>/g, '')
            .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
            .replace(/&nbsp;/g,' ').replace(/&#39;/g,"'").replace(/&quot;/g,'"');
        const lines = clean.split('\n').map(l => l.replace(/\s+/g,' ').trim()).filter(Boolean);
        const text  = lines.join('\n');
        const evtRe = /(\d{2}\/\d{2}(?:\/\d{4})?)\s+(?:ore\s+)?(\d{1,2}:\d{2})\s*[-–]?\s*([^\n\d]{3,200})/g;
        let em;
        while ((em = evtRe.exec(text)) !== null) {
            const desc = em[3].replace(/\s+/g,' ').trim();
            if (desc.length >= 3) result.eventi.push({ data: em[1], ora: em[2], descrizione: desc.substring(0,200) });
        }
        for (const line of lines) {
            const parts = line.split('\t').map(p => p.trim()).filter(Boolean);
            if (parts.length >= 3 && /^\d{2}\/\d{2}/.test(parts[0]) && /^\d{1,2}:\d{2}$/.test(parts[1]))
                result.eventi.push({ data: parts[0], ora: parts[1], descrizione: parts.slice(2).join(' ').substring(0,200) });
        }
    }

    return result;
}

async function fetchFercamData(url) {
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html' },
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) { console.log(`  [fercam-fetch] HTTP ${res.status}`); return null; }
        const html = await res.text();
        return parseFercamHtml(html);
    } catch (e) {
        console.log(`  [fercam-fetch] ${e.message}`);
        return null;
    }
}

async function getShippeoData(rawUrl, { needFercamUrl = false, needFedexData = false } = {}) {
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
    let _fercamFromNetwork = null;

    // Intercetta URL di richiesta dirette a fercam.com
    page.on('request', req => {
        if (/fercam\.com/i.test(req.url()) && !_fercamFromNetwork)
            _fercamFromNetwork = req.url();
    });

    page.on('response', async res => {
        const url = res.url();
        // Risposta proveniente da fercam.com → salva l'URL
        if (/fercam\.com/i.test(url) && !_fercamFromNetwork)
            _fercamFromNetwork = url;
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

    // Estrae il primo URL fercam.com dall'HTML o JSON fornito
    function _extractFercamUrl(text) {
        if (!text) return null;
        // Con protocollo
        let m = text.match(/https?:\/\/[^\s"'`<>\\,)]*fercam\.com[^\s"'`<>\\,)]*/i);
        if (m) return m[0];
        // Senza protocollo: //tracktrace.fercam.com/...
        m = text.match(/\/\/[^\s"'`<>\\,)]*fercam\.com[^\s"'`<>\\,)]*/i);
        if (m) return 'https:' + m[0];
        // Solo dominio+path: tracktrace.fercam.com/...
        m = text.match(/tracktrace\.fercam\.com\/[^\s"'`<>\\,)]*/i);
        if (m) return 'https://' + m[0];
        return null;
    }

    function _extractTntUrl(text) {
        if (!text) return null;
        const m = text.match(/https?:\/\/[^\s"'`<>\\,)]*tnt\.it\/tracking[^\s"'`<>\\,)]*/i);
        if (m) return decodeURIComponent(m[0]).includes('?') ? m[0] : m[0];
        return null;
    }

    // Visita goods page per estrarre link Fercam (solo se richiesto)
    let fercamUrl = null;
    if (needFercamUrl && token) {
        // 1. Intercettazione di rete (richiesta diretta a fercam.com durante overview)
        if (_fercamFromNetwork) { fercamUrl = _fercamFromNetwork; console.log(`  [fercam-net] ${fercamUrl}`); }

        // 2. Cerca nelle risposte JSON catturate finora (overview page)
        if (!fercamUrl) {
            for (const { body } of captured) {
                const found = _extractFercamUrl(JSON.stringify(body));
                if (found) { fercamUrl = found; console.log(`  [fercam-json] ${fercamUrl}`); break; }
            }
        }

        // 3. HTML completo della pagina overview già caricata
        if (!fercamUrl) {
            const html = await page.content().catch(() => '');
            fercamUrl = _extractFercamUrl(html);
            if (fercamUrl) console.log(`  [fercam-overview-html] ${fercamUrl}`);
        }

        // 4. Visita la goods page e poi documents; aspetta il JS
        if (!fercamUrl) {
            const tabs = [
                `https://view.shippeo.com/road/orderPublic/${token}/goods`,
                `https://view.shippeo.com/road/orderPublic/${token}/documents`,
            ];
            for (const tabUrl of tabs) {
                if (fercamUrl) break;
                try {
                    await page.goto(tabUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                } catch (_) {}
                await new Promise(r => setTimeout(r, 8000));

                // 4a. Intercettazione di rete aggiornata
                if (_fercamFromNetwork) { fercamUrl = _fercamFromNetwork; console.log(`  [fercam-net-tab] ${fercamUrl}`); break; }

                // 4b. Nuove risposte JSON catturate
                for (const { body } of captured) {
                    const found = _extractFercamUrl(JSON.stringify(body));
                    if (found) { fercamUrl = found; console.log(`  [fercam-json-tab] ${fercamUrl} (${tabUrl})`); break; }
                }
                if (fercamUrl) break;

                // 4c. HTML completo della tab
                const tabHtml = await page.content().catch(() => '');
                fercamUrl = _extractFercamUrl(tabHtml);
                if (fercamUrl) { console.log(`  [fercam-html-tab] ${fercamUrl} (${tabUrl})`); break; }

                // 4d. Attributi DOM (data-href, src, onclick, etc.)
                fercamUrl = await page.evaluate(() => {
                    const all = document.querySelectorAll('*');
                    for (const el of all) {
                        for (const attr of el.attributes) {
                            if (/fercam\.com/i.test(attr.value)) return attr.value;
                        }
                        if (/fercam\.com/i.test(el.textContent || '')) {
                            const m = (el.textContent || '').match(/https?:\/\/[^\s"'`<>\\,)]*fercam\.com[^\s"'`<>\\,)]*/i);
                            if (m) return m[0];
                        }
                    }
                    return null;
                }).catch(() => null);
                if (fercamUrl) { console.log(`  [fercam-dom-tab] ${fercamUrl} (${tabUrl})`); break; }

                console.log(`  [fercam] nessun link su ${tabUrl}`);
            }
        }

        if (!fercamUrl) console.log(`  [fercam] link non trovato`);
    }

    // Per FedEx: visita goods page per catturare dati Shippeo e link TNT
    let tntUrl = null;
    if (needFedexData && !needFercamUrl && token) {
        const tabs = [
            `https://view.shippeo.com/road/orderPublic/${token}/goods`,
            `https://view.shippeo.com/road/orderPublic/${token}/documents`,
        ];
        for (const tabUrl of tabs) {
            if (tntUrl) break;
            try {
                await page.goto(tabUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            } catch (_) {}
            await new Promise(r => setTimeout(r, 8000));
            console.log(`  [fedex] visitata ${tabUrl}`);

            // 1. Cerca nelle risposte JSON catturate
            for (const { body } of captured) {
                const found = _extractTntUrl(JSON.stringify(body));
                if (found) { tntUrl = found; console.log(`  [tnt-json] ${tntUrl}`); break; }
            }
            if (tntUrl) break;

            // 2. HTML completo della pagina
            const tabHtml = await page.content().catch(() => '');
            tntUrl = _extractTntUrl(tabHtml);
            if (tntUrl) { console.log(`  [tnt-html] ${tntUrl}`); break; }

            // 3. Attributi DOM (href, data-href, onclick, ecc.)
            tntUrl = await page.evaluate(() => {
                for (const el of document.querySelectorAll('*')) {
                    for (const attr of el.attributes) {
                        if (/tnt\.it\/tracking/i.test(attr.value)) return attr.value;
                    }
                    const m = (el.textContent || '').match(/https?:\/\/[^\s"'`<>\\,)]*tnt\.it\/tracking[^\s"'`<>\\,)]*/i);
                    if (m) return m[0];
                }
                return null;
            }).catch(() => null);
            if (tntUrl) { console.log(`  [tnt-dom] ${tntUrl}`); break; }

            console.log(`  [tnt] nessun link su ${tabUrl}`);
        }
        if (!tntUrl) console.log(`  [tnt] link non trovato`);
    }

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

    // Non usiamo deliveredAt dalle API catturate per forzare lo status:
    // può venire da stop intermedi. Solo il testo pagina è affidabile.

    // Analisi testo pagina: sempre eseguita
    const t  = pageText;
    const tl = t.toLowerCase();
    const alreadyDelivery = status && status.toLowerCase().startsWith('delivery');

    if (!alreadyDelivery) {
        // Cerca "Consegnato DD/MM/YYYY • HH:MM" con orario NON 00:00
        // (00:00 = orario pianificato/slot, non consegna effettiva; gli hub usano lo stesso label)
        const consM = t.match(/consegnat\w{0,3}\s+(?:il\s+)?(\d{1,2}[\s\/\.](?:[a-z]+|\d{2})[\s\/\.]?\d{0,4})\s*[•·]?\s*(\d{2}:\d{2})/i);
        if (consM && consM[2] !== '00:00') {
            status = 'deliveryCompliant';
            // La data dal testo pagina sovrascrive sempre quella API (che può venire da stop sbagliato)
            deliveredAt = parseDataIT(consM[1].trim());
        } else if (tl.includes('delivery compliant')) {
            // Label Shippeo esplicita nella pagina (es. status chip)
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

    // Estrai dati Shippeo goods per FedEx (disponibili dopo visita goods page)
    let shippeoOrders = null, shippeoOverview = null, shippeoGoods = null;
    if (needFedexData) {
        // Log tutte le URL JSON catturate per debug
        if (captured.length) {
            console.log(`  [fedex-api] ${captured.length} risposte JSON: ${captured.map(c => c.url.replace(/^https?:\/\/[^/]+/, '').substring(0, 80)).join(' | ')}`);
        } else {
            console.log(`  [fedex-api] nessuna risposta JSON catturata`);
        }
        // Pattern flessibili: matchano varianti URL Shippeo
        shippeoOrders   = captured.find(c => /[/]orders[/?&]|[/]orders$/.test(c.url) && !c.body?.errors && !c.body?.error)?.body || null;
        shippeoOverview = captured.find(c => /order[/.]overview|[/]overview[/?&]|[/]overview$/.test(c.url) && !c.body?.errors && !c.body?.error)?.body || null;
        shippeoGoods    = captured.find(c => /order[/.]goods|[/]goods[/?&]|[/]goods$/.test(c.url) && !c.body?.errors && !c.body?.error && c.body !== shippeoOverview)?.body || null;

        // Fallback: cerca qualsiasi JSON con struttura stops/order (dati overview caricati durante navigazione)
        if (!shippeoOverview) {
            const orderLike = captured.find(c =>
                !c.body?.errors && !c.body?.error &&
                (c.body?.stops || c.body?.order?.stops || c.body?.data?.stops ||
                 c.body?.currentStatus || c.body?.status?.currentStatus)
            );
            if (orderLike) {
                shippeoOverview = orderLike.body?.order ?? orderLike.body?.data ?? orderLike.body;
                console.log(`  [fedex-api] overview da fallback: ${orderLike.url.replace(/^https?:\/\/[^/]+/, '').substring(0, 80)}`);
            }
        }
    }

    return { status, etaRaw, deliveredAt, fercamUrl, tntUrl, shippeoOrders, shippeoOverview, shippeoGoods };
}

function parseShippeoGoodsFedex(orders, overview, goods) {
    const result = {
        destinatario: null, citta_consegna: null,
        partenza: null, citta_partenza: null,
        eta: null, stato: null,
        eventi: [], fetched_at: new Date().toISOString(),
    };

    // Normalizza overview: l'API Shippeo può restituire { order: {...} } o { data: {...} } o direttamente i dati
    if (overview) {
        if (overview.order && (overview.order.stops || overview.order.status)) overview = overview.order;
        else if (overview.data && (overview.data.stops || overview.data.status)) overview = overview.data;
    }

    if (overview) {
        result.stato = overview.status?.currentStatus || overview.currentStatus || null;
        const dest = (overview.stops || []).find(s => s.stopType === 'delivery');
        const orig = (overview.stops || []).find(s => s.stopType === 'loading');
        if (dest) {
            const a = dest.place?.shippeoPlace?.address;
            if (a) {
                result.destinatario  = a.name || null;
                result.citta_consegna = a.town ? `${a.town}${a.postalCode ? ' (' + a.postalCode + ')' : ''}` : null;
            }
            const etaIso = dest.dates?.plannedArrivalStartDate || dest.dates?.plannedArrivalEndDate;
            if (etaIso) result.eta = etaIso.substring(0, 10);
        }
        if (orig) {
            const a = orig.place?.shippeoPlace?.address;
            result.partenza      = a?.name || null;
            result.citta_partenza = a?.town || null;
        }
    }

    // Aggiungi eventi dalla goods page (collo ritirato, ecc.)
    for (const hu of goods?.handlingUnits || []) {
        for (const ev of hu.events || []) {
            if (!ev.dates?.occurredOn) continue;
            const dt = new Date(ev.dates.occurredOn);
            result.eventi.push({
                data: `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`,
                ora:  `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`,
                tipo: ev.type,
            });
        }
    }

    // Aggiungi eventi dalla timeline ordine (ORDER_CONFIRMED, ecc.)
    for (const stage of orders?.timeline || []) {
        for (const ev of stage.events || []) {
            if (!ev.dateEvent || !ev.type) continue;
            const dt = new Date(ev.dateEvent);
            const data = `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`;
            const ora  = `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
            if (!result.eventi.some(e => e.data === data && e.ora === ora && e.tipo === ev.type))
                result.eventi.push({ data, ora, tipo: ev.type });
        }
    }

    // Ordina dal più recente al meno recente
    result.eventi.sort((a, b) => {
        const ka = a.data.split('/').reverse().join('-') + 'T' + a.ora;
        const kb = b.data.split('/').reverse().join('-') + 'T' + b.ora;
        return kb.localeCompare(ka);
    });

    return result;
}

async function main() {
    // --force NUMERO_CONSEGNA[,NUMERO2,...] → re-processa DDT specifici ignorando lo stato
    const forceArg = process.argv.find(a => a.startsWith('--force'));
    const forceCodes = forceArg
        ? forceArg.replace('--force=', '').replace('--force', '').split(',').map(s => s.trim()).filter(Boolean)
        : [];
    // --fercam-only → processa solo DDT Fercam senza fercam_url
    const fercamOnly = process.argv.includes('--fercam-only');
    // --month[=YYYY-MM] → re-processa tutti i DDT del mese (default: mese corrente)
    const monthArg = process.argv.find(a => a.startsWith('--month'));
    let monthFilter = null;
    if (monthArg !== undefined) {
        const val = monthArg.includes('=') ? monthArg.split('=')[1].trim() : null;
        if (val && /^\d{4}-\d{2}$/.test(val)) {
            monthFilter = val;
        } else {
            const now = new Date();
            monthFilter = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        }
    }

    let query = supabase
        .from('ddt')
        .select('id, numero_ddt, numero_ordine, numero_consegna, shippeo_url, stato, corriere, segnacollo, fercam_url, fercam_dati, tnt_url, tnt_dati')
        .not('shippeo_url', 'is', null);

    if (forceCodes.length) {
        query = query.in('numero_consegna', forceCodes);
    } else if (monthFilter) {
        // Tutti i DDT del mese con shippeo_url, indipendentemente dallo stato
        const [y, m] = monthFilter.split('-').map(Number);
        const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
        query = query.gte('data_ddt', `${monthFilter}-01`).lt('data_ddt', `${nextMonth}-01`);
    } else if (fercamOnly) {
        query = query.ilike('corriere', '%fercam%').is('fercam_url', null);
    } else {
        // Processa DDT non consegnati + Fercam senza URL/dati + FedEx/TNT senza dati
        query = query.or('stato.neq.consegnato,and(corriere.ilike.%fercam%,fercam_url.is.null),and(corriere.ilike.%fercam%,fercam_dati.is.null),and(corriere.ilike.%fedex%,tnt_dati.is.null),and(corriere.ilike.%tnt%,tnt_dati.is.null)');
    }

    const { data: ddts, error } = await query;

    if (error) { console.error('Errore Supabase:', error); process.exit(1); }
    if (!ddts?.length) { console.log('Nessun DDT trovato.'); return; }

    if (forceCodes.length) console.log(`Modalità --force: ${forceCodes.join(', ')}\n`);
    else if (monthFilter) console.log(`Modalità --month: tutti i DDT di ${monthFilter}\n`);
    else if (fercamOnly) console.log(`Modalità --fercam-only: solo Fercam senza URL\n`);
    console.log(`DDT da verificare: ${ddts.length}\n`);

    for (const ddt of ddts) {
        console.log(`DDT ${ddt.numero_ddt} | Ordine ${ddt.numero_ordine}`);

        const isFercam   = ddt.corriere?.trim() === 'DACHSER & FERCAM ITALIA S.R.L.';
        const corrU      = ddt.corriere?.toUpperCase() || '';
        const isFedex    = corrU.includes('FEDEX') || corrU.includes('TNT');
        const needFercamUrl  = isFercam && !ddt.fercam_url;
        // needFercamData: anche quando fercam_url esiste ma fercam_dati è assente o senza eventi
        const needFercamData = isFercam && ddt.fercam_url && (!ddt.fercam_dati || !ddt.fercam_dati.numero_spedizione);
        const needFedexData  = isFedex  && (!ddt.tnt_dati || !ddt.tnt_dati.destinatario);

        const { status, etaRaw, deliveredAt, fercamUrl, tntUrl,
                shippeoOrders, shippeoOverview, shippeoGoods } =
            await getShippeoData(ddt.shippeo_url, { needFercamUrl, needFedexData });
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

        // Fercam: scopri URL (goods page) o aggiorna dati se già noto o mancante
        const activeFercamUrl = fercamUrl || (isFercam ? ddt.fercam_url : null);
        if (activeFercamUrl) {
            update.fercam_url = activeFercamUrl;
            // Rifetch se: url appena trovato, dati mancanti o senza numero_spedizione
            if (fercamUrl || needFercamData) {
                console.log(`  [fercam] aggiornamento dati...`);
                const fercamDati = await fetchFercamData(activeFercamUrl);
                if (fercamDati) {
                    update.fercam_dati = fercamDati;
                    console.log(`  ✓ Fercam: ${fercamDati.numero_spedizione || '?'} · ${fercamDati.eventi?.length || 0} eventi`);
                } else {
                    console.log(`  [fercam] fetch dati fallito, URL salvato per retry`);
                }
            }
        }

        // FedEx: salva URL TNT (da pagina Shippeo o costruito da segnacollo) + dati goods
        if (isFedex) {
            if (tntUrl) {
                // URL estratto dalla goods page (formato ?pp=... da Shippeo) → preferito
                if (!ddt.tnt_url || ddt.tnt_url !== tntUrl) {
                    update.tnt_url = tntUrl;
                    console.log(`  [tnt] url aggiornato: ${tntUrl}`);
                }
            } else if (!ddt.tnt_url) {
                // Fallback: URL costruito dal segnacollo (formato ?con=...)
                const tntNum = ddt.segnacollo?.match(/^(\d+)/)?.[1];
                if (tntNum) update.tnt_url = `https://www.tnt.it/tracking/index.html?con=${tntNum}`;
            }
            if (shippeoOrders || shippeoOverview || shippeoGoods) {
                const tntDati = parseShippeoGoodsFedex(shippeoOrders, shippeoOverview, shippeoGoods);
                update.tnt_dati = tntDati;
                console.log(`  ✓ FedEx: ${tntDati.destinatario || '?'} · ETA ${tntDati.eta || '—'} · ${tntDati.eventi.length} eventi`);
            } else if (needFedexData) {
                // Fallback: salva tnt_dati con almeno ETA/status estratti dalla pagina
                update.tnt_dati = {
                    destinatario: null, citta_consegna: null,
                    partenza: null, citta_partenza: null,
                    eta: etaRaw ? etaRaw.substring(0, 10) : null,
                    stato: status || null,
                    eventi: [],
                    fetched_at: new Date().toISOString(),
                };
                console.log(`  [fedex] tnt_dati parziale (ETA: ${etaRaw || '—'}, status: ${status || '—'}) — goods API non catturate`);
            }
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
