import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIONS_EN_ESPACE_PRIVE } from "../shared/actions";
import type { Action } from "../shared/api";
import type { EtatNavigateur } from "../shared/modele";
import { appliquer } from "../core/etat/actions";
import { etatInitial } from "../core/etat/etat-initial";
import { HOST_EXITED, type AgentHost } from "../chrome/agent/host";
import { createActionsApi, espaceActifPrive } from "../ui/actions-api";

const NONE = { courantes: [], enAttente: [] };
const DEBUT = "2026-10-31T08:00:00.000Z";

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
  let etat: EtatNavigateur = etatInitial(genId);
  const F = etat.fenetres[0]!.id;
  const dispatched: Action[] = [];
  const dispatch = (a: Action) => {
    dispatched.push(a);
    etat = appliquer(etat, a, genId);
  };
  const fake = fakeHost(answers);
  const media = { image: vi.fn(async (_url: string): Promise<string | null> => "data:image/png;base64,"), serve: vi.fn(async (nom: string): Promise<string | null> => `resource://webaios-composant-${nom}/composant-1.html`), release: vi.fn(async (_nom: string) => {}) };
  const unloads: (() => void)[] = [];
  const api = (fenetre: string) =>
    createActionsApi({
      state: () => etat,
      dispatch,
      host: fake.host,
      fenetre,
      untilUnload: (f) => (unloads.push(f), f),
      media,
    });
  const turnPrivate = (f = F) => {
    const e = etat.espaces.find((x) => x.id === etat.fenetres.find((w) => w.id === f)!.espaceActif)!;
    etat = appliquer(etat, { type: "reglerEspace", id: e.id, nom: e.nom, icone: e.icone, prive: true, profil: e.profil }, genId);
  };
  return { F, api, dispatched, turnPrivate, media, unload: () => unloads.forEach((f) => f()), ...fake, etat: () => etat, set: (s: EtatNavigateur) => (etat = s), genId };
}

type Api = ReturnType<typeof createActionsApi>;

afterEach(() => vi.restoreAllMocks());

