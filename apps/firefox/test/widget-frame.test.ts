import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AFFICHAGE_REFUSE, CSP_WIDGET, SCHEMA_WIDGET, affichageServi, fichierAffichage } from "../chrome/window/widget-frame";

let racine: string;
let widgets: string;

beforeAll(() => {
  racine = mkdtempSync(join(tmpdir(), "webaios-widget-frame-"));
  widgets = join(racine, "espace", "accueil", "widgets");
  mkdirSync(join(widgets, "demo"), { recursive: true });
  writeFileSync(join(widgets, "demo", "affichage.html"), "<!doctype html><title>démo</title>");
  // Un fichier du Mac, hors du dossier des widgets.
  writeFileSync(join(racine, "secret.html"), "<title>secret</title>");
});

afterAll(() => rmSync(racine, { recursive: true, force: true }));

describe("fichierAffichage", () => {
  it("accepte l'affichage d'un widget, avec ou sans ?v=", () => {
    const attendu = realpathSync(join(widgets, "demo", "affichage.html"));
    expect(SCHEMA_WIDGET).toBe("webaios-widget");
    expect(fichierAffichage("webaios-widget://demo/affichage.html", widgets)).toBe(attendu);
    expect(fichierAffichage("webaios-widget://demo/affichage.html?v=1730000000123", widgets)).toBe(attendu);
  });

  it("refuse un autre schéma", () => {
    expect(fichierAffichage("http://demo/affichage.html", widgets)).toBeNull();
    expect(fichierAffichage("file:///demo/affichage.html", widgets)).toBeNull();
    expect(fichierAffichage("pas une url", widgets)).toBeNull();
  });

  it("refuse un hôte qui n'est pas un id de widget", () => {
    expect(fichierAffichage("webaios-widget://demo_bad/affichage.html", widgets)).toBeNull();
    expect(fichierAffichage("webaios-widget://Demo/affichage.html", widgets)).toBeNull();
    expect(fichierAffichage("webaios-widget://demo.evil/affichage.html", widgets)).toBeNull();
    expect(fichierAffichage("webaios-widget:///affichage.html", widgets)).toBeNull();
  });

  it("refuse un autre chemin, un port, des séparateurs encodés et ..", () => {
    expect(fichierAffichage("webaios-widget://demo/autre.html", widgets)).toBeNull();
    expect(fichierAffichage("webaios-widget://demo/affichage.html/../secret", widgets)).toBeNull();
    expect(fichierAffichage("webaios-widget://demo/../affichage.html", widgets)).toBeNull();
    expect(fichierAffichage("webaios-widget://demo/affichage.html%2F..%2Fsecret", widgets)).toBeNull();
    expect(fichierAffichage("webaios-widget://demo:80/affichage.html", widgets)).toBeNull();
  });

  it("refuse un fichier absent", () => {
    expect(fichierAffichage("webaios-widget://inconnu/affichage.html", widgets)).toBeNull();
  });

  it("refuse un affichage.html qui est un lien sortant du dossier du widget", () => {
    mkdirSync(join(widgets, "fuite"), { recursive: true });
    writeFileSync(join(widgets, "fuite", "widget.json"), "{}");
    symlinkSync(join(racine, "secret.html"), join(widgets, "fuite", "affichage.html"));
    expect(fichierAffichage("webaios-widget://fuite/affichage.html", widgets)).toBeNull();
  });

  it("refuse un dossier de widget qui est un lien sortant", () => {
    const dehors = join(racine, "dehors");
    mkdirSync(dehors);
    writeFileSync(join(dehors, "affichage.html"), "<title>dehors</title>");
    symlinkSync(dehors, join(widgets, "evade"));
    expect(fichierAffichage("webaios-widget://evade/affichage.html", widgets)).toBeNull();
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
