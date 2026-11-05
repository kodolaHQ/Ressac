import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, missingApi, pressKeys, waitUi } from "./ui";
import { nodes, openBuilder, widgetDir, writeWidget } from "./workflows";

// The workflow builder on webaios://workflow/<widget>, opened from the home page's widget menu (Electron's
// constructeur.spec.ts, ported).

/** A workflow shipped by the agent, without positions: a page, its links taken by code, sorted by Kev, then their texts. */
const WORKFLOW_VEILLE = {
  version: 1,
  blocs: [
    { id: "page", type: "source.page", parametres: { url: "{config.url}" } },
    { id: "liens", type: "code", nom: "Liens de la page", parametres: { source: "liens.mjs" } },
    { id: "tri", type: "ia.trier", nom: "Tri par Kev", parametres: { question: "Parle d'IA ?", texte: "{texte}", seuil: 0.5 } },
    { id: "textes", type: "code", parametres: { source: "textes.mjs" } },
    { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
  ],
  liens: [
    { de: "page", vers: "liens" },
    { de: "liens", vers: "tri" },
    { de: "tri", vers: "textes" },
    { de: "textes", vers: "sortie" },
  ],
};

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** What the builder may have written in a widget's folder: names and modification times. */
const snapshot = async (dir: string) => (await Promise.all((await readdir(dir)).map(async (f) => `${f}:${(await stat(path.join(dir, f))).mtimeMs}`))).sort();

let dataDir: string;
let w: LaunchedWebAiOs;
let m: Marionette;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-builder-"));
  await writeWidget(dataDir, "veille", {
    nom: "Veille",
    recolte: { minutes: 60 },
    declaration: { config: { url: "https://exemple.invalid/liens" } },
    workflow: WORKFLOW_VEILLE,
    fichiers: {
      "liens.mjs": "export default async (page) => page.liens;",
      "textes.mjs": "export default async (liens) => ({ liens: liens.map((l) => l.texte) });",
    },
  });
  await writeWidget(dataDir, "sans", { nom: "Sans récolte" });
  w = await launchWebAiOs({ dataDir });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
});
afterAll(async () => {
  await w?.close();
  await rm(dataDir, { recursive: true, force: true });
});
afterEach(async () => {
  expect(await missingApi(m)).toEqual([]);
});

/** Back to the home page of the window. */
async function home(): Promise<void> {
  await dispatch(m, { type: "afficherPageVide", fenetreId: (await state(m)).fenetres[0]!.id });
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"widget-veille\"]')");
}

describe("the workflow builder", () => {
  it("opening the builder of a shipped workflow without positions lays it out in columns and writes nothing", async () => {
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"widget-veille\"] iframe')");
    const before = await snapshot(widgetDir(dataDir, "veille"));
    await openBuilder(m, "veille");
    expect(await waitUi(m, "return doc.querySelector('[data-testid=\"constructeur\"] h1')?.textContent")).toBe("Veille");
    const ids = ["page", "liens", "tri", "textes", "sortie"];
    expect((await waitUi<string[] | false>(m, "const n = [...doc.querySelectorAll('.svelte-flow__node')]; return n.length === 5 && n.map((x) => x.dataset.id)")) as string[]).toEqual(
      expect.arrayContaining(ids),
    );
    expect((await nodes(m)).sort()).toEqual([...ids].sort());
    const boxes = await inUi<Box[]>(
      m,
      "return arguments[0].map((id) => { const r = doc.querySelector('[data-testid=\"noeud-' + id + '\"]').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })",
      [ids],
    );
    const liens = await inUi<string>(m, "return doc.querySelector('[data-testid=\"noeud-liens\"]').textContent");
    expect(liens).toContain("Liens de la page");
    expect(liens).toContain("code");
    // One column per rank, left to right, no overlap.
    for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.x).toBeGreaterThan(boxes[i - 1]!.x + boxes[i - 1]!.width / 2);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i]!, boxes[j]!)).toBe(false);
    expect(await waitUi(m, "return doc.querySelector('[data-testid=\"etat-enregistrement\"]')?.textContent.trim() === 'Enregistré'")).toBe(true);

    // Selecting and reorganising write nothing either.
    await click(m, '[data-testid="noeud-tri"]');
    await click(m, '[data-testid="reorganiser"]');
    await new Promise((r) => setTimeout(r, 1000));
    expect(await snapshot(widgetDir(dataDir, "veille"))).toEqual(before);
  });

  it("a widget without a harvest has no « Voir / modifier le workflow » in its menu", async () => {
    await home();
    await click(m, '[data-testid="widget-sans"] button[aria-label="Options du widget"]');
    const items = await waitUi<string[] | false>(m, "const l = [...doc.querySelectorAll('[data-testid=\"widget-sans\"] [role=\"menuitem\"]')]; return l.length > 0 && l.map((b) => b.textContent.trim())");
    expect(items).toEqual(["Mettre à jour maintenant", "Retirer"]);
    // Closes the menu.
    await click(m, '[data-testid="widget-sans"] button[aria-label="Options du widget"]');
  });

  it("opening the same widget's entry twice keeps a single builder tab", async () => {
    await home();
    await openBuilder(m, "veille");
    await home();
    await openBuilder(m, "veille");
    const tabs = Object.values((await state(m)).onglets).filter((o) => o.url === "webaios://workflow/veille");
    expect(tabs.map((o) => o.titre)).toEqual(["Workflow — Veille"]);
  });

  it("⌘J and ✦ on a builder tab show its Agent tab and open the agent panel, never closing it", async () => {
    await home();
    await openBuilder(m, "veille");
    const panelShown = () => m.execute<boolean>("return !document.getElementById('webaios-agent').hidden");
    const agentTab = () => inUi<string | null>(m, "return doc.querySelector('[data-testid=\"onglet-agent\"]')?.getAttribute('aria-selected')");
    // Leaving the home page closed the panel it had opened.
    await waitFor(m, "return document.getElementById('webaios-agent').hidden", (v) => v === true);
    expect(await agentTab()).toBe("false");
    await pressKeys(m, "Meta+j");
    await waitFor(m, "return !document.getElementById('webaios-agent').hidden", (v) => v === true);
    expect(await waitUi(m, "return doc.querySelector('[data-testid=\"onglet-agent\"]')?.getAttribute('aria-selected') === 'true'")).toBe(true);
    expect(await m.execute("return document.activeElement?.id")).toBe("webaios-agent");
    await pressKeys(m, "Meta+j");
    await click(m, '[data-testid="bouton-agent"]');
    await new Promise((r) => setTimeout(r, 300));
    expect(await panelShown()).toBe(true);
    expect(await agentTab()).toBe("true");
  });

  it("an action's builder tab shows the internal page", async () => {
    await dispatch(m, { type: "ouvrirWorkflow", fenetreId: (await state(m)).fenetres[0]!.id, id: "x", nom: "X", proprietaire: "action" });
    expect(await waitUi(m, "return !!doc.querySelector('[data-testid=\"page-interne\"]')")).toBe(true);
    expect(await inUi(m, "return !!doc.querySelector('[data-testid=\"constructeur\"]')")).toBe(false);
  });
});
