-- Migration 012: abilita RLS su statistiche_salvate (segnalata dall'advisor
-- Supabase come "RLS disabled", livello critical).
-- Stessa policy delle altre tabelle Wilson (vedi 006): anon + authenticated.

ALTER TABLE IF EXISTS public.statistiche_salvate ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wilson_open" ON public.statistiche_salvate;
CREATE POLICY "wilson_open" ON public.statistiche_salvate
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
