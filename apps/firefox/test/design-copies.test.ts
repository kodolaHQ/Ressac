import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanCapture, cleanSource, cleCible, firefoxViewfinderScript, placeBulle, sourceExpression, STOP_SCRIPT } from "../chrome/store/design-copies";

const ELECTRON = readFileSync(path.resolve(import.meta.dirname, "../../navigateur/src/main/design/viseur.ts"), "utf8");
const COPIES = readFileSync(path.resolve(import.meta.dirname, "../chrome/store/design-copies.ts"), "utf8");
const CALQUE = readFileSync(path.resolve(import.meta.dirname, "../../navigateur/src/main/design/calque.ts"), "utf8");
const SERVICE = readFileSync(path.resolve(import.meta.dirname, "../../navigateur/src/main/design/service.ts"), "utf8");

/** The text of `function <name>(…) {…}` (up to its closing brace at column 0). */
const fn = (text: string, name: string) => /\nfunction [^\n]*\n[\s\S]*?\n}\n/.exec(text.slice(text.indexOf(`\nfunction ${name}(`)))?.[0] ?? `missing ${name}`;
const line = (text: string, start: string) => text.split("\n").find((l) => l.startsWith(start)) ?? `missing ${start}`;

describe("design copies", () => {
  it("the Firefox viewfinder script: no click listener of its own, the guard hands it the element", () => {
    const s = firefoxViewfinderScript();
    expect(s).toContain("globalThis.__viseurChoisir = choisir;");
    expect(s).toContain("delete globalThis.__viseurChoisir;");
    expect(s).not.toContain('window.addEventListener("click", surClic, true)');
  });

  it("drift: Electron's viseur.ts holds ARRET, propreCapture, sourceSaine and lireSource's expression word for word", () => {
    expect(ELECTRON).toContain(`const ARRET = \`${STOP_SCRIPT}\`;`);
    for (const name of ["propreCapture", "sourceSaine"]) expect(ELECTRON).toContain(fn(COPIES, name));
    for (const start of ["const fini = ", "const chaine = ", "const entierPositif = "]) expect(ELECTRON).toContain(line(COPIES, start));
    const expr = (text: string, open: string) => text.slice(text.indexOf(open) + open.length, text.indexOf("})()`;", text.indexOf(open)) + 4);
    const copied = expr(COPIES, "  return `");
    expect(copied.startsWith("(() => {\n    try {")).toBe(true);
    expect(expr(ELECTRON, "  const code = `")).toBe(copied);
    expect(sourceExpression('a"b')).toContain('document.querySelector("a\\"b")');
  });

  const valid = () => ({
    selecteur: "h1", etiquette: "h1", html: "<h1>x</h1>", voisinage: { parent: "body", freres: ["p : a"] }, styles: { display: "block" },
    rect: { x: 1, y: 2, largeur: 3, hauteur: 4 }, adresse: "http://127.0.0.1/", vue: { largeur: 800, hauteur: 600 },
  });

  it("cleanCapture: Electron's shape checks, then the html is cut", () => {
    expect(cleanCapture(valid())).toEqual(valid());
    expect(cleanCapture({ ...valid(), rect: { x: Number.NaN, y: 2, largeur: 3, hauteur: 4 } })).toBeNull();
    expect(cleanCapture({ ...valid(), voisinage: { parent: "body", freres: "p" } })).toBeNull();
    expect(cleanCapture({ ...valid(), styles: { display: 1 } })).toBeNull();
    expect(cleanCapture(null)).toBeNull();
    expect(cleanCapture("x")).toBeNull();
    const long = cleanCapture({ ...valid(), html: "a".repeat(5000) });
    expect(long?.html.endsWith("… [tronqué]")).toBe(true);
    expect(long!.html.length).toBeLessThan(5000);
  });

  it("cleanSource: Electron's checks", () => {
    expect(cleanSource({ file: {}, line: "x" })).toBeNull();
    expect(cleanSource({ fichier: {}, ligne: "x" })).toBeNull();
    expect(cleanSource({ fichier: "a.svelte", ligne: -3, colonne: 1.5 })).toEqual({ fichier: "a.svelte" });
    expect(cleanSource({ fichier: "src/A.svelte", ligne: 12, colonne: 3 })).toEqual({ fichier: "src/A.svelte", ligne: 12, colonne: 3 });
    expect(cleanSource(null)).toBeNull();
  });

  it("drift: placeBulle, cleCible, TAILLE_BULLE, ECART_BULLE (service.ts), MARGE and LARGEUR_PANIER (calque.ts), word for word", () => {
    const placed = /\nexport function placeBulle\([\s\S]*?\n}\n/.exec(COPIES)?.[0] ?? "missing placeBulle";
    expect(SERVICE).toContain(placed);
    const cle = /\nexport const cleCible = [\s\S]*?;\n/.exec(COPIES)?.[0] ?? "missing cleCible";
    expect(SERVICE).toContain(cle);
    for (const start of ["export const TAILLE_BULLE = ", "const ECART_BULLE = "]) expect(SERVICE).toContain(line(COPIES, start));
    for (const k of ["LARGEUR_MESSAGE", "HAUTEUR_MESSAGE", "MARGE_MESSAGE"]) expect(SERVICE).toContain(line(COPIES, `export const ${k} = `).replace("export ", ""));
    for (const k of ["MARGE", "LARGEUR_PANIER"]) expect(CALQUE).toContain(line(COPIES, `export const ${k} = `).replace("export ", ""));
    expect(CALQUE).toContain(line(COPIES, "export const DUREE_MESSAGE_MS = "));
    expect(cleCible({ type: "fenetre", fenetreId: "f1" })).toBe("fenetre:f1");
    expect(cleCible({ type: "app", dossier: "essai" })).toBe("app:essai");
  });

  // Electron's test/design/service.test.ts:232-241.
  it("placeBulle: under the element, bounded to the window", () => {
    const bornes = { x: 300, y: 50, width: 900, height: 750 };
    expect(placeBulle({ x: 10, y: 20, largeur: 100, hauteur: 30 }, 1, bornes, [1200, 800])).toEqual({ x: 310, y: 106, width: 320, height: 170 });
    expect(placeBulle({ x: 1000, y: 700, largeur: 50, hauteur: 30 }, 1, bornes, [1200, 800])).toEqual({ x: 880, y: 630, width: 320, height: 170 });
    expect(placeBulle({ x: 10, y: 20, largeur: 100, hauteur: 30 }, 1, { x: 0, y: 356, width: 1200, height: 44 }, [1200, 400], { hautMin: 356, hauteur: 190 })).toEqual({ x: 10, y: 356, width: 320, height: 190 });
    // Zoomed 1.5: the CSS rect scaled into the window.
    expect(placeBulle({ x: 100, y: 20, largeur: 100, hauteur: 30 }, 1.5, bornes, [1200, 800])).toEqual({ x: 450, y: 131, width: 320, height: 170 });
  });
});
