-- Migration 011: budget mensile 2026 e % di budget raggiunto per mese.
--
-- Fonte budget: file Fischer "Bdgt_mensilizzato_Cubaiu Loris.xlsx"
-- (Budget 2026, Sig. Cubaiu Loris, cod. 400542, Div. 11+72) – totale € 1.295.016,28.
--
-- Fonte fatturato: ultimo rolling_fatturato importato (stessa data_aggiornamento
-- per tutti i clienti), sommato su tutti i clienti.
--   * mesi chiusi (precedenti al mese del rolling) → somma gto_<mese>_2026
--   * mese del rolling → mese_consegnato (consolidato)
--                        spedito_ordinato_mese (consolidato + ordinato in corso)
--   * mesi futuri → nessun fatturato (NULL)
--
-- Esegui nel SQL editor di Supabase (come service role / owner).

-- ── Budget mensile ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS budget_mensile (
  anno        INT           NOT NULL,
  mese        SMALLINT      NOT NULL CHECK (mese BETWEEN 1 AND 12),
  budget_eur  NUMERIC(12,2) NOT NULL CHECK (budget_eur >= 0),
  fonte       TEXT,
  updated_at  TIMESTAMPTZ   DEFAULT now(),
  PRIMARY KEY (anno, mese)
);

-- ── RLS: solo Loris autenticato (nessun accesso anon) ────────────────────────
ALTER TABLE budget_mensile ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_only" ON budget_mensile;
CREATE POLICY "owner_only" ON budget_mensile
  FOR ALL TO authenticated
  USING (auth.email() = 'loriscuba@gmail.com')
  WITH CHECK (auth.email() = 'loriscuba@gmail.com');

-- ── Dati Budget 2026 (Div. 11+72) ─────────────────────────────────────────────
INSERT INTO budget_mensile (anno, mese, budget_eur, fonte) VALUES
  (2026,  1,  98424.38, 'Bdgt_mensilizzato_Cubaiu Loris.xlsx'),
  (2026,  2, 105544.95, 'Bdgt_mensilizzato_Cubaiu Loris.xlsx'),
  (2026,  3, 120429.87, 'Bdgt_mensilizzato_Cubaiu Loris.xlsx'),
  (2026,  4, 111373.94, 'Bdgt_mensilizzato_Cubaiu Loris.xlsx'),
  (2026,  5, 117192.00, 'Bdgt_mensilizzato_Cubaiu Loris.xlsx'),
  (2026,  6, 117845.58, 'Bdgt_mensilizzato_Cubaiu Loris.xlsx'),
  (2026,  7, 143729.54, 'Bdgt_mensilizzato_Cubaiu Loris.xlsx'),
  (2026,  8,  55687.78, 'Bdgt_mensilizzato_Cubaiu Loris.xlsx'),
  (2026,  9, 113958.22, 'Bdgt_mensilizzato_Cubaiu Loris.xlsx'),
  (2026, 10, 116547.21, 'Bdgt_mensilizzato_Cubaiu Loris.xlsx'),
  (2026, 11, 113958.22, 'Bdgt_mensilizzato_Cubaiu Loris.xlsx'),
  (2026, 12,  80324.59, 'Bdgt_mensilizzato_Cubaiu Loris.xlsx')
ON CONFLICT (anno, mese) DO UPDATE
  SET budget_eur = EXCLUDED.budget_eur,
      fonte      = EXCLUDED.fonte,
      updated_at = now();

-- ── View budget vs fatturato rolling ──────────────────────────────────────────
DROP VIEW IF EXISTS v_budget_mensile_raggiunto;
CREATE VIEW v_budget_mensile_raggiunto
WITH (security_invoker = on) AS
WITH ultima AS (
  SELECT MAX(data_aggiornamento) AS data_rolling
  FROM rolling_fatturato
  WHERE data_aggiornamento >= DATE '2026-01-01'
    AND data_aggiornamento <= current_date
),
tot AS (
  SELECT
    u.data_rolling,
    EXTRACT(MONTH FROM u.data_rolling)::int AS mese_rolling,
    SUM(r.gto_gen_2026) AS m1,  SUM(r.gto_feb_2026) AS m2,  SUM(r.gto_mar_2026) AS m3,
    SUM(r.gto_apr_2026) AS m4,  SUM(r.gto_mag_2026) AS m5,  SUM(r.gto_giu_2026) AS m6,
    SUM(r.gto_lug_2026) AS m7,  SUM(r.gto_ago_2026) AS m8,  SUM(r.gto_set_2026) AS m9,
    SUM(r.gto_ott_2026) AS m10, SUM(r.gto_nov_2026) AS m11, SUM(r.gto_dic_2026) AS m12,
    SUM(r.mese_consegnato)        AS cons_mese,
    SUM(r.spedito_ordinato_mese)  AS sped_ord_mese
  FROM ultima u
  JOIN rolling_fatturato r ON r.data_aggiornamento = u.data_rolling
  GROUP BY u.data_rolling
),
mesi AS (
  SELECT
    b.anno,
    b.mese,
    b.budget_eur,
    t.data_rolling,
    CASE
      WHEN t.mese_rolling IS NULL         THEN 'futuro'
      WHEN b.mese <  t.mese_rolling       THEN 'chiuso'
      WHEN b.mese =  t.mese_rolling       THEN 'in_corso'
      ELSE 'futuro'
    END AS stato,
    CASE
      WHEN b.mese <  t.mese_rolling THEN COALESCE(g.gto, 0)
      WHEN b.mese =  t.mese_rolling THEN COALESCE(t.cons_mese, 0)
    END AS fatturato,
    CASE
      WHEN b.mese <  t.mese_rolling THEN COALESCE(g.gto, 0)
      WHEN b.mese =  t.mese_rolling THEN COALESCE(t.sped_ord_mese, 0)
    END AS fatturato_con_ordinato
  FROM budget_mensile b
  LEFT JOIN tot t ON true
  LEFT JOIN LATERAL (
    SELECT (ARRAY[t.m1, t.m2, t.m3, t.m4, t.m5, t.m6,
                  t.m7, t.m8, t.m9, t.m10, t.m11, t.m12])[b.mese] AS gto
  ) g ON true
  WHERE b.anno = 2026
)
SELECT
  anno,
  mese,
  (ARRAY['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio',
         'Agosto','Settembre','Ottobre','Novembre','Dicembre'])[mese] AS nome_mese,
  stato,
  data_rolling,
  budget_eur,
  fatturato,
  fatturato_con_ordinato,
  fatturato - budget_eur                                         AS delta_eur,
  ROUND(fatturato * 100.0 / NULLIF(budget_eur, 0), 1)            AS pct_raggiunto,
  ROUND(fatturato_con_ordinato * 100.0 / NULLIF(budget_eur, 0), 1) AS pct_con_ordinato
FROM mesi;

GRANT SELECT ON v_budget_mensile_raggiunto TO authenticated;
REVOKE ALL ON v_budget_mensile_raggiunto FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON budget_mensile TO authenticated;
REVOKE ALL ON budget_mensile FROM anon;
