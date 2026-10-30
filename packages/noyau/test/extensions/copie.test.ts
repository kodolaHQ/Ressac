import { describe, it, expect, vi, afterEach } from "vitest";
import { link, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { dirname, join } from "node:path";
import {
  ENTREES_MAX,
  FICHIERS_MAX,
  GARDES_PAR_DEFAUT,
  cspAgent,
  preparerCopie,
  preparerStore,
} from "../../src/extensions/copie.js";
import { dossierTemporaire } from "../aide/temporaire.js";

// Crochets pour simuler un dossier modifié pendant la lecture, ou un renommage en échec.
const crochets = vi.hoisted(() => ({
  apresLstat: null as null | ((p: string) => Promise<void>),
  apresReaddir: null as null | ((p: string) => Promise<void>),
  avantRename: null as null | ((de: string, vers: string) => void),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...orig,
    lstat: (async (p: string, ...r: unknown[]) => {
      const v = await (orig.lstat as (...a: unknown[]) => Promise<unknown>)(p, ...r);
      if (crochets.apresLstat) await crochets.apresLstat(p);
      return v;
    }) as typeof orig.lstat,
    readdir: (async (p: string, ...r: unknown[]) => {
      const v = await (orig.readdir as (...a: unknown[]) => Promise<unknown>)(p, ...r);
      if (crochets.apresReaddir) await crochets.apresReaddir(p);
      return v;
    }) as typeof orig.readdir,
    rename: (async (de: string, vers: string) => {
      crochets.avantRename?.(de, vers);
      return orig.rename(de, vers);
    }) as typeof orig.rename,
  };
});
afterEach(() => {
  crochets.apresLstat = null;
  crochets.apresReaddir = null;
  crochets.avantRename = null;
});

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

  it("avec webaios.json { reseau: [\"api.exemple.com\"] } : connect-src contient https:// et wss://api.exemple.com, webaios.json absent de la copie", async () => {
    const src = await source({ "manifest.json": manifesteBase(), "webaios.json": { reseau: ["api.exemple.com"] } });
    const c = await cible();
    const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(analyse.portee.reseau).toEqual(["api.exemple.com"]);
    const m = await lireJson(join(c, "manifest.json"));
    expect(m.content_security_policy.extension_pages).toContain("connect-src 'self' https://api.exemple.com wss://api.exemple.com;");
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

  it("une entrée de deux fichiers devient webaios-cs-0.js : correctifs, garde, portée, puis les deux fichiers dans une seule fonction ; une fonction déclarée dans le premier est appelable du second", async () => {
    const src = await source({
      "manifest.json": manifesteBase({
        host_permissions: ["https://h.example/*"],
        content_scripts: [
          { matches: ["https://a.example/*"], js: ["a.js", "./b.js"], css: ["s.css"], run_at: "document_start" },
          { matches: ["https://b.example/*"], js: ["c/d.js"] },
          { matches: ["https://b.example/*"], css: ["s.css"] },
        ],
      }),
      "webaios.json": { reseau: ["api.exemple.com"] },
      "a.js": "function double(x) { return 2 * x; } // sans fin de ligne",
      "b.js": "\uFEFFglobalThis.resultat = double(21);",
      "c/d.js": "3",
      "s.css": "p{}",
    });
    const c = await cible();
    const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(analyse.refus).toEqual([]);
    const m = await lireJson(join(c, "manifest.json"));
    expect(m.content_scripts[0]).toEqual({ matches: ["https://a.example/*"], js: ["webaios-cs-0.js"], css: ["s.css"], run_at: "document_start" });
    expect(m.content_scripts[1].js).toEqual(["webaios-cs-1.js"]);
    expect(m.content_scripts[2].js).toBeUndefined();
    expect(existsSync(join(c, "webaios-cs-2.js"))).toBe(false);
    for (const g of GARDES) expect(existsSync(join(c, g)), g).toBe(true);
    // Les fichiers de l'agent restent aussi à leur place (executeScript, pages).
    expect(await readFile(join(c, "c/d.js"), "utf8")).toBe("3");

    const correctifs = await readFile(join(GARDES_PAR_DEFAUT, "webaios-correctifs-page.js"), "utf8");
    const garde = await readFile(join(GARDES_PAR_DEFAUT, "webaios-garde-page.js"), "utf8");
    const portee = `globalThis.__webaiosPortee(${JSON.stringify({ reseau: ["api.exemple.com"], hotes: analyse.portee.hotes })});`;
    expect(analyse.portee.hotes).toEqual(["https://a.example/*", "https://b.example/*", "https://h.example/*"]);
    const cs0 = await readFile(join(c, "webaios-cs-0.js"), "utf8");
    const positions = [correctifs, garde, portee, "globalThis.__webaiosApres(() => {", "function double", "globalThis.resultat"].map((x) => cs0.indexOf(x));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    expect(cs0).not.toContain("\uFEFF");
    expect(cs0.trimEnd().endsWith("});")).toBe(true);
    // La portée seule, pour executeScript et registerContentScripts.
    expect(await readFile(join(c, "webaios-portee.js"), "utf8")).toBe(portee + "\n");

    // Exécuté dans un contexte à part, sans DOM : retenu tant que le contexte n'a pas répondu { onglet: true }.
    const lancer = (reponse: unknown) => {
      let repondre: ((r: unknown) => void) | undefined;
      const messages: unknown[] = [];
      const ctx: Record<string, unknown> = {
        chrome: { runtime: { id: "x", sendMessage: (m: unknown, rappel: (r: unknown) => void) => { messages.push(m); repondre = rappel; } } },
        console,
        setTimeout,
      };
      ctx.globalThis = ctx;
      runInNewContext(cs0, ctx);
      expect(ctx.resultat).toBeUndefined();
      repondre!(reponse);
      return { ctx, messages };
    };
    const oui = lancer({ onglet: true });
    expect(oui.messages).toEqual([{ webaios: "contexte" }]);
    expect(oui.ctx.resultat).toBe(42);
    // Dans ce périmètre : `double` n'est pas une variable globale.
    expect(oui.ctx.double).toBeUndefined();
    expect(lancer({ onglet: false }).ctx.resultat).toBeUndefined();
    expect(lancer(undefined).ctx.resultat).toBeUndefined();
  });

  it("chaque fichier .js a son double enveloppé dans webaios-env/ (registerContentScripts)", async () => {
    const src = await source({ "manifest.json": manifesteBase(), "a.js": "globalThis.vu = 1;", "c/d.js": "3", "p.css": "p{}" });
    const c = await cible();
    await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(await readFile(join(c, "webaios-env/a.js"), "utf8")).toBe("globalThis.__webaiosApres(() => {\nglobalThis.vu = 1;\n});\n");
    expect(await readFile(join(c, "webaios-env/c/d.js"), "utf8")).toBe("globalThis.__webaiosApres(() => {\n3\n});\n");
    expect(existsSync(join(c, "webaios-env/p.css"))).toBe(false);
  });

  it("un script de contenu dans le monde de la page (world: MAIN) est refusé (analyse) ; un script introuvable aussi", async () => {
    const main = await source({
      "manifest.json": manifesteBase({ content_scripts: [{ matches: ["https://a.example/*"], js: ["a.js"], world: "MAIN" }] }),
      "a.js": "1",
    });
    expect((await preparerCopie({ source: main, cible: await cible(), dossierGardes: GARDES_PAR_DEFAUT })).analyse.refus).toEqual([
      'Script de contenu refusé : world "MAIN" n\'est pas permis',
    ]);
    const src = await source({
      "manifest.json": manifesteBase({ content_scripts: [{ matches: ["https://a.example/*"], js: ["a.js", "absent.js", "../a.js"] }] }),
      "a.js": "1",
    });
    const c = await cible();
    const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(analyse.refus).toEqual(["Script de contenu introuvable : absent.js", "Script de contenu introuvable : ../a.js"]);
    expect(existsSync(c)).toBe(false);
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

  it("sans fond : un service worker minimal webaios-fond.js (le garde seul) est déclaré, pour onInstalled et les rulesets", async () => {
    const src = await source({ "manifest.json": manifesteBase() });
    const c = await cible();
    await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    const m = await lireJson(join(c, "manifest.json"));
    expect(m.background).toEqual({ service_worker: "webaios-fond.js" });
    const fond = await readFile(join(c, "webaios-fond.js"), "utf8");
    expect(fond).toContain('importScripts("webaios-garde-fond.js");');
    expect([...fond.matchAll(/importScripts\(/g)]).toHaveLength(1);
  });

  it("le garde de fond est préfixé à chaque page HTML (octets bruts, chemin absolu), les scripts existants restent après", async () => {
    const GARDE = '<script src="/webaios-garde-fond.js"></script>';
    const src = await source({
      "manifest.json": manifesteBase(),
      "popup.html": '<!doctype html><html><head><meta charset="utf-8"><script src="popup.js"></script></head><body></body></html>',
      "pages/options.html": "<p>options</p><script src=\"options.js\"></script>",
      "commentaire.html": '<!-- <head> --><head><script src="a.js"></script></head>',
      "base.htm": '<html><base href="x/"><head><script src="a.js"></script></head></html>',
      "offscreen.HTML": "\uFEFF<!DOCTYPE html>\n<script>1</script>",
    });
    await writeFile(join(src, "latin1.html"), Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]));
    const c = await cible();
    await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    const scripts = (html: string) => [...html.matchAll(/<script[^>]*>/gi)].map((x) => x[0]);

    const popup = await readFile(join(c, "popup.html"), "utf8");
    expect(popup).toBe('<!doctype html>' + GARDE + '<html><head><meta charset="utf-8"><script src="popup.js"></script></head><body></body></html>');
    expect(scripts(popup)).toEqual(['<script src="/webaios-garde-fond.js">', '<script src="popup.js">']);
    expect(await readFile(join(c, "pages/options.html"), "utf8")).toBe(GARDE + '<p>options</p><script src="options.js"></script>');
    expect(await readFile(join(c, "commentaire.html"), "utf8")).toBe(GARDE + '<!-- <head> --><head><script src="a.js"></script></head>');
    expect(await readFile(join(c, "base.htm"), "utf8")).toBe(GARDE + '<html><base href="x/"><head><script src="a.js"></script></head></html>');
    expect(await readFile(join(c, "offscreen.HTML"), "utf8")).toBe("\uFEFF<!DOCTYPE html>" + GARDE + "\n<script>1</script>");
    expect(await readFile(join(c, "latin1.html"))).toEqual(
      Buffer.concat([Buffer.from(GARDE), Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c, 0x2f, 0x70, 0x3e])]),
    );
  });

  it("les fichiers qui font un document hors HTML sont refusés", async () => {
    for (const ext of ["xhtml", "xht", "xml", "xsl", "xslt", "mht", "mhtml", "XHTML"]) {
      const src = await source({ "manifest.json": manifesteBase(), [`p.${ext}`]: "<x/>" });
      const c = await cible();
      const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
      expect(analyse.refus.some((r) => r.includes(`p.${ext}`)), ext).toBe(true);
      expect(existsSync(c)).toBe(false);
    }
  });

  it("un SVG avec du script est refusé, un SVG simple passe", async () => {
    for (const svg of [
      '<svg><SCRIPT href="x.js"/></svg>',
      "<svg><foreignobject><div/></foreignobject></svg>",
      '<svg onload = "x()"></svg>',
      '<svg><a\nONCLICK="x()"/></svg>',
    ]) {
      const src = await source({ "manifest.json": manifesteBase(), "i/icone.svg": svg });
      const { analyse } = await preparerCopie({ source: src, cible: await cible(), dossierGardes: GARDES_PAR_DEFAUT });
      expect(analyse.refus.some((r) => r.includes("i/icone.svg")), svg).toBe(true);
    }
    const src = await source({ "manifest.json": manifesteBase(), "icone.svg": '<svg><path d="M0 0"/></svg>' });
    const c = await cible();
    const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(analyse.refus).toEqual([]);
    expect(existsSync(join(c, "icone.svg"))).toBe(true);
  });

  it("SVG : règle fermée (préfixe d'espace de noms, UTF-16, javascript:, entité, octets invalides), .svgz refusé", async () => {
    const cas: [string, Buffer | string, string][] = [
      ["s.svg", '<svg xmlns:s="http://www.w3.org/2000/svg"><s:script href="x.js"/></svg>', "script"],
      ["u16.svg", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<svg><script href="x.js"/></svg>', "utf16le")]), "UTF-16"],
      ["u16sansbom.svg", Buffer.from("<svg/>", "utf16le"), "NUL"],
      ["js.svg", '<svg><a href="JavaScript:x()"/></svg>', "javascript:"],
      ["ent.svg", '<!DOCTYPE svg [<!ENTITY e "x">]><svg/>', "<!entity"],
      ["fo.svg", "<svg><FOREIGNOBJECT/></svg>", "foreignobject"],
      ["on.svg", '<svg><a onfocus="x()"/></svg>', "on…="],
      ["bad.svg", Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xff, 0x2f, 0x3e]), "UTF-8"],
      ["image.svgz", Buffer.from([0x1f, 0x8b, 0x08]), ".svgz"],
    ];
    for (const [nom, contenu, motif] of cas) {
      const src = await source({ "manifest.json": manifesteBase() });
      await writeFile(join(src, nom), contenu);
      const c = await cible();
      const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
      const r = analyse.refus.find((x) => x.includes(nom));
      expect(r, nom).toBeDefined();
      expect(r, nom).toContain(motif);
      expect(existsSync(c)).toBe(false);
    }
    const icone = await source({
      "manifest.json": manifesteBase(),
      "icone.svg": '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>Étoile</title><path fill="#fc0" d="M12 2l3 7h7l-6 4 2 7-6-4-6 4 2-7-6-4h7z"/></svg>',
    });
    const c = await cible();
    expect((await preparerCopie({ source: icone, cible: c, dossierGardes: GARDES_PAR_DEFAUT })).analyse.refus).toEqual([]);
    expect(existsSync(join(c, "icone.svg"))).toBe(true);
  });

  it("une page HTML en UTF-16 ou UTF-32 (BOM) est refusée", async () => {
    for (const bom of [[0xff, 0xfe], [0xfe, 0xff], [0xff, 0xfe, 0x00, 0x00], [0x00, 0x00, 0xfe, 0xff]]) {
      const src = await source({ "manifest.json": manifesteBase() });
      await writeFile(join(src, "popup.html"), Buffer.concat([Buffer.from(bom), Buffer.from("<p>x</p>", "utf16le")]));
      const c = await cible();
      const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
      expect(analyse.refus.some((r) => r.includes("popup.html")), String(bom)).toBe(true);
      expect(existsSync(c)).toBe(false);
    }
  });

  it("background.scripts ou background.page refusés", async () => {
    for (const background of [{ scripts: ["a.js"] }, { page: "fond.html" }, { service_worker: "sw.js", scripts: ["a.js"] }]) {
      const src = await source({ "manifest.json": manifesteBase({ background }), "a.js": "", "sw.js": "", "fond.html": "" });
      const c = await cible();
      const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
      expect(analyse.refus.length, JSON.stringify(background)).toBeGreaterThan(0);
      expect(existsSync(c)).toBe(false);
    }
  });

  it("plus de 32 niveaux de dossiers refusés", async () => {
    const profond = Array.from({ length: 33 }, (_, i) => `d${i}`).join("/");
    const src = await source({ "manifest.json": manifesteBase(), [`${profond}/f.js`]: "" });
    const c = await cible();
    const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(analyse.refus.some((r) => r.includes("32"))).toBe(true);
    expect(existsSync(c)).toBe(false);
    const ok = await source({ "manifest.json": manifesteBase(), [`${Array.from({ length: 31 }, (_, i) => `d${i}`).join("/")}/f.js`]: "" });
    expect((await preparerCopie({ source: ok, cible: await cible(), dossierGardes: GARDES_PAR_DEFAUT })).analyse.refus).toEqual([]);
  });

  it("plus de 5000 entrées (dossiers compris) refusées", async () => {
    const src = await source({ "manifest.json": manifesteBase() });
    for (let i = 0; i < ENTREES_MAX; i++) await mkdir(join(src, `v${i}`));
    const c = await cible();
    const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(analyse.refus.some((r) => r.includes(String(ENTREES_MAX)))).toBe(true);
    expect(existsSync(c)).toBe(false);
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

  it("un nom de fichier réservé à WebAiOs est refusé, quelle que soit la casse", async () => {
    for (const nom of ["webaios-fond.js", "WebAiOs-Fond.js", "WEBAIOS-GARDE-PAGE.JS", "webaios-cs-0.js", "webaios-portee.js", "Webaios-Env/a.js"]) {
      const src = await source({ "manifest.json": manifesteBase(), [nom]: "1" });
      const { analyse } = await preparerCopie({ source: src, cible: await cible(), dossierGardes: GARDES_PAR_DEFAUT });
      expect(analyse.refus.some((r) => r.includes(nom)), nom).toBe(true);
    }
  });

  it("un lien symbolique dans un sous-dossier est refusé", async () => {
    const dehors = join(await dossierTemporaire(), "secret");
    await writeFile(dehors, "x");
    const src = await source({ "manifest.json": manifesteBase(), "a/b/c.js": "" });
    await symlink(dehors, join(src, "a/b/lien.js"));
    const c = await cible();
    const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(analyse.refus.some((r) => r.includes("a/b/lien.js"))).toBe(true);
    expect(existsSync(c)).toBe(false);
  });

  it("un lien symbolique vers un dossier est refusé, la racine aussi", async () => {
    const dehors = await dossierTemporaire();
    await writeFile(join(dehors, "id_ed25519"), "x");
    const src = await source({ "manifest.json": manifesteBase() });
    await symlink(dehors, join(src, "ssh"));
    const c = await cible();
    const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(analyse.refus.some((r) => r.includes("ssh"))).toBe(true);
    expect(existsSync(c)).toBe(false);

    const vrai = await source({ "manifest.json": manifesteBase() });
    const lienRacine = join(dirname(vrai), "lien-racine");
    await symlink(vrai, lienRacine);
    const r = await preparerCopie({ source: lienRacine, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(r.analyse.refus.length).toBeGreaterThan(0);
    expect(existsSync(c)).toBe(false);
  });

  it("un lien physique est refusé", async () => {
    const dehors = join(await dossierTemporaire(), "secret");
    await writeFile(dehors, "x");
    const src = await source({ "manifest.json": manifesteBase() });
    await link(dehors, join(src, "physique.txt"));
    const c = await cible();
    const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(analyse.refus.some((r) => r.includes("physique.txt"))).toBe(true);
    expect(existsSync(c)).toBe(false);
  });

  it("un fichier remplacé par un lien après son lstat est refusé (rien n'est lu hors du dossier)", async () => {
    const dehors = join(await dossierTemporaire(), "secret");
    await writeFile(dehors, "clé privée");
    const src = await source({ "manifest.json": manifesteBase(), "a.js": "1" });
    crochets.apresLstat = async (p) => {
      if (p === join(src, "a.js")) {
        crochets.apresLstat = null;
        await rm(p);
        await symlink(dehors, p);
      }
    };
    const c = await cible();
    const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(analyse.refus.some((r) => r.includes("a.js"))).toBe(true);
    expect(existsSync(c)).toBe(false);
  });

  it("un fichier remplacé par un autre fichier après son lstat est refusé", async () => {
    const src = await source({ "manifest.json": manifesteBase(), "a.js": "1" });
    crochets.apresLstat = async (p) => {
      if (p === join(src, "a.js")) {
        crochets.apresLstat = null;
        await writeFile(join(src, "b.tmp"), "2");
        await rename(join(src, "b.tmp"), p);
      }
    };
    const { analyse } = await preparerCopie({ source: src, cible: await cible(), dossierGardes: GARDES_PAR_DEFAUT });
    expect(analyse.refus.some((r) => r.includes("a.js"))).toBe(true);
  });

  it("un sous-dossier remplacé par un lien pendant sa lecture est refusé", async () => {
    const dehors = await dossierTemporaire();
    await writeFile(join(dehors, "id_ed25519"), "x");
    const src = await source({ "manifest.json": manifesteBase(), "sous/id_ed25519": "leurre" });
    crochets.apresReaddir = async (p) => {
      if (p === join(src, "sous")) {
        crochets.apresReaddir = null;
        await rename(p, join(src, "ailleurs"));
        await symlink(dehors, p);
      }
    };
    const c = await cible();
    const { analyse } = await preparerCopie({ source: src, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(analyse.refus.some((r) => r.includes("sous"))).toBe(true);
    expect(existsSync(c)).toBe(false);
  });

  it("l'ancienne copie est remise en place si le second renommage échoue", async () => {
    const c = await cible();
    await preparerCopie({ source: await source({ "manifest.json": manifesteBase(), "a.js": "ancien" }), cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    crochets.avantRename = (de, vers) => {
      if (de.endsWith(".tmp") && vers === c) throw Object.assign(new Error("échec simulé"), { code: "EIO" });
    };
    const seconde = await source({ "manifest.json": manifesteBase(), "b.js": "nouveau" });
    await expect(preparerCopie({ source: seconde, cible: c, dossierGardes: GARDES_PAR_DEFAUT })).rejects.toThrow("échec simulé");
    expect(await readFile(join(c, "a.js"), "utf8")).toBe("ancien");
    expect(existsSync(join(c, "b.js"))).toBe(false);
    expect(await readdir(dirname(c))).toEqual(["essai"]);
  });

  it("le dossier temporaire est supprimé après une erreur d'écriture", async () => {
    const c = await cible();
    const src = await source({ "manifest.json": manifesteBase(), "a.js": "" });
    await expect(preparerCopie({ source: src, cible: c, dossierGardes: join(src, "absent") })).rejects.toThrow();
    expect(existsSync(c)).toBe(false);
    expect(await readdir(dirname(c))).toEqual([]);
  });

  it("une seconde copie remplace la première d'un coup (aucun mélange de fichiers)", async () => {
    const c = await cible();
    const premiere = await source({ "manifest.json": manifesteBase(), "a.js": "a", "sous/x.js": "x" });
    await preparerCopie({ source: premiere, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect(existsSync(join(c, "a.js"))).toBe(true);

    const seconde = await source({ "manifest.json": manifesteBase({ version: "2.0" }), "b.js": "b" });
    await preparerCopie({ source: seconde, cible: c, dossierGardes: GARDES_PAR_DEFAUT });
    expect((await readdir(c)).sort()).toEqual(["b.js", "manifest.json", "webaios-env", "webaios-fond.js", "webaios-portee.js", ...GARDES].sort());
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
    const renommages: string[] = [];
    crochets.avantRename = (_de, vers) => void renommages.push(vers);
    await preparerStore(d, GARDES_PAR_DEFAUT);
    await preparerStore(d, GARDES_PAR_DEFAUT);
    expect(renommages.filter((v) => v === join(d, "manifest.json"))).toHaveLength(2);
    expect((await readdir(d)).sort()).toEqual(["cs.js", "manifest.json", "webaios-correctifs-page.js", "webaios-fond.js"]);
    const m = await lireJson(join(d, "manifest.json"));
    expect(m.content_scripts[0].js).toEqual(["webaios-correctifs-page.js", "cs.js"]);
    expect(m.content_scripts[1].js).toBeUndefined();
    expect(await readFile(join(d, "webaios-correctifs-page.js"), "utf8")).toBe(
      await readFile(join(GARDES_PAR_DEFAUT, "webaios-correctifs-page.js"), "utf8"),
    );
  });
});

describe("preparerStore : fond minimal", () => {
  it("sans fond : un service worker minimal est déclaré (idempotent) ; avec un fond, rien ne change", async () => {
    const d = await source({ "manifest.json": manifesteBase({ declarative_net_request: { rule_resources: [{ id: "r", enabled: true, path: "r.json" }] } }), "r.json": "[]" });
    await preparerStore(d, GARDES_PAR_DEFAUT);
    await preparerStore(d, GARDES_PAR_DEFAUT);
    const m = await lireJson(join(d, "manifest.json"));
    expect(m.background).toEqual({ service_worker: "webaios-fond.js" });
    const fond = await readFile(join(d, "webaios-fond.js"), "utf8");
    expect(fond).not.toContain("importScripts");
    expect(fond.trim().length).toBeGreaterThan(0);

    const avec = await source({ "manifest.json": manifesteBase({ background: { service_worker: "sw.js", type: "module" } }), "sw.js": "" });
    await preparerStore(avec, GARDES_PAR_DEFAUT);
    expect((await lireJson(join(avec, "manifest.json"))).background).toEqual({ service_worker: "sw.js", type: "module" });
    expect(existsSync(join(avec, "webaios-fond.js"))).toBe(false);
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
