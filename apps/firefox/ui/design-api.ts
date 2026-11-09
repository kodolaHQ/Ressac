import type { Action, ApiDesign, ApiWebaios, ShownElement, ExternalsState, BatchShown, ExtensionResult } from "../shared/api";
import type { WindowId } from "../shared/model";
import { HOST_EXITED, type AgentHost } from "../chrome/agent/host";
import type { WindowController } from "../chrome/window/controller";
import {
  checkClientName,
  checkComment,
  checkLines,
  checkPath,
  checkProject,
  checkResolved,
  checkText,
  checkToken,
  CLIENT_ID,
  DESIGN_ID_MAX,
  EXTERNAL_ID,
  ID_PROJECT,
  INVALID_REQUEST,
  failureReason,
} from "../shared/design-guards";

// The section « Projets externes » and the Review page over the kernel host's externes.* and relecture.* RPCs, with
// the shared guards (shared/design-guards.ts) before any call.

/** An error from the store's realm, made again in this one (`instanceof Error` fails across realms). */
export const local = (e: unknown): Error => new Error(typeof (e as Error | null)?.message === "string" ? (e as Error).message : String(e));

export function createExternalApi(o: {
  host: Pick<AgentHost, "request" | "on">;
  fenetre: WindowId;
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
      host.request<ExternalsState>("externes.liste").then(
        (v) => structuredClone(v),
        (e) => ({ serveur: { etat: "eteint" as const, raison: failureReason(local(e)) }, projets: [], clients: [] }),
      ),
    surChange(cb) {
      // accueil.change: the host sends it at each kernel start.
      const offs = ["externes.change", HOST_EXITED, "accueil.change"].map((m) => host.on(m, () => cb()));
      return o.untilUnload(() => offs.forEach((f) => f()));
    },
    async brancher(name) {
      const n = checkClientName(name);
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
        (name) => {
          if (typeof name === "string") o.dispatch({ type: "ouvrirRelecture", fenetreId: o.fenetre, projet: "ext-" + id, nom: name.slice(0, 80) });
        },
        (e) => console.error("[webaios] externes.nom :", local(e).message),
      );
    },
  };
}

/** The Review page: the shared guards, then the handler of the same name; a rejection keeps its message. */
export function createReviewApi(o: { host: Pick<AgentHost, "request"> }): ApiWebaios["relecture"] {
  const ask = <T>(method: string, params: Record<string, unknown>): Promise<T> =>
    o.host.request<T>(method, params).then(
      (v) => structuredClone(v),
      (e) => Promise.reject(local(e)),
    );
  return {
    async ouvrir(project, token) {
      return ask("relecture.ouvrir", { projet: checkProject(project), jeton: token === undefined || token === null ? null : checkToken(token) });
    },
    async fichier(project, token, path) {
      return ask("relecture.fichier", { projet: checkProject(project), jeton: checkToken(token), chemin: checkPath(path) });
    },
    async lignes(project, token, path, start, end) {
      const p = checkProject(project);
      [start, end] = checkLines(start, end);
      return ask("relecture.lignes", { projet: p, jeton: checkToken(token), chemin: checkPath(path), debut: start, fin: end });
    },
    async commentaires(project) {
      return ask("relecture.commentaires", { projet: checkProject(project) });
    },
    async commenter(project, token, c) {
      const p = checkProject(project);
      if (typeof c !== "object" || c === null) throw new Error("lignes invalides");
      const [start, end] = checkLines(c.debut, c.fin);
      return ask("relecture.commenter", { projet: p, jeton: checkToken(token), c: { fichier: checkPath(c.fichier), debut: start, fin: end, texte: checkText(c.texte) } });
    },
    async modifierCommentaire(project, id, text) {
      return ask("relecture.modifierCommentaire", { projet: checkProject(project), id: checkComment(id), texte: checkText(text) });
    },
    async resoudre(project, id, resolved) {
      const p = checkProject(project);
      const r = checkResolved(resolved);
      return ask("relecture.resoudre", { projet: p, id: checkComment(id), resolu: r });
    },
    async supprimerCommentaire(project, id) {
      return ask("relecture.supprimerCommentaire", { projet: checkProject(project), id: checkComment(id) });
    },
    async envoyer(project) {
      return ask("relecture.envoyer", { projet: checkProject(project) });
    },
    async relu(project, token) {
      return ask("relecture.relu", { projet: checkProject(project), jeton: checkToken(token) });
    },
  };
}

/**
 * The design mode of this window's active tab: the target is this window, never an id
 * the UI sends. A cart, batch or send is only for the project of the tab's state (projetPermis); the host checks again.
 */
export function createDesignApi(o: { win: WindowController; untilUnload: (f: () => void) => () => void }): ApiDesign {
  const { design, agent: host } = o.win.store;
  const t = { type: "fenetre" as const, fenetreId: o.win.fenetreId };
  const copy = <T>(p: Promise<T>): Promise<T> =>
    p.then(
      (v) => structuredClone(v),
      (e) => Promise.reject(local(e)),
    );
  const appState = () => copy(design.etat(t));
  const allowed = async (p: unknown): Promise<boolean> => typeof p === "string" && ID_PROJECT.test(p) && p === (await appState().catch(() => null))?.projet?.projet;
  const id = (x: unknown): x is string => typeof x === "string" && x.length <= DESIGN_ID_MAX;
  return {
    etat: appState,
    basculer: () => void design.toggle(t),
    relire: () => void design.relire(t),
    panier: async (p) => ((await allowed(p)) ? copy(host.request<ShownElement[]>("design.panier", { projet: p })) : []),
    lots: async (p) => ((await allowed(p)) ? copy(host.request<BatchShown[]>("design.lots", { projet: p })) : []),
    async retirer(p, x) {
      if ((await allowed(p)) && id(x)) await copy(host.request("design.retirer", { projet: p, id: x }));
    },
    async traite(p, batch) {
      if ((await allowed(p)) && id(batch)) await copy(host.request("design.traite", { projet: p, lot: batch }));
    },
    envoyer: async (p) => ((await allowed(p)) ? copy(host.request<ExtensionResult>("design.envoyer", { projet: p })) : { ok: false, erreur: INVALID_REQUEST }),
    surChange(cb) {
      // accueil.change: the host sends it at each kernel start.
      const offs = [...["design.change", HOST_EXITED, "accueil.change"].map((m) => host.on(m, () => cb())), design.onChange(() => cb())];
      return o.untilUnload(() => offs.forEach((f) => f()));
    },
  };
}
