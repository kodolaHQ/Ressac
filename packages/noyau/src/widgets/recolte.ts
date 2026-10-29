import { join } from "node:path";
import { ecrireDonnees, ecrireEtatWidget, lireDonnees, lireEtatWidget, supprimerDonnees } from "../accueil/donnees.js";
import type { DeclarationWidget, EtatWidget, WidgetLu } from "../accueil/schemas.js";
import type { Atelier } from "../conteneur/atelier.js";
import type { IaLocale } from "../ia/ia-locale.js";
import type { PontNavigateur } from "../mcp/pont.js";
import { accordValide, lireAccords, retirerAccord } from "./accords.js";
import { DELAI_EXECUTION_MS, PROFIL_REFUSE, executerWorkflow, type IssueWorkflow, type LanceurProcessus } from "../workflows/executer.js";
import { ecrireExecution, idExecution, type Execution, type TraceBloc } from "../workflows/executions.js";
import { lireWorkflow } from "../workflows/lire.js";
import { ecrireMemoire, lireMemoire } from "../workflows/memoire.js";
import { PREFIXE_WORKFLOW_INVALIDE, type Proprietaire } from "../workflows/schema.js";

// Déplacés dans le moteur des workflows ; réexportés pour les modules et tests qui les prennent ici.
export { adresseLocale } from "../workflows/acces.js";
export { PROFIL_REFUSE, lancerParDefaut, type LanceurProcessus, type ProcessusRecolte } from "../workflows/executer.js";

export interface OptionsRecolte {
  id: string;
  widget: WidgetLu;
  dossierWidgets: string;
  /** Dossier du moteur des workflows sur le Mac (`docker/moteur`), monté en lecture seule dans le conteneur. */
  moteur: string;
  atelier: Pick<Atelier, "commandeRecolte" | "supprimerRecolte">;
  lancer?: LanceurProcessus;
  /** null : pas d'IA locale, `kev` et `gemma` répondent une erreur. */
  ia: Pick<IaLocale, "kev" | "gemma"> | null;
  pont: PontNavigateur;
  horloge?: () => Date;
  /** Délai côté noyau ; le conteneur s'arrête de lui-même après 180 s (+5 s). */
  delaiMs?: number;
  /** Appelé après chaque écriture de l'état ou des données du widget (rafraîchir l'affichage). */
  surChange?: () => void;
  /** Tests seulement : permet `recuperer` et `lirePage` vers des adresses locales (127.0.0.1…). */
  adressesLocales?: boolean;
  /** Ce qui a lancé l'exécution (par défaut : la planification). */
  declencheur?: Execution["declencheur"];
  /** Vrai quand le noyau s'arrête : une exécution qui n'a pas fini est alors « interrompue », pas « échouée ». */
  interrompue?: () => boolean;
}

/** `execution` : l'id de l'exécution écrite (aucune quand rien n'a tourné, ou quand l'accord a été retiré pendant). */
export type ResultatRecolte = { etat: EtatWidget; donnees?: unknown; execution?: string };

export const DELAI_RECOLTE_MS = DELAI_EXECUTION_MS;
const ERREUR_MAX = 500;
const JOURNAL_MAX = 2000;
const ID = /^[a-z0-9-]+$/;

export const accordRequis = (d: DeclarationWidget) => `Accord requis pour lire avec ton compte : ${d.sources.compte.join(", ")}`;
export const ERREUR_ATELIER_ARRETE = "Mise à jour impossible : atelier arrêté";
export const ERREUR_RECOLTE_INTERNE = "Mise à jour impossible : erreur interne du navigateur";
export const ERREUR_SANS_WORKFLOW = "Ce widget n'a ni workflow.json ni recolte.mjs";
export const ERREUR_INTERROMPUE = "Interrompue : WebAiOs s'est arrêté";
const MEMOIRE_NON_GARDEE = "Mémoire des blocs non gardée : plus de 3 Mo (l'ancienne reste)";

