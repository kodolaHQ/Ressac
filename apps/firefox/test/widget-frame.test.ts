import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ShownWidget } from "../shared/api";
import { DISPLAY_DENIED, CSP_WIDGET, displayServed, copyPath, forgetWidget, preparerWidget, displayUrl } from "../chrome/window/widget-frame";
import { NETWORK_HINTS_PATTERN } from "../shared/indices-reseau";
import { servirAffichages } from "../ui/api";

let racine: string;
let widgets: string;
/** What the resource:// substitution received: name → folder (null: removed). */
const substitutions = new Map<string, string | null>();

// The module runs in chrome in Firefox (IOUtils/PathUtils/Services/Cc/Ci globals): here, the same ones, on node:fs.
beforeAll(() => {
  racine = mkdtempSync(join(tmpdir(), "webaios-widget-frame-"));
  widgets = join(racine, "espace", "accueil", "widgets");
  mkdirSync(join(widgets, "demo"), { recursive: true });
  writeFileSync(join(widgets, "demo", "affichage.html"), "<!doctype html><title>démo</title>");
  // A Mac file, outside the widgets folder.
  writeFileSync(join(racine, "secret.html"), "<title>secret</title>");
  Object.assign(globalThis as any, {
    PathUtils: { join: (...parts: string[]) => join(...parts) },
    IOUtils: {
      stat: async (p: string) => ({ lastModified: statSync(p).mtimeMs }),
      exists: async (p: string) => existsSync(p),
      makeDirectory: async (p: string) => void mkdirSync(p, { recursive: true }),
      readUTF8: async (p: string) => readFileSync(p, "utf8"),
      writeUTF8: async (p: string, texte: string) => writeFileSync(p, texte),
      move: async (de: string, vers: string) => renameSync(de, vers),
      getChildren: async (p: string) => readdirSync(p).map((nom) => join(p, nom)),
      remove: async (p: string) => rmSync(p, { recursive: true, force: true }),
    },
    Ci: { nsIFile: "nsIFile", nsIResProtocolHandler: "nsIResProtocolHandler" },
    Cc: {
      "@mozilla.org/file/local;1": {
        createInstance: () => {
          let chemin = "";
          return {
            initWithPath(p: string) {
              chemin = p;
            },
            normalize() {
              chemin = realpathSync(chemin);
            },
            get path() {
              return chemin;
            },
          };
        },
      },
    },
    ChromeUtils: { importESModule: () => ({ FileUtils: { File: class { constructor(public path: string) {} } } }) },
    Services: {
      io: {
        getProtocolHandler: () => ({ QueryInterface: () => ({ setSubstitution: (nom: string, uri: { spec: string } | null) => substitutions.set(nom, uri?.spec ?? null) }) }),
        newFileURI: (fichier: { path: string }) => ({ spec: `file://${fichier.path}` }),
      },
    },
  });
});

