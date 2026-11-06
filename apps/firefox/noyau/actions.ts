import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  ACTION_INCONNUE,
  chainesDe,
  ID_ACTION,
  ID_EXECUTION,
  lireAccords,
  lireAction,
  lireActions,
  lireExecution,
  lireResultat,
  listerExecutions,
  retirerAccord,
  supprimerDonneesAction,
  type ActionLue,
  type CheminsEspace,
  type EtatActions,
  type Execution,
  type Noyau,
  type PageAction,
  type ResultatLancement,
  type ResumeExecution,
} from "../../../packages/noyau/src/index.ts";
import type { ActionAffichee } from "../../navigateur/src/commun/actions.ts";
import { urlOuvrable } from "../ui/accueil-profils.ts";

// Copies of Electron's schemas (commun/api.ts, which cannot load in the host): drift test in test/actions-host.test.ts.
export const SchemaIdAction = z.string().regex(/^[a-z0-9-]{1,60}$/);
export const SchemaSaisieAction = z.string().max(2000).nullable();
const domaine = z.string().min(1).max(253);
export const SchemaAccord = z
  .object({ id: z.string().regex(/^[a-z0-9-]+$/).max(100), profil: z.string().min(1).max(200), compte: z.array(domaine).max(100), publiques: z.array(domaine).max(100) })
  .strict();
type Accord = z.infer<typeof SchemaAccord>;

// The disk and noyau half of Electron's main/agent/actions.ts, which cannot load here (it imports electron).
// Drift tests in test/actions-host.test.ts.

export const MESSAGE_SANS_NOYAU = "Le service des actions ne répond pas (agent arrêté ?)";
const NO_ACTION: EtatActions = { courantes: [], enAttente: [] };

/** Electron's adresseImagePermise: https only, never the machine. Keep in sync with chrome/store/action-media.ts. */
const imageAddressAllowed = (url: string) => url.startsWith("https://") && urlOuvrable(url);

/**
 * The refusal half of Electron's repondreImage, up to the load: a result image is fetched only for a current action
 * without account, a kept run, and an https address present as is in its results, with no accord for the account.
 */
export async function actionImageAllowed(
  o: { dossierActions: string; lireAction: (id: string) => Promise<ActionLue | null> },
  id: string,
  execution: string,
  url: string,
): Promise<boolean> {
  if (!ID_ACTION.test(id) || execution.length > 64 || !ID_EXECUTION.test(execution) || !url || !imageAddressAllowed(url)) return false;
  const action = await o.lireAction(id);
  if (!action || "erreur" in action || action.declaration.sources.compte.length > 0) return false;
  // An action rewritten without account may keep results read with it: an accord still there is enough to refuse.
  const accords = await lireAccords(o.dossierActions).catch(() => null);
  if (!accords || Object.hasOwn(accords, id)) return false;
  const [resultat, exec] = await Promise.all([lireResultat(o.dossierActions, id, execution), lireExecution(join(o.dossierActions, id), execution)]);
  return !!resultat && !!exec && chainesDe(resultat.resultats).has(url);
}

/** A link of an action's page opens only if its address is, as is, in the run's results, in http(s). */
export async function linkAllowed(dossierActions: string, id: string, execution: string, url: string): Promise<boolean> {
  if (!urlOuvrable(url)) return false;
  const r = await lireResultat(dossierActions, id, execution);
  return !!r && chainesDe(r.resultats).has(url);
}

/** The action's folder goes to actions/.corbeille (nothing is destroyed), then `oublier` drops its accord and data. */
export async function trashAction(c: CheminsEspace, id: string, oublier: (id: string) => Promise<void>): Promise<void> {
  if (!ID_ACTION.test(id)) throw new Error(`id d'action invalide : ${id}`);
  const corbeille = join(c.actions, ".corbeille");
  await mkdir(corbeille, { recursive: true });
  await rename(join(c.actions, id), join(corbeille, `${id}-${Date.now()}`));
  await oublier(id);
}