describe("espaceActifPrive", () => {
  it("is false only for a window whose active space is private", () => {
    const { F, etat, turnPrivate, genId } = setup();
    const cases: [EtatNavigateur, string][] = [[etat(), F], [etat(), "inconnue"]];
    const sansEspace = { ...etat(), espaces: [] };
    cases.push([sansEspace, F]);
    turnPrivate();
    cases.push([etat(), F]);
    cases.push([appliquer(etat(), { type: "creerEspace", nom: "B", icone: "🅱", prive: false, profil: "defaut", fenetreId: F }, genId), F]);
    const got = cases.map(([s, f]) => espaceActifPrive(s, f));
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
  it("voirWorkflow opens the builder on the action; lancer and arreter go to the kernel", async () => {
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

  it("a stopped host gives the answers without a kernel", async () => {
    const { F, api } = setup();
    const a = api(F);
    expect(await a.lancer("x", null)).toEqual({ statut: "invalide", erreur: "Le service des actions ne répond pas (agent arrêté ?)" });
    expect(await a.liste()).toEqual([]);
    expect(await a.page("x", null)).toBeNull();
    expect(await a.direct()).toEqual(NONE);
  });

  it("accorder never uses a private space's profile, read again at the grant", async () => {
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
    const running = { courantes: [{ action: "gitlab", debut: DEBUT, saisie: null, essai: false, etape: "workflow", blocs: {} }], enAttente: [] };
    const { F, api, calls, emit, etat, set, genId, media } = setup({
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
    // A host that started again: the feed is read again, only for the public window.
    emit(HOST_EXITED, { message: "stop" });
    emit("acces");
    await vi.waitFor(() => expect(seenPub).toHaveBeenCalledTimes(2));
    expect(seenPriv).not.toHaveBeenCalled();
    calls.length = 0;
    expect(await priv.liste()).toEqual([]);
    expect(await priv.page("gitlab", null)).toBeNull();
    expect(await priv.image("gitlab", "x", "https://img.test/a.png")).toBeNull();
    expect(await priv.direct()).toEqual(NONE);
    expect(calls).toEqual([]);
    expect(media.image).not.toHaveBeenCalled();
    expect(await pub.liste()).toEqual([{ id: "gitlab" }]);
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
    expect(s.calls).toEqual([{ method: "actions.imagePermise", params: { id: "gitlab", execution: "x", url: "https://img.test/absent.png" } }]);
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
    const off = api(F).surChange(cb);
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
    const { F, api, turnPrivate } = setup({ "actions.liste": answer([{ id: "gitlab" }]), "actions.page": answer({ execution: "x" }), "actions.executions": answer([{ id: "x" }]), "actions.direct": answer({ courantes: [{ action: "gitlab" }], enAttente: [] }) });
    const a = api(F);
    await Promise.all([a.liste(), a.page("gitlab", null), a.executions("gitlab"), a.direct()]);
    up = false;
    expect(await a.liste()).toEqual([{ id: "gitlab" }]);
    expect(await a.page("gitlab", null)).toEqual({ execution: "x" });
    expect(await a.executions("gitlab")).toEqual([{ id: "x" }]);
    expect(await a.page("gitlab", "y")).toBeNull();
    // Nothing runs while no host runs.
    expect(await a.direct()).toEqual(NONE);
    // Never in a private space.
    turnPrivate();
    expect(await a.liste()).toEqual([]);
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
    a.surChange(change);
    a.surDirect(direct);
    // The page's first read: no host answers, and this API saw no exit.
    expect(await a.liste()).toEqual([]);
    up = true;
    emit("acces");
    expect(change).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(direct).toHaveBeenCalledTimes(1));
    expect(await a.liste()).toEqual([{ id: "gitlab" }]);
    // A later acces, with no failure in between: nothing more.
    emit("acces");
    expect(change).toHaveBeenCalledTimes(1);
  });

  // One read of the host's pipe can hold both the refusal and the kernel's first acces: the acces listener runs before
  // the refusal's handler.
  it("a read refused just before the kernel's first acces, in the same read, reads again", async () => {
    let refuse!: (e: Error) => void;
    const { F, api, emit } = setup({ "actions.page": () => new Promise((_, no) => (refuse = no)) });
    const a = api(F);
    const change = vi.fn();
    a.surChange(change);
    const read = a.page("annonces", null);
    await vi.waitFor(() => expect(refuse).toBeTypeOf("function"));
    refuse(new Error("Le service des actions ne répond pas (agent arrêté ?)"));
    emit("acces");
    expect(await read).toBeNull();
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("acces without a preceding exit does not read again", async () => {
    const { F, api, emit, calls } = setup({ "actions.direct": () => NONE });
    const change = vi.fn();
    const direct = vi.fn();
    const a = api(F);
    a.surChange(change);
    a.surDirect(direct);
    emit("acces");
    await new Promise((r) => setTimeout(r, 0));
    expect(change).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("accorder: a stopped host is a missing kernel; a window turned private meanwhile is refused", async () => {
    const stopped = setup();
    expect(await stopped.api(stopped.F).accorder({ id: "gitlab", profil: "defaut", compte: ["gitlab.com"], publiques: [] })).toEqual({
      ok: false,
      erreur: "Le service des actions ne répond pas (agent arrêté ?)",
    });
    let turn = () => {};
    const s = setup({ "actions.accorder": () => (turn(), { ok: true }) });
    turn = () => s.turnPrivate();
    expect(await s.api(s.F).accorder({ id: "gitlab", profil: "defaut", compte: ["gitlab.com"], publiques: [] })).toEqual({ ok: false, erreur: ACTIONS_EN_ESPACE_PRIVE });
  });
  // Review Focus 1
  it("a window turned private while the host reads opens and launches nothing", async () => {
    let turn = () => {};
    const s = setup({ "actions.preparer": () => (turn(), { ok: true, nom: "GitLab", lancer: true }), "actions.lancer": () => ({ statut: "reussie", execution: "x" }) });
    turn = () => s.turnPrivate();
    s.dispatched.length = 0;
    expect(await s.api(s.F).ouvrir("gitlab", null)).toEqual({ ok: false, erreur: ACTIONS_EN_ESPACE_PRIVE });
    await new Promise((r) => setTimeout(r, 0));
    expect(s.calls.map((c) => c.method)).toEqual(["actions.preparer"]);
    expect(s.dispatched).toEqual([]);
  });

  /** The host's preparer over a fixed set of actions (noyau/actions.ts), `running` already in the direct feed. */
  const preparer = (running: string[] = []) => (p: { id: string; saisie: string | null }) => {
    const noms: Record<string, [string, boolean]> = { gitlab: ["GitLab", false], leboncoin: ["Leboncoin", true] };
    const a = noms[p.id];
    if (!a) return { ok: false, erreur: "Action inconnue" };
    return { ok: true, nom: a[0], lancer: !running.includes(p.id) && !(a[1] && !p.saisie?.trim()) };
  };
  const launched = (calls: { method: string; params: unknown }[]) => calls.filter((c) => c.method === "actions.lancer").map((c) => c.params);

  // actions.test.ts:402
  it("ouvrir opens the action's page titled with its name, then launches it", async () => {
    const { F, api, calls, etat } = setup({ "actions.preparer": preparer(), "actions.lancer": () => ({ statut: "reussie", execution: "x" }) });
    const a = api(F);
    expect(await a.ouvrir("gitlab", null)).toEqual({ ok: true });
    const onglets = Object.values(etat().onglets);
    expect(onglets).toHaveLength(1);
    expect(onglets[0]).toMatchObject({ url: "webaios://action/gitlab", titre: "GitLab" });
    expect(launched(calls)).toEqual([{ id: "gitlab", saisie: null }]);
    expect(await a.ouvrir("leboncoin", "clio lyon")).toEqual({ ok: true });
    expect(launched(calls)).toEqual([{ id: "gitlab", saisie: null }, { id: "leboncoin", saisie: "clio lyon" }]);
  });

  // actions.test.ts:413
  it("ouvrir without the required input opens the page and launches nothing; an unknown action is refused", async () => {
    const { F, api, calls, etat } = setup({ "actions.preparer": preparer() });
    const a = api(F);
    expect(await a.ouvrir("leboncoin", null)).toEqual({ ok: true });
    expect(await a.ouvrir("leboncoin", "  ")).toEqual({ ok: true });
    expect(Object.values(etat().onglets).map((o) => o.url)).toEqual(["webaios://action/leboncoin"]);
    expect(launched(calls)).toEqual([]);
    expect(await a.ouvrir("inconnue", null)).toEqual({ ok: false, erreur: "Action inconnue" });
  });

  // actions.test.ts:423
  it("ouvrir on a running action opens its page and launches nothing", async () => {
    const { F, api, calls, etat, set, genId } = setup({ "actions.preparer": preparer(["gitlab"]) });
    const a = api(F);
    expect(await a.ouvrir("gitlab", null)).toEqual({ ok: true });
    const page = Object.values(etat().onglets)[0]!;
    // Another tab comes first; opening again goes back to the action's page.
    set(appliquer(etat(), { type: "ouvrirOnglet", fenetreId: F, url: "https://a.test/" }, genId));
    expect(await a.ouvrir("gitlab", null)).toEqual({ ok: true });
    expect(Object.values(etat().onglets).filter((o) => o.url.startsWith("webaios://action/"))).toHaveLength(1);
    expect(etat().fenetres[0]!.actif[etat().fenetres[0]!.espaceActif]).toBe(page.id);
    expect(launched(calls)).toEqual([]);
  });

  it("ouvrir: a stopped host is a missing kernel; a failed launch goes to the console and reads again on the next acces", async () => {
    const stopped = setup();
    expect(await stopped.api(stopped.F).ouvrir("gitlab", null)).toEqual({ ok: false, erreur: "Le service des actions ne répond pas (agent arrêté ?)" });
    expect(stopped.dispatched).toEqual([]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup({ "actions.preparer": preparer() });
    const a = s.api(s.F);
    const change = vi.fn();
    a.surChange(change);
    expect(await a.ouvrir("gitlab", null)).toEqual({ ok: true });
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
      "actions.page": answer({ execution: "x" }),
      "actions.executions": answer([{ id: "x" }]),
      "actions.liste": answer([{ id: "gitlab" }]),
      "actions.refuserAccord": answer(undefined),
      "actions.supprimer": answer({ ok: true }),
    });
    const a = api(F);
    await Promise.all([a.page("gitlab", null), a.executions("gitlab"), a.liste()]);
    await a.refuserAccord("gitlab");
    up = false;
    // The results were erased with the grant: a stopped host gives no stale page back.
    expect(await a.page("gitlab", null)).toBeNull();
    expect(await a.executions("gitlab")).toEqual([]);
    up = true;
    await a.liste();
    expect(await a.supprimer("gitlab")).toEqual({ ok: true });
    up = false;
    expect(await a.liste()).toEqual([]);
    expect(await a.supprimer("gitlab")).toEqual({ ok: false, erreur: "Le service des actions ne répond pas (agent arrêté ?)" });
    expect(calls.filter((c) => c.method === "actions.refuserAccord" || c.method === "actions.supprimer").map((c) => c.params)).toEqual([{ id: "gitlab" }, { id: "gitlab" }, { id: "gitlab" }]);
    calls.length = 0;
    turnPrivate();
    await a.refuserAccord("gitlab");
    expect(await a.supprimer("gitlab")).toEqual({ ok: false, erreur: ACTIONS_EN_ESPACE_PRIVE });
    expect(await a.ouvrir("gitlab", null)).toEqual({ ok: false, erreur: ACTIONS_EN_ESPACE_PRIVE });
    expect(calls).toEqual([]);
  });

  it("components: each serve is paired with one store release; a private space serves none; unload releases what is left", async () => {
    const s = setup();
    const a = s.api(s.F);
    expect(await a.serveComponent("barres")).toBe("resource://webaios-composant-barres/composant-1.html");
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
    t.media.serve.mockImplementationOnce(async () => (t.turnPrivate(), "resource://webaios-composant-x/composant-1.html"));
    expect(await c.serveComponent("x")).toBeNull();
    c.releaseComponent("x");
    expect(t.media.release).toHaveBeenCalledWith("x");
  });
});
