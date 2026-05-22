-- Tabella configurazione clienti Wilson
-- attivo = FALSE → escluso da top-10 e budget clienti

CREATE TABLE IF NOT EXISTS clienti_config (
  codice_cliente  TEXT PRIMARY KEY,
  ragione_sociale TEXT,
  attivo          BOOLEAN NOT NULL DEFAULT TRUE,
  note            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Aggiorna updated_at automaticamente
CREATE OR REPLACE FUNCTION update_clienti_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_clienti_config_updated_at ON clienti_config;
CREATE TRIGGER trg_clienti_config_updated_at
  BEFORE UPDATE ON clienti_config
  FOR EACH ROW EXECUTE FUNCTION update_clienti_config_updated_at();

-- Clienti esclusi iniziali (attivo = false)
INSERT INTO clienti_config (codice_cliente, attivo) VALUES
  ('570377', false),
  ('576587', false),
  ('595528', false),
  ('974997', false),
  ('977448', false),
  ('978309', false),
  ('974345', false),
  ('590760', false),
  ('603224', false),
  ('603272', false),
  ('614794', false),
  ('974024', false),
  ('974753', false),
  ('975904', false)
ON CONFLICT (codice_cliente) DO NOTHING;
