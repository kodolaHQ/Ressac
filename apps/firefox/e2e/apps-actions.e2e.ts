import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentInput, appRow, closeAppsPage, openAppsPage, rowButton, rowMenu, rowMenuItems, rowState, writeProject, type AppsPage } from "./apps";
import { state } from "./firefox";
import { callTool } from "./mcp";
import { click, inUi, missingApi, pressKeys, waitUi } from "./ui";

// Plan 35a Task 4: the Applications page's actions (Supprimer, Afficher le dossier, Passer en application, Déboguer).

const BLOCK: [number, number] = [15290, 15294];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CONFIRM = '[data-testid="confirmation-suppression"]';

let p: AppsPage | undefined;
afterEach(async () => {
  try {
    if (p) expect(await missingApi(p.m)).toEqual([]);
  } finally {
    await closeAppsPage(p);
    p = undefined;
  }
});

const project = (dossier: string) => path.join(p!.dataDir, "espace", "projets", dossier);
const rowGone = (dossier: string, ms = 10_000) => waitUi(p!.m, "return !doc.querySelector(arguments[0])", [appRow(dossier)], ms);
const rowShown = (dossier: string, ms = 10_000) => waitUi(p!.m, "return !!doc.querySelector(arguments[0])", [appRow(dossier)], ms);
const rowText = (dossier: string) => inUi<string>(p!.m, "return doc.querySelector(arguments[0])?.textContent ?? ''", [appRow(dossier)]);
const filterText = (id: string) => inUi<string | null>(p!.m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ').trim() ?? null", [`[data-testid="filtre-${id}"]`]);
/** The page's own api call, as the component makes it. */
const act = (dossier: string, action: string) => inUi(p!.m, "ui.webaios.applications.agir(arguments[0], arguments[1]);", [dossier, action]);
const panelOpen = async () => !!(await state(p!.m)).fenetres[0]!.panneauAgentOuvert;
/** The app's container (`userContextIdInternal.webaios-app-<dossier>`), or null. */
const container = (dossier: string) =>
  p!.m.execute<number | null>(
    `const { ContextualIdentityService: C } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
     return C.getPrivateIdentity("userContextIdInternal.webaios-app-" + arguments[0])?.userContextId ?? null;`,
    [dossier],
  );
async function confirmDelete(dossier: string): Promise<void> {
  await rowMenu(p!.m, dossier, "Supprimer");
  await click(p!.m, `${CONFIRM} button`, { text: "Supprimer" });
}
async function launchFromPage(): Promise<void> {
  await rowButton(p!.m, "essai", "Lancer");
  await rowState(p!.m, "essai", "en-marche", 15_000);
}

describe("Applications page actions", () => {
  // applications.spec.ts:441
  it("Supprimer asks for confirmation, erases the folder and the row; the app's container is gone", async () => {
    p = await openAppsPage(BLOCK);
    const m = p.m;
    // Launched once: its container exists.
    await launchFromPage();
    await rowButton(m, "essai", "Arrêter");
    await rowState(m, "essai", "arretee");
    expect(await container("essai")).not.toBeNull();
    await rowMenu(m, "essai", "Supprimer");
    const text = await waitUi<string>(m, "return doc.querySelector(arguments[0])?.textContent", [CONFIRM]);
    expect(text).toMatch(/Supprimer « Essai » \? Son dossier sera effacé\./);
    await click(m, `${CONFIRM} button`, { text: "Annuler" });
    await waitUi(m, "return !doc.querySelector(arguments[0])", [CONFIRM]);
    await sleep(300);
    expect(existsSync(project("essai"))).toBe(true);
    await confirmDelete("essai");
    await expect.poll(() => existsSync(project("essai")), { timeout: 10_000 }).toBe(false);
    await rowGone("essai");
    expect(await inUi<number>(m, `return doc.querySelectorAll('[data-testid^="appli-"]').length;`)).toBe(2);
    await expect.poll(() => container("essai"), { timeout: 10_000 }).toBeNull();
  });

  // applications.spec.ts:461
  it("no Supprimer for a running app; refused by the host too, and for a path that is not a direct project folder", async () => {
    p = await openAppsPage(BLOCK);
    const m = p.m;
    await launchFromPage();
    const items = await rowMenuItems(m, "essai");
    expect(items).toContain("Relancer");
    expect(items).not.toContain("Supprimer");
    await pressKeys(m, "Escape");
    // Refused by the host as well, not only missing from the menu.
    await act("essai", "supprimer");
    for (const d of ["..", ".", "", "essai/..", "../espace"]) await act(d, "supprimer");
    await sleep(500);
    expect(existsSync(path.join(project("essai"), "webaios.json"))).toBe(true);
    expect(existsSync(project("zod"))).toBe(true);
    await rowState(m, "essai", "en-marche");
  });

  // applications.spec.ts:476
  it("Afficher le dossier shows it without opening anything (an « x.app » folder would be launched)", async () => {
    const reveals = path.join(os.tmpdir(), `webaios-reveal-${process.pid}-${Date.now()}.txt`);
    p = await openAppsPage(BLOCK, { projets: false, prepare: (d) => writeProject(d, "x.app", { manifeste: { nom: "Piège" } }), env: { WEBAIOS_TEST_REVEAL: reveals } });
    const m = p.m;
    const windows = () => m.execute<number>(`return [...Services.wm.getEnumerator("navigator:browser")].length;`);
    const tabs = async () => Object.keys((await state(m)).onglets).length;
    const before = { windows: await windows(), tabs: await tabs() };
    // Not one segment, or not a folder name: nothing shown.
    for (const d of ["..", ".", "", "x.app/..", "../x.app", "a\\b"]) await act(d, "dossier");
    await rowMenu(m, "x.app", "Afficher le dossier");
    const read = () => (existsSync(reveals) ? readFileSync(reveals, "utf8") : "");
    await expect.poll(read, { timeout: 10_000 }).not.toBe("");
    await sleep(300);
    expect(read()).toBe(path.join(p.dataDir, "espace", "projets", "x.app") + "\n");
    expect({ windows: await windows(), tabs: await tabs() }).toEqual(before);
    await rm(reveals, { force: true });
  });

  // applications.spec.ts:497
  it("Passer en application rewrites the manifest and moves the row", async () => {
    p = await openAppsPage(BLOCK);
    await expect.poll(() => filterText("application"), { timeout: 10_000 }).toBe("Applications 1");
    await rowMenu(p.m, "zod", "Passer en application");
    const manifest = () => JSON.parse(readFileSync(path.join(project("zod"), "webaios.json"), "utf8")) as { type: string; origine?: string };
    await expect.poll(() => manifest().type, { timeout: 10_000 }).toBe("application");
    expect(manifest().origine).toBe("https://github.com/colinhacks/zod");
    await expect.poll(() => filterText("application"), { timeout: 10_000 }).toBe("Applications 2");
    expect(await rowText("zod")).toContain("Application");
  });

  // applications.spec.ts:510
  it("Déboguer pre-fills the terminal without sending, with the log", async () => {
    p = await openAppsPage(BLOCK);
    // Panel closed, agent not started yet: Déboguer opens the panel, and the text waits for the session.
    expect(await panelOpen()).toBe(false);
    await rowButton(p.m, "essai", "Déboguer");
    await expect.poll(panelOpen, { timeout: 10_000 }).toBe(true);
    await waitUi(p.m, "return doc.querySelector('.xterm-rows')?.textContent.includes('faux agent prêt>')", [], 20_000, "agent");
    await expect.poll(() => agentInput(p!.dataDir), { timeout: 10_000 }).toBe("[application : Essai — /workspace/projets/essai — journal : /workspace/.webaios/journaux/essai.log] ");
    await sleep(300);
    expect(agentInput(p.dataDir)).not.toContain("\r");
  });

  // applications.spec.ts:523
  it("Déboguer a project without manifest", async () => {
    p = await openAppsPage(BLOCK);
    await rowButton(p.m, "vieux", "Déboguer");
    await expect.poll(() => agentInput(p!.dataDir), { timeout: 10_000 }).toBe("[projet sans fiche webaios.json : /workspace/projets/vieux] ");
  });

  // applications.spec.ts:530
  it("Déboguer a running app gives it access to its window", async () => {
    p = await openAppsPage(BLOCK);
    const m = p.m;
    await launchFromPage();
    // The agent has not started yet: Déboguer opens its session, whose opening resets the policy.
    expect(await panelOpen()).toBe(false);
    await rowMenu(m, "essai", "Déboguer");
    await expect.poll(() => agentInput(p!.dataDir), { timeout: 10_000 }).toContain("[application : Essai");
    const read = await callTool(p.dataDir, "lire_onglet", { id: "app:essai" });
    expect(read.texte).toContain("lien");
    for (const frame of ["sidebar", "agent"] as const)
      expect(await inUi<number>(m, `return doc.querySelectorAll('[data-testid="demande-permission"]').length;`, [], frame)).toBe(0);
  });

  // applications.spec.ts:544
  it("a folder with an unsupported name can be debugged and deleted", async () => {
    p = await openAppsPage(BLOCK, { sansFiche: ["Mon Projet"] });
    await rowButton(p.m, "Mon Projet", "Déboguer");
    await expect.poll(() => agentInput(p!.dataDir), { timeout: 10_000 }).toBe("[projet sans fiche webaios.json : /workspace/projets/Mon Projet] ");
    await confirmDelete("Mon Projet");
    await expect.poll(() => existsSync(project("Mon Projet")), { timeout: 10_000 }).toBe(false);
    await rowGone("Mon Projet");
  });

  // applications.spec.ts:557
  it("a project made again after Supprimer does not keep the old error", async () => {
    p = await openAppsPage(BLOCK, { projets: false, prepare: (d) => writeProject(d, "essai", { manifeste: { nom: "Essai" }, serveur: "plante" }) });
    await rowButton(p.m, "essai", "Lancer");
    await rowState(p.m, "essai", "erreur", 15_000);
    await confirmDelete("essai");
    await rowGone("essai");
    writeProject(p.dataDir, "essai", { manifeste: { nom: "Essai" } });
    await rowShown("essai");
    await rowState(p.m, "essai", "arretee");
  });

  // applications.spec.ts:576
  it("Supprimer cancels a launch still waiting for Docker", { timeout: 60_000 }, async () => {
    // `docker info` answers in 8 s: the launch asked stays « arretee » meanwhile.
    p = await openAppsPage(BLOCK, { env: { FAUX_DOCKER_LENT: "1" } });
    await rowButton(p.m, "essai", "Lancer");
    const clicked = Date.now();
    await rowState(p.m, "essai", "arretee");
    await confirmDelete("essai");
    await expect.poll(() => existsSync(project("essai")), { timeout: 15_000 }).toBe(false);
    // Well after Docker's answer (8 s after the click): no process was launched for the deleted app.
    await sleep(Math.max(0, clicked + 14_000 - Date.now()));
    expect(existsSync(path.join(p.dataDir, "espace", "faux-docker-app-essai.pid"))).toBe(false);
    expect(existsSync(project("essai"))).toBe(false);
  });
});
