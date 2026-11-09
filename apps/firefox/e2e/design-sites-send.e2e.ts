import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { reviewUrl } from "../shared/modele";
import { THIRD_PARTY_SITE_WARNING } from "../../../packages/noyau/src/design/remarques";
import { testActor } from "./agent-extensions";
import { overlayOf, inStore, openSite, siteKey, siteMouse, toSite, TUNING_PAGE, tuningDeclaration, viewExpr, viewPoint, OTHER_PAGE, CONNEXION_PAGE } from "./design-sites";
import { state, waitFor, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { openApplications, reviewedRef } from "./review";
import { grantSite, inSiteBar, inSiteView, resolveLocalHosts, startSitesServer, writeSite } from "./sites";
import { click, inUi, waitUi } from "./ui";

// Plan 36 Task 4: a site app's design mode down the whole path: the send to the agent, the tweak's reload, the
// review from the chevron, the deletion, and the host stopped (spec §5.10). App tuning,
// one launch, the tests in order. Block 15360-15364: sites on 15360.

const PORT = 15360;
const ID = "tuning";
const T = { type: "site", id: ID };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tid = (t: string) => `[data-testid="${t}"]`;
const BATCH = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/;

let server: Awaited<ReturnType<typeof startSitesServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
const dirs: string[] = [];
const url = (host: string, path = "/") => server.url(host, path);

beforeAll(async () => {
  server = await startSitesServer({ port: PORT });
  server.definir("tuning-a.localhost", "/", TUNING_PAGE);
  server.definir("tuning-a.localhost", "/autre", OTHER_PAGE);
  server.definir("compte-tuning.localhost", "/connexion", CONNEXION_PAGE);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  dirs.push(dataDir, profile);
  writeSite(dataDir, ID, { declaration: tuningDeclaration(url), fichiers: { "retouches/tuning.css": "/* rien */" } });
  await grantSite(dataDir, ID, tuningDeclaration(url));
  const a = testActor(profile);
  w = await launchWebAiOs({ dataDir, profile, env: { WEBAIOS_TEST_ADRESSES_LOCALES: "1", ...a.env }, prefs: a.prefs });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await resolveLocalHosts(m, ["tuning-a.localhost", "compte-tuning.localhost"]);
}, 120_000);
afterAll(async () => {
  await w?.close();
  await server?.fermer();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
afterEach(async () => {
  await inStore(m, `if (!store.sites.openIds().includes(arguments[0].id)) return 1; await store.design.stop(arguments[0]); store.design.closeOverlay(arguments[0], "panier"); return 1;`, [T]).catch(() => undefined);
});

const space = () => path.join(w.dataDir, "espace");
const remarksDir = () => path.join(space(), ".webaios", "remarques", `site-${ID}`);
const batches = () => (existsSync(remarksDir()) ? readdirSync(remarksDir()).filter((n) => BATCH.test(n)) : []);
const agentInput = () => {
  const f = path.join(space(), "faux-agent-entree.txt");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};
const TERMINAL = "(doc.querySelector('.xterm-rows')?.textContent ?? '').replace(/\\u00a0/g, ' ')";

const designState = () => inStore<{ actif: boolean; panier: number }>(m, "return await store.design.etat(arguments[0]);", [T]);
const hosts = () => inSiteView<number>(m, ID, `return document.getElementsByTagName("webaios-viseur").length;`).catch(() => -1);
const view = <R = unknown>(expr: string) => inSiteView<R>(m, ID, `return ${expr};`).catch(() => null);
const bar = () =>
  inSiteBar<{ pressed: string | null; count: string | null; accord: boolean }>(
    m,
    ID,
    `return { pressed: doc.querySelector('${tid("site-bouton-design")}')?.getAttribute("aria-pressed") ?? null,
       count: doc.querySelector('${tid("site-compteur-panier")}')?.textContent ?? null, accord: !!doc.querySelector('${tid("carte-accord-site")}') };`,
  );
const clickBar = (t: string) => inSiteBar(m, ID, `doc.querySelector('${tid(t)}').click(); return 1;`);
/** A chevron entry: the chevron, then its entry `t`. */
async function chevron(t: string) {
  await clickBar("site-menu-design");
  await expect.poll(() => inSiteBar(m, ID, `return !!doc.querySelector('${tid(t)}');`), { timeout: 10_000 }).toBe(true);
  await clickBar(t);
}
const inOverlay = <R = unknown>(body: string, args: unknown[] = []) => overlayOf<R>(m, ID, body, args);
const bubbleText = () => inOverlay<string | null>(`return doc.querySelector('${tid("bulle-design")}')?.textContent ?? null;`);
const designKey = () => siteKey(m, ID, "d", ["Meta", "Shift"]);
const reviewTabs = async () => Object.values((await state(m)).onglets).filter((o) => o.url === reviewUrl(`site-${ID}`));

/** ⇧⌘D in tuning's window: the mode on, the viewfinder armed. */
async function modeOn() {
  await designKey();
  await expect.poll(async () => (await bar()).pressed, { timeout: 10_000 }).toBe("true");
  await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
}
/** A trusted click on `sel`: the bubble names `label`, its textarea has the keyboard, `text` typed. */
async function aim(sel: string, label: string, text: string) {
  await siteMouse(m, ID, await viewPoint(m, ID, sel));
  await expect.poll(bubbleText, { timeout: 10_000 }).toContain(label);
  await expect.poll(() => inOverlay("return doc.activeElement?.localName ?? null;"), { timeout: 10_000 }).toBe("textarea");
  await inOverlay(`const t = doc.querySelector("textarea"); t.value = arguments[0]; t.dispatchEvent(new f.contentWindow.Event("input", { bubbles: true })); return 1;`, [text]);
}
/** A remark on `sel` by ⌘Enter, the counter shows `count`, the viewfinder armed again. */
async function remark(sel: string, label: string, text: string, count: string) {
  await aim(sel, label, text);
  await siteKey(m, ID, "Enter", ["Meta"]);
  await expect.poll(async () => (await bar()).count, { timeout: 10_000 }).toBe(count);
  await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
}
/** Escape in the page: the mode off. */
async function escape() {
  await siteKey(m, ID, "Escape");
  await expect.poll(async () => (await bar()).pressed, { timeout: 10_000 }).toBe("false");
}
/** « Panier » of the chevron, then « Envoyer » in the overlay. */
async function sendFromCart(label: string) {
  await chevron("site-menu-design-panier");
  await expect.poll(() => inOverlay<string | null>(`return doc.querySelector('${tid("envoyer-remarques")}')?.textContent ?? null;`), { timeout: 10_000 }).toBe(label);
  await inOverlay(`doc.querySelector('${tid("envoyer-remarques")}').click(); return 1;`);
}

// design-sites.spec.ts:408
it("two remarks on tuning then send from the cart: text pre-filled without Enter, site-tiers batch on disk, cart empty", async () => {
  await toSite(m, ID);
  await modeOn();
  await remark("#banniere", "div#banniere.cookies", "cache ça", "1");
  await sleep(600);
  await remark("#films", "li.affiche", "affiches plus grandes", "2");
  await escape();
  await sendFromCart("Envoyer 2 remarques à l'agent");
  // The agent's panel opens in the main window.
  await waitFor(m, "return !document.getElementById('webaios-agent').hidden", (v) => v === true);
  await waitUi(m, `return ${TERMINAL}.includes("faux agent prêt>")`, [], 20_000, "agent");
  await expect.poll(agentInput, { timeout: 15_000 }).toMatch(/^\[remarques de .+ — appli de site "Tuning" \(\/workspace\/sites\/tuning\/\) : site tiers/);
  expect(agentInput()).toContain("/workspace/.webaios/remarques/site-tuning/");
  await sleep(300);
  expect(agentInput()).not.toContain("\r");
  const lots = batches();
  expect(lots).toHaveLength(1);
  const lot = JSON.parse(readFileSync(path.join(remarksDir(), lots[0]!, "lot.json"), "utf8"));
  expect(lot.origine).toBe("site-tiers");
  expect(lot.avertissement).toBe(THIRD_PARTY_SITE_WARNING);
  expect(readdirSync(path.join(remarksDir(), lots[0]!)).filter((n) => n.endsWith(".png"))).toHaveLength(2);
  await expect.poll(async () => (await bar()).count, { timeout: 10_000 }).toBeNull();
  await expect.poll(() => inOverlay<number>(`return doc.querySelectorAll('${tid("remarque-panier")}').length;`), { timeout: 10_000 }).toBe(0);
  // relecture.assurer took the first photo before the send.
  expect(existsSync(reviewedRef(w.dataDir, `site-${ID}`))).toBe(true);
});

// design-sites.spec.ts:444
it("tweak changed during the mode: the view reloads without the grant card, the rule applies, the mode is off, the cart stays", async () => {
  await toSite(m, ID);
  await modeOn();
  await remark("#banniere", "div#banniere.cookies", "cache ça", "1");
  await view("(window.__avant = 1, 1)");
  writeFileSync(path.join(space(), "sites", ID, "retouches", "tuning.css"), "#banniere { display: none }");
  await expect
    .poll(
      async () => {
        const spec = String(await m.execute(`return ${viewExpr(ID)}.currentURI.spec;`));
        if (!/^https?:/.test(spec)) return null;
        return view(`window.__avant === undefined && document.readyState === "complete" ? getComputedStyle(document.getElementById("banniere")).display : null`);
      },
      { timeout: 15_000 },
    )
    .toBe("none");
  await expect.poll(bar, { timeout: 10_000 }).toEqual({ pressed: "false", count: "1", accord: false });
  expect((await designState()).actif).toBe(false);
  expect(await hosts()).toBe(0);
});

// design-sites.spec.ts:507, the chevron half (the card half is review.e2e.ts:252)
it("after site.json and the tweak changed, « Relire ce projet » of the chevron brings the same Review page, no second tab", async () => {
  await expect.poll(() => existsSync(reviewedRef(w.dataDir, `site-${ID}`)), { timeout: 15_000 }).toBe(true);
  writeFileSync(path.join(space(), "sites", ID, "site.json"), JSON.stringify({ ...tuningDeclaration(url), description: "Sans bannière" }));
  writeFileSync(path.join(space(), "sites", ID, "retouches", "tuning.css"), "#banniere { display: none } /* 2 */");
  await openSite(m, ID);
  await chevron("site-menu-design-relire");
  const PAGE = tid("page-relecture");
  await waitUi(m, `return !!doc.querySelector('${PAGE}')`, [], 15_000);
  await waitUi(m, `return doc.querySelectorAll('${tid("fichier-relecture")}').length === 2`, [], 15_000);
  const names = await inUi<string[]>(m, `return [...doc.querySelectorAll('${tid("fichier-relecture")} .nom-fichier')].map((e) => e.textContent).sort();`);
  expect(names).toEqual(["retouches/tuning.css", "site.json"]);
  expect((await reviewTabs()).map((o) => o.titre)).toEqual(["Relecture — Tuning"]);
  // Another tab, then « Relire ce projet » again: the same page comes back.
  await openApplications(m);
  await waitUi(m, `return !doc.querySelector('${PAGE}')`);
  await chevron("site-menu-design-relire");
  await waitUi(m, `return !!doc.querySelector('${PAGE}')`, [], 15_000);
  await waitUi(m, `return doc.querySelectorAll('${tid("fichier-relecture")}').length === 2`, [], 15_000);
  expect(await reviewTabs()).toHaveLength(1);
});

// Spec §5.10. Before the deletion: the recreated app is not granted.
it("the host stopped: ✎ keeps its last state, ⌘⇧D does nothing, Ajouter shows the call's error", async () => {
  const stopHost = () => inStore(m, "await store.agent.stop(); return 1;");
  const startHost = async (basket: number) => {
    await inStore(m, "await store.agent.ensure(); return 1;");
    await expect.poll(() => designState().then((e) => e.panier, () => null), { timeout: 30_000 }).toBe(basket);
  };
  await toSite(m, ID);
  const n = (await designState()).panier;
  expect(n).toBeGreaterThan(0);
  // The mode off: ⇧⌘D starts nothing, ✎ stays released.
  await stopHost();
  try {
    await designKey();
    await sleep(500);
    expect(await hosts()).toBe(0);
    expect(await bar()).toMatchObject({ pressed: "false", count: n ? String(n) : null });
  } finally {
    await startHost(n);
  }
  // The mode on, the bubble open: ✎ stays pressed, Ajouter shows the call's error in the bubble.
  await modeOn();
  await aim("#lien", "a#lien", "perdue");
  await stopHost();
  try {
    await sleep(500);
    expect(await bar()).toMatchObject({ pressed: "true", count: n ? String(n) : null });
    await inOverlay(`doc.querySelector("button.ajouter").click(); return 1;`);
    await expect.poll(() => inOverlay<string | null>(`return doc.querySelector('[role="alert"]')?.textContent ?? null;`), { timeout: 10_000 }).toBeTruthy();
    expect(await bubbleText()).toContain("a#lien");
    expect(await inStore(m, "return store.design.overlayContext(arguments[0])?.mode ?? null;", [T])).toBe("bulle");
    expect((await bar()).pressed).toBe("true");
  } finally {
    await startHost(n);
  }
});

// design-sites.spec.ts:538
it("Supprimer with a remark in the cart and a batch sent: remarks and review repo erased; tuning made again: empty cart, new reference", { timeout: 90_000 }, async () => {
  const review = path.join(w.dataDir, "design", "relecture");
  await expect.poll(() => existsSync(reviewedRef(w.dataDir, `site-${ID}`)), { timeout: 15_000 }).toBe(true);
  const old = readFileSync(reviewedRef(w.dataDir, `site-${ID}`), "utf8");
  await toSite(m, ID);
  // A batch sent (with the tweak test's remark; #banniere is hidden by the tweak: #lien)…
  const sent = batches().length;
  expect((await designState()).panier).toBe(1);
  await modeOn();
  await remark("#lien", "a#lien", "lien plus visible", "2");
  await escape();
  await sendFromCart("Envoyer 2 remarques à l'agent");
  await expect.poll(async () => (await bar()).count, { timeout: 10_000 }).toBeNull();
  await expect.poll(() => batches().length, { timeout: 10_000 }).toBe(sent + 1);
  // … then a remark in the cart, the mode on.
  await modeOn();
  await remark("#films", "li.affiche", "affiches plus grandes", "1");
  await openApplications(m);
  await click(m, tid(`site-${ID}-supprimer`));
  await click(m, tid("confirmer-suppression-site"));
  await waitUi(m, `return !doc.querySelector('${tid(`site-${ID}`)}')`, [], 15_000);
  await expect.poll(() => existsSync(remarksDir()), { timeout: 15_000 }).toBe(false);
  await expect.poll(() => existsSync(path.join(review, `site-${ID}.git`)), { timeout: 15_000 }).toBe(false);
  expect(existsSync(path.join(review, `site-${ID}.commentaires.json`))).toBe(false);
  // Made again with the same id (another tweak: another tree, so another photo if the old one is gone).
  writeSite(w.dataDir, ID, { declaration: tuningDeclaration(url), fichiers: { "retouches/tuning.css": "/* neuve */" } });
  await waitUi(m, `return !!doc.querySelector('${tid(`site-${ID}`)}')`, [], 15_000);
  await expect.poll(() => existsSync(reviewedRef(w.dataDir, `site-${ID}`)), { timeout: 15_000 }).toBe(true);
  expect(readFileSync(reviewedRef(w.dataDir, `site-${ID}`), "utf8")).not.toBe(old);
  await openSite(m, ID);
  await expect.poll(() => inSiteBar(m, ID, `return !!doc.querySelector('${tid("site-bouton-design")}');`), { timeout: 10_000 }).toBe(true);
  expect((await bar()).count).toBeNull();
  expect((await designState()).panier).toBe(0);
});
