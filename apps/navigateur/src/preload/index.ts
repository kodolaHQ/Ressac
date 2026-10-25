import { contextBridge, ipcRenderer } from "electron";
import type { ApiWebaios } from "../commun/api";
import { ARG_FENETRE, CANAUX } from "../commun/canaux";
import type { EtatNavigateur } from "../commun/modele";

const fenetreId = process.argv.find((a) => a.startsWith(ARG_FENETRE))?.slice(ARG_FENETRE.length) ?? "";

const api: ApiWebaios = {
  fenetreId,
  agir: (action) => ipcRenderer.send(CANAUX.action, action),
  surEtat(rappel) {
    const ecouteur = (_: unknown, e: EtatNavigateur) => rappel(e);
    ipcRenderer.on(CANAUX.etat, ecouteur);
    ipcRenderer.send(CANAUX.demanderEtat);
    return () => ipcRenderer.removeListener(CANAUX.etat, ecouteur);
  },
  naviguer: (ongletId, saisie) => ipcRenderer.send(CANAUX.naviguer, { ongletId, saisie }),
  commande: (ongletId, c) => ipcRenderer.send(CANAUX.commande, { ongletId, c }),
  bornesContenu: (b) => ipcRenderer.send(CANAUX.bornes, b),
};

contextBridge.exposeInMainWorld("webaios", api);