/** Messages d'erreur fixes écrits par le noyau ; tout autre texte d'erreur a pu être écrit par le widget. */
const ERREURS_FIXES = new Set([
  "Délai dépassé",
  "Réponse trop grande",
  PROFIL_REFUSE,
  ERREUR_ATELIER_ARRETE,
  ERREUR_RECOLTE_INTERNE,
  ERREUR_SANS_WORKFLOW,
  ERREUR_INTERROMPUE,
  // Ancien message, encore dans des états écrits avant les workflows.
  "Ce widget n'a pas de recolte.mjs",
  "Données trop grosses (2 Mo au plus)",
]);
const echapper = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ERREURS_MOTIFS = [
  // Les domaines déclarés n'ont que [a-z0-9.-] ; le message a pu être tronqué (« … »).
  /^Accord requis pour lire avec ton compte : [a-z0-9., -]*…?$/,
  // Écrit par la validation de workflow.json (rédigé par l'agent), jamais par le conteneur. Un widget peut lever le même
  // texte : c'est alors `erreurNoyau` (absent) qui le dit.
  new RegExp(`^${echapper(PREFIXE_WORKFLOW_INVALIDE)}`),
];

/**
 * L'erreur vient-elle du noyau, sans rien que le widget ait pu écrire ? Pour un widget qui lit avec le compte de l'utilisateur,
 * seule une telle erreur (et marquée `erreurNoyau` dans l'état) est montrée à l'agent sans accord.
 */
export function erreurDuNoyau(erreur: string): boolean {
  return ERREURS_FIXES.has(erreur) || ERREURS_MOTIFS.some((m) => m.test(erreur));
}

const tronquer = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * La récolte d'un widget : l'exécution de son workflow (`workflow.json`, ou `recolte.mjs` seul, en workflow implicite)
 * par le moteur, qui n'écrit rien. Ici, ce qui est gardé : `etat.json` (en-cours au début), et selon l'issue
 * `donnees.json`, `memoire.json` et l'exécution. Pour un widget avec compte, l'accord est relu après chaque écriture :
 * retiré, tout ce qui a été lu avec part (données, exécutions, mémoire) et le widget attend un nouvel accord.
 */
