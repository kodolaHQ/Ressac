import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIONS_IN_PRIVATE_SPACE } from "../shared/actions";
import type { Action } from "../shared/api";
import type { BrowserState } from "../shared/model";
import { apply } from "../core/state/actions";
import { initialState } from "../core/state/initial-state";
import { HOST_EXITED, type AgentHost } from "../chrome/agent/host";
import { createActionsApi, activeSpacePrivate } from "../ui/actions-api";

const NONE = { running: [], waiting: [] };
const START = "2026-10-31T08:00:00.000Z";

/** A fake kernel host: answers by method (a missing one rejects, as a stopped host does), notes every call. */
function fakeHost(answers: Record<string, (p: any) => unknown> = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const host = {
    request: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      const a = answers[method];
      if (!a) throw new Error("Le noyau de l'agent s'est arrêté.");
      return a(params);
    },
    notify: (method: string, params?: unknown) => void calls.push({ method, params }),
    on(method: string, cb: (p: unknown) => void) {
      const set = listeners.get(method) ?? new Set();
      listeners.set(method, set.add(cb));
      return () => void set.delete(cb);
    },
    ensure: async () => {},
    stop: async () => {},
    pid: null,
  };
  const emit = (method: string, p?: unknown) => listeners.get(method)?.forEach((cb) => cb(p));
  return { host: host as AgentHost, calls, emit };
}

/** A window F (public), and a second window P whose active space is private when `withPrivate`. */
function setup(answers: Record<string, (p: any) => unknown> = {}) {
  let n = 0;
  const genId = () => `g${++n}`;
  let state: BrowserState = initialState(genId);
  const F = state.windows[0]!.id;
  const dispatched: Action[] = [];
  const dispatch = (a: Action) => {
    dispatched.push(a);
    state = apply(state, a, genId);
  };
  const fake = fakeHost(answers);
  const media = { image: vi.fn(async (_url: string): Promise<string | null> => "data:image/png;base64,"), serve: vi.fn(async (name: string): Promise<string | null> => `resource://webaios-component-${name}/component-1.html`), release: vi.fn(async (_name: string) => {}) };
  const unloads: (() => void)[] = [];
  const api = (win: string) =>
    createActionsApi({
      state: () => state,
      dispatch,
      host: fake.host,
      window: win,
      untilUnload: (f) => (unloads.push(f), f),
      media,
    });
  const turnPrivate = (f = F) => {
    const e = state.spaces.find((x) => x.id === state.windows.find((w) => w.id === f)!.activeSpace)!;
    state = apply(state, { type: "reglerEspace", id: e.id, name: e.name, icon: e.icon, private: true, profile: e.profile }, genId);
  };
  return { F, api, dispatched, turnPrivate, media, unload: () => unloads.forEach((f) => f()), ...fake, state: () => state, set: (s: BrowserState) => (state = s), genId };
}

type Api = ReturnType<typeof createActionsApi>;

afterEach(() => vi.restoreAllMocks());

describe("activeSpacePrivate", () => {
  it("is false only for a window whose active space is private", () => {
    const { F, state: state, turnPrivate, genId } = setup();
    const cases: [BrowserState, string][] = [[state(), F], [state(), "inconnue"]];
    const withoutSpace = { ...state(), spaces: [] };
    cases.push([withoutSpace, F]);
    turnPrivate();
    cases.push([state(), F]);
    cases.push([apply(state(), { type: "creerEspace", name: "B", icon: "🅱", private: false, profile: "defaut", windowId: F }, genId), F]);
    const got = cases.map(([s, f]) => activeSpacePrivate(s, f));
    expect(got).toEqual([false, true, true, true, false]);
  });
});

