import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { CHEMIN_CONTENEUR, cheminDansConteneur, cheminsEspace, type CheminsEspace } from "./chemins.js";
import { initialiserEspace } from "./espace/initialiser.js";
import { lireAccueil } from "./accueil/lire.js";
import type { EtatAccueil } from "./accueil/schemas.js";
import { surveillerAccueil } from "./accueil/surveiller.js";
import { chargerProfils, construireCommande } from "./profils/profil.js";
import { ecrireConfigMcp } from "./profils/config-mcp.js";
import { Atelier, type EtatAtelier } from "./conteneur/atelier.js";
import { executeurParDefaut, type Executeur } from "./conteneur/executeur.js";
import { SessionAgent } from "./pty/session.js";
import { PolitiqueAcces } from "./acces/politique.js";
import type { OngletInfo, PontNavigateur } from "./mcp/pont.js";
import { demarrerServeurMcp, genererJeton, type OutilsApplications } from "./mcp/serveur.js";
import type { FichiersProfils } from "./mcp/outils-dev.js";
import { SuiviOutilsDev } from "./outils-dev/suivi.js";
import { PlanificateurVeille } from "./veille/planificateur.js";

export class ErreurAtelier extends Error {
  constructor(readonly etat: EtatAtelier, detail?: string) {
    super(detail ?? (etat === "docker-absent" ? "Docker n'est pas lancé" : `Conteneur indisponible (${etat})`));
    this.name = "ErreurAtelier";
  }
}

/** Un seul segment de chemin, sans remontée : un nom de fichier ou de dossier de projet. */
const segmentSur = (s: string): boolean => s !== "" && s !== "." && s !== ".." && basename(s) === s && !s.includes("\\");

/**
 * Profils bruts des outils de développement, écrits par le navigateur dans l'espace (spec §6) : dans le projet pour
 * une application (`projets/<dossier>/.webaios/profils`), dans `.webaios/profils` sinon. Seuls ces dossiers sont lus
 * ou effacés.
 */
export function fichiersProfils(chemins: CheminsEspace): FichiersProfils {
  const dossier = (o: OngletInfo): string => {
    if (o.application === undefined) return join(chemins.interne, "profils");
    if (!segmentSur(o.application)) throw new Error(`Dossier d'application invalide : ${o.application}`);
    return join(chemins.projets, o.application, ".webaios", "profils");
  };
  /** Chemin du conteneur → chemin sur le Mac, seulement s'il désigne un fichier d'un dossier de profils. */
  const surHote = (cheminConteneur: string): string => {
    const normal = posix.normalize(cheminConteneur);
    const prefixe = `${CHEMIN_CONTENEUR}/`;
    if (!posix.isAbsolute(cheminConteneur) || !normal.startsWith(prefixe)) throw new Error(`Chemin hors des profils : ${cheminConteneur}`);
    const parties = normal.slice(prefixe.length).split("/");
    const valide =
      parties.every(segmentSur) &&
      ((parties.length === 3 && parties[0] === ".webaios" && parties[1] === "profils") ||
        (parties.length === 5 && parties[0] === "projets" && parties[2] === ".webaios" && parties[3] === "profils"));
    if (!valide) throw new Error(`Chemin hors des profils : ${cheminConteneur}`);
    return join(chemins.racine, ...parties);
  };
  return {
    async ecrireProfil(o, nom, contenu) {
      if (!segmentSur(nom)) throw new Error(`Nom de profil invalide : ${nom}`);
      const d = dossier(o);
      await mkdir(d, { recursive: true });
      const fichier = join(d, nom);
      await writeFile(fichier, contenu);
      return cheminDansConteneur(fichier, chemins);
    },
    lireProfil: async (c) => readFile(surHote(c), "utf8"),
    supprimerProfil: async (c) => rm(surHote(c), { force: true }),
  };
}

export interface Noyau {
  chemins: CheminsEspace;
  politique: PolitiqueAcces;
  etatAtelier(): Promise<EtatAtelier>;
  /** Nouvelle conversation : efface les autorisations. Signaler l'onglet courant (interactionUtilisateur) après. */
  ouvrirSessionAgent(o: { cols: number; rows: number }): Promise<SessionAgent>;
  lireAccueil(): Promise<EtatAccueil>;
  surveillerAccueil(rappel: () => void): () => Promise<void>;
  arreter(): Promise<void>;
}

