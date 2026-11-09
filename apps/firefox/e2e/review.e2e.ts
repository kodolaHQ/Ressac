import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { reviewUrl } from "../shared/modele";
import { dispatch, inWindow, newWindow, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { declareProject, LINES, modified, openApplications, refreshReview, reviewedRef, writeAppJs } from "./review";
import { writeSite } from "./sites";
import { click, inUi, missingApi, waitUi } from "./ui";

// Plan 34 Task 4: the Review page on a declared external project (spec §6),
// a site app's « Relire », and Review Focus 3 and 4.

const dirs: string[] = [];
let w: LaunchedWebAiOs | undefined;
let m: Marionette;
afterEach(async () => {
  try {
    if (w) expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
    w = undefined;
  }
});
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** WebAiOs on a temporary data folder (`prepare` writes into it first), the Applications page open. */
async function launch(o: { env?: Record<string, string>; prepare?: (dataDir: string) => void } = {}): Promise<LaunchedWebAiOs> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  dirs.push(dataDir, profile);
  o.prepare?.(dataDir);
  w = await launchWebAiOs({ dataDir, profile, env: o.env });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  await openApplications(m);
  return w;
}

const tid = (id: string) => `[data-testid="${id}"]`;
const PAGE = tid("page-relecture");
const count = (selector: string) => inUi<number>(m, "return doc.querySelectorAll(arguments[0]).length", [selector]);
const waitCount = (selector: string, n: number, ms = 10_000) => waitUi(m, "return doc.querySelectorAll(arguments[0]).length === arguments[1]", [selector, n], ms);
const texts = (selector: string) => inUi<string[]>(m, "return [...doc.querySelectorAll(arguments[0])].map((e) => e.textContent)", [selector]);
const waitTexts = (selector: string, t: string[], ms = 10_000) =>
  waitUi(m, "return JSON.stringify([...doc.querySelectorAll(arguments[0])].map((e) => e.textContent)) === arguments[1]", [selector, JSON.stringify(t)], ms);
const fileRow = (path: string) => inUi<string | null>(m, `return [...doc.querySelectorAll('${tid("fichier-relecture")}')].find((e) => e.querySelector(".nom-fichier").textContent === arguments[0])?.textContent ?? null`, [path]);
const openFile = (path: string) => click(m, tid("fichier-relecture"), { text: path });
const ADDED = `${tid("ligne-diff")}.ajout`;
const REMOVED = `${tid("ligne-diff")}.retrait`;
/** The new line numbers of the context lines shown. */
const context = () => inUi<number[]>(m, `return [...doc.querySelectorAll('${tid("ligne-diff")}.contexte')].map((l) => Number(l.dataset.nouveau))`);
const waitContext = (n: number[]) => expect.poll(context, { timeout: 10_000 }).toEqual(n);
/** The tabs of the Review page of `projet`, every window together. */
const reviewTabs = async (project: string) => Object.values((await state(m)).onglets).filter((o) => o.url === reviewUrl(project));
const tabsOf = (f: { ordre: Record<string, string[]> }) => Object.values(f.ordre).flat();

/** « Relire » of the projet-externe line, on the Applications page; waits for the Review page. */
async function reread(): Promise<void> {
  await click(m, `${tid("projet-externe")} button`, { text: "Relire" });
  await waitUi(m, `return !!doc.querySelector('${PAGE}')`);
}

/** Back to the Applications page of the current window (its tab, activated again). */
async function backToApplications(): Promise<void> {
  const windowId = await m.execute<string>("return window.webaiosWindow.fenetreId");
  await dispatch(m, { type: "ouvrirApplications", fenetreId: windowId });
  await waitUi(m, `return !!doc.querySelector('${tid("projets-externes")}') && !doc.querySelector('${PAGE}')`);
}

/** A declared project with line `n` of app.js changed, its Review page open on app.js. */
async function pageOnAppJs(n: number) {
  const p = await declareProject(m, { dataDir: w!.dataDir });
  writeAppJs(p.dossier, modified(n));
  await reread();
  await openFile("app.js");
  await waitTexts(ADDED, [`${n}ligne ${n} modifiée`]);
  return p;
}

// relecture.spec.ts:52
it("at start the first photo is taken (refs/webaios/relu under <dataDir>/design/relecture/ext-<id>.git) and no .git appears in the project folder", async () => {
  await launch();
  const p = await declareProject(m, { dataDir: w!.dataDir });
  try {
    expect(existsSync(reviewedRef(w!.dataDir, `ext-${p.id}`))).toBe(true);
    expect(readdirSync(p.dossier).sort()).toEqual(["app.js", "logo.bin"]);
    expect(existsSync(path.join(p.dossier, "..", ".git"))).toBe(false);
  } finally {
    await p.client.close();
  }
});

