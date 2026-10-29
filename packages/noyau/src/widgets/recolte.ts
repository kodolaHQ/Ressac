import { join } from "node:path";
import { ecrireDonnees, ecrireEtatWidget, lireDonnees, lireEtatWidget, supprimerDonnees } from "../accueil/donnees.js";
import type { DeclarationWidget, EtatWidget, WidgetLu } from "../accueil/schemas.js";
import type { Atelier } from "../conteneur/atelier.js";
import type { IaLocale } from "../ia/ia-locale.js";
import type { PontNavigateur } from "../mcp/pont.js";
import { accordValide, lireAccords, retirerAccord } from "./accords.js";
import { message, tronquer } from "../workflows/acces.js";
import {
  DELAI_EXECUTION_MS,
  ERREUR_MAX,
  JOURNAL_MAX,
  MEMOIRE_NON_GARDEE,
  PROFIL_REFUSE,
  delaisExecution,
  executerWorkflow,
  type ContexteWorkflow,
  type IssueWorkflow,
  type LanceurProcessus,
  type Publication,
  type TraceDirecte,
} from "../workflows/executer.js";
import { ecrireExecution, idEssai, idExecution, lireExecution, listerExecutions, type Execution, type TraceBloc } from "../workflows/executions.js";
import { lireWorkflow } from "../workflows/lire.js";
import type { Menagement } from "../workflows/menagement.js";
import { avecMemoire, ecrireMemoire, lireMemoire, type MemoireBlocs } from "../workflows/memoire.js";
import { compterNouveaux } from "./nouveautes.js";
import { debutTropGros } from "../workflows/protocole.js";
import { PROFONDEUR_REJEU, REJEU_TROP_GROS, planRejeu } from "../workflows/rejeu.js";
import { PREFIXE_WORKFLOW_INVALIDE, type Proprietaire } from "../workflows/schema.js";
import type { ContexteValidation, WorkflowValide } from "../workflows/valider.js";

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
  /** Chaque trace acceptée, en direct (le constructeur suit les blocs) ; doit rendre la main tout de suite. */
  surTrace?: (t: TraceDirecte) => void;
  /** Ménagement des recherches et des lectures ouvertes, partagé par toutes les exécutions du noyau. */
  menagement?: Menagement;
  /** Tests seulement : la base des recherches DuckDuckGo. */
  urlRecherche?: string;
}

/**
 * Issue d'un essai du constructeur : `ok` dès qu'il a tourné (même en échec, son exécution le dit) ; sinon, la raison
 * du refus (rien n'a été écrit, aucun conteneur lancé ou rien gardé de lui).
 */
export type ResultatEssai = { ok: true; execution: string; statut: Execution["statut"] } | { ok: false; erreur: string };

/**
 * `execution` : l'id de l'exécution écrite (aucune quand rien n'a tourné, ou quand l'accord a été retiré pendant).
 * `nouveaux` : seulement pour une exécution qui finit d'un widget `recolte.notifier`, le nombre d'éléments qui n'étaient
 * pas dans les données d'avant l'exécution.
 */
export type ResultatRecolte = { etat: EtatWidget; donnees?: unknown; execution?: string; nouveaux?: number };

export const DELAI_RECOLTE_MS = DELAI_EXECUTION_MS;
const ID = /^[a-z0-9-]+$/;

export const accordRequis = (d: DeclarationWidget) => `Accord requis pour lire avec ton compte : ${d.sources.compte.join(", ")}`;
export const ERREUR_ATELIER_ARRETE = "Mise à jour impossible : atelier arrêté";
export const ERREUR_RECOLTE_INTERNE = "Mise à jour impossible : erreur interne du navigateur";
export const ERREUR_SANS_WORKFLOW = "Ce widget n'a ni workflow.json ni recolte.mjs";
export const ERREUR_INTERROMPUE = "Interrompue : WebAiOs s'est arrêté";

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

/** Le workflow d'un widget : `workflow.json`, ou `recolte.mjs` seul (workflow implicite). */
type WorkflowDuWidget =
  | { t: "ok"; valide: WorkflowValide; declaration: DeclarationWidget }
  /** Le widget est illisible : son erreur peut citer ses fichiers. */
  | { t: "illisible"; erreur: string }
  | { t: "absent" }
  /** workflow.json à moitié écrit, bloc inconnu, cycle… (message du validateur, tronqué). */
  | { t: "invalide"; erreur: string };

/** Ce que la déclaration du widget change aux règles de son workflow. */
export function contexteValidation(d: DeclarationWidget): ContexteValidation {
  return { web: d.sources.web, dureeMaxMinutes: d.recolte?.dureeMaxMinutes ?? null };
}

