import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor, waitReady, waitWindowCount } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, waitUi } from "./ui";

// The home page in the sidebar: folder widgets, free placement, the agent's theme, isolated frame and links,
// then grants, harvests (manual, failed, workshop stopped), notifications, removal and host stopped.
// Not run in this worktree (no build or engine): to run after `pnpm build:ui` by the user.

interface PlacementTest {
  id: string;
  x: number;
  y: number;
  l: number;
  h: number;
}

interface TestGrant {
  domaines: string[];
  publiques: string[];
  profil: string;
}

type TestGrants = Record<string, TestGrant>;

const ROOT = (dataDir: string) => path.join(dataDir, "espace");
const HOME = (dataDir: string) => path.join(ROOT(dataDir), "accueil");
const WIDGETS = (dataDir: string) => path.join(dataDir, "widgets");
const GRANTS = (dataDir: string) => path.join(WIDGETS(dataDir), "accords.json");
const STATE = (dataDir: string, id: string) => path.join(WIDGETS(dataDir), id, "etat.json");
const DATA = (dataDir: string, id: string) => path.join(WIDGETS(dataDir), id, "donnees.json");

async function writeWidget(dataDir: string, id: string, o: { nom: string; affichage: string; declaration?: Record<string, unknown> }): Promise<void> {
  const folder = path.join(HOME(dataDir), "widgets", id);
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, "widget.json"),
    JSON.stringify({
      nom: o.nom,
      description: "",
      tailles: { min: { l: 2, h: 1 }, max: { l: 6, h: 4 }, defaut: { l: 3, h: 2 } },
      sources: { compte: [], publiques: [], web: false },
      ...o.declaration,
    }),
  );
  await writeFile(path.join(folder, "affichage.html"), o.affichage);
}

async function writeHarvest(dataDir: string, id: string, code: string): Promise<void> {
  await writeFile(path.join(HOME(dataDir), "widgets", id, "recolte.mjs"), code);
}

async function writeLayout(dataDir: string, widgets: PlacementTest[]): Promise<void> {
  await writeFile(path.join(HOME(dataDir), "disposition.json"), JSON.stringify({ version: 3, widgets }));
}

async function readLayout(dataDir: string): Promise<PlacementTest[]> {
  return JSON.parse(await readFile(path.join(HOME(dataDir), "disposition.json"), "utf8")).widgets;
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
 * placement and the writing of disposition.json.
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

/** The text displayed in a widget's frame (opaque origin: the document is read from the chrome context). */
function frameText(m: Marionette, id: string): Promise<string> {
  return inUi(
    m,
    `const f = doc.querySelector('[data-testid="widget-' + arguments[0] + '"] iframe');
     return f?.contentDocument?.body?.textContent ?? "";`,
    [id],
  );
}

/** The data received by the display (the `<pre id="donnees">` of AFFICHAGE_DONNEES), not the whole frame body. */
function dataText(m: Marionette, id: string): Promise<string> {
  return inUi(
    m,
    `const f = doc.querySelector('[data-testid="widget-' + arguments[0] + '"] iframe');
     return f?.contentDocument?.getElementById("donnees")?.textContent ?? "";`,
    [id],
  );
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
    // L'origine d'un cadre sandbox est opaque : event.source n'est pas parent côté page (mesuré). Le message
    // vient du chrome, seul à connaître ce cadre : on ne vérifie que son type.
    if (!e.data || e.data.type !== "widget") return;
    document.getElementById("donnees").textContent = JSON.stringify(e.data.donnees);
  });
</script>`;

describe("the home page", () => {
  let dataDir: string;
  let w: LaunchedWebAiOs;
  let m: Marionette;
  let notifications: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-accueil-"));
    notifications = path.join(dataDir, "notifications.jsonl");
    await mkdir(path.join(HOME(dataDir), "widgets"), { recursive: true });
    await writeWidget(dataDir, "alpha", { nom: "Alpha", affichage: DISPLAY("alpha") });
    await writeWidget(dataDir, "beta", { nom: "Beta", affichage: DISPLAY("beta") });
    // A network hint in the display: served replaced by DISPLAY_DENIED, before any script.
    await writeWidget(dataDir, "refus", {
      nom: "Refus",
      affichage: '<!doctype html><title>refus</title><link rel="stylesheet" href="https://exemple.invalid/x.css"><p>jamais</p>',
    });
    // A link requested at load (ignored) and another on click (accepted only after a real press).
    await writeWidget(dataDir, "lien", {
      nom: "Lien",
      affichage: `<!doctype html><meta charset="utf-8"><title>lien</title><button id="go">ouvrir</button>
