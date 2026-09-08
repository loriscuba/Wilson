// Supabase Edge Function: proxy verso Claude per il modulo "Note Visite".
// Tiene ANTHROPIC_API_KEY lato server — il browser non la vede mai.
// Deploy: supabase functions deploy nota-visita
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-sonnet-5";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function callClaude(prompt: string, maxTokens: number): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const textBlock = (data.content || []).find((c: { type: string }) => c.type === "text");
  return textBlock?.text?.trim() || "";
}

function promptGeneraNota(payload: {
  cliente: string;
  contatto: { nome: string; count: number; total: number } | null;
  recentNotes: string;
  historySummary: string;
  prodotti?: string;
  ordini?: string;
  step?: string;
}): string {
  const { cliente, contatto, recentNotes, historySummary, prodotti, ordini, step } = payload;

  const extra = [];
  if (prodotti) extra.push(`Prodotti/linee da includere oggi: ${prodotti}`);
  if (ordini) extra.push(`Ordini da includere oggi: ${ordini}`);
  if (step) extra.push(`Prossimi step da includere: ${step}`);
  const extraText = extra.length ? "\n" + extra.join("\n") : "";

  const historyContext = historySummary
    ? `\nRiassunto dello storico di questo cliente:\n${historySummary}\n`
    : recentNotes
    ? `\nUltime note storiche di questo cliente:\n${recentNotes}\n`
    : "\nNessuno storico disponibile per questo cliente.\n";

  return `Sei un tecnico commerciale Fischer Italia che visita rivendite (ferramenta, edilizia) come clienti B2B.
Devi scrivere la BOZZA della nota di fine visita per il cliente "${cliente}", da usare come punto di partenza da modificare dopo la visita vera.

Regole di stile, ricavale imitando il modo in cui questo venditore scrive di solito (vedi note storiche sotto):
- Inizia la frase con "Parlato con ${contatto ? contatto.nome : "[nome contatto]"}, " ${
    contatto
      ? `(è il nome più ricorrente nello storico di questo cliente, comparso in ${contatto.count} note su ${contatto.total})`
      : '(nessun nome ricorrente trovato nello storico: usa un segnaposto generico tipo "il referente" oppure ometti il nome se non hai info)'
  }.
- Prosegui con 2-4 brevi attività verosimili, in stile telegrafico come nelle note storiche (es. "proposta promo [prodotto]", "fatta formazione su [prodotto]", "portato calendario", "fatto ragionamento su gamma [X]"), scegliendo temi e prodotti che ricorrono davvero nello storico di questo cliente.
- Non inventare prodotti, promozioni o dettagli che non compaiono mai nello storico di questo cliente. Se lo storico è scarso, resta generico e breve.
- Testo totale: 2-4 righe, nessuna introduzione, solo il testo della nota.
${historyContext}${extraText}`;
}

function promptRiassumiStorico(payload: { cliente: string; visitsText: string }): string {
  return `Sei un tecnico commerciale Fischer Italia. Ecco le note delle ultime visite a una rivendita cliente (${payload.cliente}):
${payload.visitsText}

Scrivi un riassunto in italiano, 3-5 righe, utile a un venditore prima di una visita. Includi solo ciò che emerge davvero dalle note:
- prodotti/linee di interesse ricorrente
- eventuali obiezioni o criticità ricorrenti
- tono/stato della relazione commerciale
Non inventare nulla che non risulti dalle note. Nessuna introduzione, solo il testo del riassunto.`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (!ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY non configurata" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const { action } = body;

    let text: string;
    if (action === "genera_nota") {
      text = await callClaude(promptGeneraNota(body), 1000);
    } else if (action === "riassumi_storico") {
      text = await callClaude(promptRiassumiStorico(body), 1000);
    } else {
      return new Response(JSON.stringify({ error: `Azione sconosciuta: ${action}` }), {
        status: 400,
        headers: { ...CORS_HEADERS, "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ text }), {
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
    });
  }
});