async function workflowDuWidget(widget: WidgetLu): Promise<WorkflowDuWidget> {
  if ("erreur" in widget) return { t: "illisible", erreur: widget.erreur };
  const lu = await lireWorkflow(widget.dossier, contexteValidation(widget.declaration));
  if (!lu) return { t: "absent" };
  if (!lu.resultat.ok) return { t: "invalide", erreur: tronquer(lu.resultat.erreur, ERREUR_MAX) };
  return { t: "ok", valide: lu.resultat.valide, declaration: widget.declaration };
}

/**
 * Un accord qui ne vaut plus pour la déclaration actuelle (domaines changés, compte retiré) est retiré, et ce qui a été
 * lu avec effacé (données, exécutions, mémoire) : rien ne passe à la récolte suivante ni, plus tard, à l'agent.
 * `peut` : le widget peut tourner (sans compte, ou avec un accord valide, qui couvre aussi ses domaines publics) ;
 * `retire` : un accord périmé vient d'être retiré.
 */
async function accordEnRegle(dossierWidgets: string, id: string, declaration: DeclarationWidget): Promise<{ peut: boolean; retire: boolean }> {
  const accordEnregistre = (await lireAccords(dossierWidgets))[id];
  const retire = accordEnregistre !== undefined && !accordValide(declaration, accordEnregistre);
  if (retire) {
    await retirerAccord(dossierWidgets, id);
    await supprimerDonnees(dossierWidgets, id);
  }
  const peut = declaration.sources.compte.length === 0 || accordValide(declaration, (await lireAccords(dossierWidgets))[id]);
  return { peut, retire };
}

/**
 * L'accord vient d'être perdu hors d'une récolte (pendant un essai) : comme `refuserAccord`, le widget passe en attente
 * d'accord (dates gardées) et l'affichage est prévenu. Déjà en attente d'accord : rien n'est réécrit.
 */
async function marquerAccordRequis(o: OptionsRecolte, erreur: string): Promise<void> {
  const avant = await lireEtatWidget(o.dossierWidgets, o.id);
  if (avant.statut === "accord-requis") return;
  await ecrireEtatWidget(o.dossierWidgets, o.id, {
    statut: "accord-requis",
    derniereMaj: avant.derniereMaj,
    derniereTentative: avant.derniereTentative,
    erreur: tronquer(erreur, ERREUR_MAX),
    erreurNoyau: true,
  });
  o.surChange?.();
}

/** Ce que l'exécution d'un widget demande sur son accord (relu à chaque lecture avec compte). */
function contexteAccord(
  dossierWidgets: string,
  id: string,
  declaration: DeclarationWidget,
): Pick<ContexteWorkflow, "accord" | "surProfilRefuse" | "messageAccordRequis" | "sources"> {
  return {
    sources: declaration.sources,
    async accord() {
      const a = (await lireAccords(dossierWidgets))[id];
      return accordValide(declaration, a) ? { profil: a.profil } : null;
    },
    // L'accord est retiré avant l'arrêt : quand l'exécution conclut, il n'existe plus. Ce qui a été lu avec ce compte part
    // avec lui (le widget montre son exemple jusqu'au nouvel accord).
    async surProfilRefuse() {
      await retirerAccord(dossierWidgets, id);
      await supprimerDonnees(dossierWidgets, id);
    },
    messageAccordRequis: accordRequis(declaration),
  };
}

/** L'accord a-t-il été retiré (refuserAccord efface tout) ? Toujours faux pour un widget sans compte. */
async function accordRetireDe(dossierWidgets: string, id: string, declaration: DeclarationWidget): Promise<boolean> {
  return declaration.sources.compte.length > 0 && !accordValide(declaration, (await lireAccords(dossierWidgets))[id]);
}

/** Ce que l'infrastructure reçoit des options d'une récolte ou d'un essai. */
function infraDe(o: OptionsRecolte, horloge: () => Date): Parameters<typeof executerWorkflow>[1] {
  return {
    moteur: o.moteur,
    atelier: o.atelier,
    ...(o.lancer ? { lancer: o.lancer } : {}),
    ia: o.ia,
    pont: o.pont,
    horloge,
    ...(o.delaiMs !== undefined ? { delaiMs: o.delaiMs } : {}),
    ...(o.adressesLocales ? { adressesLocales: true } : {}),
    ...(o.surTrace ? { surTrace: o.surTrace } : {}),
    ...(o.menagement ? { menagement: o.menagement } : {}),
    ...(o.urlRecherche !== undefined ? { urlRecherche: o.urlRecherche } : {}),
  };
}

