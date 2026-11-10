import { describe, expect, it, vi } from "vitest";
import type { Action } from "../shared/api";
import { HOST_EXITED, HOST_STOPPED, type AgentHost } from "../chrome/agent/host";
import { failureReason } from "../shared/design-guards";
import { createExternalApi, createReviewApi } from "../ui/design-api";

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
  const api = createExternalApi({ host, window: "F", dispatch: (a) => void dispatched.push(a), untilUnload: (f) => f });
  const emit = (method: string, p?: unknown) => listeners.get(method)?.forEach((cb) => cb(p));
  return { api, calls, dispatched, emit };
}

const ID = "0123456789abcdef";

describe("createExternalApi", () => {
  it("an invalid id or name never reaches the host", async () => {
    const { api, calls } = setup({ "external.connect": () => ({ command: "x" }), "external.revoke": () => undefined, "external.forget": () => undefined, "external.name": () => "n" });
    await expect(api.connect(42 as unknown as string)).rejects.toThrow("Nom invalide");
    await expect(api.connect("x".repeat(201))).rejects.toThrow("Nom invalide");
    await api.revoke("../x");
    await api.revoke(ID.toUpperCase() + "!");
    await api.forget("abc");
    await api.forget(ID + "0");
    api.review("../../etc");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);
    await api.revoke("abcdef01-2345");
    await api.forget(ID);
    expect(calls.map((c) => c.method)).toEqual(["external.revoke", "external.forget"]);
  });

  it("a host that rejects gives the off shape with failureReason", async () => {
    const { api } = setup();
    expect(await api.list()).toEqual({ server: { state: "off", reason: failureReason(new Error(HOST_STOPPED)) }, projects: [], clients: [] });
    expect(failureReason(new Error(HOST_STOPPED))).toBe(`Le MCP externe n'a pas pu démarrer : ${HOST_STOPPED}`);
  });

  it("a rejected brancher rejects with the host's message", async () => {
    const { api } = setup();
    await expect(api.connect("Claude Code")).rejects.toThrow(HOST_STOPPED);
  });

  it("onChange calls back on externes.change, a host exit and the chrome's accueil.change", () => {
    const { api, emit } = setup();
    const cb = vi.fn();
    const off = api.onChange(cb);
    emit("external.change");
    emit(HOST_EXITED, { message: HOST_STOPPED });
    emit("home.change");
    expect(cb).toHaveBeenCalledTimes(3);
    off();
    emit("external.change");
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("relire dispatches openReview with the name cut to 80 characters; null does nothing", async () => {
    const name = "é".repeat(100);
    const { api, dispatched, calls } = setup({ "external.name": (p) => (p.id === ID ? name : null) });
    api.review(ID);
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]).toEqual({ type: "openReview", windowId: "F", project: "ext-" + ID, name: name.slice(0, 80) });
    api.review("fedcba9876543210");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(dispatched).toHaveLength(1);
  });
});

describe("createReviewApi", () => {
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
      ["projet invalide", () => api.open("../x")],
      ["jeton invalide", () => api.open(P, "abc")],
      ["projet invalide", () => api.file("demo", T, "app.js")],
      ["jeton invalide", () => api.file(P, "x", "app.js")],
      ["chemin invalide", () => api.file(P, T, "")],
      ["chemin invalide", () => api.file(P, T, "a\0b")],
      ["chemin invalide", () => api.file(P, T, "x".repeat(4097))],
      ["lignes invalides", () => api.lines(P, T, "app.js", 0, 3)],
      ["lignes invalides", () => api.lines(P, T, "app.js", 5, 3)],
      ["lignes invalides", () => api.lines(P, T, "app.js", 1.5, 3)],
      ["projet invalide", () => api.comments(42 as unknown as string)],
      ["lignes invalides", () => api.comment(P, T, null as never)],
      ["lignes invalides", () => api.comment(P, T, { file: "app.js", start: 2, end: 1, text: "t" })],
      ["jeton invalide", () => api.comment(P, "x", { file: "app.js", start: 1, end: 1, text: "t" })],
      ["chemin invalide", () => api.comment(P, T, { file: "", start: 1, end: 1, text: "t" })],
      ["texte invalide", () => api.comment(P, T, { file: "app.js", start: 1, end: 1, text: "x".repeat(4001) })],
      ["commentaire invalide", () => api.editComment(P, "c-xyz", "t")],
      ["texte invalide", () => api.editComment(P, C, 42 as unknown as string)],
      ["résolu invalide", () => api.resolve(P, C, "oui" as unknown as boolean)],
      ["commentaire invalide", () => api.resolve(P, "../c", true)],
      ["commentaire invalide", () => api.deleteComment(P, "c-0123abcde")],
      ["projet invalide", () => api.send("app-")],
      ["jeton invalide", () => api.reviewed(P, T + "0")],
    ];
    for (const [message, f] of bad) await expect(f(), message).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it("valid inputs go to the handler of the same name, with named parameters; ouvrir without a token passes jeton: null", async () => {
    const { api, calls } = review();
    const c = { file: "dossier é/a b.js", start: 1, end: 2, text: "t" };
    expect(await api.open(P)).toEqual({ method: "review.open", params: { project: P, token: null } });
    await api.open(P, T);
    await api.file(P, T, "app.js");
    await api.lines(P, T, "app.js", 1, 11);
    await api.comments(P);
    await api.comment(P, T, c);
    await api.editComment(P, C, "u");
    await api.resolve(P, C, false);
    await api.deleteComment(P, C);
    await api.send(P);
    await api.reviewed(P, T);
    expect(calls).toEqual([
      { method: "review.open", params: { project: P, token: null } },
      { method: "review.open", params: { project: P, token: T } },
      { method: "review.file", params: { project: P, token: T, path: "app.js" } },
      { method: "review.lines", params: { project: P, token: T, path: "app.js", start: 1, end: 11 } },
      { method: "review.comments", params: { project: P } },
      { method: "review.comment", params: { project: P, token: T, c } },
      { method: "review.editComment", params: { project: P, id: C, text: "u" } },
      { method: "review.resolve", params: { project: P, id: C, resolved: false } },
      { method: "review.deleteComment", params: { project: P, id: C } },
      { method: "review.send", params: { project: P } },
      { method: "review.reviewed", params: { project: P, token: T } },
    ]);
  });

  it("answers are copies; a host rejection keeps its message", async () => {
    const answer = { state: "ok", files: [] };
    const api = createReviewApi({
      host: {
        request: async (method: string) => {
          if (method === "review.send") throw new Error("projet inconnu");
          return answer;
        },
      } as Pick<AgentHost, "request">,
    });
    const v = await api.comments(P);
    expect(v).toEqual(answer);
    expect(v).not.toBe(answer);
    await expect(api.send(P)).rejects.toThrow("projet inconnu");
  });
});
