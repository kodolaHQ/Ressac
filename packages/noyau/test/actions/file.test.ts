import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spacePaths } from "../../src/chemins.js";
import { PontFactice } from "../../src/mcp/pont-factice.js";
import { createAiDispatcher } from "../../src/ia/repartiteur.js";
import { lireExecution } from "../../src/workflows/executions.js";
import { WidgetsScheduler } from "../../src/widgets/planificateur.js";
import type { HarvestOptions } from "../../src/widgets/recolte.js";
import type { OptionsAction, LaunchResult } from "../../src/actions/executer.js";
import { CONCURRENT_ACTIONS, FileActions, type ActionsState, type OptionsFileActions } from "../../src/actions/file.js";
import { dossierTemporaire } from "../aide/temporaire.js";
import { declarationWidget, ecrireWidget } from "../aide/accueil.js";

const MOTEUR = join(import.meta.dirname, "..", "..", "docker", "moteur");
const SCRIPT = join(MOTEUR, "recolteur.mjs");
const horloge = (() => {
  let t = Date.parse("2026-10-31T10:00:00.000Z");
  return () => new Date((t += 1000));
})();

function differe<T>() {
  let resoudre!: (v: T) => void;
  const promesse = new Promise<T>((ok) => (resoudre = ok));
  return { promesse, resoudre };
}

const files: FileActions[] = [];
afterEach(async () => {
  await Promise.all(files.splice(0).map((f) => f.arreterTout()));
});

async function preparer(o: Partial<OptionsFileActions> = {}) {
  const c = spacePaths(await dossierTemporaire());
  const dossierActions = await dossierTemporaire();
  const directs: ActionsState[] = [];
  const supprimes: unknown[] = [];
  const f = new FileActions({
    chemins: c,
    dossierActions,
    moteur: MOTEUR,
    atelier: { etat: async () => "demarre", commandeRecolte: (p) => ["docker", JSON.stringify(p)], supprimerRecolte: async (p) => void supprimes.push(p) },
    pont: new PontFactice([], { actif: null, autoriser: false }),
    repartiteur: null,
    horloge,
    surDirect: (e) => directs.push(e),
    ...o,
  });
  files.push(f);
  return { f, c, dossierActions, directs, supprimes };
}

/** A fake run per action, which waits for `liberer(id)`. */
function retenues() {
  const fins = new Map<string, (r: LaunchResult) => void>();
  const lancees: OptionsAction[] = [];
  const executer = (o: OptionsAction) => {
    lancees.push(o);
    const d = differe<LaunchResult>();
    fins.set(o.id, d.resoudre);
    return d.promesse;
  };
  const liberer = (id: string) => fins.get(id)!({ statut: "reussie", execution: `ex-${id}` });
  return { executer, lancees, liberer };
}

const attendreQue = async (f: () => boolean, ms = 5000) => {
  const fin = Date.now() + ms;
  while (!f()) {
    if (Date.now() > fin) throw new Error("attente dépassée");
    await new Promise((ok) => setTimeout(ok, 5));
  }
};

