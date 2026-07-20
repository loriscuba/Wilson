/**
 * Automazione Wilson: quando ci sono file nella cartella Drive di origine,
 * fa partire il workflow GitHub "wilson_sync.yml".
 *
 * SETUP (una tantum):
 * 1. Estensioni > Proprietà del progetto > Proprietà script, aggiungi:
 *      GITHUB_TOKEN = <personal access token con permesso "workflow"/"actions:write">
 *    (NON lasciare mai il token in chiaro nel codice sorgente)
 * 2. Se non hai già un trigger a tempo su controllaCartellaETriggera,
 *    esegui installaTrigger() una volta e autorizza i permessi richiesti.
 * 3. Per disinstallare: esegui rimuoviTrigger().
 */

const DRIVE_FOLDER_ID     = '1G96ZLk4OS2QR3a53lBtVbpPeBi0uTnMr';   // cartella sorgente (stessa del workflow)
const PROCESSED_FOLDER_ID = '1hXZ7gs5FfbdaVe4SqETBX4rZWHiAVpOw';   // cartella "processed", da ignorare
const REPO                = 'loriscuba/Wilson';
const WORKFLOW_FILE       = 'wilson_sync.yml';
const REF                 = 'main';

function triggerWilsonSync() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    Logger.log('ERRORE: GITHUB_TOKEN non impostato nelle Proprietà script.');
    return;
  }

  const response = UrlFetchApp.fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: 'post',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      payload: JSON.stringify({ ref: REF }),
      muteHttpExceptions: true,
    }
  );

  Logger.log('Dispatch status: ' + response.getResponseCode());
  // 204 = OK, action avviata
}

/**
 * Cerca ricorsivamente file nella cartella (e sottocartelle), come fa
 * list_files_recursive() lato Python nel workflow. Un controllo non
 * ricorsivo perde i file caricati nelle sottocartelle.
 */
function cartellaHaFile(folderId) {
  if (folderId === PROCESSED_FOLDER_ID) return false;

  const folder = DriveApp.getFolderById(folderId);
  if (folder.getFiles().hasNext()) return true;

  const subfolders = folder.getFolders();
  while (subfolders.hasNext()) {
    if (cartellaHaFile(subfolders.next().getId())) return true;
  }

  return false;
}

function controllaCartellaETriggera() {
  if (cartellaHaFile(DRIVE_FOLDER_ID)) {
    triggerWilsonSync();
    Logger.log('Sync triggerata — file trovati nella cartella (incluse sottocartelle)');
  } else {
    Logger.log('Cartella vuota, nessun sync necessario');
  }
}

function installaTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'controllaCartellaETriggera') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('controllaCartellaETriggera')
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log('Trigger installato: controllaCartellaETriggera ogni 5 minuti.');
}

function rimuoviTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'controllaCartellaETriggera') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Trigger rimosso.');
}
