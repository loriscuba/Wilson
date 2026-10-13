-- Migration 010: schema "app-ticket" per l'app di lettura scontrini/fatture
-- (https://loriscuba.github.io/Wilson/app_ticket/).
--
-- Lo schema non va esposto alla Data API: il browser passa dalle funzioni RPC
-- in public (SECURITY DEFINER) che controllano l'email dell'utente loggato.
-- Le foto vanno nel bucket privato "app-ticket" dello Storage.
--
-- Esegui nel SQL editor di Supabase (come owner).

CREATE SCHEMA IF NOT EXISTS "app-ticket";

CREATE TABLE IF NOT EXISTS "app-ticket".ticket (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- campi della maschera "Immissione consuntivi"
  categoria          TEXT,                 -- Vitto, Alloggio, Carburante, ...
  data_registrazione DATE NOT NULL DEFAULT current_date,
  valuta             TEXT NOT NULL DEFAULT 'EUR',
  importo            NUMERIC(12,2),
  tipo_documento     TEXT,                 -- Fattura, Scontrino, Ricevuta
  pagamento          TEXT,                 -- Contanti, Carta di credito, ...
  data_pagamento     DATE,
  num_allegati       INT NOT NULL DEFAULT 1,
  -- sezione "Documento"
  numero_documento   TEXT,
  data_documento     DATE,
  descrizione        TEXT,                 -- ragione sociale dell'emittente
  partita_iva        TEXT,
  citta              TEXT,
  note               TEXT,                 -- di default la città
  -- tracciabilità
  foto_path          TEXT,                 -- percorso nel bucket "app-ticket"
  estrazione         JSONB,                -- risposta grezza del modello
  stato              TEXT NOT NULL DEFAULT 'da_inserire'  -- da_inserire | inserito
);

CREATE INDEX IF NOT EXISTS ticket_data_doc_idx ON "app-ticket".ticket (data_documento DESC);

ALTER TABLE "app-ticket".ticket ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA "app-ticket" FROM anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA "app-ticket" FROM anon, authenticated;

-- ── Accesso consentito solo a loriscuba@gmail.com ──────────────────────────
CREATE OR REPLACE FUNCTION "app-ticket".autorizzato() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT coalesce(auth.jwt() ->> 'email', '') = 'loriscuba@gmail.com'
$$;

-- Salva (insert se id assente, altrimenti update). Restituisce la riga.
CREATE OR REPLACE FUNCTION public.app_ticket_salva(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r "app-ticket".ticket;
BEGIN
  IF NOT "app-ticket".autorizzato() THEN
    RAISE EXCEPTION 'non autorizzato' USING ERRCODE = '42501';
  END IF;

  IF p ? 'id' AND nullif(p->>'id', '') IS NOT NULL THEN
    UPDATE "app-ticket".ticket t SET
      categoria          = p->>'categoria',
      data_registrazione = coalesce(nullif(p->>'data_registrazione','')::date, t.data_registrazione),
      valuta             = coalesce(nullif(p->>'valuta',''), 'EUR'),
      importo            = nullif(p->>'importo','')::numeric,
      tipo_documento     = p->>'tipo_documento',
      pagamento          = p->>'pagamento',
      data_pagamento     = nullif(p->>'data_pagamento','')::date,
      num_allegati       = coalesce(nullif(p->>'num_allegati','')::int, 1),
      numero_documento   = p->>'numero_documento',
      data_documento     = nullif(p->>'data_documento','')::date,
      descrizione        = p->>'descrizione',
      partita_iva        = p->>'partita_iva',
      citta              = p->>'citta',
      note               = p->>'note',
      foto_path          = coalesce(nullif(p->>'foto_path',''), t.foto_path),
      estrazione         = coalesce(p->'estrazione', t.estrazione),
      stato              = coalesce(nullif(p->>'stato',''), t.stato),
      updated_at         = now()
    WHERE t.id = (p->>'id')::bigint
    RETURNING * INTO r;
  ELSE
    INSERT INTO "app-ticket".ticket (
      categoria, data_registrazione, valuta, importo, tipo_documento, pagamento,
      data_pagamento, num_allegati, numero_documento, data_documento, descrizione,
      partita_iva, citta, note, foto_path, estrazione, stato
    ) VALUES (
      p->>'categoria',
      coalesce(nullif(p->>'data_registrazione','')::date, current_date),
      coalesce(nullif(p->>'valuta',''), 'EUR'),
      nullif(p->>'importo','')::numeric,
      p->>'tipo_documento',
      p->>'pagamento',
      nullif(p->>'data_pagamento','')::date,
      coalesce(nullif(p->>'num_allegati','')::int, 1),
      p->>'numero_documento',
      nullif(p->>'data_documento','')::date,
      p->>'descrizione',
      p->>'partita_iva',
      p->>'citta',
      p->>'note',
      nullif(p->>'foto_path',''),
      p->'estrazione',
      coalesce(nullif(p->>'stato',''), 'da_inserire')
    )
    RETURNING * INTO r;
  END IF;

  RETURN to_jsonb(r);
END $$;

CREATE OR REPLACE FUNCTION public.app_ticket_lista(p_limit INT DEFAULT 50)
RETURNS SETOF JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT "app-ticket".autorizzato() THEN
    RAISE EXCEPTION 'non autorizzato' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT to_jsonb(t) - 'estrazione'
      FROM "app-ticket".ticket t
     ORDER BY t.created_at DESC
     LIMIT p_limit;
END $$;

CREATE OR REPLACE FUNCTION public.app_ticket_elimina(p_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT "app-ticket".autorizzato() THEN
    RAISE EXCEPTION 'non autorizzato' USING ERRCODE = '42501';
  END IF;
  DELETE FROM "app-ticket".ticket WHERE id = p_id;
END $$;

REVOKE ALL ON FUNCTION public.app_ticket_salva(JSONB)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.app_ticket_lista(INT)    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.app_ticket_elimina(BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_ticket_salva(JSONB)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_ticket_lista(INT)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_ticket_elimina(BIGINT) TO authenticated;

-- ── Storage: bucket privato per le foto ───────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('app-ticket', 'app-ticket', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "app-ticket foto" ON storage.objects;
CREATE POLICY "app-ticket foto" ON storage.objects
  FOR ALL TO authenticated
  USING      (bucket_id = 'app-ticket' AND auth.jwt() ->> 'email' = 'loriscuba@gmail.com')
  WITH CHECK (bucket_id = 'app-ticket' AND auth.jwt() ->> 'email' = 'loriscuba@gmail.com');
