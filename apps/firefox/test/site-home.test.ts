import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cspAccueilSite, FICHIER_ACCUEIL_MAX as ELECTRON_FICHIER_MAX } from "../../navigateur/src/main/sites/accueil";
import { chargerImage, REDIRECTIONS_IMAGE as ELECTRON_REDIRECTIONS, type OuvrirRequete } from "../../navigateur/src/main/image-distante";
import { AFFICHAGE_REFUSE } from "../chrome/window/widget-frame";
import { FICHIER_ACCUEIL_MAX, HOME_BRIDGE, HOME_TYPES, REDIRECTIONS_IMAGE, cspAccueilFirefox, forgetHome, homeServed, loadImage, serveHome, type OpenRequest } from "../chrome/store/site-home";

let root: string;
let data: string;
/** What the resource:// substitutions received: name → [folder, flags] (null: removed). */
const substitutions = new Map<string, [string, number] | null>();
let uuids = 0;

// The module runs as chrome in Firefox (IOUtils, PathUtils, Services, Cc, Ci): here, the same on node:fs.
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "webaios-site-home-")));
  writeFileSync(join(root, "secret.txt"), "secret du Mac");
  Object.assign(globalThis as any, {
    PathUtils: { join: (...parts: string[]) => join(...parts) },
    IOUtils: {
      stat: async (p: string) => {
        const s = statSync(p);
        return { lastModified: s.mtimeMs, size: s.size, type: s.isFile() ? "regular" : s.isDirectory() ? "directory" : "other" };
      },
      read: async (p: string, o?: { maxBytes?: number }) => new Uint8Array(readFileSync(p)).subarray(0, o?.maxBytes),
      write: async (p: string, b: Uint8Array) => void writeFileSync(p, b),
      writeUTF8: async (p: string, t: string) => void writeFileSync(p, t),
      makeDirectory: async (p: string) => void mkdirSync(p, { recursive: true }),
      getChildren: async (p: string) => readdirSync(p).map((n) => join(p, n)),
      remove: async (p: string) => rmSync(p, { recursive: true, force: true }),
    },
    Ci: { nsIFile: "nsIFile", nsIResProtocolHandler: "nsIResProtocolHandler", nsISubstitutingProtocolHandler: { ALLOW_CONTENT_ACCESS: 1 } },
    Cc: {
      "@mozilla.org/file/local;1": {
        createInstance: () => {
          let p = "";
          return {
            initWithPath: (x: string) => void (p = x),
            normalize: () => void (p = realpathSync(p)),
            isSymlink: () => lstatSync(p).isSymbolicLink(),
            get path() {
              return p;
            },
          };
        },
      },
    },
    ChromeUtils: { importESModule: () => ({ FileUtils: { File: class { constructor(public path: string) {} } } }) },
    Services: {
      io: {
        getProtocolHandler: () => ({
          QueryInterface: () => ({
            setSubstitutionWithFlags: (n: string, uri: { spec: string }, flags: number) => substitutions.set(n, [uri.spec, flags]),
            setSubstitution: (n: string, uri: null) => substitutions.set(n, uri),
          }),
        }),
        newFileURI: (f: { path: string }) => ({ spec: `file://${f.path}` }),
      },
      uuid: { generateUUID: () => ({ toString: () => `{${(++uuids).toString(16).padStart(8, "0")}-1111-4222-8333-444455556666}` }) },
    },
  });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A fresh data dir with app `id`'s home files (path → content). */
