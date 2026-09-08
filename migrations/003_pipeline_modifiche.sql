-- Modifiche manuali al Dettaglio Pipeline (budget clienti)
-- Prima erano salvate solo in localStorage del browser: non si vedevano cambiando dispositivo/browser.
-- Qui persistiamo escluso/gap personalizzato/icone stato contatto cliente lato server.

CREATE TABLE IF NOT EXISTS pipeline_modifiche (
  codice_cliente      TEXT PRIMARY KEY,
  escluso             BOOLEAN NOT NULL DEFAULT FALSE,
  gap_personalizzato  NUMERIC,
  stato_avvisato      BOOLEAN NOT NULL DEFAULT FALSE,
  stato_mail          BOOLEAN NOT NULL DEFAULT FALSE,
  stato_mex           BOOLEAN NOT NULL DEFAULT FALSE,
  stato_ordine        BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION update_pipeline_modifiche_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pipeline_modifiche_updated_at ON pipeline_modifiche;
CREATE TRIGGER trg_pipeline_modifiche_updated_at
  BEFORE UPDATE ON pipeline_modifiche
  FOR EACH ROW EXECUTE FUNCTION update_pipeline_modifiche_updated_at();

ALTER TABLE pipeline_modifiche ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pipeline_modifiche_all" ON pipeline_modifiche FOR ALL USING (true) WITH CHECK (true);