/** Point d'entrée unique pour un navigateur (Electron, extension…) : il fournit son pont, le noyau fait le reste. */
export async function creerNoyau(o: {
  pont: PontNavigateur;
  racine?: string;
  executer?: Executeur;
  horloge?: () => Date;
  profilId?: string;
  /** Dossier contenant `modeles/` et `docker/` (par défaut, ceux du paquet). */
  ressources?: string;
  /** Atelier partagé avec le navigateur (qui lance aussi les applications) ; à défaut, le noyau crée le sien. */
  atelier?: Atelier;
  /** Outils MCP des applications (lancer, arrêter, journal). */
  applications?: OutilsApplications;
  /** Ports sur lesquels une démo locale ouverte par l'agent est « construite » (par défaut 5280–5299). */
  portConstruit?: (port: number) => boolean;
}): Promise<Noyau> {
  const chemins = cheminsEspace(o.racine);
  const executer = o.executer ?? executeurParDefaut;
  await initialiserEspace(chemins, o.ressources ? join(o.ressources, "modeles") : undefined);

  const profilId = o.profilId ?? "claude";
  const profil = (await chargerProfils(chemins)).profils.find((p) => p.id === profilId);
  if (!profil) throw new Error(`Profil d'agent inconnu : ${profilId}`);

  const politique = new PolitiqueAcces(o.portConstruit ? { portConstruit: o.portConstruit } : {});
  const jeton = genererJeton();
  const serveur = await demarrerServeurMcp({
    pont: o.pont,
    politique,
    jeton,
    agent: profil.nom,
    profils: fichiersProfils(chemins),
    ...(o.applications ? { applications: o.applications } : {}),
  });
  try {
    await ecrireConfigMcp(chemins, profil.configMcp, { url: serveur.urlConteneur, jeton });
  } catch (e) {
    await serveur.arreter();
    throw e;
  }

  // La navigation ne doit jamais attendre Docker (spec §9) : la première construction d'image prend
  // des minutes, et un échec (port occupé…) ne concerne que l'agent.
  const atelier = o.atelier ?? new Atelier({ chemins, executer, ...(o.ressources ? { dossierDocker: join(o.ressources, "docker") } : {}) });
  // Le conteneur se prépare dès le lancement. S'il échoue, la première session rend cet échec plutôt que de tout
  // reconstruire aussitôt ; les suivantes (Réessayer) tentent à nouveau. Réussi, il est revérifié (sonde rapide).
  // Avant toute session, les agents laissés par une app précédente sont arrêtés.
  let demarrage: Promise<EtatAtelier> | null = atelier.assurerDemarre().then(async (etat) => {
    if (etat === "demarre") await atelier.arreterSessionsOrphelines();
    return etat;
  });
  demarrage.catch(() => {});
  const planificateur = new PlanificateurVeille({ chemins, atelier, profil, executer, horloge: o.horloge });
  await planificateur.demarrer();
  const pont = o.pont;
  const suivi = pont.outilsDev ? new SuiviOutilsDev(politique, pont.outilsDev, () => pont.listerOnglets()) : null;

  return {
    chemins,
    politique,
    etatAtelier: () => atelier.etat(),
    async ouvrirSessionAgent({ cols, rows }) {
      const premier = demarrage;
      demarrage = null;
      const tentative = premier ? premier.then(() => atelier.assurerDemarre()) : atelier.assurerDemarre();
      let etat: EtatAtelier;
      try {
        etat = await tentative;
      } catch (e) {
        throw new ErreurAtelier("absent", (e as Error).message);
      }
      if (etat !== "demarre") throw new ErreurAtelier(etat);
      // Nouvelle conversation : plus aucune autorisation. Les sessions partagent le serveur MCP et donc la politique :
      // une session d'une autre fenêtre perd aussi ses accès (elle redemandera), plutôt que d'en hériter.
      politique.reinitialiser();
      const commande = construireCommande(profil, "interactif", { mcpConfig: cheminDansConteneur(chemins.configMcp, chemins) });
      const id = randomBytes(8).toString("hex");
      return SessionAgent.demarrer(atelier.commandeSession(id, commande), { cols, rows, arreterDistant: () => atelier.arreterSession(id) });
    },
    lireAccueil: () => lireAccueil(chemins),
    surveillerAccueil: (rappel) => surveillerAccueil(chemins, rappel),
    async arreter() {
      suivi?.arreter();
      await planificateur.arreter();
      await serveur.arreter();
    },
  };
}
