import { describe, it, expect } from "vitest";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { dirname, join } from "node:path";
import {
  FICHIERS_MAX,
  GARDES_PAR_DEFAUT,
  cspAgent,
  preparerCopie,
  preparerStore,
} from "../../src/extensions/copie.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const GARDES = ["webaios-correctifs-page.js", "webaios-garde-page.js", "webaios-garde-fond.js"];

async function ecrire(dossier: string, fichiers: Record<string, string | object>): Promise<void> {
  for (const [chemin, contenu] of Object.entries(fichiers)) {
    await mkdir(dirname(join(dossier, chemin)), { recursive: true });
    await writeFile(join(dossier, chemin), typeof contenu === "string" ? contenu : JSON.stringify(contenu));
  }
}

const manifesteBase = (surcharge: Record<string, unknown> = {}) => ({
  manifest_version: 3,
  name: "Essai",
  version: "1.0",
  ...surcharge,
});

async function source(fichiers: Record<string, string | object>): Promise<string> {
  const d = join(await dossierTemporaire(), "source");
  await mkdir(d);
  await ecrire(d, fichiers);
  return d;
}

async function cible(): Promise<string> {
  return join(await dossierTemporaire(), "copies", "essai");
}

const lireJson = async (chemin: string) => JSON.parse(await readFile(chemin, "utf8")) as Record<string, any>;

