import { describe, expect, it, vi } from "vitest";
import type { Action } from "../../navigateur/src/commun/api";
import { HOST_EXITED, HOST_STOPPED, type AgentHost } from "../chrome/agent/host";
import { raisonEchec } from "../shared/design-guards";
import { createExternesApi } from "../ui/design-api";

/** A fake noyau host: answers by method (a missing one rejects, as a stopped host does), notes every call. */
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
    expect(await api.liste()).toEqual({ serveur: { etat: "eteint", raison: raisonEchec(new Error(HOST_STOPPED)) }, projets: [], clients: [] });
    expect(raisonEchec(new Error(HOST_STOPPED))).toBe(`Le MCP externe n'a pas pu démarrer : ${HOST_STOPPED}`);
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
    const nom = "é".repeat(100);
    const { api, dispatched, calls } = setup({ "externes.nom": (p) => (p.id === ID ? nom : null) });
    api.relire(ID);
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]).toEqual({ type: "ouvrirRelecture", fenetreId: "F", projet: "ext-" + ID, nom: nom.slice(0, 80) });
    api.relire("fedcba9876543210");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(dispatched).toHaveLength(1);
  });
});
