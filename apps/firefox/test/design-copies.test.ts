import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanCapture, cleanSource, firefoxViewfinderScript, sourceExpression, STOP_SCRIPT } from "../chrome/store/design-copies";

const ELECTRON = readFileSync(path.resolve(import.meta.dirname, "../../navigateur/src/main/design/viseur.ts"), "utf8");
const COPIES = readFileSync(path.resolve(import.meta.dirname, "../chrome/store/design-copies.ts"), "utf8");

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
});