describe("createActionsApi", () => {
  // actions.test.ts:381
  it("every actions call is refused in a private space", async () => {
    const { F, api, dispatched, calls, turnPrivate, emit } = setup({ "actions.liste": () => [{ id: "gitlab" }], "actions.lienPermis": () => true, "actions.nom": () => "GitLab" });
    turnPrivate();
    dispatched.length = 0;
    const a = api(F);
    const direct = vi.fn();
    a.onLive(direct);
    expect(await a.list()).toEqual([]);
    expect(await a.launch("gitlab", null)).toEqual({ status: "invalid", error: ACTIONS_IN_PRIVATE_SPACE });
    a.stop("gitlab");
    expect(await a.page("gitlab", null)).toBeNull();
    expect(await a.runs("gitlab")).toEqual([]);
    expect(await a.run("gitlab", "2026-10-31T08-00-00-000Z")).toBeNull();
    expect(await a.direct()).toEqual(NONE);
    await a.openLink("gitlab", "2026-10-31T08-00-00-000Z", "https://a.test/");
    expect(await a.profilesForGrant()).toEqual([]);
    expect(await a.grant({ id: "gitlab", profile: "defaut", account: ["gitlab.com"], public: [] })).toEqual({ ok: false, error: ACTIONS_IN_PRIVATE_SPACE });
    await a.viewWorkflow("gitlab");
    emit("actions.direct", { running: [{ action: "gitlab" }], waiting: [] });
    expect(calls).toEqual([]);
    expect(dispatched).toEqual([]);
    expect(direct).not.toHaveBeenCalled();
  });

  // actions.test.ts:437
  it("ouvrirLien opens an active tab for an address of the results, one per second at most", async () => {
    const allowed = new Set(["https://gitlab.com/1", "https://gitlab.com/2"]);
    const { F, api, dispatched } = setup({ "actions.lienPermis": (p) => allowed.has(p.url) });
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const a = api(F);
    const ex = "2026-10-31T08-00-00-000Z";
    await a.openLink("gitlab", ex, "https://gitlab.com/1");
    await a.openLink("gitlab", ex, "https://gitlab.com/2"); // too close
    await a.openLink("gitlab", ex, "javascript:alert(1)");
    await a.openLink("gitlab", ex, "https://gitlab.com/3"); // absent
    now += 1000;
    await a.openLink("gitlab", ex, "https://gitlab.com/2");
    expect(dispatched).toEqual([
      { type: "ouvrirOnglet", windowId: F, url: "https://gitlab.com/1", activate: true },
      { type: "ouvrirOnglet", windowId: F, url: "https://gitlab.com/2", activate: true },
    ]);
  });

  it("two links within a second open one tab", async () => {
    let answer: (v: boolean) => void = () => {};
    const { F, api, dispatched, calls } = setup({ "actions.lienPermis": () => new Promise<boolean>((ok) => (answer = ok)) });
    const a = api(F);
    const ex = "2026-10-31T08-00-00-000Z";
    // The second click comes while the host still checks the first link.
    const first = a.openLink("gitlab", ex, "https://gitlab.com/1");
    const second = a.openLink("gitlab", ex, "https://gitlab.com/2");
    answer(true);
    await Promise.all([first, second]);
    expect(dispatched.map((d) => (d as { url: string }).url)).toEqual(["https://gitlab.com/1"]);
    expect(calls.filter((c) => c.method === "actions.lienPermis")).toHaveLength(1);
  });

  it("a link absent from the results opens nothing", async () => {
    const { F, api, dispatched, calls } = setup({ "actions.lienPermis": (p) => p.url === "https://gitlab.com/1" });
    const a = api(F);
    const ex = "2026-10-31T08-00-00-000Z";
    await a.openLink("gitlab", ex, "https://gitlab.com/3");
    expect(calls).toEqual([{ method: "actions.lienPermis", params: { id: "gitlab", run: ex, url: "https://gitlab.com/3" } }]);
    expect(dispatched).toEqual([]);
    // A refused link does not use up the second: an allowed one right after opens.
    await a.openLink("gitlab", ex, "https://gitlab.com/1");
    expect(dispatched).toEqual([{ type: "ouvrirOnglet", windowId: F, url: "https://gitlab.com/1", activate: true }]);
  });

  // actions.test.ts:452
  it("voirWorkflow opens the builder on the action; lancer and arreter go to the kernel", async () => {
    const { F, api, calls, state: state } = setup({ "actions.nom": (p) => (p.id === "gitlab" ? "GitLab" : null), "actions.lancer": () => ({ status: "succeeded", run: "x" }) });
    const a = api(F);
    await a.viewWorkflow("gitlab");
    expect(Object.values(state().tabs)[0]).toMatchObject({ url: "webaios://workflow/action/gitlab", title: "Workflow — GitLab" });
    await a.viewWorkflow("inconnue");
    expect(Object.values(state().tabs)).toHaveLength(1);
    expect(await a.launch("leboncoin", "clio")).toEqual({ status: "succeeded", run: "x" });
    a.stop("leboncoin");
    expect(calls.filter((c) => c.method === "actions.lancer" || c.method === "actions.arreter")).toEqual([
      { method: "actions.lancer", params: { id: "leboncoin", input: "clio" } },
      { method: "actions.arreter", params: { id: "leboncoin" } },
    ]);
  });

  it("a stopped host gives the answers without a kernel", async () => {
    const { F, api } = setup();
    const a = api(F);
    expect(await a.launch("x", null)).toEqual({ status: "invalid", error: "Le service des actions ne répond pas (agent arrêté ?)" });
    expect(await a.list()).toEqual([]);
    expect(await a.page("x", null)).toBeNull();
    expect(await a.direct()).toEqual(NONE);
  });

  it("accorder never uses a private space's profile, read again at the grant", async () => {
    const { F, api, calls, state: state, set, genId } = setup({ "actions.accorder": () => ({ ok: true }) });
    set(apply(state(), { type: "creerEspace", name: "Banque", icon: "🏦", private: true, profile: "nouveau", windowId: F }, genId));
    const bank = state().spaces.find((e) => e.private)!.profile;
    set(apply(state(), { type: "activerEspace", windowId: F, id: state().spaces[0]!.id }, genId));
    const a = api(F);
    expect(await a.grant({ id: "gitlab", profile: bank, account: ["gitlab.com"], public: [] })).toEqual({ ok: false, error: "Ce profil ne peut pas servir à un accord" });
    expect(calls).toEqual([]);
    expect(await a.grant({ id: "gitlab", profile: "defaut", account: ["gitlab.com"], public: [] })).toEqual({ ok: true });
    expect((await a.profilesForGrant()).map((p) => p.id)).toEqual(["defaut"]);
  });

  it("a window turned private while the host answers gets nothing and dispatches nothing", async () => {
    const running = { running: [{ action: "gitlab" }], waiting: [] };
    const cases = [
      ["actions.liste", [{ id: "gitlab" }], (b: Api) => b.list(), []],
      ["actions.page", { run: "x" }, (b: Api) => b.page("gitlab", null), null],
      ["actions.executions", [{ id: "x" }], (b: Api) => b.runs("gitlab"), []],
      ["actions.execution", { id: "x" }, (b: Api) => b.run("gitlab", "x"), null],
      ["actions.direct", running, (b: Api) => b.direct(), NONE],
      ["actions.lancer", { status: "succeeded", run: "x" }, (b: Api) => b.launch("gitlab", null), { status: "invalid", error: ACTIONS_IN_PRIVATE_SPACE }],
      ["actions.nom", "GitLab", (b: Api) => b.viewWorkflow("gitlab"), undefined],
      ["actions.lienPermis", true, (b: Api) => b.openLink("gitlab", "x", "https://gitlab.com/1"), undefined],
      ["actions.imagePermise", true, (b: Api) => b.image("gitlab", "x", "https://img.test/a.png"), null],
    ] as const;
    for (const [method, value, call, empty] of cases) {
      let turn = () => {};
      const s = setup({ [method]: () => (turn(), value) });
      turn = () => s.turnPrivate();
      expect(await call(s.api(s.F)), method).toEqual(empty);
      expect(s.calls.map((c) => c.method), method).toEqual([method]);
      expect(s.dispatched, method).toEqual([]);
      expect(s.media.image, method).not.toHaveBeenCalled();
    }
  });

  // Review Focus 2
  it("a private window gets no direct feed, list, page or image", async () => {
    const running = { running: [{ action: "gitlab", start: START, input: null, attempt: false, step: "workflow", blocks: {} }], waiting: [] };
    const { F, api, calls, emit, state: state, set, genId, media } = setup({
      "actions.liste": () => [{ id: "gitlab" }],
      "actions.page": () => ({ run: "x" }),
      "actions.direct": () => running,
      "actions.imagePermise": () => true,
    });
    set(apply(state(), { type: "ouvrirFenetre" }, genId));
    const P = state().windows[1]!.id;
    set(apply(state(), { type: "creerEspace", name: "Banque", icon: "🏦", private: true, profile: "nouveau", windowId: P }, genId));
    expect(activeSpacePrivate(state(), F)).toBe(false);
    expect(activeSpacePrivate(state(), P)).toBe(true);
    const pub = api(F);
    const priv = api(P);
    const seenPub = vi.fn();
    const seenPriv = vi.fn();
    pub.onLive(seenPub);
    priv.onLive(seenPriv);
    emit("actions.direct", running);
    expect(seenPub).toHaveBeenCalledWith(running);
    expect(seenPriv).not.toHaveBeenCalled();
    // A host that started again: the feed is read again, only for the public window.
    emit(HOST_EXITED, { message: "stop" });
    emit("acces");
    await vi.waitFor(() => expect(seenPub).toHaveBeenCalledTimes(2));
    expect(seenPriv).not.toHaveBeenCalled();
    calls.length = 0;
    expect(await priv.list()).toEqual([]);
    expect(await priv.page("gitlab", null)).toBeNull();
    expect(await priv.image("gitlab", "x", "https://img.test/a.png")).toBeNull();
    expect(await priv.direct()).toEqual(NONE);
    expect(calls).toEqual([]);
    expect(media.image).not.toHaveBeenCalled();
    expect(await pub.list()).toEqual([{ id: "gitlab" }]);
    // The same image, for the public window: allowed by the host, loaded by the store.
    expect(await pub.image("gitlab", "x", "https://img.test/a.png")).toBe("data:image/png;base64,");
    expect(media.image).toHaveBeenCalledWith("https://img.test/a.png");
  });

  it("image: the host is asked first; a refusal or a stopped host loads nothing; a window turned private during the load gets null", async () => {
    let allowed = false;
    const s = setup({ "actions.imagePermise": () => allowed });
    const b = s.api(s.F);
    // An address absent from the results (the host refuses): no load.
    expect(await b.image("gitlab", "x", "https://img.test/absent.png")).toBeNull();
    expect(s.calls).toEqual([{ method: "actions.imagePermise", params: { id: "gitlab", run: "x", url: "https://img.test/absent.png" } }]);
    expect(s.media.image).not.toHaveBeenCalled();
    allowed = true;
    expect(await b.image("gitlab", "x", "https://img.test/a.png")).toBe("data:image/png;base64,");
    // No cached image after a refusal: a stopped host refuses.
    const stopped = setup();
    expect(await stopped.api(stopped.F).image("gitlab", "x", "https://img.test/a.png")).toBeNull();
    expect(stopped.media.image).not.toHaveBeenCalled();
    s.media.image.mockImplementationOnce(async () => (s.turnPrivate(), "data:image/png;base64,"));
    expect(await b.image("gitlab", "x", "https://img.test/a.png")).toBeNull();
  });

  it("surChange calls back on actions.change and the home's resync; after a host exit, once on its kernel's start", () => {
    const { F, api, emit } = setup();
    const cb = vi.fn();
    const off = api(F).onChange(cb);
    emit("actions.change");
    emit("accueil.change");
    expect(cb).toHaveBeenCalledTimes(2);
    // The page keeps its last read while no host runs; the first acces after the exit reads again, later ones do not.
    emit(HOST_EXITED, { message: "stop" });
    expect(cb).toHaveBeenCalledTimes(2);
    emit("acces");
    emit("acces");
    expect(cb).toHaveBeenCalledTimes(3);
    off();
    emit("actions.change");
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("a host that stops keeps the page's last read; a read never answered stays empty", async () => {
    let up = true;
    const answer = (v: unknown) => () => {
      if (!up) throw new Error("Le noyau de l'agent s'est arrêté.");
      return v;
    };
    const { F, api, turnPrivate } = setup({ "actions.liste": answer([{ id: "gitlab" }]), "actions.page": answer({ run: "x" }), "actions.executions": answer([{ id: "x" }]), "actions.direct": answer({ running: [{ action: "gitlab" }], waiting: [] }) });
    const a = api(F);
    await Promise.all([a.list(), a.page("gitlab", null), a.runs("gitlab"), a.direct()]);
    up = false;
    expect(await a.list()).toEqual([{ id: "gitlab" }]);
    expect(await a.page("gitlab", null)).toEqual({ run: "x" });
    expect(await a.runs("gitlab")).toEqual([{ id: "x" }]);
    expect(await a.page("gitlab", "y")).toBeNull();
    // Nothing runs while no host runs.
    expect(await a.direct()).toEqual(NONE);
    // Never in a private space.
    turnPrivate();
    expect(await a.list()).toEqual([]);
  });

  it("a page opened while the host is down reads again on the next acces", async () => {
    let up = false;
    const { F, api, emit } = setup({
      "actions.liste": () => {
        if (!up) throw new Error("Le noyau de l'agent s'est arrêté.");
        return [{ id: "gitlab" }];
      },
      "actions.direct": () => NONE,
    });
    const a = api(F);
    const change = vi.fn();
    const direct = vi.fn();
    a.onChange(change);
    a.onLive(direct);
    // The page's first read: no host answers, and this API saw no exit.
    expect(await a.list()).toEqual([]);
    up = true;
    emit("acces");
    expect(change).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(direct).toHaveBeenCalledTimes(1));
    expect(await a.list()).toEqual([{ id: "gitlab" }]);
    // A later acces, with no failure in between: nothing more.
    emit("acces");
    expect(change).toHaveBeenCalledTimes(1);
  });

  // One read of the host's pipe can hold both the refusal and the kernel's first acces: the acces listener runs before
  // the refusal's handler.
  it("a read refused just before the kernel's first acces, in the same read, reads again", async () => {
    let deny!: (e: Error) => void;
    const { F, api, emit } = setup({ "actions.page": () => new Promise((_, no) => (deny = no)) });
    const a = api(F);
    const change = vi.fn();
    a.onChange(change);
    const read = a.page("annonces", null);
    await vi.waitFor(() => expect(deny).toBeTypeOf("function"));
    deny(new Error("Le service des actions ne répond pas (agent arrêté ?)"));
    emit("acces");
    expect(await read).toBeNull();
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("acces without a preceding exit does not read again", async () => {
    const { F, api, emit, calls } = setup({ "actions.direct": () => NONE });
    const change = vi.fn();
    const direct = vi.fn();
    const a = api(F);
    a.onChange(change);
    a.onLive(direct);
    emit("acces");
    await new Promise((r) => setTimeout(r, 0));
    expect(change).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("accorder: a stopped host is a missing kernel; a window turned private meanwhile is refused", async () => {
    const stopped = setup();
    expect(await stopped.api(stopped.F).grant({ id: "gitlab", profile: "defaut", account: ["gitlab.com"], public: [] })).toEqual({
      ok: false,
      error: "Le service des actions ne répond pas (agent arrêté ?)",
    });
    let turn = () => {};
    const s = setup({ "actions.accorder": () => (turn(), { ok: true }) });
    turn = () => s.turnPrivate();
    expect(await s.api(s.F).grant({ id: "gitlab", profile: "defaut", account: ["gitlab.com"], public: [] })).toEqual({ ok: false, error: ACTIONS_IN_PRIVATE_SPACE });
  });
  // Review Focus 1
  it("a window turned private while the host reads opens and launches nothing", async () => {
    let turn = () => {};
    const s = setup({ "actions.preparer": () => (turn(), { ok: true, name: "GitLab", launch: true }), "actions.lancer": () => ({ status: "succeeded", run: "x" }) });
    turn = () => s.turnPrivate();
    s.dispatched.length = 0;
    expect(await s.api(s.F).open("gitlab", null)).toEqual({ ok: false, error: ACTIONS_IN_PRIVATE_SPACE });
    await new Promise((r) => setTimeout(r, 0));
    expect(s.calls.map((c) => c.method)).toEqual(["actions.preparer"]);
    expect(s.dispatched).toEqual([]);
  });

  /** The host's preparer over a fixed set of actions (host/actions.ts), `running` already in the direct feed. */
  const prepare = (running: string[] = []) => (p: { id: string; input: string | null }) => {
    const names: Record<string, [string, boolean]> = { gitlab: ["GitLab", false], leboncoin: ["Leboncoin", true] };
    const a = names[p.id];
    if (!a) return { ok: false, error: "Action inconnue" };
    return { ok: true, name: a[0], launch: !running.includes(p.id) && !(a[1] && !p.input?.trim()) };
  };
  const launched = (calls: { method: string; params: unknown }[]) => calls.filter((c) => c.method === "actions.lancer").map((c) => c.params);

  // actions.test.ts:402
  it("ouvrir opens the action's page titled with its name, then launches it", async () => {
    const { F, api, calls, state: state } = setup({ "actions.preparer": prepare(), "actions.lancer": () => ({ status: "succeeded", run: "x" }) });
    const a = api(F);
    expect(await a.open("gitlab", null)).toEqual({ ok: true });
    const tabs = Object.values(state().tabs);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ url: "webaios://action/gitlab", title: "GitLab" });
    expect(launched(calls)).toEqual([{ id: "gitlab", input: null }]);
    expect(await a.open("leboncoin", "clio lyon")).toEqual({ ok: true });
    expect(launched(calls)).toEqual([{ id: "gitlab", input: null }, { id: "leboncoin", input: "clio lyon" }]);
  });

  // actions.test.ts:413
  it("ouvrir without the required input opens the page and launches nothing; an unknown action is refused", async () => {
    const { F, api, calls, state: state } = setup({ "actions.preparer": prepare() });
    const a = api(F);
    expect(await a.open("leboncoin", null)).toEqual({ ok: true });
    expect(await a.open("leboncoin", "  ")).toEqual({ ok: true });
    expect(Object.values(state().tabs).map((o) => o.url)).toEqual(["webaios://action/leboncoin"]);
    expect(launched(calls)).toEqual([]);
    expect(await a.open("inconnue", null)).toEqual({ ok: false, error: "Action inconnue" });
  });

  // actions.test.ts:423
  it("ouvrir on a running action opens its page and launches nothing", async () => {
    const { F, api, calls, state: state, set, genId } = setup({ "actions.preparer": prepare(["gitlab"]) });
    const a = api(F);
    expect(await a.open("gitlab", null)).toEqual({ ok: true });
    const page = Object.values(state().tabs)[0]!;
    // Another tab comes first; opening again goes back to the action's page.
    set(apply(state(), { type: "ouvrirOnglet", windowId: F, url: "https://a.test/" }, genId));
    expect(await a.open("gitlab", null)).toEqual({ ok: true });
    expect(Object.values(state().tabs).filter((o) => o.url.startsWith("webaios://action/"))).toHaveLength(1);
    expect(state().windows[0]!.active[state().windows[0]!.activeSpace]).toBe(page.id);
    expect(launched(calls)).toEqual([]);
  });

  it("ouvrir: a stopped host is a missing kernel; a failed launch goes to the console and reads again on the next acces", async () => {
    const stopped = setup();
    expect(await stopped.api(stopped.F).open("gitlab", null)).toEqual({ ok: false, error: "Le service des actions ne répond pas (agent arrêté ?)" });
    expect(stopped.dispatched).toEqual([]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup({ "actions.preparer": prepare() });
    const a = s.api(s.F);
    const change = vi.fn();
    a.onChange(change);
    expect(await a.open("gitlab", null)).toEqual({ ok: true });
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    // The host did not answer the launch: its next start reads the page again.
    s.emit("acces");
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("refuserAccord and supprimer go to the host, refused in a private space; their cached reads are forgotten", async () => {
    let up = true;
    const answer = (v: unknown) => () => {
      if (!up) throw new Error("Le noyau de l'agent s'est arrêté.");
      return v;
    };
    const { F, api, calls, turnPrivate } = setup({
      "actions.page": answer({ run: "x" }),
      "actions.executions": answer([{ id: "x" }]),
      "actions.liste": answer([{ id: "gitlab" }]),
      "actions.refuserAccord": answer(undefined),
      "actions.supprimer": answer({ ok: true }),
    });
    const a = api(F);
    await Promise.all([a.page("gitlab", null), a.runs("gitlab"), a.list()]);
    await a.denyGrant("gitlab");
    up = false;
    // The results were erased with the grant: a stopped host gives no stale page back.
    expect(await a.page("gitlab", null)).toBeNull();
    expect(await a.runs("gitlab")).toEqual([]);
    up = true;
    await a.list();
    expect(await a.supprimer("gitlab")).toEqual({ ok: true });
    up = false;
    expect(await a.list()).toEqual([]);
    expect(await a.supprimer("gitlab")).toEqual({ ok: false, error: "Le service des actions ne répond pas (agent arrêté ?)" });
    expect(calls.filter((c) => c.method === "actions.refuserAccord" || c.method === "actions.supprimer").map((c) => c.params)).toEqual([{ id: "gitlab" }, { id: "gitlab" }, { id: "gitlab" }]);
    calls.length = 0;
    turnPrivate();
    await a.denyGrant("gitlab");
    expect(await a.supprimer("gitlab")).toEqual({ ok: false, error: ACTIONS_IN_PRIVATE_SPACE });
    expect(await a.open("gitlab", null)).toEqual({ ok: false, error: ACTIONS_IN_PRIVATE_SPACE });
    expect(calls).toEqual([]);
  });

  it("components: each serve is paired with one store release; a private space serves none; unload releases what is left", async () => {
    const s = setup();
    const a = s.api(s.F);
    expect(await a.serveComponent("barres")).toBe("resource://webaios-component-barres/component-1.html");
    await a.serveComponent("barres");
    await a.serveComponent("ecrit");
    a.releaseComponent("barres");
    // A release this document does not hold reaches nothing (another window's reference stays).
    a.releaseComponent("autre");
    expect(s.media.release.mock.calls).toEqual([["barres"]]);
    s.unload();
    expect(s.media.release.mock.calls.map((c) => c[0]).sort()).toEqual(["barres", "barres", "ecrit"]);
    const p = setup();
    const b = p.api(p.F);
    p.turnPrivate();
    expect(await b.serveComponent("barres")).toBeNull();
    b.releaseComponent("barres");
    expect(p.media.serve).not.toHaveBeenCalled();
    expect(p.media.release).not.toHaveBeenCalled();
    // Turned private while the store serves: null, and the reference taken is still released.
    const t = setup();
    const c = t.api(t.F);
    t.media.serve.mockImplementationOnce(async () => (t.turnPrivate(), "resource://webaios-component-x/component-1.html"));
    expect(await c.serveComponent("x")).toBeNull();
    c.releaseComponent("x");
    expect(t.media.release).toHaveBeenCalledWith("x");
  });
});
