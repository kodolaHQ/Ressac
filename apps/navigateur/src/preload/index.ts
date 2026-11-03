import { contextBridge, ipcRenderer } from "electron";
import { injectBrowserAction } from "electron-chrome-extensions/browser-action";
import type { ApiCalque, ApiDesign, ApiPastille, ApiSite, ApiWebaios } from "../commun/api";
import { ARG_CALQUE, ARG_FENETRE, ARG_PASTILLE, ARG_SITE, CANAUX } from "../commun/canaux";
import { MOTIF_INDICES_RESEAU } from "../commun/indices-reseau";
import { gardeWidget } from "./garde-widget";
import type { EtatNavigateur } from "../commun/modele";

const fenetreId = process.argv.find((a) => a.startsWith(ARG_FENETRE))?.slice(ARG_FENETRE.length) ?? "";

/** Abonnement à un canal diffusé par le process principal ; renvoie le désabonnement. */
function ecouter<T>(canal: string, rappel: (v: T) => void): () => void {
  const ecouteur = (_: unknown, v: T) => rappel(v);
  ipcRenderer.on(canal, ecouteur);
  return () => ipcRenderer.removeListener(canal, ecouteur);
}

/** Paniers du mode design : partagés par l'interface d'une fenêtre et le calque (bulle ou panier). */
const paniers: Pick<ApiDesign, "panier" | "retirer" | "envoyer" | "lots" | "traite" | "surChange"> = {
  panier: (projet) => ipcRenderer.invoke(CANAUX.designPanier, projet),
  retirer: (projet, id) => ipcRenderer.invoke(CANAUX.designRetirer, projet, id),
  envoyer: (projet) => ipcRenderer.invoke(CANAUX.designEnvoyer, projet),
  lots: (projet) => ipcRenderer.invoke(CANAUX.designLots, projet),
  traite: (projet, lot) => ipcRenderer.invoke(CANAUX.designTraite, projet, lot),
  surChange: (rappel) => ecouter(CANAUX.designChange, () => rappel()),
};

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
  boutonsFenetre: (visibles) => ipcRenderer.send(CANAUX.boutonsFenetre, { visibles }),
  surZoneGauche: (rappel) => ecouter(CANAUX.zoneGauche, rappel),
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
    repondre: (id, decision, droits, o) =>
      ipcRenderer.send(CANAUX.repondrePermission, { id, decision, ...(droits ? { droits } : {}), ...(o?.confirme !== undefined ? { confirme: o.confirme } : {}) }),
  },
  apercuPage: (ongletId) => ipcRenderer.invoke(CANAUX.apercuPage, { ongletId }),
  surPanneauOnglets: (rappel) => ecouter(CANAUX.panneauOnglets, rappel),
  parcoursOnglets: (m) => ipcRenderer.send(CANAUX.parcoursOnglets, m),
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
  workflow: {
    catalogue: () => ipcRenderer.invoke(CANAUX.workflowCatalogue),
    lire: (cible) => ipcRenderer.invoke(CANAUX.workflowLire, cible),
    enregistrer: (cible, brouillon) => ipcRenderer.invoke(CANAUX.workflowEnregistrer, cible, brouillon),
    lireCode: (cible, nom) => ipcRenderer.invoke(CANAUX.workflowLireCode, cible, nom),
    enregistrerCode: (cible, nom, texte) => ipcRenderer.invoke(CANAUX.workflowEnregistrerCode, cible, nom, texte),
    rejouer: (cible, execution, bloc) => ipcRenderer.invoke(CANAUX.workflowRejouer, cible, execution, bloc),
    lancer: (cible, saisie) => ipcRenderer.invoke(CANAUX.workflowLancer, cible, saisie ?? null),
    selection: (cible, bloc) => ipcRenderer.send(CANAUX.workflowSelection, { cible, bloc }),
    direct: () => ipcRenderer.invoke(CANAUX.workflowDirectLire),
    surDirect: (rappel) => ecouter(CANAUX.workflowDirect, rappel),
  },
  accueil: {
    lire: () => ipcRenderer.invoke(CANAUX.accueilLire),
    surChange: (rappel) => ecouter(CANAUX.accueilChange, () => rappel()),
    placer: (placements) => ipcRenderer.send(CANAUX.accueilPlacer, placements),
    retirer: (id) => ipcRenderer.send(CANAUX.accueilRetirer, id),
    ouvrir: (url, id) => ipcRenderer.send(CANAUX.accueilOuvrir, { url, id }),
    profilsPourAccord: () => ipcRenderer.invoke(CANAUX.accueilProfils),
    accorder: (a) => ipcRenderer.invoke(CANAUX.accueilAccorder, a),
    refuserAccord: (id) => ipcRenderer.send(CANAUX.accueilRefuserAccord, id),
    recolter: (id) => ipcRenderer.send(CANAUX.accueilRecolter, id),
    executions: (id) => ipcRenderer.invoke(CANAUX.accueilExecutions, id),
    execution: (id, execution) => ipcRenderer.invoke(CANAUX.accueilExecution, id, execution),
  },
  ia: {
    etat: () => ipcRenderer.invoke(CANAUX.iaEtat),
    installer: () => ipcRenderer.invoke(CANAUX.iaInstaller),
    surEtat: (rappel) => ecouter(CANAUX.iaEtatChange, rappel),
    surProgres: (rappel) => ecouter(CANAUX.iaProgres, rappel),
  },
  actions: {
    liste: () => ipcRenderer.invoke(CANAUX.actionsListe),
    surChange: (rappel) => ecouter(CANAUX.actionsChange, () => rappel()),
    ouvrir: (id, saisie) => ipcRenderer.invoke(CANAUX.actionsOuvrir, id, saisie),
    lancer: (id, saisie) => ipcRenderer.invoke(CANAUX.actionsLancer, id, saisie),
    arreter: (id) => void ipcRenderer.invoke(CANAUX.actionsArreter, id),
    page: (id, execution) => ipcRenderer.invoke(CANAUX.actionsPage, id, execution),
    executions: (id) => ipcRenderer.invoke(CANAUX.actionsExecutions, id),
    execution: (id, execution) => ipcRenderer.invoke(CANAUX.actionsExecution, id, execution),
    direct: () => ipcRenderer.invoke(CANAUX.actionsDirectLire),
    surDirect: (rappel) => ecouter(CANAUX.actionsDirect, rappel),
    ouvrirLien: (id, execution, url) => void ipcRenderer.invoke(CANAUX.actionsOuvrirLien, id, execution, url),
    profilsPourAccord: () => ipcRenderer.invoke(CANAUX.actionsProfils),
    accorder: (a) => ipcRenderer.invoke(CANAUX.actionsAccorder, a),
    refuserAccord: (id) => ipcRenderer.invoke(CANAUX.actionsRefuserAccord, id),
    supprimer: (id) => ipcRenderer.invoke(CANAUX.actionsSupprimer, id),
    voirWorkflow: (id) => void ipcRenderer.invoke(CANAUX.actionsVoirWorkflow, id),
  },
  applications: {
    liste: () => ipcRenderer.invoke(CANAUX.applicationsListe),
    surChange: (rappel) => ecouter(CANAUX.applicationsChange, () => rappel()),
    agir: (dossier, action) => ipcRenderer.send(CANAUX.applicationAction, { dossier, action }),
  },
  sites: {
    liste: () => ipcRenderer.invoke(CANAUX.sitesListe),
    surChange: (rappel) => ecouter(CANAUX.sitesChange, () => rappel()),
    agir: (id, action) => ipcRenderer.send(CANAUX.sitesAction, { id, action }),
  },
  extensions: {
    installerStore: (saisie) => ipcRenderer.invoke(CANAUX.extensionsInstallerStore, saisie),
    pourEspace: (espaceId) => ipcRenderer.invoke(CANAUX.extensionsPourEspace, espaceId),
    basculer: (cle, espaceId, actif) => ipcRenderer.invoke(CANAUX.extensionsBasculer, cle, espaceId, actif),
    surChange: (rappel) => ecouter(CANAUX.extensionsChange, () => rappel()),
    liste: () => ipcRenderer.invoke(CANAUX.extensionsListe),
    coupees: () => ipcRenderer.invoke(CANAUX.extensionsCoupees),
    barre: () => ipcRenderer.invoke(CANAUX.extensionsBarre),
    epingler: (cle, oui) => ipcRenderer.invoke(CANAUX.extensionsEpingler, cle, oui),
    desactiverPartout: (cle) => ipcRenderer.invoke(CANAUX.extensionsDesactiverPartout, cle),
    supprimer: (cle) => ipcRenderer.invoke(CANAUX.extensionsSupprimer, cle),
    toutCouper: (oui) => ipcRenderer.invoke(CANAUX.extensionsToutCouper, oui),
    revoir: (cle) => ipcRenderer.invoke(CANAUX.extensionsRevoir, cle),
    reactiver: (cle) => ipcRenderer.invoke(CANAUX.extensionsReactiver, cle),
    couperDeblocage: (cle) => ipcRenderer.invoke(CANAUX.extensionsCouperDeblocage, cle),
  },
  surTelechargements(rappel) {
    const ecouteur = (_: unknown, liste: Parameters<typeof rappel>[0]) => rappel(liste);
    ipcRenderer.on(CANAUX.telechargements, ecouteur);
    return () => ipcRenderer.removeListener(CANAUX.telechargements, ecouteur);
  },
  design: {
    etat: () => ipcRenderer.invoke(CANAUX.designEtat),
    basculer: () => ipcRenderer.send(CANAUX.designBasculer),
    relire: () => ipcRenderer.send(CANAUX.designRelire),
    ...paniers,
  },
  externes: {
    liste: () => ipcRenderer.invoke(CANAUX.externesListe),
    brancher: (nom) => ipcRenderer.invoke(CANAUX.externesBrancher, nom),
    revoquer: (id) => ipcRenderer.invoke(CANAUX.externesRevoquer, id),
    oublier: (id) => ipcRenderer.invoke(CANAUX.externesOublier, id),
    relire: (id) => ipcRenderer.send(CANAUX.externesRelire, id),
    surChange: (rappel) => ecouter(CANAUX.externesChange, () => rappel()),
  },
  relecture: {
    ouvrir: (projet, jeton) => ipcRenderer.invoke(CANAUX.relectureOuvrir, projet, jeton),
    fichier: (projet, jeton, chemin) => ipcRenderer.invoke(CANAUX.relectureFichier, projet, jeton, chemin),
    lignes: (projet, jeton, chemin, debut, fin) => ipcRenderer.invoke(CANAUX.relectureLignes, projet, jeton, chemin, debut, fin),
    commentaires: (projet) => ipcRenderer.invoke(CANAUX.relectureCommentaires, projet),
    commenter: (projet, jeton, c) => ipcRenderer.invoke(CANAUX.relectureCommenter, projet, jeton, c),
    modifierCommentaire: (projet, id, texte) => ipcRenderer.invoke(CANAUX.relectureModifier, projet, id, texte),
    resoudre: (projet, id, resolu) => ipcRenderer.invoke(CANAUX.relectureResoudre, projet, id, resolu),
    supprimerCommentaire: (projet, id) => ipcRenderer.invoke(CANAUX.relectureSupprimer, projet, id),
    envoyer: (projet) => ipcRenderer.invoke(CANAUX.relectureEnvoyer, projet),
    relu: (projet, jeton) => ipcRenderer.invoke(CANAUX.relectureRelu, projet, jeton),
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
  design: {
    etat: () => ipcRenderer.invoke(CANAUX.designEtat),
    basculer: () => ipcRenderer.send(CANAUX.designBasculer),
    panier: () => ipcRenderer.send(CANAUX.designOuvrirPanier),
    relire: () => ipcRenderer.send(CANAUX.designRelire),
  },
};

