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
const unavailable = async () => ({ ok: false as const, erreur: "Pas encore disponible dans WebAiOs-Firefox." });

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
  /** A host request answered in this realm, `empty` in a private space (before and after) or when the host does not answer. */
  const ask = async <T>(method: string, params: unknown, empty: () => T): Promise<T> => {
    if (prive()) return empty();
    const r = await host.request<T>(method, params).then((v) => structuredClone(v), () => empty());
    return prive() ? empty() : r;
  };
  /** When this window last opened a link of an action's page: a page cannot make links leave in a burst. */
  let dernierLien = -Infinity;
  const api: ActionsFirefox = {
    liste: () => ask("actions.liste", undefined, () => []),
    surChange(rappel) {
      // A host that stopped or started again (`acces` comes once its noyau runs), or the chrome's resync: read again.
      const offs = ["actions.change", HOST_EXITED, "accueil.change", "acces"].map((e) => host.on(e, () => rappel()));
      return o.untilUnload(() => offs.forEach((f) => f()));
    },
    // Task 4.
    ouvrir: unavailable,
    lancer: (id, saisie) => ask("actions.lancer", { id, saisie }, () => ({ statut: "invalide" as const, erreur: prive() ? ACTIONS_EN_ESPACE_PRIVE : MESSAGE_SANS_NOYAU })),
    arreter(id) {
      if (!prive()) host.notify("actions.arreter", { id });
    },
    page: (id, execution) => ask("actions.page", { id, execution }, () => null),
    executions: (id) => ask("actions.executions", { id }, () => []),
    execution: (id, execution) => ask("actions.execution", { id, execution }, () => null),
    direct: () => ask("actions.direct", undefined, NO_ACTION),
    surDirect(rappel) {
      // Only while this window's space is not private, judged at each event (Electron's diffuserDirectActions).
      const offFeed = host.on("actions.direct", (e) => !prive() && rappel(structuredClone(e)));
      // A host that stopped or started again sent no feed meanwhile: the runs are read again.
      const again = () => void api.direct().then((e) => !prive() && rappel(e));
      const offs = [offFeed, ...[HOST_EXITED, "acces"].map((e) => host.on(e, again))];
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
      return host.request<{ ok: true } | { ok: false; erreur: string }>("actions.accorder", a).then(
        (r) => structuredClone(r),
        (e) => ({ ok: false as const, erreur: e instanceof Error ? e.message : String(e) }),
      );
    },
    // Tasks 4 to 6.
    refuserAccord: async () => {},
    supprimer: unavailable,
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
