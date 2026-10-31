import { join } from "node:path";
import type { CheminsEspace } from "../chemins.js";
import type { Atelier } from "../conteneur/atelier.js";
import type { AccesIaExecution } from "../ia/repartiteur.js";
import type { PontNavigateur } from "../mcp/pont.js";
import { COMPOSANTS_INTEGRES } from "../pages/catalogue.js";
import { lireComposantsAgent } from "../pages/composants-agent.js";
import { mettreEnPage } from "../pages/mise-en-page.js";
import { accordValide, lireAccords, retirerAccord } from "../widgets/accords.js";
import { chaineOrigine, marquerInterrompue } from "../widgets/recolte.js";
import { message, tronquer } from "../workflows/acces.js";
import {
  ERREUR_MAX,
  MEMOIRE_NON_GARDEE,
  delaisExecution,
  executerWorkflow,
  type ContexteWorkflow,
  type IssueWorkflow,
  type LanceurProcessus,
  type TraceDirecte,
} from "../workflows/executer.js";
import { ecrireExecution, idEssai, type Execution } from "../workflows/executions.js";
import type { Menagement } from "../workflows/menagement.js";
import { avecMemoire, ecrireMemoire, lireMemoire } from "../workflows/memoire.js";
import { debutTropGros } from "../workflows/protocole.js";
import { REJEU_TROP_GROS, planRejeu } from "../workflows/rejeu.js";
import type { Proprietaire } from "../workflows/schema.js";
import { ecrireResultat, supprimerDonneesAction } from "./donnees.js";
import { lireAction, workflowDeLAction } from "./lire.js";
import type { DeclarationAction } from "./schemas.js";

export const ACTION_INCONNUE = "Action inconnue";
export const saisieRequise = (libelle: string) => `Saisie requise : ${libelle}`;
/** Même texte que pour un widget. */
export const accordRequisAction = (d: DeclarationAction) => `Accord requis pour lire avec ton compte : ${d.sources.compte.join(", ")}`;
export const ACTION_SANS_WORKFLOW = "Cette action n'a pas de workflow.json";
export const RESULTAT_TROP_GROS = "Résultats trop gros pour être gardés";
/** Longueur maximale de la saisie gardée (celle d'`Execution.saisie`). */
export const SAISIE_MAX = 200;

/** L'issue d'un lancement : `invalide` quand rien n'a tourné (action inconnue, workflow invalide, saisie absente…). */
export type ResultatLancement = { statut: Execution["statut"] | "invalide"; execution?: string; erreur?: string; erreurNoyau?: true };

export interface OptionsAction {
  id: string;
  chemins: CheminsEspace;
  /** Exécutions, résultats, mémoire et accords des actions, hors de l'espace (`<profil>/actions`). */
  dossierActions: string;
  moteur: string;
  atelier: Pick<Atelier, "commandeRecolte" | "supprimerRecolte">;
  lancer?: LanceurProcessus;
  pont: PontNavigateur;
  /** L'accès de cette exécution à l'IA locale (prioritaire), pour les blocs et la mise en page ; null sans IA. */
  ia: AccesIaExecution | null;
  horloge?: () => Date;
  saisie: string | null;
  declencheur: Execution["declencheur"];
  /** « Arrêter » : levé pendant le workflow, l'exécution est interrompue ; pendant la mise en page, celle de secours. */
  signal: AbortSignal;
  surTrace(t: TraceDirecte): void;
  surEtape(e: "mise-en-page"): void;
  /** Un essai du constructeur : rejoue depuis `depart` avec les sorties amont de l'exécution `origine`. */
  essai?: { origine: string; depart: string };
  /** Vrai quand le noyau s'arrête : l'exécution est alors « interrompue » par WebAiOs, pas par l'utilisateur. */
  interrompue?: () => boolean;
  adressesLocales?: boolean;
  menagement?: Menagement;
  urlRecherche?: string;
  delaiMiseEnPageMs?: number;
}

/** La saisie telle qu'elle est gardée et envoyée : sans espaces autour, `SAISIE_MAX` caractères au plus ; null si vide. */
export function couperSaisie(saisie: string | null | undefined): string | null {
  let s = (saisie ?? "").trim().slice(0, SAISIE_MAX);
  // Pas de moitié de caractère au bout.
  if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
  s = s.trimEnd();
  return s === "" ? null : s;
}

const refus = (erreur: string, noyau = true): ResultatLancement => ({ statut: "invalide", erreur, ...(noyau ? { erreurNoyau: true as const } : {}) });

