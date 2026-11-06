import { ACTIONS_EN_ESPACE_PRIVE } from "../../navigateur/src/commun/actions";
import type { Action, ApiWebaios } from "../../navigateur/src/commun/api";
import type { EtatNavigateur, IdFenetre } from "../../navigateur/src/commun/modele";
import { HOST_EXITED, type AgentHost } from "../chrome/agent/host";
import type { WebAiOsStore } from "../chrome/store";
import { profilsLisibles, profilsPourAccord } from "./accueil-profils";

// The window half of Electron's creerServiceActions (main/agent/actions.ts): private spaces, dispatches, the pace of
// links, the direct feed's filter and the accord profiles. The disk and noyau half is the host's (noyau/actions.ts).

/** Copy of Electron's espaceActifPrive (drift test in test/actions-api.test.ts): a missing window or space counts as private. */
export function espaceActifPrive(etat: Pick<EtatNavigateur, "espaces" | "fenetres">, f: IdFenetre): boolean {
  const fenetre = etat.fenetres.find((x) => x.id === f);
  return !fenetre || (etat.espaces.find((e) => e.id === fenetre.espaceActif)?.prive ?? true);
}

/** Electron's actions API, plus what the Firefox page asks the chrome for: result images and agent components. */
export type ActionsFirefox = ApiWebaios["actions"] & {
  image(id: string, execution: string, url: string): Promise<string | null>;
  serveComponent(nom: string): Promise<string | null>;
  releaseComponent(nom: string): void;
};

// Electron's MESSAGE_SANS_NOYAU and AUCUNE_ACTION (main/agent/actions.ts, which this bundle cannot import).
const MESSAGE_SANS_NOYAU = "Le service des actions ne répond pas (agent arrêté ?)";
const NO_ACTION = () => ({ courantes: [], enAttente: [] });

