-- Migration 010: monitor incentivi quadrimestrali per cliente.
--
-- Accordo di riferimento: lettera Fischer del 16/02/2026 a Trucchi Efisio Srl
-- (cod. 978839), "Incentive quadrimestrali 2026". Per ogni singolo quadrimestre
-- (gen-apr, mag-ago, set-dic) il premio matura sul fatturato del quadrimestre
-- in base allo scaglione raggiunto:
--   € 36.500 → 1,0%  ·  € 39.000 → 2,0%  ·  € 40.500 → 2,5%  ·  € 41.500 → 3,0%
--
-- Fonte del fatturato: ultimo rolling_fatturato 2026 del cliente.
--   * mesi chiusi (precedenti al mese del rolling) → gto_<mese>_2026
--   * mese del rolling → mese_consegnato (consolidato)
--                        spedito_ordinato_mese (consolidato + ordinato in corso)
-- Le forniture escluse dall'accordo (commesse gestite e appoggiate da Fischer)
-- si registrano in incentivi_rettifiche e vengono sottratte.
--
-- Esegui nel SQL editor di Supabase (come service role / owner).

-- ── Scaglioni dell'accordo ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS incentivi_scaglioni (
  id             BIGSERIAL PRIMARY KEY,
  codice_cliente TEXT          NOT NULL,
  anno           INT           NOT NULL,
  soglia         NUMERIC(12,2) NOT NULL CHECK (soglia > 0),
  aliquota_pct   NUMERIC(5,2)  NOT NULL CHECK (aliquota_pct > 0),
  nota           TEXT,
  created_at     TIMESTAMPTZ   DEFAULT now(),
  UNIQUE (codice_cliente, anno, soglia)
);