<script>
  webaiosOuvrir("https://exemple.invalid/auto");
  document.getElementById("go").onclick = () => webaiosOuvrir("https://exemple.invalid/clic");
</script>`,
    });
    // A widget that reads with the account: the grant banner shows as long as no grant is given. Its harvest only reads
    // once `config.lire` is set (the « another profile asks again » test), so that the grant is at stake.
    await writeWidget(dataDir, "compte", {
      nom: "Compte",
      affichage: DISPLAY_DATA,
      declaration: {
        recolte: { minutes: 60 },
        sources: { compte: ["exemple.invalid"], publiques: [], web: false },
        config: { lire: false, url: "https://exemple.invalid/x" },
      },
    });
    await writeHarvest(
      dataDir,
      "compte",
      `export default async (w) => { if (w.config?.lire) await w.lirePage(w.config.url, { compte: true }); return { vu: "compte" }; };`,
    );
    // Another widget with an account: the user refuses it (the banner does not come back from the session).
    await writeWidget(dataDir, "sans-accord", {
      nom: "Sans accord",
      affichage: DISPLAY_DATA,
      declaration: { recolte: { minutes: 60 }, sources: { compte: ["exemple.invalid"], publiques: [], web: false } },
    });
    await writeHarvest(dataDir, "sans-accord", `export default async () => ({ secret: "du compte" });`);
    // A slow harvest: « en cours » stays visible, then the data arrives.
    await writeWidget(dataDir, "lent", {
      nom: "Lent",
      affichage: DISPLAY_DATA,
      declaration: { recolte: { minutes: 60 }, sources: { compte: [], publiques: [], web: false } },
    });
    await writeHarvest(dataDir, "lent", `export default async () => { await new Promise((r) => setTimeout(r, 2500)); return { fait: Date.now() }; };`);
    // A harvest that fails.
    await writeWidget(dataDir, "echec", {
      nom: "Échec",
      affichage: DISPLAY_DATA,
      declaration: { recolte: { minutes: 60 }, sources: { compte: [], publiques: [], web: false } },
    });
    await writeHarvest(dataDir, "echec", `export default async () => { throw new Error("boum"); };`);
    // A watch that notifies its news (first harvest: both items are new).
    await writeWidget(dataDir, "veille", {
      nom: "Veille",
      affichage: DISPLAY_DATA,
      declaration: { recolte: { minutes: 60, notifier: true }, sources: { compte: [], publiques: [], web: false } },
    });
    await writeHarvest(dataDir, "veille", `export default async () => [{ url: "https://exemple.invalid/a" }, { url: "https://exemple.invalid/b" }];`);
    // A widget with a grant and data, harvested beforehand: the removal must take all three.
    await writeWidget(dataDir, "retrait", {
      nom: "Retrait",
      affichage: DISPLAY_DATA,
      declaration: { sources: { compte: ["exemple.invalid"], publiques: [], web: false } },
    });
    const now = new Date().toISOString();
    await writeJson(STATE(dataDir, "retrait"), { statut: "ok", derniereMaj: now, derniereTentative: now });
    await writeJson(DATA(dataDir, "retrait"), { ancien: "compte" });
    await writeJson(GRANTS(dataDir), { retrait: { domaines: ["exemple.invalid"], publiques: [], profil: "defaut" } });
    await writeLayout(dataDir, [
      { id: "alpha", x: 0, y: 0, l: 250, h: 180 },
      { id: "beta", x: 500, y: 0, l: 250, h: 180 },
      { id: "refus", x: 0, y: 200, l: 250, h: 180 },
      { id: "lien", x: 500, y: 200, l: 250, h: 180 },
      { id: "compte", x: 0, y: 400, l: 250, h: 180 },
      { id: "sans-accord", x: 500, y: 400, l: 250, h: 180 },
      { id: "lent", x: 0, y: 600, l: 250, h: 180 },
      { id: "echec", x: 500, y: 600, l: 250, h: 180 },
      { id: "veille", x: 0, y: 800, l: 250, h: 180 },
      { id: "retrait", x: 500, y: 800, l: 250, h: 180 },
    ]);
    // A test notification is a file, never a macOS bubble.
    w = await launchWebAiOs({ dataDir, env: { WEBAIOS_TEST_NOTIFICATIONS: notifications } });
    m = w.marionette;
    await m.setContext("chrome");
    await waitReady(m);
  });
  afterAll(async () => {
    await w?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("the screen without a tab shows the folder's widgets, served by resource://webaios-widget-", async () => {
    const titles = await wait(
      () => inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="titre-widget"]')].map((e) => e.textContent);`),
      (ts) => ts.length === 10,
      "les dix widgets",
      15_000,
    );
    expect(titles).toEqual(["Alpha", "Beta", "Refus", "Lien", "Compte", "Sans accord", "Lent", "Échec", "Veille", "Retrait"]);
    const src = await inUi(m, `return doc.querySelector('[data-testid="widget-alpha"] iframe')?.getAttribute("src") ?? "";`);
    expect(src).toMatch(/^resource:\/\/webaios-widget-alpha\/affichage-\d+\.html$/);
    // The frame is isolated: the widget's document does not have the sidebar's system principal (opaque origin, sandbox).
    const system = await waitUi<string>(
      m,
      `const d = doc.querySelector('[data-testid="widget-alpha"] iframe')?.contentDocument; return d ? String(d.nodePrincipal.isSystemPrincipal) : null;`,
      [],
      15_000,
    );
    expect(system).toBe("false");
  });

  it("a widget added by the agent appears without restarting", async () => {
    await writeWidget(dataDir, "nouveau", { nom: "Nouveau", affichage: DISPLAY("nouveau") });
    const titles = await wait(
      () => inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="titre-widget"]')].map((e) => e.textContent);`),
      (ts) => ts.includes("Nouveau"),
      "le widget ajouté",
    );
    expect(titles).toContain("Nouveau");
  });

  it("a tall home page keeps the favourites whole, above the widgets", async () => {
    const s = await dispatch(m, { type: "ouvrirOnglet", fenetreId: (await state(m)).fenetres[0]!.id, url: "https://exemple.invalid/favori" });
    const tab = Object.entries(s.onglets).find(([, o]) => o.url.includes("/favori"))![0];
    await dispatch(m, { type: "ajouterEssentiel", id: tab });
    await dispatch(m, { type: "fermerOnglet", id: tab });
    const r = await waitUi<{ bas: number; accueil: number; defile: boolean }>(
      m,
      `const f = doc.querySelector('[data-testid="essentiels-page-vide"] [data-testid^="favori-"]');
       const a = doc.querySelector('[data-testid="accueil"]');
       if (!f || !a?.querySelector('[data-testid="widget-retrait"]')) return null;
       const p = a.parentElement;
       return { bas: f.getBoundingClientRect().bottom, accueil: a.getBoundingClientRect().top, defile: p.scrollHeight > p.clientHeight };`,
    );
    expect(r.defile).toBe(true);
    expect(r.bas).toBeLessThanOrEqual(r.accueil);
  });

  it("dragging a widget moves no other", async () => {
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
    expect(alpha.x + alpha.l).toBeLessThanOrEqual(1000);
    // Alpha goes beyond bêta: it cannot be dropped on another widget, but the drag flies over it.
    expect(alpha.x).toBe(750);
    expect(beta).toEqual(betaBefore);
  });

  it("resizing stays within bounds and does not overflow on the right", async () => {
    // Declared max: 6 units wide (500 ‰) and 4 rows (360 px).
    await drag(m, '[data-testid="widget-beta"] [data-testid="poignee-taille"]', 600, 300);
    const after = await wait(
      () => readLayout(dataDir).catch(() => [] as PlacementTest[]),
      (ps) => {
        const b = ps.find((p) => p.id === "beta");
        return !!b && (b.l > 250 || b.h > 180);
      },
      "l'écriture du redimensionnement",
    );
    const beta = after.find((p) => p.id === "beta")!;
    expect(beta.l).toBeGreaterThanOrEqual(167); // min: 2 units
    expect(beta.l).toBeLessThanOrEqual(500); // max: 6 units
    expect(beta.h).toBeLessThanOrEqual(360);
    expect(beta.x + beta.l).toBeLessThanOrEqual(1000);
  });

  it("a <link> in the display is replaced by DISPLAY_DENIED", async () => {
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-refus"] iframe');`, [], 15_000);
    const text = await wait(() => frameText(m, "refus"), (t) => t.includes("Affichage refusé"), "le refus de l'affichage");
    expect(text).toContain("Affichage refusé");
    expect(text).not.toContain("jamais");
  });

  it("the agent's theme changes the home's colors; an invalid theme goes back to the default", async () => {
    const background = () => inUi<string>(m, `return ui.getComputedStyle(doc.querySelector('[data-testid="accueil"]')).backgroundColor;`);
    const defaultValue = await background();
    await writeFile(path.join(HOME(dataDir), "theme.json"), JSON.stringify({ version: 1, fond: "#101014", accent: "#8b7cf6", rayon: 4 }));
    await wait(background, (c) => c === "rgb(16, 16, 20)", "le fond du thème");
    await writeFile(path.join(HOME(dataDir), "theme.json"), "{ pas du json");
    await wait(background, (c) => c === defaultValue, "le retour au thème par défaut");
  });

  it("a widget link only opens after a real press, never at load nor by a simulated click", async () => {
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-lien"] iframe')?.contentDocument?.getElementById("go");`, [], 15_000);
    const urls = async () => Object.values((await state(m)).onglets).map((o) => o.url);
    // The load's send: no gesture, no tab.
    await new Promise((r) => setTimeout(r, 2000));
    expect((await urls()).filter((u) => u.includes("exemple.invalid"))).toEqual([]);
    // A click simulated by the script: isTrusted false, no gesture, no tab.
    await inUi(m, `doc.querySelector('[data-testid="widget-lien"] iframe').contentDocument.getElementById("go").click();`);
    await new Promise((r) => setTimeout(r, 2000));
    expect((await urls()).filter((u) => u.includes("exemple.invalid"))).toEqual([]);
    // A real press in the frame: the actor signals the gesture, the link opens.
    await inUi(
      m,
      `const f = doc.querySelector('[data-testid="widget-lien"] iframe');
       f.scrollIntoView({ block: "center" });
       await new Promise((r) => requestAnimationFrame(r));
       const b = f.contentDocument.getElementById("go");
       const r = f.getBoundingClientRect(), q = b.getBoundingClientRect();
       const x = r.left + q.left + q.width / 2, y = r.top + q.top + q.height / 2;
       ui.synthesizeMouseEvent("mousedown", x, y, { button: 0, clickCount: 1 });
       ui.synthesizeMouseEvent("mouseup", x, y, { button: 0, clickCount: 1 });`,
    );
    await wait(urls, (us) => us.includes("https://exemple.invalid/clic"), "l'ouverture du lien");
    expect((await urls()).filter((u) => u.includes("/auto"))).toEqual([]);
    // The opening activated a tab: the home is no longer mounted (EmptyPage). We close it again for what follows.
    const tab = Object.entries((await state(m)).onglets).find(([, o]) => o.url.includes("exemple.invalid/clic"))?.[0];
    expect(tab).toBeDefined();
    await dispatch(m, { type: "fermerOnglet", id: tab! });
    await waitUi(m, `return !!doc.querySelector('[data-testid="accueil"]') && !!doc.querySelector('[data-testid="widget-alpha"]');`, [], 15_000);
  });

  it("a widget display opens no Firefox window", async () => {
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-alpha"] iframe')?.contentDocument;`, [], 15_000);
    await waitWindowCount(m, 1);
    await new Promise((r) => setTimeout(r, 500));
    expect(await waitWindowCount(m, 1)).toHaveLength(1);
    // No top-level <browser> loads the resource:// substitution: it is a frame of the sidebar.
    const top = await waitFor<number>(m, `return [...gBrowser.browsers].filter((b) => b.currentURI?.spec?.startsWith("resource://webaios-widget-")).length;`, (n) => n === 0);
    expect(top).toBe(0);
  });

  it("the grant card: Autoriser keeps the chosen profile and starts the harvest with the account", async () => {
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-compte"] [data-testid="bandeau-accord"]');`, [], 15_000);
    expect(await widgetText(m, "compte")).toContain("exemple.invalid");
    // Nothing is read with the account until the user has granted.
    expect(existsSync(DATA(dataDir, "compte"))).toBe(false);
    await click(m, '[data-testid="widget-compte"] [data-testid="bandeau-accord"] button', { text: "Autoriser…" });
    const card = await waitUi<string>(m, `const c = doc.querySelector('[data-testid="carte-accord"]'); return c ? c.textContent : "";`);
    expect(card).toContain("exemple.invalid");
    expect(card).toContain("ne contactera aucun autre site");
    // The active space's profile (the default profile) is ticked.
    const profiles = await waitUi<[string, boolean][]>(
      m,
      `const rs = [...doc.querySelectorAll('[data-testid="carte-accord"] input[type="radio"]')];
       return rs.length ? rs.map((r) => [r.value, r.checked]) : null;`,
    );
    expect(profiles).toEqual([["defaut", true]]);
    await click(m, '[data-testid="carte-accord"] button', { text: "Autoriser" });
    // The grant names the shown domains and the chosen profile; the harvest starts and its data reaches the frame.
    const grant = await wait(() => readGrants(dataDir), (a) => a.compte?.profil === "defaut", "l'écriture de l'accord");
    expect(grant.compte).toEqual({ domaines: ["exemple.invalid"], publiques: [], profil: "defaut" });
    await wait(() => (existsSync(DATA(dataDir, "compte")) ? readJson<unknown>(DATA(dataDir, "compte")) : Promise.resolve(null)), (d) => d !== null, "les données de la récolte");
    expect(await readJson(DATA(dataDir, "compte"))).toEqual({ vu: "compte" });
    await wait(() => dataText(m, "compte"), (t) => t === '{"vu":"compte"}', "les données dans le cadre");
    expect(await waitUi(m, `return !doc.querySelector('[data-testid="widget-compte"] [data-testid="bandeau-accord"]');`)).toBe(true);
  });

  it("Refuser does not come back: the banner stays hidden after the page is reread", async () => {
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-sans-accord"] [data-testid="bandeau-accord"]');`, [], 15_000);
    // A grant and data from before (as after another profile): the denial must really erase them.
    await writeJson(GRANTS(dataDir), { ...(await readGrants(dataDir)), "sans-accord": { domaines: ["exemple.invalid"], publiques: [], profil: "defaut" } });
    await writeJson(DATA(dataDir, "sans-accord"), { secret: "du compte" });
    await click(m, '[data-testid="widget-sans-accord"] [data-testid="bandeau-accord"] button', { text: "Refuser" });
    expect(await waitUi(m, `return !doc.querySelector('[data-testid="widget-sans-accord"] [data-testid="bandeau-accord"]');`)).toBe(true);
    // An added widget forces a reread (accueil.change): the denial holds for the session, the banner does not come back.
    await writeWidget(dataDir, "temoin", { nom: "Témoin", affichage: DISPLAY("témoin") });
    await wait(
      () => inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="titre-widget"]')].map((e) => e.textContent);`),
      (ts) => ts.includes("Témoin"),
      "la relecture après le refus",
    );
    expect(await inUi<boolean>(m, `return !!doc.querySelector('[data-testid="widget-sans-accord"] [data-testid="bandeau-accord"]');`)).toBe(false);
    await wait(() => readGrants(dataDir), (a) => a["sans-accord"] === undefined, "le retrait de l'accord refusé");
    await wait(async () => existsSync(DATA(dataDir, "sans-accord")), (present) => !present, "le retrait des données du refus");
    expect(await readJson<{ statut: string }>(STATE(dataDir, "sans-accord"))).toMatchObject({ statut: "accord-requis" });
  });

  it("a grant that names an invalid profile asks again: the harvest refuses it, the grant and its data go away", async () => {
    // The grant names a sign-in profile; a profile absent from the session makes it unusable. (A profile that
    // becomes private only asks again at the widget's next scheduled harvest: see the README's limit.)
    const declaration = await readJson<Record<string, unknown>>(path.join(HOME(dataDir), "widgets", "compte", "widget.json"));
    await writeJson(path.join(HOME(dataDir), "widgets", "compte", "widget.json"), { ...declaration, config: { lire: true, url: "https://exemple.invalid/x" } });
    await writeJson(GRANTS(dataDir), { ...(await readGrants(dataDir)), compte: { domaines: ["exemple.invalid"], publiques: [], profil: "absent" } });
    await harvest(m, "compte");
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-compte"] [data-testid="bandeau-accord"]');`, [], 20_000);
    expect((await readGrants(dataDir)).compte).toBeUndefined();
    expect(existsSync(DATA(dataDir, "compte"))).toBe(false);
    expect(await readJson<{ statut: string }>(STATE(dataDir, "compte"))).toMatchObject({ statut: "accord-requis" });
    // The new request offers a profile again.
    await click(m, '[data-testid="widget-compte"] [data-testid="bandeau-accord"] button', { text: "Autoriser…" });
    const profiles = await waitUi<[string, boolean][]>(m, `const rs = [...doc.querySelectorAll('[data-testid="carte-accord"] input[type="radio"]')]; return rs.length ? rs.map((r) => [r.value, r.checked]) : null;`);
    expect(profiles.map(([id]) => id)).toContain("defaut");
    await click(m, '[data-testid="carte-accord"] button', { text: "Annuler" });
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
  });

  it("a failed harvest says so and leaves no data", async () => {
    const text = await wait(() => widgetText(m, "echec"), (t) => t.includes("échec du") && t.includes("boum"), "l'échec de la récolte", 20_000);
    expect(text).toContain("échec du");
    expect(existsSync(DATA(dataDir, "echec"))).toBe(false);
    expect(await readJson<{ statut: string; erreur: string }>(STATE(dataDir, "echec"))).toMatchObject({ statut: "erreur", erreur: "boum" });
  });

  it("a news harvest writes its notification into WEBAIOS_TEST_NOTIFICATIONS", async () => {
    const lignes = await wait(
      async () => ((existsSync(notifications) ? (await readFile(notifications, "utf8")).trim().split("\n").filter(Boolean) : []).map((l) => JSON.parse(l) as { titre: string; texte: string })),
      (ls) => ls.some((n) => n.titre === "Veille"),
      "la notification de nouveautés",
      20_000,
    );
    expect(lignes).toContainEqual({ titre: "Veille", texte: "2 nouveaux éléments" });
  });

  it("Retirer: the folder goes into .corbeille, the grant and the data are erased", async () => {
    // The widget has a grant and data before the removal.
    expect(existsSync(path.join(HOME(dataDir), "widgets", "retrait"))).toBe(true);
    expect((await readGrants(dataDir)).retrait).toBeDefined();
    expect(existsSync(DATA(dataDir, "retrait"))).toBe(true);
    await click(m, '[data-testid="widget-retrait"] button[aria-label="Options du widget"]');
    await click(m, '[role="menuitem"]', { text: "Retirer" });
    const confirmation = await waitUi<string>(m, `const d = doc.querySelector('[data-testid="confirmation-retrait"]'); return d ? d.textContent : "";`);
    expect(confirmation).toContain("Retirer « Retrait » de la page d'accueil ?");
    await click(m, '[data-testid="confirmation-retrait"] button', { text: "Retirer" });
    await waitUi(m, `return !doc.querySelector('[data-testid="widget-retrait"]');`, [], 15_000);
    const trash = await wait(
      () => readdir(path.join(HOME(dataDir), ".corbeille")).catch(() => [] as string[]),
      (names) => names.some((n) => n.startsWith("retrait-")),
      "le dossier du widget dans la corbeille",
    );
    expect(trash.some((n) => n.startsWith("retrait-"))).toBe(true);
    expect(existsSync(path.join(HOME(dataDir), "widgets", "retrait"))).toBe(false);
    // The host removes the grant then the data: both together.
    await wait(
      async () => ({ accord: (await readGrants(dataDir)).retrait, donnees: existsSync(DATA(dataDir, "retrait")) }),
      (v) => v.accord === undefined && !v.donnees,
      "le retrait de l'accord et des données",
    );
  });

  it("host stopped: the actions stay without effect and the page stays displayed", async () => {
    await m.execute(`return (async () => { await window.webaiosWindow.store.agent.stop(); return true; })();`);
    await waitFor<number | null>(m, `return window.webaiosWindow.store.agent.pid;`, (pid) => pid === null);
    await harvest(m, "veille");
    const text = await wait(() => widgetText(m, "veille"), (t) => t.includes("Sans effet pour l'instant"), "l'avertissement sans effet", 12_000);
    expect(text).toContain("le service des widgets ne répond pas");
    // The widgets stay displayed, frames included.
    expect(await inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="titre-widget"]')].map((e) => e.textContent);`)).toContain("Veille");
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-veille"] iframe');`);
  });

});