export function createActionsApi(o: {
  state: () => EtatNavigateur | undefined;
  dispatch: (a: Action) => void;
  host: AgentHost;
  fenetre: IdFenetre;
  untilUnload: (unsubscribe: () => void) => () => void;
  media: WebAiOsStore["actionMedia"];
}): ActionsFirefox {
  const { host, fenetre } = o;
  /** Read at each call and again after each wait: the window may have moved to a private space meanwhile. */
  const prive = () => {
    const s = o.state();
    return !s || espaceActifPrive(s, fenetre);
  };
  const refus = { ok: false as const, erreur: ACTIONS_EN_ESPACE_PRIVE };
  /** The host stopped or did not answer a request: the next `acces` reads again (afterRestart). */
  let hostDown = false;
  /** The last answer to each read of the page: a host that stopped answers nothing, and the page keeps what it showed. */
  const lastRead = new Map<string, unknown>();
  /**
   * A host request answered in this realm, `empty` in a private space (before and after). When the host does not
   * answer: with `keep`, the last answer to the same request, otherwise `empty`.
   */
  const ask = async <T>(method: string, params: unknown, empty: () => T, keep = false): Promise<T> => {
    if (prive()) return empty();
    const key = JSON.stringify([method, params]);
    const r = await host.request<T>(method, params).then(
      (v) => {
        if (keep) lastRead.set(key, v);
        return structuredClone(v);
      },
      () => {
        hostDown = true;
        return keep && lastRead.has(key) ? structuredClone(lastRead.get(key) as T) : empty();
      },
    );
    return prive() ? empty() : r;
  };
  /**
   * The host stopped, or did not answer this API (a page opened while it was down): the first `acces`, sent once its
   * noyau runs again, calls the subscribers back once. Meanwhile pages keep their last read; later `acces` (each policy
   * change) are ignored.
   */
  const restarted = new Set<() => void>();
  o.untilUnload(host.on(HOST_EXITED, () => (hostDown = true)));
  o.untilUnload(
    host.on("acces", () => {
      if (!hostDown) return;
      hostDown = false;
      restarted.forEach((cb) => cb());
    }),
  );
  /** An action's accord or folder is gone: none of its cached reads, nor the cached list, may come back. */
  const forget = (id: string) => {
    for (const key of lastRead.keys()) {
      const [method, params] = JSON.parse(key) as [string, { id?: string } | undefined];
      if (method === "actions.liste" || params?.id === id) lastRead.delete(key);
    }
  };
  const afterRestart = (cb: () => void) => (restarted.add(cb), () => void restarted.delete(cb));
  /** When this window last opened a link of an action's page: a page cannot make links leave in a burst. */
  let dernierLien = -Infinity;
  const api: ActionsFirefox = {
    liste: () => ask("actions.liste", undefined, () => [], true),
    surChange(rappel) {
      const offs = [host.on("actions.change", () => rappel()), host.on("accueil.change", () => rappel()), afterRestart(() => rappel())];
      return o.untilUnload(() => offs.forEach((f) => f()));
    },
    // Electron's order, cut in two host calls: read without launching, check private again, open the page, then launch.
    async ouvrir(id, saisie) {
      if (prive()) return refus;
      const p = await ask<{ ok: true; nom: string; lancer: boolean } | { ok: false; erreur: string } | null>("actions.preparer", { id, saisie }, () => null);
      if (prive()) return refus;
      if (!p) return { ok: false, erreur: MESSAGE_SANS_NOYAU };
      if (!p.ok) return p;
      o.dispatch({ type: "ouvrirAction", fenetreId: fenetre, id, nom: p.nom });
      // A host that dies meanwhile: the next `acces` reads the page again, as after a rejected `ask`.
      if (p.lancer) host.request("actions.lancer", { id, saisie }).catch((e) => ((hostDown = true), console.error(`[webaios] action ${id} :`, e)));
      return { ok: true };
    },
    lancer: (id, saisie) => ask("actions.lancer", { id, saisie }, () => ({ statut: "invalide" as const, erreur: prive() ? ACTIONS_EN_ESPACE_PRIVE : MESSAGE_SANS_NOYAU })),
    arreter(id) {
      if (!prive()) host.notify("actions.arreter", { id });
    },
    page: (id, execution) => ask("actions.page", { id, execution }, () => null, true),
    executions: (id) => ask("actions.executions", { id }, () => [], true),
    execution: (id, execution) => ask("actions.execution", { id, execution }, () => null, true),
    direct: () => ask("actions.direct", undefined, NO_ACTION),
    surDirect(rappel) {
      // Only while this window's space is not private, judged at each event (Electron's diffuserDirectActions).
      const offFeed = host.on("actions.direct", (e) => !prive() && rappel(structuredClone(e)));
      // A host that started again sent no feed meanwhile: the runs are read again.
      const offs = [offFeed, afterRestart(() => void api.direct().then((e) => !prive() && rappel(e)))];
      return o.untilUnload(() => offs.forEach((f) => f()));
    },
    async ouvrirLien(id, execution, url) {
      if (prive()) return;
      const maintenant = Date.now();
      // A page that would open links in a burst (to make data leave): one per second at most.
      if (maintenant - dernierLien < 1000) return console.warn("[webaios] lien d'action ignoré (trop rapproché) :", url);
      // Taken now: a second click while the host checks this link is too close. A refused link gives the second back.
      const avant = dernierLien;
      dernierLien = maintenant;
      const permis = await ask("actions.lienPermis", { id, execution, url }, () => false);
      if (permis !== true || prive()) {
        if (dernierLien === maintenant) dernierLien = avant;
        if (permis !== true) console.warn("[webaios] lien d'action refusé :", url);
        return;
      }
      o.dispatch({ type: "ouvrirOnglet", fenetreId: fenetre, url, activer: true });
    },
    profilsPourAccord: async () => {
      const s = o.state();
      return !s || prive() ? [] : profilsPourAccord(s, fenetre);
    },
    async accorder(a) {
      if (prive()) return refus;
      // Never a profile a private space uses: the state is read again at the moment of the accord.
      if (!profilsLisibles(o.state()!).includes(a.profil)) return { ok: false, erreur: "Ce profil ne peut pas servir à un accord" };
      // A host that does not answer is Electron's missing noyau; the noyau's own refusals come back as answers.
      const r = await host.request<{ ok: true } | { ok: false; erreur: string }>("actions.accorder", a).then(
        (v) => structuredClone(v),
        () => ({ ok: false as const, erreur: MESSAGE_SANS_NOYAU }),
      );
      return prive() ? refus : r;
    },
    async refuserAccord(id) {
      if (prive()) return;
      // The host stops the run first, then erases the accord and the results.
      await host.request("actions.refuserAccord", { id }).then(
        () => forget(id),
        (e) => ((hostDown = true), console.error(`[webaios] retrait de l'accord de l'action ${id} :`, e)),
      );
    },
    async supprimer(id) {
      if (prive()) return refus;
      const r = await host.request<{ ok: true } | { ok: false; erreur: string }>("actions.supprimer", { id }).then(
        (v) => structuredClone(v),
        () => ((hostDown = true), { ok: false as const, erreur: MESSAGE_SANS_NOYAU }),
      );
      if (r.ok) forget(id);
      return prive() ? refus : r;
    },
    // Tasks 5 and 6.
    async voirWorkflow(id) {
      const nom = await ask<string | null>("actions.nom", { id }, () => null);
      if (nom && !prive()) o.dispatch({ type: "ouvrirWorkflow", fenetreId: fenetre, id, nom, proprietaire: "action" });
    },
    image: async () => null,
    serveComponent: async () => null,
    releaseComponent() {},
  };
  return api;
}