// relecture.spec.ts:65
it("after changing app.js (line 15) and adding note.md: « Relire » opens page-relecture with app.js (~) and note.md (+); line 15 removed and added, 3 context lines each side", async () => {
  await launch();
  const p = await declareProject(m, { dataDir: w!.dataDir });
  try {
    writeAppJs(p.dossier, modified(15));
    writeFileSync(path.join(p.dossier, "note.md"), "# Note\n");
    await reread();
    const tabs = await reviewTabs(`ext-${p.id}`);
    expect(tabs.map((o) => o.titre)).toEqual(["Relecture — mon-site"]);
    await waitCount(tid("fichier-relecture"), 2);
    expect(await fileRow("app.js")).toContain("~");
    expect(await fileRow("app.js")).toContain("+1 −1");
    expect(await fileRow("note.md")).toContain("+");
    await openFile("app.js");
    await waitTexts(REMOVED, ["15ligne 15"]);
    expect(await texts(ADDED)).toEqual(["15ligne 15 modifiée"]);
    expect(await context()).toEqual([12, 13, 14, 16, 17, 18]);
    // Read only: no editable field on the code.
    expect(await count(`${PAGE} :is(textarea, input, [contenteditable])`)).toBe(0);
  } finally {
    await p.client.close();
  }
});

// relecture.spec.ts:89
it("deplier-contexte shows lines 1 to 11", async () => {
  await launch();
  const p = await pageOnAppJs(15);
  try {
    await waitContext([12, 13, 14, 16, 17, 18]);
    await click(m, tid("deplier-contexte"));
    await waitContext([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18]);
    expect(await texts(`${tid("ligne-diff")}[data-nouveau="1"]`)).toEqual(["11ligne 1"]);
  } finally {
    await p.client.close();
  }
});

// relecture.spec.ts:106
it("logo.bin changed (a NUL byte): « fichier binaire »", async () => {
  await launch();
  const p = await declareProject(m, { dataDir: w!.dataDir });
  try {
    writeFileSync(path.join(p.dossier, "logo.bin"), Buffer.from([0x89, 0x00, 0x4e, 0x47]));
    await reread();
    await openFile("logo.bin");
    await waitUi(m, `return doc.querySelector('${tid("diff-fichier")}')?.textContent.includes("fichier binaire")`);
    expect(await count(tid("ligne-diff"))).toBe(0);
  } finally {
    await p.client.close();
  }
});

// relecture.spec.ts:121
it("a file changed while the page is open: nothing changes before « Rafraîchir », then the new diff", async () => {
  await launch();
  const p = await pageOnAppJs(15);
  try {
    writeAppJs(p.dossier, modified(15, 25));
    writeFileSync(path.join(p.dossier, "autre.txt"), "autre\n");
    await new Promise((r) => setTimeout(r, 1500));
    await openFile("app.js");
    await new Promise((r) => setTimeout(r, 300));
    expect(await texts(ADDED)).toEqual(["15ligne 15 modifiée"]);
    expect(await count(tid("fichier-relecture"))).toBe(1);
    await refreshReview(m);
    await waitCount(tid("fichier-relecture"), 2);
    await waitTexts(ADDED, ["15ligne 15 modifiée", "25ligne 25 modifiée"]);
  } finally {
    await p.client.close();
  }
});

// relecture.spec.ts:144
it("changed, then another tab and back: the page shows the old diff until « Rafraîchir »", async () => {
  await launch();
  const p = await pageOnAppJs(15);
  try {
    writeAppJs(p.dossier, modified(15, 25));
    // Another tab (the Applications page), then back to the Review tab: the page is mounted again.
    const s = await state(m);
    const apps = Object.values(s.onglets).find((o) => o.titre === "Applications")!.id;
    const review = (await reviewTabs(`ext-${p.id}`))[0]!.id;
    await click(m, tid(`onglet-${apps}`));
    await waitCount(PAGE, 0);
    await click(m, tid(`onglet-${review}`));
    await waitCount(PAGE, 1);
    await openFile("app.js");
    await waitTexts(ADDED, ["15ligne 15 modifiée"]);
    await new Promise((r) => setTimeout(r, 300));
    expect(await texts(ADDED)).toEqual(["15ligne 15 modifiée"]);
    await refreshReview(m);
    await waitTexts(ADDED, ["15ligne 15 modifiée", "25ligne 25 modifiée"]);
  } finally {
    await p.client.close();
  }
});

// relecture.spec.ts:168 (the « same page » part; the badge and the design menu are plans 35-36)
it("« Relire » twice from « Projets externes »: the same page, one tab « Relecture — mon-site »", async () => {
  await launch();
  const p = await declareProject(m, { dataDir: w!.dataDir });
  try {
    await reread();
    await backToApplications();
    await reread();
    const tabs = await reviewTabs(`ext-${p.id}`);
    expect(tabs.map((o) => o.titre)).toEqual(["Relecture — mon-site"]);
  } finally {
    await p.client.close();
  }
});

// relecture.spec.ts:200 (the Review part; design mode is plan 35's)
it("WEBAIOS_GIT=/chemin/absent: the page says « git est nécessaire », no ref written", async () => {
  await launch({ env: { WEBAIOS_GIT: "/chemin/absent" } });
  const p = await declareProject(m, { dataDir: w!.dataDir, snapshot: false });
  try {
    await reread();
    await waitUi(m, `return doc.querySelector('${PAGE}')?.textContent.includes("git est nécessaire")`);
    expect(existsSync(reviewedRef(w!.dataDir, `ext-${p.id}`))).toBe(false);
  } finally {
    await p.client.close();
  }
});

