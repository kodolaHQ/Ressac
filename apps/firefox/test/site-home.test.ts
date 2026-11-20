import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { displayDenied } from "../chrome/window/widget-frame";
import { HOME_ENTRIES_MAX, HOME_FILE_MAX, HOME_BRIDGE, cspFirefoxHome, forgetHome, homeServed, loadImage, serveHome as serve, type OpenRequest } from "../chrome/store/site-home";
import { copyHomeRequest } from "../host/home-copy";
import { framesKindDir, framesOrigin } from "../chrome/window/frames-root";

let root: string;
let data: string;
/** What the resource:// substitutions received: name → [folder, flags] (null: removed). */
const substitutions = new Map<string, [string, number] | null>();
let uuids = 0;

// The module runs as chrome in Firefox (IOUtils, PathUtils, Services, Cc, Ci): here, the same on node:fs.
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ressac-site-home-")));
  writeFileSync(join(root, "secret.txt"), "secret du Mac");
  Object.assign(globalThis as any, {
    PathUtils: { join: (...parts: string[]) => join(...parts), get profileDir() { return data; } },
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

/** serveHome with the host's real copy, as host.ts wires it. */
const serveHome = (dataDir: string, id: string) => serve(dataDir, id, (id, token) => copyHomeRequest(framesKindDir("sites"), join(dataDir, "workspace", "sites"), { id, token }));

let n = 0;
/** A fresh data dir with app `id`'s home files (path → content). */
function app(files: Record<string, string | Buffer>, id = "vidola", folder = id): string {
  data = join(root, `d${++n}`);
  const home = join(data, "workspace", "sites", folder, "home");
  mkdirSync(home, { recursive: true });
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(home, p, ".."), { recursive: true });
    writeFileSync(join(home, p), c);
  }
  return home;
}
/** The key of a served URL (`<framesOrigin>/sites/<id>-<token>/index.html`): its copy's folder name. */
const keyOf = (url: string) => new URL(url).pathname.split("/")[2]!;
/** The files of the served copy, relative to its key folder. */
function served(url: string): string[] {
  const dir = join(framesKindDir("sites"), keyOf(url));
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name), `${rel}${e.name}/`) : out.push(`${rel}${e.name}`);
  };
  walk(dir, "");
  return out.sort();
}
const copied = (url: string, p: string) => readFileSync(join(framesKindDir("sites"), keyOf(url), p), "utf8");

describe("homeServed", () => {
  it("puts the CSP meta, the widgets' guard, then the bridge, after the doctype", () => {
    const s = homeServed("<!doctype html><title>Accueil</title><p>x</p>", "vidola");
    const meta = `<meta http-equiv="Content-Security-Policy" content="${cspFirefoxHome("vidola")}">`;
    expect(s.startsWith(`<!doctype html>${meta}<script>`)).toBe(true);
    const guard = s.indexOf("trustedTypes");
    const bridge = s.indexOf(HOME_BRIDGE);
    expect(guard).toBeGreaterThan(meta.length);
    expect(bridge).toBeGreaterThan(guard);
    expect(s.indexOf("<title>Accueil</title>")).toBe(bridge + HOME_BRIDGE.length);
  });

  it("is DISPLAY_DENIED for a page with a network hint", () => {
    expect(homeServed('<!doctype html><link rel="preload" href="https://x.test/">', "vidola")).toBe(displayDenied());
  });
});

describe("site home resources", () => {
  it("cspFirefoxHome allows images from the site's resource:// origin only", () => {
    const csp = cspFirefoxHome("vidola-abc");
    for (const d of ["script-src", "style-src", "img-src", "font-src"]) expect(csp).toContain(`${d} ${d === "script-src" || d === "style-src" ? "'unsafe-inline'" : "data:"} ${framesOrigin()}/sites/vidola-abc/`);
    expect(csp).not.toContain("ressac-site-");
  });

  it("loadImage follows permitted redirects and keeps only small images", async () => {
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
    const o = { allowed: (u: string) => new URL(u).hostname === "site.test", cookies: true, max: 10 };
    const got: unknown[] = [];
    for (const p of ["/a.png", "/r", "/out", "/html", "/big", "/404", "/l0"]) {
      const log: string[] = [];
      const a = await loadImage(fake(log, (s) => new TextEncoder().encode(s)) as unknown as OpenRequest, `https://site.test${p}`, o);
      got.push([p, a && { type: a.type, body: Buffer.from(a.body).toString() }, log.length]);
    }
    const png = { type: "image/png", body: "PNG" };
    // Path, image kept, requests made: a redirect to another host, a non-image, an oversized body, a 404 and a redirect loop give nothing.
    expect(got).toEqual([["/a.png", png, 1], ["/r", png, 2], ["/out", null, 1], ["/html", null, 1], ["/big", null, 1], ["/404", null, 1], ["/l0", null, 4]]);
  });
});

