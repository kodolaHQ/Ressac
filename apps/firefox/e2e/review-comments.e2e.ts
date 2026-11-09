import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { NO_CLIENT } from "../../../packages/kernel/src/design/projects";
import { PAGE_LINE_CHANGED as LIGNE_CHANGEE, RANGE_OUTSIDE_BLOCK, reviewUrl } from "../shared/model";
import { state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { declareProject, LINES, modified, openApplications, refreshReview, textOf, writeAppJs } from "./review";
import { writeSite } from "./sites";
import { click, inUi, missingApi, waitUi } from "./ui";

// Plan 34 Task 5: review comments, sent to Claude Code (the external MCP's queue) or to the agent (pre-filled, never
// sent), and Review Focus 5.

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
async function launch(o: { prepare?: (dataDir: string) => void } = {}): Promise<LaunchedWebAiOs> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  dirs.push(dataDir, profile);
  o.prepare?.(dataDir);
  w = await launchWebAiOs({ dataDir, profile });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  await openApplications(m);
  return w;
}

const tid = (id: string) => `[data-testid="${id}"]`;
const PAGE = tid("page-relecture");
const SEND = tid("envoyer-commentaires");
const COMMENT = tid("commentaire");
const FORM = tid("formulaire-commentaire");
const line = (n: number) => `${tid("ligne-diff")}[data-nouveau="${n}"]`;
const extra = (n: number) => `${line(n)} ${tid("ajouter-commentaire")}`;
const count = (selector: string) => inUi<number>(m, "return doc.querySelectorAll(arguments[0]).length", [selector]);
const waitCount = (selector: string, n: number, ms = 10_000) => waitUi(m, "return doc.querySelectorAll(arguments[0]).length === arguments[1]", [selector, n], ms);
const text = (selector: string) => inUi<string | null>(m, "return doc.querySelector(arguments[0])?.textContent ?? null", [selector]);
const waitText = (selector: string, t: string, ms = 10_000) => waitUi(m, "return doc.querySelector(arguments[0])?.textContent.includes(arguments[1])", [selector, t], ms);
/** The new line number of the diff line just above the first comment (the line it hangs under). */
const commentUnder = () => inUi<string | null>(m, `return doc.querySelector('${COMMENT}')?.previousElementSibling?.dataset.nouveau ?? null`);
const openFile = (path: string) => click(m, tid("fichier-relecture"), { text: path });
const refresh = () => refreshReview(m);
const ADDED = `${tid("ligne-diff")}.ajout`;

/** A Shift+click on the + of line `n`: its mousedown, as DiffFile reads it (the click helper has no modifiers). */
async function shiftPlus(n: number): Promise<void> {
  await waitUi(m, "return !!doc.querySelector(arguments[0])", [extra(n)]);
  await inUi(m, `doc.querySelector(arguments[0]).dispatchEvent(new ui.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }))`, [extra(n)]);
}

/** The open form gets `texte`, then « Commenter »; the form closes. */
async function comment(text: string): Promise<void> {
  await waitUi(
    m,
    `const t = doc.querySelector(arguments[0] + " textarea");
     if (!t) return false;
     t.value = arguments[1];
     t.dispatchEvent(new ui.Event("input", { bubbles: true }));
     return true;`,
    [FORM, text],
  );
  await click(m, `${FORM} button`, { text: "Commenter" });
  await waitCount(FORM, 0);
}

/** « Relire » of the projet-externe line, on the Applications page; waits for the Review page. */
async function reread(): Promise<void> {
  await click(m, `${tid("projet-externe")} button`, { text: "Relire" });
  await waitUi(m, `return !!doc.querySelector('${PAGE}')`);
}

/** A declared project with lines `n` of app.js changed, its Review page open on app.js. */
async function pageOnAppJs(...n: number[]) {
  const p = await declareProject(m, { dataDir: w!.dataDir });
  writeAppJs(p.folder, modified(...n));
  await reread();
  await openFile("app.js");
  await waitCount(ADDED, n.length);
  return p;
}

