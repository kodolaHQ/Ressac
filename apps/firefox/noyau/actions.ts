import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ACTION_UNKNOWN,
  chainsOf,
  ID_ACTION,
  ID_EXECUTION,
  lireAccords,
  lireAction,
  lireActions,
  lireExecution,
  readResult,
  listerExecutions,
  retirerAccord,
  deleteDataAction,
  type ActionLue,
  type SpacePaths,
  type ActionsState,
  type Execution,
  type Noyau,
  type PageAction,
  type LaunchResult,
  type ResumeExecution,
} from "../../../packages/noyau/src/index.ts";
import type { ActionShown } from "../shared/actions.ts";
import type { Accord } from "../shared/api.ts";
import { openableUrl } from "../ui/accueil-profils.ts";

// The disk and kernel half of the actions service.

export const MESSAGE_SANS_NOYAU = "Le service des actions ne répond pas (agent arrêté ?)";
const NO_ACTION: ActionsState = { courantes: [], enAttente: [] };

/** https only, never the machine. Keep in sync with chrome/store/action-media.ts. */
const imageAddressAllowed = (url: string) => url.startsWith("https://") && openableUrl(url);

/**
 * The refusal half of a result image's load: a result image is fetched only for a current action
 * without account, a kept run, and an https address present as is in its results, with no grant for the account.
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
  // An action rewritten without account may keep results read with it: a grant still there is enough to refuse.
  const accords = await lireAccords(o.dossierActions).catch(() => null);
  if (!accords || Object.hasOwn(accords, id)) return false;
  const [result, exec] = await Promise.all([readResult(o.dossierActions, id, execution), lireExecution(join(o.dossierActions, id), execution)]);
  return !!result && !!exec && chainsOf(result.resultats).has(url);
}

/** A link of an action's page opens only if its address is, as is, in the run's results, in http(s). */
export async function linkAllowed(dossierActions: string, id: string, execution: string, url: string): Promise<boolean> {
  if (!openableUrl(url)) return false;
  const r = await readResult(dossierActions, id, execution);
  return !!r && chainsOf(r.resultats).has(url);
}

/** The action's folder goes to actions/.corbeille (nothing is destroyed), then `oublier` drops its grant and data. */
export async function trashAction(c: SpacePaths, id: string, forget: (id: string) => Promise<void>): Promise<void> {
  if (!ID_ACTION.test(id)) throw new Error(`id d'action invalide : ${id}`);
  const trash = join(c.actions, ".corbeille");
  await mkdir(trash, { recursive: true });
  await rename(join(c.actions, id), join(trash, `${id}-${Date.now()}`));
  await forget(id);
}

