import { contextBridge, ipcRenderer } from "electron";
import type { ApiPastille, ApiWebaios } from "../commun/api";
import { ARG_FENETRE, ARG_PASTILLE, CANAUX } from "../commun/canaux";
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
    rechercher: (texte, limite, distinctes) => ipcRenderer.invoke(CANAUX.historiqueRechercher, texte, limite, distinctes),
    recents: () => ipcRenderer.invoke(CANAUX.historiqueRecents),
    effacer: (depuis) => ipcRenderer.invoke(CANAUX.historiqueEffacer, depuis),
    oublierTexte: (url, espaceId) => ipcRenderer.invoke(CANAUX.historiqueOublierTexte, url, espaceId),
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
  apercuPage: (ongletId) => ipcRenderer.invoke(CANAUX.apercuPage, { ongletId }),
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
  acces: {
    etat: () => ipcRenderer.invoke(CANAUX.accesEtat),
    couper: (id, droit) => ipcRenderer.send(CANAUX.accesCouper, { id, ...(droit ? { droit } : {}) }),
  },
  surAcces: (rappel) => ecouter(CANAUX.acces, rappel),
  accueil: {
    lire: () => ipcRenderer.invoke(CANAUX.accueilLire),
    surChange: (rappel) => ecouter(CANAUX.accueilChange, () => rappel()),
    placer: (placements) => ipcRenderer.send(CANAUX.accueilPlacer, placements),
    retirer: (id) => ipcRenderer.send(CANAUX.accueilRetirer, id),
    ouvrir: (url, id) => ipcRenderer.send(CANAUX.accueilOuvrir, { url, id }),
    profilsPourAccord: () => ipcRenderer.invoke(CANAUX.accueilProfils),
    accorder: (id, profil) => ipcRenderer.send(CANAUX.accueilAccorder, { id, profil }),
    refuserAccord: (id) => ipcRenderer.send(CANAUX.accueilRefuserAccord, id),
    recolter: (id) => ipcRenderer.send(CANAUX.accueilRecolter, id),
  },
  ia: {
    etat: () => ipcRenderer.invoke(CANAUX.iaEtat),
    installer: () => ipcRenderer.invoke(CANAUX.iaInstaller),
    surEtat: (rappel) => ecouter(CANAUX.iaEtatChange, rappel),
    surProgres: (rappel) => ecouter(CANAUX.iaProgres, rappel),
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

/** Pastille d'une fenêtre d'appli : l'accès de l'agent et la taille de sa vue, pas le reste de l'API de la fenêtre. */
const pastille: ApiPastille = {
  acces: {
    etat: () => ipcRenderer.invoke(CANAUX.accesEtat),
    couper: (id, droit) => ipcRenderer.send(CANAUX.accesCouper, { id, ...(droit ? { droit } : {}) }),
  },
  surAcces: (rappel) => ecouter(CANAUX.acces, rappel),
  pastilleTaille: (ouverte) => ipcRenderer.send(CANAUX.pastilleTaille, { ouverte }),
};

/**
 * Ce preload tourne aussi dans les cadres de l'interface (nodeIntegrationInSubFrames, pour les affichages des widgets).
 * Seul le cadre principal reçoit l'API ; un cadre n'en voit rien.
 */
const cadrePrincipal = process.isMainFrame !== false && window.top === window;
if (cadrePrincipal) {
  contextBridge.exposeInMainWorld("webaios", process.argv.some((a) => a.startsWith(ARG_PASTILLE)) ? pastille : api);
} else if (location.protocol === "webaios-widget:") {
  // Affichage d'un widget : un vrai appui de la souris (isTrusted, impossible à produire par le code du widget, qui ne
  // voit pas ce monde isolé) est signalé au process principal, qui seul permet alors un lien à ce widget. Écouté en
  // capture, avant tout écouteur du widget. Jamais un `click` : le widget peut voler le focus et faire d'un Espace ou
  // d'un Entrée tapé par l'utilisateur pour autre chose un clic « isTrusted ».
  addEventListener(
    "pointerdown",
    (e) => {
      if (e.isTrusted) ipcRenderer.send(CANAUX.gesteWidget);
    },
    true,
  );
}