/** Comme `accordEnRegle` des widgets : un accord périmé est retiré, et ce qui a été lu avec effacé. */
async function accordEnRegle(dossierActions: string, id: string, d: DeclarationAction): Promise<boolean> {
  const enregistre = (await lireAccords(dossierActions))[id];
  if (enregistre !== undefined && !accordValide(d, enregistre)) {
    await retirerAccord(dossierActions, id);
    await supprimerDonneesAction(dossierActions, id);
  }
  return d.sources.compte.length === 0 || accordValide(d, (await lireAccords(dossierActions))[id]);
}

/**
 * Lance une action : son workflow dans le conteneur, puis la mise en page de son résultat par Gemma (de secours sans
 * elle). Gardés, dans l'ordre : l'exécution, le résultat, la mémoire (jamais pour un essai). Rien n'est écrit quand
 * l'action n'a pas pu tourner. Pour une action avec compte, l'accord est relu après chaque écriture : retiré, tout ce
 * qui a été lu avec part. Une action dont le dossier a disparu pendant ne garde rien.
 */
export async function executerAction(o: OptionsAction): Promise<ResultatLancement> {
  const { id, chemins, dossierActions } = o;
  const horloge = o.horloge ?? (() => new Date());
  const action = await lireAction(chemins, id);
  if (!action) return refus(ACTION_INCONNUE);
  // L'erreur de lecture d'action.json en cite le contenu (noms de clés) : elle n'est pas un texte fixe du noyau.
  if ("erreur" in action) return refus(action.erreur, false);
  const wf = await workflowDeLAction(action);
  if (wf.t === "absent") return refus(ACTION_SANS_WORKFLOW);
  if (wf.t !== "ok") return refus(tronquer(wf.erreur, ERREUR_MAX), wf.t !== "illisible");
  const { valide } = wf;
  const { declaration } = action;
  const dossierDonnees = join(dossierActions, id);
  const proprietaire: Proprietaire = { type: "action", id };

  // Un essai reprend les sorties amont d'une exécution : sa saisie aussi, à défaut d'une nouvelle.
  const rejeu = o.essai ? await chaineOrigine(dossierDonnees, o.essai.origine) : null;
  const saisie = declaration.saisie ? couperSaisie(o.saisie ?? rejeu?.[0]?.saisie ?? null) : null;
  if (declaration.saisie && saisie === null) return refus(saisieRequise(declaration.saisie.libelle));

  if (!(await accordEnRegle(dossierActions, id, declaration))) {
    return { statut: "accord-requis", erreur: accordRequisAction(declaration), erreurNoyau: true };
  }

  let plan: Extract<ReturnType<typeof planRejeu>, { ok: true }> | null = null;
  if (o.essai && rejeu) {
    const p = planRejeu(valide, rejeu[0], o.essai.depart, rejeu[1]);
    if (!p.ok) return refus(p.erreur);
    const { limiteMs } = delaisExecution(declaration.dureeMaxMinutes);
    const workflow = { blocs: valide.workflow.blocs, liens: valide.workflow.liens, ordre: valide.ordre };
    const debut = {
      precedent: null,
      maintenant: horloge().toISOString(),
      config: null,
      workflow,
      rejeu: { relances: p.relances, sorties: p.sorties },
      ...(limiteMs !== undefined ? { limiteMs } : {}),
      ...(saisie !== null ? { saisie } : {}),
      avancement: true as const,
    };
    if (debutTropGros(debut)) return refus(REJEU_TROP_GROS);
    plan = p;
  }

  const contexteAccord: Pick<ContexteWorkflow, "accord" | "surProfilRefuse" | "messageAccordRequis" | "sources"> = {
    sources: declaration.sources,
    async accord() {
      const a = (await lireAccords(dossierActions))[id];
      return accordValide(declaration, a) ? { profil: a.profil } : null;
    },
    async surProfilRefuse() {
      await retirerAccord(dossierActions, id);
      await supprimerDonneesAction(dossierActions, id);
    },
    messageAccordRequis: accordRequisAction(declaration),
  };
  const dureeMaxMinutes = declaration.dureeMaxMinutes;
  const { issue, execution } = await executerWorkflow(
    {
      proprietaire,
      valide,
      dossierFichiers: action.dossier,
      config: null,
      precedent: null,
      // Un essai ne reçoit ni ne garde aucune mémoire.
      memoire: plan ? {} : await lireMemoire(dossierDonnees),
      ...contexteAccord,
      declencheur: o.declencheur,
      ...(plan ? { rejeu: { relances: plan.relances, sorties: plan.sorties, repris: plan.repris } } : {}),
      ...(dureeMaxMinutes !== undefined ? { dureeMaxMinutes } : {}),
      ...(saisie !== null ? { saisie } : {}),
      avancement: true,
      signal: o.signal,
    },
    {
      moteur: o.moteur,
      atelier: o.atelier,
      ...(o.lancer ? { lancer: o.lancer } : {}),
      ia: o.ia,
      pont: o.pont,
      horloge,
      surTrace: o.surTrace,
      ...(o.adressesLocales ? { adressesLocales: true } : {}),
      ...(o.menagement ? { menagement: o.menagement } : {}),
      ...(o.urlRecherche !== undefined ? { urlRecherche: o.urlRecherche } : {}),
    },
  );
  if (issue.t === "arret" && issue.erreur === REJEU_TROP_GROS) return refus(REJEU_TROP_GROS);
  if (plan && o.essai) {
    execution.id = idEssai(execution.debut);
    execution.essai = { depart: o.essai.depart, origine: plan.origine };
  }

  const accordRetire = async () => declaration.sources.compte.length > 0 && !accordValide(declaration, (await lireAccords(dossierActions))[id]);
  const presente = async () => (await lireAction(chemins, id)) !== null;
  /** Ce qui a été lu avec le compte part avec l'accord ; une action disparue ne garde rien. */
  const perdue = async (): Promise<ResultatLancement | null> => {
    if (await accordRetire()) {
      await supprimerDonneesAction(dossierActions, id);
      return { statut: "accord-requis", erreur: messageRefus(issue, declaration), erreurNoyau: true };
    }
    if (!(await presente())) {
      await supprimerDonneesAction(dossierActions, id).catch(() => {});
      return refus(ACTION_INCONNUE);
    }
    return null;
  };
  const avant = await perdue();
  if (avant) return avant;

  const conclusion = (): ResultatLancement => ({
    statut: execution.statut,
    execution: execution.id,
    ...(execution.erreur !== undefined ? { erreur: execution.erreur } : {}),
    ...(execution.erreurNoyau ? { erreurNoyau: true as const } : {}),
  });

  if (issue.t !== "fin") {
    if (o.interrompue?.() === true && execution.statut !== "accord-requis") marquerInterrompue(execution);
    await ecrireExecution(dossierDonnees, execution);
    return (await perdue()) ?? conclusion();
  }

  o.surEtape("mise-en-page");
  const resultats = issue.sortie.valeur;
  const catalogue = [...COMPOSANTS_INTEGRES, ...(await lireComposantsAgent(chemins.composants)).valides];
  const page = await mettreEnPage({
    resultats,
    consigne: declaration.miseEnPage ?? null,
    catalogue,
    ia: o.ia,
    signal: o.signal,
    ...(o.delaiMiseEnPageMs !== undefined ? { delaiMs: o.delaiMiseEnPageMs } : {}),
  });
  const pendant = await perdue();
  if (pendant) return pendant;

  await ecrireExecution(dossierDonnees, execution);
  try {
    await ecrireResultat(dossierActions, id, { version: 1, execution: execution.id, saisie, resultats, plan: page.plan, secours: page.secours, vide: page.vide });
  } catch (e) {
    // Trop gros (ou disque) : l'exécution échoue côté noyau, sans résultat.
    console.error(`[webaios] résultat de l'action ${id} :`, message(e));
    execution.statut = "echouee";
    execution.erreur = RESULTAT_TROP_GROS;
    execution.erreurNoyau = true;
    await ecrireExecution(dossierDonnees, execution);
    return (await perdue()) ?? conclusion();
  }
  const apresResultat = await perdue();
  if (apresResultat) return apresResultat;

  if (!plan && issue.memoire) {
    const gardee = await avecMemoire(dossierDonnees, async () => (await accordRetire()) || (await ecrireMemoire(dossierDonnees, issue.memoire!)));
    if (!gardee) {
      execution.blocs.find((b) => b.id === valide.sortie.id)?.journal.push(MEMOIRE_NON_GARDEE);
      await ecrireExecution(dossierDonnees, execution);
    }
  }
  return (await perdue()) ?? conclusion();
}

/** Le message d'une action qui attend un nouvel accord : celui du moteur s'il s'est arrêté pour ça (profil refusé…). */
function messageRefus(issue: IssueWorkflow, d: DeclarationAction): string {
  return issue.t === "arret" && issue.statut === "accord-requis" ? issue.erreur : accordRequisAction(d);
}

