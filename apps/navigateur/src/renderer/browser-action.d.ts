// Attributs du `<button is="browser-action">` d'electron-chrome-extensions (injectBrowserAction, preload de l'interface).
import "svelte/elements";

declare module "svelte/elements" {
  interface HTMLButtonAttributes {
    /** Partition de la session du profil dont l'extension est montrée. */
    partition?: string;
    /** Id de l'onglet (webContents) pour la bibliothèque ; -1 : l'onglet actif de la fenêtre courante. */
    tab?: number;
  }
}

declare global {
  interface Window {
    /** Exposé par injectBrowserAction (preload de l'interface) : l'état des boutons, par partition. */
    browserAction?: {
      getState(partition: string): Promise<unknown>;
      addEventListener(nom: "update", rappel: (etat: unknown) => void): void;
      removeEventListener(nom: "update", rappel: (etat: unknown) => void): void;
      addObserver(partition: string): void;
      removeObserver(partition: string): void;
    };
  }
}