function app(files: Record<string, string | Buffer>, id = "vidola", folder = id): string {
  data = join(root, `d${++n}`);
  const home = join(data, "espace", "sites", folder, "accueil");
  mkdirSync(home, { recursive: true });
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(home, p, ".."), { recursive: true });
    writeFileSync(join(home, p), c);
  }
  return home;
}
/** The token of a served URL (`resource://webaios-site-<id>-<token>/index.html`): its copy's folder. */
const tokenOf = (url: string, id = "vidola") => new URL(url).host.slice(`webaios-site-${id}-`.length);
/** The files of the served copy, relative to its `<token>/` folder. */
function served(url: string, id = "vidola"): string[] {
  const dir = join(data, "webaios-sites", id, tokenOf(url, id));
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name), `${rel}${e.name}/`) : out.push(`${rel}${e.name}`);
  };
  walk(dir, "");
  return out.sort();
}
const copied = (url: string, p: string, id = "vidola") => readFileSync(join(data, "webaios-sites", id, tokenOf(url, id), p), "utf8");

describe("homeServed", () => {
  it("puts the CSP meta, the widgets' guard, then the bridge, after the doctype", () => {
    const s = homeServed("<!doctype html><title>Accueil</title><p>x</p>", "vidola");
    const meta = `<meta http-equiv="Content-Security-Policy" content="${cspAccueilFirefox("vidola")}">`;
    expect(s.startsWith(`<!doctype html>${meta}<script>`)).toBe(true);
    const guard = s.indexOf("trustedTypes");
    const bridge = s.indexOf(HOME_BRIDGE);
    expect(guard).toBeGreaterThan(meta.length);
    expect(bridge).toBeGreaterThan(guard);
    expect(s.indexOf("<title>Accueil</title>")).toBe(bridge + HOME_BRIDGE.length);
  });

  it("is AFFICHAGE_REFUSE for a page with a network hint", () => {
    expect(homeServed('<!doctype html><link rel="preload" href="https://x.test/">', "vidola")).toBe(AFFICHAGE_REFUSE);
  });
});

describe("drift from Electron", () => {
  it("cspAccueilFirefox is cspAccueilSite with resource://webaios-site-<id>", () => {
    for (const id of ["vidola", "mon-site-2"]) expect(cspAccueilFirefox(id)).toBe(cspAccueilSite(id).replaceAll(`webaios-site://${id}`, `resource://webaios-site-${id}`));
    expect(cspAccueilFirefox("vidola")).toContain("img-src data: resource://webaios-site-vidola;");
  });

  it("the limits are Electron's", () => {
    expect(FICHIER_ACCUEIL_MAX).toBe(ELECTRON_FICHIER_MAX);
    expect(REDIRECTIONS_IMAGE).toBe(ELECTRON_REDIRECTIONS);
  });

  it("loadImage answers as chargerImage on the same requests", async () => {
    // A fake server: path → [status, headers, body] or a redirect; the log of what each loader asked for.
    const routes: Record<string, { status: number; headers: Record<string, string>; body?: string }> = {
      "/a.png": { status: 200, headers: { "content-type": "image/png" }, body: "PNG" },
      "/r": { status: 302, headers: { location: "/a.png" } },
      "/out": { status: 302, headers: { location: "https://pub.test/a.png" } },
      "/html": { status: 200, headers: { "content-type": "text/html" }, body: "<p>" },
      "/big": { status: 200, headers: { "content-type": "image/png" }, body: "x".repeat(20) },
      "/404": { status: 404, headers: { "content-type": "image/png" } },
      ...Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`/l${i}`, { status: 302, headers: { location: `/l${i + 1}` } }])),
    };
    const fake = (log: string[], chunk: (s: string) => unknown) => (url: string) => {
      const on: Record<string, ((...a: any[]) => void)[]> = {};
      let follow = false;
      const go = (u: string): void => {
        log.push(u);
        const r = routes[new URL(u).pathname] ?? { status: 404, headers: {} };
        if (r.headers.location) {
          follow = false;
          const to = new URL(r.headers.location, u).href;
          on.redirect?.forEach((cb) => cb(r.status, "GET", to));
          if (follow) return go(to);
          return;
        }
        const ron: Record<string, ((...a: any[]) => void)[]> = {};
        on.response?.forEach((cb) => cb({ statusCode: r.status, headers: r.headers, on: (e: string, cb: () => void) => void (ron[e] ??= []).push(cb) }));
        if (r.body) ron.data?.forEach((cb) => cb(chunk(r.body!)));
        ron.end?.forEach((cb) => cb());
      };
      return {
        on: (e: string, cb: () => void) => void (on[e] ??= []).push(cb),
        followRedirect: () => void (follow = true),
        abort: () => {},
        end: () => go(url),
      };
    };
    const o = { permise: (u: string) => new URL(u).hostname === "site.test", cookies: true, max: 10 };
    for (const p of ["/a.png", "/r", "/out", "/html", "/big", "/404", "/l0"]) {
      const url = `https://site.test${p}`;
      const ours: string[] = [];
      const theirs: string[] = [];
      const a = await loadImage(fake(ours, (s) => new TextEncoder().encode(s)) as unknown as OpenRequest, url, o);
      const b = await chargerImage(fake(theirs, (s) => Buffer.from(s)) as unknown as OuvrirRequete, url, o);
      expect(a && { type: a.type, corps: Buffer.from(a.corps).toString() }, p).toEqual(b && { type: b.type, corps: b.corps.toString() });
      expect(ours, p).toEqual(theirs);
    }
  });
});

