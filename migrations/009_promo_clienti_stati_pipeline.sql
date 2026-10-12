-- Promo: stessi stati a pulsante della Pipeline clienti del Budget
-- (Avvisato, Mandata mail, Scritto Mex, Preso Ordine), indipendenti tra loro.
-- La colonna `stato` resta e viene derivata dai pulsanti (per i filtri).

ALTER TABLE promo_clienti
  ADD COLUMN IF NOT EXISTS stato_avvisato BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stato_mail     BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stato_mex      BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stato_ordine   BOOLEAN DEFAULT FALSE;

-- Conversione degli stati esistenti
UPDATE promo_clienti SET stato_avvisato = TRUE
 WHERE stato IN ('proposta', 'in_attesa', 'ordinato');
UPDATE promo_clienti SET stato_ordine = TRUE
 WHERE stato = 'ordinato';
