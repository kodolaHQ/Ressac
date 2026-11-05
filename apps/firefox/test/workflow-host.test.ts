import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { cheminsEspace } from "../../../packages/noyau/src/index";
import * as electron from "../../navigateur/src/commun/api";
import * as copy from "../noyau/workflow";
import { readCode, readEdition, saveCode, saveEdition, workflowOpen, WriteQueue } from "../noyau/workflow";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const workflow = {
  version: 1,
  blocs: [
    { id: "page", type: "source.page", position: { x: 0, y: 0 }, parametres: { url: "https://x.test/" } },
    { id: "sortie", type: "sortie", position: { x: 1, y: 0 }, parametres: {} },
  ],
  liens: [{ de: "page", vers: "sortie" }],
};

function mount() {
  const racine = realpathSync(mkdtempSync(join(tmpdir(), "workflow-host-")));
  dirs.push(racine);
  const chemins = cheminsEspace(join(racine, "espace"));
  const dossier = join(chemins.widgets, "veille");
  mkdirSync(dossier, { recursive: true });
  const decl = { nom: "Veille", tailles: { min: { l: 1, h: 1 }, max: { l: 4, h: 4 }, defaut: { l: 2, h: 2 } }, sources: { compte: [], publiques: ["x.test"] } };
  writeFileSync(join(dossier, "widget.json"), JSON.stringify(decl));
  writeFileSync(join(dossier, "workflow.json"), JSON.stringify(workflow));
  return { racine, chemins, dossier, c: { chemins, dossierWidgets: join(racine, "widgets") } };
}

describe("widget workflow edition", () => {
  it("reads the blocks, saves a valid draft, refuses an invalid one without touching the file", async () => {
    const m = mount();
    const e = await readEdition(m.c, "veille");
    expect(e).toMatchObject({ origine: "fichier", validation: { ok: true }, widget: { nom: "Veille" } });
    expect((e?.brut as typeof workflow).blocs.map((b) => b.id)).toEqual(["page", "sortie"]);
    const moved = { ...workflow, blocs: [{ ...workflow.blocs[0]!, position: { x: 5, y: 5 } }, workflow.blocs[1]!] };
    expect(await saveEdition(m.c, "veille", moved)).toMatchObject({ ok: true, avertissements: [] });
    const saved = readFileSync(join(m.dossier, "workflow.json"), "utf8");
    expect(JSON.parse(saved).blocs[0].position).toEqual({ x: 5, y: 5 });
    const bad = await saveEdition(m.c, "veille", { version: 1, blocs: [], liens: [] });
    expect(bad).toMatchObject({ ok: false, avertissements: [] });
    expect(readFileSync(join(m.dossier, "workflow.json"), "utf8")).toBe(saved);
  });

  it("refuse a symlinked widget folder and a hostile code name", async () => {
    const m = mount();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "workflow-outside-")));
    dirs.push(outside);
    writeFileSync(join(outside, "widget.json"), readFileSync(join(m.dossier, "widget.json")));
    writeFileSync(join(outside, "tri.mjs"), "secret");
    renameSync(m.dossier, join(m.chemins.widgets, "old"));
    symlinkSync(outside, m.dossier);
    expect(await readEdition(m.c, "veille")).toBeNull();
    expect(await saveEdition(m.c, "veille", workflow)).toMatchObject({ ok: false, erreur: "Widget introuvable", avertissements: [] });
    expect(await readCode(m.chemins, "veille", "tri.mjs")).toEqual({ erreur: "Widget introuvable" });
    expect(await saveCode(m.chemins, "veille", "neuf.mjs", "pwned")).toEqual({ ok: false, erreur: "Widget introuvable" });
    expect(existsSync(join(outside, "workflow.json"))).toBe(false);
    expect(existsSync(join(outside, "neuf.mjs"))).toBe(false);

    const real = join(m.chemins.widgets, "reel");
    mkdirSync(real);
    expect(await readCode(m.chemins, "reel", "../x.mjs")).toEqual({ erreur: expect.any(String) });
    expect(await saveCode(m.chemins, "reel", "../x.mjs", "pwned")).toMatchObject({ ok: false });
    expect(existsSync(join(m.chemins.widgets, "x.mjs"))).toBe(false);
    expect(await saveCode(m.chemins, "reel", "tri.mjs", "ok")).toEqual({ ok: true });
    expect(await readCode(m.chemins, "reel", "tri.mjs")).toEqual({ texte: "ok" });
  });
});

