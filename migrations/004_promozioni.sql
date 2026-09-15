-- Promozioni Fischer: definizione promo mensili e tracking proposte clienti

CREATE TABLE IF NOT EXISTS promozioni (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome            TEXT NOT NULL,
  CONSTRAINT promozioni_nome_anno_mese UNIQUE (nome, anno, mese),
  mese            INT,                       -- 4 per aprile
  anno            INT,                       -- 2026
  data_inizio     DATE,
  data_fine       DATE,
  settore         TEXT,                      -- 'Edilizia', 'Industria'
  divisione       TEXT,                      -- '11'
  famiglie        TEXT[] DEFAULT '{}',       -- desc.liv.3 famiglie associate (settate nell'app)
  codici_extra    TEXT[] DEFAULT '{}',       -- codici articolo aggiuntivi specifici
  condizioni      TEXT,                      -- testo dinamica promozionale
  note_ordine     TEXT,                      -- es. "ORDINE PROMO DISCHI"
  non_cumulabile  BOOLEAN DEFAULT TRUE,
  attiva          BOOLEAN DEFAULT TRUE,
  pdf_nome        TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS promo_clienti (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  promo_id        BIGINT NOT NULL REFERENCES promozioni(id) ON DELETE CASCADE,
  codice_cliente  TEXT NOT NULL,
  ragione_sociale TEXT,
  stato           TEXT NOT NULL DEFAULT 'da_contattare',
  -- stati: da_contattare / proposta / in_attesa / ordinato / non_interessato
  nota            TEXT,
  data_proposta   DATE,
  valore_stimato  NUMERIC,
  valore_ordine   NUMERIC,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (promo_id, codice_cliente)
);

CREATE OR REPLACE FUNCTION update_promo_clienti_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_promo_clienti_updated_at ON promo_clienti;
CREATE TRIGGER trg_promo_clienti_updated_at
  BEFORE UPDATE ON promo_clienti
  FOR EACH ROW EXECUTE FUNCTION update_promo_clienti_updated_at();

ALTER TABLE promozioni   ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_clienti ENABLE ROW LEVEL SECURITY;

CREATE POLICY "promozioni_all"    ON promozioni    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "promo_clienti_all" ON promo_clienti FOR ALL USING (true) WITH CHECK (true);
