import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor, waitReady, waitWindowCount } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { click, framesPid, inFrame, inUi, killFrames, waitUi } from "./ui";

// The home page in the sidebar: folder widgets, free placement, the agent's theme, isolated frame and links,
// then grants, harvests (manual, failed, workshop stopped), notifications, removal and host stopped.
// Not run in this worktree (no build or engine): to run after `pnpm build:ui` by the user.

interface PlacementTest {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TestGrant {
  domains: string[];
  public: string[];
  profile: string;
}

type TestGrants = Record<string, TestGrant>;

const ROOT = (dataDir: string) => path.join(dataDir, "workspace");
const HOME = (dataDir: string) => path.join(ROOT(dataDir), "home");
const WIDGETS = (dataDir: string) => path.join(dataDir, "widgets");
const GRANTS = (dataDir: string) => path.join(WIDGETS(dataDir), "grants.json");
const STATE = (dataDir: string, id: string) => path.join(WIDGETS(dataDir), id, "state.json");
const DATA = (dataDir: string, id: string) => path.join(WIDGETS(dataDir), id, "data.json");

async function writeWidget(dataDir: string, id: string, o: { name: string; display: string; declaration?: Record<string, unknown> }): Promise<void> {
  const folder = path.join(HOME(dataDir), "widgets", id);
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, "widget.json"),
    JSON.stringify({
      name: o.name,
      description: "",
      sizes: { min: { w: 2, h: 1 }, max: { w: 6, h: 4 }, default: { w: 3, h: 2 } },
      sources: { account: [], public: [], web: false },
      ...o.declaration,
    }),
  );
  await writeFile(path.join(folder, "display.html"), o.display);
}

async function writeHarvest(dataDir: string, id: string, code: string): Promise<void> {
  await writeFile(path.join(HOME(dataDir), "widgets", id, "harvest.mjs"), code);
}

async function writeLayout(dataDir: string, widgets: PlacementTest[]): Promise<void> {
  await writeFile(path.join(HOME(dataDir), "layout.json"), JSON.stringify({ version: 3, widgets }));
}

async function readLayout(dataDir: string): Promise<PlacementTest[]> {
  return JSON.parse(await readFile(path.join(HOME(dataDir), "layout.json"), "utf8")).widgets;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

async function readGrants(dataDir: string): Promise<TestGrants> {
  return existsSync(GRANTS(dataDir)) ? readJson<TestGrants>(GRANTS(dataDir)) : {};
}

async function wait<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`délai dépassé en attendant ${what}: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * A drag or a resize, through pointer events sent directly in the interface. The gesture does not depend on
 * `isTrusted` (only the widget's links do, and they go through `synthesizeMouseEvent`): this test covers the
 * placement and the writing of layout.json.
 */
async function drag(m: Marionette, selection: string, dx: number, dy: number): Promise<void> {
  await inUi(
    m,
    `
    const el = doc.querySelector(arguments[0]);
    if (!el) throw new Error("introuvable : " + arguments[0]);
    const r = el.getBoundingClientRect();
    const x0 = r.left + r.width / 2, y0 = r.top + Math.min(12, r.height / 2);
    const pointeur = (type, cible, x, y) => cible.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y, pointerId: 1, isPrimary: true,
    }));
    pointeur("pointerdown", el, x0, y0);
    for (let i = 1; i <= 4; i++) pointeur("pointermove", ui, x0 + arguments[1] * i / 4, y0 + arguments[2] * i / 4);
    pointeur("pointerup", ui, x0 + arguments[1], y0 + arguments[2]);`,
    [selection, dx, dy],
  );
}

/** Widget `id`'s frame <browser> (a remote frame: its document is read through the actor's test hook, inFrame). */
const FRAME = (id: string) => `[data-testid="widget-${id}"] browser`;

/** Evaluates `expr` in widget `id`'s document; null while it has none yet. */
function inWidget<T>(m: Marionette, id: string, expr: string): Promise<T | null> {
  return inFrame<T>(m, FRAME(id), expr).catch(() => null);
}

/** The text displayed in a widget's frame. */
async function frameText(m: Marionette, id: string): Promise<string> {
  return (await inWidget<string>(m, id, "document.body?.textContent ?? ''")) ?? "";
}

/** The data received by the display (the `<pre id="donnees">` of AFFICHAGE_DONNEES), not the whole frame body. */
async function dataText(m: Marionette, id: string): Promise<string> {
  return (await inWidget<string>(m, id, `document.getElementById("donnees")?.textContent ?? ""`)) ?? "";
}

/** The text of a widget card: header, grant banner and warnings included. */
function widgetText(m: Marionette, id: string): Promise<string> {
  return inUi(m, `return doc.querySelector('[data-testid="widget-' + arguments[0] + '"]')?.textContent ?? "";`, [id]);
}

/** « Mettre à jour maintenant » through the widget's menu. */
async function harvest(m: Marionette, id: string): Promise<void> {
  await click(m, `[data-testid="widget-${id}"] button[aria-label="Options du widget"]`);
  await click(m, '[role="menuitem"]', { text: "Mettre à jour maintenant" });
}

const DISPLAY = (title: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><p>${title}</p>`;

