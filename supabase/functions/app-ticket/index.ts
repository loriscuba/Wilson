// Supabase Edge Function: lettura di scontrini/fatture per l'app "app_ticket".
// Riceve la foto (base64) e restituisce i campi della maschera
// "Immissione consuntivi" estratti da Claude (vision + structured output).
// Tiene ANTHROPIC_API_KEY lato server — il browser non la vede mai.
// Deploy: supabase functions deploy app-ticket
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...  (già presente per nota-visita)

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const MODEL = "claude-opus-5-5";
const ALLOWED_EMAIL = "loriscuba@gmail.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CATEGORIE = ["Vitto", "Alloggio", "Carburante", "Pedaggi", "Parcheggi", "Trasporti", "Altro"];
const TIPI_DOCUMENTO = ["Fattura", "Scontrino", "Ricevuta"];
const PAGAMENTI = ["Contanti", "Carta di credito", "Bancomat", "Altro"];

const nullable = (type: string) => ({ type: [type, "null"] });

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "categoria", "tipo_documento", "descrizione", "partita_iva", "numero_documento",
    "data_documento", "importo", "valuta", "pagamento", "citta", "indirizzo",
    "voci", "confidenza", "avvisi",
  ],
  properties: {
    categoria: { type: "string", enum: CATEGORIE },
    tipo_documento: { type: "string", enum: TIPI_DOCUMENTO },
    descrizione: { ...nullable("string"), description: "Ragione sociale dell'emittente" },
    partita_iva: nullable("string"),
    numero_documento: nullable("string"),
    data_documento: { ...nullable("string"), description: "Formato YYYY-MM-DD" },
    importo: { ...nullable("number"), description: "Totale pagato, IVA inclusa" },
    valuta: { type: "string", description: "Codice ISO 4217, es. EUR" },
    pagamento: { type: "string", enum: PAGAMENTI },
    citta: nullable("string"),
    indirizzo: nullable("string"),
    voci: { type: "array", items: { type: "string" }, description: "Righe principali del documento" },
    confidenza: { type: "string", enum: ["alta", "media", "bassa"] },
    avvisi: { type: "array", items: { type: "string" }, description: "Dubbi o campi illeggibili" },
  },
};

const PROMPT = `Questa è la foto di un documento di spesa italiano (scontrino, fattura o ricevuta) da registrare come nota spese.
Estrai i dati richiesti dallo schema:
- descrizione: ragione sociale dell'emittente (es. "Ristorante Da Mario S.r.l."), non il nome del cliente.
- categoria: "Vitto" se è un ristorante, bar, pizzeria, trattoria, mensa o se ci sono voci di menu/coperto/bevande; "Alloggio" per hotel/B&B; "Carburante" per distributori; "Pedaggi" per autostrade; "Parcheggi"; "Trasporti" per treni/taxi/aerei; altrimenti "Altro".
- tipo_documento: "Fattura" se c'è scritto fattura (anche "fattura semplificata" o dati del cliente/P.IVA del destinatario), "Scontrino" per documento commerciale/scontrino, "Ricevuta" altrimenti.
- importo: il TOTALE pagato (IVA inclusa), non subtotali o resto.
- pagamento: "Carta di credito" se compaiono pagamento elettronico/POS/carta/VISA/Mastercard/Amex, "Bancomat" se compare bancomat/PagoBancomat, "Contanti" se compare contanti/contante, altrimenti "Altro".
- citta: la città dell'emittente (dall'indirizzo del punto vendita), senza CAP né provincia.
- data_documento in formato YYYY-MM-DD.
Usa null per i dati che non trovi. Non inventare: se un dato è incerto, mettilo e aggiungi un avviso.`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

async function utenteAutorizzato(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization");
  if (!auth || !SUPABASE_URL || !SUPABASE_ANON_KEY) return false;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { authorization: auth, apikey: SUPABASE_ANON_KEY },
  });
  if (!res.ok) return false;
  const user = await res.json();
  return user?.email === ALLOWED_EMAIL;
}

async function leggiDocumento(image: string, mediaType: string) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "server-side-fallback-2026-07-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      fallbacks: "default",
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
          { type: "text", text: PROMPT },
        ],
      }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  if (data.stop_reason === "refusal") throw new Error("Il modello ha rifiutato la richiesta");
  if (data.stop_reason === "max_tokens") throw new Error("Risposta troncata");
  const textBlock = (data.content || []).find((c: { type: string }) => c.type === "text");
  if (!textBlock?.text) throw new Error("Risposta vuota dal modello");
  return JSON.parse(textBlock.text);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (!ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY non configurata" }, 500);
  if (!(await utenteAutorizzato(req))) return json({ error: "Non autorizzato" }, 401);

  try {
    const { image, media_type } = await req.json();
    if (!image) return json({ error: "Foto mancante" }, 400);
    const campi = await leggiDocumento(image, media_type || "image/jpeg");
    return json({ campi });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
