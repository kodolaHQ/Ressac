import { join } from "node:path";
import { ecrireDonnees, ecrireEtatWidget, lireDonnees, lireEtatWidget, modifierEtatWidget, supprimerDonnees } from "../accueil/donnees.js";
import type { DeclarationWidget, EtatWidget, WidgetLu } from "../accueil/schemas.js";
import type { Atelier } from "../conteneur/atelier.js";
import type { IaLocale } from "../ia/ia-locale.js";
import type { PontNavigateur } from "../mcp/pont.js";
import { accordValide, lireAccords, retirerAccord } from "./accords.js";
import { message, tronquer } from "../workflows/acces.js";
import {
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

// Moved into the workflow engine; re-exported for the modules and tests that take them here.
export { adresseLocale } from "../workflows/acces.js";
export { PROFIL_REFUSE, lancerParDefaut, type LanceurProcessus, type ProcessusRecolte } from "../workflows/executer.js";

export interface OptionsRecolte {
  id: string;
  widget: WidgetLu;
  dossierWidgets: string;
  /** Folder of the workflow engine on the Mac (`docker/moteur`), mounted read-only in the container. */
  moteur: string;
  atelier: Pick<Atelier, "commandeRecolte" | "supprimerRecolte">;
  lancer?: LanceurProcessus;
  /** null: no local AI, `kev` and `gemma` answer with an error. */
  ia: Pick<IaLocale, "kev" | "gemma"> | null;
  pont: PontNavigateur;
  horloge?: () => Date;
  /** Kernel-side timeout; the container stops by itself after 180 s (+5 s). */
  delaiMs?: number;
  /** Called after each write of the widget's state or data (refresh the display). */
  surChange?: () => void;
  /** Tests only: allows `recuperer` and `lirePage` to local addresses (127.0.0.1…). */
  adressesLocales?: boolean;
  /** What launched the run (default: the schedule). */
  declencheur?: Execution["declencheur"];
  /** True when the kernel is stopping: a run that did not finish is then « interrompue », not « échouée ». */
  interrompue?: () => boolean;
  /** Each accepted trace, live (the builder follows the blocks); must return control right away. */
  surTrace?: (t: TraceDirecte) => void;
  /** Pacing of the searches and open reads, shared by all the kernel's runs. */
  menagement?: Menagement;
  /** Tests only: the base of the DuckDuckGo searches. */
  urlRecherche?: string;
}

/**
 * Outcome of a builder try: `ok` as soon as it ran (even failing, its run says so); otherwise, the reason
 * for the refusal (nothing was written, no container launched or nothing kept from it).
 */
export type ResultatEssai = { ok: true; execution: string; statut: Execution["statut"] } | { ok: false; erreur: string };

/**
 * `execution`: the id of the written run (none when nothing ran, or when the grant was withdrawn meanwhile).
 * `nouveaux`: only for a finishing run of a `recolte.notifier` widget, the number of items that were
 * not in the data from before the run.
 */
export type ResultatRecolte = { etat: EtatWidget; donnees?: unknown; execution?: string; nouveaux?: number };

const ID = /^[a-z0-9-]+$/;

export const accordRequis = (d: DeclarationWidget) => `Accord requis pour lire avec ton compte : ${d.sources.compte.join(", ")}`;
export const ERREUR_ATELIER_ARRETE = "Mise à jour impossible : atelier arrêté";
export const ERREUR_RECOLTE_INTERNE = "Mise à jour impossible : erreur interne du navigateur";
export const ERREUR_SANS_WORKFLOW = "Ce widget n'a ni workflow.json ni recolte.mjs";
export const ERREUR_INTERROMPUE = "Interrompue : WebAiOs s'est arrêté";

/** Fixed error messages written by the kernel; any other error text may have been written by the widget. */
const ERREURS_FIXES = new Set([
  "Délai dépassé",
  "Réponse trop grande",
  PROFIL_REFUSE,
  ERREUR_ATELIER_ARRETE,
  ERREUR_RECOLTE_INTERNE,
  ERREUR_SANS_WORKFLOW,
  ERREUR_INTERROMPUE,
  // Old message, still in states written before the workflows.
  "Ce widget n'a pas de recolte.mjs",
  "Données trop grosses (2 Mo au plus)",
]);
const echapper = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ERREURS_MOTIFS = [
  // The declared domains only have [a-z0-9.-]; the message may have been truncated (« … »).
  /^Accord requis pour lire avec ton compte : [a-z0-9., -]*…?$/,
  // Written by the validation of workflow.json (drafted by the agent), never by the container. A widget can throw the same
  // text: it is then `erreurNoyau` (absent) that says so.
  new RegExp(`^${echapper(PREFIXE_WORKFLOW_INVALIDE)}`),
];

/**
 * Does the error come from the kernel, without anything the widget could have written? For a widget that reads with the user's account,
 * only such an error (and marked `erreurNoyau` in the state) is shown to the agent without a grant.
 */
export function erreurDuNoyau(erreur: string): boolean {
  return ERREURS_FIXES.has(erreur) || ERREURS_MOTIFS.some((m) => m.test(erreur));
}

/** A widget's workflow: `workflow.json`, or `recolte.mjs` alone (implicit workflow). */
type WorkflowDuWidget =
  | { t: "ok"; valide: WorkflowValide; declaration: DeclarationWidget }
  /** The widget is unreadable: its error may quote its files. */
  | { t: "illisible"; erreur: string }
  | { t: "absent" }
  /** workflow.json half-written, unknown block, cycle… (validator message, truncated). */
  | { t: "invalide"; erreur: string };

/** What the widget's declaration changes to the rules of its workflow. */
export function contexteValidation(d: DeclarationWidget): ContexteValidation {
  return { web: d.sources.web, dureeMaxMinutes: d.recolte?.dureeMaxMinutes ?? null, proprietaire: "widget", saisie: false };
}

async function workflowDuWidget(widget: WidgetLu): Promise<WorkflowDuWidget> {
  if ("erreur" in widget) return { t: "illisible", erreur: widget.erreur };
  const lu = await lireWorkflow(widget.dossier, contexteValidation(widget.declaration));
  if (!lu) return { t: "absent" };
  if (!lu.resultat.ok) return { t: "invalide", erreur: tronquer(lu.resultat.erreur, ERREUR_MAX) };
  return { t: "ok", valide: lu.resultat.valide, declaration: widget.declaration };
}

/**
 * A grant that no longer holds for the current declaration (domains changed, account removed) is withdrawn, and what was
 * read with it erased (data, runs, memory): nothing passes to the next harvest nor, later, to the agent.
 * `peut`: the widget may run (without account, or with a valid grant, which also covers its public domains);
 * `retire`: an expired grant has just been withdrawn.
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
 * The grant has just been lost outside a harvest (during a try): like `refuserAccord`, the widget goes into waiting
 * for a grant (dates kept) and the display is notified. Already waiting for a grant: nothing is rewritten.
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

/** What a widget's run asks about its grant (re-read at each read with an account). */
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
    // The grant is withdrawn before the stop: when the run concludes, it no longer exists. What was read with this account goes
    // with it (the widget shows its example until the new grant).
    async surProfilRefuse() {
      await retirerAccord(dossierWidgets, id);
      await supprimerDonnees(dossierWidgets, id);
    },
    messageAccordRequis: accordRequis(declaration),
  };
}

