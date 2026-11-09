import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { CAPTURE_WARNING_SITE, UNAVAILABLE_DESIGN_SITE } from "../shared/design-guards";
import { testActor } from "./agent-extensions";
import { WITH_HOME, withHomeDeclaration, overlayOf, LOGIN_PAGE, inStore, keyIn, openSite, siteExpr, siteKey, siteMouse, toSite, TUNING_PAGE, tuningDeclaration, viewExpr, viewPoint, OTHER_PAGE } from "./design-sites";
import { waitFor, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { grantSite, inSiteBar, inSiteView, resolveLocalHosts, startSitesServer, writeSite } from "./sites";

// Plan 36 Task 2: the site bar's design button, its chevron, ⇧⌘D in the app window and in its sign-in window, the
// bar's info avis. Apps tuning, avec-accueil and sans-accord. Block 15350-15354:
// sites on 15350.

const PORT = 15350;
const IDS = ["tuning", "avec-accueil", "sans-accord"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T = (id: string) => ({ type: "site", id });

let server: Awaited<ReturnType<typeof startSitesServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
const dirs: string[] = [];
const url = (host: string, path = "/") => server.url(host, path);

beforeAll(async () => {
  server = await startSitesServer({ port: PORT });
  server.define("tuning-a.localhost", "/", TUNING_PAGE);
  server.define("tuning-a.localhost", "/autre", OTHER_PAGE);
  server.define("compte-tuning.localhost", "/connexion", LOGIN_PAGE);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  dirs.push(dataDir, profile);
  writeSite(dataDir, "tuning", { declaration: tuningDeclaration(url), files: { "tweaks/tuning.css": "/* rien */" } });
  writeSite(dataDir, "avec-accueil", { declaration: withHomeDeclaration(url), files: { "home/index.html": WITH_HOME } });
  writeSite(dataDir, "sans-accord", { declaration: { ...tuningDeclaration(url), name: "Sans accord" }, files: { "tweaks/tuning.css": "/* rien */" } });
  await grantSite(dataDir, "tuning", tuningDeclaration(url));
  const a = testActor(profile);
  // An element's fullscreen without a gesture (as design-sites-view.e2e.ts).
  w = await launchWebAiOs({ dataDir, profile, env: { WEBAIOS_TEST_LOCAL_ADDRESSES: "1", ...a.env }, prefs: { ...a.prefs, "full-screen-api.allow-trusted-requests-only": false } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await resolveLocalHosts(m, ["tuning-a.localhost", "compte-tuning.localhost"]);
}, 120_000);
afterAll(async () => {
  await w?.close();
  await server?.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
afterEach(async () => {
  await inStore(m, `if (store.agent.__real) { store.agent.request = store.agent.__real; delete store.agent.__real; }
    for (const id of arguments[0]) { await store.design.stop({ type: "site", id }); store.design.closeOverlay({ type: "site", id }, "basket"); } return 1;`, [IDS]);
});

const state = (id: string) => inStore<{ active: boolean; unavailable: string | null; basket: number }>(m, "return await store.design.etat(arguments[0]);", [T(id)]);
const bubble = (id: string) => inStore<{ label: string } | null>(m, 'return store.design.overlayContext(arguments[0], ["bubble"]);', [T(id)]);
const hosts = (id: string) => inSiteView<number>(m, id, `return document.getElementsByTagName("webaios-viewfinder").length;`).catch(() => -1);
const view = <T = unknown>(id: string, expr: string) => inSiteView<T>(m, id, `return ${expr};`).catch(() => null);
const overlayTop = (id: string) => overlayOf<number>(m, id, "return f.getBoundingClientRect().y;");
const tid = (t: string) => `[data-testid="${t}"]`;
/** ⇧⌘D in the app window (trusted keys). */
const designKey = (id: string) => siteKey(m, id, "d", ["Meta", "Shift"]);
/** The bar's design button, its chevron and its avis. */
const bar = (id: string) =>
  inSiteBar<{ title: string; disabled: boolean; pressed: string | null; chevron: boolean; count: string | null; notice: string | null; entries: number }>(
    m,
    id,
    `const b = doc.querySelector('${tid("site-bouton-design")}'), c = doc.querySelector('${tid("site-menu-design")}');
     return { title: b?.title ?? "", disabled: !!b?.disabled, pressed: b?.getAttribute("aria-pressed") ?? null, chevron: !!c && !c.disabled,
       count: doc.querySelector('${tid("site-compteur-panier")}')?.textContent ?? null, avis: doc.querySelector('${tid("site-avis")}')?.textContent.trim() ?? null,
       entries: doc.querySelectorAll('${tid("site-menu-design-panier")}').length };`,
  );
const clickBar = (id: string, t: string) => inSiteBar(m, id, `doc.querySelector('${tid(t)}').click(); return 1;`);
/** The centre of the bar's element `t`, in the site window's coordinates. */
const barPoint = (id: string, t: string) =>
  inSiteBar<{ x: number; y: number }>(
    m,
    id,
    `const b = win.document.getElementById("webaios-site-bar").getBoundingClientRect(), r = doc.querySelector('${tid(t)}').getBoundingClientRect();
     return { x: b.left + r.left + r.width / 2, y: b.top + r.top + r.height / 2 };`,
  );
/** An element's fullscreen in the app's page: Firefox denies it to a page whose window is not in front. */
const fullscreen = async (id: string) => {
  await m.execute(`${siteExpr(id)}.focus(); return 1;`);
  await view(id, "(void document.getElementById('films').requestFullscreen(), 1)");
};
const bubbleText = (id: string) => overlayOf<string | null>(m, id, `return doc.querySelector('${tid("bulle-design")}')?.textContent ?? null;`);

/** ⇧⌘D in tuning's window: the mode on, the viewfinder armed. */
async function modeOn(id = "tuning") {
  await designKey(id);
  await expect.poll(async () => (await bar(id)).pressed, { timeout: 10_000 }).toBe("true");
  await expect.poll(() => hosts(id), { timeout: 10_000 }).toBe(1);
}
/** A trusted click on `sel` in the view: the bubble names `label`, its textarea has the keyboard. */
async function aim(id: string, sel: string, label: string) {
  await siteMouse(m, id, await viewPoint(m, id, sel));
  await expect.poll(() => bubbleText(id), { timeout: 10_000 }).toContain(label);
  await expect.poll(() => overlayOf(m, id, "return doc.activeElement?.localName ?? null;"), { timeout: 10_000 }).toBe("textarea");
}

/** ⇧⌘D there injects nothing, the avis is in the bar, ✎ greyed with it, ▾ active. */
async function verifyUnavailable(id: string) {
  await designKey(id);
  await expect.poll(async () => (await bar(id)).notice, { timeout: 10_000 }).toBe(UNAVAILABLE_DESIGN_SITE);
  await expect.poll(() => bar(id), { timeout: 10_000 }).toMatchObject({ disabled: true, title: UNAVAILABLE_DESIGN_SITE, pressed: "false", chevron: true });
  await sleep(300);
  const loaded = /^https?:/.test(String(await m.execute(`return ${viewExpr(id)}.currentURI.spec;`)));
  if (loaded) expect(await hosts(id)).toBe(0);
  expect((await state(id)).active).toBe(false);
}

// design-sites.spec.ts:149
it("⇧⌘D in tuning: viewfinder in the view, a click on #lien does nothing, bubble under the bar; ⌘Enter, Escape, Panier", async () => {
  const start = await toSite(m, "tuning");
  await expect.poll(() => bar("tuning"), { timeout: 10_000 }).toMatchObject({ title: "Mode design (⌘⇧D)", disabled: false });
  const n = (await state("tuning")).basket;
  await modeOn();
  await aim("tuning", "#lien", "a#lien");
  await sleep(500);
  expect(await view("tuning", "location.href")).toBe(start);
  expect(await view("tuning", "window.reactions")).toEqual([]);
  expect(await overlayOf(m, "tuning", `return doc.querySelector('${tid("avertissement-bulle")}')?.textContent ?? null;`)).toBe(CAPTURE_WARNING_SITE);
  expect(await overlayTop("tuning")).toBeGreaterThanOrEqual(36);
  // ⌘Enter: the remark goes to the cart, the viewfinder is armed again.
  await overlayOf(m, "tuning", `const t = doc.querySelector("textarea"); t.value = "Lien plus visible"; t.dispatchEvent(new f.contentWindow.Event("input", { bubbles: true })); return 1;`);
  await siteKey(m, "tuning", "Enter", ["Meta"]);
  await expect.poll(async () => (await bar("tuning")).count, { timeout: 10_000 }).toBe(String(n + 1));
  await expect.poll(() => hosts("tuning"), { timeout: 10_000 }).toBe(1);
  // Escape in the page: the mode stops, no viewfinder left.
  await siteKey(m, "tuning", "Escape");
  await expect.poll(async () => (await bar("tuning")).pressed, { timeout: 10_000 }).toBe("false");
  await expect.poll(() => hosts("tuning"), { timeout: 10_000 }).toBe(0);
  // Panier (chevron): the overlay shows the cart, under the bar; the entries fold.
  await clickBar("tuning", "site-menu-design");
  await expect.poll(async () => (await bar("tuning")).entries, { timeout: 10_000 }).toBe(1);
  await clickBar("tuning", "site-menu-design-panier");
  await expect.poll(() => overlayOf(m, "tuning", `return !!doc.querySelector('${tid("panier-design")}');`), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => overlayTop("tuning"), { timeout: 10_000 }).toBe(48);
  expect((await bar("tuning")).entries).toBe(0);
});

// design-sites.spec.ts:298
it("unavailable on the grant card (the avis goes after 5 s); ⌂ stops the mode", async () => {
  // (a) avec-accueil: the site entered from the home, the mode on, then ⌂: it stops.
  await toSite(m, "avec-accueil");
  await modeOn("avec-accueil");
  await clickBar("avec-accueil", "site-accueil");
  await expect.poll(async () => (await bar("avec-accueil")).pressed, { timeout: 10_000 }).toBe("false");
  await expect.poll(() => hosts("avec-accueil"), { timeout: 10_000 }).toBe(0);
  // (b) sans-accord on its grant card.
  await openSite(m, "sans-accord");
  await expect.poll(() => inSiteBar(m, "sans-accord", `return !!doc.querySelector('${tid("carte-accord-site")}');`), { timeout: 10_000 }).toBe(true);
  await verifyUnavailable("sans-accord");
  await expect.poll(async () => (await bar("sans-accord")).notice, { timeout: 10_000 }).toBeNull();
});

// design-sites.spec.ts:326
it("unavailable on the login page and in fullscreen", async () => {
  await toSite(m, "tuning");
  await view("tuning", `(location.href = ${JSON.stringify(url("compte-tuning.localhost", "/connexion"))}, 1)`);
  await expect.poll(() => view("tuning", "document.title"), { timeout: 10_000 }).toBe("Connexion");
  await verifyUnavailable("tuning");
  await toSite(m, "tuning");
  await expect.poll(async () => (await bar("tuning")).disabled, { timeout: 10_000 }).toBe(false);
  await fullscreen("tuning");
  await waitFor(m, `return ${siteExpr("tuning")}.document.documentElement.hasAttribute("inDOMFullscreen");`, (v) => v === true);
  try {
    await verifyUnavailable("tuning");
  } finally {
    await view("tuning", "(void document.exitFullscreen(), 1)");
    await waitFor(m, `return ${siteExpr("tuning")}.document.documentElement.hasAttribute("inDOMFullscreen");`, (v) => v === false);
  }
});

const SMALL = `[...Services.wm.getEnumerator("navigator:browser")].find((x) => x.document.documentElement.getAttribute("webaios-site-small") === "tuning")`;
async function openSmall() {
  await inStore(m, `store.sites.routeOpen("tuning", arguments[0]); return 1;`, [url("compte-tuning.localhost", "/connexion")]);
  const target = JSON.stringify(url("compte-tuning.localhost", "/connexion"));
  await waitFor(m, `const s = ${SMALL}; return !!s && s.gBrowser?.selectedBrowser?.currentURI.spec === ${target};`, (v) => v === true, 15_000);
}
const closeSmall = () => m.execute(`${SMALL}?.close(); return 1;`);

// design-sites.spec.ts:348
it("small sign-in window opened during the bubble: ⇧⌘D from it toggles nothing, Escape in the bubble still cancels it", async () => {
  await toSite(m, "tuning");
  await modeOn();
  await aim("tuning", "#lien", "a#lien");
  await openSmall();
  try {
    await keyIn(m, SMALL, "d", ["Meta", "Shift"]);
    await expect.poll(async () => (await bar("tuning")).notice, { timeout: 10_000 }).toBe(UNAVAILABLE_DESIGN_SITE);
    expect((await bar("tuning")).pressed).toBe("true");
    expect(await bubble("tuning")).not.toBeNull();
    expect(await bubbleText("tuning")).toContain("a#lien");
    // Escape in the bubble: cancelled, the viewfinder armed again.
    await overlayOf(m, "tuning", `doc.querySelector("textarea").focus(); return 1;`);
    await siteKey(m, "tuning", "Escape");
    await expect.poll(() => bubble("tuning"), { timeout: 10_000 }).toBeNull();
    await expect.poll(() => hosts("tuning"), { timeout: 10_000 }).toBe(1);
    expect((await bar("tuning")).pressed).toBe("true");
  } finally {
    await closeSmall();
  }
});

it("⇧⌘D in the small window opens no Firefox bookmarks dialog", async () => {
  await toSite(m, "tuning");
  await openSmall();
  try {
    const before = (await m.command<string[]>("WebDriver:GetWindowHandles")).length;
    await keyIn(m, SMALL, "d", ["Meta", "Shift"]);
    await sleep(1000);
    expect(
      await m.execute(
        `const s = ${SMALL};
         return {
           disabled: ["bookmarkAllTabsKb", "Browser:BookmarkAllTabs"].map((id) => s.document.getElementById(id)?.getAttribute("disabled")),
           organizer: !!Services.wm.getMostRecentWindow("Places:Organizer"),
           dialog: !!s.gDialogBox?.isOpen || [...Services.wm.getEnumerator(null)].some((x) => /bookmark/i.test(x.location.href)),
         };`,
      ),
    ).toEqual({ disabled: ["true", "true"], organizer: false, dialog: false });
    expect((await m.command<string[]>("WebDriver:GetWindowHandles")).length).toBe(before);
    expect((await state("tuning")).active).toBe(false);
  } finally {
    await closeSmall();
  }
});

// design-sites.spec.ts:381
it("closing tuning's window during the mode: no overlay of the target site:tuning left", async () => {
  await toSite(m, "tuning");
  await modeOn();
  await aim("tuning", "#lien", "a#lien");
  expect(await inStore(m, "return !!store.design.overlayContext(arguments[0]);", [T("tuning")])).toBe(true);
  await m.execute(`${siteExpr("tuning")}.close(); return 1;`);
  await waitFor(m, `return !${siteExpr("tuning")};`, (v) => v === true);
  await expect.poll(() => inStore(m, "return store.design.overlayContext(arguments[0]);", [T("tuning")]), { timeout: 10_000 }).toBeNull();
  expect((await state("tuning")).active).toBe(false);
});

// Spike S7: the overlay sits under the bar, never over it.
it("the bar stays clickable over an open bubble and an open cart", async () => {
  await toSite(m, "tuning");
  await modeOn();
  await aim("tuning", "#films li", "li.affiche");
  const chevron = await barPoint("tuning", "site-menu-design");
  expect(chevron.y).toBeLessThan((await overlayTop("tuning"))!);
  await siteMouse(m, "tuning", chevron);
  await expect.poll(async () => (await bar("tuning")).entries, { timeout: 10_000 }).toBe(1);
  await inStore(m, "await store.design.stop(arguments[0]); return 1;", [T("tuning")]);
  await expect.poll(() => hosts("tuning"), { timeout: 10_000 }).toBe(0);
  // The cart open: a real click on the chevron folds the entries; a click in the view off the overlay reaches the page.
  await inStore(m, "await store.design.openCart(arguments[0]); return 1;", [T("tuning")]);
  await expect.poll(() => overlayTop("tuning"), { timeout: 10_000 }).toBe(48);
  if ((await bar("tuning")).entries === 0) await siteMouse(m, "tuning", await barPoint("tuning", "site-menu-design"));
  await expect.poll(async () => (await bar("tuning")).entries, { timeout: 10_000 }).toBe(1);
  await siteMouse(m, "tuning", await barPoint("tuning", "site-menu-design"));
  await expect.poll(async () => (await bar("tuning")).entries, { timeout: 10_000 }).toBe(0);
  await view("tuning", "(window.reactions = [], 1)");
  await siteMouse(m, "tuning", await viewPoint(m, "tuning", "#banniere"));
  await expect.poll(() => view("tuning", "window.reactions"), { timeout: 10_000 }).toEqual(["clic"]);
});

it("two site apps: each bar toggles its own app, never the other", async () => {
  await toSite(m, "tuning");
  await toSite(m, "avec-accueil");
  await clickBar("tuning", "site-bouton-design");
  await expect.poll(async () => (await state("tuning")).active, { timeout: 10_000 }).toBe(true);
  await expect.poll(() => hosts("tuning"), { timeout: 10_000 }).toBe(1);
  expect((await state("avec-accueil")).active).toBe(false);
  expect(await hosts("avec-accueil")).toBe(0);
  expect((await bar("avec-accueil")).pressed).toBe("false");
  await designKey("avec-accueil");
  await expect.poll(async () => (await state("avec-accueil")).active, { timeout: 10_000 }).toBe(true);
  await expect.poll(() => hosts("avec-accueil"), { timeout: 10_000 }).toBe(1);
  expect((await state("tuning")).active).toBe(true);
  await clickBar("avec-accueil", "site-bouton-design");
  await expect.poll(async () => (await state("avec-accueil")).active, { timeout: 10_000 }).toBe(false);
  expect((await state("tuning")).active).toBe(true);
  expect(await hosts("tuning")).toBe(1);
});

it("mode on, bubble open, 3 s idle: at most 4 design.suivi calls", async () => {
  // Only the main window's UI and tuning's bar read the state (each other bar would read it too).
  await inStore(m, `for (const id of arguments[0]) await store.sites.close(id); return 1;`, [["avec-accueil", "sans-accord"]]);
  await toSite(m, "tuning");
  await modeOn();
  await aim("tuning", "#banniere", "div#banniere.cookies");
  await sleep(500);
  const wrap = `window.__suivi = 0; const real = (store.agent.__real ??= store.agent.request);
    store.agent.request = (method, p) => (method === "design.tracking" && window.__suivi++, real.call(store.agent, method, p)); return 1;`;
  const count = () => inStore<number>(m, "return window.__suivi;");
  await inStore(m, wrap);
  await sleep(3000);
  expect(await count()).toBeLessThanOrEqual(4);
  // After an add to the cart too.
  const n = (await state("tuning")).basket;
  await inStore(m, wrap);
  expect(await inStore(m, "return await store.design.add(arguments[0], arguments[1]);", [T("tuning"), "cache ça"])).toEqual({ ok: true });
  await sleep(3000);
  expect(await count()).toBeLessThanOrEqual(4);
  expect((await bar("tuning")).count).toBe(String(n + 1));
});

// Task 1's review: the site's availability read again after the host's answer.
it("fullscreen while the host answers the toggle: the mode does not start", async () => {
  await toSite(m, "tuning");
  // The toggle's design.suivi is held until the page is fullscreen.
  await inStore(
    m,
    `let release; window.__release = new Promise((r) => (release = r)); window.__doRelease = release; window.__held = false;
     const real = (store.agent.__real ??= store.agent.request);
     store.agent.request = (method, p) => {
       const r = real.call(store.agent, method, p);
       if (method !== "design.tracking" || window.__held) return r;
       window.__held = true;
       return window.__release.then(() => r);
     };
     void store.design.toggle(arguments[0]); return 1;`,
    [T("tuning")],
  );
  await waitFor(m, "return window.__held;", (v) => v === true);
  await fullscreen("tuning");
  await waitFor(m, `return ${siteExpr("tuning")}.document.documentElement.hasAttribute("inDOMFullscreen");`, (v) => v === true);
  try {
    await inStore(m, "window.__doRelease(); return 1;");
    await sleep(500);
    expect((await state("tuning")).active).toBe(false);
    expect(await hosts("tuning")).toBe(0);
  } finally {
    await view("tuning", "(void document.exitFullscreen(), 1)");
    await waitFor(m, `return ${siteExpr("tuning")}.document.documentElement.hasAttribute("inDOMFullscreen");`, (v) => v === false);
  }
});
