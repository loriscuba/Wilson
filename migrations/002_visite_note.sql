-- Modulo "Note Visite": bozze di nota per settimana/cliente + cache riassunto storico
-- Lo storico visite (import CRM) e il giro settimanale restano caricamenti file a sessione,
-- non persistiti: qui salviamo solo le bozze scritte dall'utente e il riassunto AI per cliente.

CREATE TABLE IF NOT EXISTS visite_note_bozze (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settimana     TEXT NOT NULL,           -- es. '2026-W28'
  cliente       TEXT NOT NULL,           -- nome come letto dal file del giro
  cliente_norm  TEXT NOT NULL,           -- nome normalizzato, per match con storico
  codice        TEXT,
  giorno        TEXT,
  prodotti      TEXT,
  ordini        TEXT,
  step          TEXT,
  nota          TEXT,
  history_key   TEXT,                    -- nome-storico scelto, per non richiedere match manuale ogni volta
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (settimana, cliente_norm)
);

CREATE TABLE IF NOT EXISTS visite_note_riassunti_cache (
  cliente_norm  TEXT PRIMARY KEY,
  cliente_nome  TEXT,
  riassunto     TEXT NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION update_visite_note_bozze_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_visite_note_bozze_updated_at ON visite_note_bozze;
CREATE TRIGGER trg_visite_note_bozze_updated_at
  BEFORE UPDATE ON visite_note_bozze
  FOR EACH ROW EXECUTE FUNCTION update_visite_note_bozze_updated_at();

ALTER TABLE visite_note_bozze ENABLE ROW LEVEL SECURITY;
ALTER TABLE visite_note_riassunti_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "visite_note_bozze_all" ON visite_note_bozze FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "visite_note_riassunti_cache_all" ON visite_note_riassunti_cache FOR ALL USING (true) WITH CHECK (true);
