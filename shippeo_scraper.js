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

function parseFercamHtml(html) {
    const clean = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:tr|p|div|li|h[1-6])\s*>/gi, '\n')
        .replace(/<\/td\s*>/gi, '\t')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"');

    const lines = clean.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const text  = lines.join('\n');

    const result = {
        numero_spedizione: null,
        destinatario: null,
        colli: null, peso_kg: null, volume_mc: null,
        servizio: null, data_spedizione: null,
        note: null, eventi: [],
        fetched_at: new Date().toISOString(),
    };

    const numM = text.match(/Spediz[^:\n]{0,30}:\s*([A-Z]\d{7,12})/i) || text.match(/\b([A-Z]\d{9,12})\b/);
    if (numM) result.numero_spedizione = numM[1];

    const colliM = text.match(/Colli\s*:?\s*(\d+)/i);
    if (colliM) result.colli = parseInt(colliM[1]);

    const pesoM = text.match(/Peso\s*:?\s*([\d,.]+)\s*kg/i);
    if (pesoM) result.peso_kg = parseFloat(pesoM[1].replace(',', '.'));

    const volM = text.match(/Volume\s*:?\s*([\d,.]+)\s*mc/i);
    if (volM) result.volume_mc = parseFloat(volM[1].replace(',', '.'));

    const servM = text.match(/Servizio\s*:?\s*([A-ZÀÈÌÒÙ][A-ZÀÈÌÒÙ\s]{2,30})(?=\n|Colli|Data|\d)/i);
    if (servM) result.servizio = servM[1].trim();

    const dataM = text.match(/Data\s+(?:di\s+)?[Ss]pedizione\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i)
               || text.match(/Data\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i);
    if (dataM) { const [d2,m2,y2]=dataM[1].split('/'); result.data_spedizione=`${y2}-${m2}-${d2}`; }

    // Destinatario: riga dopo la keyword
    const dstIdx = lines.findIndex(l => /destinatario/i.test(l));
    if (dstIdx >= 0) {
        const parts = lines[dstIdx].split(':');
        result.destinatario = (parts.length > 1 ? parts.slice(1).join(':').trim()
                               : lines[dstIdx + 1] || '').trim() || null;
    }

    const notaM = text.match(/"([A-ZÀÈÌÒÙ][^"]{5,200})"/);
    if (notaM) result.note = notaM[1].trim();

    // Tracking events: "DD/MM ore HH:MM - Desc" or "DD/MM/YYYY\tHH:MM\tDesc"
    const evtRe = /(\d{2}\/\d{2}(?:\/\d{4})?)\s+(?:ore\s+)?(\d{2}:\d{2})\s*[-–]?\s*([^\n\d]{3,200})/g;
    let m;
    while ((m = evtRe.exec(text)) !== null) {
        const desc = m[3].replace(/\s+/g, ' ').trim();
        if (desc.length >= 3) result.eventi.push({ data: m[1], ora: m[2], descrizione: desc.substring(0, 200) });
    }
    // Tab-separated table fallback
    if (!result.eventi.length) {
        for (const line of lines) {
            const parts = line.split('\t').map(p => p.trim()).filter(Boolean);
            if (parts.length >= 3 && /^\d{2}\/\d{2}/.test(parts[0]) && /^\d{2}:\d{2}$/.test(parts[1]))
                result.eventi.push({ data: parts[0], ora: parts[1], descrizione: parts.slice(2).join(' ').substring(0, 200) });
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

async function getShippeoData(rawUrl, { needFercamUrl = false } = {}) {
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
    return { status, etaRaw, deliveredAt, fercamUrl };
}

async function main() {
    // --force NUMERO_CONSEGNA[,NUMERO2,...] → re-processa DDT specifici ignorando lo stato
    const forceArg = process.argv.find(a => a.startsWith('--force'));
    const forceCodes = forceArg
        ? forceArg.replace('--force=', '').replace('--force', '').split(',').map(s => s.trim()).filter(Boolean)
        : [];
    // --fercam-only → processa solo DDT Fercam senza fercam_url
    const fercamOnly = process.argv.includes('--fercam-only');

    let query = supabase
        .from('ddt')
        .select('id, numero_ddt, numero_ordine, numero_consegna, shippeo_url, stato, corriere, fercam_url')
        .not('shippeo_url', 'is', null);

    if (forceCodes.length) {
        query = query.in('numero_consegna', forceCodes);
    } else if (fercamOnly) {
        query = query.ilike('corriere', '%fercam%').is('fercam_url', null);
    } else {
        // Processa DDT non consegnati + qualsiasi DDT Fercam senza URL (anche consegnati)
        query = query.or('stato.neq.consegnato,and(corriere.ilike.%fercam%,fercam_url.is.null)');
    }

    const { data: ddts, error } = await query;

    if (error) { console.error('Errore Supabase:', error); process.exit(1); }
    if (!ddts?.length) { console.log('Nessun DDT trovato.'); return; }

    if (forceCodes.length) console.log(`Modalità --force: ${forceCodes.join(', ')}\n`);
    else if (fercamOnly) console.log(`Modalità --fercam-only: solo Fercam senza URL\n`);
    console.log(`DDT da verificare: ${ddts.length}\n`);

    for (const ddt of ddts) {
        console.log(`DDT ${ddt.numero_ddt} | Ordine ${ddt.numero_ordine}`);

        const isFercam = ddt.corriere?.trim() === 'DACHSER & FERCAM ITALIA S.R.L.';
        const needFercamUrl = isFercam && !ddt.fercam_url;

        const { status, etaRaw, deliveredAt, fercamUrl } = await getShippeoData(ddt.shippeo_url, { needFercamUrl });
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

        // Fercam: scopri URL (goods page) o aggiorna dati se già noto
        const activeFercamUrl = fercamUrl || (isFercam ? ddt.fercam_url : null);
        if (activeFercamUrl) {
            // Salva sempre l'URL, anche se il fetch dei dati fallisce
            update.fercam_url = activeFercamUrl;
            console.log(`  [fercam] aggiornamento dati...`);
            const fercamDati = await fetchFercamData(activeFercamUrl);
            if (fercamDati) {
                update.fercam_dati = fercamDati;
                console.log(`  ✓ Fercam: ${fercamDati.numero_spedizione || '?'} · ${fercamDati.eventi?.length || 0} eventi`);
            } else {
                console.log(`  [fercam] fetch dati fallito, URL salvato per retry`);
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