/** Arrêt du noyau : l'exécution n'a pas échoué, elle est interrompue ; un bloc commencé sans fin est interrompu. */
function marquerInterrompue(execution: Execution): void {
  execution.statut = "interrompue";
  execution.erreur = ERREUR_INTERROMPUE;
  execution.erreurNoyau = true;
  execution.blocs = execution.blocs.map((b) => (b.debut !== null && b.fin === null ? { ...b, statut: "interrompu" } : b));
}

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

  const lu = await workflowDuWidget(widget);
  // L'erreur de lecture du widget peut citer ses fichiers : elle compte comme écrite par le widget.
  if (lu.t === "illisible") return conclure({ statut: "erreur", erreur: lu.erreur, erreurWidget: true });
  if (lu.t === "absent") return conclure({ statut: "erreur", erreur: ERREUR_SANS_WORKFLOW });
  // workflow.json à moitié écrit, bloc inconnu, cycle… : aucun conteneur n'est lancé, les données restent.
  if (lu.t === "invalide") return conclure({ statut: "erreur", erreur: lu.erreur, execution: await sansConteneur("echouee", lu.erreur, []) });
  const { valide, declaration } = lu;
  // Un widget qui lit avec le compte de l'utilisateur ne tourne qu'avec son accord (un accord périmé est retiré, avec ses données).
  if (!(await accordEnRegle(dossierWidgets, id, declaration)).peut) {
    const erreur = accordRequis(declaration);
    // Déjà en attente d'accord à la dernière exécution : pas une de plus à chaque planification (elles pousseraient
    // dehors l'historique des vraies exécutions), la dernière tient lieu. Les essais ne comptent pas.
    const derniere = (await listerExecutions(dossierDonnees)).find((e) => !e.essai);
    if (derniere?.statut === "accord-requis") return conclure({ statut: "accord-requis", erreur, execution: derniere.id });
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

  // L'accord a pu être retiré pendant l'exécution (refuserAccord efface tout), ou pendant une écriture d'ici (elle a pu
  // arriver après l'effacement) : rien de ce qui a été lu avec ne reste, pas même l'exécution.
  const accordRetire = () => accordRetireDe(dossierWidgets, id, declaration);
  /** La mémoire d'une exécution, sous le verrou de la mémoire du widget, si l'accord tient ; false si trop grosse. */
  const garderMemoire = (m: MemoireBlocs) =>
    avecMemoire(dossierDonnees, async () => (await accordRetire()) || (await ecrireMemoire(dossierDonnees, m)));

  // Exécution progressive (le moteur ne relaie rien aux autres) : chaque publication acceptée est écrite tout de suite,
  // avec la progression dans l'état ; la mémoire sûre reçue en cours de route aussi. Le moteur fait ces relais l'un
  // après l'autre et les attend tous avant de rendre : la sortie finale, écrite ensuite, n'est jamais recouverte.
  // Accord retiré (widget avec compte) : ce qui a été publié part, et plus rien n'est écrit en cours de route.
  const donneesAvant = await lireDonnees(dossierWidgets, id);
  let relaisFermes = false;
  const fermerSiAccordRetire = async (): Promise<boolean> => {
    if (!(await accordRetire())) return false;
    relaisFermes = true;
    await supprimerDonnees(dossierWidgets, id);
    return true;
  };
  const surPublication = async (p: Publication) => {
    if (relaisFermes) return;
    await ecrireDonnees(dossierWidgets, id, p.donnees);
    if (await fermerSiAccordRetire()) return;
    const progression = { faits: p.faits, total: p.total };
    await ecrireEtatWidget(dossierWidgets, id, { statut: "en-cours", derniereMaj: precedent.derniereMaj, derniereTentative: debut, progression });
    if (await fermerSiAccordRetire()) return;
    o.surChange?.();
  };
  const surMemoire = async (m: MemoireBlocs) => {
    if (relaisFermes) return;
    await garderMemoire(m);
  };

  const dureeMaxMinutes = declaration.recolte?.dureeMaxMinutes;
  const { issue, execution, journal: journalExecution } = await executerWorkflow(
    {
      proprietaire,
      valide,
      dossierFichiers: widget.dossier,
      config: declaration.config ?? null,
      precedent: donneesAvant,
      memoire: await lireMemoire(dossierDonnees),
      ...contexteAccord(dossierWidgets, id, declaration),
      declencheur,
      ...(dureeMaxMinutes !== undefined ? { dureeMaxMinutes } : {}),
    },
    { ...infraDe(o, horloge), surPublication, surMemoire },
  );
  // Les relais sont tous finis (le moteur les attend) : plus rien ne s'écrit en cours de route.
  relaisFermes = true;
  let journal = journalExecution;

  const refusee = async () => {
    await supprimerDonnees(dossierWidgets, id);
    return conclure({ statut: "accord-requis", erreur: messageRefus(issue, declaration) });
  };
  /**
   * Échec ou arrêt : l'exécution est écrite ; les données (précédentes, ou publiées en cours de route) restent. La
   * mémoire précédente reste, sauf pour une exécution progressive qui rend sa dernière mémoire sûre (`memoire`).
   */
  const conclureSansDonnees = async (e: Execution, r: Parameters<typeof conclure>[0], memoire?: MemoireBlocs | null): Promise<ResultatRecolte> => {
    await ecrireExecution(dossierDonnees, e);
    if (await accordRetire()) return refusee();
    if (memoire) {
      await garderMemoire(memoire);
      if (await accordRetire()) return refusee();
    }
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
      if (!(await garderMemoire(issue.memoire))) {
        journal = ajouter(journal, MEMOIRE_NON_GARDEE);
        // Aussi dans l'exécution, au journal du bloc de sortie.
        execution.blocs.find((b) => b.id === valide.sortie.id)?.journal.push(MEMOIRE_NON_GARDEE);
      }
      if (await accordRetire()) return refusee();
    }
    await ecrireExecution(dossierDonnees, execution);
    if (await accordRetire()) return refusee();
    const ok = await conclure({ statut: "ok", donnees: issue.sortie.valeur, journal, execution: execution.id });
    // Retiré pendant l'écriture de l'état : « ok » ne doit pas recouvrir l'accord-requis écrit par refuserAccord.
    if (await accordRetire()) return refusee();
    // Comptés contre les données d'avant l'exécution (celles publiées en cours de route n'y sont pas).
    if (declaration.recolte?.notifier === true) return { ...ok, nouveaux: compterNouveaux(donneesAvant, issue.sortie.valeur) };
    return ok;
  }

  // Arrêt du noyau (sortie, changement de profil) : l'exécution n'a pas échoué, elle est interrompue.
  // Son erreur est celle du noyau (pas celle, sans objet, du conteneur tué) ; un bloc commencé sans fin est interrompu.
  const interrompue = o.interrompue?.() === true && execution.statut !== "accord-requis";
  if (interrompue) marquerInterrompue(execution);
  // Exécution progressive : sa dernière mémoire sûre est gardée (jamais quand elle s'arrête faute d'accord).
  const memoire = issue.t === "arret" && issue.statut === "accord-requis" ? null : issue.memoire;
  return issue.t === "arret"
    ? conclureSansDonnees(execution, { statut: issue.statut, erreur: issue.erreur, journal }, memoire)
    : // La provenance vient du moteur : `erreurNoyau` absent, le texte a pu être écrit par le code du widget.
      // Interrompue : le message est celui du noyau, pas le texte que le code du widget a pu écrire.
      conclureSansDonnees(
        execution,
        interrompue
          ? { statut: "erreur", erreur: ERREUR_INTERROMPUE, journal }
          : { statut: "erreur", erreur: issue.erreur, erreurWidget: !execution.erreurNoyau, journal },
        memoire,
      );
}