describe("WriteQueue", () => {
  it("runs one key in series, two keys in parallel", async () => {
    const q = new WriteQueue();
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a1 = q.inSeries("a", async () => {
      log.push("a1-start");
      await gate;
      log.push("a1-end");
    });
    const a2 = q.inSeries("a", async () => void log.push("a2"));
    await q.inSeries("b", async () => void log.push("b"));
    expect(log).toEqual(["a1-start", "b"]);
    release();
    await Promise.all([a1, a2]);
    expect(log).toEqual(["a1-start", "b", "a1-end", "a2"]);
  });
});

describe("workflowOpen", () => {
  it("gives the open widget and the block selected on it only", () => {
    expect(workflowOpen("webaios://workflow/veille", { widget: "veille", bloc: "tri" })).toEqual({ widget: "veille", bloc: "tri" });
    expect(workflowOpen("webaios://workflow/veille", { widget: "autre", bloc: "tri" })).toEqual({ widget: "veille", bloc: null });
    expect(workflowOpen("https://x.test/", { widget: "veille", bloc: "tri" })).toBeNull();
    expect(workflowOpen(undefined, undefined)).toBeNull();
  });
});

describe("IPC schemas copied from Electron", () => {
  it("match commun/api.ts", () => {
    for (const k of ["SchemaCible", "SchemaBlocWorkflow", "SchemaNomCode", "SchemaCodeWorkflow", "SchemaBrouillon", "SchemaIdExecution"] as const)
      expect(z.toJSONSchema(copy[k], { unrepresentable: "any" }), k).toEqual(z.toJSONSchema(electron[k], { unrepresentable: "any" }));
    for (const v of [{ cible: { type: "widget", id: "a" }, bloc: "b" }, { cible: { type: "action", id: "a" }, bloc: "" }, { cible: { type: "x" } }])
      expect(copy.selectionConstructeur(v)).toEqual(electron.selectionConstructeur(v));
    // The byte limit is a refine, which the JSON schema cannot show: 256 KB of 2-byte characters is under the length limit.
    const tooBig = "é".repeat(128 * 1024 + 1);
    expect([copy.SchemaCodeWorkflow.safeParse(tooBig).success, electron.SchemaCodeWorkflow.safeParse(tooBig).success]).toEqual([false, false]);
    const fits = "é".repeat(128 * 1024);
    expect([copy.SchemaCodeWorkflow.safeParse(fits).success, electron.SchemaCodeWorkflow.safeParse(fits).success]).toEqual([true, true]);
  });
});

describe("fenetres.actives mirror", () => {
  it("sends only workflow URLs, on start and on each active-tab change", async () => {
    // bridge.ts loads invisible.ts, which asks ChromeUtils for a Firefox module at load time.
    (globalThis as { ChromeUtils?: unknown }).ChromeUtils ??= { importESModule: () => ({}) };
    const { etatInitial } = await import("../../navigateur/src/main/etat/etat-initial");
    const { createStore } = await import("../chrome/store/store");
    const { sendMirror, trackState } = await import("../chrome/agent/bridge");
    const store = createStore(etatInitial());
    const f = store.state.fenetres[0]!.id;
    const windows = { active: () => f } as unknown as Parameters<typeof trackState>[2];
    const sent: [string, unknown][] = [];
    const notify = (m: string, p: unknown) => void sent.push([m, p]);
    sendMirror(store, windows, notify);
    trackState(store, { notify, request: () => Promise.resolve() } as unknown as Parameters<typeof trackState>[1], windows);
    store.dispatch({ type: "ouvrirOnglet", fenetreId: f, url: "webaios://workflow/veille" }, () => "t1");
    store.dispatch({ type: "ouvrirOnglet", fenetreId: f, url: "https://x.test/" }, () => "t2");
    expect(sent.filter(([m]) => m === "fenetres.actives").map(([, p]) => p)).toEqual([{ [f]: null }, { [f]: "webaios://workflow/veille" }, { [f]: null }]);
  });
});