// relecture.spec.ts:404
it("reopening the shown file (a second click in the list) does not close the comment being written", async () => {
  await launch();
  const p = await pageOnAppJs(15);
  try {
    await click(m, `${tid("ligne-diff")}[data-nouveau="15"] ${tid("ajouter-commentaire")}`);
    const FORM = tid("formulaire-commentaire");
    await waitUi(
      m,
      `const t = doc.querySelector(arguments[0] + " textarea");
       if (!t) return false;
       t.value = "en cours";
       t.dispatchEvent(new ui.Event("input", { bubbles: true }));
       return true;`,
      [FORM],
    );
    await openFile("app.js");
    await new Promise((r) => setTimeout(r, 500));
    expect(await inUi<string | null>(m, "return doc.querySelector(arguments[0] + ' textarea')?.value ?? null", [FORM])).toBe("en cours");
  } finally {
    await p.client.close();
  }
});

// Spec §5.3: the Sites card's « Relire » opens the Review page, no longer the internal page.
it("at start the site app's first photo exists under <dataDir>/design/relecture/site-<id>.git; Relire of its Sites card opens the page with the changed file", async () => {
  await launch({
    prepare: (d) => writeSite(d, "essai", { declaration: { nom: "Essai", adresse: "https://essai.example/", domaines: ["essai.example"] }, fichiers: { "app.js": LINES.join("\n") + "\n" } }),
  });
  await expect.poll(() => existsSync(reviewedRef(w!.dataDir, "site-essai")), { timeout: 15_000 }).toBe(true);
  writeAppJs(path.join(w!.dataDir, "espace", "sites", "essai"), modified(15));
  await click(m, tid("site-essai-relire"));
  await waitUi(m, `return !!doc.querySelector('${PAGE}')`);
  expect((await reviewTabs("site-essai")).map((o) => o.titre)).toEqual(["Relecture — Essai"]);
  await waitCount(tid("fichier-relecture"), 1);
  expect(await fileRow("app.js")).toContain("~");
  await openFile("app.js");
  await waitTexts(ADDED, ["15ligne 15 modifiée"]);
  expect(await count(tid("page-interne"))).toBe(0);
});

// Review Focus 3
it("forgetting a project under its open Review page: Rafraîchir says projet inconnu", async () => {
  await launch();
  const p = await pageOnAppJs(15);
  try {
    const project = `ext-${p.id}`;
    const review = (await reviewTabs(project))[0]!.id;
    // A comment, so that its file exists before « Oublier ».
    await click(m, `${tid("ligne-diff")}[data-nouveau="15"] ${tid("ajouter-commentaire")}`);
    await waitUi(
      m,
      `const t = doc.querySelector('${tid("formulaire-commentaire")} textarea');
       if (!t) return false;
       t.value = "Plus court";
       t.dispatchEvent(new ui.Event("input", { bubbles: true }));
       return true;`,
    );
    await click(m, `${tid("formulaire-commentaire")} button`, { text: "Commenter" });
    await waitCount(tid("commentaire-relecture"), 1);
    const reviewDir = path.join(w!.dataDir, "design", "relecture");
    const comments = path.join(reviewDir, `${project}.commentaires.json`);
    expect(existsSync(comments)).toBe(true);
    await backToApplications();
    await click(m, `${tid("projet-externe")} button`, { text: "Oublier" });
    await waitCount(tid("projet-externe"), 0);
    await expect.poll(() => existsSync(path.join(reviewDir, `${project}.git`)) || existsSync(comments), { timeout: 10_000 }).toBe(false);
    await click(m, tid(`onglet-${review}`));
    await waitCount(PAGE, 1);
    await refreshReview(m);
    await waitUi(m, `return doc.querySelector('${tid("relecture-indisponible")}')?.textContent === "Relecture indisponible : projet inconnu"`);
    expect(await count(tid("erreur-relecture"))).toBe(0);
  } finally {
    await p.client.close();
  }
});

// Review Focus 4
it("Relire in a second window opens the page there, once", async () => {
  await launch();
  const p = await declareProject(m, { dataDir: w!.dataDir });
  try {
    const a = (await state(m)).fenetres[0]!.id;
    const b = await newWindow(m);
    await inWindow(m, b, async () => {
      await backToApplications();
      await reread();
      await backToApplications();
      await reread();
    });
    const s = await state(m);
    const tabs = await reviewTabs(`ext-${p.id}`);
    expect(tabs).toHaveLength(1);
    const fb = s.fenetres.find((f) => f.id !== a)!;
    expect(tabsOf(fb)).toContain(tabs[0]!.id);
    expect(fb.actif[fb.espaceActif]).toBe(tabs[0]!.id);
    const fa = s.fenetres.find((f) => f.id === a)!;
    expect(tabsOf(fa)).not.toContain(tabs[0]!.id);
    expect(s.onglets[fa.actif[fa.espaceActif]!]!.titre).toBe("Applications");
    expect(await count(PAGE)).toBe(0);
  } finally {
    await p.client.close();
  }
});