/** The disk's actions, ready to show: declaration, grant and last real run. Read without the kernel. */
export async function readShownActions(c: SpacePaths, dossierActions: string): Promise<ActionShown[]> {
  const [lues, accords] = await Promise.all([lireActions(c), lireAccords(dossierActions).catch(() => ({}) as Record<string, unknown>)]);
  return Promise.all(
    lues.map(async (a): Promise<ActionShown> => {
      const last = (await listerExecutions(join(dossierActions, a.id))).find((e) => !e.essai && !e.id.endsWith("-essai"));
      const dernier = last ? { execution: last.id, debut: last.debut, statut: last.statut } : null;
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

/** The actions service without the window state (private spaces, tabs, links' pace: the chrome's) and `agir`. */
export function createActionsHost(o: {
  chemins: SpacePaths;
  dossierActions: string;
  noyau: () => Noyau | null;
  /** A launch refused without a run written was just noted: the actions pages read again. */
  surChange: () => void;
  maintenant?: () => number;
}) {
  const now = o.maintenant ?? Date.now;
  /** Per action, the last launch refused without writing anything: the page cannot read it on disk, `liste` gives it. */
  const launchDenial = new Map<string, { erreur: string; quand: string }>();
  // Kept on disk next to the runs: a refusal survives a restart.
  const denialFile = join(o.dossierActions, "refus-lancement.json");
  const charge = readFile(denialFile, "utf8").then(
    (t) => {
      const lu: unknown = JSON.parse(t);
      if (typeof lu !== "object" || lu === null) return;
      for (const [id, v] of Object.entries(lu)) {
        const { erreur: error, quand: when } = (v ?? {}) as { erreur?: unknown; quand?: unknown };
        if (typeof error === "string" && typeof when === "string") launchDenial.set(id, { erreur: error, quand: when });
      }
    },
    () => {},
  );
  let writing = Promise.resolve();
  const recordDenial = () => {
    const t = JSON.stringify(Object.fromEntries(launchDenial));
    writing = writing
      .then(() => mkdir(o.dossierActions, { recursive: true }))
      .then(() => writeFile(denialFile, t))
      .catch((e) => console.error("[webaios] refus des actions non enregistrés :", e));
  };
  /** Followed launches, per action: a deletion forgets them, their end notes nothing (action made again under the same id). */
  const trackedLaunches = new Map<string, Set<Promise<LaunchResult>>>();
  const followLaunch = (id: string, fin: Promise<LaunchResult>): Promise<LaunchResult> => {
    const ready = charge.then(() => launchDenial.delete(id) && recordDenial());
    const tracked = trackedLaunches.get(id) ?? new Set();
    trackedLaunches.set(id, tracked.add(fin));
    return fin.then(async (r) => {
      await ready;
      const tracking = trackedLaunches.get(id)?.delete(fin) ?? false;
      if (trackedLaunches.get(id)?.size === 0) trackedLaunches.delete(id);
      if (tracking && !r.execution) {
        launchDenial.set(id, { erreur: r.erreur ?? "L'action n'a pas pu être lancée", quand: new Date(now()).toISOString() });
        recordDenial();
        o.surChange();
      }
      return r;
    });
  };
  const lire = (id: string) => lireAction(o.chemins, id);
  const nameOf = (a: ActionLue) => ("erreur" in a ? a.id : a.declaration.nom);
  let actionsCourantes = new Set<string>();
  return {
    async liste(): Promise<ActionShown[]> {
      await charge;
      return (await readShownActions(o.chemins, o.dossierActions)).map((a) => {
        const r = launchDenial.get(a.id);
        return r && (!a.dernier || a.dernier.debut < r.quand) ? { ...a, refus: r.erreur } : a;
      });
    },
    /** Reads the action without launching it: `lancer` says whether the chrome should launch it after opening its page. */
    async preparer(id: string, input: string | null): Promise<Prepared> {
      const noyau = o.noyau();
      if (!noyau) return { ok: false, erreur: MESSAGE_SANS_NOYAU };
      const a = await lire(id);
      if (!a) return { ok: false, erreur: ACTION_UNKNOWN };
      const d = noyau.actions.direct();
      const running = d.courantes.some((x) => x.action === id) || d.enAttente.some((x) => x.action === id);
      // Required input missing: the page opens with its field to fill, nothing is launched.
      const inputMissing = !("erreur" in a) && !!a.declaration.saisie && !input?.trim();
      return { ok: true, nom: nameOf(a), lancer: !running && !inputMissing };
    },
    /** The action's name for « Voir le workflow », read without the kernel. */
    async nom(id: string): Promise<string | null> {
      const a = await lire(id);
      return a ? nameOf(a).slice(0, 60) : null;
    },
    async lancer(id: string, input: string | null): Promise<LaunchResult> {
      const noyau = o.noyau();
      if (!noyau) return { statut: "invalide", erreur: MESSAGE_SANS_NOYAU };
      return followLaunch(id, noyau.actions.lancer(id, { ...(input?.trim() ? { saisie: input } : {}), declencheur: "manuelle" }).fin);
    },
    arreter(id: string): void {
      o.noyau()?.actions.arreter(id);
    },
    async page(id: string, execution: string | null): Promise<PageAction | null> {
      const noyau = o.noyau();
      // Refused, not null (« no result »): a page read before the kernel started reads again on its first `acces`.
      if (!noyau) throw new Error(MESSAGE_SANS_NOYAU);
      return (await noyau.actions.page(id, execution)) ?? null;
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
    async direct(): Promise<ActionsState> {
      return o.noyau()?.actions.direct() ?? NO_ACTION;
    },
    lienPermis: (id: string, execution: string, url: string) => linkAllowed(o.dossierActions, id, execution, url),
    imagePermise: (id: string, execution: string, url: string) => actionImageAllowed({ dossierActions: o.dossierActions, lireAction: lire }, id, execution, url),
    async accorder(a: Accord): Promise<{ ok: true } | { ok: false; erreur: string }> {
      const noyau = o.noyau();
      if (!noyau) return { ok: false, erreur: MESSAGE_SANS_NOYAU };
      try {
        // The kernel refuses if the declaration is no longer the one the card showed.
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
      if (!(await lire(id))) return { ok: false, erreur: ACTION_UNKNOWN };
      // Stopped first: otherwise it would run to its maximum duration with nothing left to stop it.
      o.noyau()?.actions.arreter(id);
      // Removed from disk too: an action made again under the same id would find this refusal at the next start.
      await charge;
      if (launchDenial.delete(id)) recordDenial();
      trackedLaunches.delete(id);
      const forget = async (x: string) => {
        const noyau = o.noyau();
        if (noyau) return noyau.actions.refuserAccord(x);
        await retirerAccord(o.dossierActions, x);
        await deleteDataAction(o.dossierActions, x);
      };
      try {
        await trashAction(o.chemins, id, forget);
        return { ok: true };
      } catch (e) {
        console.error(`[webaios] action ${id} non supprimée :`, e);
        return { ok: false, erreur: "L'action n'a pas pu être supprimée" };
      }
    },
    /** A finished action has a new last result (written outside the watched space): the list reads again. */
    directVu(e: ActionsState): void {
      const courantes = new Set(e.courantes.map((c) => c.action));
      const quit = [...actionsCourantes].some((a) => !courantes.has(a));
      actionsCourantes = courantes;
      if (quit) o.surChange();
    },
  };
}