describe("FileActions", () => {
  it("three actions: two run, the third waits and appears in enAttente", async () => {
    expect(CONCURRENT_ACTIONS).toBe(2);
    const r = retenues();
    const { f } = await preparer({ executer: r.executer });
    const a = f.lancer("a", { saisie: null, declencheur: "manuelle" });
    const b = f.lancer("b", { saisie: "clio lyon", declencheur: "manuelle" });
    const c = f.lancer("c", { saisie: null, declencheur: "agent" });
    await attendreQue(() => r.lancees.length === 2);
    expect(r.lancees.map((o) => o.id)).toEqual(["a", "b"]);
    const d = f.direct();
    expect(d.courantes.map((x) => x.action)).toEqual(["a", "b"]);
    expect(d.courantes[1]).toMatchObject({ saisie: "clio lyon", essai: false, etape: "workflow", blocs: {} });
    expect(d.enAttente.map((x) => x.action)).toEqual(["c"]);
    expect(a.deja || b.deja || c.deja).toBe(false);
    r.liberer("a");
    expect(await a.fin).toEqual({ statut: "reussie", execution: "ex-a" });
    await attendreQue(() => r.lancees.length === 3);
    expect(f.direct().enAttente).toEqual([]);
    r.liberer("b");
    r.liberer("c");
    await Promise.all([b.fin, c.fin]);
    expect(f.direct()).toEqual({ courantes: [], enAttente: [] });
  });

  it("relaunching a running action returns deja: true and the same end", async () => {
    const r = retenues();
    const { f } = await preparer({ executer: r.executer });
    const premier = f.lancer("a", { saisie: null, declencheur: "manuelle" });
    const second = f.lancer("a", { saisie: "autre", declencheur: "manuelle" });
    expect(second.deja).toBe(true);
    expect(second.fin).toBe(premier.fin);
    expect(f.essayer("a", "x", "y").deja).toBe(true);
    await attendreQue(() => r.lancees.length === 1);
    r.liberer("a");
    await premier.fin;
    // Finished: a new request goes through.
    const troisieme = f.lancer("a", { saisie: null, declencheur: "manuelle" });
    expect(troisieme.deja).toBe(false);
    await attendreQue(() => r.lancees.length === 2);
    r.liberer("a");
    await troisieme.fin;
  });

  it("a waiting action that is stopped leaves the queue without running", async () => {
    const r = retenues();
    const { f } = await preparer({ executer: r.executer });
    f.lancer("a", { saisie: null, declencheur: "manuelle" });
    f.lancer("b", { saisie: null, declencheur: "manuelle" });
    const c = f.lancer("c", { saisie: null, declencheur: "manuelle" });
    await attendreQue(() => r.lancees.length === 2);
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
    const r = retenues();
    const pret = differe<void>();
    const { f } = await preparer({ executer: r.executer, pret: pret.promesse });
    f.lancer("a", { saisie: null, declencheur: "manuelle" });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(r.lancees).toEqual([]);
    pret.resoudre();
    await attendreQue(() => r.lancees.length === 1);
    r.liberer("a");
  });

  it("each action has its priority AI access, forgotten at the end", async () => {
    const r = retenues();
    const repartiteur = createAiDispatcher({ kev: async () => ({}), gemma: async () => "ok" } as never);
    const cles: { cle: string; prioritaire?: boolean }[] = [];
    let oublies = 0;
    const espion = {
      pour: (cle: string, o?: { prioritaire?: boolean }) => {
        cles.push({ cle, ...(o?.prioritaire !== undefined ? { prioritaire: o.prioritaire } : {}) });
        const acces = repartiteur.pour(cle, o);
        return { ...acces, oublier: () => (oublies++, acces.oublier()) };
      },
    };
    const { f } = await preparer({ executer: r.executer, repartiteur: espion });
    const a = f.lancer("a", { saisie: null, declencheur: "manuelle" });
    await attendreQue(() => r.lancees.length === 1);
    expect(r.lancees[0]!.ia).not.toBeNull();
    expect(cles).toHaveLength(1);
    expect(cles[0]!.cle).toMatch(/^action:a:2026-/);
    expect(cles[0]!.prioritaire).toBe(true);
    r.liberer("a");
    await a.fin;
    expect(oublies).toBe(1);
  });

  it("an action starts while a widget harvest is running", async () => {
    const r = retenues();
    const { f, c } = await preparer({ executer: r.executer });
    await ecrireWidget(c, "lent", declarationWidget(undefined, { recolte: { minutes: 60 } }), { "recolte.mjs": "export default () => 1" });
    const recolteRetenue = differe<void>();
    let recolteCommencee = false;
    const p = new WidgetsScheduler({
      chemins: c,
      dossierWidgets: await dossierTemporaire(),
      moteur: MOTEUR,
      atelier: { etat: async () => "demarre", commandeRecolte: () => ["docker"], supprimerRecolte: async () => {} },
      pont: new PontFactice([], { actif: null, autoriser: false }),
      ia: null,
      recolter: async (_o: HarvestOptions) => {
        recolteCommencee = true;
        await recolteRetenue.promesse;
        return { etat: { statut: "ok", derniereMaj: null, derniereTentative: null } };
      },
    });
    const recolte = p.recolterMaintenant("lent");
    await attendreQue(() => recolteCommencee);
    const a = f.lancer("a", { saisie: null, declencheur: "manuelle" });
    await attendreQue(() => r.lancees.length === 1);
    r.liberer("a");
    expect((await a.fin).statut).toBe("reussie");
    recolteRetenue.resoudre();
    await recolte;
    await p.arreter();
  });

  it("lecture and avancement traces fill direct()", async () => {
    const r = retenues();
    const { f, directs } = await preparer({ executer: r.executer });
    const a = f.lancer("a", { saisie: null, declencheur: "manuelle" });
    await attendreQue(() => r.lancees.length === 1);
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
    const r = retenues();
    const { f } = await preparer({ executer: r.executer });
    const a = f.lancer("a", { saisie: null, declencheur: "manuelle" });
    await attendreQue(() => r.lancees.length === 1);
    const o = r.lancees[0]!;
    o.surTrace({ bloc: "trier", etape: "debut", type: "ia.trier" });
    expect(f.direct().courantes[0]!.blocs.trier).toEqual({ statut: "en-cours", elements: null, type: "ia.trier" });
    o.surTrace({ bloc: "trier", etape: "fin", statut: "reussi", elements: 2, type: "ia.trier" });
    expect(f.direct().courantes[0]!.blocs.trier).toEqual({ statut: "reussi", elements: 2, type: "ia.trier" });
    r.liberer("a");
    await a.fin;
  });

  it("arreterTout: written run interrupted", async () => {
    const c0 = spacePaths(await dossierTemporaire());
    const dossier = join(c0.actions, "public");
    await mkdir(dossier, { recursive: true });
    await writeFile(join(dossier, "action.json"), JSON.stringify({ nom: "P", sources: { publiques: ["gitlab.com"] } }));
    await writeFile(
      join(dossier, "workflow.json"),
      JSON.stringify({
        version: 1,
        blocs: [{ id: "lire", type: "code", parametres: { source: "lire.mjs" } }, { id: "sortie", type: "sortie", parametres: { vers: "page" } }],
        liens: [{ de: "lire", vers: "sortie" }],
      }),
    );
    await writeFile(join(dossier, "lire.mjs"), `export default async (e, w) => ({ t: (await w.lirePage("https://gitlab.com/x")).titre });`);
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: [], suspendues: ["https://gitlab.com/x"] } });
    const { f, dossierActions, supprimes } = await preparer({
      chemins: c0,
      pont,
      adressesLocales: true,
      lancer: () => {
        const e = spawn(process.execPath, [SCRIPT, dossier], { stdio: ["pipe", "pipe", "pipe"] });
        return { stdin: e.stdin, stdout: e.stdout, stderr: e.stderr, tuer: () => void e.kill("SIGKILL"), fin: new Promise((ok) => e.on("close", (x) => ok(x))) };
      },
    });
    const a = f.lancer("public", { saisie: null, declencheur: "manuelle" });
    await attendreQue(() => pont.appels.some((x) => x.methode === "lirePageInvisible"));
    await f.arreterTout();
    const r = await a.fin;
    expect(r.statut).toBe("interrompue");
    const e = await lireExecution(join(dossierActions, "public"), r.execution!);
    expect(e).toMatchObject({ statut: "interrompue", erreur: "Interrompue : WebAiOs s'est arrêté", erreurNoyau: true });
    expect(supprimes).toContainEqual({ type: "action", id: "public" });
    // After the stop, nothing leaves anymore.
    expect((await f.lancer("public", { saisie: null, declencheur: "manuelle" }).fin).statut).toBe("interrompue");
  });
});