/**
 * Un essai du constructeur : rejoue le workflow du widget depuis le bloc `depart`, en reprenant de l'exécution
 * `origine` la sortie des blocs en amont. Ce que l'essai produit ne touche jamais `etat.json`, `donnees.json` ni
 * `memoire.json` : seule l'exécution `-essai` est gardée (un essai en échec ne montre aucune erreur sur l'accueil). Comme
 * une récolte, un widget avec compte ne tourne qu'avec l'accord de l'utilisateur. Seule exception : un accord perdu à cause de
 * l'essai (périmé au départ, profil refusé, retiré pendant) suit le chemin normal du retrait — tout ce qui a été lu avec
 * part, essai compris, et le widget passe en `accord-requis`.
 */
export async function executerEssai(o: OptionsRecolte & { origine: string; depart: string }): Promise<ResultatEssai> {
  const { id, widget, dossierWidgets } = o;
  if (!ID.test(id) || widget.id !== id) throw new Error(`id de widget invalide : ${id}`);
  const horloge = o.horloge ?? (() => new Date());
  const dossierDonnees = join(dossierWidgets, id);
  const refus = (erreur: string): ResultatEssai => ({ ok: false, erreur });

  const lu = await workflowDuWidget(widget);
  if (lu.t === "absent") return refus(ERREUR_SANS_WORKFLOW);
  if (lu.t !== "ok") return refus(lu.erreur);
  const { valide, declaration } = lu;
  const accord = await accordEnRegle(dossierWidgets, id, declaration);
  if (!accord.peut) {
    // Accord périmé retiré : le widget attend un nouvel accord. Jamais donné : rien n'est écrit.
    if (accord.retire) await marquerAccordRequis(o, accordRequis(declaration));
    return refus(accordRequis(declaration));
  }

  const [origine, anterieures] = await chaineOrigine(dossierDonnees, o.origine);
  const plan = planRejeu(valide, origine, o.depart, anterieures);
  if (!plan.ok) return refus(plan.erreur);
  const precedent = await lireDonnees(dossierWidgets, id);
  const config = declaration.config ?? null;
  const workflow = { blocs: valide.workflow.blocs, liens: valide.workflow.liens, ordre: valide.ordre };
  const rejeu = { relances: plan.relances, sorties: plan.sorties };
  // Un essai a les délais de la durée maximale du widget (une veille doit pouvoir s'essayer), sans jamais être progressif.
  const dureeMaxMinutes = declaration.recolte?.dureeMaxMinutes;
  const { limiteMs } = delaisExecution(dureeMaxMinutes);
  // Mesuré avant tout conteneur, sur la ligne telle qu'elle partira : le récolteur la refuserait, et rien ne doit être écrit.
  const maintenant = horloge().toISOString();
  if (debutTropGros({ precedent, maintenant, config, workflow, rejeu, ...(limiteMs !== undefined ? { limiteMs } : {}) })) {
    return refus(REJEU_TROP_GROS);
  }

  const { issue, execution } = await executerWorkflow(
    {
      proprietaire: { type: "widget", id },
      valide,
      dossierFichiers: widget.dossier,
      config,
      precedent,
      // Un essai ne reçoit ni ne garde aucune mémoire.
      memoire: {},
      ...contexteAccord(dossierWidgets, id, declaration),
      declencheur: "rejeu",
      rejeu: { ...rejeu, repris: plan.repris },
      ...(dureeMaxMinutes !== undefined ? { dureeMaxMinutes } : {}),
    },
    infraDe(o, horloge),
  );
  // Filet de l'exécuteur (la mesure d'ici a dû refuser avant) : un refus, rien d'écrit.
  if (issue.t === "arret" && issue.erreur === REJEU_TROP_GROS) return refus(REJEU_TROP_GROS);

  // L'accord a pu être retiré pendant l'essai, ou pendant son écriture : rien de ce qui a été lu avec ne reste.
  const retire = async () => {
    if (!(await accordRetireDe(dossierWidgets, id, declaration))) return null;
    await supprimerDonnees(dossierWidgets, id);
    const erreur = messageRefus(issue, declaration);
    await marquerAccordRequis(o, erreur);
    return refus(erreur);
  };
  const avant = await retire();
  if (avant) return avant;

  execution.id = idEssai(execution.debut);
  execution.essai = { depart: o.depart, origine: plan.origine };
  if (issue.t !== "fin" && o.interrompue?.() === true && execution.statut !== "accord-requis") marquerInterrompue(execution);
  await ecrireExecution(dossierDonnees, execution);
  const apres = await retire();
  if (apres) return apres;
  return { ok: true, execution: execution.id, statut: execution.statut };
}