// Widgets with no harvest: nothing the new kernel does writes, so only its start can make the page read again.
describe("the home page after a host restart", () => {
  let dataDir: string;
  let w: LaunchedWebAiOs;
  let m: Marionette;
  const titles = () => inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="titre-widget"]')].map((e) => e.textContent);`);

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-accueil-relance-"));
    await mkdir(path.join(HOME(dataDir), "widgets"), { recursive: true });
    await writeWidget(dataDir, "alpha", { nom: "Alpha", affichage: DISPLAY("alpha") });
    w = await launchWebAiOs({ dataDir });
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
    await m.execute(`return (async () => { await window.webaiosWindow.store.agent.stop(); return true; })();`);
    await waitFor<number | null>(m, `return window.webaiosWindow.store.agent.pid;`, (pid) => pid === null);
    await writeWidget(dataDir, "pendant-arret", { nom: "Pendant l'arrêt", affichage: DISPLAY("pendant-arret") });
    await m.execute(`return (async () => { await window.webaiosWindow.store.agent.ensure(); return true; })();`);
    expect(await wait(titles, (ts) => ts.includes("Pendant l'arrêt"), "the widget added while the host was stopped", 20_000)).toContain("Alpha");
  });
});

describe("the home page, workshop stopped", () => {
  let dataDir: string;
  let w: LaunchedWebAiOs;
  let m: Marionette;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-accueil-atelier-"));
    await mkdir(path.join(HOME(dataDir), "widgets"), { recursive: true });
    await writeWidget(dataDir, "veille", {
      nom: "Veille",
      affichage: DISPLAY_DATA,
      declaration: { recolte: { minutes: 60 }, sources: { compte: [], publiques: [], web: false } },
    });
    await writeHarvest(dataDir, "veille", `export default async () => [{ url: "https://exemple.invalid/a" }];`);
    // Data from a previous harvest, and a due state: the launch check must keep them.
    await writeJson(DATA(dataDir, "veille"), { vieux: true });
    await writeJson(STATE(dataDir, "veille"), { statut: "ok", derniereMaj: "2026-01-01T00:00:00.000Z", derniereTentative: "2026-01-01T00:00:00.000Z" });
    await writeLayout(dataDir, [{ id: "veille", x: 0, y: 0, l: 250, h: 180 }]);
    w = await launchWebAiOs({ dataDir, env: { FAUX_DOCKER_ABSENT: "1" } });
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
    expect(await readJson(DATA(dataDir, "veille"))).toEqual({ vieux: true });
    // « Mettre à jour maintenant » launches nothing either: nothing changes, the interface says so after its delay.
    await harvest(m, "veille");
    await wait(() => widgetText(m, "veille"), (t) => t.includes("Sans effet pour l'instant"), "l'action sans effet", 12_000);
    expect(await readJson<{ statut: string }>(STATE(dataDir, "veille"))).toMatchObject({ statut: "atelier-arrete" });
    expect(await readJson(DATA(dataDir, "veille"))).toEqual({ vieux: true });
    // The page stays displayed.
    expect(await inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="titre-widget"]')].map((e) => e.textContent);`)).toEqual(["Veille"]);
  });
});
