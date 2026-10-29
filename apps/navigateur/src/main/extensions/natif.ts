/**
 * Messagerie native des extensions (`runtime.connectNative`, `runtime.sendNativeMessage`, spec §4.4) : le point
 * d'entrée unique où WebAiOs décide si une extension peut parler à un programme du Mac. Aujourd'hui, toujours non :
 * le port se ferme avec « Messagerie native non prise en charge » (correctif de electron-chrome-extensions) et aucun
 * processus n'est jamais lancé. Un futur chantier pourra y autoriser un seul hôte nommé, pour une seule extension.
 */
export function connexionNative(_extension: Electron.Extension, _application: string): boolean {
  return false;
}
