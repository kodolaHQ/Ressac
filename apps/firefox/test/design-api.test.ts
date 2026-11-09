import { describe, expect, it, vi } from "vitest";
import type { Action } from "../shared/api";
import { HOST_EXITED, HOST_STOPPED, type AgentHost } from "../chrome/agent/host";
import { failureReason } from "../shared/design-guards";
import { createExternesApi, createReviewApi } from "../ui/design-api";

/** A fake kernel host: answers by method (a missing one rejects, as a stopped host does), notes every call. */
function setup(answers: Record<string, (p: any) => unknown> = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const host = {
    request: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      const a = answers[method];
      if (!a) throw new Error(HOST_STOPPED);
      return a(params);
    },
    on(method: string, cb: (p: unknown) => void) {
      const set = listeners.get(method) ?? new Set();
      listeners.set(method, set.add(cb));
      return () => void set.delete(cb);
    },
  } as Pick<AgentHost, "request" | "on">;
  const dispatched: Action[] = [];
  const api = createExternesApi({ host, fenetre: "F", dispatch: (a) => void dispatched.push(a), untilUnload: (f) => f });
  const emit = (method: string, p?: unknown) => listeners.get(method)?.forEach((cb) => cb(p));
  return { api, calls, dispatched, emit };
}

const ID = "0123456789abcdef";

describe("createExternesApi", () => {
  it("an invalid id or name never reaches the host", async () => {
    const { api, calls } = setup({ "externes.brancher": () => ({ commande: "x" }), "externes.revoquer": () => undefined, "externes.oublier": () => undefined, "externes.nom": () => "n" });
    await expect(api.brancher(42 as unknown as string)).rejects.toThrow("Nom invalide");
    await expect(api.brancher("x".repeat(201))).rejects.toThrow("Nom invalide");
    await api.revoquer("../x");
    await api.revoquer(ID.toUpperCase() + "!");
    await api.oublier("abc");
    await api.oublier(ID + "0");
    api.relire("../../etc");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);
    await api.revoquer("abcdef01-2345");
    await api.oublier(ID);
    expect(calls.map((c) => c.method)).toEqual(["externes.revoquer", "externes.oublier"]);
  });

  it("a host that rejects gives the off shape with raisonEchec", async () => {
    const { api } = setup();
    expect(await api.liste()).toEqual({ serveur: { etat: "eteint", raison: failureReason(new Error(HOST_STOPPED)) }, projets: [], clients: [] });
    expect(failureReason(new Error(HOST_STOPPED))).toBe(`Le MCP externe n'a pas pu démarrer : ${HOST_STOPPED}`);
  });

  it("a rejected brancher rejects with the host's message", async () => {
    const { api } = setup();
    await expect(api.brancher("Claude Code")).rejects.toThrow(HOST_STOPPED);
  });

  it("surChange calls back on externes.change, a host exit and the chrome's accueil.change", () => {
    const { api, emit } = setup();
    const cb = vi.fn();
    const off = api.surChange(cb);
    emit("externes.change");
    emit(HOST_EXITED, { message: HOST_STOPPED });
    emit("accueil.change");
    expect(cb).toHaveBeenCalledTimes(3);
    off();
    emit("externes.change");
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("relire dispatches ouvrirRelecture with the name cut to 80 characters; null does nothing", async () => {
    const name = "é".repeat(100);
    const { api, dispatched, calls } = setup({ "externes.nom": (p) => (p.id === ID ? name : null) });
    api.relire(ID);
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]).toEqual({ type: "ouvrirRelecture", fenetreId: "F", projet: "ext-" + ID, nom: name.slice(0, 80) });
    api.relire("fedcba9876543210");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(dispatched).toHaveLength(1);
  });
});