-- ── Rettifiche: forniture da escludere (importi positivi = da togliere) ──────
CREATE TABLE IF NOT EXISTS incentivi_rettifiche (
  id             BIGSERIAL PRIMARY KEY,
  codice_cliente TEXT          NOT NULL,
  anno           INT           NOT NULL,
  quadrimestre   SMALLINT      NOT NULL CHECK (quadrimestre BETWEEN 1 AND 3),
  importo        NUMERIC(12,2) NOT NULL,
  nota           TEXT,
  created_at     TIMESTAMPTZ   DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incentivi_rettifiche_cli_idx
  ON incentivi_rettifiche (codice_cliente, anno, quadrimestre);

-- ── RLS: solo Loris autenticato (nessun accesso anon) ────────────────────────
ALTER TABLE incentivi_scaglioni  ENABLE ROW LEVEL SECURITY;
ALTER TABLE incentivi_rettifiche ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_only" ON incentivi_scaglioni;
CREATE POLICY "owner_only" ON incentivi_scaglioni
  FOR ALL TO authenticated
  USING (auth.email() = 'loriscuba@gmail.com')
  WITH CHECK (auth.email() = 'loriscuba@gmail.com');

DROP POLICY IF EXISTS "owner_only" ON incentivi_rettifiche;
CREATE POLICY "owner_only" ON incentivi_rettifiche
  FOR ALL TO authenticated
  USING (auth.email() = 'loriscuba@gmail.com')
  WITH CHECK (auth.email() = 'loriscuba@gmail.com');

-- ── Dati accordo Trucchi Efisio Srl 2026 ──────────────────────────────────────
INSERT INTO incentivi_scaglioni (codice_cliente, anno, soglia, aliquota_pct, nota) VALUES
  ('978839', 2026, 36500, 1.0, 'Lettera Fischer 16/02/2026 – Incentive quadrimestrali 2026'),
  ('978839', 2026, 39000, 2.0, 'Lettera Fischer 16/02/2026 – Incentive quadrimestrali 2026'),
  ('978839', 2026, 40500, 2.5, 'Lettera Fischer 16/02/2026 – Incentive quadrimestrali 2026'),
  ('978839', 2026, 41500, 3.0, 'Lettera Fischer 16/02/2026 – Incentive quadrimestrali 2026')
ON CONFLICT (codice_cliente, anno, soglia) DO NOTHING;

-- ── View monitor ──────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS v_incentivi_quadrimestrali;
CREATE VIEW v_incentivi_quadrimestrali
WITH (security_invoker = on) AS
WITH clienti_inc AS (
  SELECT DISTINCT codice_cliente FROM incentivi_scaglioni WHERE anno = 2026
),
ultimo AS (
  SELECT DISTINCT ON (r.codice_cliente) r.*
  FROM rolling_fatturato r
  JOIN clienti_inc c ON c.codice_cliente = r.codice_cliente
  WHERE r.data_aggiornamento >= DATE '2026-01-01'
    AND r.data_aggiornamento <= current_date
  ORDER BY r.codice_cliente, r.data_aggiornamento DESC
),
mesi AS (
  SELECT
    u.codice_cliente,
    u.ragione_sociale,
    u.data_aggiornamento,
    m.n                                               AS mese,
    (m.n - 1) / 4 + 1                                 AS quadrimestre,
    EXTRACT(MONTH FROM u.data_aggiornamento)::int     AS mese_rolling,
    CASE
      WHEN m.n <  EXTRACT(MONTH FROM u.data_aggiornamento) THEN COALESCE(m.gto, 0)
      WHEN m.n =  EXTRACT(MONTH FROM u.data_aggiornamento) THEN COALESCE(u.mese_consegnato, 0)
      ELSE 0
    END                                               AS consolidato,
    CASE
      WHEN m.n <  EXTRACT(MONTH FROM u.data_aggiornamento) THEN COALESCE(m.gto, 0)
      WHEN m.n =  EXTRACT(MONTH FROM u.data_aggiornamento) THEN COALESCE(u.spedito_ordinato_mese, 0)
      ELSE 0
    END                                               AS con_ordinato
  FROM ultimo u
  CROSS JOIN LATERAL (VALUES
    (1,  u.gto_gen_2026), (2,  u.gto_feb_2026), (3,  u.gto_mar_2026), (4,  u.gto_apr_2026),
    (5,  u.gto_mag_2026), (6,  u.gto_giu_2026), (7,  u.gto_lug_2026), (8,  u.gto_ago_2026),
    (9,  u.gto_set_2026), (10, u.gto_ott_2026), (11, u.gto_nov_2026), (12, u.gto_dic_2026)
  ) AS m(n, gto)
),
quad AS (
  SELECT
    codice_cliente,
    MAX(ragione_sociale)        AS ragione_sociale,
    MAX(data_aggiornamento)     AS data_rolling,
    quadrimestre,
    MAX(mese_rolling)           AS mese_rolling,
    SUM(consolidato)            AS fatturato_consolidato,
    SUM(con_ordinato)           AS fatturato_con_ordinato
  FROM mesi
  GROUP BY codice_cliente, quadrimestre
),
base AS (
  SELECT
    q.*,
    COALESCE((SELECT SUM(r.importo) FROM incentivi_rettifiche r
              WHERE r.codice_cliente = q.codice_cliente AND r.anno = 2026
                AND r.quadrimestre = q.quadrimestre), 0)            AS rettifiche,
    CASE
      WHEN q.mese_rolling >  q.quadrimestre * 4     THEN 'chiuso'
      WHEN q.mese_rolling >= q.quadrimestre * 4 - 3 THEN 'in_corso'
      ELSE 'futuro'
    END                                                             AS stato
  FROM quad q
),
netto AS (
  SELECT
    b.*,
    b.fatturato_consolidato  - b.rettifiche AS netto_consolidato,
    b.fatturato_con_ordinato - b.rettifiche AS netto_con_ordinato
  FROM base b
)
SELECT
  n.codice_cliente,
  n.ragione_sociale,
  2026                                   AS anno,
  n.quadrimestre,
  (ARRAY['Gen–Apr','Mag–Ago','Set–Dic'])[n.quadrimestre] AS periodo,
  n.stato,
  n.data_rolling,
  n.fatturato_consolidato,
  n.fatturato_con_ordinato,
  n.rettifiche,
  n.netto_consolidato,
  n.netto_con_ordinato,
  -- Scaglione raggiunto sul consolidato
  s_ok.soglia                            AS soglia_raggiunta,
  s_ok.aliquota_pct                      AS aliquota_raggiunta,
  ROUND(n.netto_consolidato * COALESCE(s_ok.aliquota_pct, 0) / 100, 2) AS premio_maturato,
  -- Prossimo scaglione dal consolidato
  s_next.soglia                          AS prossima_soglia,
  s_next.aliquota_pct                    AS prossima_aliquota,
  GREATEST(s_next.soglia - n.netto_consolidato, 0) AS mancante_prossima,
  -- Proiezione includendo l'ordinato del mese in corso
  s_ord.soglia                           AS soglia_con_ordinato,
  s_ord.aliquota_pct                     AS aliquota_con_ordinato,
  ROUND(n.netto_con_ordinato * COALESCE(s_ord.aliquota_pct, 0) / 100, 2) AS premio_con_ordinato,
  (SELECT MIN(soglia)  FROM incentivi_scaglioni s
    WHERE s.codice_cliente = n.codice_cliente AND s.anno = 2026) AS soglia_minima,
  (SELECT MAX(soglia)  FROM incentivi_scaglioni s
    WHERE s.codice_cliente = n.codice_cliente AND s.anno = 2026) AS soglia_massima
FROM netto n
LEFT JOIN LATERAL (
  SELECT soglia, aliquota_pct FROM incentivi_scaglioni s
  WHERE s.codice_cliente = n.codice_cliente AND s.anno = 2026
    AND s.soglia <= n.netto_consolidato
  ORDER BY s.soglia DESC LIMIT 1
) s_ok ON true
LEFT JOIN LATERAL (
  SELECT soglia, aliquota_pct FROM incentivi_scaglioni s
  WHERE s.codice_cliente = n.codice_cliente AND s.anno = 2026
    AND s.soglia > n.netto_consolidato
  ORDER BY s.soglia ASC LIMIT 1
) s_next ON true
LEFT JOIN LATERAL (
  SELECT soglia, aliquota_pct FROM incentivi_scaglioni s
  WHERE s.codice_cliente = n.codice_cliente AND s.anno = 2026
    AND s.soglia <= n.netto_con_ordinato
  ORDER BY s.soglia DESC LIMIT 1
) s_ord ON true;

GRANT SELECT ON v_incentivi_quadrimestrali TO authenticated;
REVOKE ALL ON v_incentivi_quadrimestrali FROM anon;