/** A display that renders the data received by postMessage, to see a harvest arrive. */
const DISPLAY_DATA = `<!doctype html><meta charset="utf-8"><pre id="donnees"></pre>
<script>
  addEventListener("message", (e) => {
    // A sandboxed frame's origin is opaque: event.source is not parent on the page side (measured). The message
    // comes from the chrome, the only one that knows this frame: only its type is checked.
    if (!e.data || e.data.type !== "widget") return;
    document.getElementById("donnees").textContent = JSON.stringify(e.data.data);
  });
</script>`;

describe("the home page", () => {
  let dataDir: string;
  let w: LaunchedRessac;
  let m: Marionette;
  let notifications: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-accueil-"));
    notifications = path.join(dataDir, "notifications.jsonl");
    await mkdir(path.join(HOME(dataDir), "widgets"), { recursive: true });
    await writeWidget(dataDir, "alpha", { name: "Alpha", display: DISPLAY("alpha") });
    await writeWidget(dataDir, "beta", { name: "Beta", display: DISPLAY("beta") });
    // A network hint in the display: served replaced by DISPLAY_DENIED, before any script.
    await writeWidget(dataDir, "refus", {
      name: "Refus",
      display: '<!doctype html><title>refus</title><link rel="stylesheet" href="https://exemple.invalid/x.css"><p>jamais</p>',
    });
    // A link requested at load (ignored) and another on click (accepted only after a real press).
    await writeWidget(dataDir, "lien", {
      name: "Lien",
      display: `<!doctype html><meta charset="utf-8"><title>lien</title><button id="go">ouvrir</button>
<script>
  ressacOpen("https://exemple.invalid/auto");
  // The name a widget written before the rename to Ressac calls.
  document.getElementById("go").onclick = () => webaiosOpen("https://exemple.invalid/clic");
</script>`,
    });
    // A widget that reads with the account: the grant banner shows as long as no grant is given. Its harvest only reads
    // once `config.lire` is set (the « another profile asks again » test), so that the grant is at stake.
    await writeWidget(dataDir, "compte", {
      name: "Compte",
      display: DISPLAY_DATA,
      declaration: {
        harvest: { minutes: 60 },
        sources: { account: ["exemple.invalid"], public: [], web: false },
        config: { lire: false, url: "https://exemple.invalid/x" },
      },
    });
    await writeHarvest(
      dataDir,
      "compte",
      `export default async (w) => { if (w.config?.lire) await w.readPage(w.config.url, { account: true }); return { vu: "compte" }; };`,
    );
    // Another widget with an account: the user refuses it (the banner does not come back from the session).
    await writeWidget(dataDir, "sans-accord", {
      name: "Sans accord",
      display: DISPLAY_DATA,
      declaration: { harvest: { minutes: 60 }, sources: { account: ["exemple.invalid"], public: [], web: false } },
    });
    await writeHarvest(dataDir, "sans-accord", `export default async () => ({ secret: "du compte" });`);
    // A slow harvest: « en cours » stays visible, then the data arrives.
    await writeWidget(dataDir, "lent", {
      name: "Lent",
      display: DISPLAY_DATA,
      declaration: { harvest: { minutes: 60 }, sources: { account: [], public: [], web: false } },
    });
    await writeHarvest(dataDir, "lent", `export default async () => { await new Promise((r) => setTimeout(r, 2500)); return { fait: Date.now() }; };`);
    // A harvest that fails.
    await writeWidget(dataDir, "echec", {
      name: "Échec",
      display: DISPLAY_DATA,
      declaration: { harvest: { minutes: 60 }, sources: { account: [], public: [], web: false } },
    });
    await writeHarvest(dataDir, "echec", `export default async () => { throw new Error("boum"); };`);
    // A watch that notifies its news (first harvest: both items are new).
    await writeWidget(dataDir, "veille", {
      name: "Veille",
      display: DISPLAY_DATA,
      declaration: { harvest: { minutes: 60, notify: true }, sources: { account: [], public: [], web: false } },
    });
    await writeHarvest(dataDir, "veille", `export default async () => [{ url: "https://exemple.invalid/a" }, { url: "https://exemple.invalid/b" }];`);
    // A widget with a grant and data, harvested beforehand: the removal must take all three.
    await writeWidget(dataDir, "retrait", {
      name: "Retrait",
      display: DISPLAY_DATA,
      declaration: { sources: { account: ["exemple.invalid"], public: [], web: false } },
    });
    const now = new Date().toISOString();
    await writeJson(STATE(dataDir, "retrait"), { status: "ok", lastUpdate: now, lastAttempt: now });
    await writeJson(DATA(dataDir, "retrait"), { old: "compte" });
    await writeJson(GRANTS(dataDir), { retrait: { domains: ["exemple.invalid"], public: [], profile: "default" } });
    await writeLayout(dataDir, [
      { id: "alpha", x: 0, y: 0, w: 250, h: 180 },
      { id: "beta", x: 500, y: 0, w: 250, h: 180 },
      { id: "refus", x: 0, y: 200, w: 250, h: 180 },
      { id: "lien", x: 500, y: 200, w: 250, h: 180 },
      { id: "compte", x: 0, y: 400, w: 250, h: 180 },
      { id: "sans-accord", x: 500, y: 400, w: 250, h: 180 },
      { id: "lent", x: 0, y: 600, w: 250, h: 180 },
      { id: "echec", x: 500, y: 600, w: 250, h: 180 },
      { id: "veille", x: 0, y: 800, w: 250, h: 180 },
      { id: "retrait", x: 500, y: 800, w: 250, h: 180 },
    ]);
    // A test notification is a file, never a macOS bubble.
    w = await launchRessac({ dataDir, env: { RESSAC_TEST_NOTIFICATIONS: notifications } });
    m = w.marionette;
    await m.setContext("chrome");
    await waitReady(m);
  });
  afterAll(async () => {
    await w?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("the screen without a tab shows the folder's widgets, served by resource://ressac-frames-", async () => {
    const titles = await wait(
      () => inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="widget-title"]')].map((e) => e.textContent);`),
      (ts) => ts.length === 10,
      "les dix widgets",
      15_000,
    );
    expect(titles).toEqual(["Alpha", "Beta", "Refus", "Lien", "Compte", "Sans accord", "Lent", "Échec", "Veille", "Retrait"]);
    const src = await wait(() => inWidget<string>(m, "alpha", "document.documentURI"), (u) => !!u?.startsWith("resource:"), "alpha's document", 15_000);
    expect(src).toMatch(/^resource:\/\/ressac-frames-[0-9a-f]{16}\/widgets\/alpha\/display-\d+-\d+\.html$/);
    // Data sent on the first render after launch: the frame's messages are heard even when it mounts before the store
    // registered the frames' actor.
    expect(await wait(() => dataText(m, "retrait"), (t) => t !== "", "retrait's data at launch", 15_000)).toBe('{"old":"compte"}');
  });

  it("widgets run in one content process, not the parent", async () => {
    const r = await waitUi<{ pids: number[]; parent: number; nulls: boolean[]; types: string[] } | null>(
      m,
      `const bs = [...doc.querySelectorAll('[data-testid^="widget-"] browser')];
       const wgs = bs.map((b) => b.browsingContext?.currentWindowGlobal);
       if (bs.length < 10 || wgs.some((g) => !g)) return null;
       return { pids: wgs.map((g) => g.osPid), parent: Services.appinfo.processID, nulls: wgs.map((g) => g.documentPrincipal.isNullPrincipal), types: bs.map((b) => b.remoteType) };`,
      [],
      15_000,
    );
    expect(r!.pids.length).toBeGreaterThanOrEqual(10);
    expect(new Set(r!.pids).size, "one process for every widget").toBe(1);
    expect(r!.pids[0]).not.toBe(r!.parent);
    expect(r!.nulls.every(Boolean), "null principals").toBe(true);
    for (const t of r!.types) expect(t).toMatch(/^webIsolated=resource:\/\/ressac-frames-/);
  });

  it("a focus() from a widget's code leaves the keyboard to the interface; a real click gives it to the widget", async () => {
    await wait(() => inWidget<string>(m, "alpha", "document.documentURI"), (u) => !!u?.startsWith("resource:"), "alpha's document", 15_000);
    const active = () => inUi<string>(m, `const a = doc.activeElement; return a?.getAttribute("aria-label") ?? a?.localName ?? "none";`);
    // The keyboard in the interface first (a window focus with nothing focused would move it to the home's field).
    await inUi(m, `ui.focus();`);
    await waitUi(m, `return Services.focus.focusedWindow === ui;`, [], 5000);
    await new Promise((r) => setTimeout(r, 300));
    await inUi(m, `doc.querySelector('[data-testid="widget-alpha"] button[aria-label="Options du widget"]').focus();`);
    expect(await active()).toBe("Options du widget");
    await inFrame(m, FRAME("alpha"), `(() => { document.body.tabIndex = 0; document.body.focus(); })()`);
    await new Promise((r) => setTimeout(r, 500));
    expect(await active()).toBe("Options du widget");
    expect(await inWidget<boolean>(m, "alpha", "document.hasFocus()")).toBe(false);
    // A click by the user: the widget is under the pointer, it keeps the keyboard.
    await inUi(
      m,
      `const r = doc.querySelector(arguments[0]).getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
       ui.synthesizeMouseEvent("mousemove", x, y, {});
       ui.synthesizeMouseEvent("mousedown", x, y, { button: 0, clickCount: 1 });
       ui.synthesizeMouseEvent("mouseup", x, y, { button: 0, clickCount: 1 });`,
      [FRAME("alpha")],
    );
    await waitUi(m, `return doc.activeElement === doc.querySelector(arguments[0]);`, [FRAME("alpha")], 5000);
    await new Promise((r) => setTimeout(r, 300));
    expect(await active(), "the frame browser, labelled by the widget name").toBe("Alpha");
  });

  it("a widget added by the agent appears without restarting", async () => {
    await writeWidget(dataDir, "nouveau", { name: "Nouveau", display: DISPLAY("nouveau") });
    const titles = await wait(
      () => inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="widget-title"]')].map((e) => e.textContent);`),
      (ts) => ts.includes("Nouveau"),
      "le widget ajouté",
    );
    expect(titles).toContain("Nouveau");
  });

  it("the page does not repeat the sidebar's essentials", async () => {
    const s = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: "https://exemple.invalid/favori" });
    const tab = Object.entries(s.tabs).find(([, o]) => o.url.includes("/favori"))![0];
    await dispatch(m, { type: "addEssential", id: tab });
    await dispatch(m, { type: "showBlankPage", windowId: s.windows[0]!.id });
    await waitUi(m, `return !!doc.querySelector('[data-testid="empty-page"]') && doc.querySelectorAll('[data-testid="essentials"] [data-testid^="favorite-"]').length === 1`);
    expect(await inUi(m, `return doc.querySelectorAll('[data-testid="empty-page"] [data-testid^="favorite-"]').length`)).toBe(0);
  });

  it("dragging a widget moves no other", async () => {
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-alpha"] header')`);
    const before = await readLayout(dataDir);
    const betaBefore = before.find((p) => p.id === "beta")!;
    // Far to the right passing over bêta: a drag can cross a neighbour, and alpha stops at the
    // right edge of the home (750 = 1000 ‰ - 250 ‰), without moving bêta.
    await drag(m, '[data-testid="widget-alpha"] header', 1200, 0);
    // The read can land during a write: an empty or unreadable list must not make the wait fail.
    const after = await wait(
      () => readLayout(dataDir).catch(() => [] as PlacementTest[]),
      (ps) => (ps.find((p) => p.id === "alpha")?.x ?? 0) > 0,
      "l'écriture du glisser",
    );
    const alpha = after.find((p) => p.id === "alpha")!;
    const beta = after.find((p) => p.id === "beta")!;
    expect(alpha.x).toBeGreaterThan(0);
    expect(alpha.x + alpha.w).toBeLessThanOrEqual(1000);
    // Alpha goes beyond bêta: it cannot be dropped on another widget, but the drag flies over it.
    expect(alpha.x).toBe(750);
    expect(beta).toEqual(betaBefore);
  });

  it("resizing stays within bounds and does not overflow on the right", async () => {
    // Declared max: 6 units wide (500 ‰) and 4 rows (360 px).
    await drag(m, '[data-testid="widget-beta"] [data-testid="resize-handle"]', 600, 300);
    const after = await wait(
      () => readLayout(dataDir).catch(() => [] as PlacementTest[]),
      (ps) => {
        const b = ps.find((p) => p.id === "beta");
        return !!b && (b.w > 250 || b.h > 180);
      },
      "l'écriture du redimensionnement",
    );
    const beta = after.find((p) => p.id === "beta")!;
    expect(beta.w).toBeGreaterThanOrEqual(167); // min: 2 units
    expect(beta.w).toBeLessThanOrEqual(500); // max: 6 units
    expect(beta.h).toBeLessThanOrEqual(360);
    expect(beta.x + beta.w).toBeLessThanOrEqual(1000);
  });

  it("a <link> in the display is replaced by DISPLAY_DENIED", async () => {
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-refus"] browser');`, [], 15_000);
    const text = await wait(() => frameText(m, "refus"), (t) => t.includes("Affichage refusé"), "le refus de l'affichage");
    expect(text).toContain("Affichage refusé");
    expect(text).not.toContain("jamais");
  });

  it("the agent's theme changes the home's colors; an invalid theme goes back to the default", async () => {
    const background = () => inUi<string>(m, `return ui.getComputedStyle(doc.querySelector('[data-testid="home"]')).backgroundColor;`);
    const defaultValue = await background();
    await writeFile(path.join(HOME(dataDir), "theme.json"), JSON.stringify({ version: 1, background: "#101014", accent: "#8b7cf6", radius: 4 }));
    await wait(background, (c) => c === "rgb(16, 16, 20)", "le fond du thème");
    await writeFile(path.join(HOME(dataDir), "theme.json"), "{ pas du json");
    await wait(background, (c) => c === defaultValue, "le retour au thème par défaut");
  });

  it("a widget link only opens after a real press, never at load nor by a simulated click", async () => {
    await wait(() => inWidget<boolean>(m, "lien", `!!document.getElementById("go")`), Boolean, "the link's button", 15_000);
    // Opened tabs only: an essential keeps its own loaded.
    const urls = async () => Object.values((await state(m)).tabs).filter((o) => !o.link).map((o) => o.url);
    // The load's send: no gesture, no tab.
    await new Promise((r) => setTimeout(r, 2000));
    expect((await urls()).filter((u) => u.includes("exemple.invalid"))).toEqual([]);
    // A click simulated by the script: isTrusted false, no gesture, no tab.
    await inFrame(m, FRAME("lien"), `document.getElementById("go").click()`);
    await new Promise((r) => setTimeout(r, 2000));
    expect((await urls()).filter((u) => u.includes("exemple.invalid"))).toEqual([]);
    // A real press in the frame: the actor signals the gesture, the link opens.
    await inUi(m, `doc.querySelector(arguments[0]).scrollIntoView({ block: "center" }); await new Promise((r) => requestAnimationFrame(r));`, [FRAME("lien")]);
    // The frame's process learns its new place a paint or more after the scroll; a press before that lands where the frame
    // was (measured: the page got the press 194 px above the link). Pressed once both agree, as ui-network.e2e.ts.
    const where = () => Promise.all([inUi<number>(m, `return ui.mozInnerScreenY + doc.querySelector(arguments[0]).getBoundingClientRect().top;`, [FRAME("lien")]), inFrame<number>(m, FRAME("lien"), "window.mozInnerScreenY")]);
    await expect.poll(async () => { const [outer, inner] = await where(); return Math.abs(outer - inner) < 1; }).toBe(true);
    const q = (await inFrame<{ left: number; top: number; width: number; height: number }>(m, FRAME("lien"), `document.getElementById("go").getBoundingClientRect().toJSON()`))!;
    await inUi(
      m,
      `const r = doc.querySelector(arguments[0]).getBoundingClientRect(), q = arguments[1];
       const x = r.left + q.left + q.width / 2, y = r.top + q.top + q.height / 2;
       ui.synthesizeMouseEvent("mousedown", x, y, { button: 0, clickCount: 1 });
       ui.synthesizeMouseEvent("mouseup", x, y, { button: 0, clickCount: 1 });`,
      [FRAME("lien"), q],
    );
    await wait(urls, (us) => us.includes("https://exemple.invalid/clic"), "l'ouverture du lien");
    expect((await urls()).filter((u) => u.includes("/auto"))).toEqual([]);
    // The opening activated a tab: the home is no longer mounted (EmptyPage). We close it again for what follows.
    const tab = Object.entries((await state(m)).tabs).find(([, o]) => o.url.includes("exemple.invalid/clic"))?.[0];
    expect(tab).toBeDefined();
    await dispatch(m, { type: "closeTab", id: tab! });
    await waitUi(m, `return !!doc.querySelector('[data-testid="home"]') && !!doc.querySelector('[data-testid="widget-alpha"]');`, [], 15_000);
  });

  it("a widget display opens no Firefox window", async () => {
    await wait(() => inWidget<string>(m, "alpha", "document.documentURI"), (u) => !!u?.startsWith("resource:"), "alpha's document", 15_000);
    await waitWindowCount(m, 1);
    await new Promise((r) => setTimeout(r, 500));
    expect(await waitWindowCount(m, 1)).toHaveLength(1);
    // No tab <browser> loads the frames' substitution: widgets are frame browsers of the sidebar.
    const top = await waitFor<number>(m, `return [...gBrowser.browsers].filter((b) => b.currentURI?.spec?.startsWith("resource://ressac-frames-")).length;`, (n) => n === 0);
    expect(top).toBe(0);
  });

  it("the grant card: Autoriser keeps the chosen profile and starts the harvest with the account", async () => {
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-compte"] [data-testid="grant-banner"]');`, [], 15_000);
    expect(await widgetText(m, "compte")).toContain("exemple.invalid");
    // Nothing is read with the account until the user has granted.
    expect(existsSync(DATA(dataDir, "compte"))).toBe(false);
    await click(m, '[data-testid="widget-compte"] [data-testid="grant-banner"] button', { text: "Autoriser…" });
    const card = await waitUi<string>(m, `const c = doc.querySelector('[data-testid="grant-card"]'); return c ? c.textContent : "";`);
    expect(card).toContain("exemple.invalid");
    expect(card).toContain("ne contactera aucun autre site");
    // The active space's profile (the default profile) is ticked.
    const profiles = await waitUi<[string, boolean][]>(
      m,
      `const rs = [...doc.querySelectorAll('[data-testid="grant-card"] input[type="radio"]')];
       return rs.length ? rs.map((r) => [r.value, r.checked]) : null;`,
    );
    expect(profiles).toEqual([["default", true]]);
    await click(m, '[data-testid="grant-card"] button', { text: "Autoriser" });
    // The grant names the shown domains and the chosen profile; the harvest starts and its data reaches the frame.
    const grant = await wait(() => readGrants(dataDir), (a) => a.compte?.profile === "default", "l'écriture de l'accord");
    expect(grant.compte).toEqual({ domains: ["exemple.invalid"], public: [], profile: "default" });
    await wait(() => (existsSync(DATA(dataDir, "compte")) ? readJson<unknown>(DATA(dataDir, "compte")) : Promise.resolve(null)), (d) => d !== null, "les données de la récolte");
    expect(await readJson(DATA(dataDir, "compte"))).toEqual({ vu: "compte" });
    await wait(() => dataText(m, "compte"), (t) => t === '{"vu":"compte"}', "les données dans le cadre");
    expect(await waitUi(m, `return !doc.querySelector('[data-testid="widget-compte"] [data-testid="grant-banner"]');`)).toBe(true);
  });

  it("Refuser does not come back: the banner stays hidden after the page is reread", async () => {
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-sans-accord"] [data-testid="grant-banner"]');`, [], 15_000);
    // A grant and data from before (as after another profile): the denial must really erase them.
    await writeJson(GRANTS(dataDir), { ...(await readGrants(dataDir)), "sans-accord": { domains: ["exemple.invalid"], public: [], profile: "default" } });
    await writeJson(DATA(dataDir, "sans-accord"), { secret: "du compte" });
    await click(m, '[data-testid="widget-sans-accord"] [data-testid="grant-banner"] button', { text: "Refuser" });
    expect(await waitUi(m, `return !doc.querySelector('[data-testid="widget-sans-accord"] [data-testid="grant-banner"]');`)).toBe(true);
    // An added widget forces a reread (accueil.change): the denial holds for the session, the banner does not come back.
    // A GC first: the home came back after a tab (link test), and the teardown of the frames' group from before used to
    // drop the new group's id from Firefox's table, so this new frame started a second process.
    await m.execute(`Cu.forceGC(); Cu.forceCC(); Cu.forceGC();`);
    await writeWidget(dataDir, "temoin", { name: "Témoin", display: DISPLAY("témoin") });
    await wait(
      () => inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="widget-title"]')].map((e) => e.textContent);`),
      (ts) => ts.includes("Témoin"),
      "la relecture après le refus",
    );
    const pids = await waitUi<number[] | null>(
      m,
      `const gs = [...doc.querySelectorAll('[data-testid^="widget-"] browser')].map((b) => b.browsingContext?.currentWindowGlobal);
       return doc.querySelector('[data-testid="widget-temoin"] browser') && gs.every((g) => g?.osPid) ? gs.map((g) => g.osPid) : null;`,
      [],
      15_000,
    );
    expect(new Set(pids).size, "the added widget in the frames' one process").toBe(1);
    expect(await inUi<boolean>(m, `return !!doc.querySelector('[data-testid="widget-sans-accord"] [data-testid="grant-banner"]');`)).toBe(false);
    await wait(() => readGrants(dataDir), (a) => a["sans-accord"] === undefined, "le retrait de l'accord refusé");
    await wait(async () => existsSync(DATA(dataDir, "sans-accord")), (present) => !present, "le retrait des données du refus");
    expect(await readJson<{ status: string }>(STATE(dataDir, "sans-accord"))).toMatchObject({ status: "grant-required" });
  });

  it("a widget without account written after start, with a public domain: the banner asks once, nothing is harvested before « Autoriser »", async () => {
    await writeWidget(dataDir, "lecture", {
      name: "Lecture",
      display: DISPLAY_DATA,
      declaration: { harvest: { minutes: 60 }, sources: { account: [], public: ["exemple.invalid"], web: false } },
    });
    await writeHarvest(dataDir, "lecture", `export default async () => ({ vu: "public" });`);
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-lecture"]');`, [], 15_000);
    await harvest(m, "lecture");
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-lecture"] [data-testid="grant-banner"]');`, [], 15_000);
    expect(await widgetText(m, "lecture")).toContain("Ce widget lira : exemple.invalid");
    expect(existsSync(DATA(dataDir, "lecture"))).toBe(false);
    // No card: the click approves exactly what the banner showed, then the harvest runs.
    await click(m, '[data-testid="widget-lecture"] [data-testid="grant-banner"] button', { text: "Autoriser" });
    await wait(() => (existsSync(DATA(dataDir, "lecture")) ? readJson<unknown>(DATA(dataDir, "lecture")) : Promise.resolve(null)), (d) => d !== null, "les données de la récolte", 20_000);
    expect(await readJson(path.join(WIDGETS(dataDir), "reads.json"))).toMatchObject({ lecture: { public: ["exemple.invalid"], web: false } });
    expect(await waitUi(m, `return !doc.querySelector('[data-testid="widget-lecture"] [data-testid="grant-banner"]');`)).toBe(true);
  });

  it("a grant that names an invalid profile asks again: the harvest refuses it, the grant and its data go away", async () => {
    // The grant names a sign-in profile; a profile absent from the session makes it unusable. (A profile that
    // becomes private only asks again at the widget's next scheduled harvest: see the README's limit.)
    const declaration = await readJson<Record<string, unknown>>(path.join(HOME(dataDir), "widgets", "compte", "widget.json"));
    await writeJson(path.join(HOME(dataDir), "widgets", "compte", "widget.json"), { ...declaration, config: { lire: true, url: "https://exemple.invalid/x" } });
    await writeJson(GRANTS(dataDir), { ...(await readGrants(dataDir)), compte: { domains: ["exemple.invalid"], public: [], profile: "absent" } });
    await harvest(m, "compte");
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-compte"] [data-testid="grant-banner"]');`, [], 20_000);
    expect((await readGrants(dataDir)).compte).toBeUndefined();
    expect(existsSync(DATA(dataDir, "compte"))).toBe(false);
    expect(await readJson<{ status: string }>(STATE(dataDir, "compte"))).toMatchObject({ status: "grant-required" });
    // The new request offers a profile again.
    await click(m, '[data-testid="widget-compte"] [data-testid="grant-banner"] button', { text: "Autoriser…" });
    const profiles = await waitUi<[string, boolean][]>(m, `const rs = [...doc.querySelectorAll('[data-testid="grant-card"] input[type="radio"]')]; return rs.length ? rs.map((r) => [r.value, r.checked]) : null;`);
    expect(profiles.map(([id]) => id)).toContain("default");
    await click(m, '[data-testid="grant-card"] button', { text: "Annuler" });
  });

  it("a manual harvest goes through « en cours » then fills the widget", async () => {
    const data = () => (existsSync(DATA(dataDir, "lent")) ? readJson<{ fait: number }>(DATA(dataDir, "lent")) : Promise.resolve(null));
    await wait(data, (d) => d !== null, "les données du lancement", 20_000);
    const before = await wait(
      async () => {
        try {
          return JSON.parse(await dataText(m, "lent")) as { fait: number };
        } catch {
          return null;
        }
      },
      (d) => d !== null,
      "les données dans le cadre",
    );
    // The data and the home's re-reads reach the pages by message: neither this widget nor another one reloads.
    const mark = `document.documentElement.dataset.kept = "1"`, kept = `document.documentElement.dataset.kept === "1"`;
    for (const id of ["lent", "alpha"]) await inWidget(m, id, mark);
    await harvest(m, "lent");
    // The « en cours » state is written before the container: the badge stays visible during the slow harvest.
    await waitUi(m, `return (doc.querySelector('[data-testid="widget-lent"] header')?.textContent ?? '').includes('mise à jour…');`, [], 10_000);
    const after = await wait(
      async () => {
        try {
          return JSON.parse(await dataText(m, "lent")) as { fait: number };
        } catch {
          return null;
        }
      },
      (d) => d !== null && d.fait > before!.fait,
      "les nouvelles données dans le cadre",
      20_000,
    );
    expect(after!.fait).toBeGreaterThan(before!.fait);
    for (const id of ["lent", "alpha"]) expect(await inWidget(m, id, kept), id).toBe(true);
  });

  it("a failed harvest says so and leaves no data", async () => {
    const text = await wait(() => widgetText(m, "echec"), (t) => t.includes("échec du") && t.includes("boum"), "l'échec de la récolte", 20_000);
    expect(text).toContain("échec du");
    expect(existsSync(DATA(dataDir, "echec"))).toBe(false);
    expect(await readJson<{ status: string; error: string }>(STATE(dataDir, "echec"))).toMatchObject({ status: "error", error: "boum" });
  });

  it("a news harvest writes its notification into RESSAC_TEST_NOTIFICATIONS", async () => {
    const lines = await wait(
      async () => ((existsSync(notifications) ? (await readFile(notifications, "utf8")).trim().split("\n").filter(Boolean) : []).map((l) => JSON.parse(l) as { title: string; text: string })),
      (ls) => ls.some((n) => n.title === "Veille"),
      "la notification de nouveautés",
      20_000,
    );
    expect(lines).toContainEqual({ title: "Veille", text: "2 nouveaux éléments" });
  });

  // Measured before the fix: after the kill, every widget stays blank for good.
  it("the frames' process killed: every widget comes back with its display and its data", async () => {
    await wait(() => dataText(m, "retrait"), (t) => t === '{"old":"compte"}', "retrait's data", 15_000);
    await killFrames(m);
    await wait(() => dataText(m, "retrait"), (t) => t === '{"old":"compte"}', "retrait's data again", 20_000);
    expect(await wait(() => frameText(m, "alpha"), (t) => t.includes("alpha"), "alpha's display again", 15_000)).toContain("alpha");
    expect(await inUi<number>(m, `return doc.querySelectorAll('[data-testid="frame-stopped"]').length;`)).toBe(0);
    const procs = await inUi<[number, string, number][]>(m, `return [...doc.querySelectorAll('[data-testid^="widget-"] browser')].map((b) => { const g = b.browsingContext?.currentWindowGlobal; return [g?.osPid ?? 0, g?.domProcess?.remoteType ?? "", b.browsingContext?.group?.id ?? 0]; });`);
    expect(new Set(procs.map((p) => p[0])).size, "one process for every widget again").toBe(1);
  }, 60_000);

  it("Retirer: the folder goes into .corbeille, the grant and the data are erased", async () => {
    // The widget has a grant and data before the removal.
    expect(existsSync(path.join(HOME(dataDir), "widgets", "retrait"))).toBe(true);
    expect((await readGrants(dataDir)).retrait).toBeDefined();
    expect(existsSync(DATA(dataDir, "retrait"))).toBe(true);
    await click(m, '[data-testid="widget-retrait"] button[aria-label="Options du widget"]');
    await click(m, '[role="menuitem"]', { text: "Retirer" });
    const confirmation = await waitUi<string>(m, `const d = doc.querySelector('[data-testid="removal-confirmation"]'); return d ? d.textContent : "";`);
    expect(confirmation).toContain("Retirer « Retrait » de la page d'accueil ?");
    await click(m, '[data-testid="removal-confirmation"] button', { text: "Retirer" });
    await waitUi(m, `return !doc.querySelector('[data-testid="widget-retrait"]');`, [], 15_000);
    const trash = await wait(
      () => readdir(path.join(HOME(dataDir), ".trash")).catch(() => [] as string[]),
      (names) => names.some((n) => n.startsWith("retrait-")),
      "le dossier du widget dans la corbeille",
    );
    expect(trash.some((n) => n.startsWith("retrait-"))).toBe(true);
    expect(existsSync(path.join(HOME(dataDir), "widgets", "retrait"))).toBe(false);
    // The host removes the grant then the data: both together.
    await wait(
      async () => ({ grant: (await readGrants(dataDir)).retrait, data: existsSync(DATA(dataDir, "retrait")) }),
      (v) => v.grant === undefined && !v.data,
      "le retrait de l'accord et des données",
    );
  });

  it("host stopped: the actions stay without effect and the page stays displayed", async () => {
    await m.execute(`return (async () => { await window.ressacWindow.store.agent.stop(); return true; })();`);
    await waitFor<number | null>(m, `return window.ressacWindow.store.agent.pid;`, (pid) => pid === null);
    await harvest(m, "veille");
    const text = await wait(() => widgetText(m, "veille"), (t) => t.includes("Sans effet pour l'instant"), "l'avertissement sans effet", 12_000);
    expect(text).toContain("le service des widgets ne répond pas");
    // The widgets stay displayed, frames included.
    expect(await inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="widget-title"]')].map((e) => e.textContent);`)).toContain("Veille");
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-veille"] browser');`);
  });

  it("a frames' process that keeps dying: past three deaths a minute the widgets stay empty, with a message", async () => {
    // One death already (the test above), maybe out of the minute by now: at most four more, the last one stays.
    const stopped = () => inUi<string>(m, `return doc.querySelector('[data-testid="widget-alpha"] [data-testid="frame-stopped"]')?.textContent ?? "";`);
    let text = "";
    for (let i = 0; i < 4 && !text; i++) {
      await killFrames(m);
      const r = await wait(async () => ({ stop: await stopped(), back: await frameText(m, "alpha") }), (v) => !!v.stop || v.back.includes("alpha"), `alpha after kill ${i + 2}`, 20_000);
      text = r.stop;
    }
    expect(text).toBe("Cet affichage s'est arrêté plusieurs fois : il reste vide.");
    await new Promise((r) => setTimeout(r, 2000));
    expect(await framesPid(m), "no new process").toBeNull();
  }, 90_000);

});