/** Calque du mode design (bulle ou panier) : sa remarque et les paniers, rien d'autre. */
const calque: ApiCalque = {
  contexte: () => ipcRenderer.invoke(CANAUX.designContexte),
  ajouter: (texte) => ipcRenderer.invoke(CANAUX.designAjouter, texte),
  annuler: () => ipcRenderer.send(CANAUX.designAnnuler),
  ...paniers,
};

/** Interface de la fenêtre d'une appli de site : sa barre et son état, rien d'autre (le main reconnaît l'appli à l'expéditeur). */
const site: ApiSite = {
  etat: () => ipcRenderer.invoke(CANAUX.siteEtat),
  surEtat: (rappel) => ecouter(CANAUX.siteEtatChange, rappel),
  entrer: () => ipcRenderer.send(CANAUX.siteEntrer),
  accueil: () => ipcRenderer.send(CANAUX.siteAccueil),
  precedent: () => ipcRenderer.send(CANAUX.sitePrecedent),
  suivant: () => ipcRenderer.send(CANAUX.siteSuivant),
  recharger: () => ipcRenderer.send(CANAUX.siteRecharger),
  ouvrirBloque: () => ipcRenderer.send(CANAUX.siteOuvrirBloque),
  chercherAdresse: () => ipcRenderer.send(CANAUX.siteChercherAdresse),
  accorder: (oui, empreinte) => ipcRenderer.invoke(CANAUX.siteAccorder, oui, empreinte),
  memoire: () => ipcRenderer.invoke(CANAUX.siteAccueilMemoire),
  surMemoire: (rappel) => ecouter(CANAUX.siteAccueilMemoireChange, rappel),
  ouvrir: (adresse) => ipcRenderer.invoke(CANAUX.siteAccueilOuvrir, adresse),
  image: (url) => ipcRenderer.invoke(CANAUX.siteAccueilImage, url),
  extensions: {
    liste: () => ipcRenderer.invoke(CANAUX.siteExtensionsListe),
    basculer: (cle, actif) => ipcRenderer.invoke(CANAUX.siteExtensionsBasculer, cle, actif),
    barre: () => ipcRenderer.invoke(CANAUX.siteExtensionsBarre),
    surChange: (rappel) => ecouter(CANAUX.extensionsChange, () => rappel()),
    gerer: () => ipcRenderer.send(CANAUX.siteExtensionsGerer),
    panneau: (hauteur) => ipcRenderer.send(CANAUX.siteExtensionsPanneau, hauteur),
    surFermer: (rappel) => ecouter(CANAUX.siteExtensionsFermer, () => rappel()),
  },
  design: {
    etat: () => ipcRenderer.invoke(CANAUX.designEtat),
    basculer: () => ipcRenderer.send(CANAUX.designBasculer),
    relire: () => ipcRenderer.send(CANAUX.designRelire),
    ouvrirPanier: () => ipcRenderer.send(CANAUX.designOuvrirPanier),
    surChange: (rappel) => ecouter(CANAUX.designChange, () => rappel()),
  },
};

