import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ShownWidget } from "../shared/api";
import { DISPLAY_DENIED, CSP_WIDGET, displayServed, copyPath, forgetWidget, prepareWidget, displayUrl } from "../chrome/window/widget-frame";
import { NETWORK_HINTS_PATTERN } from "../shared/network-hints";
import { serveDisplays } from "../ui/api";

let root: string;
let widgets: string;
/** What the resource:// substitution received: name → folder (null: removed). */
const substitutions = new Map<string, string | null>();

// The module runs in chrome in Firefox (IOUtils/PathUtils/Services/Cc/Ci globals): here, the same ones, on node:fs.
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "webaios-widget-frame-"));
  widgets = join(root, "espace", "accueil", "widgets");
  mkdirSync(join(widgets, "demo"), { recursive: true });
  writeFileSync(join(widgets, "demo", "affichage.html"), "<!doctype html><title>démo</title>");
  // A Mac file, outside the widgets folder.
  writeFileSync(join(root, "secret.html"), "<title>secret</title>");
  Object.assign(globalThis as any, {
    PathUtils: { join: (...parts: string[]) => join(...parts) },
    IOUtils: {
      stat: async (p: string) => ({ lastModified: statSync(p).mtimeMs }),
      exists: async (p: string) => existsSync(p),
      makeDirectory: async (p: string) => void mkdirSync(p, { recursive: true }),
      readUTF8: async (p: string) => readFileSync(p, "utf8"),
      writeUTF8: async (p: string, text: string) => writeFileSync(p, text),
      move: async (from: string, to: string) => renameSync(from, to),
      getChildren: async (p: string) => readdirSync(p).map((name) => join(p, name)),
      remove: async (p: string) => rmSync(p, { recursive: true, force: true }),
    },
    Ci: { nsIFile: "nsIFile", nsIResProtocolHandler: "nsIResProtocolHandler" },
    Cc: {
      "@mozilla.org/file/local;1": {
        createInstance: () => {
          let path = "";
          return {
            initWithPath(p: string) {
              path = p;
            },
            normalize() {
              path = realpathSync(path);
            },
            get path() {
              return path;
            },
          };
        },
      },
    },
    ChromeUtils: { importESModule: () => ({ FileUtils: { File: class { constructor(public path: string) {} } } }) },
    Services: {
      io: {
        getProtocolHandler: () => ({ QueryInterface: () => ({ setSubstitution: (name: string, uri: { spec: string } | null) => substitutions.set(name, uri?.spec ?? null) }) }),
        newFileURI: (file: { path: string }) => ({ spec: `file://${file.path}` }),
      },
    },
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("served paths", () => {
  it("names the copy and its resource:// URL by the source's mtime", () => {
    expect(displayUrl("demo", 1730000000123)).toBe("resource://webaios-widget-demo/affichage-1730000000123.html");
    expect(copyPath("/data", "demo", 42)).toBe("/data/webaios-widgets/demo/affichage-42.html");
  });
});

describe("preparerWidget", () => {
  it("writes the sanitized copy, sets the substitution and returns the frame's URL", async () => {
    const source = join(widgets, "demo", "affichage.html");
    const mtime = Math.round(statSync(source).mtimeMs);
    const url = await prepareWidget(root, "demo");
    expect(url).toBe(displayUrl("demo", mtime));
    const copy = readFileSync(copyPath(root, "demo", mtime), "utf8");
    expect(copy).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP_WIDGET}">`);
    expect(copy).toContain("<title>démo</title>");
    expect(substitutions.get("webaios-widget-demo")).toBe(`file://${join(root, "webaios-widgets", "demo")}`);
  });

  it("injects AFFICHAGE_REFUSE into the copy of a display with a network hint", async () => {
    mkdirSync(join(widgets, "refus"), { recursive: true });
    const source = join(widgets, "refus", "affichage.html");
    writeFileSync(source, '<!doctype html><link rel="preload" href="https://exemple.test/x"><p>jamais</p>');
    const mtime = Math.round(statSync(source).mtimeMs);
    expect(await prepareWidget(root, "refus")).toBe(displayUrl("refus", mtime));
    expect(readFileSync(copyPath(root, "refus", mtime), "utf8")).toBe(DISPLAY_DENIED);
  });

  it("does not rewrite the copy when the source's mtime does not change", async () => {
    const source = join(widgets, "demo", "affichage.html");
    const mtime = Math.round(statSync(source).mtimeMs);
    const copy = copyPath(root, "demo", mtime);
    const first = readFileSync(copy, "utf8");
    writeFileSync(source, "<!doctype html><title>réécrit</title>");
    utimesSync(source, new Date(mtime), new Date(mtime));
    expect(await prepareWidget(root, "demo")).toBe(displayUrl("demo", mtime));
    expect(readFileSync(copy, "utf8")).toBe(first);
  });

  it("removes the old copy when the source changes", async () => {
    const source = join(widgets, "demo", "affichage.html");
    const old = Math.round(statSync(source).mtimeMs);
    const fresh = old + 5000;
    writeFileSync(source, "<!doctype html><title>nouveau</title>");
    utimesSync(source, new Date(fresh), new Date(fresh));
    expect(await prepareWidget(root, "demo")).toBe(displayUrl("demo", fresh));
    expect(existsSync(copyPath(root, "demo", old))).toBe(false);
    expect(readFileSync(copyPath(root, "demo", fresh), "utf8")).toContain("<title>nouveau</title>");
    // The write is atomic: no temporary file remains.
    expect(readdirSync(join(root, "webaios-widgets", "demo")).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it("refuses a copies folder that is an outgoing link", async () => {
    const outside = join(root, "copies-dehors");
    mkdirSync(outside);
    mkdirSync(join(widgets, "copie-lien"), { recursive: true });
    writeFileSync(join(widgets, "copie-lien", "affichage.html"), "<title>lien</title>");
    symlinkSync(outside, join(root, "webaios-widgets", "copie-lien"));
    expect(await prepareWidget(root, "copie-lien")).toBeNull();
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses an affichage.html that is an outgoing link from the widget's folder", async () => {
    mkdirSync(join(widgets, "fuite"), { recursive: true });
    writeFileSync(join(widgets, "fuite", "widget.json"), "{}");
    symlinkSync(join(root, "secret.html"), join(widgets, "fuite", "affichage.html"));
    expect(await prepareWidget(root, "fuite")).toBeNull();
  });

  it("refuses a widget folder that is an outgoing link", async () => {
    const outside = join(root, "dehors");
    mkdirSync(outside);
    writeFileSync(join(outside, "affichage.html"), "<title>dehors</title>");
    symlinkSync(outside, join(widgets, "evade"));
    expect(await prepareWidget(root, "evade")).toBeNull();
  });
});

describe("oublierWidget", () => {
  it("removes the substitution and the copies folder", async () => {
    mkdirSync(join(widgets, "oublie"), { recursive: true });
    writeFileSync(join(widgets, "oublie", "affichage.html"), "<title>oublie</title>");
    await prepareWidget(root, "oublie");
    expect(substitutions.get("webaios-widget-oublie")).toBeTruthy();
    await forgetWidget(root, "oublie");
    expect(substitutions.get("webaios-widget-oublie")).toBeNull();
    expect(existsSync(join(root, "webaios-widgets", "oublie"))).toBe(false);
  });
});

describe("servirAffichages", () => {
  it("prepares the copies, and only forgets the widgets that are no longer displayed", async () => {
    const prepares = new Set<string>();
    const forgotten: string[] = [];
    const tool = {
      preparer: async (_d: string, id: string) => `resource://webaios-widget-${id}/affichage-1.html`,
      oublier: async (_d: string, id: string) => void forgotten.push(id),
    };
    const w = (id: string) => ({ id, src: `resource://webaios-widget-${id}/affichage-1.html` }) as unknown as ShownWidget;
    await serveDisplays([w("a"), w("b")], "/data", prepares, tool);
    expect(prepares).toEqual(new Set(["a", "b"]));
    expect(forgotten).toEqual([]);
    await serveDisplays([w("a")], "/data", prepares, tool);
    // « a » is still displayed: its substitution stays.
    expect(prepares).toEqual(new Set(["a"]));
    expect(forgotten).toEqual(["b"]);
  });
});

describe("affichageServi", () => {
  const html = (body: string) => `<!doctype html><html><head><title>démo</title></head><body>${body}</body></html>`;

  it("injects the CSP meta then the guard after the doctype, before any widget element", () => {
    const source = html("<script>document.title = 'ok'</script>");
    const served = displayServed(source);
    const prefix = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP_WIDGET}"><script>`;
    expect(served.startsWith(prefix)).toBe(true);
    expect(served).toContain("<script>document.title = 'ok'</script>");
    // The parser runs the guard before the widget's scripts; the doctype stays the first token.
    const endGuard = served.indexOf("</script>");
    expect(served.indexOf("<title>")).toBeGreaterThan(endGuard);
    expect(served.indexOf("<script>document.title")).toBeGreaterThan(endGuard);
    // The network-hint rule is passed to the guard.
    expect(served).toContain(JSON.stringify(NETWORK_HINTS_PATTERN));
    // The serialized script is valid JavaScript (compiled, not run).
    const start = served.indexOf("<script>") + "<script>".length;
    expect(() => new Function(served.slice(start, endGuard))).not.toThrow();
  });

  it("injects the same prefix into an HTML without a doctype", () => {
    const served = displayServed("<p>nu</p>");
    expect(served.startsWith(`<meta http-equiv="Content-Security-Policy" content="${CSP_WIDGET}"><script>`)).toBe(true);
    expect(served.endsWith("</script><p>nu</p>")).toBe(true);
  });

  it("keeps the head comments and the doctype before the meta and the guard", () => {
    const served = displayServed("<!-- x -->\n<!doctype html><p>nu</p>");
    expect(served.startsWith(`<!-- x -->\n<!doctype html><meta http-equiv="Content-Security-Policy"`)).toBe(true);
    expect(served.endsWith("</script><p>nu</p>")).toBe(true);
  });

  it("remplace par AFFICHAGE_REFUSE un <link>", () => {
    expect(displayServed(html('<link rel="preload" href="https://exemple.test/x">'))).toBe(DISPLAY_DENIED);
  });

  it("replaces another http-equiv meta with AFFICHAGE_REFUSE", () => {
    expect(displayServed(html('<meta http-equiv="x-dns-prefetch-control" content="on">'))).toBe(DISPLAY_DENIED);
  });

  it("replaces speculation rules with AFFICHAGE_REFUSE", () => {
    expect(displayServed(html('<script type="speculationrules">{"prefetch":[]}</script>'))).toBe(DISPLAY_DENIED);
  });

  it("keeps intact an HTML that only talks about links and preloading", () => {
    const source = html("<p>A link can preload; speculation rules are a thing.</p>");
    expect(displayServed(source)).toContain("<p>A link can preload; speculation rules are a thing.</p>");
    expect(displayServed(source)).not.toBe(DISPLAY_DENIED);
  });
});