/** The disk's actions, ready to show: declaration, accord and last real run. Read without the noyau. */
export async function readShownActions(c: CheminsEspace, dossierActions: string): Promise<ActionAffichee[]> {
  const [lues, accords] = await Promise.all([lireActions(c), lireAccords(dossierActions).catch(() => ({}) as Record<string, unknown>)]);
  return Promise.all(
    lues.map(async (a): Promise<ActionAffichee> => {
      const derniere = (await listerExecutions(join(dossierActions, a.id))).find((e) => !e.essai && !e.id.endsWith("-essai"));
      const dernier = derniere ? { execution: derniere.id, debut: derniere.debut, statut: derniere.statut } : null;
      if ("erreur" in a) return { id: a.id, nom: a.id, description: "", motsCles: [], saisie: null, compte: [], publiques: [], accord: false, dernier, erreur: a.erreur };
      const d = a.declaration;
      return {
        id: a.id,
        nom: d.nom,
        description: d.description,
        motsCles: d.motsCles,
        saisie: d.saisie ?? null,
        compte: d.sources.compte,
        publiques: d.sources.publiques,
        accord: Object.hasOwn(accords, a.id),
        dernier,
      };
    }),
  );
}

type Prepared = { ok: true; nom: string; lancer: boolean } | { ok: false; erreur: string };

