import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import { OutilsDevOccupes } from "@webaios/noyau";
import type { WebContents } from "electron";
import { InspecteurCdp, TEXTE_REVOQUE } from "../../src/main/outils-dev/inspecteur";

const A = "http://localhost:15280/";
const B = "http://localhost:15281/";

/** Une réponse du protocole qu'on rend quand on veut. */
interface Attente {
  methode: string;
  params: any;
  ok: (v: unknown) => void;
  ko: (e: Error) => void;
}

/** Débogueur d'Electron simulé : les commandes listées dans `retenues` attendent `rendre`, les autres répondent `{}`. */
class FauxDebogueur extends EventEmitter {
  attache = false;
  envoyees: string[] = [];
  attentes: Attente[] = [];
  retenues = new Set<string>();
  reponses: Record<string, unknown> = {};
  attach() {
    this.attache = true;
  }
  detach() {
    this.attache = false;
  }
  isAttached() {
    return this.attache;
  }
  sendCommand(methode: string, params?: any): Promise<unknown> {
    this.envoyees.push(methode);
    if (!this.retenues.has(methode)) return Promise.resolve(this.reponses[methode] ?? {});
    return new Promise((ok, ko) => this.attentes.push({ methode, params, ok, ko }));
  }
  /** Rend la plus ancienne commande `methode` en attente. */
  rendre(methode: string, valeur: unknown = {}) {
    const i = this.attentes.findIndex((a) => a.methode === methode);
    if (i < 0) throw new Error(`aucune commande ${methode} en attente`);
    this.attentes.splice(i, 1)[0]!.ok(valeur);
  }
  combien(methode: string) {
    return this.envoyees.filter((m) => m === methode).length;
  }
  evenement(methode: string, params: unknown) {
    this.emit("message", {}, methode, params);
  }
}

