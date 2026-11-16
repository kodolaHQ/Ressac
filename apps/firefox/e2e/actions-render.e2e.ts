import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Action } from "../shared/api";
import { fallbackLayout } from "../../../packages/kernel/src/pages/fallback";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BARS, EXECUTION, openActionPage, probe, startActionServers, tid, uiQueries, writeActionWithResult, writeComponent, type Block } from "./actions";
import { dispatch, state, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, missingApi, waitUi } from "./ui";

// An action's page and its built-in components: served from a result the
// test writes, with no container and no Gemma. Reopening a page launches nothing. Result images go through the test hook
// (RESSAC_TEST_ACTION_IMAGES): `https://<host><path>` is asked from the local image server, which notes each request.

const TASKS = [
  { nom: "Alpha", priorite: 9, etat: "ouvert", url: "https://exemple.invalide/alpha", image: "https://exemple.invalide/a.png" },
  { nom: "Bravo", priorite: 10, etat: "fermé" },
  { nom: "Charlie", priorite: 2, etat: "ouvert" },
];
const DEMO_BLOCKS: Block[] = [
  { component: "title", props: { text: "<b>gras</b>" } },
  { component: "paragraph", props: { text: "Trois tâches cette semaine." } },
  { component: "callout", props: { level: "warning", title: "À voir", items: "taches", field: "nom" } },
  { component: "figure", props: { value: "count(taches)", label: "Tâches" } },
  { component: "figures", props: { figures: [{ value: "count(taches)", label: "En tout" }, { value: "resume.ouvertes", label: "Ouvertes" }] } },
  { component: "list", props: { items: "taches", title: "nom", subtitle: "etat", link: "url" } },
  { component: "cards", props: { items: "taches", title: "nom", value: "priorite", tags: "etat" } },
  { component: "table", props: { items: "taches", columns: [{ field: "nom", label: "Nom" }, { field: "priorite", label: "Priorité" }] } },
  { component: "fields", props: { object: "resume" } },
  { component: "tags", props: { items: "taches", field: "etat" } },
  { component: "link", props: { object: "resume", url: "source", text: "La source" } },
  { component: "group", props: { title: "Détails" }, blocks: [{ component: "paragraph", props: { text: "Dans le groupe." } }] },
  { component: "columns", props: {}, left: [{ component: "paragraph", props: { text: "À gauche." } }], right: [{ component: "paragraph", props: { text: "À droite." } }] },
];
const DEMO_RESULTS = { taches: TASKS, resume: { ouvertes: 2, semaine: "44", source: "https://exemple.invalide/source" } };

