import { contextBridge, ipcRenderer } from "electron";
import type { ApiWebaios } from "../commun/api";
import { ARG_FENETRE, CANAUX } from "../commun/canaux";
import type { EtatNavigateur } from "../commun/modele";

const fenetreId = process.argv.find((a) => a.startsWith(ARG_FENETRE))?.slice(ARG_FENETRE.length) ?? "";

/** Abonnement à un canal diffusé par le process principal ; renvoie le désabonnement. */
function ecouter<T>(canal: string, rappel: (v: T) => void): () => void {
  const ecouteur = (_: unknown, v: T) => rappel(v);
  ipcRenderer.on(canal, ecouteur);
  return () => ipcRenderer.removeListener(canal, ecouteur);
}

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
  surPanneau: (rappel) => ecouter(CANAUX.panneau, rappel),
  surRaccourci: (rappel) => ecouter(CANAUX.raccourci, rappel),
  surResultatRecherche: (rappel) => ecouter(CANAUX.resultatRecherche, rappel),
  surPleinEcran: (rappel) => ecouter(CANAUX.pleinEcran, rappel),
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
    repondre: (id, decision, droits) => ipcRenderer.send(CANAUX.repondrePermission, { id, decision, ...(droits ? { droits } : {}) }),
  },
  surPermissions(rappel) {
    const ecouteur = (_: unknown, liste: Parameters<typeof rappel>[0]) => rappel(liste);
    ipcRenderer.on(CANAUX.permissions, ecouteur);
    return () => ipcRenderer.removeListener(CANAUX.permissions, ecouteur);
  },
  agent: {
    demarrer: (t) => ipcRenderer.send(CANAUX.agentDemarrer, t),
    ecrire: (d) => ipcRenderer.send(CANAUX.agentEcrire, d),
    redimensionner: (t) => ipcRenderer.send(CANAUX.agentRedimensionner, t),
    surDonnees: (rappel) => ecouter(CANAUX.agentDonnees, rappel),
    surEtat: (rappel) => ecouter(CANAUX.agentEtat, rappel),
    profils: () => ipcRenderer.invoke(CANAUX.agentProfils),
  },
  accueil: {
    lire: () => ipcRenderer.invoke(CANAUX.accueilLire),
    surChange: (rappel) => ecouter(CANAUX.accueilChange, () => rappel()),
    ordonner: (ordre) => ipcRenderer.send(CANAUX.accueilOrdonner, ordre),
    retirer: (id) => ipcRenderer.send(CANAUX.accueilRetirer, id),
  },
  applications: {
    liste: () => ipcRenderer.invoke(CANAUX.applicationsListe),
    surChange: (rappel) => ecouter(CANAUX.applicationsChange, () => rappel()),
    agir: (dossier, action) => ipcRenderer.send(CANAUX.applicationAction, { dossier, action }),
  },
  surTelechargements(rappel) {
    const ecouteur = (_: unknown, liste: Parameters<typeof rappel>[0]) => rappel(liste);
    ipcRenderer.on(CANAUX.telechargements, ecouteur);
    return () => ipcRenderer.removeListener(CANAUX.telechargements, ecouteur);
  },
};

contextBridge.exposeInMainWorld("webaios", api);