export async function executerRecolte(o: OptionsRecolte): Promise<ResultatRecolte> {
  const { id, widget, dossierWidgets } = o;
  if (!ID.test(id) || widget.id !== id) throw new Error(`id de widget invalide : ${id}`);
  const horloge = o.horloge ?? (() => new Date());
  const dossierDonnees = join(dossierWidgets, id);
  const proprietaire: Proprietaire = { type: "widget", id };
  const declencheur = o.declencheur ?? "planifiee";
  const precedent = await lireEtatWidget(dossierWidgets, id);
  const debut = horloge().toISOString();
  await ecrireEtatWidget(dossierWidgets, id, { statut: "en-cours", derniereMaj: precedent.derniereMaj, derniereTentative: debut });
  o.surChange?.();

  /** `erreurWidget` : le texte de l'erreur vient du widget ou du conteneur (sinon, il est écrit par le noyau). */
  const conclure = async (r: {
    statut: EtatWidget["statut"];
    erreur?: string;
    erreurWidget?: boolean;
    journal?: string;
    donnees?: unknown;
    execution?: string;
  }): Promise<ResultatRecolte> => {
    const etat: EtatWidget = {
      statut: r.statut,
      derniereMaj: r.statut === "ok" ? horloge().toISOString() : precedent.derniereMaj,
      derniereTentative: debut,
    };
    if (r.erreur) {
      etat.erreur = tronquer(r.erreur, ERREUR_MAX);
      if (!r.erreurWidget) etat.erreurNoyau = true;
    }
    if (r.journal) etat.journal = r.journal;
    await ecrireEtatWidget(dossierWidgets, id, etat);
    o.surChange?.();
    return {
      etat,
      ...(r.statut === "ok" ? { donnees: r.donnees } : {}),
      ...(r.execution ? { execution: r.execution } : {}),
    };
  };
  /** Une exécution que le noyau a arrêtée avant tout conteneur : ses blocs ne sont pas lancés. */
  const sansConteneur = async (statut: Execution["statut"], erreur: string, blocs: TraceBloc[]): Promise<string> => {
    const e: Execution = {
      version: 1,
      id: idExecution(debut),
      proprietaire,
      declencheur,
      debut,
      fin: horloge().toISOString(),
      statut,
      erreur,
      erreurNoyau: true,
      blocs,
    };
    await ecrireExecution(dossierDonnees, e);
    return e.id;
  };

  // L'erreur de lecture du widget peut citer ses fichiers : elle compte comme écrite par le widget.
  if ("erreur" in widget) return conclure({ statut: "erreur", erreur: widget.erreur, erreurWidget: true });
  const lu = await lireWorkflow(widget.dossier);
  if (!lu) return conclure({ statut: "erreur", erreur: ERREUR_SANS_WORKFLOW });
  // workflow.json à moitié écrit, bloc inconnu, cycle… : aucun conteneur n'est lancé, les données restent.
  if (!lu.resultat.ok) {
    const erreur = tronquer(lu.resultat.erreur, ERREUR_MAX);
    return conclure({ statut: "erreur", erreur, execution: await sansConteneur("echouee", erreur, []) });
  }
  const valide = lu.resultat.valide;
  const declaration = widget.declaration;
  const aCompte = declaration.sources.compte.length > 0;
  // Un accord qui ne vaut plus pour la déclaration actuelle (domaines changés, compte retiré) est retiré, et ce qui a été
  // lu avec effacé (données, exécutions, mémoire) : rien ne passe à la récolte suivante ni, plus tard, à l'agent.
  const accordEnregistre = (await lireAccords(dossierWidgets))[id];
  if (accordEnregistre && !accordValide(declaration, accordEnregistre)) {
    await retirerAccord(dossierWidgets, id);
    await supprimerDonnees(dossierWidgets, id);
  }
  // Un widget qui lit avec le compte de l'utilisateur ne tourne qu'avec son accord, qui couvre aussi ses domaines publics.
  if (aCompte && !accordValide(declaration, (await lireAccords(dossierWidgets))[id])) {
    const erreur = accordRequis(declaration);
    const pasLances: TraceBloc[] = valide.ordre.map((b) => ({
      id: b,
      type: valide.workflow.blocs.find((x) => x.id === b)!.type,
      statut: "pas-lance",
      debut: null,
      fin: null,
      elements: null,
      journal: [],
    }));
    return conclure({ statut: "accord-requis", erreur, execution: await sansConteneur("accord-requis", erreur, pasLances) });
  }

  const { issue, execution, journal: journalExecution } = await executerWorkflow(
    {
      proprietaire,
      valide,
      dossierFichiers: widget.dossier,
      config: declaration.config ?? null,
      precedent: await lireDonnees(dossierWidgets, id),
      memoire: await lireMemoire(dossierDonnees),
      sources: declaration.sources,
      async accord() {
        const a = (await lireAccords(dossierWidgets))[id];
        return accordValide(declaration, a) ? { profil: a.profil } : null;
      },
      // L'accord est retiré avant l'arrêt : quand la récolte conclut, il n'existe plus. Ce qui a été lu avec ce compte part
      // avec lui (le widget montre son exemple jusqu'au nouvel accord).
      async surProfilRefuse() {
        await retirerAccord(dossierWidgets, id);
        await supprimerDonnees(dossierWidgets, id);
      },
      messageAccordRequis: accordRequis(declaration),
      declencheur,
    },
    {
      moteur: o.moteur,
      atelier: o.atelier,
      ...(o.lancer ? { lancer: o.lancer } : {}),
      ia: o.ia,
      pont: o.pont,
      horloge,
      ...(o.delaiMs !== undefined ? { delaiMs: o.delaiMs } : {}),
      ...(o.adressesLocales ? { adressesLocales: true } : {}),
    },
  );
  let journal = journalExecution;

  // L'accord a pu être retiré pendant l'exécution (refuserAccord efface tout), ou pendant une écriture d'ici (elle a pu
  // arriver après l'effacement) : rien de ce qui a été lu avec ne reste, pas même l'exécution.
  const accordRetire = async () => aCompte && !accordValide(declaration, (await lireAccords(dossierWidgets))[id]);
  const refusee = async () => {
    await supprimerDonnees(dossierWidgets, id);
    return conclure({ statut: "accord-requis", erreur: messageRefus(issue, declaration) });
  };
  /** Échec ou arrêt : l'exécution est écrite, les données et la mémoire précédentes restent. */
  const conclureSansDonnees = async (e: Execution, r: Parameters<typeof conclure>[0]): Promise<ResultatRecolte> => {
    await ecrireExecution(dossierDonnees, e);
    if (await accordRetire()) return refusee();
    const fini = await conclure({ ...r, execution: e.id });
    if (await accordRetire()) return refusee();
    return fini;
  };
  if (await accordRetire()) return refusee();

  if (issue.t === "fin") {
    try {
      if (issue.sortie.vers === "widget") await ecrireDonnees(dossierWidgets, id, issue.sortie.valeur);
    } catch (e) {
      // Données refusées (trop grosses…) : les précédentes restent, l'exécution échoue côté noyau.
      execution.statut = "echouee";
      execution.erreur = tronquer(message(e), ERREUR_MAX);
      execution.erreurNoyau = true;
      return conclureSansDonnees(execution, { statut: "erreur", erreur: execution.erreur, journal });
    }
    if (await accordRetire()) return refusee();
    if (issue.memoire) {
      if (!(await ecrireMemoire(dossierDonnees, issue.memoire))) journal = ajouter(journal, MEMOIRE_NON_GARDEE);
      if (await accordRetire()) return refusee();
    }
    await ecrireExecution(dossierDonnees, execution);
    if (await accordRetire()) return refusee();
    const ok = await conclure({ statut: "ok", donnees: issue.sortie.valeur, journal, execution: execution.id });
    // Retiré pendant l'écriture de l'état : « ok » ne doit pas recouvrir l'accord-requis écrit par refuserAccord.
    if (await accordRetire()) return refusee();
    return ok;
  }

  // Arrêt du noyau (sortie, changement de profil) : l'exécution n'a pas échoué, elle est interrompue.
  // Son erreur est celle du noyau (pas celle, sans objet, du conteneur tué) ; un bloc commencé sans fin est interrompu.
  if (o.interrompue?.() && execution.statut !== "accord-requis") {
    execution.statut = "interrompue";
    execution.erreur = ERREUR_INTERROMPUE;
    execution.erreurNoyau = true;
    execution.blocs = execution.blocs.map((b) => (b.debut !== null && b.fin === null ? { ...b, statut: "interrompu" } : b));
  }
  return issue.t === "arret"
    ? conclureSansDonnees(execution, { statut: issue.statut, erreur: issue.erreur, journal })
    : // La provenance vient du moteur : `erreurNoyau` absent, le texte a pu être écrit par le code du widget.
      conclureSansDonnees(execution, { statut: "erreur", erreur: issue.erreur, erreurWidget: !execution.erreurNoyau, journal });
}

/** Le message d'un widget qui attend un nouvel accord : celui du moteur s'il s'est arrêté pour ça (profil refusé…). */
function messageRefus(issue: IssueWorkflow, declaration: DeclarationWidget): string {
  return issue.t === "arret" && issue.statut === "accord-requis" ? issue.erreur : accordRequis(declaration);
}

function ajouter(journal: string, ligne: string): string {
  return ((journal ? journal + "\n" : "") + ligne).slice(-JOURNAL_MAX);
}
