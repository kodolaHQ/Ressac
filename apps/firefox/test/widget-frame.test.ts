import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ShownWidget } from "../shared/api";
import { displayDenied, CSP_WIDGET, displayServed, copyPath, forgetWidget, prepareWidget, displayUrl } from "../chrome/window/widget-frame";
import { NETWORK_HINTS_PATTERN } from "../shared/network-hints";
import { serveDisplays } from "../ui/api";
import { framesKindDir, framesOrigin } from "../chrome/window/frames-root";

let root: string;
let widgets: string;
/** What the resource:// substitution received: name → folder (null: removed). */
/** The copy's key, as prepareWidget computes it: rounded mtime and size. */
const keyOf = (p: string) => `${Math.round(statSync(p).mtimeMs)}-${statSync(p).size}`;
const substitutions = new Map<string, string | null>();

// The module runs in chrome in Firefox (IOUtils/PathUtils/Services/Cc/Ci globals): here, the same ones, on node:fs.
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ressac-widget-frame-"));
  widgets = join(root, "workspace", "home", "widgets");
  mkdirSync(join(widgets, "demo"), { recursive: true });
  writeFileSync(join(widgets, "demo", "display.html"), "<!doctype html><title>démo</title>");
  // A Mac file, outside the widgets folder.
  writeFileSync(join(root, "secret.html"), "<title>secret</title>");
  Object.assign(globalThis as any, {
    PathUtils: { join: (...parts: string[]) => join(...parts), get profileDir() { return root; } },
    IOUtils: {
      stat: async (p: string) => ({ lastModified: statSync(p).mtimeMs, size: statSync(p).size }),
      exists: async (p: string) => existsSync(p),
      makeDirectory: async (p: string) => void mkdirSync(p, { recursive: true }),
      readUTF8: async (p: string) => readFileSync(p, "utf8"),
      writeUTF8: async (p: string, text: string) => writeFileSync(p, text),
      move: async (from: string, to: string) => renameSync(from, to),
      getChildren: async (p: string) => readdirSync(p).map((name) => join(p, name)),
      remove: async (p: string) => rmSync(p, { recursive: true, force: true }),
    },
    Ci: { nsIFile: "nsIFile", nsIResProtocolHandler: "nsIResProtocolHandler", nsISubstitutingProtocolHandler: { ALLOW_CONTENT_ACCESS: 1 } },
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
        getProtocolHandler: () => ({ QueryInterface: () => ({ setSubstitutionWithFlags: (name: string, uri: { spec: string }) => substitutions.set(name, uri.spec) }) }),
        newFileURI: (file: { path: string }) => ({ spec: `file://${file.path}` }),
      },
    },
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("served paths", () => {
  it("names the copy and its resource:// URL by the source's mtime", () => {
    expect(displayUrl("demo", 1730000000123)).toBe(`${framesOrigin()}/widgets/demo/display-1730000000123.html`);
    expect(displayUrl("alpha", "1-2").startsWith(`${framesOrigin()}/widgets/alpha/`)).toBe(true);
    expect(copyPath("demo", 42)).toBe(join(framesKindDir("widgets"), "demo", "display-42.html"));
  });
});

