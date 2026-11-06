import type { Action, ApiWebaios, EtatExternes } from "../../navigateur/src/commun/api";
import type { IdFenetre } from "../../navigateur/src/commun/modele";
import { HOST_EXITED, type AgentHost } from "../chrome/agent/host";
import { checkClientName, CLIENT_ID, EXTERNAL_ID, raisonEchec } from "../shared/design-guards";

// The section « Projets externes » over the noyau host's externes.* RPCs, with ipc.ts's guards before any call.

/** An error from the store's realm, made again in this one (`instanceof Error` fails across realms). */
const local = (e: unknown): Error => new Error(typeof (e as Error | null)?.message === "string" ? (e as Error).message : String(e));

export function createExternesApi(o: {
  host: Pick<AgentHost, "request" | "on">;
  fenetre: IdFenetre;
  dispatch: (a: Action) => void;
  untilUnload: (f: () => void) => () => void;
}): ApiWebaios["externes"] {
  const { host } = o;
  const call = (method: string, params: unknown) =>
    host.request(method, params).then(
      () => {},
      (e) => console.error(`[webaios] ${method} :`, local(e).message),
    );
  return {
    // A host that does not answer: the off server with its reason (spec §5.10).
    liste: () =>
      host.request<EtatExternes>("externes.liste").then(
        (v) => structuredClone(v),
        (e) => ({ serveur: { etat: "eteint" as const, raison: raisonEchec(local(e)) }, projets: [], clients: [] }),
      ),
    surChange(cb) {
      // accueil.change: the chrome sends it at each host start.
      const offs = ["externes.change", HOST_EXITED, "accueil.change"].map((m) => host.on(m, () => cb()));
      return o.untilUnload(() => offs.forEach((f) => f()));
    },
    async brancher(nom) {
      const n = checkClientName(nom);
      return host.request<{ commande: string }>("externes.brancher", { nom: n }).then(
        (r) => structuredClone(r),
        (e) => Promise.reject(local(e)),
      );
    },
    async revoquer(id) {
      if (typeof id === "string" && CLIENT_ID.test(id)) await call("externes.revoquer", { id });
    },
    async oublier(id) {
      if (typeof id === "string" && EXTERNAL_ID.test(id)) await call("externes.oublier", { id });
    },
    relire(id) {
      if (typeof id !== "string" || !EXTERNAL_ID.test(id)) return;
      void host.request<string | null>("externes.nom", { id }).then(
        (nom) => {
          if (typeof nom === "string") o.dispatch({ type: "ouvrirRelecture", fenetreId: o.fenetre, projet: "ext-" + id, nom: nom.slice(0, 80) });
        },
        (e) => console.error("[webaios] externes.nom :", local(e).message),
      );
    },
  };
}
