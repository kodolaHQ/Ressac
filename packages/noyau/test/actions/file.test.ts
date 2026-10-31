import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cheminsEspace } from "../../src/chemins.js";
import { PontFactice } from "../../src/mcp/pont-factice.js";
import { creerRepartiteurIa } from "../../src/ia/repartiteur.js";
import { lireExecution } from "../../src/workflows/executions.js";
import { PlanificateurWidgets } from "../../src/widgets/planificateur.js";
import type { OptionsRecolte } from "../../src/widgets/recolte.js";
import type { OptionsAction, ResultatLancement } from "../../src/actions/executer.js";
import { ACTIONS_SIMULTANEES, FileActions, type EtatActions, type OptionsFileActions } from "../../src/actions/file.js";
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
  const c = cheminsEspace(await dossierTemporaire());
  const dossierActions = await dossierTemporaire();
  const directs: EtatActions[] = [];
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

/** Une exécution factice par action, qui attend `liberer(id)`. */
function retenues() {
  const fins = new Map<string, (r: ResultatLancement) => void>();
  const lancees: OptionsAction[] = [];
  const executer = (o: OptionsAction) => {
    lancees.push(o);
    const d = differe<ResultatLancement>();
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
  it("trois actions : deux tournent, la troisième attend et apparaît dans enAttente", async () => {
    expect(ACTIONS_SIMULTANEES).toBe(2);
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

  it("relancer une action en cours rend deja: true et la même fin", async () => {
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
    // Finie : une nouvelle demande part.
    const troisieme = f.lancer("a", { saisie: null, declencheur: "manuelle" });
    expect(troisieme.deja).toBe(false);
    await attendreQue(() => r.lancees.length === 2);
    r.liberer("a");
    await troisieme.fin;
  });

  it("une action en attente arrêtée sort de la file sans tourner", async () => {
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
    // Une action qui tourne reçoit le signal.
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

  it("chaque action a son accès prioritaire à l'IA, oublié à la fin", async () => {
    const r = retenues();
    const repartiteur = creerRepartiteurIa({ kev: async () => ({}), gemma: async () => "ok" } as never);
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

  it("une action part pendant qu'une récolte de widget tourne", async () => {
    const r = retenues();
    const { f, c } = await preparer({ executer: r.executer });
    await ecrireWidget(c, "lent", declarationWidget(undefined, { recolte: { minutes: 60 } }), { "recolte.mjs": "export default () => 1" });
    const recolteRetenue = differe<void>();
    let recolteCommencee = false;
    const p = new PlanificateurWidgets({
      chemins: c,
      dossierWidgets: await dossierTemporaire(),
      moteur: MOTEUR,
      atelier: { etat: async () => "demarre", commandeRecolte: () => ["docker"], supprimerRecolte: async () => {} },
      pont: new PontFactice([], { actif: null, autoriser: false }),
      ia: null,
      recolter: async (_o: OptionsRecolte) => {
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

  it("les traces lecture et avancement remplissent direct()", async () => {
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
    // surDirect est appelé à chaque changement.
    expect(directs.some((d) => d.courantes[0]?.blocs.lire?.hote === "gitlab.com")).toBe(true);
    expect(directs.at(-1)!.courantes[0]!.etape).toBe("mise-en-page");
    // direct() est une copie.
    f.direct().courantes[0]!.blocs.lire!.statut = "echoue";
    expect(f.direct().courantes[0]!.blocs.lire!.statut).toBe("reussi");
    r.liberer("a");
    await a.fin;
    expect(directs.at(-1)).toEqual({ courantes: [], enAttente: [] });
  });

  it("arreterTout : exécution écrite interrompue", async () => {
    const c0 = cheminsEspace(await dossierTemporaire());
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
    // Après l'arrêt, plus rien ne part.
    expect((await f.lancer("public", { saisie: null, declencheur: "manuelle" }).fin).statut).toBe("interrompue");
  });
});
