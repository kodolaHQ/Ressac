import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spacePaths } from "../../src/paths.js";
import { FakeBridge } from "../../src/mcp/fake-bridge.js";
import { createAiDispatcher } from "../../src/ai/dispatcher.js";
import { readRun } from "../../src/workflows/executions.js";
import { WidgetsScheduler } from "../../src/widgets/scheduler.js";
import type { HarvestOptions } from "../../src/widgets/harvest.js";
import type { OptionsAction, LaunchResult } from "../../src/actions/run.js";
import { CONCURRENT_ACTIONS, FileActions, type ActionsState, type OptionsFileActions } from "../../src/actions/file.js";
import { tempFolder } from "../helpers/temp.js";
import { declarationWidget, writeWidget } from "../helpers/home.js";

const ENGINE = join(import.meta.dirname, "..", "..", "docker", "moteur");
const SCRIPT = join(ENGINE, "recolteur.mjs");
const clock = (() => {
  let t = Date.parse("2026-10-31T10:00:00.000Z");
  return () => new Date((t += 1000));
})();

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((ok) => (resolve = ok));
  return { promesse: promise, resoudre: resolve };
}

const files: FileActions[] = [];
afterEach(async () => {
  await Promise.all(files.splice(0).map((f) => f.arreterTout()));
});

async function prepare(o: Partial<OptionsFileActions> = {}) {
  const c = spacePaths(await tempFolder());
  const actionsFolder = await tempFolder();
  const directs: ActionsState[] = [];
  const deleted: unknown[] = [];
  const f = new FileActions({
    chemins: c,
    dossierActions: actionsFolder,
    moteur: ENGINE,
    atelier: { etat: async () => "demarre", commandeRecolte: (p) => ["docker", JSON.stringify(p)], supprimerRecolte: async (p) => void deleted.push(p) },
    pont: new FakeBridge([], { actif: null, autoriser: false }),
    repartiteur: null,
    horloge: clock,
    surDirect: (e) => directs.push(e),
    ...o,
  });
  files.push(f);
  return { f, c, dossierActions: actionsFolder, directs, supprimes: deleted };
}

/** A fake run per action, which waits for `liberer(id)`. */
function kept() {
  const ends = new Map<string, (r: LaunchResult) => void>();
  const launched: OptionsAction[] = [];
  const run = (o: OptionsAction) => {
    launched.push(o);
    const d = deferred<LaunchResult>();
    ends.set(o.id, d.resoudre);
    return d.promesse;
  };
  const release = (id: string) => ends.get(id)!({ statut: "reussie", execution: `ex-${id}` });
  return { executer: run, lancees: launched, liberer: release };
}

const waitUntil = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("attente dépassée");
    await new Promise((ok) => setTimeout(ok, 5));
  }
};