// Widgets with no harvest: nothing the new kernel does writes, so only its start can make the page read again.
describe("the home page after a host restart", () => {
  let dataDir: string;
  let w: LaunchedRessac;
  let m: Marionette;
  const titles = () => inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="widget-title"]')].map((e) => e.textContent);`);

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-accueil-relance-"));
    await mkdir(path.join(HOME(dataDir), "widgets"), { recursive: true });
    await writeWidget(dataDir, "alpha", { name: "Alpha", display: DISPLAY("alpha") });
    w = await launchRessac({ dataDir });
    m = w.marionette;
    await m.setContext("chrome");
    await waitReady(m);
    await wait(titles, (ts) => ts.includes("Alpha"), "the first widget", 20_000);
  });
  afterAll(async () => {
    await w?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("a widget added while the host was stopped shows once it starts again (Réessayer)", async () => {
    await m.execute(`return (async () => { await window.ressacWindow.store.agent.stop(); return true; })();`);
    await waitFor<number | null>(m, `return window.ressacWindow.store.agent.pid;`, (pid) => pid === null);
    await writeWidget(dataDir, "pendant-arret", { name: "Pendant l'arrêt", display: DISPLAY("pendant-arret") });
    await m.execute(`return (async () => { await window.ressacWindow.store.agent.ensure(); return true; })();`);
    expect(await wait(titles, (ts) => ts.includes("Pendant l'arrêt"), "the widget added while the host was stopped", 20_000)).toContain("Alpha");
  });
});