describe("preparerCopie", () => {
  it("la copie a la CSP cspAgent([]) et rien d'autre de l'agent dans content_security_policy", async () => {
    const src = await source({
      "manifest.json": manifesteBase({
        content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'; connect-src *", sandbox: "x" },
      }),
    });
    const c = await cible();
    const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(analyse.refus).toEqual([]);
    const m = await lireJson(join(c, "manifest.json"));
    expect(m.content_security_policy).toEqual({ extension_pages: cspAgent([]) });
    expect(cspAgent([])).toBe(
      "default-src 'self'; script-src 'self'; object-src 'none'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; form-action 'none'; frame-ancestors 'self'",
    );
  });

  it("avec webaios.json { reseau: [\"api.exemple.com\"] } : connect-src contient https://api.exemple.com, webaios.json absent de la copie", async () => {
    const src = await source({ "manifest.json": manifesteBase(), "webaios.json": { reseau: ["api.exemple.com"] } });
    const c = await cible();
    const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(analyse.portee.reseau).toEqual(["api.exemple.com"]);
    const m = await lireJson(join(c, "manifest.json"));
    expect(m.content_security_policy.extension_pages).toContain("connect-src 'self' https://api.exemple.com;");
    expect(existsSync(join(c, "webaios.json"))).toBe(false);
  });

  it("key et update_url retirés", async () => {
    const src = await source({ "manifest.json": manifesteBase({ key: "MIIB...", update_url: "https://x.example/u" }) });
    const c = await cible();
    await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    const m = await lireJson(join(c, "manifest.json"));
    expect("key" in m).toBe(false);
    expect("update_url" in m).toBe(false);
    expect(m.name).toBe("Essai");
  });

  it("chaque content_script commence par webaios-correctifs-page.js puis webaios-garde-page.js", async () => {
    const src = await source({
      "manifest.json": manifesteBase({
        content_scripts: [
          { matches: ["https://a.example/*"], js: ["a.js", "b.js"] },
          { matches: ["https://b.example/*"], js: ["c/d.js"] },
        ],
      }),
      "a.js": "1",
      "b.js": "2",
      "c/d.js": "3",
    });
    const c = await cible();
    await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    const m = await lireJson(join(c, "manifest.json"));
    expect(m.content_scripts[0].js).toEqual(["webaios-correctifs-page.js", "webaios-garde-page.js", "a.js", "b.js"]);
    expect(m.content_scripts[1].js).toEqual(["webaios-correctifs-page.js", "webaios-garde-page.js", "c/d.js"]);
    for (const g of GARDES) expect(existsSync(join(c, g)), g).toBe(true);
    expect(await readFile(join(c, "c/d.js"), "utf8")).toBe("3");
  });

  it("service worker classique : webaios-fond.js fait importScripts des deux ; module : import des deux, type module gardé", async () => {
    const src = await source({ "manifest.json": manifesteBase({ background: { service_worker: "bg/sw.js" } }), "bg/sw.js": "" });
    const c = await cible();
    await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    const m = await lireJson(join(c, "manifest.json"));
    expect(m.background).toEqual({ service_worker: "webaios-fond.js" });
    const fond = await readFile(join(c, "webaios-fond.js"), "utf8");
    expect(fond).toContain('importScripts("webaios-garde-fond.js", "bg/sw.js")');
    expect(existsSync(join(c, "bg/sw.js"))).toBe(true);

    const srcM = await source({
      "manifest.json": manifesteBase({ background: { service_worker: "sw.js", type: "module" } }),
      "sw.js": "export {}",
    });
    const cM = await cible();
    await preparerCopie({ source: srcM, cible: cM, dossierGardes: GARDES_PAR_DEFAUT });
    const mM = await lireJson(join(cM, "manifest.json"));
    expect(mM.background).toEqual({ service_worker: "webaios-fond.js", type: "module" });
    const fondM = await readFile(join(cM, "webaios-fond.js"), "utf8");
    const imports = [...fondM.matchAll(/^import "(.+)";$/gm)].map((x) => x[1]);
    expect(imports).toEqual(["./webaios-garde-fond.js", "./sw.js"]);
  });

  it("le garde de fond est le premier script de chaque page HTML, même sans <head>, les scripts existants restent après", async () => {
    const src = await source({
      "manifest.json": manifesteBase(),
      "popup.html": '<!doctype html><html><head><meta charset="utf-8"><script src="popup.js"></script></head><body></body></html>',
      "pages/options.html": "<p>options</p><script src=\"options.js\"></script>",
      "offscreen.HTML": "<!DOCTYPE html>\n<script>1</script>",
    });
    const c = await cible();
    await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    const scripts = (html: string) => [...html.matchAll(/<script[^>]*>/gi)].map((x) => x[0]);

    const popup = await readFile(join(c, "popup.html"), "utf8");
    expect(scripts(popup)).toEqual(['<script src="webaios-garde-fond.js">', '<script src="popup.js">']);
    expect(popup.indexOf("webaios-garde-fond.js")).toBeGreaterThan(popup.indexOf("<head>"));

    const options = await readFile(join(c, "pages/options.html"), "utf8");
    expect(scripts(options)).toEqual(['<script src="../webaios-garde-fond.js">', '<script src="options.js">']);
    expect(options.endsWith("<p>options</p><script src=\"options.js\"></script>")).toBe(true);

    const offscreen = await readFile(join(c, "offscreen.HTML"), "utf8");
    expect(offscreen.startsWith('<!DOCTYPE html><script src="webaios-garde-fond.js"></script>')).toBe(true);
    expect(scripts(offscreen)).toEqual(['<script src="webaios-garde-fond.js">', "<script>"]);
  });

  it("un lien symbolique (vers un fichier hors du dossier) est refusé, cible inchangée", async () => {
    const dehors = join(await dossierTemporaire(), "secret");
    await writeFile(dehors, "clé privée");
    const c = await cible();
    const premiere = await source({ "manifest.json": manifesteBase(), "a.js": "ancien" });
    await preparerCopie({ source: premiere, cible: c, dossierGardes: GARDES_PAR_DEFAUT });

    const src = await source({ "manifest.json": manifesteBase(), "a.js": "nouveau" });
    await symlink(dehors, join(src, "lien.txt"));
    const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(analyse.refus.some((r) => r.includes("lien.txt"))).toBe(true);
    expect(await readFile(join(c, "a.js"), "utf8")).toBe("ancien");
    expect(existsSync(join(c, "lien.txt"))).toBe(false);
    expect(await readdir(dirname(c))).toEqual(["essai"]);
  });

  it("2001 fichiers refusés", async () => {
    const fichiers: Record<string, string | object> = { "manifest.json": manifesteBase() };
    for (let i = 0; i < FICHIERS_MAX; i++) fichiers[`f/${i}.txt`] = "x";
    const src = await source(fichiers);
    const c = await cible();
    const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(analyse.refus.length).toBeGreaterThan(0);
    expect(existsSync(c)).toBe(false);
    expect(existsSync(dirname(c)) ? await readdir(dirname(c)) : []).toEqual([]);
  });

  it("une analyse avec refus n'écrit rien et rend les refus", async () => {
    const src = await source({ "manifest.json": manifesteBase({ permissions: ["debugger"] }) });
    const c = await cible();
    const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(analyse.refus).toEqual(["Droit refusé : debugger"]);
    expect(existsSync(c)).toBe(false);
    expect(existsSync(dirname(c)) ? await readdir(dirname(c)) : []).toEqual([]);
  });

  it("les règles DNR sont lues dans le dossier et vérifiées", async () => {
    const src = await source({
      "manifest.json": manifesteBase({
        permissions: ["declarativeNetRequest"],
        declarative_net_request: { rule_resources: [{ id: "r", enabled: true, path: "regles/r.json" }] },
      }),
      "regles/r.json": [{ id: 1, action: { type: "redirect", redirect: { url: "https://x.example" } }, condition: {} }],
    });
    const c = await cible();
    const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(analyse.refus).toEqual(["Règle DNR refusée (redirect) dans regles/r.json, règle 1"]);
    expect(existsSync(c)).toBe(false);
  });

  it("un nom de fichier réservé à WebAiOs est refusé", async () => {
    const src = await source({ "manifest.json": manifesteBase(), "webaios-fond.js": "1" });
    const { analyse } = await preparerCopie({ source: src, cible: await cible(), dossierGardes: GARDES_PAR_DEFAUT });
    expect(analyse.refus.some((r) => r.includes("webaios-fond.js"))).toBe(true);
  });

  it("une seconde copie remplace la première d'un coup (aucun mélange de fichiers)", async () => {
    const c = await cible();
    const premiere = await source({ "manifest.json": manifesteBase(), "a.js": "a", "sous/x.js": "x" });
    await preparerCopie({ source: premiere, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(existsSync(join(c, "a.js"))).toBe(true);

    const seconde = await source({ "manifest.json": manifesteBase({ version: "2.0" }), "b.js": "b" });
    await preparerCopie({ source: seconde, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect((await readdir(c)).sort()).toEqual(["b.js", "manifest.json", ...GARDES].sort());
    expect((await lireJson(join(c, "manifest.json"))).version).toBe("2.0");
    // Ni dossier temporaire ni ancienne copie laissés à côté.
    expect(await readdir(dirname(c))).toEqual(["essai"]);
  });

  it("même source, même empreinte ; un octet changé, autre empreinte", async () => {
    const src = await source({ "manifest.json": manifesteBase(), "a.js": "abc" });
    const e1 = (await preparerCopie({ source: src, cible: await cible(), dossierGardes: GARDES_PAR_DEFAUT })).empreinte;
    const e2 = (await preparerCopie({ source: src, cible: await cible(), dossierGardes: GARDES_PAR_DEFAUT })).empreinte;
    expect(e1).toMatch(/^[0-9a-f]{64}$/);
    expect(e2).toBe(e1);
    await writeFile(join(src, "a.js"), "abd");
    const e3 = (await preparerCopie({ source: src, cible: await cible(), dossierGardes: GARDES_PAR_DEFAUT })).empreinte;
    expect(e3).not.toBe(e1);
  });
});

describe("preparerStore", () => {
  it("preparerStore met le correctif en tête une seule fois même appelé deux fois", async () => {
    const d = await source({
      "manifest.json": manifesteBase({
        content_scripts: [{ matches: ["<all_urls>"], js: ["cs.js"] }, { matches: ["<all_urls>"], css: ["s.css"] }],
      }),
      "cs.js": "",
    });
    await preparerStore(d, GARDES_PAR_DEFAUT);
    await preparerStore(d, GARDES_PAR_DEFAUT);
    const m = await lireJson(join(d, "manifest.json"));
    expect(m.content_scripts[0].js).toEqual(["webaios-correctifs-page.js", "cs.js"]);
    expect(m.content_scripts[1].js).toBeUndefined();
    expect(await readFile(join(d, "webaios-correctifs-page.js"), "utf8")).toBe(
      await readFile(join(GARDES_PAR_DEFAUT, "webaios-correctifs-page.js"), "utf8"),
    );
  });
});

describe("webaios-correctifs-page.js", () => {
  it("redéfinit storage.sync sur storage.local et pose browser, sans effet la seconde fois", async () => {
    const code = await readFile(join(GARDES_PAR_DEFAUT, "webaios-correctifs-page.js"), "utf8");
    const local = { nom: "local" };
    const chrome = { storage: { local, sync: { nom: "sync" } } };
    const ctx: Record<string, unknown> = { chrome };
    ctx.globalThis = ctx;
    runInNewContext(code, ctx);
    expect(chrome.storage.sync).toBe(local);
    expect(ctx.browser).toBe(chrome);
    expect(Object.getOwnPropertyDescriptor(chrome.storage, "sync")?.configurable).toBe(true);
    runInNewContext(code, ctx);
    expect(chrome.storage.sync).toBe(local);
  });
});