class FauxWebContents extends EventEmitter {
  debugger = new FauxDebogueur();
  url = A;
  ouverts = false;
  rechargements = 0;
  getURL() {
    return this.url;
  }
  isDestroyed() {
    return false;
  }
  isDevToolsOpened() {
    return this.ouverts;
  }
  reload() {
    this.rechargements++;
  }
  reloadIgnoringCache() {
    this.rechargements++;
  }
  /** Le cadre principal arrive sur `url`. */
  naviguer(url: string) {
    this.url = url;
    this.debugger.evenement("Page.frameNavigated", { frame: { id: "principal", url } });
  }
  log(texte: string) {
    this.debugger.evenement("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: texte }], timestamp: Date.now() + 1000 });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function preparer() {
  const wc = new FauxWebContents();
  const inspecteur = new InspecteurCdp((id) => (id === "t" ? (wc as unknown as WebContents) : undefined));
  return { wc, inspecteur, dbg: wc.debugger };
}

const textes = async (i: InspecteurCdp) => (await i.console("t")).map((m) => m.texte);

describe("changement de site", () => {
  test("un appel après une navigation vers un autre site échoue, puis repart de zéro sur le nouveau site", async () => {
    const { wc, inspecteur } = preparer();
    await inspecteur.attacher("t");
    wc.log("sur A");
    wc.naviguer(B);
    wc.log("sur B, avant l'appel");
    await expect(inspecteur.console("t")).rejects.toThrow("L'onglet a changé de site.");
    wc.log("sur B, après");
    expect(await textes(inspecteur)).toEqual(["sur B, après"]);
  });

  test("A → B → A : rien de B n'atteint un appel sur A", async () => {
    const { wc, inspecteur } = preparer();
    await inspecteur.attacher("t");
    wc.log("A1");
    wc.naviguer(B);
    wc.log("secret de B");
    wc.debugger.evenement("Network.requestWillBeSent", { requestId: "b", request: { url: `${B}jeton`, method: "GET", headers: {} }, timestamp: 1 });
    wc.naviguer(A);
    wc.log("A2");
    await expect(inspecteur.console("t")).rejects.toThrow("L'onglet a changé de site.");
    expect(await textes(inspecteur)).toEqual([]);
    expect(await inspecteur.reseau("t")).toEqual([]);
    wc.log("A3");
    expect(await textes(inspecteur)).toEqual(["A3"]);
  });

  test("même site : les messages restent, marqués par « — page rechargée — »", async () => {
    const { wc, inspecteur } = preparer();
    await inspecteur.attacher("t");
    wc.log("avant");
    wc.naviguer(A);
    wc.log("après");
    expect(await textes(inspecteur)).toEqual(["avant", "— page rechargée —", "après"]);
  });

  test("executer : la page partie sur un autre site pendant l'appel → échec", async () => {
    const { wc, inspecteur, dbg } = preparer();
    dbg.retenues.add("Runtime.evaluate");
    const r = inspecteur.executer("t", "location.href = '…'", new AbortController().signal);
    await tick();
    wc.naviguer(B);
    dbg.rendre("Runtime.evaluate", { result: { type: "string", value: "…" } });
    await expect(r).rejects.toThrow("L'onglet a changé de site.");
  });

  test("recharger : une redirection vers un autre site → échec", async () => {
    const { wc, inspecteur } = preparer();
    await inspecteur.attacher("t");
    const r = inspecteur.recharger("t", false);
    await tick();
    expect(wc.rechargements).toBe(1);
    wc.naviguer(B);
    await expect(r).rejects.toThrow("L'onglet a changé de site.");
  });

  test("recharger sur le même site réussit", async () => {
    const { wc, inspecteur } = preparer();
    await inspecteur.attacher("t");
    const r = inspecteur.recharger("t", true);
    await tick();
    wc.naviguer(A);
    await expect(r).resolves.toBeUndefined();
  });
});

describe("outils de l'utilisateur", () => {
  test("un appel en cours quand l'utilisateur ouvre ses outils échoue avec OutilsDevOccupes", async () => {
    const { wc, inspecteur, dbg } = preparer();
    dbg.retenues.add("Runtime.evaluate");
    const r = inspecteur.executer("t", "1", new AbortController().signal);
    await tick();
    wc.ouverts = true;
    wc.emit("devtools-opened");
    await expect(r).rejects.toBeInstanceOf(OutilsDevOccupes);
    expect(dbg.attache).toBe(false);
    await expect(inspecteur.console("t")).rejects.toBeInstanceOf(OutilsDevOccupes);
    wc.ouverts = false;
    wc.emit("devtools-closed");
    await expect(inspecteur.console("t")).resolves.toEqual([]);
    expect(dbg.attache).toBe(true);
  });
});

describe("abandon", () => {
  test("un signal déjà levé rejette sans rien envoyer", async () => {
    const { inspecteur, dbg } = preparer();
    const c = new AbortController();
    c.abort();
    await expect(inspecteur.executer("t", "1", c.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(inspecteur.profiler("t", {}, c.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(inspecteur.instantaneMemoire("t", c.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(dbg.envoyees).toEqual([]);
  });

  test("executer abandonné : AbortError et Runtime.terminateExecution", async () => {
    const { inspecteur, dbg } = preparer();
    dbg.retenues.add("Runtime.evaluate");
    const c = new AbortController();
    const r = inspecteur.executer("t", "for (;;) {}", c.signal);
    await tick();
    c.abort();
    await expect(r).rejects.toMatchObject({ name: "AbortError" });
    expect(dbg.combien("Runtime.terminateExecution")).toBe(1);
  });

  test("profil abandonné : le profileur s'arrête, et le profil suivant attend cet arrêt", async () => {
    const { inspecteur, dbg } = preparer();
    dbg.retenues.add("Profiler.stop");
    const c = new AbortController();
    const premier = inspecteur.profiler("t", { dureeMs: 30_000 }, c.signal);
    await tick();
    expect(dbg.combien("Profiler.start")).toBe(1);
    c.abort();
    await expect(premier).rejects.toMatchObject({ name: "AbortError" });
    await tick();
    expect(dbg.combien("Profiler.stop")).toBe(1);
    dbg.reponses["Performance.getMetrics"] = { metrics: [{ name: "Nodes", value: 3 }] };
    const second = inspecteur.profiler("t", { dureeMs: 0 }, new AbortController().signal);
    await tick();
    expect(dbg.combien("Profiler.start")).toBe(1); // le premier n'est pas encore arrêté
    dbg.rendre("Profiler.stop");
    await tick();
    await tick();
    expect(dbg.combien("Profiler.start")).toBe(2);
    const profil = { nodes: [], samples: [], timeDeltas: [], startTime: 0, endTime: 1 };
    await expect.poll(() => dbg.attentes.some((a) => a.methode === "Profiler.stop")).toBe(true);
    dbg.rendre("Profiler.stop", { profile: profil });
    await expect(second).resolves.toEqual({ profil, metriques: { Nodes: 3 } });
  });

  test("instantané abandonné : le suivant attend la fin du premier et n'en reçoit aucun morceau", async () => {
    const { inspecteur, dbg } = preparer();
    dbg.retenues.add("HeapProfiler.takeHeapSnapshot");
    const c = new AbortController();
    const premier = inspecteur.instantaneMemoire("t", c.signal);
    await tick();
    dbg.evenement("HeapProfiler.addHeapSnapshotChunk", { chunk: "premier-1" });
    c.abort();
    await expect(premier).rejects.toMatchObject({ name: "AbortError" });
    const second = inspecteur.instantaneMemoire("t", new AbortController().signal);
    await tick();
    expect(dbg.combien("HeapProfiler.takeHeapSnapshot")).toBe(1);
    // V8 finit de transmettre le premier instantané.
    dbg.evenement("HeapProfiler.addHeapSnapshotChunk", { chunk: "premier-2" });
    dbg.rendre("HeapProfiler.takeHeapSnapshot");
    await expect.poll(() => dbg.combien("HeapProfiler.takeHeapSnapshot")).toBe(2);
    dbg.evenement("HeapProfiler.addHeapSnapshotChunk", { chunk: "second" });
    dbg.rendre("HeapProfiler.takeHeapSnapshot");
    await expect(second).resolves.toBe("second");
  });
});

describe("propriétaire (un noyau à la fois)", () => {
  test("un nouveau propriétaire révoque le précédent : ses appels sont refusés, ses attachements tombent", async () => {
    const { wc, inspecteur, dbg } = preparer();
    const ancien = inspecteur.proprietaire();
    await ancien.attacher("t");
    expect(ancien.attaches!()).toEqual(["t"]);
    expect(dbg.isAttached()).toBe(true);
    const nouveau = inspecteur.proprietaire();
    expect(dbg.isAttached()).toBe(false);
    expect(nouveau.attaches!()).toEqual([]);
    await expect(ancien.console("t")).rejects.toThrow(TEXTE_REVOQUE);
    await expect(ancien.attacher("t")).rejects.toThrow(TEXTE_REVOQUE);
    expect(dbg.isAttached()).toBe(false);
    // libérer un propriétaire révoqué ne touche pas au nouveau
    await nouveau.attacher("t");
    ancien.liberer();
    await ancien.detacher("t");
    expect(dbg.isAttached()).toBe(true);
    wc.log("pour le nouveau");
    expect((await nouveau.console("t")).map((m) => m.texte)).toEqual(["pour le nouveau"]);
    expect(inspecteur.attaches()).toEqual(["t"]);
  });

  test("un attachement en cours quand le noyau s'arrête (liberer) échoue et ne laisse rien d'attaché", async () => {
    const { inspecteur, dbg } = preparer();
    dbg.retenues.add("Runtime.enable");
    const p = inspecteur.proprietaire();
    const attache = p.attacher("t");
    await tick();
    p.liberer();
    await expect(attache).rejects.toThrow();
    expect(dbg.isAttached()).toBe(false);
    expect(inspecteur.attaches()).toEqual([]);
    await expect(p.reseau("t")).rejects.toThrow(TEXTE_REVOQUE);
  });
});