describe("serveHome: a hostile home folder (Review Focus 3)", () => {
  beforeEach(() => substitutions.clear());

  it("copies the home, its .html through homeServed, and points resource://webaios-site-<id>/ at the copies", async () => {
    app({ "index.html": "<!doctype html><p>accueil</p>", "img/logo.png": Buffer.from([1, 2, 3]), "app.js": "let x;" });
    const url = await serveHome(data, "vidola");
    // A random token in the host, the substitution straight at its folder: nothing above it to guess.
    expect(url).toMatch(/^resource:\/\/webaios-site-vidola-[0-9a-f]{32}\/index\.html$/);
    const host = new URL(url!).host;
    expect(served(url!)).toEqual(["app.js", "img/logo.png", "index.html"]);
    expect(copied(url!, "index.html")).toBe(homeServed("<!doctype html><p>accueil</p>", host.slice("webaios-site-".length)));
    expect(copied(url!, "index.html")).toContain(`img-src data: resource://${host};`);
    expect(copied(url!, "app.js")).toBe("let x;");
    expect(substitutions.get(host)).toEqual([`file://${join(data, "webaios-sites", "vidola", tokenOf(url!))}`, 1]);
    expect(substitutions.has("webaios-site-vidola")).toBe(false);
    // Served again: a new token; the previous substitution and folder are gone.
    const again = await serveHome(data, "vidola");
    expect(new URL(again!).host).not.toBe(host);
    expect(substitutions.get(host)).toBeNull();
    expect(readdirSync(join(data, "webaios-sites", "vidola"))).toEqual([tokenOf(again!)]);
    // « Supprimer »: the substitution and the copies go.
    await forgetHome(data, "vidola");
    expect(substitutions.get(new URL(again!).host)).toBeNull();
    expect(existsSync(join(data, "webaios-sites", "vidola"))).toBe(false);
  });

  it("two serves started back to back (the agent writing several files): the last one works, nothing stale is left", async () => {
    app({ "index.html": "<p>accueil</p>", "img/logo.png": Buffer.from([1]), "a/b/c.js": "1" });
    const [first, second] = await Promise.all([serveHome(data, "vidola"), serveHome(data, "vidola")]);
    expect(second).toMatch(/^resource:\/\/webaios-site-vidola-[0-9a-f]{32}\/index\.html$/);
    expect(served(second!)).toEqual(["a/b/c.js", "img/logo.png", "index.html"]);
    expect(readdirSync(join(data, "webaios-sites", "vidola"))).toEqual([tokenOf(second!)]);
    const live = [...substitutions].filter(([name, v]) => name.startsWith("webaios-site-vidola-") && v !== null).map(([name]) => name);
    expect(live).toEqual([new URL(second!).host]);
    if (first) expect(substitutions.get(new URL(first).host)).toBeNull();
  });

  it("never serves a symbolic link to a file of the Mac", async () => {
    const home = app({ "index.html": "<p>accueil</p>" });
    symlinkSync(join(root, "secret.txt"), join(home, "secret.txt"));
    mkdirSync(join(home, "sous"));
    symlinkSync(join(root, "secret.txt"), join(home, "sous", "lien.html"));
    const url = await serveHome(data, "vidola");
    expect(served(url!)).toEqual(["index.html"]);
  });

  it("never serves an accueil folder that is a link", async () => {
    app({}, "vidola");
    const elsewhere = join(root, `ailleurs-${n}`);
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "index.html"), "<p>dehors</p>");
    rmSync(join(data, "espace", "sites", "vidola", "accueil"), { recursive: true });
    symlinkSync(elsewhere, join(data, "espace", "sites", "vidola", "accueil"));
    expect(await serveHome(data, "vidola")).toBeNull();
    expect(existsSync(join(data, "webaios-sites"))).toBe(false);
  });

  it("refuses a file of 2 MB + 1 and a hidden segment (.cache/x.js, .x)", async () => {
    app({ "index.html": "<p>accueil</p>", "gros.png": Buffer.alloc(FICHIER_ACCUEIL_MAX + 1), "juste.png": Buffer.alloc(FICHIER_ACCUEIL_MAX), ".cache/x.js": "secret", ".x": "secret" });
    const url = await serveHome(data, "vidola");
    expect(served(url!)).toEqual(["index.html", "juste.png"]);
  });

  it("copies only Electron's served types (TYPES in main/sites/accueil.ts), nothing else", async () => {
    app({ "index.html": "<p>accueil</p>", "page.HTML": "<p>p</p>", "x.svg": "<svg/>", "a.js": "1", "x.xhtml": "<x/>", "x.xht": "<x/>", "x.htm": "<p/>", "x.shtml": "<p/>", "x.xml": "<x/>", "sans": "x", "x.exe": "x" });
    const url = await serveHome(data, "vidola");
    expect(served(url!)).toEqual(["a.js", "index.html", "page.HTML", "x.svg"]);
    expect(copied(url!, "page.HTML")).toContain("Content-Security-Policy");
  });

  it("the copied types are Electron's TYPES (drift)", () => {
    const source = readFileSync(join(__dirname, "../../navigateur/src/main/sites/accueil.ts"), "utf8");
    const block = source.slice(source.indexOf("const TYPES"), source.indexOf("};", source.indexOf("const TYPES")));
    expect([...HOME_TYPES].sort()).toEqual([...block.matchAll(/"(\.[a-z0-9]+)":/g)].map((m) => m[1]).sort());
  });

  it("serves AFFICHAGE_REFUSE for an index.html with <link>", async () => {
    app({ "index.html": '<!doctype html><link rel="prefetch" href="https://x.test/"><p>accueil</p>' });
    const url = await serveHome(data, "vidola");
    expect(copied(url!, "index.html")).toBe(AFFICHAGE_REFUSE);
  });

  it("never finds a « Vidola » folder for the id « vidola », nor a bad id", async () => {
    app({ "index.html": "<p>accueil</p>" }, "vidola", "Vidola");
    expect(await serveHome(data, "vidola")).toBeNull();
    for (const id of ["Vidola", "../vidola", ""]) expect(await serveHome(data, id)).toBeNull();
  });

  it("keeps the copies inside <dataDir>/webaios-sites: a copies folder that is a link is refused", async () => {
    app({ "index.html": "<p>accueil</p>" });
    const out = join(root, `copies-dehors-${n}`);
    mkdirSync(out);
    mkdirSync(join(data, "webaios-sites"));
    symlinkSync(out, join(data, "webaios-sites", "vidola"));
    expect(await serveHome(data, "vidola")).toBeNull();
    expect(readdirSync(out)).toEqual([]);
  });

  it("is null without an index.html", async () => {
    app({ "autre.html": "<p>x</p>" });
    expect(await serveHome(data, "vidola")).toBeNull();
  });
});
