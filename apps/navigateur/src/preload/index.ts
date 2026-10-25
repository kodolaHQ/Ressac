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
  surBordGauche(rappel) {
    const ecouteur = (_: unknown, dedans: boolean) => rappel(dedans);
    ipcRenderer.on(CANAUX.bordGauche, ecouteur);
    return () => ipcRenderer.removeListener(CANAUX.bordGauche, ecouteur);
  },
  surPanneau(rappel) {
    const ecouteur = (_: unknown, p: Parameters<typeof rappel>[0]) => rappel(p);
    ipcRenderer.on(CANAUX.panneau, ecouteur);
    return () => ipcRenderer.removeListener(CANAUX.panneau, ecouteur);
  },
  historique: {
    rechercher: (texte, limite) => ipcRenderer.invoke(CANAUX.historiqueRechercher, texte, limite),
    recents: () => ipcRenderer.invoke(CANAUX.historiqueRecents),
    effacer: (depuis) => ipcRenderer.invoke(CANAUX.historiqueEffacer, depuis),
  },
  telechargements: {
    liste: () => ipcRenderer.invoke(CANAUX.telechargementsListe),
    ouvrir: (id) => ipcRenderer.send(CANAUX.telechargementAction, { id, action: "ouvrir" }),
    montrer: (id) => ipcRenderer.send(CANAUX.telechargementAction, { id, action: "montrer" }),
    annuler: (id) => ipcRenderer.send(CANAUX.telechargementAction, { id, action: "annuler" }),
  },
  permissions: {
    enAttente: () => ipcRenderer.invoke(CANAUX.permissionsListe),
    repondre: (id, decision) => ipcRenderer.send(CANAUX.repondrePermission, { id, decision }),
  },
  surPermissions(rappel) {
    const ecouteur = (_: unknown, liste: Parameters<typeof rappel>[0]) => rappel(liste);
    ipcRenderer.on(CANAUX.permissions, ecouteur);
    return () => ipcRenderer.removeListener(CANAUX.permissions, ecouteur);
  },
  surTelechargements(rappel) {
    const ecouteur = (_: unknown, liste: Parameters<typeof rappel>[0]) => rappel(liste);
    ipcRenderer.on(CANAUX.telechargements, ecouteur);
    return () => ipcRenderer.removeListener(CANAUX.telechargements, ecouteur);
  },
};

contextBridge.exposeInMainWorld("webaios", api);
