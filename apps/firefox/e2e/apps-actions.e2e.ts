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
const CONFIRM = '[data-testid="delete-confirmation"]';

let p: AppsPage | undefined;
afterEach(async () => {
  try {
    if (p) expect(await missingApi(p.m)).toEqual([]);
  } finally {
    await closeAppsPage(p);
    p = undefined;
  }
});

const project = (folder: string) => path.join(p!.dataDir, "workspace", "projects", folder);
const rowGone = (folder: string, ms = 10_000) => waitUi(p!.m, "return !doc.querySelector(arguments[0])", [appRow(folder)], ms);
const rowShown = (folder: string, ms = 10_000) => waitUi(p!.m, "return !!doc.querySelector(arguments[0])", [appRow(folder)], ms);
const rowText = (folder: string) => inUi<string>(p!.m, "return doc.querySelector(arguments[0])?.textContent ?? ''", [appRow(folder)]);
const filterText = (id: string) => inUi<string | null>(p!.m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ').trim() ?? null", [`[data-testid="filter-${id}"]`]);
/** The page's own api call, as the component makes it. */
const act = (folder: string, action: string) => inUi(p!.m, "ui.webaios.apps.act(arguments[0], arguments[1]);", [folder, action]);
const panelOpen = async () => !!(await state(p!.m)).windows[0]!.agentPanelOpen;
/** The app's container (`userContextIdInternal.webaios-app-<dossier>`), or null. */
const container = (folder: string) =>
  p!.m.execute<number | null>(
    `const { ContextualIdentityService: C } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
     return C.getPrivateIdentity("userContextIdInternal.webaios-app-" + arguments[0])?.userContextId ?? null;`,
    [folder],
  );
async function confirmDelete(folder: string): Promise<void> {
  await rowMenu(p!.m, folder, "Supprimer");
  await click(p!.m, `${CONFIRM} button`, { text: "Supprimer" });
}
async function launchFromPage(): Promise<void> {
  await rowButton(p!.m, "essai", "Lancer");
  await rowState(p!.m, "essai", "running", 15_000);
}

describe("Applications page actions", () => {
  // applications.spec.ts:441
  it("Supprimer asks for confirmation, erases the folder and the row; the app's container is gone", async () => {
    p = await openAppsPage(BLOCK);
    const m = p.m;
    // Launched once: its container exists.
    await launchFromPage();
    await rowButton(m, "essai", "Arrêter");
    await rowState(m, "essai", "stopped");
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
    expect(await inUi<number>(m, `return doc.querySelectorAll('[data-testid^="app-"]').length;`)).toBe(2);
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
    await act("essai", "delete");
    for (const d of ["..", ".", "", "essai/..", "../espace"]) await act(d, "delete");
    await sleep(500);
    expect(existsSync(path.join(project("essai"), "webaios.json"))).toBe(true);
    expect(existsSync(project("zod"))).toBe(true);
    await rowState(m, "essai", "running");
  });

  // applications.spec.ts:476
  it("Afficher le dossier shows it without opening anything (an « x.app » folder would be launched)", async () => {
    const reveals = path.join(os.tmpdir(), `webaios-reveal-${process.pid}-${Date.now()}.txt`);
    p = await openAppsPage(BLOCK, { projects: false, prepare: (d) => writeProject(d, "x.app", { manifest: { name: "Piège" } }), env: { WEBAIOS_TEST_REVEAL: reveals } });
    const m = p.m;
    const windows = () => m.execute<number>(`return [...Services.wm.getEnumerator("navigator:browser")].length;`);
    const tabs = async () => Object.keys((await state(m)).tabs).length;
    const before = { windows: await windows(), tabs: await tabs() };
    // Not one segment, or not a folder name: nothing shown.
    for (const d of ["..", ".", "", "x.app/..", "../x.app", "a\\b"]) await act(d, "folder");
    await rowMenu(m, "x.app", "Afficher le dossier");
    const read = () => (existsSync(reveals) ? readFileSync(reveals, "utf8") : "");
    await expect.poll(read, { timeout: 10_000 }).not.toBe("");
    await sleep(300);
    expect(read()).toBe(path.join(p.dataDir, "workspace", "projects", "x.app") + "\n");
    expect({ windows: await windows(), tabs: await tabs() }).toEqual(before);
    await rm(reveals, { force: true });
  });

  // applications.spec.ts:497
  it("Passer en application rewrites the manifest and moves the row", async () => {
    p = await openAppsPage(BLOCK);
    await expect.poll(() => filterText("app"), { timeout: 10_000 }).toBe("Applications 1");
    await rowMenu(p.m, "zod", "Passer en application");
    const manifest = () => JSON.parse(readFileSync(path.join(project("zod"), "webaios.json"), "utf8")) as { type: string; origin?: string };
    await expect.poll(() => manifest().type, { timeout: 10_000 }).toBe("app");
    expect(manifest().origin).toBe("https://github.com/colinhacks/zod");
    await expect.poll(() => filterText("app"), { timeout: 10_000 }).toBe("Applications 2");
    expect(await rowText("zod")).toContain("Application");
  });

  // applications.spec.ts:510
  it("Déboguer pre-fills the terminal without sending, with the log", async () => {
    p = await openAppsPage(BLOCK);
    // Panel closed, agent not started yet: Déboguer opens the panel, and the text waits for the session.
    expect(await panelOpen()).toBe(false);
    await rowButton(p.m, "essai", "Déboguer");
    await expect.poll(panelOpen, { timeout: 10_000 }).toBe(true);
    await waitUi(p.m, "return doc.querySelector('.xterm-rows')?.textContent.includes('fake agent ready>')", [], 20_000, "agent");
    await expect.poll(() => agentInput(p!.dataDir), { timeout: 10_000 }).toBe("[application : Essai — /workspace/projects/essai — journal : /workspace/.webaios/logs/essai.log] ");
    await sleep(300);
    expect(agentInput(p.dataDir)).not.toContain("\r");
  });

  // applications.spec.ts:523
  it("Déboguer a project without manifest", async () => {
    p = await openAppsPage(BLOCK);
    await rowButton(p.m, "vieux", "Déboguer");
    await expect.poll(() => agentInput(p!.dataDir), { timeout: 10_000 }).toBe("[projet sans fiche webaios.json : /workspace/projects/vieux] ");
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
    const read = await callTool(p.dataDir, "read_tab", { id: "app:essai" });
    expect(read.text).toContain("lien");
    for (const frame of ["sidebar", "agent"] as const)
      expect(await inUi<number>(m, `return doc.querySelectorAll('[data-testid="permission-request"]').length;`, [], frame)).toBe(0);
  });

  // applications.spec.ts:544
  it("a folder with an unsupported name can be debugged and deleted", async () => {
    p = await openAppsPage(BLOCK, { noManifest: ["Mon Projet"] });
    await rowButton(p.m, "Mon Projet", "Déboguer");
    await expect.poll(() => agentInput(p!.dataDir), { timeout: 10_000 }).toBe("[projet sans fiche webaios.json : /workspace/projects/Mon Projet] ");
    // Déboguer focuses the agent and retries 100 ms later if the terminal lost it (AgentPanel): a sidebar click inside
    // that window gets its menu closed by the retry. A person is never that fast; the test waits it out.
    await new Promise((r) => setTimeout(r, 200));
    await confirmDelete("Mon Projet");
    await expect.poll(() => existsSync(project("Mon Projet")), { timeout: 10_000 }).toBe(false);
    await rowGone("Mon Projet");
  });

  // applications.spec.ts:557
  it("a project made again after Supprimer does not keep the old error", async () => {
    p = await openAppsPage(BLOCK, { projects: false, prepare: (d) => writeProject(d, "essai", { manifest: { name: "Essai" }, server: "crashed" }) });
    await rowButton(p.m, "essai", "Lancer");
    await rowState(p.m, "essai", "error", 15_000);
    await confirmDelete("essai");
    await rowGone("essai");
    writeProject(p.dataDir, "essai", { manifest: { name: "Essai" } });
    await rowShown("essai");
    await rowState(p.m, "essai", "stopped");
  });

  // applications.spec.ts:576
  it("Supprimer cancels a launch still waiting for Docker", { timeout: 60_000 }, async () => {
    // `docker info` answers in 8 s: the launch asked stays « arretee » meanwhile.
    p = await openAppsPage(BLOCK, { env: { FAKE_DOCKER_SLOW: "1" } });
    await rowButton(p.m, "essai", "Lancer");
    const clicked = Date.now();
    await rowState(p.m, "essai", "stopped");
    await confirmDelete("essai");
    await expect.poll(() => existsSync(project("essai")), { timeout: 15_000 }).toBe(false);
    // Well after Docker's answer (8 s after the click): no process was launched for the deleted app.
    await sleep(Math.max(0, clicked + 14_000 - Date.now()));
    expect(existsSync(path.join(p.dataDir, "workspace", "fake-docker-app-essai.pid"))).toBe(false);
    expect(existsSync(project("essai"))).toBe(false);
  });
});