/** The hostile images of Review Focus 3, and an ordinary one as the control. */
const PHOTOS = {
  ok: "https://img.exemple/ok.png",
  // A 302 to http://127.0.0.1:<port>/secret.
  redirect: "https://img.exemple/x/r",
  html: "https://img.exemple/html.png",
  big: "https://img.exemple/big.png",
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let servers: Awaited<ReturnType<typeof startActionServers>>;
let w: LaunchedRessac;
let m: Marionette;
let q: ReturnType<typeof uiQueries>;
/** What reached the probe component's server: requests and TCP connections. */
const reached = { requests: [] as string[], connections: 0 };
let probeServer: Server;

/** A component that sends height `px` on each message, and tries a link (components open none). */
const sized = (px: number) => `<!doctype html><meta charset="utf-8"><script>
  addEventListener("message", (e) => {
    if (e.data?.type !== "component") return;
    try { ressacOpen("https://exemple.invalide/from-component"); } catch {}
    parent.postMessage({ type: "height", px: ${px} }, "*");
  });
</script>`;
const FRAME = tid("component-frame");
const closeTabs = async () => {
  for (const id of Object.keys((await state(m)).tabs)) await dispatch(m, { type: "closeTab", id } as Action);
};

beforeAll(async () => {
  // A permitted link opens a tab: exemple.invalide resolves to the machine, so no lookup leaves it.
  servers = await startActionServers();
  w = await launchRessac({ env: { RESSAC_TEST_ACTION_IMAGES: servers.images.url }, prefs: { "network.dns.localDomains": "exemple.invalide" } });
  m = w.marionette;
  q = uiQueries(m);
  await m.setContext("chrome");
  await waitReady(m);
  await writeActionWithResult(w.dataDir, "demo", { name: "Démo", results: DEMO_RESULTS, blocks: DEMO_BLOCKS, fallback: true });
  await writeActionWithResult(w.dataDir, "simple", { name: "Simple", results: DEMO_RESULTS, blocks: DEMO_BLOCKS });
  const cards: Block[] = [{ component: "cards", props: { items: "photos", title: "titre", image: "photo" } }];
  await writeActionWithResult(w.dataDir, "courrier", {
    name: "Courrier",
    account: ["mail.exemple.fr"],
    results: { photos: [{ titre: "Bonjour", photo: "https://img.exemple/photo.png" }] },
    blocks: cards,
  });
  const many = Array.from({ length: 40 }, (_, i) => ({ titre: `n${i}`, photo: `https://img.exemple/n${i}.png` }));
  await writeActionWithResult(w.dataDir, "lazy", { name: "Lazy", results: { photos: many }, blocks: cards });
  probeServer = createServer((req, res) => (reached.requests.push(req.url ?? "/"), res.writeHead(200).end("x")));
  probeServer.on("connection", () => reached.connections++);
  await new Promise<void>((ok) => probeServer.listen(0, "127.0.0.1", ok));
  const probeBase = `http://127.0.0.1:${(probeServer.address() as AddressInfo).port}`;
  const properties = { valeurs: { kind: "reference", description: "Liste de { libelle, valeur }", required: true }, titre: { kind: "text", description: "Titre du graphique" } };
  await writeComponent(w.dataDir, "barres", { description: "Graphique en barres", properties: properties, html: BARS });
  await writeComponent(w.dataDir, "ecrit", { description: "Hauteur fixe", properties: {}, html: sized(300) });
  await writeComponent(w.dataDir, "sonde", { description: "Sonde", properties: {}, html: probe(probeBase) });
  // Eight bars: taller than the 150 px the frame starts with, so the height it asks for shows.
  const sales = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche", "Total"].map((label, i) => ({ libelle: label, valeur: i + 1 }));
  await writeActionWithResult(w.dataDir, "graphe", {
    name: "Graphe",
    results: { ventes: sales },
    blocks: [
      { component: "title", props: { text: "Priorités" } },
      { component: "barres", props: { valeurs: "ventes", titre: "Ventes" } },
      { component: "absent", props: {} },
      { component: "paragraph", props: { text: "Après le composant." } },
    ],
  });
  await writeActionWithResult(w.dataDir, "ecrit", { name: "Ecrit", results: { n: 1 }, blocks: [{ component: "title", props: { text: "Ecrit" } }, { component: "ecrit", props: {} }] });
  await writeActionWithResult(w.dataDir, "sonde", { name: "Sonde", results: { n: 1 }, blocks: [{ component: "title", props: { text: "Sonde" } }, { component: "sonde", props: {} }] });
  // The gallery bricks: a highlight with its photo, cards with warnings.
  await writeActionWithResult(w.dataDir, "galerie", {
    name: "Galerie",
    results: { best: { nom: "Yuba", prix: "1 850 €", photo: "https://img.exemple/ok.png" }, autres: [{ nom: "Babboe", prix: "1 400 €", photo: "https://img.exemple/ok.png", alertes: ["batterie 70 %", "pneus"] }, { nom: "Tern", prix: "1 990 €", alertes: [] }] },
    blocks: [
      { component: "highlight", props: { object: "best", label: "Meilleure affaire", title: "nom", value: "prix", image: "photo" } },
      { component: "cards", props: { items: "autres", title: "nom", value: "prix", image: "photo", warnings: "alertes" } },
    ],
  });
  // A head with six figure pills: the title keeps its column.
  await writeActionWithResult(w.dataDir, "entete", {
    name: "Entete",
    results: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
    blocks: [
      { component: "title", props: { text: "Un titre assez long pour se faire écraser par les chiffres" } },
      { component: "paragraph", props: { text: "Une phrase sous le titre." } },
      { component: "figures", props: { figures: ["a", "b", "c", "d", "e", "f"].map((k) => ({ value: k, label: `Chiffre ${k}` })) } },
    ],
  });
  await writeActionWithResult(w.dataDir, "images", { name: "Images", results: { photos: Object.entries(PHOTOS).map(([title, snapshot]) => ({ titre: title, photo: snapshot })) }, blocks: cards });
}, 60_000);

afterAll(async () => {
  expect(await missingApi(m)).toEqual([]);
  await w?.close();
  await servers?.close();
  await new Promise((ok) => (probeServer?.closeAllConnections(), probeServer?.close(ok)));
});

describe("action page rendering", () => {
  // actions.spec.ts:102
  it('each built-in component shows (data-testid="block-<name>")', async () => {
    await openActionPage(m, "demo", "Démo");
    const page = tid("page-render");
    for (const name of ["title", "paragraph", "callout", "figure", "figures", "list", "cards", "table", "fields", "labels", "link", "group", "columns"]) {
      expect(await inUi(m, "const e = doc.querySelector(arguments[0]); return !!e && e.getBoundingClientRect().height > 0;", [`${page} ${tid(`block-${name}`)}`]), name).toBe(true);
    }
    // A fallback layout: the mention comes first.
    expect(await q.text(tid("fallback-mention"))).toBe("mise en page simple");
    expect(await q.text(tid("block-figure"))).toContain("3");
    expect(await q.text(tid("block-callout"))).toContain("Charlie");
    expect(await q.text(tid("block-fields"))).toContain("semaine");
    expect(await q.text(tid("block-group"))).toContain("Dans le groupe.");
    expect(await q.text(tid("block-columns"))).toContain("À droite.");
    // The colours follow the theme (Firefox's system theme pref stands in for Playwright's emulateMedia).
    const background = () => inUi<string>(m, "return ui.getComputedStyle(doc.querySelector(arguments[0])).backgroundColor;", [tid("block-callout")]);
    await m.execute("Services.prefs.setIntPref('ui.systemUsesDarkTheme', 1);");
    try {
      await new Promise((r) => setTimeout(r, 300));
      const dark = await background();
      await m.execute("Services.prefs.setIntPref('ui.systemUsesDarkTheme', 0);");
      await waitUi(m, "return ui.getComputedStyle(doc.querySelector(arguments[0])).backgroundColor !== arguments[1];", [tid("block-callout"), dark]);
    } finally {
      await m.execute("Services.prefs.clearUserPref('ui.systemUsesDarkTheme');");
    }
  });

  it("a highlight and card warnings show (gallery bricks)", async () => {
    await openActionPage(m, "galerie", "Galerie");
    await q.waitContains(tid("block-highlight"), "Meilleure affaire");
    expect(await q.text(tid("block-highlight"))).toContain("1 850 €");
    await waitUi(m, "return !!doc.querySelector(arguments[0]);", [`${tid("block-highlight")} img.pa-image`], 15_000);
    const warnings = await inUi<string[]>(m, "return [...doc.querySelectorAll(arguments[0])].map((e) => e.textContent);", [`${tid("block-cards")} .pa-warning`]);
    expect(warnings).toEqual(["batterie 70 %", "pneus"]);
    // The price sits on the photo when there is one, under the title otherwise.
    expect(await q.count(`${tid("block-cards")} .pa-photo .value`)).toBe(1);
    expect(await q.count(`${tid("block-cards")} .body .value`)).toBe(1);
    // Images appear on the spring.
    expect(await inUi(m, "return doc.defaultView.getComputedStyle(doc.querySelector(arguments[0])).animationName;", [`${tid("block-highlight")} img.pa-image`])).toBe("ressac-rise");
  });

  it("figure pills in the head leave the title at least 40 % of the row", async () => {
    await openActionPage(m, "entete", "Entete");
    await waitUi(m, "return !!doc.querySelector('.pa-head .pa-figures');", [], 15_000);
    const share = await inUi<number>(m, "return doc.querySelector('.pa-head-text').getBoundingClientRect().width / doc.querySelector('.pa-head').getBoundingClientRect().width;", []);
    expect(share).toBeGreaterThan(0.4);
  });

  // actions.spec.ts:131
  it("a « <b>gras</b> » title shows as text", async () => {
    await openActionPage(m, "simple", "Simple");
    await q.waitText(tid("block-title"), "<b>gras</b>");
    expect(await q.count(`${tid("block-title")} b`)).toBe(0);
    expect(await q.count(tid("fallback-mention"))).toBe(0);
  });

  // actions.spec.ts:147
  it("clicking the Priorité header sorts the table", async () => {
    await openActionPage(m, "simple", "Simple");
    const column = () => inUi<string[]>(m, "return [...doc.querySelectorAll(arguments[0])].map((e) => e.textContent);", [`${tid("block-table")} tbody tr td:nth-child(2)`]);
    const sortOf = (label: string) =>
      inUi<string | null>(m, "return [...doc.querySelectorAll(arguments[0])].find((th) => th.textContent.includes(arguments[1]))?.getAttribute('aria-sort') ?? null;", [`${tid("block-table")} th`, label]);
    const waitColumn = (v: string[]) => waitUi(m, "return JSON.stringify([...doc.querySelectorAll(arguments[0])].map((e) => e.textContent)) === arguments[1];", [`${tid("block-table")} tbody tr td:nth-child(2)`, JSON.stringify(v)]);
    expect(await column()).toEqual(["9", "10", "2"]);
    await click(m, `${tid("block-table")} th button`, { text: "Priorité" });
    await waitColumn(["2", "9", "10"]);
    expect(await sortOf("Priorité")).toBe("ascending");
    await click(m, `${tid("block-table")} th button`, { text: "Priorité" });
    await waitColumn(["10", "9", "2"]);
    expect(await sortOf("Priorité")).toBe("descending");
    expect(await sortOf("Nom")).toBe("none");
  });

  // actions.spec.ts:170
  it("a link without url is not clickable; an allowed link opens a tab", async () => {
    await openActionPage(m, "simple", "Simple");
    const list = tid("block-list");
    expect(await q.text(list)).toContain("Bravo");
    expect(await inUi(m, "return [...doc.querySelectorAll(arguments[0])].some((b) => b.textContent.includes('Bravo'));", [`${list} button`])).toBe(false);
    expect(await q.count(`${list} a`)).toBe(0);
    const urls = async () => Object.values((await state(m)).tabs).map((o) => o.url);
    expect((await urls()).some((u) => u.includes("exemple.invalide/alpha"))).toBe(false);
    await click(m, `${list} button`, { text: "Alpha" });
    const deadline = Date.now() + 10_000;
    while (!(await urls()).some((u) => u.includes("exemple.invalide/alpha")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect((await urls()).some((u) => u.includes("exemple.invalide/alpha"))).toBe(true);
  });

  // actions.spec.ts:190
  it("account action: the image is a neutral placeholder and no request reaches the test server", async () => {
    servers.reset();
    await openActionPage(m, "courrier", "Courrier");
    const cards = tid("block-cards");
    await q.waitContains(cards, "Bonjour");
    await q.waitCount(`${cards} ${tid("neutral-image")}`, 1);
    expect(await q.count(`${cards} img`)).toBe(0);
    // Asked directly, the host refuses it too: an action with an account never loads an image.
    expect(await inUi(m, "return ui.ressac.actions.image('courrier', arguments[0], arguments[1]);", [EXECUTION, "https://img.exemple/photo.png"])).toBeNull();
    await sleep(500);
    expect(servers.images.seen).toEqual([]);
  });

  // Review Focus 3
  it("a result image that redirects to 127.0.0.1, is not an image or is too big stays neutral", async () => {
    servers.reset();
    await openActionPage(m, "images", "Images");
    const cards = tid("block-cards");
    // The control: an ordinary image shows, as a data: URL.
    await q.waitCount(`${cards} img.pa-image`, 1, 15_000);
    expect(await inUi<string>(m, "return doc.querySelector(arguments[0]).src;", [`${cards} img.pa-image`])).toMatch(/^data:image\/png;base64,/);
    const paths = () => servers.images.seen.map((s) => s.path).sort();
    const asked = ["/img.exemple/big.png", "/img.exemple/html.png", "/img.exemple/ok.png", "/img.exemple/x/r"];
    for (const deadline = Date.now() + 15_000; JSON.stringify(paths()) !== JSON.stringify(asked); await sleep(100))
      if (Date.now() > deadline) throw new Error(`images asked: ${JSON.stringify(paths())}`);
    await q.waitCount(`${cards} ${tid("neutral-image")}`, 3);
    expect(await q.count(`${cards} img`)).toBe(1);
    // An address absent from the results: refused by the host, never fetched.
    expect(await inUi(m, "return ui.ressac.actions.image('images', arguments[0], arguments[1]);", [EXECUTION, "https://img.exemple/absent.png"])).toBeNull();
    await sleep(500);
    // The redirect's target (/secret) got no request; none carried a cookie or a referrer.
    expect(paths()).toEqual(asked);
    expect(servers.images.seen.every((s) => s.cookie === null && s.referer === null)).toBe(true);
  });

  // loading="lazy": an image far below the view is asked only once scrolled near.
  it("an offscreen result image is not requested until it is scrolled near", async () => {
    servers.reset();
    await openActionPage(m, "lazy", "Lazy");
    const cards = tid("block-cards");
    await waitUi(m, "return doc.querySelectorAll(arguments[0]).length > 0;", [`${cards} img.pa-image`], 15_000);
    const n = await q.count(`${cards} .pa-card`);
    const last = `/img.exemple/n${n - 1}.png`;
    await sleep(1000);
    const before = servers.images.seen.map((s) => s.path);
    expect(before.length).toBeLessThan(n);
    expect(before).not.toContain(last);
    await inUi(m, "const d = doc.querySelector(arguments[0]); d.scrollTop = d.scrollHeight;", [tid("page-action")]);
    for (const deadline = Date.now() + 10_000; !servers.images.seen.some((s) => s.path === last); await sleep(100))
      if (Date.now() > deadline) throw new Error(`not asked after the scroll: ${last}`);
    await waitUi(m, "const c = [...doc.querySelectorAll(arguments[0])].at(-1); return !!c?.querySelector('img.pa-image');", [`${cards} .pa-card`]);
    // Each image asked once: a page read again does not ask again.
    const paths = servers.images.seen.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  // actions.spec.ts:232, with AGENTS.md:660's « barres » example as the component
  it("agent component: its height follows its message; a missing component shows « Composant indisponible : … » and the rest of the page shows", async () => {
    await m.execute("Services.prefs.setIntPref('ui.systemUsesDarkTheme', 1);");
    try {
      await openActionPage(m, "graphe", "Graphe");
      expect(await inUi(m, "return doc.querySelector(arguments[0]).getAttribute('sandbox');", [FRAME])).toBe("allow-scripts");
      await waitUi(m, "return doc.querySelector(arguments[0])?.contentDocument?.querySelectorAll('rect').length === 8;", [FRAME], 15_000);
      const frame = await inUi<{ src: string; uri: string; title: string; body: string; texts: string[] }>(
        m,
        "const f = doc.querySelector(arguments[0]); const d = f.contentDocument; return { src: f.src, uri: d.documentURI, title: d.getElementById('titre').textContent, body: d.body.className, texts: [...d.querySelectorAll('text')].map((t) => t.textContent) };",
        [FRAME],
      );
      expect(frame.src).toMatch(/^resource:\/\/ressac-component-barres\/component-\d+-\d+\.html$/);
      expect(frame.uri).toBe(frame.src);
      expect(frame).toMatchObject({ title: "Ventes", body: "sombre" });
      expect(frame.texts.slice(0, 4)).toEqual(["Lundi", "1", "Mardi", "2"]);
      // The Aura tokens of the page, as CSS variables on the component's root.
      const tokens = await inUi<{ host: string[]; frame: string[] }>(
        m,
        `const names = ["--accent", "--text", "--font-ui", "--radius-card"];
         const host = ui.getComputedStyle(doc.documentElement), d = doc.querySelector(arguments[0]).contentDocument;
         const own = d.defaultView.getComputedStyle(d.documentElement);
         return { host: names.map((n) => host.getPropertyValue(n).trim()), frame: names.map((n) => own.getPropertyValue(n).trim()) };`,
        [FRAME],
      );
      expect(tokens.frame).toEqual([...tokens.host.slice(0, 3), "16px"]);
      expect(tokens.frame[0]).not.toBe("");
      // The browser fonts, inlined in the copy, load under the families the tokens name.
      await waitUi(
        m,
        `const d = doc.querySelector(arguments[0]).contentDocument;
         const loaded = (family) => (d.fonts.load('16px "' + family + '"'), [...d.fonts].some((f) => f.family.replaceAll('"', '') === family && f.status === 'loaded'));
         return ["Geist", "Funnel Display", "Geist Mono"].every(loaded) && d.fonts.check('16px Geist');`,
        [FRAME],
        15_000,
      );
      // The height the component asked for: its document's own height, not the 150 it started with.
      await waitUi(m, "const f = doc.querySelector(arguments[0]); const h = f.contentDocument.documentElement.scrollHeight; return h !== 150 && Math.round(f.getBoundingClientRect().height) === h;", [FRAME]);
      expect(await q.text(tid("block-error"))).toBe("Composant indisponible : absent");
      expect(await q.text(tid("page-render"))).toContain("Après le composant.");
      expect(await q.text(tid("block-title"))).toBe("Priorités");
    } finally {
      await m.execute("Services.prefs.clearUserPref('ui.systemUsesDarkTheme');");
    }
  });

  // Review Focus 4
  it("a component rewritten while shown reloads; closing its last page removes its substitution", async () => {
    await closeTabs();
    await openActionPage(m, "ecrit", "Ecrit");
    const height = () => inUi<number>(m, "return Math.round(doc.querySelector(arguments[0]).getBoundingClientRect().height);", [FRAME]);
    await waitUi(m, "return Math.round(doc.querySelector(arguments[0]).getBoundingClientRect().height) === 300;", [FRAME], 15_000);
    const first = await inUi<string>(m, "return doc.querySelector(arguments[0]).contentDocument.documentURI;", [FRAME]);
    // The agent rewrites it: a new mtime, a new copy.
    const html = path.join(w.dataDir, "workspace", "components", "ecrit", "component.html");
    await writeComponent(w.dataDir, "ecrit", { description: "Hauteur fixe", properties: {}, html: sized(400) });
    const later = new Date(Date.now() + 5000);
    await utimes(html, later, later);
    await waitUi(m, "const f = doc.querySelector(arguments[0]); return f.contentDocument?.documentURI !== arguments[1] && Math.round(f.getBoundingClientRect().height) === 400;", [FRAME, first], 15_000);
    const second = await inUi<string>(m, "return doc.querySelector(arguments[0]).contentDocument.documentURI;", [FRAME]);
    expect(second).toMatch(/^resource:\/\/ressac-component-ecrit\/component-\d+-\d+\.html$/);
    const copies = path.join(w.dataDir, "ressac-components", "ecrit");
    expect(readdirSync(copies)).toEqual([path.basename(second)]);
    // Its link was not opened: components open none.
    expect(Object.values((await state(m)).tabs).some((o) => o.url.includes("from-component"))).toBe(false);
    /** Dispatches a bridge event on the frame's window, as a component's own code could, with any detail. */
    const send = (detail: unknown) =>
      inUi(m, "const w = doc.querySelector(arguments[0]).contentDocument.defaultView; w.dispatchEvent(new w.CustomEvent('ressac-component', { detail: arguments[1] }));", [FRAME, detail]);
    await send(JSON.stringify({ type: "autre", px: 900 }));
    await send({ type: "height", px: 700 });
    await send(JSON.stringify({ type: "height", px: "800" }));
    await send("{not json");
    await new Promise((r) => setTimeout(r, 300));
    expect(await height()).toBe(400);
    // The bridge's own path, clamped.
    await send(JSON.stringify({ type: "height", px: 5000 }));
    await waitUi(m, "return Math.round(doc.querySelector(arguments[0]).getBoundingClientRect().height) === 2000;", [FRAME]);
    await send(JSON.stringify({ type: "height", px: 1 }));
    await waitUi(m, "return Math.round(doc.querySelector(arguments[0]).getBoundingClientRect().height) === 20;", [FRAME]);
    // A document that is not the current copy (as the old one) does not count.
    await inUi(m, "doc.querySelector(arguments[0]).setAttribute('src', 'about:blank');", [FRAME]);
    await waitUi(m, "return doc.querySelector(arguments[0]).contentDocument?.documentURI === 'about:blank';", [FRAME]);
    await send(JSON.stringify({ type: "height", px: 600 }));
    await new Promise((r) => setTimeout(r, 300));
    expect(await height()).toBe(20);
    await closeTabs();
    await waitUi(m, "return !doc.querySelector(arguments[0]);", [FRAME]);
    for (const deadline = Date.now() + 10_000; existsSync(copies); await sleep(100)) if (Date.now() > deadline) throw new Error("copies left");
    const after = await m.execute<{ substitution: boolean; load: string }>(
      `return (async () => {
        const h = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
        const load = await fetch(arguments[0]).then((r) => "status " + r.status, (e) => e.name);
        return { substitution: h.hasSubstitution("ressac-component-ecrit"), load };
      })();`,
      [second],
    );
    expect(after).toEqual({ substitution: false, load: "TypeError" });
  }, 60_000);

  // Plan 33 spike S1, kept without RESSAC_SPIKE
  it("a component's fetch, image and WebSocket to the test server never arrive", async () => {
    reached.requests.length = 0;
    reached.connections = 0;
    await openActionPage(m, "sonde", "Sonde");
    await waitUi(m, "return doc.querySelector(arguments[0])?.contentDocument?.documentURI?.startsWith('resource://ressac-component-sonde/');", [FRAME], 15_000);
    // The probe tries at once, then navigates itself to the server after 1.5 s.
    await sleep(3000);
    expect(reached).toEqual({ requests: [], connections: 0 });
  }, 30_000);

  // Not compared: a PNG of the fallback layout, dark then light, in dist/aura-tour/ to look at.
  it("captures a fallback page (a video summary), dark and light", async () => {
    const results = {
      title: "I discovered a sound that changes everything",
      url: "https://www.youtube.com/watch?v=abc",
      channel: "colsto",
      duration: "29 min 12",
      views: 4410673,
      score: "9/10",
      recommendation: "À regarder",
      summary: "Le vidéaste raconte comment un son entendu par hasard l'a mené à reconstruire tout son studio, et ce que cela change pour sa façon de composer.",
      verdict: [{ text: "Passionnant de bout en bout" }, { text: "Un peu long au milieu" }],
      points: [{ text: "L'origine du son" }, { text: "La reconstruction du studio" }, { text: "Ce qui change pour la composition" }],
    };
    await writeActionWithResult(w.dataDir, "video", { name: "Résumer une vidéo YouTube", results, blocks: fallbackLayout(results).blocks as Block[], fallback: true });
    const out = path.resolve(import.meta.dirname, "../dist/aura-tour");
    mkdirSync(out, { recursive: true });
    try {
      await openActionPage(m, "video", "Résumer une vidéo YouTube");
      expect(await q.count(tid("block-list"))).toBe(2);
      for (const [theme, dark] of [["sombre", 1], ["clair", 0]] as const) {
        await m.execute(`Services.prefs.setIntPref('ui.systemUsesDarkTheme', ${dark});`);
        await sleep(1200);
        const png = (await m.command<{ value: string }>("WebDriver:TakeScreenshot", { full: false, hash: false })).value;
        writeFileSync(path.join(out, `action-fallback-${theme}.png`), Buffer.from(png, "base64"));
      }
    } finally {
      await m.execute("Services.prefs.clearUserPref('ui.systemUsesDarkTheme');");
      await closeTabs();
    }
  }, 30_000);
});
