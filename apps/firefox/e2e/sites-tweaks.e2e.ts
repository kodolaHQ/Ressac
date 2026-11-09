import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testActor } from "./agent-extensions";
import { waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { grantSite, inBrowser, inSiteBar, inSiteView, resolveLocalHosts, siteWindowExpr, startSitesServer, writeSite } from "./sites";
import { missingApi } from "./ui";

// Plan 32 Task 1: the agent's tweaks in each frame of a site app's view (Xray sandbox per document), plus the
// sign-in window and two apps side by side.

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const HOSTS = ["vidola-a.localhost", "vidola-b.localhost", "pub.localhost", "lecteur.localhost", "compte.localhost"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A series tweak with a world probe, with Firefox's chrome globals added (spec §1): it hides
 * `.shorts` (CSS), remembers the episode, notes what it sees of its world in the DOM, and answers the test's commands.
 */
const TWEAK_SERIES = `
const racine = document.documentElement;
racine.dataset.monde = JSON.stringify({ require: typeof require, ipcRenderer: typeof ipcRenderer, process: typeof process, pont: typeof webaiosSite,
  Components: typeof Components, ChromeUtils: typeof ChromeUtils, Services: typeof Services });
document.body.dataset.retouche = "oui";
webaiosSite.remember("encours.the-bear", { titre: "The Bear", episode: "S2E4" }).then(() => (racine.dataset.retenu = "oui"), (e) => (racine.dataset.retenu = "refus:" + e.message));
const repondre = (p) => p.then((r) => (racine.dataset.resultat = "ok:" + r), (e) => (racine.dataset.resultat = "refus:" + (e && e.message)));
document.addEventListener("essai", () => {
  const c = racine.dataset.commande;
  if (c === "mdp") racine.dataset.resultat = "valeur:" + document.getElementById("mdp").value;
  else if (c === "fetch-pub") repondre(Promise.resolve().then(() => fetch(racine.dataset.pub)).then((r) => r.status));
  else if (c === "fetch-site") repondre(fetch("/film/2").then((r) => r.status));
  else if (c === "elargir") {
    __webaiosScope({ network: [racine.dataset.pubHote], hosts: ["<all_urls>"] });
    repondre(Promise.resolve().then(() => fetch(racine.dataset.pub)).then((r) => r.status));
  } else if (c === "non-json") repondre(webaiosSite.remember("f", () => 1));
  else if (c === "lire") repondre(webaiosSite.read("encours.the-bear").then((v) => JSON.stringify(v)));
});`;

let server: Awaited<ReturnType<typeof startSitesServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
let dataDir: string;
let profile: string;

const url = (p: string, host = "vidola-a.localhost") => server.url(host, p);
const reader = () => server.url("lecteur.localhost", "/*").replace(/^http:/, "https:");
const vidola = () => ({
  name: "Vidola",
  url: url("/serie/the-bear"),
  domains: ["vidola-a.localhost"],
  login: ["compte.localhost"],
  tweaks: [
    { matches: ["/serie/*"], js: ["serie.js"], css: ["cacher.css"] },
    { matches: ["/jamais"], js: ["cadre.js"], frames: [reader()] },
    { matches: ["/erreur"], js: ["erreur.js", "apres.js"] },
  ],
});
/** The second app (Review Focus 2): its own domain, memory and console. */
const other = () => ({ name: "Autre", url: url("/serie/b", "vidola-b.localhost"), domains: ["vidola-b.localhost"], tweaks: [{ matches: ["/serie/*"], js: ["b.js"] }] });
const B_JS = 'webaiosSite.remember("b", 1).then(() => (document.documentElement.dataset.retenu = "oui")); throw new Error("erreur de B");';

const inStore = <T = unknown>(body: string, args: unknown[] = []) =>
  m.execute<T>(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; ${body} })();`, args);
const openSite = (id: string) => inStore(`await store.agent.request("sites.act", { id: arguments[0], action: "open", window: store.state.windows[0].id });`, [id]);
const viewUrl = (id: string) => m.execute<string | null>(`return ${siteWindowExpr(id)}?.gBrowser?.selectedBrowser.currentURI?.spec ?? null;`);
/** An expression in app `id`'s view (its `frame`-th frame), null while it cannot run. */
const view = <T = unknown>(expr: string, o: { id?: string; frame?: number } = {}) => inSiteView<T>(m, o.id ?? "vidola", `return ${expr};`, { frame: o.frame }).catch(() => null);
/** `typeof name` in the page's own world (a <script> of the page; the test's script has Xrays, like a tweak). */
const pageTypeof = (name: string) =>
  view<string>(`(() => { const s = document.createElement("script"); s.textContent = "document.documentElement.dataset.vu = typeof " + ${JSON.stringify(name)}; document.documentElement.append(s); s.remove(); return document.documentElement.dataset.vu; })()`);
const errors = (id = "vidola") => inStore<{ text: string; source: string; sourceVerified: boolean }[]>(`return store.sites.errors(arguments[0]);`, [id]);
const memory = (id: string) => {
  const f = path.join(dataDir, "sites", id, "memory.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
};

/** Opens app `id` and waits for its view to have loaded `chemin`. */
async function openAt(id: string, path: string, host = "vidola-a.localhost") {
  await openSite(id);
  await expect.poll(() => viewUrl(id), { timeout: 15_000 }).toBe(url(path, host));
  await expect.poll(() => view("document.readyState", { id }), { timeout: 10_000 }).toBe("complete");
}
const go = async (path: string) => {
  await view(`(location.href = ${JSON.stringify(url(path))}, 1)`);
  await expect.poll(() => viewUrl("vidola"), { timeout: 10_000 }).toBe(url(path));
};

/** The test's command to the tweak, then its answer. */
async function command(c: string): Promise<string | null> {
  await view(`(document.documentElement.dataset.resultat = "", document.documentElement.dataset.commande = ${JSON.stringify(c)}, document.dispatchEvent(new Event("essai")), 1)`);
  await expect.poll(() => view("document.documentElement.dataset.resultat")).not.toBe("");
  return view("document.documentElement.dataset.resultat");
}

beforeAll(async () => {
  server = await startSitesServer();
  server.define("vidola-a.localhost", "/serie/the-bear", '<title>The Bear</title><div class="shorts" id="shorts">shorts</div><input type="password" id="mdp"><p>épisode</p>');
  server.define("vidola-a.localhost", "/film/2", "<title>Film</title>");
  server.define("vidola-a.localhost", "/lecteur", `<title>Lecteur</title><iframe id="l" src="${url("/v", "lecteur.localhost")}"></iframe>`);
  server.define("lecteur.localhost", "/v", "<title>Vidéo</title><video></video>");
  server.define("vidola-a.localhost", "/erreur", "<title>Erreur</title><p id='p'>la page marche</p>");
  // A page that stops DOMContentLoaded from window, in capture, before any other listener it knows.
  server.define(
    "vidola-a.localhost",
    "/serie/bloque",
    '<title>Bloque</title><script>window.addEventListener("DOMContentLoaded", (e) => e.stopImmediatePropagation(), true); document.addEventListener("DOMContentLoaded", (e) => e.stopImmediatePropagation(), true);</script><div class="shorts" id="shorts">shorts</div><input type="password" id="mdp">',
  );
  server.define("compte.localhost", "/connexion", "<title>Connexion</title>");
  server.define("vidola-b.localhost", "/serie/b", "<title>B</title><p>b</p>");
  dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  writeSite(dataDir, "vidola", {
    declaration: vidola(),
    files: {
      "tweaks/serie.js": TWEAK_SERIES,
      "tweaks/cacher.css": ".shorts { display: none; }",
      "tweaks/cadre.js": 'document.documentElement.dataset.cadre = "oui"; document.documentElement.dataset.pont = typeof webaiosSite;',
      "tweaks/erreur.js": 'throw new Error("retouche cassée");',
      "tweaks/apres.js": 'document.documentElement.dataset.apres = "oui"; setTimeout(() => { throw new Error("plus tard"); });',
    },
  });
  writeSite(dataDir, "autre", { declaration: other(), files: { "tweaks/b.js": B_JS } });
  await grantSite(dataDir, "vidola", vidola());
  await grantSite(dataDir, "autre", other());
  const actor = testActor(profile);
  w = await launchWebAiOs({ dataDir, profile, env: { WEBAIOS_TEST_LOCAL_ADDRESSES: "1", ...actor.env }, prefs: actor.prefs });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await resolveLocalHosts(m, HOSTS);
}, 90_000);
afterAll(async () => {
  await w?.close();
  await server?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  if (profile) await rm(profile, { recursive: true, force: true });
});
beforeEach(() => void server.requests.splice(0));
afterEach(async () => {
  try {
    expect(await missingApi(m)).toEqual([]);
  } finally {
    await m.execute(`for (const x of [...Services.wm.getEnumerator("navigator:browser")]) if (x.document.documentElement.hasAttribute("webaios-site-small")) x.close();`).catch(() => {});
    await inStore(`for (const id of store.sites.openIds()) await store.sites.close(id);`).catch(() => {});
  }
});

describe("tweaks", () => {
  it("a CSS tweak hides .shorts in the page (display none) (sites.spec.ts:809)", async () => {
    await openAt("vidola", "/serie/the-bear");
    await expect.poll(() => view('getComputedStyle(document.getElementById("shorts")).display')).toBe("none");
  });

  it('a JS tweak remembers encours.the-bear through webaiosSite.remember; the memory read by the test has adresse "/serie/the-bear" (sites.spec.ts:815)', async () => {
    await openAt("vidola", "/serie/the-bear");
    await expect.poll(() => view("document.documentElement.dataset.retenu")).toBe("oui");
    await expect.poll(() => memory("vidola")?.values?.["encours.the-bear"] ?? null, { timeout: 5000 }).toMatchObject({ value: { titre: "The Bear", episode: "S2E4" }, url: "/serie/the-bear" });
    expect(await command("lire")).toBe('ok:{"titre":"The Bear","episode":"S2E4"}');
    // A non-JSON value: the memory's named refusal.
    expect(await command("non-json")).toBe("refus:Valeur refusée : JSON seulement");
  });

  it('in the tweak: typeof require, ipcRenderer, process, Components, ChromeUtils, Services are "undefined" (sites.spec.ts:828)', async () => {
    await openAt("vidola", "/serie/the-bear");
    await expect.poll(() => view("document.documentElement.dataset.monde")).toBeTruthy();
    expect(JSON.parse(String(await view("document.documentElement.dataset.monde")))).toEqual({
      require: "undefined", ipcRenderer: "undefined", process: "undefined", bridge: "object", Components: "undefined", ChromeUtils: "undefined", Services: "undefined",
    });
  });

  it("in the page's world: window.webaiosSite is undefined and the DOM is changed (sites.spec.ts:836)", async () => {
    await openAt("vidola", "/serie/the-bear");
    await expect.poll(() => view("document.body.dataset.retouche")).toBe("oui");
    expect(await pageTypeof("window.webaiosSite")).toBe("undefined");
    expect(await pageTypeof("__webaiosScope")).toBe("undefined");
  });

  it('in the lecteur.localhost sub-frame matching cadres: the tweak runs, typeof webaiosSite === "undefined" (sites.spec.ts:844)', async () => {
    await openAt("vidola", "/serie/the-bear");
    await go("/lecteur");
    await expect.poll(() => view("document.documentElement.dataset.cadre ?? null", { frame: 0 }), { timeout: 10_000 }).toBe("oui");
    expect(await view("document.documentElement.dataset.pont", { frame: 0 })).toBe("undefined");
    // The frame's tweak does not go into the main page (/lecteur is in no « correspond »).
    expect(await view("document.documentElement.dataset.cadre ?? null")).toBeNull();
  });

  it("the tweak's fetch to pub.localhost is rejected, no request received; to the site, allowed (sites.spec.ts:855)", async () => {
    await openAt("vidola", "/serie/the-bear");
    await expect.poll(() => view("document.body.dataset.retouche")).toBe("oui");
    await view(`(document.documentElement.dataset.pub = ${JSON.stringify(url("/x", "pub.localhost"))}, 1)`);
    server.requests.splice(0);
    expect(await command("fetch-pub")).toMatch(/^refus:/);
    expect(await command("fetch-site")).toBe("ok:200");
    expect(server.requests.filter((r) => r.host === "pub.localhost")).toEqual([]);
    expect(server.requests.some((r) => r.host === "vidola-a.localhost" && r.path === "/film/2")).toBe(true);
  });

  it('a password field filled by the test: the tweak reads "" (sites.spec.ts:867)', async () => {
    await openAt("vidola", "/serie/the-bear");
    await expect.poll(() => view("document.body.dataset.retouche")).toBe("oui");
    await view('(document.getElementById("mdp").value = "secret", 1)');
    expect(await view('document.getElementById("mdp").value')).toBe("secret");
    expect(await command("mdp")).toBe("valeur:");
  });

  it("__webaiosScope called again with <all_urls>: fetch to pub.localhost still rejected (sites.spec.ts:876)", async () => {
    await openAt("vidola", "/serie/the-bear");
    await expect.poll(() => view("document.body.dataset.retouche")).toBe("oui");
    await view(`(document.documentElement.dataset.pub = ${JSON.stringify(url("/x", "pub.localhost"))}, document.documentElement.dataset.pubHote = "pub.localhost", 1)`);
    server.requests.splice(0);
    expect(await command("elargir")).toMatch(/^refus:/);
    expect(server.requests.filter((r) => r.host === "pub.localhost")).toEqual([]);
  });

  it("a tweak that throws: tweak_errors has it, the page works (sites.spec.ts:886)", async () => {
    await openAt("vidola", "/serie/the-bear");
    await go("/erreur");
    await expect.poll(() => view("document.documentElement.dataset.apres ?? null")).toBe("oui");
    await expect.poll(async () => (await errors()).map((e) => e.text).join("\n"), { timeout: 10_000 }).toContain("retouche cassée");
    await expect.poll(async () => (await errors()).map((e) => e.text).join("\n"), { timeout: 10_000 }).toContain("plus tard");
    const e = (await errors()).find((x) => x.text.includes("retouche cassée"))!;
    expect(e.source).toMatch(/^webaios-tweak:\/\/vidola\/erreur\.js/);
    // The source says it is a tweak: nothing proves it (the page can name itself so).
    expect(e.sourceVerified).toBe(false);
    expect(await view('document.getElementById("p").textContent')).toBe("la page marche");
  });

  it("a tweak that throws later (setTimeout) is in tweak_errors too, with its source; the console empties when the window closes", async () => {
    await openAt("vidola", "/serie/the-bear");
    await go("/erreur");
    await expect.poll(async () => (await errors()).find((e) => e.text.includes("plus tard"))?.source ?? null, { timeout: 10_000 }).toMatch(/^webaios-tweak:\/\/vidola\/apres\.js/);
    await inStore(`await store.sites.close("vidola");`);
    expect(await errors()).toEqual([]);
  });

  it("a page that calls stopImmediatePropagation on DOMContentLoaded (window, capture): the tweak runs (sites.spec.ts:901)", async () => {
    await openAt("vidola", "/serie/the-bear");
    await go("/serie/bloque");
    await expect.poll(() => view("document.body.dataset.retouche ?? null"), { timeout: 10_000 }).toBe("oui");
  });

  it("the memory channel failing: the bridge rejects without asking again (one call) (sites.spec.ts:911)", async () => {
    await openAt("vidola", "/serie/the-bear");
    await expect.poll(() => view("document.documentElement.dataset.retenu")).toBe("oui");
    // The relay to the host fails: the chrome's request to sites.memoryOp throws.
    await inStore(`const request = store.agent.request;
      store.__memoryCalls = [];
      store.__request = request;
      store.agent.request = (method, params, signal) => (method === "sites.memoryOp" ? (store.__memoryCalls.push(params), Promise.reject(new Error("panne"))) : request.call(store.agent, method, params, signal));`);
    try {
      expect(await command("lire")).toMatch(/^refus:/);
      expect(await inStore<number>(`return store.__memoryCalls.length;`)).toBe(1);
      // A value that cannot be copied is never sent as is, and the error is not asked again.
      expect(await command("non-json")).toMatch(/^refus:/);
      expect(await inStore<number>(`return store.__memoryCalls.length;`)).toBeLessThanOrEqual(2);
      expect(await inStore<unknown>(`return store.__memoryCalls.at(-1)?.value ?? null;`)).toBeNull();
    } finally {
      await inStore(`store.agent.request = store.__request;`);
    }
  });

  for (const [cas, grant] of [
    ["without accord", () => ({})],
    // The grant from before the frame pattern was added: it covers less than the declaration asks for.
    ["with an accord that covers less than the declaration", () => ({ vidola: { domains: ["vidola-a.localhost"], login: ["compte.localhost"], frames: [], resume: false } })],
  ] as const)
    it(`${cas}: nothing is loaded before the card is answered, then neither the agent's CSS nor script in the page (sites.spec.ts:944)`, async () => {
      const grants = path.join(dataDir, "site-grants.json");
      const before = readFileSync(grants, "utf8");
      writeFileSync(grants, JSON.stringify(grant()));
      try {
        await openSite("vidola");
        await expect.poll(() => inStore<string | null>(`return store.sites.viewOf("vidola");`), { timeout: 15_000 }).toBe("grant");
        await sleep(300);
        // The card blocks the view: it loads nothing.
        expect(await m.execute<string>(`return ${siteWindowExpr("vidola")}.gBrowser.selectedBrowser.currentURI.spec;`)).toBe("about:blank");
        expect(server.requests.filter((r) => r.host === "vidola-a.localhost")).toEqual([]);
        // « Ouvrir sans retouches »: the page loads, and nothing of the agent is in it.
        await inSiteBar(m, "vidola", `doc.querySelector('[data-testid="refuser-site"]').click(); return true;`);
        await expect.poll(() => viewUrl("vidola"), { timeout: 15_000 }).toBe(url("/serie/the-bear"));
        await expect.poll(() => view("document.readyState")).toBe("complete");
        await sleep(300);
        expect(await view("document.body.dataset.retouche ?? null")).toBeNull();
        expect(await view('getComputedStyle(document.getElementById("shorts")).display')).toBe("block");
        expect(await view("document.documentElement.dataset.retenu ?? null")).toBeNull();
      } finally {
        writeFileSync(grants, before);
      }
    });

  it("the sign-in window gets no tweak, no webaiosSite and no resume (Review Focus 1)", async () => {
    await openAt("vidola", "/serie/the-bear");
    await expect.poll(() => view("document.documentElement.dataset.retenu")).toBe("oui");
    await inStore(`store.sites.routeOpen("vidola", arguments[0]);`, [url("/connexion", "compte.localhost")]);
    const small = `[...Services.wm.getEnumerator("navigator:browser")].find((x) => x.document.documentElement.getAttribute("webaios-site-small") === "vidola")?.gBrowser.selectedBrowser`;
    await expect.poll(() => m.execute(`return ${small}?.currentURI?.spec ?? null;`), { timeout: 10_000 }).toBe(url("/connexion", "compte.localhost"));
    // In the same container, on a page of the app that its tweaks match.
    await inBrowser(m, small, `location.href = ${JSON.stringify(url("/serie/the-bear"))}; return 1;`);
    await expect.poll(() => m.execute(`const b = ${small}; return b && !b.webProgress.isLoadingDocument ? b.currentURI.spec : null;`), { timeout: 10_000 }).toBe(url("/serie/the-bear"));
    await expect.poll(() => inBrowser(m, small, "return document.readyState;").catch(() => null)).toBe("complete");
    await sleep(500);
    expect(await inBrowser(m, small, 'return [document.body.dataset.retouche ?? null, document.documentElement.dataset.retenu ?? null, getComputedStyle(document.getElementById("shorts")).display];')).toEqual([null, null, "block"]);
  });

  it("two open apps never share tweaks, memory or console (Review Focus 2)", async () => {
    await openAt("vidola", "/serie/the-bear");
    await openAt("autre", "/serie/b", "vidola-b.localhost");
    await expect.poll(() => view("document.documentElement.dataset.retenu", { id: "autre" })).toBe("oui");
    await expect.poll(() => view("document.documentElement.dataset.retenu")).toBe("oui");
    await go("/erreur");
    await expect.poll(async () => (await errors("autre")).map((e) => e.text).join("\n"), { timeout: 10_000 }).toContain("erreur de B");
    await expect.poll(async () => (await errors()).map((e) => e.text).join("\n"), { timeout: 10_000 }).toContain("retouche cassée");
    expect((await errors()).map((e) => e.text).join("\n")).not.toContain("erreur de B");
    expect((await errors("autre")).map((e) => e.text).join("\n")).not.toContain("retouche cassée");
    // A's tweak never ran in B's view, nor its CSS.
    expect(await view("document.body.dataset.retouche ?? null", { id: "autre" })).toBeNull();
    await expect.poll(() => memory("autre")?.values ?? null, { timeout: 5000 }).toMatchObject({ b: { value: 1, url: "/serie/b" } });
    expect(Object.keys(memory("autre").values)).toEqual(["b"]);
    await expect.poll(() => memory("vidola")?.values ?? null, { timeout: 5000 }).toHaveProperty(["encours.the-bear"]);
    expect(memory("vidola").values).not.toHaveProperty("b");
  });

  // Last: it rewrites the app's tweak.
  it("rewriting retouches/serie.js: the view reloads and the new code runs (sites.spec.ts:919)", async () => {
    await openAt("vidola", "/serie/the-bear");
    await expect.poll(() => view("document.body.dataset.retouche")).toBe("oui");
    await view("(window.marque = 1, 1)");
    writeFileSync(path.join(dataDir, "workspace", "sites", "vidola", "tweaks", "serie.js"), 'document.documentElement.dataset.version = "2";');
    await expect.poll(() => view("document.documentElement.dataset.version ?? null"), { timeout: 10_000 }).toBe("2");
    expect(await view("window.marque ?? null")).toBeNull();
  });
});
