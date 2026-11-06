import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIONS_EN_ESPACE_PRIVE } from "../../navigateur/src/commun/actions";
import type { Action } from "../../navigateur/src/commun/api";
import type { EtatNavigateur } from "../../navigateur/src/commun/modele";
import { espaceActifPrive as electronEspaceActifPrive } from "../../navigateur/src/main/agent/actions";
import { appliquer } from "../../navigateur/src/main/etat/actions";
import { etatInitial } from "../../navigateur/src/main/etat/etat-initial";
import { HOST_EXITED, type AgentHost } from "../chrome/agent/host";
import { createActionsApi, espaceActifPrive } from "../ui/actions-api";

// Electron's main/agent/actions.ts is imported only for the drift test: its electron imports are never used here.
vi.mock("electron", () => new Proxy({ default: {} }, { get: (t, k) => (k in t ? t[k as "default"] : class {}), has: () => true }));
vi.mock("../../navigateur/src/main/onglets/vues", () => ({}));

const NONE = { courantes: [], enAttente: [] };
const DEBUT = "2026-10-31T08:00:00.000Z";

/** A fake noyau host: answers by method (a missing one rejects, as a stopped host does), notes every call. */
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
  let etat: EtatNavigateur = etatInitial(genId);
  const F = etat.fenetres[0]!.id;
  const dispatched: Action[] = [];
  const dispatch = (a: Action) => {
    dispatched.push(a);
    etat = appliquer(etat, a, genId);
  };
  const fake = fakeHost(answers);
  const api = (fenetre: string) =>
    createActionsApi({
      state: () => etat,
      dispatch,
      host: fake.host,
      fenetre,
      untilUnload: (f) => f,
      media: { image: async () => "data:image/png;base64,", serve: async () => null, release: async () => {} },
    });
  const turnPrivate = (f = F) => {
    const e = etat.espaces.find((x) => x.id === etat.fenetres.find((w) => w.id === f)!.espaceActif)!;
    etat = appliquer(etat, { type: "reglerEspace", id: e.id, nom: e.nom, icone: e.icone, prive: true, profil: e.profil }, genId);
  };
  return { F, api, dispatched, turnPrivate, ...fake, etat: () => etat, set: (s: EtatNavigateur) => (etat = s), genId };
}

type Api = ReturnType<typeof createActionsApi>;

afterEach(() => vi.restoreAllMocks());