/** Has the grant been withdrawn (refuserAccord erases everything)? Always false for a widget without an account. */
async function accordRetireDe(dossierWidgets: string, id: string, declaration: DeclarationWidget): Promise<boolean> {
  return declaration.sources.compte.length > 0 && !accordValide(declaration, (await lireAccords(dossierWidgets))[id]);
}

/** What the infrastructure receives from the options of a harvest or a try. */
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

/** Kernel stop: the run did not fail, it is interrupted; a block started without an end is interrupted. */
export function marquerInterrompue(execution: Execution): void {
  execution.statut = "interrompue";
  execution.erreur = ERREUR_INTERROMPUE;
  execution.erreurNoyau = true;
  execution.blocs = execution.blocs.map((b) => (b.debut !== null && b.fin === null ? { ...b, statut: "interrompu" } : b));
}

/** Status and error from before a run (those from before the previous one, if it did not finish itself). */
function etatAvantExecution(e: EtatWidget): NonNullable<EtatWidget["avant"]> {
  if (e.statut === "en-cours") return e.avant ?? { statut: "ok" };
  return { statut: e.statut, ...(e.erreur !== undefined ? { erreur: e.erreur } : {}), ...(e.erreurNoyau ? { erreurNoyau: true as const } : {}) };
}

/**
 * A widget's harvest: the run of its workflow (`workflow.json`, or `recolte.mjs` alone, as an implicit workflow)
 * by the engine, which writes nothing. Here, what is kept: `etat.json` (en-cours at the start), and depending on the outcome
 * `donnees.json`, `memoire.json` and the run. For a widget with an account, the grant is re-read after each write:
 * withdrawn, everything read with it goes (data, runs, memory) and the widget waits for a new grant.
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
  // The previous state, kept during the run: restored at the next startup if WebAiOs stops abruptly.
  const avant = etatAvantExecution(precedent);
  await ecrireEtatWidget(dossierWidgets, id, { statut: "en-cours", derniereMaj: precedent.derniereMaj, derniereTentative: debut, avant });
  o.surChange?.();

  /** `erreurWidget`: the error text comes from the widget or the container (otherwise, it is written by the kernel). */
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
  /** A run that the kernel stopped before any container: its blocks are not launched. */
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
  // The widget's read error may quote its files: it counts as written by the widget.
  if (lu.t === "illisible") return conclure({ statut: "erreur", erreur: lu.erreur, erreurWidget: true });
  if (lu.t === "absent") return conclure({ statut: "erreur", erreur: ERREUR_SANS_WORKFLOW });
  // workflow.json half-written, unknown block, cycle…: no container is launched, the data stays.
  if (lu.t === "invalide") return conclure({ statut: "erreur", erreur: lu.erreur, execution: await sansConteneur("echouee", lu.erreur, []) });
  const { valide, declaration } = lu;
  // A widget that reads with the user's account only runs with their grant (an expired grant is withdrawn, with its data).
  if (!(await accordEnRegle(dossierWidgets, id, declaration)).peut) {
    const erreur = accordRequis(declaration);
    // Already waiting for a grant at the last run: not one more at each scheduling (they would push
    // the history of the real runs out), the last one stands in. Tries do not count.
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

  // The grant may have been withdrawn during the run (refuserAccord erases everything), or during a write from here (it may have
  // come after the erasure): nothing read with it remains, not even the run.
  const accordRetire = () => accordRetireDe(dossierWidgets, id, declaration);
  /** A run's memory, under the widget's memory lock, if the grant holds; false if too big. */
  const garderMemoire = (m: MemoireBlocs) =>
    avecMemoire(dossierDonnees, async () => (await accordRetire()) || (await ecrireMemoire(dossierDonnees, m)));

  // Progressive run (the engine relays nothing to the others): each accepted publication is written right away,
  // with the progress in the state; the safe memory received along the way too. The engine does these relays one
  // after the other and waits for all of them before returning: the final output, written afterwards, is never overwritten.
  // Grant withdrawn (widget with an account): what was published goes, and nothing more is written along the way.
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
    // Only on top of this run's en-cours: an accord-requis written in the meantime (refuserAccord) stays.
    await modifierEtatWidget(dossierWidgets, id, (e) =>
      e.statut === "en-cours" ? { statut: "en-cours", derniereMaj: precedent.derniereMaj, derniereTentative: debut, progression, avant } : null,
    );
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
  // The relays are all finished (the engine waits for them): nothing more is written along the way.
  relaisFermes = true;
  let journal = journalExecution;

  const refusee = async () => {
    await supprimerDonnees(dossierWidgets, id);
    return conclure({ statut: "accord-requis", erreur: messageRefus(issue, declaration) });
  };
  /**
   * Failure or stop: the run is written; the data (previous, or published along the way) stays. The
   * previous memory stays, except for a progressive run that returns its last safe memory (`memoire`).
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
      // Data refused (too big…): the previous ones stay, the run fails kernel-side.
      execution.statut = "echouee";
      execution.erreur = tronquer(message(e), ERREUR_MAX);
      execution.erreurNoyau = true;
      return conclureSansDonnees(execution, { statut: "erreur", erreur: execution.erreur, journal });
    }
    if (await accordRetire()) return refusee();
    if (issue.memoire) {
      if (!(await garderMemoire(issue.memoire))) {
        journal = ajouter(journal, MEMOIRE_NON_GARDEE);
        // Also in the run, in the output block's log.
        execution.blocs.find((b) => b.id === valide.sortie.id)?.journal.push(MEMOIRE_NON_GARDEE);
      }
      if (await accordRetire()) return refusee();
    }
    await ecrireExecution(dossierDonnees, execution);
    if (await accordRetire()) return refusee();
    const ok = await conclure({ statut: "ok", donnees: issue.sortie.valeur, journal, execution: execution.id });
    // Withdrawn during the state write: « ok » must not overwrite the accord-requis written by refuserAccord.
    if (await accordRetire()) return refusee();
    // Counted against the data from before the run (those published along the way are not in it).
    if (declaration.recolte?.notifier === true) return { ...ok, nouveaux: compterNouveaux(donneesAvant, issue.sortie.valeur) };
    return ok;
  }

  // Kernel stop (exit, profile change): the run did not fail, it is interrupted.
  // Its error is the kernel's (not the irrelevant one of the killed container); a block started without an end is interrupted.
  const interrompue = o.interrompue?.() === true && execution.statut !== "accord-requis";
  if (interrompue) marquerInterrompue(execution);
  // Progressive run: its last safe memory is kept (never when it stops for lack of a grant).
  const memoire = issue.t === "arret" && issue.statut === "accord-requis" ? null : issue.memoire;
  return issue.t === "arret"
    ? conclureSansDonnees(execution, { statut: issue.statut, erreur: issue.erreur, journal }, memoire)
    : // The provenance comes from the engine: `erreurNoyau` absent, the text may have been written by the widget's code.
      // Interrupted: the message is the kernel's, not the text the widget's code may have written.
      conclureSansDonnees(
        execution,
        interrompue
          ? { statut: "erreur", erreur: ERREUR_INTERROMPUE, journal }
          : { statut: "erreur", erreur: issue.erreur, erreurWidget: !execution.erreurNoyau, journal },
        memoire,
      );
}

/**
 * A builder try: replays the widget's workflow from block `depart`, taking from run
 * `origine` the output of the upstream blocks. What the try produces never touches `etat.json`, `donnees.json` nor
 * `memoire.json`: only the `-essai` run is kept (a failed try shows no error on the home). Like
 * a harvest, a widget with an account only runs with the user's grant. Only exception: a grant lost because of
 * the try (expired at the start, profile refused, withdrawn meanwhile) follows the normal withdrawal path — everything read with it
 * goes, try included, and the widget goes to `accord-requis`.
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
    // Expired grant withdrawn: the widget waits for a new grant. Never given: nothing is written.
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
  // A try has the delays of the widget's maximum duration (a watch must be tryable), without ever being progressive.
  const dureeMaxMinutes = declaration.recolte?.dureeMaxMinutes;
  const { limiteMs } = delaisExecution(dureeMaxMinutes);
  // Measured before any container, on the line as it will go out: the harvester would refuse it, and nothing must be written.
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
      // A try neither receives nor keeps any memory.
      memoire: {},
      ...contexteAccord(dossierWidgets, id, declaration),
      declencheur: "rejeu",
      rejeu: { ...rejeu, repris: plan.repris },
      ...(dureeMaxMinutes !== undefined ? { dureeMaxMinutes } : {}),
    },
    infraDe(o, horloge),
  );
  // The executor's safety net (the measure here must have refused before): a refusal, nothing written.
  if (issue.t === "arret" && issue.erreur === REJEU_TROP_GROS) return refus(REJEU_TROP_GROS);

  // The grant may have been withdrawn during the try, or during its write: nothing read with it remains.
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
 * The original run of a try and, when it is itself a try, the chain of its origins (bounded): their
 * `repris` blocks find their output there. A pruned origin stops the chain.
 */
export async function chaineOrigine(dossierDonnees: string, id: string): Promise<[Execution | null, Execution[]]> {
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

/** The message of a widget waiting for a new grant: the engine's if it stopped for that (profile refused…). */
function messageRefus(issue: IssueWorkflow, declaration: DeclarationWidget): string {
  return issue.t === "arret" && issue.statut === "accord-requis" ? issue.erreur : accordRequis(declaration);
}

function ajouter(journal: string, ligne: string): string {
  return ((journal ? journal + "\n" : "") + ligne).slice(-JOURNAL_MAX);
}