const agentInput = () => {
  const f = path.join(w!.dataDir, "workspace", "faux-agent-entree.txt");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};
const TERMINAL = "(doc.querySelector('.xterm-rows')?.textContent ?? '').replace(/\\u00a0/g, ' ')";

function filesOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      out.push(p);
      if (statSync(p).isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

const SITE = { declaration: { name: "Essai", url: "https://essai.example/", domains: ["essai.example"] }, files: { "app.js": LINES.join("\n") + "\n" } };
/** A site app « essai » (app.js, line 15 changed after its first photo), its Review page open on app.js. */
async function siteOnAppJs(): Promise<void> {
  await launch({ prepare: (d) => writeSite(d, "essai", SITE) });
  await expect.poll(() => existsSync(path.join(w!.dataDir, "design", "review", "site-essai.git", "refs", "webaios", "relu")), { timeout: 15_000 }).toBe(true);
  writeAppJs(path.join(w!.dataDir, "workspace", "sites", "essai"), modified(15));
  await click(m, tid("site-essai-relire"));
  await waitUi(m, `return !!doc.querySelector('${PAGE}')`);
  await openFile("app.js");
  await waitCount(ADDED, 1);
}

// relecture.spec.ts:251
it("+ on line 15 of app.js, « garder l'ancien nom »: a comment under the line; « Envoyer 1 commentaire à l'agent »: the agent's terminal holds the line, no \\r, the comment says « envoyé »", { timeout: 60_000 }, async () => {
  await siteOnAppJs();
  await click(m, extra(15));
  await comment("garder l'ancien nom");
  await waitCount(COMMENT, 1);
  expect(await text(COMMENT)).toContain("garder l'ancien nom");
  expect(await text(COMMENT)).toContain("Ligne 15");
  expect(await commentUnder()).toBe("15");
  expect(await text(COMMENT)).not.toContain("envoyé");
  expect(await text(SEND)).toBe("Envoyer 1 commentaire à l'agent");
  // The home page's panel closed with the Applications tab: the send opens it again.
  await waitFor(m, "return document.getElementById('webaios-agent').hidden", (v) => v === true);
  await click(m, SEND);
  const sent = `1) "app.js":15-15 : « garder l'ancien nom »`;
  await waitFor(m, "return !document.getElementById('webaios-agent').hidden", (v) => v === true);
  await waitUi(m, `return ${TERMINAL}.includes(arguments[0])`, [sent], 20_000, "agent");
  await expect.poll(agentInput, { timeout: 10_000 }).toContain(sent);
  expect(agentInput()).toContain("/workspace/.webaios/remarks/site-essai/");
  await new Promise((r) => setTimeout(r, 300));
  expect(agentInput()).not.toContain("\r");
  await waitText(COMMENT, "envoyé");
  const batches = path.join(w!.dataDir, "workspace", ".webaios", "remarks", "site-essai");
  expect(filesOf(batches).some((f) => f.endsWith("batch.json"))).toBe(true);
});

// relecture.spec.ts:278
it("Shift+click from line 13 to 16: the comment covers 13–16; a range over two blocks is refused", async () => {
  await launch();
  const p = await pageOnAppJs(15, 25);
  try {
    await click(m, extra(13));
    await shiftPlus(16);
    await waitCount(`${tid("ligne-diff")}.choisie`, 5);
    await comment("tout ce passage");
    await waitCount(COMMENT, 1);
    expect(await text(COMMENT)).toContain("Lignes 13–16");
    expect(await commentUnder()).toBe("16");
    // From line 13 (first block) to line 25 (second block): refused.
    await click(m, extra(13));
    await shiftPlus(25);
    await waitUi(m, "return doc.querySelector(arguments[0])?.textContent === arguments[1]", [tid("erreur-commentaire"), RANGE_OUTSIDE_BLOCK]);
    expect(await count(`${tid("ligne-diff")}.choisie`)).toBe(1);
    await click(m, `${FORM} button`, { text: "Annuler" });
    await waitCount(FORM, 0);
    expect(await count(COMMENT)).toBe(1);
  } finally {
    await p.client.close();
  }
});

// relecture.spec.ts:304
it("three lines added at the top of app.js then Rafraîchir: the comment follows to line 18 without LIGNE_CHANGEE; line 18 rewritten then Rafraîchir: LIGNE_CHANGEE", async () => {
  await launch();
  const p = await pageOnAppJs(15);
  try {
    await click(m, extra(15));
    await comment("garder l'ancien nom");
    writeAppJs(p.folder, ["a", "b", "c", ...modified(15)]);
    await refresh();
    await waitText(COMMENT, "Ligne 18");
    expect(await text(COMMENT)).not.toContain(LIGNE_CHANGEE);
    expect(await commentUnder()).toBe("18");
    writeAppJs(p.folder, ["a", "b", "c", ...LINES.map((l, i) => (i === 14 ? "ligne 15 réécrite" : l))]);
    await refresh();
    await waitText(COMMENT, LIGNE_CHANGEE);
    expect(await text(COMMENT)).toContain("garder l'ancien nom");
  } finally {
    await p.client.close();
  }
});

// relecture.spec.ts:327
it("Résoudre then « Marquer comme relu »: no file left, the resolved comment gone, an unresolved one stays on app.js", async () => {
  await launch();
  const p = await pageOnAppJs(15);
  try {
    await click(m, extra(15));
    await comment("à résoudre");
    await click(m, extra(13));
    await comment("reste ouvert");
    await waitCount(COMMENT, 2);
    // The comment on line 13 comes first: its « Résoudre » is not the one.
    await inUi(m, `[...[...doc.querySelectorAll('${COMMENT}')].find((c) => c.textContent.includes("à résoudre")).querySelectorAll("button")].find((b) => b.textContent === "Résoudre").click()`);
    await waitUi(m, `return [...doc.querySelectorAll('${COMMENT}')].find((c) => c.textContent.includes("à résoudre"))?.textContent.includes("résolu")`);
    await waitUi(m, "return doc.querySelector(arguments[0])?.textContent === arguments[1]", [SEND, "Envoyer 1 commentaire à Claude Code (Claude Code)"]);
    await click(m, tid("marquer-relu"));
    await waitCount(tid("fichier-relecture"), 0);
    await waitCount(tid("commentaire-relecture"), 1);
    expect(await text(tid("commentaire-relecture"))).toContain("reste ouvert");
    expect(await text(tid("commentaire-relecture"))).toContain("app.js");
    expect(await text(PAGE)).not.toContain("à résoudre");
  } finally {
    await p.client.close();
  }
});

// relecture.spec.ts:352
it("external project: « Envoyer 1 commentaire à Claude Code (…) », read_remarks gives type relecture with file and lines; nothing is pre-filled", async () => {
  await launch();
  const p = await declareProject(m, { dataDir: w!.dataDir });
  try {
    writeAppJs(p.folder, modified(2));
    await reread();
    await openFile("app.js");
    await waitText(line(2), "ligne 2 modifiée");
    await click(m, extra(2));
    await comment("renommer");
    expect(await text(SEND)).toBe("Envoyer 1 commentaire à Claude Code (Claude Code)");
    await click(m, SEND);
    await waitText(COMMENT, "envoyé");
    const t = textOf(await p.client.callTool({ name: "read_remarks", arguments: { folder: p.folder } }));
    expect(t).toContain("(relecture, lot ");
    expect(t).toContain("texte de l'utilisateur : renommer");
    expect(t).toContain('Fichier : "app.js", lignes 2–2');
    expect(t).toContain("-ligne 2\n+ligne 2 modifiée");
    await new Promise((r) => setTimeout(r, 300));
    expect(agentInput()).toBe("");
  } finally {
    await p.client.close();
  }
});

// externes.spec.ts:192 (sent from the Review page; the design basket is plan 35's)
it("wait_for_remarks started before the send returns the batch as soon as « Envoyer » is clicked", async () => {
  await launch();
  const p = await pageOnAppJs(15);
  try {
    await click(m, extra(15));
    await comment("Bouton plus grand");
    const start = Date.now();
    const waiting = p.client.callTool({ name: "wait_for_remarks", arguments: { folder: p.folder, delay_s: 30 } });
    await new Promise((r) => setTimeout(r, 400));
    await click(m, SEND);
    expect(textOf(await waiting)).toContain("Bouton plus grand");
    expect(Date.now() - start).toBeLessThan(15_000);
  } finally {
    await p.client.close();
  }
});

// externes.spec.ts:258
it("no file of the external project (registries, repository, batches) appears under <dataDir>/workspace/; its batch is under <dataDir>/design/remarks/ext-<id>/", async () => {
  await launch();
  const p = await pageOnAppJs(15);
  try {
    await click(m, extra(15));
    await comment("Une remarque");
    await click(m, SEND);
    await waitText(COMMENT, "envoyé");
    await new Promise((r) => setTimeout(r, 800));
    for (const f of filesOf(path.join(w!.dataDir, "workspace"))) {
      expect(f, f).not.toMatch(/externes|relecture|ext-[0-9a-f]{16}/);
      if (statSync(f).isFile() && statSync(f).size < 2_000_000) expect(readFileSync(f, "utf8"), f).not.toContain(p.token);
    }
    expect(filesOf(path.join(w!.dataDir, "design", "remarks", `ext-${p.id}`)).some((f) => f.endsWith("batch.json"))).toBe(true);
  } finally {
    await p.client.close();
  }
});

// externes.spec.ts:209 (the Review part)
it("after « Révoquer », envoyer-commentaires is disabled, with NO_CLIENT as its title", async () => {
  await launch();
  const p = await pageOnAppJs(15);
  try {
    await click(m, extra(15));
    await comment("Une remarque");
    expect(await inUi(m, "return doc.querySelector(arguments[0]).disabled", [SEND])).toBe(false);
    const review = Object.values((await state(m)).tabs).find((o) => o.url === reviewUrl(`ext-${p.id}`))!.id;
    await openApplications(m);
    await click(m, `${tid("client-externe")} button`, { text: "Révoquer" });
    await waitCount(tid("client-externe"), 0);
    await click(m, tid(`onglet-${review}`));
    await waitCount(PAGE, 1);
    await refresh();
    await waitUi(m, "const b = doc.querySelector(arguments[0]); return b?.disabled && b.title === arguments[1]", [SEND, NO_CLIENT]);
  } finally {
    await p.client.close();
  }
});

// Spec §7
it("deleting the site app erases its review repo and comments", { timeout: 60_000 }, async () => {
  await siteOnAppJs();
  await click(m, extra(15));
  await comment("garder l'ancien nom");
  const review = path.join(w!.dataDir, "design", "review");
  await expect.poll(() => existsSync(path.join(review, "site-essai.comments.json")), { timeout: 10_000 }).toBe(true);
  await openApplications(m);
  await click(m, tid("site-essai-supprimer"));
  await click(m, tid("confirmer-suppression-site"));
  await expect
    .poll(() => existsSync(path.join(review, "site-essai.git")) || existsSync(path.join(review, "site-essai.comments.json")), { timeout: 15_000 })
    .toBe(false);
});

// Review Focus 5
it("a path with spaces and accents shows its diff and takes a comment", async () => {
  await launch();
  const p = await declareProject(m, { dataDir: w!.dataDir });
  try {
    mkdirSync(path.join(p.folder, "dossier é"));
    writeFileSync(path.join(p.folder, "dossier é", "a b.js"), "const a = 1;\nconst b = 2;\n");
    await reread();
    await waitUi(m, `return [...doc.querySelectorAll('${tid("fichier-relecture")} .nom-fichier')].some((e) => e.textContent === "dossier é/a b.js")`);
    await openFile("dossier é/a b.js");
    await waitText(line(2), "const b = 2;");
    await click(m, extra(2));
    await comment("renommer b");
    await waitCount(COMMENT, 1);
    expect(await text(COMMENT)).toContain("renommer b");
    expect(await commentUnder()).toBe("2");
  } finally {
    await p.client.close();
  }
});
