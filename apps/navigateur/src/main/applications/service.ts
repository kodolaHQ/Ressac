import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { session, shell } from "electron";
import { ecrireType, GestionnaireApplications, prefixeApplication, type Application, type Atelier, type CheminsEspace, type OngletInfo } from "@webaios/noyau";
import type { ActionApplication, ListeApplications } from "../../commun/api";
import type { Cadre, IdFenetre } from "../../commun/modele";
import { ongletApplication } from "../agent/pont";
import { FenetresApplications, partitionApplication } from "./fenetres";
import { SondeDocker } from "./sonde";

export interface SouvenirApplication {
  cadre?: Cadre;
  dernierLancement?: string;
  favicon?: string;
}

/**
 * Ce que le navigateur retient de chaque appli (`<userData>/applications.json`, ou `fichier` : `sites.json` pour les
 * applis de site) : cadre de sa fenêtre, dernier lancement, favicon. Écrit au plus une fois par `delaiMs`, de façon
 * atomique (fichier temporaire + rename).
 */
export class MemoireApplications {
  private donnees: Record<string, SouvenirApplication> = Object.create(null);
  private minuterie: NodeJS.Timeout | undefined;
  private modifiee = false;
  /** Écritures enchaînées, jamais simultanées. */
  private ecriture: Promise<void> = Promise.resolve();
  private numero = 0;

  constructor(
    private readonly dossier: string,
    private readonly delaiMs = 500,
    private readonly fichier = "applications.json",
  ) {
    try {
      const lu: unknown = JSON.parse(readFileSync(join(dossier, fichier), "utf8"));
      // Sans prototype : un nom d'appli « __proto__ » ou « constructor » reste une simple clé.
      if (lu && typeof lu === "object" && !Array.isArray(lu)) this.donnees = Object.assign(Object.create(null), lu) as Record<string, SouvenirApplication>;
    } catch {
      // Absent ou illisible : on repart de zéro (rien d'essentiel n'y est gardé).
    }
  }

  lire(dossier: string): SouvenirApplication {
    return this.donnees[dossier] ?? {};
  }

  /** Appli supprimée : plus rien n'en est gardé. */
  oublier(dossier: string): void {
    if (!(dossier in this.donnees)) return;
    delete this.donnees[dossier];
    this.modifiee = true;
    this.minuterie ??= setTimeout(() => void this.vider(), this.delaiMs);
  }

  noter(dossier: string, s: SouvenirApplication): void {
    this.donnees[dossier] = { ...this.donnees[dossier], ...s };
    this.modifiee = true;
    this.minuterie ??= setTimeout(() => void this.vider(), this.delaiMs);
  }

  /** Écrit ce qui a changé ; attend toujours la fin des écritures en cours (la sortie de l'app en dépend). */
  vider(): Promise<void> {
    clearTimeout(this.minuterie);
    this.minuterie = undefined;
    if (this.modifiee) {
      this.modifiee = false;
      const texte = JSON.stringify(this.donnees, null, 2);
      this.ecriture = this.ecriture.then(() => this.ecrire(texte)).catch((e) => console.error("[applications] mémoire non écrite :", e));
    }
    return this.ecriture;
  }

  private async ecrire(texte: string): Promise<void> {
    const cible = join(this.dossier, this.fichier);
    const temporaire = `${cible}.${process.pid}.${++this.numero}.tmp`;
    await fs.mkdir(this.dossier, { recursive: true });
    await fs.writeFile(temporaire, texte);
    await fs.rename(temporaire, cible);
  }
}

export interface ServiceApplications {
  gestionnaire: GestionnaireApplications;
  fenetres: FenetresApplications;
  memoire: MemoireApplications;
  /** Ce que montre la page Applications. */
  liste(): Promise<ListeApplications>;
  /** Une action de la page Applications, venue de la fenêtre `fenetreId` ; rejetée en silence si elle ne s'applique pas. */
  agir(dossier: string, action: ActionApplication, fenetreId: IdFenetre): void;
  /** À la sortie : arrête les applis en marche, puis écrit la mémoire. */
  arreter(): Promise<void>;
}

