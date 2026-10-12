-- Promozioni: storico dei codici articolo della promo.
-- codici_extra       = codici usati ORA nella ricerca clienti idonei
-- codici_disponibili = tutti i codici della promo (anche quelli tolti dalla
--                      ricerca), così si possono riattivare con un tocco.

ALTER TABLE promozioni
  ADD COLUMN IF NOT EXISTS codici_disponibili TEXT[] DEFAULT '{}';

UPDATE promozioni
   SET codici_disponibili = codici_extra
 WHERE (codici_disponibili IS NULL OR codici_disponibili = '{}')
   AND codici_extra IS NOT NULL;
