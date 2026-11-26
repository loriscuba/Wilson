-- Migration 013: fatturato stimato del mese includendo parte dell'"ordinato oltre mese".
--
-- Problema: il PDF "Avanzamento fatturati giornalieri" (tabella budget) mette in
-- ordinato_oltre_mese gli ordini con data consegna prevista nel mese successivo,
-- e li esclude da evaso_ordinato_resi. A fine mese però molti di questi ordini
-- (es. ordini del 24-25/11 con consegna 1/12) vengono spediti e fatturati nel
-- mese corrente.
--
-- Regola (analisi 2026-11-26 su righe_ordine.data_consegna_prevista vs ddt.data_ddt,
-- maggio-ottobre 2026):
--   * consegna al 1°-2° giorno lavorativo del mese dopo → >90% spedito nel mese
--   * 3° giorno lavorativo → circa metà
--   * dal 4° giorno in poi → quasi sempre mese successivo
-- Quindi: conta nel mese corrente le consegne fino all'N-esimo giorno lavorativo
-- del mese successivo, con N = impostazioni_app 'oltre_mese_soglia_gg_lavorativi'
-- (default 2, modificabile da Impostazioni nella webapp).
--
-- Calcolo: la quota di oltre mese stimata come fatturato del mese è
--   ordinato_oltre_mese (PDF) × (importo righe d'ordine non ancora spedite con
--   consegna entro la soglia / importo di tutte le righe non spedite con consegna
--   nel mese successivo).
-- Gli importi in euro restano quelli del PDF; gli ordini a DB servono solo a
-- stimare quale parte cade entro la soglia. Il dato ufficiale resta separato.
--
-- Esegui nel SQL editor di Supabase (come service role / owner).

