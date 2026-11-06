import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testActor } from "./agent-extensions";
import { waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { grantSite, inBrowser, inSiteView, resolveLocalHosts, siteWindowExpr, startSitesServer, writeSite } from "./sites";
import { missingApi } from "./ui";

// Plan 32 Task 1: the agent's retouches in each frame of a site app's view (Xray sandbox per document), ports of
// Electron's e2e/sites.spec.ts 30 (:809) to 42 (:944), plus the sign-in window and two apps side by side.

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const HOSTS = ["vidola-a.localhost", "vidola-b.localhost", "pub.localhost", "lecteur.localhost", "compte.localhost"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Electron's RETOUCHE_SERIE (sites.spec.ts:729), its world probe with Firefox's chrome globals added (spec §1): it hides
 * `.shorts` (CSS), remembers the episode, notes what it sees of its world in the DOM, and answers the test's commands.
 */
const RETOUCHE_SERIE = `
const racine = document.documentElement;
racine.dataset.monde = JSON.stringify({ require: typeof require, ipcRenderer: typeof ipcRenderer, process: typeof process, pont: typeof webaiosSite,
  Components: typeof Components, ChromeUtils: typeof ChromeUtils, Services: typeof Services });
document.body.dataset.retouche = "oui";
webaiosSite.retenir("encours.the-bear", { titre: "The Bear", episode: "S2E4" }).then(() => (racine.dataset.retenu = "oui"), (e) => (racine.dataset.retenu = "refus:" + e.message));
const repondre = (p) => p.then((r) => (racine.dataset.resultat = "ok:" + r), (e) => (racine.dataset.resultat = "refus:" + (e && e.message)));
document.addEventListener("essai", () => {
  const c = racine.dataset.commande;
  if (c === "mdp") racine.dataset.resultat = "valeur:" + document.getElementById("mdp").value;
  else if (c === "fetch-pub") repondre(Promise.resolve().then(() => fetch(racine.dataset.pub)).then((r) => r.status));
  else if (c === "fetch-site") repondre(fetch("/film/2").then((r) => r.status));
  else if (c === "elargir") {
    __webaiosPortee({ reseau: [racine.dataset.pubHote], hotes: ["<all_urls>"] });
    repondre(Promise.resolve().then(() => fetch(racine.dataset.pub)).then((r) => r.status));
  } else if (c === "non-json") repondre(webaiosSite.retenir("f", () => 1));
  else if (c === "lire") repondre(webaiosSite.lire("encours.the-bear").then((v) => JSON.stringify(v)));
});`;

let server: Awaited<ReturnType<typeof startSitesServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
let dataDir: string;
let profile: string;

const url = (p: string, host = "vidola-a.localhost") => server.url(host, p);
const lecteur = () => server.url("lecteur.localhost", "/*").replace(/^http:/, "https:");
const vidola = () => ({
  nom: "Vidola",
  adresse: url("/serie/the-bear"),
  domaines: ["vidola-a.localhost"],
  connexion: ["compte.localhost"],
  retouches: [
    { correspond: ["/serie/*"], js: ["serie.js"], css: ["cacher.css"] },
    { correspond: ["/jamais"], js: ["cadre.js"], cadres: [lecteur()] },
    { correspond: ["/erreur"], js: ["erreur.js", "apres.js"] },
  ],
});
/** The second app (Review Focus 2): its own domain, memory and console. */
const autre = () => ({ nom: "Autre", adresse: url("/serie/b", "vidola-b.localhost"), domaines: ["vidola-b.localhost"], retouches: [{ correspond: ["/serie/*"], js: ["b.js"] }] });
const B_JS = 'webaiosSite.retenir("b", 1).then(() => (document.documentElement.dataset.retenu = "oui")); throw new Error("erreur de B");';

const inStore = <T = unknown>(body: string, args: unknown[] = []) =>
  m.execute<T>(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; ${body} })();`, args);
const openSite = (id: string) => inStore(`await store.agent.request("sites.agir", { id: arguments[0], action: "ouvrir", fenetre: store.state.fenetres[0].id });`, [id]);
const viewUrl = (id: string) => m.execute<string | null>(`return ${siteWindowExpr(id)}?.gBrowser?.selectedBrowser.currentURI?.spec ?? null;`);
/** Electron's vueSite: an expression in app `id`'s view (its `frame`-th frame), null while it cannot run. */
const view = <T = unknown>(expr: string, o: { id?: string; frame?: number } = {}) => inSiteView<T>(m, o.id ?? "vidola", `return ${expr};`, { frame: o.frame }).catch(() => null);
/** `typeof name` in the page's own world (a <script> of the page; the test's script has Xrays, like a retouche). */
const pageTypeof = (name: string) =>
  view<string>(`(() => { const s = document.createElement("script"); s.textContent = "document.documentElement.dataset.vu = typeof " + ${JSON.stringify(name)}; document.documentElement.append(s); s.remove(); return document.documentElement.dataset.vu; })()`);
const errors = (id = "vidola") => inStore<{ texte: string; source: string; sourceVerifiee: boolean }[]>(`return store.sites.errors(arguments[0]);`, [id]);
const memory = (id: string) => {
  const f = path.join(dataDir, "sites", id, "memoire.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
};

/** Opens app `id` and waits for its view to have loaded `chemin`. */
async function openAt(id: string, chemin: string, host = "vidola-a.localhost") {
  await openSite(id);
  await expect.poll(() => viewUrl(id), { timeout: 15_000 }).toBe(url(chemin, host));
  await expect.poll(() => view("document.readyState", { id }), { timeout: 10_000 }).toBe("complete");
}
const go = async (chemin: string) => {
  await view(`(location.href = ${JSON.stringify(url(chemin))}, 1)`);
  await expect.poll(() => viewUrl("vidola"), { timeout: 10_000 }).toBe(url(chemin));
};

/** Electron's commande: the test's command to the retouche, then its answer. */
async function command(c: string): Promise<string | null> {
  await view(`(document.documentElement.dataset.resultat = "", document.documentElement.dataset.commande = ${JSON.stringify(c)}, document.dispatchEvent(new Event("essai")), 1)`);
  await expect.poll(() => view("document.documentElement.dataset.resultat")).not.toBe("");
  return view("document.documentElement.dataset.resultat");
}

beforeAll(async () => {
  server = await startSitesServer();
  server.definir("vidola-a.localhost", "/serie/the-bear", '<title>The Bear</title><div class="shorts" id="shorts">shorts</div><input type="password" id="mdp"><p>épisode</p>');
  server.definir("vidola-a.localhost", "/film/2", "<title>Film</title>");
  server.definir("vidola-a.localhost", "/lecteur", `<title>Lecteur</title><iframe id="l" src="${url("/v", "lecteur.localhost")}"></iframe>`);
  server.definir("lecteur.localhost", "/v", "<title>Vidéo</title><video></video>");
  server.definir("vidola-a.localhost", "/erreur", "<title>Erreur</title><p id='p'>la page marche</p>");
  // A page that stops DOMContentLoaded from window, in capture, before any other listener it knows.
  server.definir(
    "vidola-a.localhost",
    "/serie/bloque",
    '<title>Bloque</title><script>window.addEventListener("DOMContentLoaded", (e) => e.stopImmediatePropagation(), true); document.addEventListener("DOMContentLoaded", (e) => e.stopImmediatePropagation(), true);</script><div class="shorts" id="shorts">shorts</div><input type="password" id="mdp">',
  );
  server.definir("compte.localhost", "/connexion", "<title>Connexion</title>");
  server.definir("vidola-b.localhost", "/serie/b", "<title>B</title><p>b</p>");
  dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  writeSite(dataDir, "vidola", {
    declaration: vidola(),
    fichiers: {
      "retouches/serie.js": RETOUCHE_SERIE,
      "retouches/cacher.css": ".shorts { display: none; }",
      "retouches/cadre.js": 'document.documentElement.dataset.cadre = "oui"; document.documentElement.dataset.pont = typeof webaiosSite;',
      "retouches/erreur.js": 'throw new Error("retouche cassée");',
      "retouches/apres.js": 'document.documentElement.dataset.apres = "oui"; setTimeout(() => { throw new Error("plus tard"); });',
    },
  });
  writeSite(dataDir, "autre", { declaration: autre(), fichiers: { "retouches/b.js": B_JS } });
  await grantSite(dataDir, "vidola", vidola());
  await grantSite(dataDir, "autre", autre());
  const actor = testActor(profile);
  w = await launchWebAiOs({ dataDir, profile, env: { WEBAIOS_TEST_ADRESSES_LOCALES: "1", ...actor.env }, prefs: actor.prefs });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await resolveLocalHosts(m, HOSTS);
}, 90_000);
afterAll(async () => {
  await w?.close();
  await server?.fermer();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  if (profile) await rm(profile, { recursive: true, force: true });
});
beforeEach(() => void server.requetes.splice(0));
afterEach(async () => {
  try {
    expect(await missingApi(m)).toEqual([]);
  } finally {
    await m.execute(`for (const x of [...Services.wm.getEnumerator("navigator:browser")]) if (x.document.documentElement.hasAttribute("webaios-site-small")) x.close();`).catch(() => {});
    await inStore(`for (const id of store.sites.openIds()) await store.sites.close(id);`).catch(() => {});
  }
});

describe("retouches", () => {
  it("a CSS retouche hides .shorts in the page (display none) (sites.spec.ts:809)", async () => {
    await openAt("vidola", "/serie/the-bear");
    await expect.poll(() => view('getComputedStyle(document.getElementById("shorts")).display')).toBe("none");
  });

  it('a JS retouche remembers encours.the-bear through webaiosSite.retenir; the memory read by the test has adresse "/serie/the-bear" (sites.spec.ts:815)', async () => {
    await openAt("vidola", "/serie/the-bear");
    await expect.poll(() => view("document.documentElement.dataset.retenu")).toBe("oui");
    await expect.poll(() => memory("vidola")?.valeurs?.["encours.the-bear"] ?? null, { timeout: 5000 }).toMatchObject({ valeur: { titre: "The Bear", episode: "S2E4" }, adresse: "/serie/the-bear" });
    expect(await command("lire")).toBe('ok:{"titre":"The Bear","episode":"S2E4"}');
    // A non-JSON value: the memory's named refusal.
    expect(await command("non-json")).toBe("refus:Valeur refusée : JSON seulement");
  });

  it('in the retouche: typeof require, ipcRenderer, process, Components, ChromeUtils, Services are "undefined" (sites.spec.ts:828)', async () => {
    await openAt("vidola", "/serie/the-bear");
    await expect.poll(() => view("document.documentElement.dataset.monde")).toBeTruthy();
    expect(JSON.parse(String(await view("document.documentElement.dataset.monde")))).toEqual({
      require: "undefined", ipcRenderer: "undefined", process: "undefined", pont: "object", Components: "undefined", ChromeUtils: "undefined", Services: "undefined",
    });
  });

  it("in the page's world: window.webaiosSite is undefined and the DOM is changed (sites.spec.ts:836)", async () => {
    await openAt("vidola", "/serie/the-bear");
    await expect.poll(() => view("document.body.dataset.retouche")).toBe("oui");
    expect(await pageTypeof("window.webaiosSite")).toBe("undefined");
    expect(await pageTypeof("__webaiosPortee")).toBe("undefined");
  });

  it('in the lecteur.localhost sub-frame matching cadres: the retouche runs, typeof webaiosSite === "undefined" (sites.spec.ts:844)', async () => {
    await openAt("vidola", "/serie/the-bear");
    await go("/lecteur");
    await expect.poll(() => view("document.documentElement.dataset.cadre ?? null", { frame: 0 }), { timeout: 10_000 }).toBe("oui");
    expect(await view("document.documentElement.dataset.pont", { frame: 0 })).toBe("undefined");
    // The frame's retouche does not go into the main page (/lecteur is in no « correspond »).
    expect(await view("document.documentElement.dataset.cadre ?? null")).toBeNull();
  });

  it("the retouche's fetch to pub.localhost is rejected, no request received; to the site, allowed (sites.spec.ts:855)", async () => {
    await openAt("vidola", "/serie/the-bear");
    await expect.poll(() => view("document.body.dataset.retouche")).toBe("oui");
    await view(`(document.documentElement.dataset.pub = ${JSON.stringify(url("/x", "pub.localhost"))}, 1)`);
    server.requetes.splice(0);
    expect(await command("fetch-pub")).toMatch(/^refus:/);
    expect(await command("fetch-site")).toBe("ok:200");
    expect(server.requetes.filter((r) => r.hote === "pub.localhost")).toEqual([]);
    expect(server.requetes.some((r) => r.hote === "vidola-a.localhost" && r.chemin === "/film/2")).toBe(true);
  });

  it('a password field filled by the test: the retouche reads "" (sites.spec.ts:867)', async () => {
    await openAt("vidola", "/serie/the-bear");
    await expect.poll(() => view("document.body.dataset.retouche")).toBe("oui");
    await view('(document.getElementById("mdp").value = "secret", 1)');
    expect(await view('document.getElementById("mdp").value')).toBe("secret");
    expect(await command("mdp")).toBe("valeur:");
  });

  it("__webaiosPortee called again with <all_urls>: fetch to pub.localhost still rejected (sites.spec.ts:876)", async () => {
    await openAt("vidola", "/serie/the-bear");
    await expect.poll(() => view("document.body.dataset.retouche")).toBe("oui");
    await view(`(document.documentElement.dataset.pub = ${JSON.stringify(url("/x", "pub.localhost"))}, document.documentElement.dataset.pubHote = "pub.localhost", 1)`);
    server.requetes.splice(0);
    expect(await command("elargir")).toMatch(/^refus:/);
    expect(server.requetes.filter((r) => r.hote === "pub.localhost")).toEqual([]);
  });

  it("a retouche that throws: erreurs_retouches has it, the page works (sites.spec.ts:886)", async () => {
    await openAt("vidola", "/serie/the-bear");
    await go("/erreur");
    await expect.poll(() => view("document.documentElement.dataset.apres ?? null")).toBe("oui");
    await expect.poll(async () => (await errors()).map((e) => e.texte).join("\n"), { timeout: 10_000 }).toContain("retouche cassée");
    await expect.poll(async () => (await errors()).map((e) => e.texte).join("\n"), { timeout: 10_000 }).toContain("plus tard");
    const e = (await errors()).find((x) => x.texte.includes("retouche cassée"))!;
    expect(e.source).toMatch(/^webaios-retouche:\/\/vidola\/erreur\.js/);
    // The source says it is a retouche: nothing proves it (the page can name itself so).
    expect(e.sourceVerifiee).toBe(false);
    expect(await view('document.getElementById("p").textContent')).toBe("la page marche");
  });

  it("a retouche that throws later (setTimeout) is in erreurs_retouches too, with its source; the console empties when the window closes", async () => {
    await openAt("vidola", "/serie/the-bear");
    await go("/erreur");
    await expect.poll(async () => (await errors()).find((e) => e.texte.includes("plus tard"))?.source ?? null, { timeout: 10_000 }).toMatch(/^webaios-retouche:\/\/vidola\/apres\.js/);
    await inStore(`await store.sites.close("vidola");`);
    expect(await errors()).toEqual([]);
  });

  it("a page that calls stopImmediatePropagation on DOMContentLoaded (window, capture): the retouche runs (sites.spec.ts:901)", async () => {
    await openAt("vidola", "/serie/the-bear");
    await go("/serie/bloque");
    await expect.poll(() => view("document.body.dataset.retouche ?? null"), { timeout: 10_000 }).toBe("oui");
  });

  it("the memory channel failing: the bridge rejects without asking again (one call) (sites.spec.ts:911)", async () => {
    await openAt("vidola", "/serie/the-bear");
    await expect.poll(() => view("document.documentElement.dataset.retenu")).toBe("oui");
    // The relay to the host fails: the chrome's request to sites.memoireOp throws.
    await inStore(`const request = store.agent.request;
      store.__memoryCalls = [];
      store.__request = request;
      store.agent.request = (method, params, signal) => (method === "sites.memoireOp" ? (store.__memoryCalls.push(params), Promise.reject(new Error("panne"))) : request.call(store.agent, method, params, signal));`);
    try {
      expect(await command("lire")).toMatch(/^refus:/);
      expect(await inStore<number>(`return store.__memoryCalls.length;`)).toBe(1);
      // A value that cannot be copied is never sent as is, and the error is not asked again.
      expect(await command("non-json")).toMatch(/^refus:/);
      expect(await inStore<number>(`return store.__memoryCalls.length;`)).toBeLessThanOrEqual(2);
      expect(await inStore<unknown>(`return store.__memoryCalls.at(-1)?.valeur ?? null;`)).toBeNull();
    } finally {
      await inStore(`store.agent.request = store.__request;`);
    }
  });

  for (const [cas, accord] of [
    ["without accord", () => ({})],
    // The accord from before the frame pattern was added: it covers less than the declaration asks for.
    ["with an accord that covers less than the declaration", () => ({ vidola: { domaines: ["vidola-a.localhost"], connexion: ["compte.localhost"], cadres: [], reprise: false } })],
  ] as const)
    it(`${cas}: neither the agent's CSS nor script in the page (sites.spec.ts:944)`, async () => {
      const accords = path.join(dataDir, "sites-accords.json");
      const before = readFileSync(accords, "utf8");
      writeFileSync(accords, JSON.stringify(accord()));
      try {
        // Task 1 has no accord card yet: the app opens without retouches and its view loads at once.
        await openAt("vidola", "/serie/the-bear");
        await sleep(300);
        expect(await view("document.body.dataset.retouche ?? null")).toBeNull();
        expect(await view('getComputedStyle(document.getElementById("shorts")).display')).toBe("block");
      } finally {
        writeFileSync(accords, before);
      }
    });

  it("the sign-in window gets no retouche, no webaiosSite and no resume (Review Focus 1)", async () => {
    await openAt("vidola", "/serie/the-bear");
    await expect.poll(() => view("document.documentElement.dataset.retenu")).toBe("oui");
    await inStore(`store.sites.routeOpen("vidola", arguments[0]);`, [url("/connexion", "compte.localhost")]);
    const small = `[...Services.wm.getEnumerator("navigator:browser")].find((x) => x.document.documentElement.getAttribute("webaios-site-small") === "vidola")?.gBrowser.selectedBrowser`;
    await expect.poll(() => m.execute(`return ${small}?.currentURI?.spec ?? null;`), { timeout: 10_000 }).toBe(url("/connexion", "compte.localhost"));
    // In the same container, on a page of the app that its retouches match.
    await inBrowser(m, small, `location.href = ${JSON.stringify(url("/serie/the-bear"))}; return 1;`);
    await expect.poll(() => m.execute(`const b = ${small}; return b && !b.webProgress.isLoadingDocument ? b.currentURI.spec : null;`), { timeout: 10_000 }).toBe(url("/serie/the-bear"));
    await expect.poll(() => inBrowser(m, small, "return document.readyState;").catch(() => null)).toBe("complete");
    await sleep(500);
    expect(await inBrowser(m, small, 'return [document.body.dataset.retouche ?? null, document.documentElement.dataset.retenu ?? null, getComputedStyle(document.getElementById("shorts")).display];')).toEqual([null, null, "block"]);
  });

  it("two open apps never share retouches, memory or console (Review Focus 2)", async () => {
    await openAt("vidola", "/serie/the-bear");
    await openAt("autre", "/serie/b", "vidola-b.localhost");
    await expect.poll(() => view("document.documentElement.dataset.retenu", { id: "autre" })).toBe("oui");
    await expect.poll(() => view("document.documentElement.dataset.retenu")).toBe("oui");
    await go("/erreur");
    await expect.poll(async () => (await errors("autre")).map((e) => e.texte).join("\n"), { timeout: 10_000 }).toContain("erreur de B");
    await expect.poll(async () => (await errors()).map((e) => e.texte).join("\n"), { timeout: 10_000 }).toContain("retouche cassée");
    expect((await errors()).map((e) => e.texte).join("\n")).not.toContain("erreur de B");
    expect((await errors("autre")).map((e) => e.texte).join("\n")).not.toContain("retouche cassée");
    // A's retouche never ran in B's view, nor its CSS.
    expect(await view("document.body.dataset.retouche ?? null", { id: "autre" })).toBeNull();
    await expect.poll(() => memory("autre")?.valeurs ?? null, { timeout: 5000 }).toMatchObject({ b: { valeur: 1, adresse: "/serie/b" } });
    expect(Object.keys(memory("autre").valeurs)).toEqual(["b"]);
    await expect.poll(() => memory("vidola")?.valeurs ?? null, { timeout: 5000 }).toHaveProperty(["encours.the-bear"]);
    expect(memory("vidola").valeurs).not.toHaveProperty("b");
  });

  // Last: it rewrites the app's retouche.
  it("rewriting retouches/serie.js: the view reloads and the new code runs (sites.spec.ts:919)", async () => {
    await openAt("vidola", "/serie/the-bear");
    await expect.poll(() => view("document.body.dataset.retouche")).toBe("oui");
    await view("(window.marque = 1, 1)");
    writeFileSync(path.join(dataDir, "espace", "sites", "vidola", "retouches", "serie.js"), 'document.documentElement.dataset.version = "2";');
    await expect.poll(() => view("document.documentElement.dataset.version ?? null"), { timeout: 10_000 }).toBe("2");
    expect(await view("window.marque ?? null")).toBeNull();
  });
});
