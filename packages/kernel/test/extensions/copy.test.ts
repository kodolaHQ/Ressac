import { describe, it, expect, vi, afterEach } from "vitest";
import { link, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { dirname, join } from "node:path";
import {
  MAX_ENTRIES,
  FILES_MAX,
  DEFAULT_GUARDS,
  cspAgent,
  prepareCopy,
} from "../../src/extensions/copy.js";
import { tempFolder } from "../helpers/temp.js";

// Hooks to simulate a folder modified during the read, or a failing rename.
const brackets = vi.hoisted(() => ({
  apresLstat: null as null | ((p: string) => Promise<void>),
  apresReaddir: null as null | ((p: string) => Promise<void>),
  avantRename: null as null | ((from: string, to: string) => void),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...orig,
    lstat: (async (p: string, ...r: unknown[]) => {
      const v = await (orig.lstat as (...a: unknown[]) => Promise<unknown>)(p, ...r);
      if (brackets.apresLstat) await brackets.apresLstat(p);
      return v;
    }) as typeof orig.lstat,
    readdir: (async (p: string, ...r: unknown[]) => {
      const v = await (orig.readdir as (...a: unknown[]) => Promise<unknown>)(p, ...r);
      if (brackets.apresReaddir) await brackets.apresReaddir(p);
      return v;
    }) as typeof orig.readdir,
    rename: (async (from: string, to: string) => {
      brackets.avantRename?.(from, to);
      return orig.rename(from, to);
    }) as typeof orig.rename,
  };
});
afterEach(() => {
  brackets.apresLstat = null;
  brackets.apresReaddir = null;
  brackets.avantRename = null;
});

const GUARDS = ["webaios-correctifs-page.js", "webaios-garde-page.js", "webaios-garde-fond.js"];

async function write(folder: string, files: Record<string, string | object>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await writeFile(join(folder, path), typeof content === "string" ? content : JSON.stringify(content));
  }
}

const baseManifest = (override: Record<string, unknown> = {}) => ({
  manifest_version: 3,
  name: "Essai",
  version: "1.0",
  ...override,
});

async function source(files: Record<string, string | object>): Promise<string> {
  const d = join(await tempFolder(), "source");
  await mkdir(d);
  await write(d, files);
  return d;
}

async function target(): Promise<string> {
  return join(await tempFolder(), "copies", "essai");
}

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Record<string, any>;