describe("espaceActifPrive", () => {
  it("is Electron's (drift)", () => {
    const { F, etat, turnPrivate, genId } = setup();
    const cases: [EtatNavigateur, string][] = [[etat(), F], [etat(), "inconnue"]];
    const sansEspace = { ...etat(), espaces: [] };
    cases.push([sansEspace, F]);
    turnPrivate();
    cases.push([etat(), F]);
    cases.push([appliquer(etat(), { type: "creerEspace", nom: "B", icone: "🅱", prive: false, profil: "defaut", fenetreId: F }, genId), F]);
    const got = cases.map(([s, f]) => espaceActifPrive(s, f));
    expect(got).toEqual(cases.map(([s, f]) => electronEspaceActifPrive(s, f)));
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
    a.surDirect(direct);
    expect(await a.liste()).toEqual([]);
    expect(await a.lancer("gitlab", null)).toEqual({ statut: "invalide", erreur: ACTIONS_EN_ESPACE_PRIVE });
    a.arreter("gitlab");
    expect(await a.page("gitlab", null)).toBeNull();
    expect(await a.executions("gitlab")).toEqual([]);
    expect(await a.execution("gitlab", "2026-10-31T08-00-00-000Z")).toBeNull();
    expect(await a.direct()).toEqual(NONE);
    await a.ouvrirLien("gitlab", "2026-10-31T08-00-00-000Z", "https://a.test/");
    expect(await a.profilsPourAccord()).toEqual([]);
    expect(await a.accorder({ id: "gitlab", profil: "defaut", compte: ["gitlab.com"], publiques: [] })).toEqual({ ok: false, erreur: ACTIONS_EN_ESPACE_PRIVE });
    await a.voirWorkflow("gitlab");
    emit("actions.direct", { courantes: [{ action: "gitlab" }], enAttente: [] });
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
    await a.ouvrirLien("gitlab", ex, "https://gitlab.com/1");
    await a.ouvrirLien("gitlab", ex, "https://gitlab.com/2"); // too close
    await a.ouvrirLien("gitlab", ex, "javascript:alert(1)");
    await a.ouvrirLien("gitlab", ex, "https://gitlab.com/3"); // absent
    now += 1000;
    await a.ouvrirLien("gitlab", ex, "https://gitlab.com/2");
    expect(dispatched).toEqual([
      { type: "ouvrirOnglet", fenetreId: F, url: "https://gitlab.com/1", activer: true },
      { type: "ouvrirOnglet", fenetreId: F, url: "https://gitlab.com/2", activer: true },
    ]);
  });

  it("two links within a second open one tab", async () => {
    let answer: (v: boolean) => void = () => {};
    const { F, api, dispatched, calls } = setup({ "actions.lienPermis": () => new Promise<boolean>((ok) => (answer = ok)) });
    const a = api(F);
    const ex = "2026-10-31T08-00-00-000Z";
    // The second click comes while the host still checks the first link.
    const first = a.ouvrirLien("gitlab", ex, "https://gitlab.com/1");
    const second = a.ouvrirLien("gitlab", ex, "https://gitlab.com/2");
    answer(true);
    await Promise.all([first, second]);
    expect(dispatched.map((d) => (d as { url: string }).url)).toEqual(["https://gitlab.com/1"]);
    expect(calls.filter((c) => c.method === "actions.lienPermis")).toHaveLength(1);
  });

  it("a link absent from the results opens nothing", async () => {
    const { F, api, dispatched, calls } = setup({ "actions.lienPermis": (p) => p.url === "https://gitlab.com/1" });
    const a = api(F);
    const ex = "2026-10-31T08-00-00-000Z";
    await a.ouvrirLien("gitlab", ex, "https://gitlab.com/3");
    expect(calls).toEqual([{ method: "actions.lienPermis", params: { id: "gitlab", execution: ex, url: "https://gitlab.com/3" } }]);
    expect(dispatched).toEqual([]);
    // A refused link does not use up the second: an allowed one right after opens.
    await a.ouvrirLien("gitlab", ex, "https://gitlab.com/1");
    expect(dispatched).toEqual([{ type: "ouvrirOnglet", fenetreId: F, url: "https://gitlab.com/1", activer: true }]);
  });

  // actions.test.ts:452
  it("voirWorkflow opens the builder on the action; lancer and arreter go to the noyau", async () => {
    const { F, api, calls, etat } = setup({ "actions.nom": (p) => (p.id === "gitlab" ? "GitLab" : null), "actions.lancer": () => ({ statut: "reussie", execution: "x" }) });
    const a = api(F);
    await a.voirWorkflow("gitlab");
    expect(Object.values(etat().onglets)[0]).toMatchObject({ url: "webaios://workflow/action/gitlab", titre: "Workflow — GitLab" });
    await a.voirWorkflow("inconnue");
    expect(Object.values(etat().onglets)).toHaveLength(1);
    expect(await a.lancer("leboncoin", "clio")).toEqual({ statut: "reussie", execution: "x" });
    a.arreter("leboncoin");
    expect(calls.filter((c) => c.method === "actions.lancer" || c.method === "actions.arreter")).toEqual([
      { method: "actions.lancer", params: { id: "leboncoin", saisie: "clio" } },
      { method: "actions.arreter", params: { id: "leboncoin" } },
    ]);
  });

  it("a stopped host gives Electron's answers without a noyau", async () => {
    const { F, api } = setup();
    const a = api(F);
    expect(await a.lancer("x", null)).toEqual({ statut: "invalide", erreur: "Le service des actions ne répond pas (agent arrêté ?)" });
    expect(await a.liste()).toEqual([]);
    expect(await a.page("x", null)).toBeNull();
    expect(await a.direct()).toEqual(NONE);
  });

  it("accorder never uses a private space's profile, read again at the accord", async () => {
    const { F, api, calls, etat, set, genId } = setup({ "actions.accorder": () => ({ ok: true }) });
    set(appliquer(etat(), { type: "creerEspace", nom: "Banque", icone: "🏦", prive: true, profil: "nouveau", fenetreId: F }, genId));
    const banque = etat().espaces.find((e) => e.prive)!.profil;
    set(appliquer(etat(), { type: "activerEspace", fenetreId: F, id: etat().espaces[0]!.id }, genId));
    const a = api(F);
    expect(await a.accorder({ id: "gitlab", profil: banque, compte: ["gitlab.com"], publiques: [] })).toEqual({ ok: false, erreur: "Ce profil ne peut pas servir à un accord" });
    expect(calls).toEqual([]);
    expect(await a.accorder({ id: "gitlab", profil: "defaut", compte: ["gitlab.com"], publiques: [] })).toEqual({ ok: true });
    expect((await a.profilsPourAccord()).map((p) => p.id)).toEqual(["defaut"]);
  });

  it("a window turned private while the host answers gets nothing and dispatches nothing", async () => {
    const running = { courantes: [{ action: "gitlab" }], enAttente: [] };
    const cases = [
      ["actions.liste", [{ id: "gitlab" }], (b: Api) => b.liste(), []],
      ["actions.page", { execution: "x" }, (b: Api) => b.page("gitlab", null), null],
      ["actions.executions", [{ id: "x" }], (b: Api) => b.executions("gitlab"), []],
      ["actions.execution", { id: "x" }, (b: Api) => b.execution("gitlab", "x"), null],
      ["actions.direct", running, (b: Api) => b.direct(), NONE],
      ["actions.lancer", { statut: "reussie", execution: "x" }, (b: Api) => b.lancer("gitlab", null), { statut: "invalide", erreur: ACTIONS_EN_ESPACE_PRIVE }],
      ["actions.nom", "GitLab", (b: Api) => b.voirWorkflow("gitlab"), undefined],
      ["actions.lienPermis", true, (b: Api) => b.ouvrirLien("gitlab", "x", "https://gitlab.com/1"), undefined],
    ] as const;
    for (const [method, value, call, empty] of cases) {
      let turn = () => {};
      const s = setup({ [method]: () => (turn(), value) });
      turn = () => s.turnPrivate();
      expect(await call(s.api(s.F)), method).toEqual(empty);
      expect(s.calls.map((c) => c.method), method).toEqual([method]);
      expect(s.dispatched, method).toEqual([]);
    }
  });

  // Review Focus 2
  it("a private window gets no direct feed, list, page or image", async () => {
    const running = { courantes: [{ action: "gitlab", debut: DEBUT, saisie: null, essai: false, etape: "workflow", blocs: {} }], enAttente: [] };
    const { F, api, calls, emit, etat, set, genId } = setup({
      "actions.liste": () => [{ id: "gitlab" }],
      "actions.page": () => ({ execution: "x" }),
      "actions.direct": () => running,
      "actions.imagePermise": () => true,
    });
    set(appliquer(etat(), { type: "ouvrirFenetre" }, genId));
    const P = etat().fenetres[1]!.id;
    set(appliquer(etat(), { type: "creerEspace", nom: "Banque", icone: "🏦", prive: true, profil: "nouveau", fenetreId: P }, genId));
    expect(espaceActifPrive(etat(), F)).toBe(false);
    expect(espaceActifPrive(etat(), P)).toBe(true);
    const pub = api(F);
    const priv = api(P);
    const seenPub = vi.fn();
    const seenPriv = vi.fn();
    pub.surDirect(seenPub);
    priv.surDirect(seenPriv);
    emit("actions.direct", running);
    expect(seenPub).toHaveBeenCalledWith(running);
    expect(seenPriv).not.toHaveBeenCalled();
    // A host that stopped: the feed is read again, only for the public window.
    emit(HOST_EXITED, { message: "stop" });
    await vi.waitFor(() => expect(seenPub).toHaveBeenCalledTimes(2));
    expect(seenPriv).not.toHaveBeenCalled();
    calls.length = 0;
    expect(await priv.liste()).toEqual([]);
    expect(await priv.page("gitlab", null)).toBeNull();
    expect(await priv.image("gitlab", "x", "https://img.test/a.png")).toBeNull();
    expect(await priv.direct()).toEqual(NONE);
    expect(calls).toEqual([]);
    expect(await pub.liste()).toEqual([{ id: "gitlab" }]);
  });

  it("surChange calls back on actions.change, a host exit, the home's resync and a noyau start", () => {
    const { F, api, emit } = setup();
    const cb = vi.fn();
    const off = api(F).surChange(cb);
    for (const e of ["actions.change", HOST_EXITED, "accueil.change", "acces"]) emit(e);
    expect(cb).toHaveBeenCalledTimes(4);
    off();
    emit("actions.change");
    expect(cb).toHaveBeenCalledTimes(4);
  });
});