/**
 * Ce preload tourne aussi dans les cadres de l'interface (nodeIntegrationInSubFrames, pour les affichages des widgets).
 * Seul le cadre principal reçoit l'API ; un cadre n'en voit rien.
 */
const cadrePrincipal = process.isMainFrame !== false && window.top === window;
const estPastille = process.argv.some((a) => a.startsWith(ARG_PASTILLE));
const estSite = process.argv.some((a) => a.startsWith(ARG_SITE));
const estCalque = process.argv.some((a) => a.startsWith(ARG_CALQUE));
if (cadrePrincipal) {
  // La fenêtre d'une appli de site n'a que `site` (avec le menu de ses extensions) : jamais l'API de la fenêtre principale.
  if (estSite) contextBridge.exposeInMainWorld("webaios", { site });
  else contextBridge.exposeInMainWorld("webaios", estCalque ? calque : estPastille ? pastille : api);
  // Les boutons des extensions (`<button is="browser-action">`) : l'interface d'une fenêtre principale
  // (BarreExtensions.svelte) et celle d'une fenêtre d'appli de site (sa barre, plan 16), dans leur cadre principal
  // seulement ; jamais un cadre (affichage de widget, accueil d'une appli), la pastille d'une appli ni un calque.
  if (!estPastille && !estCalque) injectBrowserAction();
} else {
  // Tout autre cadre de l'interface est l'affichage d'un widget ou un cadre qu'il a créé : ni WebRTC, ni indice réseau
  // (voir garde-widget.ts), posé avant le premier script de la page.
  try {
    contextBridge.executeInMainWorld({ func: gardeWidget, args: [MOTIF_INDICES_RESEAU] });
  } catch (e) {
    console.error("[webaios] garde du widget non posée :", e);
  }
}
if (!cadrePrincipal && location.protocol === "webaios-widget:") {
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
if (!cadrePrincipal && location.protocol === "webaios-site:") {
  // Écran d'accueil d'une appli de site : comme pour un widget, un vrai appui (souris, ou Entrée et Espace au clavier,
  // `isTrusted`, que le code de l'accueil ne peut pas produire) est signalé au process principal, qui seul permet alors
  // à l'accueil d'ouvrir une adresse du site. Écouté en capture, avant tout écouteur de l'accueil.
  const signaler = () => ipcRenderer.send(CANAUX.siteAccueilGeste);
  addEventListener("pointerdown", (e) => e.isTrusted && signaler(), true);
  addEventListener("keydown", (e) => e.isTrusted && !e.repeat && (e.key === "Enter" || e.key === " ") && signaler(), true);
}