describe("the home page, workshop stopped", () => {
  let dataDir: string;
  let w: LaunchedRessac;
  let m: Marionette;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-accueil-atelier-"));
    await mkdir(path.join(HOME(dataDir), "widgets"), { recursive: true });
    await writeWidget(dataDir, "veille", {
      name: "Veille",
      display: DISPLAY_DATA,
      declaration: { harvest: { minutes: 60 }, sources: { account: [], public: [], web: false } },
    });
    await writeHarvest(dataDir, "veille", `export default async () => [{ url: "https://exemple.invalid/a" }];`);
    // Data from a previous harvest, and a due state: the launch check must keep them.
    await writeJson(DATA(dataDir, "veille"), { old: true });
    await writeJson(STATE(dataDir, "veille"), { status: "ok", lastUpdate: "2026-01-01T00:00:00.000Z", lastAttempt: "2026-01-01T00:00:00.000Z" });
    await writeLayout(dataDir, [{ id: "veille", x: 0, y: 0, w: 250, h: 180 }]);
    w = await launchRessac({ dataDir, env: { FAKE_DOCKER_ABSENT: "1" } });
    m = w.marionette;
    await m.setContext("chrome");
    await waitReady(m);
  });
  afterAll(async () => {
    await w?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("without a workshop, the harvest does not run: « atelier arrêté », the data kept", async () => {
    await wait(() => widgetText(m, "veille"), (t) => t.includes("mise à jour impossible : atelier arrêté"), "l'atelier arrêté", 20_000);
    expect(await readJson(DATA(dataDir, "veille"))).toEqual({ old: true });
    // « Mettre à jour maintenant » launches nothing either: nothing changes, the interface says so after its delay.
    await harvest(m, "veille");
    await wait(() => widgetText(m, "veille"), (t) => t.includes("Sans effet pour l'instant"), "l'action sans effet", 12_000);
    expect(await readJson<{ status: string }>(STATE(dataDir, "veille"))).toMatchObject({ status: "workshop-stopped" });
    expect(await readJson(DATA(dataDir, "veille"))).toEqual({ old: true });
    // The page stays displayed.
    expect(await inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="widget-title"]')].map((e) => e.textContent);`)).toEqual(["Veille"]);
  });
});