describe("FileActions", () => {
  it("three actions: two run, the third waits and appears in enAttente", async () => {
    expect(CONCURRENT_ACTIONS).toBe(2);
    const r = kept();
    const { f } = await prepare({ executer: r.executer });
    const a = f.lancer("a", { saisie: null, declencheur: "manuelle" });
    const b = f.lancer("b", { saisie: "clio lyon", declencheur: "manuelle" });
    const c = f.lancer("c", { saisie: null, declencheur: "agent" });
    await waitUntil(() => r.lancees.length === 2);
    expect(r.lancees.map((o) => o.id)).toEqual(["a", "b"]);
    const d = f.direct();
    expect(d.courantes.map((x) => x.action)).toEqual(["a", "b"]);
    expect(d.courantes[1]).toMatchObject({ saisie: "clio lyon", essai: false, etape: "workflow", blocs: {} });
    expect(d.enAttente.map((x) => x.action)).toEqual(["c"]);
    expect(a.deja || b.deja || c.deja).toBe(false);
    r.liberer("a");
    expect(await a.fin).toEqual({ statut: "reussie", execution: "ex-a" });
    await waitUntil(() => r.lancees.length === 3);
    expect(f.direct().enAttente).toEqual([]);
    r.liberer("b");
    r.liberer("c");
    await Promise.all([b.fin, c.fin]);
    expect(f.direct()).toEqual({ courantes: [], enAttente: [] });
  });

  it("relaunching a running action returns deja: true and the same end", async () => {
    const r = kept();
    const { f } = await prepare({ executer: r.executer });
    const first = f.lancer("a", { saisie: null, declencheur: "manuelle" });
    const second = f.lancer("a", { saisie: "autre", declencheur: "manuelle" });
    expect(second.deja).toBe(true);
    expect(second.fin).toBe(first.fin);
    expect(f.essayer("a", "x", "y").deja).toBe(true);
    await waitUntil(() => r.lancees.length === 1);
    r.liberer("a");
    await first.fin;
    // Finished: a new request goes through.
    const third = f.lancer("a", { saisie: null, declencheur: "manuelle" });
    expect(third.deja).toBe(false);
    await waitUntil(() => r.lancees.length === 2);
    r.liberer("a");
    await third.fin;
  });

  it("a waiting action that is stopped leaves the queue without running", async () => {
    const r = kept();
    const { f } = await prepare({ executer: r.executer });
    f.lancer("a", { saisie: null, declencheur: "manuelle" });
    f.lancer("b", { saisie: null, declencheur: "manuelle" });
    const c = f.lancer("c", { saisie: null, declencheur: "manuelle" });
    await waitUntil(() => r.lancees.length === 2);
    expect(f.arreter("c")).toBe(true);
    expect((await c.fin).statut).toBe("interrompue");
    expect(f.direct().enAttente).toEqual([]);
    expect(f.arreter("inconnue")).toBe(false);
    // A running action receives the signal.
    expect(f.arreter("a")).toBe(true);
    expect(r.lancees[0]!.signal.aborted).toBe(true);
    r.liberer("a");
    r.liberer("b");
  });

  it("attend pret avant de lancer", async () => {
    const r = kept();
    const ready = deferred<void>();
    const { f } = await prepare({ executer: r.executer, pret: ready.promesse });
    f.lancer("a", { saisie: null, declencheur: "manuelle" });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(r.lancees).toEqual([]);
    ready.resoudre();
    await waitUntil(() => r.lancees.length === 1);
    r.liberer("a");
  });

  it("each action has its priority AI access, forgotten at the end", async () => {
    const r = kept();
    const dispatcher = createAiDispatcher({ kev: async () => ({}), gemma: async () => "ok" } as never);
    const keys: { cle: string; prioritaire?: boolean }[] = [];
    let forgotten = 0;
    const spy = {
      pour: (key: string, o?: { prioritaire?: boolean }) => {
        keys.push({ cle: key, ...(o?.prioritaire !== undefined ? { prioritaire: o.prioritaire } : {}) });
        const access = dispatcher.pour(key, o);
        return { ...access, oublier: () => (forgotten++, access.oublier()) };
      },
    };
    const { f } = await prepare({ executer: r.executer, repartiteur: spy });
    const a = f.lancer("a", { saisie: null, declencheur: "manuelle" });
    await waitUntil(() => r.lancees.length === 1);
    expect(r.lancees[0]!.ia).not.toBeNull();
    expect(keys).toHaveLength(1);
    expect(keys[0]!.cle).toMatch(/^action:a:2026-/);
    expect(keys[0]!.prioritaire).toBe(true);
    r.liberer("a");
    await a.fin;
    expect(forgotten).toBe(1);
  });

  it("an action starts while a widget harvest is running", async () => {
    const r = kept();
    const { f, c } = await prepare({ executer: r.executer });
    await writeWidget(c, "lent", declarationWidget(undefined, { recolte: { minutes: 60 } }), { "recolte.mjs": "export default () => 1" });
    const keptHarvest = deferred<void>();
    let harvestStarted = false;
    const p = new WidgetsScheduler({
      chemins: c,
      dossierWidgets: await tempFolder(),
      moteur: ENGINE,
      atelier: { etat: async () => "demarre", commandeRecolte: () => ["docker"], supprimerRecolte: async () => {} },
      pont: new FakeBridge([], { actif: null, autoriser: false }),
      ia: null,
      recolter: async (_o: HarvestOptions) => {
        harvestStarted = true;
        await keptHarvest.promesse;
        return { etat: { statut: "ok", derniereMaj: null, derniereTentative: null } };
      },
    });
    const harvest = p.recolterMaintenant("lent");
    await waitUntil(() => harvestStarted);
    const a = f.lancer("a", { saisie: null, declencheur: "manuelle" });
    await waitUntil(() => r.lancees.length === 1);
    r.liberer("a");
    expect((await a.fin).statut).toBe("reussie");
    keptHarvest.resoudre();
    await harvest;
    await p.arreter();
  });

  it("lecture and avancement traces fill direct()", async () => {
    const r = kept();
    const { f, directs } = await prepare({ executer: r.executer });
    const a = f.lancer("a", { saisie: null, declencheur: "manuelle" });
    await waitUntil(() => r.lancees.length === 1);
    const o = r.lancees[0]!;
    o.surTrace({ bloc: "lire", etape: "debut" });
    o.surTrace({ bloc: "lire", etape: "lecture", hote: "gitlab.com" });
    o.surTrace({ bloc: "lire", etape: "avancement", faits: 7, total: 12 });
    expect(f.direct().courantes[0]!.blocs).toEqual({ lire: { statut: "en-cours", elements: null, hote: "gitlab.com", faits: 7, total: 12 } });
    o.surTrace({ bloc: "lire", etape: "fin", statut: "reussi", elements: 12 });
    expect(f.direct().courantes[0]!.blocs.lire).toMatchObject({ statut: "reussi", elements: 12 });
    o.surEtape("mise-en-page");
    expect(f.direct().courantes[0]!.etape).toBe("mise-en-page");
    // surDirect is called on each change.
    expect(directs.some((d) => d.courantes[0]?.blocs.lire?.hote === "gitlab.com")).toBe(true);
    expect(directs.at(-1)!.courantes[0]!.etape).toBe("mise-en-page");
    // direct() is a copy.
    f.direct().courantes[0]!.blocs.lire!.statut = "echoue";
    expect(f.direct().courantes[0]!.blocs.lire!.statut).toBe("reussi");
    r.liberer("a");
    await a.fin;
    expect(directs.at(-1)).toEqual({ courantes: [], enAttente: [] });
  });

  it("the block type relayed by the trace goes into direct()", async () => {
    const r = kept();
    const { f } = await prepare({ executer: r.executer });
    const a = f.lancer("a", { saisie: null, declencheur: "manuelle" });
    await waitUntil(() => r.lancees.length === 1);
    const o = r.lancees[0]!;
    o.surTrace({ bloc: "trier", etape: "debut", type: "ia.trier" });
    expect(f.direct().courantes[0]!.blocs.trier).toEqual({ statut: "en-cours", elements: null, type: "ia.trier" });
    o.surTrace({ bloc: "trier", etape: "fin", statut: "reussi", elements: 2, type: "ia.trier" });
    expect(f.direct().courantes[0]!.blocs.trier).toEqual({ statut: "reussi", elements: 2, type: "ia.trier" });
    r.liberer("a");
    await a.fin;
  });

  it("arreterTout: written run interrupted", async () => {
    const c0 = spacePaths(await tempFolder());
    const folder = join(c0.actions, "public");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "action.json"), JSON.stringify({ nom: "P", sources: { publiques: ["gitlab.com"] } }));
    await writeFile(
      join(folder, "workflow.json"),
      JSON.stringify({
        version: 1,
        blocs: [{ id: "lire", type: "code", parametres: { source: "lire.mjs" } }, { id: "sortie", type: "sortie", parametres: { vers: "page" } }],
        liens: [{ de: "lire", vers: "sortie" }],
      }),
    );
    await writeFile(join(folder, "lire.mjs"), `export default async (e, w) => ({ t: (await w.lirePage("https://gitlab.com/x")).titre });`);
    const bridge = new FakeBridge([], { actif: null, autoriser: false, lecture: { pages: [], suspendues: ["https://gitlab.com/x"] } });
    const { f, dossierActions: actionsFolder, supprimes: deleted } = await prepare({
      chemins: c0,
      pont: bridge,
      adressesLocales: true,
      lancer: () => {
        const e = spawn(process.execPath, [SCRIPT, folder], { stdio: ["pipe", "pipe", "pipe"] });
        return { stdin: e.stdin, stdout: e.stdout, stderr: e.stderr, tuer: () => void e.kill("SIGKILL"), fin: new Promise((ok) => e.on("close", (x) => ok(x))) };
      },
    });
    const a = f.lancer("public", { saisie: null, declencheur: "manuelle" });
    await waitUntil(() => bridge.appels.some((x) => x.methode === "lirePageInvisible"));
    await f.arreterTout();
    const r = await a.fin;
    expect(r.statut).toBe("interrompue");
    const e = await readRun(join(actionsFolder, "public"), r.execution!);
    expect(e).toMatchObject({ statut: "interrompue", erreur: "Interrompue : WebAiOs s'est arrêté", erreurNoyau: true });
    expect(deleted).toContainEqual({ type: "action", id: "public" });
    // After the stop, nothing leaves anymore.
    expect((await f.lancer("public", { saisie: null, declencheur: "manuelle" }).fin).statut).toBe("interrompue");
  });
});
