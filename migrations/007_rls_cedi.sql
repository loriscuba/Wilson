-- Migration 007: apre RLS di cedi_ridistribuito a anon + authenticated.
--
-- La 006 ha ricreato le policy per le tabelle principali dopo il passaggio
-- a Google OAuth, ma cedi_ridistribuito non era nell'elenco: le query dal
-- browser (ruolo authenticated) tornano un array vuoto senza errore e la
-- Dashboard non mostra più i CEDI nell'ordinato/consegnato del mese.
--
-- Verifica prima/dopo:
--   SELECT policyname, roles, cmd FROM pg_policies WHERE tablename = 'cedi_ridistribuito';
--
-- Esegui nel SQL editor di Supabase (come service role / owner).

DO $$
DECLARE
  pol record;
BEGIN
  ALTER TABLE IF EXISTS public.cedi_ridistribuito ENABLE ROW LEVEL SECURITY;

  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'cedi_ridistribuito'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.cedi_ridistribuito', pol.policyname);
  END LOOP;

  CREATE POLICY "wilson_open" ON public.cedi_ridistribuito
    FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
END $$;