describe("preparerCopie", () => {
  it("the copy has the CSP cspAgent([]) and nothing else from the agent in content_security_policy", async () => {
    const src = await source({
      "manifest.json": baseManifest({
        content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'; connect-src *", sandbox: "x" },
      }),
    });
    const c = await target();
    const { analyse: analysis } = await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    expect(analysis.refus).toEqual([]);
    const m = await readJson(join(c, "manifest.json"));
    expect(m.content_security_policy).toEqual({ extension_pages: cspAgent([]) });
    expect(cspAgent([])).toBe(
      "default-src 'self'; script-src 'self'; object-src 'none'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; form-action 'none'; frame-ancestors 'self'",
    );
  });

  it("with webaios.json { reseau: [\"api.exemple.com\"] }: connect-src contains https:// and wss://api.exemple.com, webaios.json absent from the copy", async () => {
    const src = await source({ "manifest.json": baseManifest(), "webaios.json": { reseau: ["api.exemple.com"] } });
    const c = await target();
    const { analyse: analysis } = await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    expect(analysis.portee.reseau).toEqual(["api.exemple.com"]);
    const m = await readJson(join(c, "manifest.json"));
    expect(m.content_security_policy.extension_pages).toContain("connect-src 'self' https://api.exemple.com wss://api.exemple.com;");
    expect(existsSync(join(c, "webaios.json"))).toBe(false);
  });

  it("key and update_url removed", async () => {
    const src = await source({ "manifest.json": baseManifest({ key: "MIIB...", update_url: "https://x.example/u" }) });
    const c = await target();
    await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    const m = await readJson(join(c, "manifest.json"));
    expect("key" in m).toBe(false);
    expect("update_url" in m).toBe(false);
    expect(m.name).toBe("Essai");
  });

  it("a content_scripts entry declares only WebAiOs files (fixes, guard, scope, one marker per agent file, CSS first); the agent's files stay as they are, the table is at the head of the background guard", async () => {
    // evade.js would close a text wrapper: it is never pasted into another file anymore.
    const evade = "});\ndocument.documentElement.setAttribute('data-evade', '1');\nglobalThis.__webaiosApres(() => {\n";
    const src = await source({
      "manifest.json": baseManifest({
        host_permissions: ["https://h.example/*"],
        content_scripts: [
          { matches: ["https://a.example/*"], js: ["a.js", "b.js"], css: ["s.css"], run_at: "document_start" },
          { matches: ["https://b.example/*"], js: ["c/d.js", "evade.js"] },
          { matches: ["https://b.example/*"], css: ["s.css"] },
        ],
      }),
      "webaios.json": { reseau: ["api.exemple.com"] },
      "a.js": "function double(x) { return 2 * x; }",
      "b.js": "globalThis.resultat = double(21);",
      "c/d.js": "3",
      "evade.js": evade,
      "s.css": "p{}",
      "lisez-moi.txt": "x",
    });
    const c = await target();
    const { analyse: analysis } = await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    expect(analysis.refus).toEqual([]);
    const m = await readJson(join(c, "manifest.json"));
    // Table: each .js and .css file of the agent, sorted; one marker each.
    const table = [["a.js", "js"], ["b.js", "js"], ["c/d.js", "js"], ["evade.js", "js"], ["s.css", "css"]];
    const head = ["webaios-correctifs-page.js", "webaios-garde-page.js", "webaios-portee.js"];
    const markers = (...n: number[]) => n.map((i) => `webaios-fichiers/${i}.js`);
    expect(m.content_scripts).toEqual([
      { matches: ["https://a.example/*"], js: [...head, ...markers(4, 0, 1)], run_at: "document_start" },
      { matches: ["https://b.example/*"], js: [...head, ...markers(2, 3)] },
      { matches: ["https://b.example/*"], js: [...head, ...markers(4)] },
    ]);
    for (let i = 0; i < table.length; i++) {
      expect(await readFile(join(c, `webaios-fichiers/${i}.js`), "utf8")).toBe(`globalThis.__webaiosFichier(${i});\n`);
    }
    expect(existsSync(join(c, "webaios-fichiers/5.js"))).toBe(false);
    // The agent's files: intact, never wrapped nor grouped.
    expect(await readFile(join(c, "evade.js"), "utf8")).toBe(evade);
    expect(existsSync(join(c, "webaios-env"))).toBe(false);
    expect(existsSync(join(c, "webaios-cs-0.js"))).toBe(false);
    // The background injects them by scripting, in the content scripts' sites.
    expect(m.permissions).toEqual(["scripting"]);
    expect(m.host_permissions).toEqual(["https://h.example/*", "https://a.example/*", "https://b.example/*"]);
    const background = await readFile(join(c, "webaios-garde-fond.js"), "utf8");
    expect(background.startsWith(`const __webaiosFichiers = ${JSON.stringify(table)};\n`)).toBe(true);
    expect(background.endsWith(await readFile(join(DEFAULT_GUARDS, "webaios-garde-fond.js"), "utf8"))).toBe(true);
    expect(await readFile(join(c, "webaios-portee.js"), "utf8")).toBe(
      `globalThis.__webaiosPortee(${JSON.stringify({ reseau: ["api.exemple.com"], hotes: analysis.portee.hotes })});\n`,
    );
    for (const g of GUARDS) expect(existsSync(join(c, g)), g).toBe(true);
  });

  it("in a world without a DOM, an entry's files only ask for the context, markers in order; nothing of the agent runs; without an answer, lastError is read and the abandonment is written", async () => {
    const src = await source({
      "manifest.json": baseManifest({ content_scripts: [{ matches: ["https://a.example/*"], js: ["a.js", "b.js"], css: ["s.css"] }] }),
      "a.js": "globalThis.vu = 1;",
      "b.js": "globalThis.vu = 2;",
      "s.css": "p{}",
    });
    const c = await target();
    await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    const m = await readJson(join(c, "manifest.json"));
    const launch = (reply: (msg: unknown, callback: (r: unknown) => void, runtime: Record<string, unknown>) => void) => {
      const timers: (() => void)[] = [];
      const errors: unknown[][] = [];
      const runtime: Record<string, unknown> = {
        id: "x",
        sendMessage: (msg: unknown, callback: (r: unknown) => void) => reply(msg, callback, runtime),
      };
      const ctx: Record<string, unknown> = {
        chrome: { runtime },
        console: { error: (...a: unknown[]) => errors.push(a), log: () => {} },
        setTimeout: (f: () => void) => void timers.push(f),
      };
      ctx.globalThis = ctx;
      for (const f of m.content_scripts[0].js as string[]) runInNewContext(readFileSync(join(c, f), "utf8"), ctx);
      expect(ctx.vu).toBeUndefined();
      // The timers one by one: the request leaves after the markers, the retries after.
      for (let i = 0; i < 100 && timers.length > 0; i++) timers.shift()!();
      return { ctx, erreurs: errors };
    };
    const messages: unknown[] = [];
    const yes = launch((msg, callback) => {
      messages.push(msg);
      callback({ onglet: true });
    });
    expect(messages).toEqual([{ webaios: "contexte", fichiers: [2, 0, 1] }]);
    expect(yes.ctx.vu).toBeUndefined();
    expect(yes.erreurs).toEqual([]);
    // No answer: lastError read, retries, then abandonment written with the reason.
    let attempts = 0;
    const non = launch((_msg, callback, runtime) => {
      attempts++;
      runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
      callback(undefined);
      delete runtime.lastError;
    });
    expect(attempts).toBe(20);
    expect(non.erreurs).toHaveLength(1);
    expect(non.erreurs[0]!.map(String).join(" ")).toContain("Could not establish connection");
  });

  it("a content script in the page's world (world: MAIN) is refused (analysis); a missing script too", async () => {
    const main = await source({
      "manifest.json": baseManifest({ content_scripts: [{ matches: ["https://a.example/*"], js: ["a.js"], world: "MAIN" }] }),
      "a.js": "1",
    });
    expect((await prepareCopy({ source: main, cible: await target(), dossierGardes: DEFAULT_GUARDS })).analyse.refus).toEqual([
      'Script de contenu refusé : world "MAIN" n\'est pas permis',
    ]);
    const src = await source({
      "manifest.json": baseManifest({ content_scripts: [{ matches: ["https://a.example/*"], js: ["a.js", "absent.js", "../a.js"] }] }),
      "a.js": "1",
    });
    const c = await target();
    const { analyse: analysis } = await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    expect(analysis.refus).toEqual(["Script de contenu introuvable : absent.js", "Script de contenu introuvable : ../a.js"]);
    expect(existsSync(c)).toBe(false);
  });

  it("classic service worker: webaios-fond.js does importScripts of both; module: import of both, type module kept", async () => {
    const src = await source({ "manifest.json": baseManifest({ background: { service_worker: "bg/sw.js" } }), "bg/sw.js": "" });
    const c = await target();
    await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    const m = await readJson(join(c, "manifest.json"));
    expect(m.background).toEqual({ service_worker: "webaios-fond.js" });
    const background = await readFile(join(c, "webaios-fond.js"), "utf8");
    expect(background).toContain('importScripts("webaios-garde-fond.js", "bg/sw.js")');
    expect(existsSync(join(c, "bg/sw.js"))).toBe(true);

    const srcM = await source({
      "manifest.json": baseManifest({ background: { service_worker: "sw.js", type: "module" } }),
      "sw.js": "export {}",
    });
    const cM = await target();
    await prepareCopy({ source: srcM, cible: cM, dossierGardes: DEFAULT_GUARDS });
    const mM = await readJson(join(cM, "manifest.json"));
    expect(mM.background).toEqual({ service_worker: "webaios-fond.js", type: "module" });
    const backgroundM = await readFile(join(cM, "webaios-fond.js"), "utf8");
    const imports = [...backgroundM.matchAll(/^import "(.+)";$/gm)].map((x) => x[1]);
    expect(imports).toEqual(["./webaios-garde-fond.js", "./sw.js"]);
  });

  it("without a background: a minimal webaios-fond.js service worker (the guard alone) is declared, for onInstalled and the rulesets", async () => {
    const src = await source({ "manifest.json": baseManifest() });
    const c = await target();
    await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    const m = await readJson(join(c, "manifest.json"));
    expect(m.background).toEqual({ service_worker: "webaios-fond.js" });
    const background = await readFile(join(c, "webaios-fond.js"), "utf8");
    expect(background).toContain('importScripts("webaios-garde-fond.js");');
    expect([...background.matchAll(/importScripts\(/g)]).toHaveLength(1);
  });

  it("the background guard is prefixed to each HTML page (raw bytes, absolute path), the existing scripts stay after", async () => {
    const GUARD = '<script src="/webaios-garde-fond.js"></script>';
    const src = await source({
      "manifest.json": baseManifest(),
      "popup.html": '<!doctype html><html><head><meta charset="utf-8"><script src="popup.js"></script></head><body></body></html>',
      "pages/options.html": "<p>options</p><script src=\"options.js\"></script>",
      "commentaire.html": '<!-- <head> --><head><script src="a.js"></script></head>',
      "base.htm": '<html><base href="x/"><head><script src="a.js"></script></head></html>',
      "offscreen.HTML": "\uFEFF<!DOCTYPE html>\n<script>1</script>",
    });
    await writeFile(join(src, "latin1.html"), Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]));
    const c = await target();
    await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    const scripts = (html: string) => [...html.matchAll(/<script[^>]*>/gi)].map((x) => x[0]);

    const popup = await readFile(join(c, "popup.html"), "utf8");
    expect(popup).toBe('<!doctype html>' + GUARD + '<html><head><meta charset="utf-8"><script src="popup.js"></script></head><body></body></html>');
    expect(scripts(popup)).toEqual(['<script src="/webaios-garde-fond.js">', '<script src="popup.js">']);
    expect(await readFile(join(c, "pages/options.html"), "utf8")).toBe(GUARD + '<p>options</p><script src="options.js"></script>');
    expect(await readFile(join(c, "commentaire.html"), "utf8")).toBe(GUARD + '<!-- <head> --><head><script src="a.js"></script></head>');
    expect(await readFile(join(c, "base.htm"), "utf8")).toBe(GUARD + '<html><base href="x/"><head><script src="a.js"></script></head></html>');
    expect(await readFile(join(c, "offscreen.HTML"), "utf8")).toBe("\uFEFF<!DOCTYPE html>" + GUARD + "\n<script>1</script>");
    expect(await readFile(join(c, "latin1.html"))).toEqual(
      Buffer.concat([Buffer.from(GUARD), Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c, 0x2f, 0x70, 0x3e])]),
    );
  });

  it("files that make a non-HTML document are refused", async () => {
    for (const ext of ["xhtml", "xht", "xml", "xsl", "xslt", "mht", "mhtml", "XHTML"]) {
      const src = await source({ "manifest.json": baseManifest(), [`p.${ext}`]: "<x/>" });
      const c = await target();
      const { analyse: analysis } = await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
      expect(analysis.refus.some((r) => r.includes(`p.${ext}`)), ext).toBe(true);
      expect(existsSync(c)).toBe(false);
    }
  });

  it("an SVG with script is refused, a simple SVG passes", async () => {
    for (const svg of [
      '<svg><SCRIPT href="x.js"/></svg>',
      "<svg><foreignobject><div/></foreignobject></svg>",
      '<svg onload = "x()"></svg>',
      '<svg><a\nONCLICK="x()"/></svg>',
    ]) {
      const src = await source({ "manifest.json": baseManifest(), "i/icone.svg": svg });
      const { analyse: analysis } = await prepareCopy({ source: src, cible: await target(), dossierGardes: DEFAULT_GUARDS });
      expect(analysis.refus.some((r) => r.includes("i/icone.svg")), svg).toBe(true);
    }
    const src = await source({ "manifest.json": baseManifest(), "icone.svg": '<svg><path d="M0 0"/></svg>' });
    const c = await target();
    const { analyse: analysis } = await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    expect(analysis.refus).toEqual([]);
    expect(existsSync(join(c, "icone.svg"))).toBe(true);
  });

  it("SVG: closed rule (namespace prefix, UTF-16, javascript:, entity, invalid bytes), .svgz refused", async () => {
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
    for (const [name, content, pattern] of cas) {
      const src = await source({ "manifest.json": baseManifest() });
      await writeFile(join(src, name), content);
      const c = await target();
      const { analyse: analysis } = await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
      const r = analysis.refus.find((x) => x.includes(name));
      expect(r, name).toBeDefined();
      expect(r, name).toContain(pattern);
      expect(existsSync(c)).toBe(false);
    }
    const icon = await source({
      "manifest.json": baseManifest(),
      "icone.svg": '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>Étoile</title><path fill="#fc0" d="M12 2l3 7h7l-6 4 2 7-6-4-6 4 2-7-6-4h7z"/></svg>',
    });
    const c = await target();
    expect((await prepareCopy({ source: icon, cible: c, dossierGardes: DEFAULT_GUARDS })).analyse.refus).toEqual([]);
    expect(existsSync(join(c, "icone.svg"))).toBe(true);
  });

  it("an HTML page in UTF-16 or UTF-32 (BOM) is refused", async () => {
    for (const bom of [[0xff, 0xfe], [0xfe, 0xff], [0xff, 0xfe, 0x00, 0x00], [0x00, 0x00, 0xfe, 0xff]]) {
      const src = await source({ "manifest.json": baseManifest() });
      await writeFile(join(src, "popup.html"), Buffer.concat([Buffer.from(bom), Buffer.from("<p>x</p>", "utf16le")]));
      const c = await target();
      const { analyse: analysis } = await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
      expect(analysis.refus.some((r) => r.includes("popup.html")), String(bom)).toBe(true);
      expect(existsSync(c)).toBe(false);
    }
  });

  it("background.scripts or background.page refused", async () => {
    for (const background of [{ scripts: ["a.js"] }, { page: "fond.html" }, { service_worker: "sw.js", scripts: ["a.js"] }]) {
      const src = await source({ "manifest.json": baseManifest({ background }), "a.js": "", "sw.js": "", "fond.html": "" });
      const c = await target();
      const { analyse: analysis } = await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
      expect(analysis.refus.length, JSON.stringify(background)).toBeGreaterThan(0);
      expect(existsSync(c)).toBe(false);
    }
  });

  it("more than 32 folder levels refused", async () => {
    const deep = Array.from({ length: 33 }, (_, i) => `d${i}`).join("/");
    const src = await source({ "manifest.json": baseManifest(), [`${deep}/f.js`]: "" });
    const c = await target();
    const { analyse: analysis } = await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    expect(analysis.refus.some((r) => r.includes("32"))).toBe(true);
    expect(existsSync(c)).toBe(false);
    const ok = await source({ "manifest.json": baseManifest(), [`${Array.from({ length: 31 }, (_, i) => `d${i}`).join("/")}/f.js`]: "" });
    expect((await prepareCopy({ source: ok, cible: await target(), dossierGardes: DEFAULT_GUARDS })).analyse.refus).toEqual([]);
  });

  it("more than 5000 entries (folders included) refused", async () => {
    const src = await source({ "manifest.json": baseManifest() });
    for (let i = 0; i < MAX_ENTRIES; i++) await mkdir(join(src, `v${i}`));
    const c = await target();
    const { analyse: analysis } = await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    expect(analysis.refus.some((r) => r.includes(String(MAX_ENTRIES)))).toBe(true);
    expect(existsSync(c)).toBe(false);
  });

  it("a symbolic link (to a file outside the folder) is refused, target unchanged", async () => {
    const outside = join(await tempFolder(), "secret");
    await writeFile(outside, "clé privée");
    const c = await target();
    const first = await source({ "manifest.json": baseManifest(), "a.js": "ancien" });
    await prepareCopy({ source: first, cible: c, dossierGardes: DEFAULT_GUARDS });

    const src = await source({ "manifest.json": baseManifest(), "a.js": "nouveau" });
    await symlink(outside, join(src, "lien.txt"));
    const { analyse: analysis } = await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    expect(analysis.refus.some((r) => r.includes("lien.txt"))).toBe(true);
    expect(await readFile(join(c, "a.js"), "utf8")).toBe("ancien");
    expect(existsSync(join(c, "lien.txt"))).toBe(false);
    expect(await readdir(dirname(c))).toEqual(["essai"]);
  });

  it("2001 files refused", async () => {
    const files: Record<string, string | object> = { "manifest.json": baseManifest() };
    for (let i = 0; i < FILES_MAX; i++) files[`f/${i}.txt`] = "x";
    const src = await source(files);
    const c = await target();
    const { analyse: analysis } = await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    expect(analysis.refus.length).toBeGreaterThan(0);
    expect(existsSync(c)).toBe(false);
    expect(existsSync(dirname(c)) ? await readdir(dirname(c)) : []).toEqual([]);
  });

  it("an analysis with refusals writes nothing and returns the refusals", async () => {
    const src = await source({ "manifest.json": baseManifest({ permissions: ["debugger"] }) });
    const c = await target();
    const { analyse: analysis } = await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    expect(analysis.refus).toEqual(["Droit refusé : debugger"]);
    expect(existsSync(c)).toBe(false);
    expect(existsSync(dirname(c)) ? await readdir(dirname(c)) : []).toEqual([]);
  });

  it("the DNR rules are read in the folder and checked", async () => {
    const src = await source({
      "manifest.json": baseManifest({
        permissions: ["declarativeNetRequest"],
        declarative_net_request: { rule_resources: [{ id: "r", enabled: true, path: "regles/r.json" }] },
      }),
      "regles/r.json": [{ id: 1, action: { type: "redirect", redirect: { url: "https://x.example" } }, condition: {} }],
    });
    const c = await target();
    const { analyse: analysis } = await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    expect(analysis.refus).toEqual(["Règle DNR refusée (redirect) dans regles/r.json, règle 1"]);
    expect(existsSync(c)).toBe(false);
  });

  it("a file name reserved for WebAiOs is refused, whatever the case", async () => {
    for (const name of ["webaios-fond.js", "WebAiOs-Fond.js", "WEBAIOS-GARDE-PAGE.JS", "webaios-fichiers/0.js", "webaios-portee.js", "Webaios-Env/a.js"]) {
      const src = await source({ "manifest.json": baseManifest(), [name]: "1" });
      const { analyse: analysis } = await prepareCopy({ source: src, cible: await target(), dossierGardes: DEFAULT_GUARDS });
      expect(analysis.refus.some((r) => r.includes(name)), name).toBe(true);
    }
  });

  it("a symbolic link in a subfolder is refused", async () => {
    const outside = join(await tempFolder(), "secret");
    await writeFile(outside, "x");
    const src = await source({ "manifest.json": baseManifest(), "a/b/c.js": "" });
    await symlink(outside, join(src, "a/b/lien.js"));
    const c = await target();
    const { analyse: analysis } = await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    expect(analysis.refus.some((r) => r.includes("a/b/lien.js"))).toBe(true);
    expect(existsSync(c)).toBe(false);
  });

  it("a symbolic link to a folder is refused, the root too", async () => {
    const outside = await tempFolder();
    await writeFile(join(outside, "id_ed25519"), "x");
    const src = await source({ "manifest.json": baseManifest() });
    await symlink(outside, join(src, "ssh"));
    const c = await target();
    const { analyse: analysis } = await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    expect(analysis.refus.some((r) => r.includes("ssh"))).toBe(true);
    expect(existsSync(c)).toBe(false);

    const real = await source({ "manifest.json": baseManifest() });
    const rootLink = join(dirname(real), "lien-racine");
    await symlink(real, rootLink);
    const r = await prepareCopy({ source: rootLink, cible: c, dossierGardes: DEFAULT_GUARDS });
    expect(r.analyse.refus.length).toBeGreaterThan(0);
    expect(existsSync(c)).toBe(false);
  });

  it("a hard link is refused", async () => {
    const outside = join(await tempFolder(), "secret");
    await writeFile(outside, "x");
    const src = await source({ "manifest.json": baseManifest() });
    await link(outside, join(src, "physique.txt"));
    const c = await target();
    const { analyse: analysis } = await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    expect(analysis.refus.some((r) => r.includes("physique.txt"))).toBe(true);
    expect(existsSync(c)).toBe(false);
  });

  it("a file replaced by a link after its lstat is refused (nothing is read outside the folder)", async () => {
    const outside = join(await tempFolder(), "secret");
    await writeFile(outside, "clé privée");
    const src = await source({ "manifest.json": baseManifest(), "a.js": "1" });
    brackets.apresLstat = async (p) => {
      if (p === join(src, "a.js")) {
        brackets.apresLstat = null;
        await rm(p);
        await symlink(outside, p);
      }
    };
    const c = await target();
    const { analyse: analysis } = await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    expect(analysis.refus.some((r) => r.includes("a.js"))).toBe(true);
    expect(existsSync(c)).toBe(false);
  });

  it("a file replaced by another file after its lstat is refused", async () => {
    const src = await source({ "manifest.json": baseManifest(), "a.js": "1" });
    brackets.apresLstat = async (p) => {
      if (p === join(src, "a.js")) {
        brackets.apresLstat = null;
        await writeFile(join(src, "b.tmp"), "2");
        await rename(join(src, "b.tmp"), p);
      }
    };
    const { analyse: analysis } = await prepareCopy({ source: src, cible: await target(), dossierGardes: DEFAULT_GUARDS });
    expect(analysis.refus.some((r) => r.includes("a.js"))).toBe(true);
  });

  it("a subfolder replaced by a link during its read is refused", async () => {
    const outside = await tempFolder();
    await writeFile(join(outside, "id_ed25519"), "x");
    const src = await source({ "manifest.json": baseManifest(), "sous/id_ed25519": "leurre" });
    brackets.apresReaddir = async (p) => {
      if (p === join(src, "sous")) {
        brackets.apresReaddir = null;
        await rename(p, join(src, "ailleurs"));
        await symlink(outside, p);
      }
    };
    const c = await target();
    const { analyse: analysis } = await prepareCopy({ source: src, cible: c, dossierGardes: DEFAULT_GUARDS });
    expect(analysis.refus.some((r) => r.includes("sous"))).toBe(true);
    expect(existsSync(c)).toBe(false);
  });

  it("the old copy is put back in place if the second rename fails", async () => {
    const c = await target();
    await prepareCopy({ source: await source({ "manifest.json": baseManifest(), "a.js": "ancien" }), cible: c, dossierGardes: DEFAULT_GUARDS });
    brackets.avantRename = (from, to) => {
      if (from.endsWith(".tmp") && to === c) throw Object.assign(new Error("échec simulé"), { code: "EIO" });
    };
    const second = await source({ "manifest.json": baseManifest(), "b.js": "nouveau" });
    await expect(prepareCopy({ source: second, cible: c, dossierGardes: DEFAULT_GUARDS })).rejects.toThrow("échec simulé");
    expect(await readFile(join(c, "a.js"), "utf8")).toBe("ancien");
    expect(existsSync(join(c, "b.js"))).toBe(false);
    expect(await readdir(dirname(c))).toEqual(["essai"]);
  });

  it("the temporary folder is deleted after a write error", async () => {
    const c = await target();
    const src = await source({ "manifest.json": baseManifest(), "a.js": "" });
    await expect(prepareCopy({ source: src, cible: c, dossierGardes: join(src, "absent") })).rejects.toThrow();
    expect(existsSync(c)).toBe(false);
    expect(await readdir(dirname(c))).toEqual([]);
  });

  it("a second copy replaces the first in one go (no mixing of files)", async () => {
    const c = await target();
    const first = await source({ "manifest.json": baseManifest(), "a.js": "a", "sous/x.js": "x" });
    await prepareCopy({ source: first, cible: c, dossierGardes: DEFAULT_GUARDS });
    expect(existsSync(join(c, "a.js"))).toBe(true);

    const second = await source({ "manifest.json": baseManifest({ version: "2.0" }), "b.js": "b" });
    await prepareCopy({ source: second, cible: c, dossierGardes: DEFAULT_GUARDS });
    expect((await readdir(c)).sort()).toEqual(["b.js", "manifest.json", "webaios-fichiers", "webaios-fond.js", "webaios-portee.js", ...GUARDS].sort());
    expect((await readJson(join(c, "manifest.json"))).version).toBe("2.0");
    // Neither a temporary folder nor an old copy left alongside.
    expect(await readdir(dirname(c))).toEqual(["essai"]);
  });

  it("same source, same hash; one byte changed, another hash", async () => {
    const src = await source({ "manifest.json": baseManifest(), "a.js": "abc" });
    const e1 = (await prepareCopy({ source: src, cible: await target(), dossierGardes: DEFAULT_GUARDS })).empreinte;
    const e2 = (await prepareCopy({ source: src, cible: await target(), dossierGardes: DEFAULT_GUARDS })).empreinte;
    expect(e1).toMatch(/^[0-9a-f]{64}$/);
    expect(e2).toBe(e1);
    await writeFile(join(src, "a.js"), "abd");
    const e3 = (await prepareCopy({ source: src, cible: await target(), dossierGardes: DEFAULT_GUARDS })).empreinte;
    expect(e3).not.toBe(e1);
  });
});

describe("webaios-correctifs-page.js", () => {
  it("redefines storage.sync on storage.local and sets browser, no effect the second time", async () => {
    const code = await readFile(join(DEFAULT_GUARDS, "webaios-correctifs-page.js"), "utf8");
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

describe("localized names (_locales)", () => {
  const localizedManifest = { manifest_version: 3, name: "__MSG_extName__", version: "1.0", default_locale: "en" };

  it("preparerCopie resolves the agent's name from _locales (fr first)", async () => {
    const src = await source({
      "manifest.json": localizedManifest,
      "_locales/en/messages.json": { extName: { message: "Name" } },
      "_locales/fr/messages.json": { extname: { message: "Nom" } },
    });
    const { analyse: analysis } = await prepareCopy({ source: src, cible: await target(), dossierGardes: DEFAULT_GUARDS });
    expect(analysis.nom).toBe("Nom");
  });
});
