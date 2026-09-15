-- Aggiorna tutte le RLS policy da USING (true) a whitelist email.
-- Esegui come service role (o su Supabase SQL editor).

-- Helper: verifica che solo loriscuba@gmail.com possa accedere
-- attraverso Supabase Auth (Google OAuth).

DO $$
DECLARE
  tbl text;
  pol record;
BEGIN
  -- Elenco tabelle con dati sensibili Wilson
  FOR tbl IN SELECT unnest(ARRAY[
    'clienti_config',
    'visite_note',
    'pipeline_modifiche',
    'promozioni',
    'promo_clienti'
  ]) LOOP
    -- Rimuovi policy permissive esistenti
    FOR pol IN
      SELECT policyname FROM pg_policies
      WHERE tablename = tbl AND schemaname = 'public'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pol.policyname, tbl);
    END LOOP;

    -- Ricrea con whitelist email
    EXECUTE format(
      'CREATE POLICY "owner_only" ON %I FOR ALL USING (auth.email() = ''loriscuba@gmail.com'')',
      tbl
    );
  END LOOP;
END $$;
