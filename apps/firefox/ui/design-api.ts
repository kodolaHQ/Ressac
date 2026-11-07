import type { Action, ApiDesign, ApiWebaios, ElementAffiche, EtatExternes, LotAffiche, ResultatExtension } from "../../navigateur/src/commun/api";
import type { IdFenetre } from "../../navigateur/src/commun/modele";
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
  raisonEchec,
} from "../shared/design-guards";

// The section « Projets externes » and the Review page over the noyau host's externes.* and relecture.* RPCs, with
// ipc.ts's guards before any call.

/** An error from the store's realm, made again in this one (`instanceof Error` fails across realms). */
export const local = (e: unknown): Error => new Error(typeof (e as Error | null)?.message === "string" ? (e as Error).message : String(e));

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

/** The Review page: ipc.ts's brancherRelecture guards, then the handler of the same name; a rejection keeps its message. */
export function createRelectureApi(o: { host: Pick<AgentHost, "request"> }): ApiWebaios["relecture"] {
  const ask = <T>(method: string, params: Record<string, unknown>): Promise<T> =>
    o.host.request<T>(method, params).then(
      (v) => structuredClone(v),
      (e) => Promise.reject(local(e)),
    );
  return {
    async ouvrir(projet, jeton) {
      return ask("relecture.ouvrir", { projet: checkProject(projet), jeton: jeton === undefined || jeton === null ? null : checkToken(jeton) });
    },
    async fichier(projet, jeton, chemin) {
      return ask("relecture.fichier", { projet: checkProject(projet), jeton: checkToken(jeton), chemin: checkPath(chemin) });
    },
    async lignes(projet, jeton, chemin, debut, fin) {
      const p = checkProject(projet);
      [debut, fin] = checkLines(debut, fin);
      return ask("relecture.lignes", { projet: p, jeton: checkToken(jeton), chemin: checkPath(chemin), debut, fin });
    },
    async commentaires(projet) {
      return ask("relecture.commentaires", { projet: checkProject(projet) });
    },
    async commenter(projet, jeton, c) {
      const p = checkProject(projet);
      if (typeof c !== "object" || c === null) throw new Error("lignes invalides");
      const [debut, fin] = checkLines(c.debut, c.fin);
      return ask("relecture.commenter", { projet: p, jeton: checkToken(jeton), c: { fichier: checkPath(c.fichier), debut, fin, texte: checkText(c.texte) } });
    },
    async modifierCommentaire(projet, id, texte) {
      return ask("relecture.modifierCommentaire", { projet: checkProject(projet), id: checkComment(id), texte: checkText(texte) });
    },
    async resoudre(projet, id, resolu) {
      const p = checkProject(projet);
      const r = checkResolved(resolu);
      return ask("relecture.resoudre", { projet: p, id: checkComment(id), resolu: r });
    },
    async supprimerCommentaire(projet, id) {
      return ask("relecture.supprimerCommentaire", { projet: checkProject(projet), id: checkComment(id) });
    },
    async envoyer(projet) {
      return ask("relecture.envoyer", { projet: checkProject(projet) });
    },
    async relu(projet, jeton) {
      return ask("relecture.relu", { projet: checkProject(projet), jeton: checkToken(jeton) });
    },
  };
}

/**
 * The design mode of this window's active tab (ipc.ts's « fenetre » origin): the target is this window, never an id
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
  const etat = () => copy(design.etat(t));
  const allowed = async (p: unknown): Promise<boolean> => typeof p === "string" && ID_PROJECT.test(p) && p === (await etat().catch(() => null))?.projet?.projet;
  const id = (x: unknown): x is string => typeof x === "string" && x.length <= DESIGN_ID_MAX;
  return {
    etat,
    basculer: () => void design.toggle(t),
    relire: () => void design.relire(t),
    panier: async (p) => ((await allowed(p)) ? copy(host.request<ElementAffiche[]>("design.panier", { projet: p })) : []),
    lots: async (p) => ((await allowed(p)) ? copy(host.request<LotAffiche[]>("design.lots", { projet: p })) : []),
    async retirer(p, x) {
      if ((await allowed(p)) && id(x)) await copy(host.request("design.retirer", { projet: p, id: x }));
    },
    async traite(p, lot) {
      if ((await allowed(p)) && id(lot)) await copy(host.request("design.traite", { projet: p, lot }));
    },
    envoyer: async (p) => ((await allowed(p)) ? copy(host.request<ResultatExtension>("design.envoyer", { projet: p })) : { ok: false, erreur: INVALID_REQUEST }),
    surChange(cb) {
      // accueil.change: the chrome sends it at each host start.
      const offs = [...["design.change", HOST_EXITED, "accueil.change"].map((m) => host.on(m, () => cb())), design.onChange(() => cb())];
      return o.untilUnload(() => offs.forEach((f) => f()));
    },
  };
}