describe("prepareWidget", () => {
  it("writes the sanitized copy, sets the substitution and returns the frame's URL", async () => {
    const source = join(widgets, "demo", "display.html");
    const mtime = keyOf(source);
    const url = await prepareWidget(root, "demo");
    expect(url).toBe(displayUrl("demo", mtime));
    const copy = readFileSync(copyPath("demo", mtime), "utf8");
    expect(copy).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP_WIDGET}">`);
    expect(copy).toContain("<title>démo</title>");
    expect(substitutions.get(framesOrigin().slice("resource://".length))).toBe(`file://${join(root, "chrome", "ressac-frames")}`);
  });

  it("injects DISPLAY_DENIED into the copy of a display with a network hint", async () => {
    mkdirSync(join(widgets, "refus"), { recursive: true });
    const source = join(widgets, "refus", "display.html");
    writeFileSync(source, '<!doctype html><link rel="preload" href="https://exemple.test/x"><p>jamais</p>');
    const mtime = keyOf(source);
    expect(await prepareWidget(root, "refus")).toBe(displayUrl("refus", mtime));
    expect(readFileSync(copyPath("refus", mtime), "utf8")).toBe(displayDenied());
  });

  it("does not rewrite the copy when the source's mtime and size do not change", async () => {
    const source = join(widgets, "demo", "display.html");
    const key = keyOf(source);
    const copy = copyPath("demo", key);
    const written = statSync(copy).mtimeMs;
    expect(await prepareWidget(root, "demo")).toBe(displayUrl("demo", key));
    expect(statSync(copy).mtimeMs).toBe(written);
  });

  it("a rewrite that keeps the old mtime but not the size makes a new copy", async () => {
    const source = join(widgets, "demo", "display.html");
    const before = await prepareWidget(root, "demo");
    const { mtime } = statSync(source);
    writeFileSync(source, "<!doctype html><title>réécrit, même date</title>");
    utimesSync(source, mtime, mtime);
    const after = await prepareWidget(root, "demo");
    expect(after).not.toBe(before);
    expect(readFileSync(copyPath("demo", keyOf(source)), "utf8")).toContain("même date");
  });

  it("removes the old copy when the source changes", async () => {
    const source = join(widgets, "demo", "display.html");
    const old = keyOf(source);
    const later = statSync(source).mtimeMs + 5000;
    writeFileSync(source, "<!doctype html><title>nouveau</title>");
    utimesSync(source, new Date(later), new Date(later));
    const fresh = keyOf(source);
    expect(await prepareWidget(root, "demo")).toBe(displayUrl("demo", fresh));
    expect(existsSync(copyPath("demo", old))).toBe(false);
    expect(readFileSync(copyPath("demo", fresh), "utf8")).toContain("<title>nouveau</title>");
    // The write is atomic: no temporary file remains.
    expect(readdirSync(join(framesKindDir("widgets"), "demo")).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it("refuses a copies folder that is an outgoing link", async () => {
    const outside = join(root, "copies-dehors");
    mkdirSync(outside);
    mkdirSync(join(widgets, "copie-lien"), { recursive: true });
    writeFileSync(join(widgets, "copie-lien", "display.html"), "<title>lien</title>");
    symlinkSync(outside, join(framesKindDir("widgets"), "copie-lien"));
    expect(await prepareWidget(root, "copie-lien")).toBeNull();
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses an display.html that is an outgoing link from the widget's folder", async () => {
    mkdirSync(join(widgets, "fuite"), { recursive: true });
    writeFileSync(join(widgets, "fuite", "widget.json"), "{}");
    symlinkSync(join(root, "secret.html"), join(widgets, "fuite", "display.html"));
    expect(await prepareWidget(root, "fuite")).toBeNull();
  });

  it("refuses a widget folder that is an outgoing link", async () => {
    const outside = join(root, "dehors");
    mkdirSync(outside);
    writeFileSync(join(outside, "display.html"), "<title>dehors</title>");
    symlinkSync(outside, join(widgets, "evade"));
    expect(await prepareWidget(root, "evade")).toBeNull();
  });
});

describe("forgetWidget", () => {
  it("removes the copies folder", async () => {
    mkdirSync(join(widgets, "oublie"), { recursive: true });
    writeFileSync(join(widgets, "oublie", "display.html"), "<title>oublie</title>");
    await prepareWidget(root, "oublie");
    await forgetWidget(root, "oublie");
    expect(existsSync(join(framesKindDir("widgets"), "oublie"))).toBe(false);
  });
});

describe("serveDisplays", () => {
  it("prepares the copies, and only forgets the widgets that are no longer displayed", async () => {
    const prepares = new Set<string>();
    const forgotten: string[] = [];
    const tool = {
      prepare: async (_d: string, id: string) => `resource://ressac-frames-0123456789abcdef/widgets/${id}/display-1.html`,
      forget: async (_d: string, id: string) => void forgotten.push(id),
    };
    const w = (id: string) => ({ id, src: `resource://ressac-frames-0123456789abcdef/widgets/${id}/display-1.html` }) as unknown as ShownWidget;
    await serveDisplays([w("a"), w("b")], "/data", prepares, tool);
    expect(prepares).toEqual(new Set(["a", "b"]));
    expect(forgotten).toEqual([]);
    await serveDisplays([w("a")], "/data", prepares, tool);
    // « a » is still displayed: its substitution stays.
    expect(prepares).toEqual(new Set(["a"]));
    expect(forgotten).toEqual(["b"]);
  });
});

describe("displayServed", () => {
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

  it("remplace par DISPLAY_DENIED un <link>", () => {
    expect(displayServed(html('<link rel="preload" href="https://exemple.test/x">'))).toBe(displayDenied());
  });

  it("replaces another http-equiv meta with DISPLAY_DENIED", () => {
    expect(displayServed(html('<meta http-equiv="x-dns-prefetch-control" content="on">'))).toBe(displayDenied());
  });

  it("replaces speculation rules with DISPLAY_DENIED", () => {
    expect(displayServed(html('<script type="speculationrules">{"prefetch":[]}</script>'))).toBe(displayDenied());
  });

  it("keeps intact an HTML that only talks about links and preloading", () => {
    const source = html("<p>A link can preload; speculation rules are a thing.</p>");
    expect(displayServed(source)).toContain("<p>A link can preload; speculation rules are a thing.</p>");
    expect(displayServed(source)).not.toBe(displayDenied());
  });
});