/** Electron's creerServiceActions without the window state (private spaces, tabs, links' pace: the chrome's) and `agir`. */
export function createActionsHost(o: {
  chemins: CheminsEspace;
  dossierActions: string;
  noyau: () => Noyau | null;
  /** A launch refused without a run written was just noted: the actions pages read again. */
  surChange: () => void;
  maintenant?: () => number;
}) {
  const now = o.maintenant ?? Date.now;
  /** Per action, the last launch refused without writing anything: the page cannot read it on disk, `liste` gives it. */
  const refusLancement = new Map<string, { erreur: string; quand: string }>();
  // Kept on disk next to the runs: a refusal survives a restart.
  const fichierRefus = join(o.dossierActions, "refus-lancement.json");
  const charge = readFile(fichierRefus, "utf8").then(
    (t) => {
      const lu: unknown = JSON.parse(t);
      if (typeof lu !== "object" || lu === null) return;
      for (const [id, v] of Object.entries(lu)) {
        const { erreur, quand } = (v ?? {}) as { erreur?: unknown; quand?: unknown };
        if (typeof erreur === "string" && typeof quand === "string") refusLancement.set(id, { erreur, quand });
      }
    },
    () => {},
  );
  let ecriture = Promise.resolve();
  const enregistrerRefus = () => {
    const t = JSON.stringify(Object.fromEntries(refusLancement));
    ecriture = ecriture
      .then(() => mkdir(o.dossierActions, { recursive: true }))
      .then(() => writeFile(fichierRefus, t))
      .catch((e) => console.error("[webaios] refus des actions non enregistrés :", e));
  };
  /** Followed launches, per action: a deletion forgets them, their end notes nothing (action made again under the same id). */
  const lancementsSuivis = new Map<string, Set<Promise<ResultatLancement>>>();
  const suivreLancement = (id: string, fin: Promise<ResultatLancement>): Promise<ResultatLancement> => {
    const pret = charge.then(() => refusLancement.delete(id) && enregistrerRefus());
    const suivis = lancementsSuivis.get(id) ?? new Set();
    lancementsSuivis.set(id, suivis.add(fin));
    return fin.then(async (r) => {
      await pret;
      const suivi = lancementsSuivis.get(id)?.delete(fin) ?? false;
      if (lancementsSuivis.get(id)?.size === 0) lancementsSuivis.delete(id);
      if (suivi && !r.execution) {
        refusLancement.set(id, { erreur: r.erreur ?? "L'action n'a pas pu être lancée", quand: new Date(now()).toISOString() });
        enregistrerRefus();
        o.surChange();
      }
      return r;
    });
  };
  const lire = (id: string) => lireAction(o.chemins, id);
  const nomDe = (a: ActionLue) => ("erreur" in a ? a.id : a.declaration.nom);
  let actionsCourantes = new Set<string>();
  return {
    async liste(): Promise<ActionAffichee[]> {
      await charge;
      return (await readShownActions(o.chemins, o.dossierActions)).map((a) => {
        const r = refusLancement.get(a.id);
        return r && (!a.dernier || a.dernier.debut < r.quand) ? { ...a, refus: r.erreur } : a;
      });
    },
    /** Reads the action without launching it: `lancer` says whether the chrome should launch it after opening its page. */
    async preparer(id: string, saisie: string | null): Promise<Prepared> {
      const noyau = o.noyau();
      if (!noyau) return { ok: false, erreur: MESSAGE_SANS_NOYAU };
      const a = await lire(id);
      if (!a) return { ok: false, erreur: ACTION_INCONNUE };
      const d = noyau.actions.direct();
      const tourne = d.courantes.some((x) => x.action === id) || d.enAttente.some((x) => x.action === id);
      // Required input missing: the page opens with its field to fill, nothing is launched.
      const saisieManque = !("erreur" in a) && !!a.declaration.saisie && !saisie?.trim();
      return { ok: true, nom: nomDe(a), lancer: !tourne && !saisieManque };
    },
    /** The action's name for « Voir le workflow », read without the noyau. */
    async nom(id: string): Promise<string | null> {
      const a = await lire(id);
      return a ? nomDe(a).slice(0, 60) : null;
    },
    async lancer(id: string, saisie: string | null): Promise<ResultatLancement> {
      const noyau = o.noyau();
      if (!noyau) return { statut: "invalide", erreur: MESSAGE_SANS_NOYAU };
      return suivreLancement(id, noyau.actions.lancer(id, { ...(saisie?.trim() ? { saisie } : {}), declencheur: "manuelle" }).fin);
    },
    arreter(id: string): void {
      o.noyau()?.actions.arreter(id);
    },
    async page(id: string, execution: string | null): Promise<PageAction | null> {
      return (await o.noyau()?.actions.page(id, execution)) ?? null;
    },
    async executions(id: string): Promise<ResumeExecution[]> {
      const noyau = o.noyau();
      if (noyau) return noyau.actions.executions(id);
      return ID_ACTION.test(id) ? listerExecutions(join(o.dossierActions, id)) : [];
    },
    async execution(id: string, execution: string): Promise<Execution | null> {
      if (!ID_ACTION.test(id) || !ID_EXECUTION.test(execution)) return null;
      const noyau = o.noyau();
      return noyau ? noyau.actions.execution(id, execution) : lireExecution(join(o.dossierActions, id), execution);
    },
    async direct(): Promise<EtatActions> {
      return o.noyau()?.actions.direct() ?? NO_ACTION;
    },
    lienPermis: (id: string, execution: string, url: string) => linkAllowed(o.dossierActions, id, execution, url),
    imagePermise: (id: string, execution: string, url: string) => actionImageAllowed({ dossierActions: o.dossierActions, lireAction: lire }, id, execution, url),
    async accorder(a: Accord): Promise<{ ok: true } | { ok: false; erreur: string }> {
      const noyau = o.noyau();
      if (!noyau) return { ok: false, erreur: MESSAGE_SANS_NOYAU };
      try {
        // The noyau refuses if the declaration is no longer the one the card showed.
        await noyau.actions.accorder(a);
        return { ok: true };
      } catch (e) {
        return { ok: false, erreur: (e as Error).message };
      }
    },
    async refuserAccord(id: string): Promise<void> {
      const noyau = o.noyau();
      // A run in progress would keep its place in the queue and its priority on the AI until its end.
      noyau?.actions.arreter(id);
      await noyau?.actions.refuserAccord(id);
    },
    async supprimer(id: string): Promise<{ ok: true } | { ok: false; erreur: string }> {
      if (!(await lire(id))) return { ok: false, erreur: ACTION_INCONNUE };
      // Stopped first: otherwise it would run to its maximum duration with nothing left to stop it.
      o.noyau()?.actions.arreter(id);
      // Removed from disk too: an action made again under the same id would find this refusal at the next start.
      await charge;
      if (refusLancement.delete(id)) enregistrerRefus();
      lancementsSuivis.delete(id);
      const oublier = async (x: string) => {
        const noyau = o.noyau();
        if (noyau) return noyau.actions.refuserAccord(x);
        await retirerAccord(o.dossierActions, x);
        await supprimerDonneesAction(o.dossierActions, x);
      };
      try {
        await trashAction(o.chemins, id, oublier);
        return { ok: true };
      } catch (e) {
        console.error(`[webaios] action ${id} non supprimée :`, e);
        return { ok: false, erreur: "L'action n'a pas pu être supprimée" };
      }
    },
    /** A finished action has a new last result (written outside the watched space): the list reads again. */
    directVu(e: EtatActions): void {
      const courantes = new Set(e.courantes.map((c) => c.action));
      const quitte = [...actionsCourantes].some((a) => !courantes.has(a));
      actionsCourantes = courantes;
      if (quitte) o.surChange();
    },
  };
}
