import type { BrowserWindow, Session } from "electron";
import {
  executeurParDefaut,
  IaLocale,
  chargerProfils,
  cheminsEspace,
  creerNoyau,
  PORTS,
  prefixeContexte,
  surveillerAccueil,
  type Atelier,
  type CheminsEspace,
  type DroitDev,
  type EtatIa,
  type Noyau,
  type OngletInfo,
  type OutilsApplications,
} from "@webaios/noyau";
import type { IdFenetre, IdProfil } from "../../commun/modele";
import type { Historique } from "../historique";
import type { Magasin } from "../ipc";
import type { GestionnaireVues } from "../onglets/vues";
import { changementsPolitique, ongletActifDe, PontElectron, type FenetresPourAgent } from "./pont";
import { SessionsAgent } from "./sessions";
import { CANAUX } from "../../commun/canaux";
import { plageDePorts } from "../applications/service";

declare const __RESSOURCES_NOYAU__: string;

/**
 * Ports où une page locale ouverte par l'agent est « construite » : ceux des démos (5280–5299, plage du conteneur) et
 * ceux des applis (WEBAIOS_PORTS_APPS dans les tests, sinon la même plage).
 */
function portConstruit(): (port: number) => boolean {
  const plages = [PORTS.split("-").map(Number) as [number, number], plageDePorts(process.env.WEBAIOS_PORTS_APPS)].filter((p) => p !== undefined);
  return (port) => plages.some(([min, max]) => port >= min && port <= max);
}

/** Tests de bout en bout seulement : les récoltes des widgets peuvent lire le serveur de test local (127.0.0.1). */
const ADRESSES_LOCALES_TESTS = process.env.WEBAIOS_TEST_ADRESSES_LOCALES === "1";

export interface ServiceAgent {
  /** null tant que le noyau n'est pas prêt, ou s'il n'a pas pu démarrer (voir `erreur`). */
  noyau(): Noyau | null;
  erreur(): string | null;
  /** Dossiers de l'espace : la page d'accueil s'y lit même si le noyau n'a pas pu démarrer. */
  chemins: CheminsEspace;
  /** IA locale (Kev, Gemma) des récoltes, une pour toute l'app : elle survit aux changements de profil d'agent. */
  ia: IaLocale;
  /** Dossier des données, états et accords des widgets (hors de l'espace). */
  dossierWidgets: string;
  /** Profils d'agent de l'espace (.webaios/profils), lus même si le noyau n'a pas pu démarrer. */
  profils(): Promise<{ id: string; nom: string }[]>;
  /** Terminaux de l'agent, un par fenêtre. */
  sessions: SessionsAgent;
  /**
   * Ouvre le panneau agent de la fenêtre s'il est fermé et pré-remplit sa saisie, sans l'envoyer. `acces` est lu et
   * donné à l'agent au moment où le texte est écrit, donc après la remise à zéro de la politique par une session qui démarre.
   */
  preRemplir(f: IdFenetre, texte: string, acces?: () => OngletInfo | undefined): void;
  arreter(): Promise<void>;
}


/**
 * Démarre le noyau en tâche de fond : la navigation n'attend jamais l'agent (spec §9), et une erreur
 * du noyau (port, profil illisible…) ne concerne que le panneau agent.
 */