afterAll(() => rmSync(racine, { recursive: true, force: true }));

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
    const url = await preparerWidget(racine, "demo");
    expect(url).toBe(displayUrl("demo", mtime));
    const copie = readFileSync(copyPath(racine, "demo", mtime), "utf8");
    expect(copie).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP_WIDGET}">`);
    expect(copie).toContain("<title>démo</title>");
    expect(substitutions.get("webaios-widget-demo")).toBe(`file://${join(racine, "webaios-widgets", "demo")}`);
  });

  it("injects AFFICHAGE_REFUSE into the copy of a display with a network hint", async () => {
    mkdirSync(join(widgets, "refus"), { recursive: true });
    const source = join(widgets, "refus", "affichage.html");
    writeFileSync(source, '<!doctype html><link rel="preload" href="https://exemple.test/x"><p>jamais</p>');
    const mtime = Math.round(statSync(source).mtimeMs);
    expect(await preparerWidget(racine, "refus")).toBe(displayUrl("refus", mtime));
    expect(readFileSync(copyPath(racine, "refus", mtime), "utf8")).toBe(DISPLAY_DENIED);
  });

  it("does not rewrite the copy when the source's mtime does not change", async () => {
    const source = join(widgets, "demo", "affichage.html");
    const mtime = Math.round(statSync(source).mtimeMs);
    const copie = copyPath(racine, "demo", mtime);
    const premier = readFileSync(copie, "utf8");
    writeFileSync(source, "<!doctype html><title>réécrit</title>");
    utimesSync(source, new Date(mtime), new Date(mtime));
    expect(await preparerWidget(racine, "demo")).toBe(displayUrl("demo", mtime));
    expect(readFileSync(copie, "utf8")).toBe(premier);
  });

  it("removes the old copy when the source changes", async () => {
    const source = join(widgets, "demo", "affichage.html");
    const ancien = Math.round(statSync(source).mtimeMs);
    const nouveau = ancien + 5000;
    writeFileSync(source, "<!doctype html><title>nouveau</title>");
    utimesSync(source, new Date(nouveau), new Date(nouveau));
    expect(await preparerWidget(racine, "demo")).toBe(displayUrl("demo", nouveau));
    expect(existsSync(copyPath(racine, "demo", ancien))).toBe(false);
    expect(readFileSync(copyPath(racine, "demo", nouveau), "utf8")).toContain("<title>nouveau</title>");
    // The write is atomic: no temporary file remains.
    expect(readdirSync(join(racine, "webaios-widgets", "demo")).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it("refuses a copies folder that is an outgoing link", async () => {
    const dehors = join(racine, "copies-dehors");
    mkdirSync(dehors);
    mkdirSync(join(widgets, "copie-lien"), { recursive: true });
    writeFileSync(join(widgets, "copie-lien", "affichage.html"), "<title>lien</title>");
    symlinkSync(dehors, join(racine, "webaios-widgets", "copie-lien"));
    expect(await preparerWidget(racine, "copie-lien")).toBeNull();
    expect(readdirSync(dehors)).toEqual([]);
  });

  it("refuses an affichage.html that is an outgoing link from the widget's folder", async () => {
    mkdirSync(join(widgets, "fuite"), { recursive: true });
    writeFileSync(join(widgets, "fuite", "widget.json"), "{}");
    symlinkSync(join(racine, "secret.html"), join(widgets, "fuite", "affichage.html"));
    expect(await preparerWidget(racine, "fuite")).toBeNull();
  });

  it("refuses a widget folder that is an outgoing link", async () => {
    const dehors = join(racine, "dehors");
    mkdirSync(dehors);
    writeFileSync(join(dehors, "affichage.html"), "<title>dehors</title>");
    symlinkSync(dehors, join(widgets, "evade"));
    expect(await preparerWidget(racine, "evade")).toBeNull();
  });
});

describe("oublierWidget", () => {
  it("removes the substitution and the copies folder", async () => {
    mkdirSync(join(widgets, "oublie"), { recursive: true });
    writeFileSync(join(widgets, "oublie", "affichage.html"), "<title>oublie</title>");
    await preparerWidget(racine, "oublie");
    expect(substitutions.get("webaios-widget-oublie")).toBeTruthy();
    await forgetWidget(racine, "oublie");
    expect(substitutions.get("webaios-widget-oublie")).toBeNull();
    expect(existsSync(join(racine, "webaios-widgets", "oublie"))).toBe(false);
  });
});

describe("servirAffichages", () => {
  it("prepares the copies, and only forgets the widgets that are no longer displayed", async () => {
    const prepares = new Set<string>();
    const oublies: string[] = [];
    const outil = {
      preparer: async (_d: string, id: string) => `resource://webaios-widget-${id}/affichage-1.html`,
      oublier: async (_d: string, id: string) => void oublies.push(id),
    };
    const w = (id: string) => ({ id, src: `resource://webaios-widget-${id}/affichage-1.html` }) as unknown as ShownWidget;
    await servirAffichages([w("a"), w("b")], "/data", prepares, outil);
    expect(prepares).toEqual(new Set(["a", "b"]));
    expect(oublies).toEqual([]);
    await servirAffichages([w("a")], "/data", prepares, outil);
    // « a » is still displayed: its substitution stays.
    expect(prepares).toEqual(new Set(["a"]));
    expect(oublies).toEqual(["b"]);
  });
});

describe("affichageServi", () => {
  const html = (corps: string) => `<!doctype html><html><head><title>démo</title></head><body>${corps}</body></html>`;

  it("injects the CSP meta then the guard after the doctype, before any widget element", () => {
    const source = html("<script>document.title = 'ok'</script>");
    const servi = displayServed(source);
    const prefixe = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP_WIDGET}"><script>`;
    expect(servi.startsWith(prefixe)).toBe(true);
    expect(servi).toContain("<script>document.title = 'ok'</script>");
    // The parser runs the guard before the widget's scripts; the doctype stays the first token.
    const finGarde = servi.indexOf("</script>");
    expect(servi.indexOf("<title>")).toBeGreaterThan(finGarde);
    expect(servi.indexOf("<script>document.title")).toBeGreaterThan(finGarde);
    // The network-hint rule is passed to the guard.
    expect(servi).toContain(JSON.stringify(NETWORK_HINTS_PATTERN));
    // The serialized script is valid JavaScript (compiled, not run).
    const debut = servi.indexOf("<script>") + "<script>".length;
    expect(() => new Function(servi.slice(debut, finGarde))).not.toThrow();
  });

  it("injects the same prefix into an HTML without a doctype", () => {
    const servi = displayServed("<p>nu</p>");
    expect(servi.startsWith(`<meta http-equiv="Content-Security-Policy" content="${CSP_WIDGET}"><script>`)).toBe(true);
    expect(servi.endsWith("</script><p>nu</p>")).toBe(true);
  });

  it("keeps the head comments and the doctype before the meta and the guard", () => {
    const servi = displayServed("<!-- x -->\n<!doctype html><p>nu</p>");
    expect(servi.startsWith(`<!-- x -->\n<!doctype html><meta http-equiv="Content-Security-Policy"`)).toBe(true);
    expect(servi.endsWith("</script><p>nu</p>")).toBe(true);
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
