-- Migration 006: apre RLS a entrambi i ruoli anon e authenticated
-- per tutte le tabelle principali di Wilson.
--
-- Prima di OAuth, le chiamate andavano come anon.
-- Dopo OAuth con Google, vanno come authenticated → le vecchie policy
-- USING (true) senza TO clause potrebbero non coprire authenticated.
-- Questa migration le ricrea esplicitamente per tutti e due i ruoli.
--
-- Esegui nel SQL editor di Supabase (come service role / owner).

DO $$
DECLARE
  tables text[] := ARRAY[
    'clienti',
    'ordini',
    'righe_ordine',
    'ddt',
    'rolling_fatturato',
    'gamma_penetrazione',
    'gamma_config',
    'settori',
    'categorie',
    'importazioni',
    'clienti_config',
    'visite_note_bozze',
    'visite_note_riassunti_cache',
    'pipeline_modifiche',
    'promozioni',
    'promo_clienti'
  ];
  tbl  text;
  pol  record;
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    -- Abilita RLS se non già attiva
    EXECUTE format('ALTER TABLE IF EXISTS %I ENABLE ROW LEVEL SECURITY', tbl);

    -- Rimuovi policy esistenti sulla tabella
    FOR pol IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = tbl
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, tbl);
    END LOOP;

    -- Ricrea una singola policy permissiva per anon + authenticated
    EXECUTE format(
      'CREATE POLICY "wilson_open" ON public.%I FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)',
      tbl
    );
  END LOOP;
END $$;
