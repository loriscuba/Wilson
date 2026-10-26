-- Migration 008: lettura per il ruolo authenticated su tabelle rimaste "anon only".
--
-- Dopo Google OAuth il browser interroga Supabase come authenticated, ma queste
-- tabelle hanno solo la policy "anon_read → anon": le select tornano vuote senza
-- errore.
--   righe_ddt              → stati ordini fermi a "confermato", fatturato evaso oggi a 0
--   prodotti               → promozioni: clienti idonei / ricerca prodotti vuota
--   sottofamiglie_prodotto → promozioni: elenco famiglie vuoto
--
-- Il frontend le legge soltanto: si aggiunge una policy SELECT per authenticated,
-- lasciando intatte le policy esistenti (le scritture restano ai job di import).
--
-- Verifica:
--   SELECT tablename, policyname, roles, cmd FROM pg_policies
--   WHERE tablename IN ('righe_ddt','prodotti','sottofamiglie_prodotto');
--
-- Esegui nel SQL editor di Supabase (come service role / owner).

DO $$
DECLARE
  tables text[] := ARRAY['righe_ddt', 'prodotti', 'sottofamiglie_prodotto'];
  tbl    text;
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS "authenticated_read" ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY "authenticated_read" ON public.%I FOR SELECT TO authenticated USING (true)',
      tbl
    );
  END LOOP;
END $$;