describe("serveHome: a hostile home folder (Review Focus 3)", () => {
  beforeEach(() => substitutions.clear());

  it("copies the home, its .html through homeServed, and serves them under the shared frames origin", async () => {
    app({ "index.html": "<!doctype html><p>accueil</p>", "img/logo.png": Buffer.from([1, 2, 3]), "app.js": "let x;" });
    const url = await serveHome(data, "vidola");
    // A random token in the path, under the shared per-launch host.
    expect(url).toMatch(new RegExp(`^${framesOrigin()}/sites/vidola-[0-9a-f]{32}/index\\.html$`));
    const key = keyOf(url!);
    expect(served(url!)).toEqual(["app.js", "img/logo.png", "index.html"]);
    expect(copied(url!, "index.html")).toBe(homeServed("<!doctype html><p>accueil</p>", key));
    expect(copied(url!, "index.html")).toContain(`img-src data: ${framesOrigin()}/sites/${key}/;`);
    expect(copied(url!, "app.js")).toBe("let x;");
    // Served again: a new key; the previous folder is gone.
    const again = await serveHome(data, "vidola");
    expect(keyOf(again!)).not.toBe(key);
    expect(readdirSync(framesKindDir("sites"))).toEqual([keyOf(again!)]);
    // « Supprimer »: the copies go.
    await forgetHome(data, "vidola");
    expect(readdirSync(framesKindDir("sites"))).toEqual([]);
  });

  it("two serves started back to back (the agent writing several files): the last one works, nothing stale is left", async () => {
    app({ "index.html": "<p>accueil</p>", "img/logo.png": Buffer.from([1]), "a/b/c.js": "1" });
    const [first, second] = await Promise.all([serveHome(data, "vidola"), serveHome(data, "vidola")]);
    expect(second).toMatch(new RegExp(`^${framesOrigin()}/sites/vidola-[0-9a-f]{32}/index\\.html$`));
    expect(served(second!)).toEqual(["a/b/c.js", "img/logo.png", "index.html"]);
    expect(readdirSync(framesKindDir("sites"))).toEqual([keyOf(second!)]);
    expect(first).toBeTruthy();
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
    rmSync(join(data, "workspace", "sites", "vidola", "home"), { recursive: true });
    symlinkSync(elsewhere, join(data, "workspace", "sites", "vidola", "home"));
    expect(await serveHome(data, "vidola")).toBeNull();
    expect(existsSync(join(data, "chrome"))).toBe(false);
  });

  it("refuses a file of 2 MB + 1 and a hidden segment (.cache/x.js, .x)", async () => {
    app({ "index.html": "<p>accueil</p>", "gros.png": Buffer.alloc(HOME_FILE_MAX + 1), "juste.png": Buffer.alloc(HOME_FILE_MAX), ".cache/x.js": "secret", ".x": "secret" });
    const url = await serveHome(data, "vidola");
    expect(served(url!)).toEqual(["index.html", "juste.png"]);
  });

  it("copies only the served types, nothing else", async () => {
    app({ "index.html": "<p>accueil</p>", "page.HTML": "<p>p</p>", "x.svg": "<svg/>", "a.js": "1", "x.xhtml": "<x/>", "x.xht": "<x/>", "x.htm": "<p/>", "x.shtml": "<p/>", "x.xml": "<x/>", "without": "x", "x.exe": "x" });
    const url = await serveHome(data, "vidola");
    expect(served(url!)).toEqual(["a.js", "index.html", "page.HTML", "x.svg"]);
    expect(copied(url!, "page.HTML")).toContain("Content-Security-Policy");
  });

  it("serves DISPLAY_DENIED for an index.html with <link>", async () => {
    app({ "index.html": '<!doctype html><link rel="prefetch" href="https://x.test/"><p>accueil</p>' });
    const url = await serveHome(data, "vidola");
    expect(copied(url!, "index.html")).toBe(displayDenied());
  });

  it("never finds a « Vidola » folder for the id « vidola », nor a bad id", async () => {
    app({ "index.html": "<p>accueil</p>" }, "vidola", "Vidola");
    expect(await serveHome(data, "vidola")).toBeNull();
    for (const id of ["Vidola", "../vidola", ""]) expect(await serveHome(data, id)).toBeNull();
  });

  it("keeps the copies inside <framesDir>/sites: a sites folder that is a link is refused", async () => {
    app({ "index.html": "<p>accueil</p>" });
    const out = join(root, `copies-dehors-${n}`);
    mkdirSync(out);
    mkdirSync(join(data, "chrome", "ressac-frames"), { recursive: true });
    symlinkSync(out, framesKindDir("sites"));
    expect(await serveHome(data, "vidola")).toBeNull();
    expect(readdirSync(out)).toEqual([]);
  });

  it("serves no home of more than HOME_ENTRIES_MAX files and folders", async () => {
    const files: Record<string, string> = { "index.html": "<p>accueil</p>" };
    for (let i = 0; i < HOME_ENTRIES_MAX; i++) files[`f${i}.js`] = "1";
    app(files);
    expect(await serveHome(data, "vidola")).toBeNull();
  });

  it("never follows a link swapped for a folder of the home, even one met by the walk", async () => {
    const home = app({ "index.html": "<p>accueil</p>", "sous/a.js": "1" });
    const elsewhere = join(root, `dehors-${n}`);
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "secret.js"), "secret du Mac");
    rmSync(join(home, "sous"), { recursive: true });
    symlinkSync(elsewhere, join(home, "sous"));
    const url = await serveHome(data, "vidola");
    expect(served(url!)).toEqual(["index.html"]);
  });

  it("is null without an index.html", async () => {
    app({ "autre.html": "<p>x</p>" });
    expect(await serveHome(data, "vidola")).toBeNull();
  });
});
