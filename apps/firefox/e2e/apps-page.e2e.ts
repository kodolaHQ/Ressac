import { afterEach, describe, expect, it } from "vitest";
import { appRow, appWindowExpr, closeAppsPage, inAppView, openAppsPage, rowButton, rowCount, rowState, stopsLog, writeProject, type AppsPage } from "./apps";
import { dispatch, state, waitFor } from "./firefox";
import { click, inUi, missingApi, pressKeys, waitUi } from "./ui";

// Plan 35a Task 4: the Applications page's Docker section on the real API, and ⇧⌘A.

const BLOCK: [number, number] = [15285, 15289];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PAGE = '[data-testid="page-applications"]';

let p: AppsPage | undefined;
afterEach(async () => {
  try {
    if (p) expect(await missingApi(p.m)).toEqual([]);
  } finally {
    await closeAppsPage(p);
    p = undefined;
  }
});

const pageShown = (shown: boolean) => waitUi(p!.m, "return !!doc.querySelector(arguments[0]) === arguments[1]", [PAGE, shown]);
const pageText = () => inUi<string>(p!.m, "return doc.querySelector(arguments[0])?.textContent ?? ''", [PAGE]);
const rowText = (folder: string) => inUi<string>(p!.m, "return doc.querySelector(arguments[0])?.textContent ?? ''", [appRow(folder)]);
const filterText = (id: string) => inUi<string | null>(p!.m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ').trim() ?? null", [`[data-testid="filter-${id}"]`]);
const rows = (n: number, ms = 10_000) => waitUi(p!.m, `return doc.querySelectorAll('[data-testid^="app-"]').length === arguments[0];`, [n], ms);
const pageTabs = async () => Object.values((await state(p!.m)).tabs).filter((o) => o.url === "ressac://apps").length;
const windowId = async () => (await state(p!.m)).windows[0]!.id;
const appWindows = () => p!.m.execute<number>(`return [...Services.wm.getEnumerator("navigator:browser")].filter((w) => w.document.documentElement.hasAttribute("ressac-app")).length;`);
/** A mouse move through the widget, as an OS one (compact.e2e.ts). */
const moveMouse = (x: number) =>
  p!.m.execute(
    `const ratio = window.devicePixelRatio;
     window.windowUtils.sendNativeMouseEvent((window.mozInnerScreenX + arguments[0]) * ratio, (window.mozInnerScreenY + 300) * ratio, window.windowUtils.NATIVE_MOUSE_MESSAGE_MOVE, 0, 0, document.documentElement);`,
    [x],
  );
const search = (text: string) =>
  inUi(p!.m, `const i = doc.querySelector('[data-testid="applications-search"]'); i.value = arguments[0]; i.dispatchEvent(new ui.Event("input", { bubbles: true }));`, [text]);

describe("Applications page", () => {
  // applications.spec.ts:290
  it("⇧⌘A and the sidebar entry open a single Applications page; no about:addons tab", async () => {
    p = await openAppsPage(BLOCK, { page: false });
    const m = p.m;
    await pressKeys(m, "Meta+Shift+a");
    await pageShown(true);
    await pressKeys(m, "Meta+Shift+a");
    await sleep(300);
    expect(await pageTabs()).toBe(1);
    await dispatch(m, { type: "openTab", windowId: await windowId(), url: "about:blank", activate: true });
    await pageShown(false);
    await click(m, '[data-testid="applications-button"]');
    await pageShown(true);
    expect(await pageTabs()).toBe(1);
    // From another space: its own page there, the window stays in that space.
    const s = await state(m);
    await dispatch(m, { type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: s.spaces[0]!.profile, windowId: s.windows[0]!.id });
    await pageShown(false);
    const work = (await state(m)).windows[0]!.activeSpace;
    await pressKeys(m, "Meta+Shift+a");
    await pageShown(true);
    expect(await pageTabs()).toBe(2);
    expect((await state(m)).windows[0]!.activeSpace).toBe(work);
    // Firefox's ⇧⌘A (add-ons) never ran.
    expect(Object.values((await state(m)).tabs).some((o) => o.url.startsWith("about:addons"))).toBe(false);
    expect(await m.execute<boolean>(`return gBrowser.browsers.some((b) => b.currentURI.spec.startsWith("about:addons"));`)).toBe(false);
  });

  // applications.spec.ts:307
  it("compact mode: the Applications page takes the whole room, the bar comes back on the left", async () => {
    p = await openAppsPage(BLOCK);
    const m = p.m;
    await dispatch(m, { type: "toggleCompact", windowId: await windowId() });
    await waitUi(m, `return doc.querySelector('[data-testid="sidebar"]').parentElement.inert;`);
    const box = await inUi<{ top: number; left: number }>(
      m,
      `const h = doc.querySelector(arguments[0]).querySelector("h1").getBoundingClientRect(); const f = frame.getBoundingClientRect();
       return { top: f.top + h.top, left: f.left + doc.querySelector(arguments[0]).getBoundingClientRect().left };`,
      [PAGE],
    );
    expect(box.top).toBeLessThan(40);
    // Framed on the aura like a web page: 8 px of margin, then its 1 px glass edge.
    expect(box.left).toBe(9);
    await moveMouse(3);
    await waitUi(m, `return !doc.querySelector('[data-testid="sidebar"]').parentElement.inert;`);
    await waitUi(m, `return !!doc.querySelector('[aria-label="Quitter le mode compact"]');`);
  });

  // applications.spec.ts:320
  it("the list shows type, origin and state; the side counters are right", async () => {
    p = await openAppsPage(BLOCK);
    await rows(3);
    for (const [filter, text] of [
      ["all", "Tout 3"],
      ["app", "Applications 1"],
      ["poc", "POC et tests 1"],
      ["no-manifest", "Sans fiche 1"],
      ["stopped", "Arrêtées 3"],
    ] as const)
      await expect.poll(() => filterText(filter), { timeout: 10_000 }).toBe(text);
    expect(await filterText("error")).toBeNull();
    expect(await rowText("zod")).toContain("github.com/colinhacks/zod");
    expect(await rowText("zod")).toContain("POC");
    expect(await rowText("essai")).toContain("Application");
    expect(await rowText("vieux")).toContain("Sans fiche");
    await rowState(p.m, "essai", "stopped");
  });

  // applications.spec.ts:340
  it("filter by type and search", async () => {
    p = await openAppsPage(BLOCK);
    const m = p.m;
    await rows(3);
    await click(m, '[data-testid="filter-poc"]');
    await rows(1);
    expect(await rowText("zod")).not.toBe("");
    await click(m, '[data-testid="filter-all"]');
    await search("colin");
    await rows(1);
    expect(await rowText("zod")).not.toBe("");
    await search("ess");
    await rows(1);
    expect(await rowText("essai")).not.toBe("");
  });

  // applications.spec.ts:356
  it("Lancer from the page: En marche, port shown, window open; Arrêter closes it", async () => {
    p = await openAppsPage(BLOCK, { slow: true });
    const m = p.m;
    await rowButton(m, "essai", "Lancer");
    await rowState(m, "essai", "launching");
    await rowState(m, "essai", "running");
    expect(await rowText("essai")).toMatch(/port 1528[5-9]/);
    await expect.poll(() => filterText("running"), { timeout: 10_000 }).toBe("En marche 1");
    await waitFor(m, `return !!${appWindowExpr("essai")}?.gBrowser.selectedBrowser.currentURI.spec.startsWith("http://localhost:");`, (v) => v === true, 15_000);
    await waitFor(m, `return !${appWindowExpr("essai")}.gBrowser.selectedBrowser.webProgress.isLoadingDocument;`, (v) => v === true);
    // « Ouvrir » brings the window to the front without reloading it.
    await inAppView(m, "essai", "window.marque = 1;");
    await rowButton(m, "essai", "Ouvrir");
    await sleep(300);
    expect(await inAppView(m, "essai", "return window.marque;")).toBe(1);
    await rowButton(m, "essai", "Arrêter");
    await rowState(m, "essai", "stopped");
    await expect.poll(appWindows, { timeout: 10_000 }).toBe(0);
  });

  // applications.spec.ts:376
  it("a manifest that appears updates the page live", async () => {
    p = await openAppsPage(BLOCK);
    await rows(3);
    // Time for the projects' watch to be ready.
    await sleep(500);
    writeProject(p.dataDir, "nouveau", { manifest: { name: "Nouveau" } });
    await waitUi(p.m, "return !!doc.querySelector(arguments[0])", [appRow("nouveau")]);
    await expect.poll(() => filterText("all"), { timeout: 10_000 }).toBe("Tout 4");
  });

  // applications.spec.ts:387
  it("Docker slow to answer: a new project still appears live", async () => {
    // `docker info` answers in 8 s: the orphans' cleanup is not over when the project comes.
    p = await openAppsPage(BLOCK, { env: { FAKE_DOCKER_SLOW: "1" } });
    await rows(3);
    await sleep(500);
    writeProject(p.dataDir, "nouveau", { manifest: { name: "Nouveau" } });
    await waitUi(p.m, "return !!doc.querySelector(arguments[0])", [appRow("nouveau")], 4_000);
    expect(stopsLog(p.dataDir)).not.toContain("RESSAC_APP=.*");
  });

  // applications.spec.ts:398
  it("without Docker: banner and Lancer disabled", async () => {
    p = await openAppsPage(BLOCK, { env: { FAKE_DOCKER_ABSENT: "1" } });
    await waitUi(p.m, "return doc.querySelector(arguments[0])?.textContent.includes(\"Docker n'est pas lancé\")", [PAGE]);
    const disabled = await waitUi<string>(
      p.m,
      `const b = [...doc.querySelectorAll(arguments[0] + " .actions button")].find((e) => e.textContent.includes("Lancer")); return b ? String(b.disabled) : null;`,
      [appRow("essai")],
    );
    expect(disabled).toBe("true");
    expect(await rowCount(p.m)).toBe(3);
  });

  // applications.spec.ts:406
  it("Docker slow to answer: the list shows without waiting", async () => {
    p = await openAppsPage(BLOCK, { env: { FAKE_DOCKER_SLOW: "1" } });
    await rows(3, 3_000);
  });

  // applications.spec.ts:412
  it("empty list: help text", async () => {
    p = await openAppsPage(BLOCK, { projects: false });
    await waitUi(p.m, "return doc.querySelector(arguments[0])?.textContent.includes(\"Demande à l'agent de tester un package ou de construire une app\")", [PAGE]);
    expect(await pageText()).toContain("Rien ici pour l'instant.");
  });

  // applications.spec.ts:418
  it("the Applications page comes back after a restart, without web page or history", async () => {
    const first = await openAppsPage(BLOCK);
    p = first;
    await rows(3);
    expect(await missingApi(first.m)).toEqual([]);
    await first.w.close();
    p = undefined;
    p = await openAppsPage(BLOCK, { dataDir: first.dataDir, profile: first.profile, page: false });
    const m = p.m;
    await pageShown(true);
    await rows(3);
    expect(await m.execute<boolean>(`return [...Services.wm.getEnumerator("navigator:browser")].some((w) => w.gBrowser.browsers.some((b) => b.currentURI.spec.startsWith("ressac:")));`)).toBe(false);
    const recents = await inUi<{ url: string }[]>(m, "return await ui.ressac.history.recent();");
    expect(recents.some((v) => v.url.startsWith("ressac:"))).toBe(false);
  });
});