describe("createRelectureApi", () => {
  const P = "ext-" + ID;
  const T = "a".repeat(40) + ":" + "b".repeat(40);
  const C = "c-0123abcd";
  function review() {
    const calls: { method: string; params: unknown }[] = [];
    const host = { request: async (method: string, params?: unknown) => (calls.push({ method, params }), { method, params }) } as Pick<AgentHost, "request">;
    return { api: createReviewApi({ host }), calls };
  }

  it("each member rejects an invalid input without calling the host", async () => {
    const { api, calls } = review();
    const bad: [string, () => Promise<unknown>][] = [
      ["projet invalide", () => api.ouvrir("../x")],
      ["jeton invalide", () => api.ouvrir(P, "abc")],
      ["projet invalide", () => api.fichier("demo", T, "app.js")],
      ["jeton invalide", () => api.fichier(P, "x", "app.js")],
      ["chemin invalide", () => api.fichier(P, T, "")],
      ["chemin invalide", () => api.fichier(P, T, "a\0b")],
      ["chemin invalide", () => api.fichier(P, T, "x".repeat(4097))],
      ["lignes invalides", () => api.lignes(P, T, "app.js", 0, 3)],
      ["lignes invalides", () => api.lignes(P, T, "app.js", 5, 3)],
      ["lignes invalides", () => api.lignes(P, T, "app.js", 1.5, 3)],
      ["projet invalide", () => api.commentaires(42 as unknown as string)],
      ["lignes invalides", () => api.commenter(P, T, null as never)],
      ["lignes invalides", () => api.commenter(P, T, { fichier: "app.js", debut: 2, fin: 1, texte: "t" })],
      ["jeton invalide", () => api.commenter(P, "x", { fichier: "app.js", debut: 1, fin: 1, texte: "t" })],
      ["chemin invalide", () => api.commenter(P, T, { fichier: "", debut: 1, fin: 1, texte: "t" })],
      ["texte invalide", () => api.commenter(P, T, { fichier: "app.js", debut: 1, fin: 1, texte: "x".repeat(4001) })],
      ["commentaire invalide", () => api.modifierCommentaire(P, "c-xyz", "t")],
      ["texte invalide", () => api.modifierCommentaire(P, C, 42 as unknown as string)],
      ["résolu invalide", () => api.resoudre(P, C, "oui" as unknown as boolean)],
      ["commentaire invalide", () => api.resoudre(P, "../c", true)],
      ["commentaire invalide", () => api.supprimerCommentaire(P, "c-0123abcde")],
      ["projet invalide", () => api.envoyer("app-")],
      ["jeton invalide", () => api.relu(P, T + "0")],
    ];
    for (const [message, f] of bad) await expect(f(), message).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it("valid inputs go to the handler of the same name, with named parameters; ouvrir without a token passes jeton: null", async () => {
    const { api, calls } = review();
    const c = { fichier: "dossier é/a b.js", debut: 1, fin: 2, texte: "t" };
    expect(await api.ouvrir(P)).toEqual({ method: "relecture.ouvrir", params: { projet: P, jeton: null } });
    await api.ouvrir(P, T);
    await api.fichier(P, T, "app.js");
    await api.lignes(P, T, "app.js", 1, 11);
    await api.commentaires(P);
    await api.commenter(P, T, c);
    await api.modifierCommentaire(P, C, "u");
    await api.resoudre(P, C, false);
    await api.supprimerCommentaire(P, C);
    await api.envoyer(P);
    await api.relu(P, T);
    expect(calls).toEqual([
      { method: "relecture.ouvrir", params: { projet: P, jeton: null } },
      { method: "relecture.ouvrir", params: { projet: P, jeton: T } },
      { method: "relecture.fichier", params: { projet: P, jeton: T, chemin: "app.js" } },
      { method: "relecture.lignes", params: { projet: P, jeton: T, chemin: "app.js", debut: 1, fin: 11 } },
      { method: "relecture.commentaires", params: { projet: P } },
      { method: "relecture.commenter", params: { projet: P, jeton: T, c } },
      { method: "relecture.modifierCommentaire", params: { projet: P, id: C, texte: "u" } },
      { method: "relecture.resoudre", params: { projet: P, id: C, resolu: false } },
      { method: "relecture.supprimerCommentaire", params: { projet: P, id: C } },
      { method: "relecture.envoyer", params: { projet: P } },
      { method: "relecture.relu", params: { projet: P, jeton: T } },
    ]);
  });

  it("answers are copies; a host rejection keeps its message", async () => {
    const answer = { etat: "ok", fichiers: [] };
    const api = createReviewApi({
      host: {
        request: async (method: string) => {
          if (method === "relecture.envoyer") throw new Error("projet inconnu");
          return answer;
        },
      } as Pick<AgentHost, "request">,
    });
    const v = await api.commentaires(P);
    expect(v).toEqual(answer);
    expect(v).not.toBe(answer);
    await expect(api.envoyer(P)).rejects.toThrow("projet inconnu");
  });
});
