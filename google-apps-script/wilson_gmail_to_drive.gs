// WILSON - Gmail → Drive
// Salva automaticamente gli allegati delle mail "Documentazione Wilson" nella
// cartella Drive Wilson/Inbox, da cui wilson_drive_trigger.gs avvia l'import.
//
// Perché questa versione: la precedente marcava come processato l'intero
// THREAD con l'etichetta "wilson-processed" e poi cercava solo i thread senza
// etichetta. Gmail raggruppa nella stessa conversazione le mail con lo stesso
// oggetto: ogni nuova "Documentazione Wilson" finiva in un thread già
// etichettato e veniva ignorata in silenzio.
// Ora si tiene traccia dei singoli MESSAGGI già salvati (Proprietà script),
// e l'etichetta resta solo come segno visivo in Gmail.
//
// SETUP: incolla al posto del vecchio codice, poi esegui una volta
// installaTrigger() (sostituisce il trigger su salvaAllegatiSuDrive).

const DRIVE_FOLDER_ID = '1G96ZLk4OS2QR3a53lBtVbpPeBi0uTnMr'; // Wilson/Inbox
const GMAIL_LABEL     = 'wilson-processed';                 // solo segno visivo
const SUBJECT_FILTER  = 'Documentazione Wilson';            // parola chiave nell'oggetto
const ALLOWED_EXT     = ['.pdf', '.xlsx', '.xls', '.txt'];

// Le mail ricevute prima di questa data sono considerate già importate.
// 16/10/2026 09:21 è l'ultimo file arrivato correttamente su Drive:
// le mail successive (anche quelle perse finora) vengono recuperate.
const DATA_INIZIO = new Date('2026-10-16T09:30:00+02:00');

const PROP_KEY  = 'WILSON_MSG_PROCESSATI';
const MAX_IDS   = 500; // basta e avanza, evita di superare il limite delle Proprietà

function caricaIdProcessati_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_KEY);
  return raw ? JSON.parse(raw) : [];
}

function salvaIdProcessati_(ids) {
  PropertiesService.getScriptProperties()
    .setProperty(PROP_KEY, JSON.stringify(ids.slice(-MAX_IDS)));
}

function salvaAllegatiSuDrive() {
  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const label  = GmailApp.getUserLabelByName(GMAIL_LABEL) || GmailApp.createLabel(GMAIL_LABEL);

  const processati = caricaIdProcessati_();
  const giaFatti   = new Set(processati);

  // Nessun filtro sull'etichetta: si guardano i singoli messaggi.
  const query   = `subject:"${SUBJECT_FILTER}" has:attachment newer_than:60d`;
  const threads = GmailApp.search(query, 0, 50);

  let nuoviMsg = 0, totaleFile = 0;

  threads.forEach(thread => {
    let threadToccato = false;

    thread.getMessages().forEach(message => {
      const id = message.getId();
      if (giaFatti.has(id)) return;
      if (message.getDate() < DATA_INIZIO) return;
      if (message.getSubject().indexOf(SUBJECT_FILTER) === -1) return;

      const attachments = message.getAttachments();
      if (attachments.length === 0) return;

      Logger.log(`📧 Da: ${message.getFrom()} | Oggetto: ${message.getSubject()} | ` +
                 `${message.getDate()} | Allegati: ${attachments.length}`);

      let errori = 0;
      attachments.forEach(att => {
        const nome = att.getName();
        if (!ALLOWED_EXT.some(e => nome.toLowerCase().endsWith(e))) {
          Logger.log(`  ⏭️  Ignorato: ${nome} (estensione non supportata)`);
          return;
        }
        if (folder.getFilesByName(nome).hasNext()) {
          Logger.log(`  ⏭️  Già presente in Inbox: ${nome}`);
          return;
        }
        try {
          folder.createFile(att.copyBlob());
          Logger.log(`  ✅ Salvato: ${nome}`);
          totaleFile++;
        } catch (e) {
          errori++;
          Logger.log(`  ❌ Errore salvataggio ${nome}: ${e.message}`);
        }
      });

      // Se un allegato non è stato salvato, il messaggio verrà ritentato al giro dopo.
      if (errori === 0) {
        processati.push(id);
        giaFatti.add(id);
        nuoviMsg++;
        threadToccato = true;
      }
    });

    if (threadToccato) thread.addLabel(label);
  });

  if (nuoviMsg > 0) salvaIdProcessati_(processati);
  Logger.log(`✅ Completato. Mail nuove: ${nuoviMsg}, file salvati: ${totaleFile}`);
}

// Mostra cosa verrebbe salvato, senza salvare nulla.
function anteprima() {
  const giaFatti = new Set(caricaIdProcessati_());
  GmailApp.search(`subject:"${SUBJECT_FILTER}" has:attachment newer_than:60d`, 0, 50)
    .forEach(thread => thread.getMessages().forEach(m => {
      const stato = giaFatti.has(m.getId()) ? 'già salvata'
                  : m.getDate() < DATA_INIZIO ? 'prima di DATA_INIZIO'
                  : 'DA SALVARE';
      Logger.log(`${m.getDate()} | ${m.getSubject()} | ${m.getAttachments().length} allegati | ${stato}`);
    }));
}

function installaTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'salvaAllegatiSuDrive') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('salvaAllegatiSuDrive').timeBased().everyMinutes(5).create();
  Logger.log('Trigger installato: salvaAllegatiSuDrive ogni 5 minuti.');
}