-- ── Impostazioni applicazione (chiave/valore) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS impostazioni_app (
  chiave      TEXT PRIMARY KEY,
  valore      JSONB       NOT NULL,
  descrizione TEXT,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- RLS: solo Loris autenticato (nessun accesso anon)
ALTER TABLE impostazioni_app ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_only" ON impostazioni_app;
CREATE POLICY "owner_only" ON impostazioni_app
  FOR ALL TO authenticated
  USING (auth.email() = 'loriscuba@gmail.com')
  WITH CHECK (auth.email() = 'loriscuba@gmail.com');

INSERT INTO impostazioni_app (chiave, valore, descrizione) VALUES
  ('oltre_mese_soglia_gg_lavorativi', '2'::jsonb,
   'Ordini con consegna prevista entro questo giorno lavorativo del mese successivo contano come fatturato del mese corrente')
ON CONFLICT (chiave) DO NOTHING;

-- ── N-esimo giorno lavorativo di un mese ──────────────────────────────────────
-- Esclude sabato, domenica e festività nazionali fisse (Pasquetta esclusa:
-- cade sempre in marzo/aprile, irrilevante per i primi giorni del mese salvo aprile).
CREATE OR REPLACE FUNCTION giorno_lavorativo_n(p_inizio_mese DATE, p_n INT)
RETURNS DATE
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT d::date
  FROM generate_series(date_trunc('month', p_inizio_mese),
                       date_trunc('month', p_inizio_mese) + interval '1 month' - interval '1 day',
                       interval '1 day') AS g(d)
  WHERE EXTRACT(ISODOW FROM d) < 6
    AND to_char(d, 'MM-DD') NOT IN ('01-01','01-06','04-25','05-01','06-02',
                                    '08-15','11-01','12-08','12-25','12-26')
  ORDER BY d
  OFFSET GREATEST(p_n, 1) - 1
  LIMIT 1
$$;

-- ── View: fatturato del mese ufficiale (PDF) e stimato ────────────────────────
DROP VIEW IF EXISTS v_oltre_mese_stimato;
CREATE VIEW v_oltre_mese_stimato
WITH (security_invoker = on) AS
WITH pdf AS (
  -- ultimo PDF avanzamento con dati del mese
  SELECT b.data_aggiornamento, b.evaso, b.ordinato_nel_mese, b.ordinato_oltre_mese,
         b.resi, b.evaso_ordinato_resi, b.budget_mese
  FROM budget b
  WHERE b.data_aggiornamento <= current_date
    AND b.budget_mese IS NOT NULL
  ORDER BY b.data_aggiornamento DESC
  LIMIT 1
),
par AS (
  SELECT
    p.*,
    COALESCE((SELECT (valore #>> '{}')::int FROM impostazioni_app
              WHERE chiave = 'oltre_mese_soglia_gg_lavorativi'), 2) AS soglia_gg,
    (date_trunc('month', p.data_aggiornamento) + interval '1 month')::date AS inizio_mese_succ
  FROM pdf p
),
par2 AS (
  SELECT par.*,
         CASE WHEN par.soglia_gg <= 0
              THEN par.inizio_mese_succ - 1          -- 0 = non includere l'oltre mese
              ELSE giorno_lavorativo_n(par.inizio_mese_succ, par.soglia_gg)
         END AS data_soglia
  FROM par
),
righe AS (
  -- righe d'ordine con consegna nel mese successivo, non ancora spedite
  -- (nessun DDT dello stesso ordine con lo stesso articolo)
  SELECT ro.importo_eur, ro.data_consegna_prevista
  FROM par2
  JOIN ordini o        ON o.data_ordine <= par2.data_aggiornamento
                      AND o.data_ordine >= par2.inizio_mese_succ - interval '3 months'
  JOIN righe_ordine ro ON ro.ordine_id = o.id
  WHERE ro.data_consegna_prevista >= par2.inizio_mese_succ
    AND ro.data_consegna_prevista <  par2.inizio_mese_succ + interval '1 month'
    AND NOT EXISTS (
      SELECT 1
      FROM ddt d
      JOIN righe_ddt rd ON rd.ddt_id = d.id
      WHERE d.numero_ordine = o.numero_ordine
        AND ltrim(rd.codice_articolo, '0') = ltrim(ro.codice_articolo, '0')
    )
),
agg AS (
  SELECT
    COALESCE(SUM(r.importo_eur) FILTER (WHERE r.data_consegna_prevista <= p.data_soglia), 0) AS ordini_entro_soglia,
    COALESCE(SUM(r.importo_eur) FILTER (WHERE r.data_consegna_prevista >  p.data_soglia), 0) AS ordini_oltre_soglia
  FROM par2 p
  LEFT JOIN righe r ON true
)
SELECT
  p.data_aggiornamento,
  p.budget_mese,
  p.evaso_ordinato_resi                         AS fatturato_ufficiale,
  p.ordinato_oltre_mese                         AS oltre_mese_pdf,
  p.soglia_gg,
  p.data_soglia,
  ROUND(a.ordini_entro_soglia, 2)               AS ordini_entro_soglia,
  ROUND(a.ordini_oltre_soglia, 2)               AS ordini_oltre_soglia,
  CASE WHEN a.ordini_entro_soglia + a.ordini_oltre_soglia > 0
       THEN ROUND(a.ordini_entro_soglia / (a.ordini_entro_soglia + a.ordini_oltre_soglia), 4)
  END                                           AS quota_entro_soglia,
  ROUND(COALESCE(p.ordinato_oltre_mese, 0) *
        CASE WHEN a.ordini_entro_soglia + a.ordini_oltre_soglia > 0
             THEN a.ordini_entro_soglia / (a.ordini_entro_soglia + a.ordini_oltre_soglia)
             ELSE 0 END, 2)                     AS oltre_mese_nel_mese,
  ROUND(COALESCE(p.evaso_ordinato_resi, 0) + COALESCE(p.ordinato_oltre_mese, 0) *
        CASE WHEN a.ordini_entro_soglia + a.ordini_oltre_soglia > 0
             THEN a.ordini_entro_soglia / (a.ordini_entro_soglia + a.ordini_oltre_soglia)
             ELSE 0 END, 2)                     AS fatturato_stimato
FROM par2 p
CROSS JOIN agg a;

GRANT SELECT ON v_oltre_mese_stimato TO authenticated;
