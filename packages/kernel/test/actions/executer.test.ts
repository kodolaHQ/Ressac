import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spacePaths, type SpacePaths } from "../../src/paths.js";
import { FakeBridge } from "../../src/mcp/pont-factice.js";
import { giveGrant, removeGrant } from "../../src/widgets/accords.js";
import { ACTION_STOPPED, readRun, listRuns } from "../../src/workflows/executions.js";
import { withMemory, readMemory } from "../../src/workflows/memory.js";
import type { ProcessLauncher, DirectTrace } from "../../src/workflows/executer.js";
import type { AiAccessRun } from "../../src/ai/dispatcher.js";
import { lastResult, readResult } from "../../src/actions/data.js";
import { ACTION_UNKNOWN, actionGrantRequired, runAction, requiredInput, type OptionsAction, type TraceAction } from "../../src/actions/executer.js";
import { DeclarationAction } from "../../src/actions/schemas.js";
import { tempFolder } from "../helpers/temp.js";

const ENGINE = join(import.meta.dirname, "..", "..", "docker", "moteur");
const SCRIPT = join(ENGINE, "recolteur.mjs");
let instant = Date.parse("2026-10-31T10:00:00.000Z");
// Each call advances by a second: two runs in a row do not have the same id.
const clock = () => new Date((instant += 1000));

const PLAN = {
  blocs: [
    { composant: "titre", props: { texte: "Tickets" } },
    { composant: "liste", props: { elements: "tickets", titre: "titre" } },
  ],
};

/** A fake Gemma (a run's access): `reponse` returns the plan; its calls are counted. */
function fakeGemma(response: (o?: { signal?: AbortSignal; auDemarrage?: () => void }) => Promise<unknown> = async () => PLAN) {
  const calls: string[] = [];
  const ai: AiAccessRun & { appels: string[] } = {
    appels: calls,
    kev: async () => ({}),
    gemma: async (g, o) => {
      calls.push(g.prompt);
      o?.auDemarrage?.();
      return response(o) as never;
    },
    oublier: () => {},
  };
  return ai;
}