export function demarrerAgent(o: {
  magasin: Magasin;
  vues: GestionnaireVues;
  fenetres: Map<IdFenetre, BrowserWindow>;
  fenetreActive: () => IdFenetre | undefined;
  /** Demande de lecture affichée à l'utilisateur (voir index.ts). */
  demanderLecture: (o: OngletInfo) => Promise<boolean>;
  /** Carte « donnees-widget » : l'agent veut voir les données d'un widget lu avec le compte de l'utilisateur (voir index.ts). */
  demanderDonneesWidget: (o: { id: string; nom: string; agent: string }, signal?: AbortSignal) => Promise<boolean>;
  /** Carte de consentement des outils de développement (voir index.ts). */
  demanderOutilsDev: (o: OngletInfo, d: { droits: DroitDev[]; raison: string; agent: string }, signal?: AbortSignal) => Promise<DroitDev[]>;
  /** L'accès de l'agent à un onglet a changé (politique du noyau). */
  surAcces: () => void;
  /** La page d'accueil a changé (ou devient lisible : noyau prêt), y compris les données, états et accords des widgets. */
  surAccueil: () => void;
  /** L'IA locale a changé d'état (arrêtée, démarre, active, erreur). */
  surEtatIa: (e: EtatIa, erreur?: string) => void;
  /** Dossier du profil du navigateur où l'IA locale est installée (`<profil>/ia-locale`). */
  dossierIa: string;
  /** Atelier partagé avec les applications : un seul conteneur, quel que soit le profil. */
  atelier: Atelier;
  /** Applis de l'espace, lancées par l'agent via ses outils MCP. */
  applications: OutilsApplications;
  /** Fenêtres des applications lancées : l'agent les voit comme des onglets `app:<dossier>`. */
  fenetresApplications: FenetresPourAgent;
  /** Dossier du profil du navigateur, hors de l'espace monté, où restent les profils bruts des sites tiers. */
  dossierProfilage: string;
  /** Dossier du profil du navigateur, hors de l'espace monté, où sont rangés données, états et accords des widgets. */
  dossierWidgets: string;
  /** Historique de navigation, cherché par l'agent (chercher_historique, lire_historique). */
  historique?: Historique;
  /** Session d'un profil de connexion, pour les lectures invisibles des widgets. */
  sessionProfil: (id: IdProfil) => Session;
}): ServiceAgent {
  let noyau: Noyau | null = null;
  let erreur: string | null = null;
  const pont = new PontElectron({
    magasin: o.magasin,
    vues: o.vues,
    fenetreActive: o.fenetreActive,
    demander: o.demanderLecture,
    demanderOutilsDev: o.demanderOutilsDev,
    demanderDonneesWidget: o.demanderDonneesWidget,
    applications: o.fenetresApplications,
    sessionProfil: o.sessionProfil,
    ...(o.historique ? { historique: o.historique } : {}),
  });
  // La politique d'accès suit ce que fait l'utilisateur : changer de site ou fermer un onglet retire l'accès (spec §8.2).
  o.magasin.abonner((etat, avant) => {
    if (!noyau) return;
    const { navigues, fermes } = changementsPolitique(avant, etat);
    for (const n of navigues) noyau.politique.ongletNavigue(n.id, n.url);
    for (const id of fermes) noyau.politique.ongletFerme(id);
  });
  const chemins = cheminsEspace();
  // Démarrée à la demande par une récolte, arrêtée après 10 minutes sans usage ; installée seulement sur un clic de l'utilisateur.
  const ia = new IaLocale({ dossier: o.dossierIa, executer: executeurParDefaut, surEtat: o.surEtatIa });
  let arreterAccueil: (() => Promise<void>) | undefined;
  try {
    arreterAccueil = surveillerAccueil(chemins, o.surAccueil);
  } catch (e) {
    console.error("[webaios] surveillance de la page d'accueil impossible :", e);
  }
  let desabonnerAcces: (() => void) | undefined;
  const lancerNoyau = (profilId: string): Promise<Noyau | null> => {
    erreur = null;
    return creerNoyau({ pont, ressources: __RESSOURCES_NOYAU__, profilId, racine: chemins.racine, atelier: o.atelier, applications: o.applications, portConstruit: portConstruit(), dossierProfilage: o.dossierProfilage, dossierWidgets: o.dossierWidgets, ia, surChange: o.surAccueil, ...(ADRESSES_LOCALES_TESTS ? { adressesLocales: true } : {}) }).then(
      (n) => {
        noyau = n;
        desabonnerAcces = n.politique.surChange(o.surAcces);
        o.surAcces();
        o.surAccueil(); // l'espace vient peut-être d'être créé
        return n;
      },
      (e: Error) => {
        erreur = e.message;
        console.error("[webaios] le noyau n'a pas pu démarrer :", e);
        return null;
      },
    );
  };
  const arreterNoyau = async (n: Noyau | null) => {
    noyau = null;
    desabonnerAcces?.();
    desabonnerAcces = undefined;
    o.surAcces(); // plus de noyau : plus aucune pastille
    await n?.arreter();
  };
  let pret = lancerNoyau(o.magasin.etat.reglages.profilAgent);
  // Autre profil (spec §10) : un nouveau noyau (commande, config MCP, veilles), et un nouvel agent dans chaque panneau.
  o.magasin.abonner((etat, avant) => {
    if (etat.reglages.profilAgent === avant.reglages.profilAgent) return;
    const ancien = pret;
    pret = ancien.then(arreterNoyau).then(() => lancerNoyau(etat.reglages.profilAgent));
    void sessions.relancerTout();
  });
  const sessions = new SessionsAgent({
    async ouvrir(t) {
      const n = await pret;
      if (!n) throw new Error(erreur ?? "le noyau de l'agent n'a pas démarré");
      return n.ouvrirSessionAgent(t);
    },
    // L'utilisateur parle à l'agent depuis l'onglet affiché : il le lui donne (spec §8.2).
    surEnvoi: (f) => {
      const actif = ongletActifDe(o.magasin.etat, f);
      if (actif) noyau?.politique.interactionUtilisateur(actif);
    },
    envoyer: (f, canal, v) => {
      const w = o.fenetres.get(f);
      if (w && !w.isDestroyed()) w.webContents.send(canal === "donnees" ? CANAUX.agentDonnees : CANAUX.agentEtat, v);
    },
  });
  // Ouvrir le panneau (⌘J ou bouton ✦) sur un onglet le donne à l'agent et pré-remplit le contexte, sans
  // l'envoyer (spec §8). À la toute première ouverture la session démarre : sa saisie n'est pas encore prête.
  o.magasin.abonner((etat, avant) => {
    for (const f of etat.fenetres) {
      const ouvert = !avant.fenetres.find((x) => x.id === f.id)?.panneauAgentOuvert && f.panneauAgentOuvert;
      const actif = ouvert ? ongletActifDe(etat, f.id) : null;
      if (!actif) continue;
      noyau?.politique.interactionUtilisateur(actif);
      if (sessions.active(f.id)) sessions.ecrire(f.id, prefixeContexte(actif.titre, actif.url));
    }
  });
  return {
    noyau: () => noyau,
    erreur: () => erreur,
    chemins,
    ia,
    dossierWidgets: o.dossierWidgets,
    async profils() {
      try {
        return (await chargerProfils(chemins)).profils.map((p) => ({ id: p.id, nom: p.nom }));
      } catch {
        return [];
      }
    },
    sessions,
    preRemplir(f, texte, acces) {
      if (o.magasin.etat.fenetres.find((x) => x.id === f)?.panneauAgentOuvert === false) o.magasin.agir({ type: "basculerPanneauAgent", fenetreId: f });
      sessions.preRemplir(
        f,
        texte,
        acces &&
          (() => {
            const onglet = acces();
            if (onglet) noyau?.politique.interactionUtilisateur(onglet);
          }),
      );
    },
    async arreter() {
      // Les agents d'abord : leur arrêt passe par le conteneur, avant que l'app ne quitte.
      await sessions.toutArreter();
      await Promise.all([arreterAccueil?.(), arreterNoyau(await pret)]);
      // L'app quitte : l'IA locale est fermée pour de bon (aussi quand le noyau n'a pas démarré), une récolte en retard ne la relance pas.
      await ia.fermer().catch(() => {});
    },
  };
}
