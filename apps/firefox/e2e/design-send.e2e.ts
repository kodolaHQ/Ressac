import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTab, testActor } from "./agent-extensions";
import { startDesignServers, trustedMouse } from "./design";
import { dispatch, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { declareProject, modified, openApplications, refreshReview, textOf, writeAppJs } from "./review";
import { inBrowser, resolveLocalHosts } from "./sites";
import { click, typeText, waitUi } from "./ui";

// Plan 35b Task 5: the cart's send, to the agent (pre-filled, never sent) and to the connected Claude Code, and
// spec §5.10 (the host stopped). The demo is
// 127.0.0.1:15318, in this file's block 15315-15319.

const PORT = 15318;
const BLOCK = "15315-15319";
const B = "gBrowser.selectedBrowser";
const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tid = (id: string) => `[data-testid="${id}"]`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let demo: Awaited<ReturnType<typeof startDesignServers>>;
/** An external project's pages: 127.0.0.1 on a free port, outside the block (declared by the MCP client later). */
let ext: Awaited<ReturnType<typeof startDesignServers>>;
let w: LaunchedWebAiOs;
let m: Marionette;
const dirs: string[] = [];

beforeAll(async () => {
  demo = await startDesignServers({ port: PORT });
  ext = await startDesignServers();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  dirs.push(dataDir, profile);
  const a = testActor(profile);
  w = await launchWebAiOs({ dataDir, profile, env: { ...a.env, WEBAIOS_APP_PORTS: BLOCK }, prefs: a.prefs });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  await resolveLocalHosts(m, ["localhost"]);
  await waitFor(m, `return (async () => { const d = (await ChromeUtils.importESModule("${STORE}").ready).design; return d.etat({ type: "fenetre", fenetreId: window.webaiosWindow.fenetreId }).then(() => true, () => false); })();`, (v) => v === true, 30_000);
}, 120_000);
afterAll(async () => {
  await w?.close();
  await demo?.close();
  await ext?.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** Runs `body` with `d` the design service, `t` the current window's target, `store` the store. */
const svc = <R = unknown>(body: string, args: unknown[] = []) =>
  m.execute<R>(
    `return (async (args) => { const store = await ChromeUtils.importESModule("${STORE}").ready, d = store.design; const t = { type: "fenetre", fenetreId: window.webaiosWindow.fenetreId }; ${body} })([...arguments]);`,
    args,
  );
const state = () => svc<{ active: boolean; basket: number }>("return await d.etat(t);");
const hosts = () => inBrowser<number>(m, B, `return document.querySelectorAll("webaios-viseur").length;`);

async function open(url: string): Promise<string> {
  const id = await openTab(m, url);
  await m.execute(`${B}.focus();`);
  return id;
}
const activate = async (id: string) => {
  await dispatch(m, { type: "activerOnglet", id });
  await waitFor(m, `return gBrowser.selectedTab.getAttribute("webaios-tab-id") === ${JSON.stringify(id)};`, (v) => v === true);
  await m.execute(`${B}.focus();`);
};

/** `body` run in the document (`doc`) of the overlay frame `id`; null while it is absent or hidden (never waits, unlike inUi). */
const frame = <T = unknown>(id: string, body: string) =>
  m.execute<T | null>(
    `const f = document.getElementById(arguments[0]);
     if (!f || f.style.display === "none" || !f.getBoundingClientRect().width) return null;
     const doc = f.contentDocument;
     return (() => { ${body} })();`,
    [id],
  );
const column = <T = unknown>(body: string) => frame<T>("webaios-design-volet", body);
const bubble = <T = unknown>(body: string) => frame<T>("webaios-design-calque", body);
const sendText = () => column<string | null>(`return doc?.querySelector('${tid("envoyer-remarques")}')?.textContent ?? null;`);
const cartCount = () => column<number>(`return doc?.querySelectorAll('${tid("remarque-panier")}').length ?? 0;`);
const batchList = () =>
  column<{ state: string; text: string; handled: boolean }[]>(
    `return [...(doc?.querySelectorAll('${tid("lot-envoye")}') ?? [])].map((l) => ({ etat: l.dataset.etat, text: l.textContent, traite: [...l.querySelectorAll("button")].some((b) => b.textContent === "Traité") }));`,
  );
const alertText = () => column<string | null>(`return doc?.querySelector('[role="alert"]')?.textContent ?? null;`);

async function modeOn() {
  const width = await inBrowser<number>(m, B, "return innerWidth;");
  await svc("await d.toggle(t); return 1;");
  await expect.poll(async () => (await state()).active, { timeout: 10_000 }).toBe(true);
  await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
  await expect.poll(sendText, { timeout: 10_000 }).not.toBeNull();
  // The column narrows the page: the next click aims once its layout settled.
  await expect.poll(() => inBrowser<number>(m, B, "return innerWidth;"), { timeout: 10_000 }).toBeLessThan(width);
}
async function modeOff() {
  if ((await state()).active) await svc("await d.stop(t); return 1;");
}

/** A trusted click on `sel`, its bubble labelled `label`, `text` typed, then « Ajouter au panier »: the cart grows by one. */
async function remark(sel: string, label: string, text: string) {
  const n = (await state()).basket;
  await trustedMouse(m, B, sel);
  await expect
    .poll(() => bubble<string | null>(`return doc?.querySelector('${tid("bulle-design")}')?.textContent ?? null;`), { timeout: 10_000 })
    .toContain(label);
  await expect.poll(() => bubble<string | null>("return doc?.activeElement?.localName ?? null;"), { timeout: 10_000 }).toBe("textarea");
  await typeText(m, text);
  await click(m, "button.ajouter", { frame: "overlay" });
  await expect.poll(async () => (await state()).basket, { timeout: 10_000 }).toBe(n + 1);
}

const agentInput = () => {
  const f = path.join(w.dataDir, "espace", "faux-agent-entree.txt");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};
const TERMINAL = "(doc.querySelector('.xterm-rows')?.textContent ?? '').replace(/\\u00a0/g, ' ')";
type Content = { type: string; text?: string; data?: string; mimeType?: string }[];

describe("to the agent", () => {
  it("design.spec.ts:489 two remarks on the demo then send: the agent's terminal is pre-filled without Enter, the batch is on disk, « Traité » closes it", async () => {
    await open(`${demo.page}/`);
    await modeOn();
    await remark("#email", "input#email.champ", "Champ plus large");
    await sleep(600);
    await remark("#envoyer", "button#envoyer", "Bouton en vert");
    await expect.poll(sendText, { timeout: 10_000 }).toBe("Envoyer 2 remarques à l'agent");
    await click(m, tid("envoyer-remarques"), { frame: "panel" });
    await waitFor(m, "return !document.getElementById('webaios-agent').hidden", (v) => v === true);
    await waitUi(m, `return ${TERMINAL}.includes("faux agent prêt>")`, [], 20_000, "agent");
    await expect.poll(agentInput, { timeout: 10_000 }).toMatch(new RegExp(`^\\[remarques de .+ — démo http://(localhost|127\\.0\\.0\\.1):${PORT} : 1\\) `));
    expect(agentInput()).toContain(`/workspace/.webaios/remarques/demo-${PORT}/`);
    await sleep(300);
    expect(agentInput()).not.toContain("\r");
    const dir = path.join(w.dataDir, "espace", ".webaios", "remarques", `demo-${PORT}`);
    const batches = readdirSync(dir).filter((n) => /^\d{8}T\d{6}Z-[0-9a-f]{4}$/.test(n));
    expect(batches).toHaveLength(1);
    expect(existsSync(path.join(dir, batches[0]!, "lot.json"))).toBe(true);
    expect(readdirSync(path.join(dir, batches[0]!)).filter((n) => n.endsWith(".png"))).toHaveLength(2);
    expect(agentInput()).toContain(`/workspace/.webaios/remarques/demo-${PORT}/${batches[0]}/lot.json] `);
    await expect.poll(cartCount, { timeout: 10_000 }).toBe(0);
    await expect.poll(batchList, { timeout: 10_000 }).toEqual([expect.objectContaining({ state: "en-attente", handled: true })]);
    expect((await batchList())![0]!.text).toContain("en attente");
    expect((await batchList())![0]!.text).toContain("input#email.champ");
    await click(m, `${tid("lot-envoye")} button`, { frame: "panel", text: "Traité" });
    await expect.poll(batchList, { timeout: 10_000 }).toEqual([expect.objectContaining({ state: "traite", handled: false })]);
    expect((await batchList())![0]!.text).toContain("traité");
    await modeOff();
  });

  it("spec §5.10 the host stopped: Envoyer shows the call's error in the cart, the cart stays", async () => {
    await open(`${demo.page}/`);
    await modeOn();
    await remark("#email", "input#email.champ", "Une remarque");
    await expect.poll(sendText, { timeout: 10_000 }).toBe("Envoyer 1 remarque à l'agent");
    const before = agentInput();
    await svc("await store.agent.stop(); return 1;");
    await click(m, tid("envoyer-remarques"), { frame: "panel" });
    await expect.poll(alertText, { timeout: 10_000 }).toBeTruthy();
    expect(await svc("return d.overlayContext(t, ['panier'])?.mode ?? null;")).toBe("panier");
    await sleep(500);
    expect(await alertText()).toBeTruthy();
    expect(await cartCount()).toBe(1);
    expect(agentInput()).toBe(before);
    // Started again: the column reads its cart again by itself, the remark is still there.
    await svc("await store.agent.ensure(); return 1;");
    await expect.poll(cartCount, { timeout: 30_000 }).toBe(1);
    expect(await sendText()).toBe("Envoyer 1 remarque à l'agent");
    await modeOff();
  });
});

describe("an external project", () => {
  let p: Awaited<ReturnType<typeof declareProject>>;
  let tab: string;

  beforeAll(async () => {
    await openApplications(m);
    p = await declareProject(m, { dataDir: w.dataDir, ports: [Number(new URL(ext.page).port)] });
    tab = await open(`${ext.page}/`);
  }, 60_000);
  afterAll(async () => {
    await p?.client.close().catch(() => undefined);
  });

  it("externes.spec.ts:163 a tab on the declared port: send to Claude Code, lire_remarques (text and image), batch read then treated with the note", async () => {
    await activate(tab);
    const before = agentInput();
    await modeOn();
    await remark("#email", "input#email.champ", "Champ plus large");
    await expect.poll(sendText, { timeout: 10_000 }).toBe("Envoyer 1 remarque à Claude Code (Claude Code)");
    await click(m, tid("envoyer-remarques"), { frame: "panel" });
    await expect.poll(batchList, { timeout: 10_000 }).toEqual([expect.objectContaining({ state: "en-attente" })]);
    // Nothing in the agent's terminal: an external batch pre-fills nothing.
    await sleep(300);
    expect(agentInput()).toBe(before);
    const read = await p.client.callTool({ name: "lire_remarques", arguments: { folder: p.folder } });
    const image = (read.content as Content).find((x) => x.type === "image");
    expect(image?.mimeType).toBe("image/png");
    expect(Buffer.from(image!.data!, "base64").subarray(0, 8)).toEqual(PNG);
    const text = textOf(read);
    expect(text).toContain("Champ plus large");
    await expect.poll(batchList, { timeout: 10_000 }).toEqual([expect.objectContaining({ state: "lu" })]);
    const id = /Remarque (e-[0-9a-f]{8})/.exec(text)![1]!;
    await p.client.callTool({ name: "marquer_traitee", arguments: { folder: p.folder, ids: [id], note: "corrigé" } });
    await expect.poll(batchList, { timeout: 10_000 }).toEqual([expect.objectContaining({ state: "traite" })]);
    expect((await batchList())![0]!.text).toContain("corrigé");
    await modeOff();
  });

  it("design.spec.ts:577 the spec's success on an external project: remarks, send, lire_remarques, the file changed, Relire ce projet, a comment, Marquer comme relu", { timeout: 90_000 }, async () => {
    await activate(tab);
    await modeOn();
    await remark("#email", "input#email.champ", "refuser une adresse sans domaine");
    await sleep(600);
    await remark("#envoyer", "button#envoyer", "Bouton en vert");
    await expect.poll(cartCount, { timeout: 10_000 }).toBe(2);
    await click(m, tid("envoyer-remarques"), { frame: "panel" });
    await expect.poll(cartCount, { timeout: 10_000 }).toBe(0);
    const text = textOf(await p.client.callTool({ name: "lire_remarques", arguments: { folder: p.folder } }));
    expect(text).toContain("refuser une adresse sans domaine");
    expect(text).toContain("Bouton en vert");
    expect(text).toContain(`Élément : "#email"`);
    expect(text).toContain(`Élément : "#envoyer"`);
    await modeOff();
    // Claude Code changes the project.
    writeAppJs(p.folder, modified(15));
    await activate(tab);
    await click(m, ".design .chevron");
    await click(m, '[role="menuitem"]', { text: "Relire ce projet" });
    const PAGE = tid("page-relecture");
    const ADDED = `${tid("ligne-diff")}.ajout`;
    await waitUi(m, `return !!doc.querySelector('${PAGE}')`, [], 15_000);
    await refreshReview(m);
    await click(m, tid("fichier-relecture"), { text: "app.js" });
    await waitUi(m, "return [...doc.querySelectorAll(arguments[0])].some((e) => e.textContent.includes('ligne 15 modifiée'))", [ADDED], 15_000);
    await click(m, `${tid("ligne-diff")}[data-nouveau="15"] ${tid("ajouter-commentaire")}`);
    await waitUi(
      m,
      `const t = doc.querySelector('${tid("formulaire-commentaire")} textarea');
       if (!t) return false;
       t.value = "garder le mot Envoyer";
       t.dispatchEvent(new ui.Event("input", { bubbles: true }));
       return true;`,
    );
    await click(m, `${tid("formulaire-commentaire")} button`, { text: "Commenter" });
    await click(m, tid("envoyer-commentaires"));
    await waitUi(m, `return doc.querySelector('${tid("commentaire")}')?.textContent.includes("envoyé")`, [], 15_000);
    const review = textOf(await p.client.callTool({ name: "lire_remarques", arguments: { folder: p.folder } }));
    expect(review).toContain('Fichier : "app.js", lignes 15–15');
    expect(review).toContain("garder le mot Envoyer");
    await click(m, tid("marquer-relu"));
    await waitUi(m, `return doc.querySelectorAll('${tid("fichier-relecture")}').length === 0`, [], 15_000);
  });
});
