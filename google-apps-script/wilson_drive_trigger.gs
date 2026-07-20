/**
 * Automazione Wilson: quando arriva un file nuovo nella cartella Drive
 * di origine, fa partire il workflow GitHub "wilson_sync.yml".
 *
 * Va incollato nel progetto Apps Script "Wilson. - Drive"
 * (script.google.com/d/1gHbxw8feIDhNeFwUNIQ1D_vou_GNCgYHVBoO7uZrFtIyZrineBVYUDTS/edit)
 *
 * SETUP (una tantum):
 * 1. Estensioni > Proprietà del progetto > Proprietà script, aggiungi:
 *      GITHUB_TOKEN = <personal access token con permesso "workflow"/"actions:write">
 * 2. Esegui manualmente la funzione installaTrigger() una volta e autorizza i permessi.
 *    Da quel momento checkNuoviFile() gira da sola ogni 5 minuti.
 * 3. Per disinstallare: esegui rimuoviTrigger().
 */

const FOLDER_ID          = '1G96ZLk4OS2QR3a53lBtVbpPeBi0uTnMr';   // cartella sorgente (stessa del workflow)
const EXCLUDE_FOLDER_ID  = '1hXZ7gs5FfbdaVe4SqETBX4rZWHiAVpOw';   // cartella "processed", da ignorare
const REPO               = 'loriscuba/Wilson';
const WORKFLOW_FILE      = 'wilson_sync.yml';
const REF                = 'main';

function installaTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'checkNuoviFile') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkNuoviFile')
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log('Trigger installato: checkNuoviFile ogni 5 minuti.');
}

function rimuoviTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'checkNuoviFile') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Trigger rimosso.');
}

function checkNuoviFile() {
  const props = PropertiesService.getScriptProperties();
  const lastCheckIso = props.getProperty('LAST_CHECK');
  const lastCheck = lastCheckIso ? new Date(lastCheckIso) : new Date(0);
  const now = new Date();

  const trovato = cercaFileNuovi(FOLDER_ID, lastCheck);

  props.setProperty('LAST_CHECK', now.toISOString());

  if (trovato) {
    Logger.log('Nuovi file trovati in Drive: avvio ' + WORKFLOW_FILE);
    dispatchWorkflow();
  } else {
    Logger.log('Nessun file nuovo.');
  }
}

function cercaFileNuovi(folderId, lastCheck) {
  if (folderId === EXCLUDE_FOLDER_ID) return false;

  const folder = DriveApp.getFolderById(folderId);

  const files = folder.getFiles();
  while (files.hasNext()) {
    if (files.next().getDateCreated() > lastCheck) return true;
  }

  const subfolders = folder.getFolders();
  while (subfolders.hasNext()) {
    const sub = subfolders.next();
    if (cercaFileNuovi(sub.getId(), lastCheck)) return true;
  }

  return false;
}

function dispatchWorkflow() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    Logger.log('ERRORE: GITHUB_TOKEN non impostato nelle Proprietà script.');
    return;
  }

  const url = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
    payload: JSON.stringify({ ref: REF }),
    muteHttpExceptions: true,
  });

  Logger.log(`Dispatch ${WORKFLOW_FILE}: HTTP ${response.getResponseCode()} ${response.getContentText()}`);
}
