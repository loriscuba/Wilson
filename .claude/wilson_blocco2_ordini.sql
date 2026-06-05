-- ============================================================
-- WILSON - Blocco 2: Ordini e Righe Ordine
-- Esegui dopo il Blocco 1
-- ============================================================

-- ------------------------------------------------------------
-- TABELLA ORDINI
-- ------------------------------------------------------------

create table if not exists ordini (
  id                        uuid primary key default gen_random_uuid(),
  numero_ordine             text not null unique,
  data_ordine               date not null,

  -- Cliente
  codice_cliente            text references clienti(codice_cliente),

  -- Destinazione merce (può differire dalla sede legale)
  destinazione_ragione_sociale text,
  destinazione_indirizzo    text,
  destinazione_citta        text,
  destinazione_provincia    text,

  -- Logistica
  tipo_ordine               text,        -- nexMart App, via EDI, Richiesta Cliente...
  magazzino                 text,        -- Geodis Pavia, Padova Warehouse...
  corriere                  text,        -- BRT, FERCAM, DACHSER...
  porto_resa                text,        -- Porto franco C.O.
  peso_kg                   numeric(10,3),
  banca_cliente             text,

  -- Pagamento
  condizioni_pagamento      text,        -- Riba 30/60 gg df fm...

  -- Importi
  importo_totale            numeric(10,2),  -- imponibile
  sconto_finanziario_pct    numeric(5,2),   -- es. 2.00
  sconto_finanziario_eur    numeric(10,2),
  iva_pct                   numeric(5,2),
  iva_eur                   numeric(10,2),
  totale_ordine             numeric(10,2),

  -- Stato
  stato                     text default 'confermato',
  -- valori: confermato | in_lavorazione | spedito | consegnato | annullato

  -- Metadati
  file_pdf                  text,        -- nome file originale
  created_at                timestamptz default now()
);

-- Indici utili per query frequenti
create index if not exists idx_ordini_codice_cliente on ordini(codice_cliente);
create index if not exists idx_ordini_data on ordini(data_ordine);
create index if not exists idx_ordini_stato on ordini(stato);

-- ------------------------------------------------------------
-- TABELLA RIGHE ORDINE
-- ------------------------------------------------------------

create table if not exists righe_ordine (
  id                        uuid primary key default gen_random_uuid(),
  ordine_id                 uuid not null references ordini(id) on delete cascade,

  -- Prodotto
  codice_articolo           text,        -- riferimento a prodotti(codice_articolo)
  descrizione_articolo      text,        -- salvata dal PDF (può differire dal catalogo)

  -- Quantità
  quantita                  numeric(10,3),
  unita_misura              text,        -- PZ, CZ, ST, PAK...

  -- Prezzo
  prezzo_unitario           numeric(10,4),
  um_prezzo                 text,        -- es. "1 PZ", "100 PZ", "1 CZ"

  -- Sconti separati per calcoli
  sconto1                   numeric(5,2),   -- es. 45.0
  sconto2                   numeric(5,2),   -- es. 8.0
  sconto3                   numeric(5,2),   -- es. 10.0
  -- Nota: sconto netto = (1-s1/100) * (1-s2/100) * (1-s3/100)

  -- Importo riga
  importo_eur               numeric(10,2),
  iva_pct                   numeric(5,2),

  -- Consegna
  data_consegna_prevista    date,
  note_riga                 text,        -- es. "Merce in partenza da Germania"

  -- Metadati
  created_at                timestamptz default now()
);

-- Indici
create index if not exists idx_righe_ordine_ordine_id on righe_ordine(ordine_id);
create index if not exists idx_righe_ordine_codice_articolo on righe_ordine(codice_articolo);

-- ------------------------------------------------------------
-- VIEW UTILE: ordini con ragione sociale cliente
-- ------------------------------------------------------------

create or replace view v_ordini_dettaglio as
select
  o.numero_ordine,
  o.data_ordine,
  o.stato,
  c.ragione_sociale,
  c.citta,
  c.provincia,
  o.destinazione_ragione_sociale,
  o.tipo_ordine,
  o.magazzino,
  o.corriere,
  o.condizioni_pagamento,
  o.peso_kg,
  o.importo_totale,
  o.sconto_finanziario_pct,
  o.iva_pct,
  o.totale_ordine,
  o.id as ordine_id
from ordini o
left join clienti c on c.codice_cliente = o.codice_cliente;

-- ------------------------------------------------------------
-- VIEW UTILE: fatturato per cliente per mese
-- ------------------------------------------------------------

create or replace view v_fatturato_mensile as
select
  c.ragione_sociale,
  c.codice_cliente,
  date_trunc('month', o.data_ordine) as mese,
  count(o.id)                        as num_ordini,
  sum(o.importo_totale)              as fatturato_netto,
  sum(o.totale_ordine)               as fatturato_ivato
from ordini o
left join clienti c on c.codice_cliente = o.codice_cliente
where o.stato != 'annullato'
group by c.ragione_sociale, c.codice_cliente, date_trunc('month', o.data_ordine)
order by mese desc, fatturato_netto desc;
