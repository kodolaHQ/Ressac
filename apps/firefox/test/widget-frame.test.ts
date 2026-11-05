import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AFFICHAGE_REFUSE, CSP_WIDGET, affichageServi, cheminCopie, preparerWidget, urlAffichage } from "../chrome/window/widget-frame";

let racine: string;
let widgets: string;
/** Ce que la substitution resource:// a reçu : nom → dossier (null : retirée). */
const substitutions = new Map<string, string | null>();

// Le module tourne en chrome dans Firefox (globaux IOUtils/PathUtils/Services/Cc/Ci) : ici, les mêmes, sur node:fs.
beforeAll(() => {
  racine = mkdtempSync(join(tmpdir(), "webaios-widget-frame-"));
  widgets = join(racine, "espace", "accueil", "widgets");
  mkdirSync(join(widgets, "demo"), { recursive: true });
  writeFileSync(join(widgets, "demo", "affichage.html"), "<!doctype html><title>démo</title>");
  // Un fichier du Mac, hors du dossier des widgets.
  writeFileSync(join(racine, "secret.html"), "<title>secret</title>");
  Object.assign(globalThis as any, {
    PathUtils: { join: (...parts: string[]) => join(...parts) },
    IOUtils: {
      stat: async (p: string) => ({ lastModified: statSync(p).mtimeMs }),
      exists: async (p: string) => existsSync(p),
      makeDirectory: async (p: string) => void mkdirSync(p, { recursive: true }),
      readUTF8: async (p: string) => readFileSync(p, "utf8"),
      writeUTF8: async (p: string, texte: string) => writeFileSync(p, texte),
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

describe("les chemins servis", () => {
  it("nomme la copie et son URL resource:// par le mtime de la source", () => {
    expect(urlAffichage("demo", 1730000000123)).toBe("resource://webaios-widget-demo/affichage-1730000000123.html");
    expect(cheminCopie("/data", "demo", 42)).toBe("/data/webaios-widgets/demo/affichage-42.html");
  });
});

describe("preparerWidget", () => {
  it("écrit la copie assainie, pose la substitution et rend l'URL du cadre", async () => {
    const source = join(widgets, "demo", "affichage.html");
    const mtime = Math.round(statSync(source).mtimeMs);
    const url = await preparerWidget(racine, "demo");
    expect(url).toBe(urlAffichage("demo", mtime));
    const copie = readFileSync(cheminCopie(racine, "demo", mtime), "utf8");
    expect(copie).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP_WIDGET}">`);
    expect(copie).toContain("<title>démo</title>");
    expect(substitutions.get("webaios-widget-demo")).toBe(`file://${join(racine, "webaios-widgets", "demo")}`);
  });

  it("injecte AFFICHAGE_REFUSE dans la copie d'un affichage avec un indice réseau", async () => {
    mkdirSync(join(widgets, "refus"), { recursive: true });
    const source = join(widgets, "refus", "affichage.html");
    writeFileSync(source, '<!doctype html><link rel="preload" href="https://exemple.test/x"><p>jamais</p>');
    const mtime = Math.round(statSync(source).mtimeMs);
    expect(await preparerWidget(racine, "refus")).toBe(urlAffichage("refus", mtime));
    expect(readFileSync(cheminCopie(racine, "refus", mtime), "utf8")).toBe(AFFICHAGE_REFUSE);
  });

  it("ne réécrit pas la copie quand le mtime de la source ne change pas", async () => {
    const source = join(widgets, "demo", "affichage.html");
    const mtime = Math.round(statSync(source).mtimeMs);
    const copie = cheminCopie(racine, "demo", mtime);
    const premier = readFileSync(copie, "utf8");
    writeFileSync(source, "<!doctype html><title>réécrit</title>");
    utimesSync(source, new Date(mtime), new Date(mtime));
    expect(await preparerWidget(racine, "demo")).toBe(urlAffichage("demo", mtime));
    expect(readFileSync(copie, "utf8")).toBe(premier);
  });

  it("refuse un affichage.html qui est un lien sortant du dossier du widget", async () => {
    mkdirSync(join(widgets, "fuite"), { recursive: true });
    writeFileSync(join(widgets, "fuite", "widget.json"), "{}");
    symlinkSync(join(racine, "secret.html"), join(widgets, "fuite", "affichage.html"));
    expect(await preparerWidget(racine, "fuite")).toBeNull();
  });

  it("refuse un dossier de widget qui est un lien sortant", async () => {
    const dehors = join(racine, "dehors");
    mkdirSync(dehors);
    writeFileSync(join(dehors, "affichage.html"), "<title>dehors</title>");
    symlinkSync(dehors, join(widgets, "evade"));
    expect(await preparerWidget(racine, "evade")).toBeNull();
  });
});

describe("affichageServi", () => {
  const html = (corps: string) => `<!doctype html><html><head><title>démo</title></head><body>${corps}</body></html>`;

  it("injecte la meta CSP avant le premier élément, HTML inchangé", () => {
    const source = html("<script>document.title = 'ok'</script>");
    const servi = affichageServi(source);
    expect(servi).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP_WIDGET}">`);
    expect(servi).toContain("<script>document.title = 'ok'</script>");
    // Le parseur doit lire la CSP avant tout script.
    expect(servi.indexOf("Content-Security-Policy")).toBeLessThan(servi.indexOf("<script"));
    expect(servi.startsWith("<!doctype html>")).toBe(true);
  });

  it("injecte aussi la meta dans un HTML sans doctype", () => {
    const servi = affichageServi("<p>nu</p>");
    expect(servi).toBe(`<meta http-equiv="Content-Security-Policy" content="${CSP_WIDGET}"><p>nu</p>`);
  });

  it("remplace par AFFICHAGE_REFUSE un <link>", () => {
    expect(affichageServi(html('<link rel="preload" href="https://exemple.test/x">'))).toBe(AFFICHAGE_REFUSE);
  });

  it("remplace par AFFICHAGE_REFUSE une autre meta http-equiv", () => {
    expect(affichageServi(html('<meta http-equiv="x-dns-prefetch-control" content="on">'))).toBe(AFFICHAGE_REFUSE);
  });

  it("remplace par AFFICHAGE_REFUSE des règles de spéculation", () => {
    expect(affichageServi(html('<script type="speculationrules">{"prefetch":[]}</script>'))).toBe(AFFICHAGE_REFUSE);
  });

  it("garde intact un HTML qui ne fait que parler de liens et de préchargement", () => {
    const source = html("<p>A link can preload; speculation rules are a thing.</p>");
    expect(affichageServi(source)).toContain("<p>A link can preload; speculation rules are a thing.</p>");
    expect(affichageServi(source)).not.toBe(AFFICHAGE_REFUSE);
  });
});