/** Plage de ports `min-max` de WEBAIOS_PORTS_APPS (tests), sinon celle du noyau. */
export function plageDePorts(valeur: string | undefined): [number, number] | undefined {
  const m = /^(\d+)-(\d+)$/.exec(valeur ?? "");
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/**
 * Gestionnaire des applis de l'espace, partagé par tous les profils d'agent, et leurs fenêtres : une appli en marche a
 * sa fenêtre, une appli arrêtée ou en erreur n'en a pas. Fermer la fenêtre arrête l'appli.
 */
export function demarrerApplications(o: {
  chemins: CheminsEspace;
  atelier: Atelier;
  dossierProfil: string;
  /** Ouvre l'URL dans un onglet de la fenêtre principale active (lien sortant d'une appli). */
  ouvrirOnglet(url: string): void;
  /** La liste ou l'état des applis a changé. */
  diffuser(): void;
  /** Une fenêtre d'appli s'est fermée (par l'utilisateur ou par le programme). */
  surFenetreFermee(dossier: string): void;
  /** La page d'une fenêtre d'appli a changé d'adresse. */
  surNavigation(dossier: string, url: string): void;
  /**
   * Déboguer : pré-remplit le terminal de l'agent de la fenêtre. `acces`, relu au moment de l'écriture, donne à l'agent
   * la fenêtre de l'appli en marche si elle est encore ouverte.
   */
  deboguer(fenetreId: IdFenetre, texte: string, acces?: () => OngletInfo | undefined): void;
  /** « Relire » : la page Relecture de l'appli dans cette fenêtre (plan 17). */
  relire?(fenetreId: IdFenetre, dossier: string, nom: string): void;
}): ServiceApplications {
  const memoire = new MemoireApplications(o.dossierProfil);
  /** Lancements en cours par dossier : une appli relancée passe par « arretee » sans que sa fenêtre doive se fermer. */
  const enCours = new Map<string, number>();
  /** Dernier lancement demandé par dossier : il ne se résout qu'après ceux d'avant (le gestionnaire les enchaîne). */
  const derniers = new Map<string, Promise<unknown>>();
  const delai = Number(process.env.WEBAIOS_DELAI_APP_MS);
  const ports = plageDePorts(process.env.WEBAIOS_PORTS_APPS);

  /** Ferme la fenêtre d'une appli qui n'est plus en marche, sauf pendant un lancement (qui décidera à sa fin). */
  const suivreEtat = (dossier: string) => {
    const etat = gestionnaire.etatDe(dossier);
    if ((etat === "arretee" || etat === "erreur") && !enCours.get(dossier)) fenetres.fermer(dossier);
  };

  // Les lancements viennent de l'agent (outil MCP) comme de la page des applis : tous passent par ici.
  class Gestionnaire extends GestionnaireApplications {
    override lancer(dossier: string): Promise<Application> {
      enCours.set(dossier, (enCours.get(dossier) ?? 0) + 1);
      const fin = super.lancer(dossier);
      derniers.set(dossier, fin);
      void fin
        .then(
          (a) => {
            // Lancée, ou relancée : la fenêtre s'ouvre ou se recharge sur le nouveau port.
            if (a.etat === "en-marche") {
              fenetres.ouvrir(a);
              memoire.noter(dossier, { dernierLancement: new Date().toISOString() });
            }
          },
          () => {},
        )
        .finally(() => {
          if (derniers.get(dossier) === fin) derniers.delete(dossier);
          const n = (enCours.get(dossier) ?? 1) - 1;
          if (n > 0) enCours.set(dossier, n);
          else enCours.delete(dossier);
          suivreEtat(dossier);
        });
      return fin;
    }
  }

  const gestionnaire: GestionnaireApplications = new Gestionnaire({
    chemins: o.chemins,
    atelier: o.atelier,
    ...(ports ? { ports } : {}),
    ...(delai > 0 ? { delaiPretMs: delai } : {}),
    surChange: () => {
      for (const { dossier } of fenetres.ouvertes()) suivreEtat(dossier);
      o.diffuser();
    },
  });
  const fenetres = new FenetresApplications({
    memoire,
    ouvrirOnglet: o.ouvrirOnglet,
    surFermee: o.surFenetreFermee,
    surNavigation: o.surNavigation,
    surFavicon: (dossier, favicon) => {
      if (memoire.lire(dossier).favicon === favicon) return;
      memoire.noter(dossier, { favicon });
      o.diffuser();
    },
    surFermeture: (dossier) => void gestionnaire.arreter(dossier).catch((e) => console.error(`[applications] ${dossier} non arrêtée :`, e)),
  });
  // Une fois par vie du navigateur, en tâche de fond : les fenêtres n'attendent jamais Docker.
  gestionnaire.demarrer().catch((e) => console.error("[applications] démarrage impossible :", e));

  // La liste ne l'attend jamais : la page est relue quand l'état de Docker change.
  const docker = new SondeDocker({ sonder: () => o.atelier.etat(), surChange: o.diffuser });
  const signaler = (dossier: string, quoi: string) => (e: unknown) => console.error(`[applications] ${dossier} non ${quoi} :`, e);

  /** Efface le dossier, les données de sa partition et son souvenir ; refusé tant que l'appli tourne ou démarre. */
  async function supprimer(dossier: string): Promise<void> {
    const etat = gestionnaire.etatDe(dossier);
    if (etat !== "arretee" && etat !== "erreur") throw new Error(`appli ${etat}`);
    // Le nom vient d'un projet « Sans fiche » quelconque : seul un dossier direct de projets/ est effacé.
    const projets = resolve(o.chemins.projets);
    const cible = resolve(projets, dossier);
    if (!cible.startsWith(projets + sep)) throw new Error(`${cible} hors de ${projets}`);
    // « arretee » ne dit rien d'un lancement en file ou qui attend encore Docker, ni d'un arrêt « en erreur » pas fini :
    // l'arrêt annule ceux qui n'ont pas commencé, et on attend que le dernier ait rendu la main.
    await gestionnaire.arreter(dossier);
    await derniers.get(dossier)?.catch(() => {});
    await fs.rm(cible, { recursive: true, force: true });
    await session.fromPartition(partitionApplication(dossier)).clearStorageData();
    memoire.oublier(dossier);
    gestionnaire.oublier(dossier);
    o.diffuser();
  }

  async function deboguer(dossier: string, fenetreId: IdFenetre): Promise<void> {
    const a = (await gestionnaire.liste()).find((x) => x.dossier === dossier);
    if (!a) return;
    // Fenêtre ouverte = appli en marche : l'agent peut la lire sans demander, si elle l'est toujours quand le texte s'écrit.
    const fenetre = () => {
      const f = fenetres.ouvertes().find((x) => x.dossier === dossier);
      return f && ongletApplication(f);
    };
    const texte = prefixeApplication({ nom: a.nom, dossier, sansFiche: a.type === "sans-fiche", enMarche: fenetre() !== undefined });
    o.deboguer(fenetreId, texte, fenetre() ? fenetre : undefined);
  }

  return {
    gestionnaire,
    fenetres,
    memoire,
    async liste() {
      const applications = await gestionnaire.liste();
      return {
        atelier: docker.valeur(),
        applications: applications.map((a) => {
          const { favicon, dernierLancement } = memoire.lire(a.dossier);
          return { ...a, ...(favicon ? { favicon } : {}), ...(dernierLancement ? { dernierLancement } : {}) };
        }),
      };
    },
    agir(dossier, action, fenetreId) {
      switch (action) {
        // Relancer = lancer une appli en marche ou en erreur : le gestionnaire arrête d'abord l'instance en cours.
        case "lancer":
        case "relancer":
          void gestionnaire.lancer(dossier).catch(signaler(dossier, "lancée"));
          return;
        case "arreter":
          void gestionnaire.arreter(dossier).catch(signaler(dossier, "arrêtée"));
          return;
        case "ouvrir":
          fenetres.montrer(dossier);
          return;
        case "supprimer":
          void supprimer(dossier).catch(signaler(dossier, "supprimée"));
          return;
        case "promouvoir":
          void ecrireType(o.chemins, dossier, "application")
            .then(o.diffuser)
            .catch(signaler(dossier, "promue"));
          return;
        case "dossier":
          // Montré dans le Finder, jamais ouvert : un dossier « x.app » écrit depuis le conteneur serait lancé sur le Mac.
          try {
            shell.showItemInFolder(join(o.chemins.projets, dossier));
          } catch (e) {
            signaler(dossier, "affichée")(e);
          }
          return;
        case "deboguer":
          void deboguer(dossier, fenetreId).catch(signaler(dossier, "déboguée"));
          return;
        // Une appli sans fiche n'a pas de relecture.
        case "relire":
          void gestionnaire
            .liste()
            .then((l) => {
              const a = l.find((x) => x.dossier === dossier);
              if (a && a.type !== "sans-fiche") o.relire?.(fenetreId, dossier, a.nom);
            })
            .catch(signaler(dossier, "relue"));
          return;
      }
    },
    async arreter() {
      try {
        await gestionnaire.toutArreter();
        await gestionnaire.arreterSurveillance();
      } finally {
        await memoire.vider();
      }
    },
  };
}