/**
 * L'exécution d'origine d'un essai et, quand elle est elle-même un essai, la chaîne de ses origines (bornée) : leurs
 * blocs `repris` y trouvent leur sortie. Une origine élaguée arrête la chaîne.
 */
async function chaineOrigine(dossierDonnees: string, id: string): Promise<[Execution | null, Execution[]]> {
  const origine = await lireExecution(dossierDonnees, id);
  const anterieures: Execution[] = [];
  const vus = new Set([id]);
  let e = origine;
  while (e?.essai && anterieures.length < PROFONDEUR_REJEU - 1 && !vus.has(e.essai.origine)) {
    vus.add(e.essai.origine);
    e = await lireExecution(dossierDonnees, e.essai.origine);
    if (e) anterieures.push(e);
  }
  return [origine, anterieures];
}

/** Le message d'un widget qui attend un nouvel accord : celui du moteur s'il s'est arrêté pour ça (profil refusé…). */
function messageRefus(issue: IssueWorkflow, declaration: DeclarationWidget): string {
  return issue.t === "arret" && issue.statut === "accord-requis" ? issue.erreur : accordRequis(declaration);
}

function ajouter(journal: string, ligne: string): string {
  return ((journal ? journal + "\n" : "") + ligne).slice(-JOURNAL_MAX);
}
