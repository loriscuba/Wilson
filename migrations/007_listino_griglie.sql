-- Migration 007: Griglie Netti — scaglioni per articolo
--
-- Il nuovo parse_listino.py salva, per ogni articolo, gli scaglioni della
-- griglia (etichetta + prezzo netto / % di sconto) oltre ai dati già presenti.
-- Esegui nel SQL editor di Supabase PRIMA di reimportare il PDF.

ALTER TABLE listino_fl
  ADD COLUMN IF NOT EXISTS scaglioni       JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS titolo_prezzi   TEXT,
  ADD COLUMN IF NOT EXISTS lordo_per       TEXT,
  ADD COLUMN IF NOT EXISTS nota            TEXT,
  ADD COLUMN IF NOT EXISTS art_equivalente TEXT,
  ADD COLUMN IF NOT EXISTS pagina          INTEGER,
  ADD COLUMN IF NOT EXISTS ordine          INTEGER;

CREATE INDEX IF NOT EXISTS listino_fl_edizione_idx ON listino_fl (edizione, ordine);