const toClean: string[] = [];
afterEach(async () => {
  await Promise.all(toClean.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface Bench {
  c: SpacePaths;
  dossierActions: string;
  dossier: string;
  commandes: string[][];
  supprimes: unknown[];
  pont: FakeBridge;
  lancer: ProcessLauncher;
}

const workflow = () =>
  JSON.stringify({
    version: 1,
    blocs: [{ id: "lire", type: "code", parametres: { source: "lire.mjs" } }, { id: "sortie", type: "sortie", parametres: { vers: "page" } }],
    liens: [{ de: "lire", vers: "sortie" }],
  });

async function prepare(id: string, declaration: unknown, code: string, o: { suspendues?: string[] } = {}): Promise<Bench> {
  const root = await tempFolder();
  const c = spacePaths(root);
  const folder = join(c.actions, id);
  await mkdir(folder, { recursive: true });
  await mkdir(c.composants, { recursive: true });
  await writeFile(join(folder, "action.json"), JSON.stringify(declaration));
  await writeFile(join(folder, "workflow.json"), workflow());
  await writeFile(join(folder, "lire.mjs"), code);
  const actionsFolder = await tempFolder();
  toClean.push(root, actionsFolder);
  const bridge = new FakeBridge([], {
    actif: null,
    autoriser: false,
    lecture: { pages: [{ url: "https://gitlab.com/tickets", titre: "Ouvrir la porte", texte: "", liens: [] }], ...(o.suspendues ? { suspendues: o.suspendues } : {}) },
  });
  const b: Bench = {
    c,
    dossierActions: actionsFolder,
    dossier: folder,
    commandes: [],
    supprimes: [],
    pont: bridge,
    lancer: (cmd, args) => {
      b.commandes.push([cmd, ...args]);
      const e = spawn(process.execPath, [SCRIPT, folder], { stdio: ["pipe", "pipe", "pipe"] });
      return { stdin: e.stdin, stdout: e.stdout, stderr: e.stderr, tuer: () => void e.kill("SIGKILL"), fin: new Promise((ok) => e.on("close", (x) => ok(x))) };
    },
  };
  return b;
}

const options = (b: Bench, id: string, o: Partial<OptionsAction> = {}): OptionsAction => ({
  id,
  chemins: b.c,
  dossierActions: b.dossierActions,
  moteur: ENGINE,
  atelier: {
    commandeRecolte: (p, d, m) => ["docker", "run", JSON.stringify(p), d, m],
    supprimerRecolte: async (p) => void b.supprimes.push(p),
  },
  lancer: b.lancer,
  pont: b.pont,
  ia: fakeGemma(),
  horloge: clock,
  saisie: null,
  declencheur: "manuelle",
  signal: new AbortController().signal,
  surTrace: () => {},
  surEtape: () => {},
  adressesLocales: true,
  ...o,
});

const GITLAB = { nom: "GitLab", sources: { compte: ["gitlab.com"] }, miseEnPage: "Les tickets en liste" };
const CODE_GITLAB = `export default async (e, w) => { const p = await w.lirePage("https://gitlab.com/tickets", { compte: true }); return { tickets: [{ titre: p.titre }] }; };`;
const gitlabGrant = (b: Bench) => giveGrant(b.dossierActions, "gitlab", { domaines: ["gitlab.com"], publiques: [], profil: "perso" });

describe("executerAction", () => {
  it("GitLab action with a grant: run reussie, result and plan written, status reussie", async () => {
    const b = await prepare("gitlab", GITLAB, CODE_GITLAB);
    await gitlabGrant(b);
    const ai = fakeGemma();
    const steps: string[] = [];
    const r = await runAction(options(b, "gitlab", { ia: ai, surEtape: (e) => steps.push(e) }));
    expect(r).toMatchObject({ statut: "reussie" });
    expect(r.execution).toBeDefined();
    const e = await readRun(join(b.dossierActions, "gitlab"), r.execution!);
    expect(e).toMatchObject({ statut: "reussie", proprietaire: { type: "action", id: "gitlab" }, declencheur: "manuelle" });
    const res = await readResult(b.dossierActions, "gitlab", r.execution!);
    expect(res).toEqual({
      version: 1,
      execution: r.execution,
      saisie: null,
      resultats: { tickets: [{ titre: "Ouvrir la porte" }] },
      plan: PLAN,
      secours: false,
      vide: false,
    });
    expect(ai.appels).toHaveLength(1);
    // The action's instruction is given to Gemma.
    expect(ai.appels[0]).toContain("Les tickets en liste");
    expect(steps).toEqual(["mise-en-page"]);
  });

  it("without a grant: accord-requis, no container launched, nothing written", async () => {
    const b = await prepare("gitlab", GITLAB, CODE_GITLAB);
    const r = await runAction(options(b, "gitlab"));
    expect(r).toEqual({ statut: "accord-requis", erreur: actionGrantRequired(DeclarationAction.parse(GITLAB)), erreurNoyau: true });
    expect(r.erreur).toBe("Accord requis pour lire avec ton compte : gitlab.com");
    expect(b.commandes).toEqual([]);
    expect(existsSync(join(b.dossierActions, "gitlab"))).toBe(false);
  });

  it("a stale grant (domains changed) is removed, the data erased", async () => {
    const b = await prepare("gitlab", GITLAB, CODE_GITLAB);
    await gitlabGrant(b);
    const first = await runAction(options(b, "gitlab"));
    expect(first.statut).toBe("reussie");
    await writeFile(join(b.dossier, "action.json"), JSON.stringify({ ...GITLAB, sources: { compte: ["gitlab.com", "github.com"] } }));
    const r = await runAction(options(b, "gitlab"));
    expect(r.statut).toBe("accord-requis");
    expect(await listRuns(join(b.dossierActions, "gitlab"))).toEqual([]);
  });

  it("unknown action: ACTION_INCONNUE, nothing written", async () => {
    const b = await prepare("gitlab", GITLAB, CODE_GITLAB);
    const r = await runAction(options(b, "absente"));
    expect(r).toMatchObject({ statut: "invalide", erreur: ACTION_UNKNOWN });
    expect(existsSync(join(b.dossierActions, "absente"))).toBe(false);
  });

  it("invalid workflow: invalide status, nothing written, no container", async () => {
    const b = await prepare("cassee", { nom: "C", sources: {} }, `export default async () => 1;`);
    await writeFile(join(b.dossier, "workflow.json"), "{pas du json");
    const r = await runAction(options(b, "cassee"));
    expect(r.statut).toBe("invalide");
    expect(r.erreur).toBeTruthy();
    expect(b.commandes).toEqual([]);
    expect(existsSync(join(b.dossierActions, "cassee"))).toBe(false);
  });

  it("saisie requise absente : saisieRequise(\"Recherche\")", async () => {
    const b = await prepare("leboncoin", { nom: "Leboncoin", sources: {}, saisie: { libelle: "Recherche" } }, `export default async (e, w) => ({ q: w.saisie });`);
    for (const input of [null, "   "]) {
      const r = await runAction(options(b, "leboncoin", { saisie: input }));
      expect(r).toEqual({ statut: "invalide", erreur: requiredInput("Recherche"), erreurNoyau: true });
    }
    expect(requiredInput("Recherche")).toBe("Saisie requise : Recherche");
    expect(b.commandes).toEqual([]);
  });

  it("« clio lyon » arrives in debut.saisie and in Execution.saisie", async () => {
    const b = await prepare("leboncoin", { nom: "Leboncoin", sources: {}, saisie: { libelle: "Recherche" } }, `export default async (e, w) => ({ annonces: [{ titre: w.saisie }] });`);
    const r = await runAction(options(b, "leboncoin", { saisie: "  clio lyon  " }));
    expect(r.statut).toBe("reussie");
    const e = await readRun(join(b.dossierActions, "leboncoin"), r.execution!);
    expect(e?.saisie).toBe("clio lyon");
    const res = await readResult(b.dossierActions, "leboncoin", r.execution!);
    // The agent's code received the input (sent in debut).
    expect(res?.resultats).toEqual({ annonces: [{ titre: "clio lyon" }] });
    expect(res?.saisie).toBe("clio lyon");
    // The summary carries it too (menu of the previous results on the action's page).
    expect((await listRuns(join(b.dossierActions, "leboncoin")))[0]?.saisie).toBe("clio lyon");
  });

  it("an input that is too long is cut to 200 characters", async () => {
    const b = await prepare("leboncoin", { nom: "Leboncoin", sources: {}, saisie: { libelle: "Recherche" } }, `export default async (e, w) => ({ annonces: [{ titre: w.saisie }] });`);
    const r = await runAction(options(b, "leboncoin", { saisie: "x".repeat(500) }));
    expect(r.statut).toBe("reussie");
    expect((await readRun(join(b.dossierActions, "leboncoin"), r.execution!))?.saisie).toBe("x".repeat(200));
  });

  it("empty results: empty result, Gemma never called", async () => {
    const b = await prepare("vide", { nom: "V", sources: {} }, `export default async () => ({ tickets: [] });`);
    const ai = fakeGemma();
    const r = await runAction(options(b, "vide", { ia: ai }));
    expect(r.statut).toBe("reussie");
    const res = await readResult(b.dossierActions, "vide", r.execution!);
    expect(res).toMatchObject({ vide: true, plan: null, secours: false });
    expect(ai.appels).toEqual([]);
  });

  it("Gemma absente : plan de secours, secours true", async () => {
    const b = await prepare("simple", { nom: "S", sources: {} }, `export default async () => ({ tickets: [{ titre: "a" }] });`);
    const r = await runAction(options(b, "simple", { ia: null }));
    expect(r.statut).toBe("reussie");
    const res = await readResult(b.dossierActions, "simple", r.execution!);
    expect(res?.secours).toBe(true);
    expect(res?.plan?.blocs.length).toBeGreaterThan(0);
  });

  it("the blocks' memory is written after the result; a failure does not touch it", async () => {
    const b = await prepare("memo", { nom: "M", sources: {} }, `export default async () => 1;`);
    const lignes = (end: unknown) => [
      { t: "bloc", id: "lire", etape: "debut" },
      { t: "bloc", id: "lire", etape: "fin", statut: "reussi", sortie: { tickets: [{ titre: "a" }] } },
      { t: "memoire", memoire: { lire: { type: "code", valeur: { vu: 1 } } } },
      { t: "bloc", id: "sortie", etape: "debut" },
      { t: "bloc", id: "sortie", etape: "fin", statut: "reussi", sortie: { tickets: [{ titre: "a" }] } },
      end,
    ];
    const r = await runAction(options(b, "memo", { lancer: launcherLines(lignes({ t: "fin", donnees: { tickets: [{ titre: "a" }] } })) }));
    expect(r.statut).toBe("reussie");
    expect((await readMemory(join(b.dossierActions, "memo"))).lire).toMatchObject({ type: "code", valeur: { vu: 1 } });
    const failure = await runAction(options(b, "memo", { lancer: launcherLines([{ t: "memoire", memoire: { lire: { type: "code", valeur: { vu: 2 } } } }, { t: "echec", erreur: "cassé" }]) }));
    expect(failure.statut).toBe("echouee");
    expect((await readMemory(join(b.dossierActions, "memo"))).lire).toMatchObject({ valeur: { vu: 1 } });
  });

  it("action deleted just before the memory write: the memory is not written", async () => {
    const b = await prepare("memo", { nom: "M", sources: {} }, `export default async () => 1;`);
    const lignes = [
      { t: "bloc", id: "lire", etape: "debut" },
      { t: "bloc", id: "lire", etape: "fin", statut: "reussi", sortie: { tickets: [{ titre: "a" }] } },
      { t: "memoire", memoire: { lire: { type: "code", valeur: { vu: 1 } } } },
      { t: "bloc", id: "sortie", etape: "debut" },
      { t: "bloc", id: "sortie", etape: "fin", statut: "reussi", sortie: { tickets: [{ titre: "a" }] } },
      { t: "fin", donnees: { tickets: [{ titre: "a" }] } },
    ];
    const dataFolder = join(b.dossierActions, "memo");
    // The memory is held (as during the erasing of its data): the run waits its turn to write it.
    let release!: () => void;
    const held = withMemory(dataFolder, () => new Promise<void>((ok) => (release = ok)));
    const end = runAction(options(b, "memo", { lancer: launcherLines(lignes) }));
    await waitUntil(() => existsSync(join(dataFolder, "resultats")));
    // The time the re-read that follows the result takes: the action is still there.
    await new Promise((ok) => setTimeout(ok, 200));
    await rm(b.dossier, { recursive: true, force: true });
    release();
    await held;
    const r = await end;
    expect(r.erreur).toBe(ACTION_UNKNOWN);
    expect(await readMemory(dataFolder)).toEqual({});
    expect(await listRuns(dataFolder)).toEqual([]);
  });

  it("grant removed during the run: nothing remains", async () => {
    const b = await prepare("gitlab", GITLAB, CODE_GITLAB, { suspendues: ["https://gitlab.com/tickets"] });
    await gitlabGrant(b);
    const end = runAction(options(b, "gitlab"));
    await waitUntil(() => b.pont.appels.some((a) => a.methode === "lirePageInvisible"));
    await removeGrant(b.dossierActions, "gitlab");
    b.pont.relacher("https://gitlab.com/tickets");
    const r = await end;
    expect(r.statut).toBe("accord-requis");
    expect(r.execution).toBeUndefined();
    expect(await listRuns(join(b.dossierActions, "gitlab"))).toEqual([]);
    expect(await lastResult(b.dossierActions, "gitlab")).toBeNull();
  });

  it("folder deleted during: nothing is written", async () => {
    const b = await prepare("public", { nom: "P", sources: { publiques: ["gitlab.com"] } }, `export default async (e, w) => ({ tickets: [{ titre: (await w.lirePage("https://gitlab.com/tickets")).titre }] });`, {
      suspendues: ["https://gitlab.com/tickets"],
    });
    const end = runAction(options(b, "public"));
    await waitUntil(() => b.pont.appels.some((a) => a.methode === "lirePageInvisible"));
    await rm(b.dossier, { recursive: true, force: true });
    b.pont.relacher("https://gitlab.com/tickets");
    const r = await end;
    expect(r.execution).toBeUndefined();
    expect(r.statut).toBe("invalide");
    expect(r.erreur).toBe(ACTION_UNKNOWN);
    expect(await listRuns(join(b.dossierActions, "public"))).toEqual([]);
  });

  it("actions folder missing for a moment during the run: nothing is written, the history stays", async () => {
    const b = await prepare("public", { nom: "P", sources: { publiques: ["gitlab.com"] } }, `export default async (e, w) => ({ tickets: [{ titre: (await w.lirePage("https://gitlab.com/tickets")).titre }] });`);
    const first = await runAction(options(b, "public"));
    expect(first.statut).toBe("reussie");
    const beforeMemory = await readMemory(join(b.dossierActions, "public"));
    // During the second one's layout, the actions folder disappears (volume unmounted, renamed…).
    const elsewhere = `${b.c.actions}-ailleurs`;
    const ai = fakeGemma(async () => {
      await rename(b.c.actions, elsewhere);
      return PLAN;
    });
    const r = await runAction(options(b, "public", { ia: ai }));
    await rename(elsewhere, b.c.actions);
    expect(r).toMatchObject({ statut: "invalide", erreur: ACTION_UNKNOWN });
    expect((await listRuns(join(b.dossierActions, "public"))).map((e) => e.id)).toEqual([first.execution]);
    expect((await lastResult(b.dossierActions, "public"))?.execution).toBe(first.execution);
    expect(await readMemory(join(b.dossierActions, "public"))).toEqual(beforeMemory);
  });

  it("kernel stop during the layout: run interrupted, without a result", async () => {
    const b = await prepare("simple", { nom: "S", sources: {} }, `export default async () => ({ tickets: [{ titre: "a" }] });`);
    const stop = new AbortController();
    let quit = false;
    const ai = fakeGemma(
      (o) =>
        new Promise((_ok, ko) => {
          o?.signal?.addEventListener("abort", () => ko(new Error("abandon")));
          setImmediate(() => {
            quit = true;
            stop.abort();
          });
        }),
    );
    const r = await runAction(options(b, "simple", { ia: ai, signal: stop.signal, interrompue: () => quit }));
    expect(r).toMatchObject({ statut: "interrompue", erreur: "Interrompue : WebAiOs s'est arrêté", erreurNoyau: true });
    expect(await readRun(join(b.dossierActions, "simple"), r.execution!)).toMatchObject({ statut: "interrompue" });
    expect(await readResult(b.dossierActions, "simple", r.execution!)).toBeNull();
  });

  it("signal raised during the workflow: interrompue, ACTION_ARRETEE; during the layout: reussie with fallback plan", async () => {
    const b = await prepare("public", { nom: "P", sources: { publiques: ["gitlab.com"] } }, `export default async (e, w) => ({ tickets: [{ titre: (await w.lirePage("https://gitlab.com/tickets")).titre }] });`, {
      suspendues: ["https://gitlab.com/tickets"],
    });
    const stop = new AbortController();
    const end = runAction(options(b, "public", { signal: stop.signal }));
    await waitUntil(() => b.pont.appels.some((a) => a.methode === "lirePageInvisible"));
    stop.abort();
    const r = await end;
    expect(r).toMatchObject({ statut: "interrompue", erreur: ACTION_STOPPED, erreurNoyau: true });
    const e = await readRun(join(b.dossierActions, "public"), r.execution!);
    expect(e).toMatchObject({ statut: "interrompue", erreur: ACTION_STOPPED });
    expect(await readResult(b.dossierActions, "public", r.execution!)).toBeNull();

    // During the layout: Gemma waits, the stop gives the fallback layout.
    const b2 = await prepare("simple", { nom: "S", sources: {} }, `export default async () => ({ tickets: [{ titre: "a" }] });`);
    const arret2 = new AbortController();
    const ai = fakeGemma(
      (o) =>
        new Promise((_ok, ko) => {
          o?.signal?.addEventListener("abort", () => ko(new Error("abandon")));
          setImmediate(() => arret2.abort());
        }),
    );
    const r2 = await runAction(options(b2, "simple", { ia: ai, signal: arret2.signal }));
    expect(r2.statut).toBe("reussie");
    expect((await readResult(b2.dossierActions, "simple", r2.execution!))?.secours).toBe(true);
  });

  it("kernel stop (interrompue): written run interrupted", async () => {
    const b = await prepare("public", { nom: "P", sources: { publiques: ["gitlab.com"] } }, `export default async (e, w) => ({ tickets: [{ titre: (await w.lirePage("https://gitlab.com/tickets")).titre }] });`, {
      suspendues: ["https://gitlab.com/tickets"],
    });
    const stop = new AbortController();
    const end = runAction(options(b, "public", { signal: stop.signal, interrompue: () => true }));
    await waitUntil(() => b.pont.appels.some((a) => a.methode === "lirePageInvisible"));
    stop.abort();
    const r = await end;
    expect(r.statut).toBe("interrompue");
    const e = await readRun(join(b.dossierActions, "public"), r.execution!);
    expect(e).toMatchObject({ statut: "interrompue", erreur: "Interrompue : WebAiOs s'est arrêté", erreurNoyau: true });
  });

  it("the workflow's traces are relayed", async () => {
    const b = await prepare("simple", { nom: "S", sources: {} }, `export default async () => ({ tickets: [{ titre: "a" }] });`);
    const traces: TraceAction[] = [];
    await runAction(options(b, "simple", { surTrace: (t) => traces.push(t) }));
    expect(traces).toContainEqual({ bloc: "lire", etape: "debut", type: "code" });
    // Each trace carries the block's type: the action's page shows its catalog label.
    expect(traces.every((t) => t.type === (t.bloc === "lire" ? "code" : "sortie"))).toBe(true);
  });

  it("trial: -essai run, result written, neither memory nor last result changed", async () => {
    const b = await prepare("simple", { nom: "S", sources: {} }, `export default async () => ({ tickets: [{ titre: "a" }] });`);
    const real = await runAction(options(b, "simple"));
    expect(real.statut).toBe("reussie");
    const memoryBefore = await readMemory(join(b.dossierActions, "simple"));
    const ai = fakeGemma();
    const r = await runAction(options(b, "simple", { ia: ai, declencheur: "rejeu", essai: { origine: real.execution!, depart: "lire" } }));
    expect(r.statut).toBe("reussie");
    expect(r.execution).toMatch(/-essai$/);
    const e = await readRun(join(b.dossierActions, "simple"), r.execution!);
    expect(e).toMatchObject({ declencheur: "rejeu", essai: { depart: "lire", origine: real.execution } });
    expect((await readResult(b.dossierActions, "simple", r.execution!))?.plan).toEqual(PLAN);
    expect((await lastResult(b.dossierActions, "simple"))?.execution).toBe(real.execution);
    expect(await readMemory(join(b.dossierActions, "simple"))).toEqual(memoryBefore);
  });

  it("trial from a missing run: refused, nothing written", async () => {
    const b = await prepare("simple", { nom: "S", sources: {} }, `export default async () => ({ tickets: [{ titre: "a" }] });`);
    const r = await runAction(options(b, "simple", { declencheur: "rejeu", essai: { origine: "2020-01-01T00-00-00-000Z", depart: "lire" } }));
    expect(r.statut).toBe("invalide");
    expect(b.commandes).toEqual([]);
  });
});

/** A fake container that writes these lines then exits with 0. */
function launcherLines(lignes: unknown[]): ProcessLauncher {
  return () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const end = new Promise<number | null>((ok) => {
      setImmediate(() => {
        for (const l of lignes) stdout.write(JSON.stringify(l) + "\n");
        stdout.end();
        stderr.end();
        setImmediate(() => ok(0));
      });
    });
    return { stdin, stdout, stderr, tuer: () => {}, fin: end };
  };
}

async function waitUntil(f: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("attente dépassée");
    await new Promise((ok) => setTimeout(ok, 10));
  }
}
