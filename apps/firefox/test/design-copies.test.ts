import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanCapture, cleanSource, targetKey, firefoxViewfinderScript, bubbleSlot, sourceExpression, SITE_BUBBLE_SIZE } from "../chrome/store/design-copies";

const line = (text: string, start: string) => text.split("\n").find((l) => l.startsWith(start)) ?? `missing ${start}`;

describe("design copies", () => {
  it("the Firefox viewfinder script: no click listener of its own, the guard hands it the element", () => {
    const s = firefoxViewfinderScript();
    expect(s).toContain("globalThis.__viseurChoisir = choisir;");
    expect(s).toContain("delete globalThis.__viseurChoisir;");
    expect(s).not.toContain('window.addEventListener("click", surClic, true)');
  });

  it("sourceExpression quotes the selector", () => {
    expect(sourceExpression('a"b')).toContain('document.querySelector("a\\"b")');
  });

  const valid = () => ({
    selecteur: "h1", etiquette: "h1", html: "<h1>x</h1>", voisinage: { parent: "body", freres: ["p : a"] }, styles: { display: "block" },
    rect: { x: 1, y: 2, largeur: 3, hauteur: 4 }, adresse: "http://127.0.0.1/", vue: { largeur: 800, hauteur: 600 },
  });

  it("cleanCapture: the shape checks, then the html is cut", () => {
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

  it("cleanSource: the shape checks", () => {
    expect(cleanSource({ file: {}, line: "x" })).toBeNull();
    expect(cleanSource({ fichier: {}, ligne: "x" })).toBeNull();
    expect(cleanSource({ fichier: "a.svelte", ligne: -3, colonne: 1.5 })).toEqual({ fichier: "a.svelte" });
    expect(cleanSource({ fichier: "src/A.svelte", ligne: 12, colonne: 3 })).toEqual({ fichier: "src/A.svelte", ligne: 12, colonne: 3 });
    expect(cleanSource(null)).toBeNull();
  });

  it("cleCible names a target; the site bubble has its size", () => {
    expect(SITE_BUBBLE_SIZE).toEqual({ largeur: 320, hauteur: 190 });
    expect(targetKey({ type: "fenetre", fenetreId: "f1" })).toBe("fenetre:f1");
    expect(targetKey({ type: "app", dossier: "essai" })).toBe("app:essai");
    expect(targetKey({ type: "site", id: "tuning" })).toBe("site:tuning");
  });

  it("drift: the home's MOUSE (design-home.ts) is the actor's (design-actor.ts), word for word", () => {
    const mouse = (file: string) => line(readFileSync(path.resolve(import.meta.dirname, file), "utf8").split("\n").map((l) => l.replace(/^export /, "")).join("\n"), "const MOUSE = ");
    expect(mouse("../chrome/store/design-home.ts")).toBe(mouse("../chrome/agent/design-actor.ts"));
    expect(mouse("../chrome/agent/design-actor.ts")).toContain('"pointerdown"');
  });

  it("placeBulle: under the element, bounded to the window", () => {
    const bounds = { x: 300, y: 50, width: 900, height: 750 };
    expect(bubbleSlot({ x: 10, y: 20, largeur: 100, hauteur: 30 }, 1, bounds, [1200, 800])).toEqual({ x: 310, y: 106, width: 320, height: 170 });
    expect(bubbleSlot({ x: 1000, y: 700, largeur: 50, hauteur: 30 }, 1, bounds, [1200, 800])).toEqual({ x: 880, y: 630, width: 320, height: 170 });
    expect(bubbleSlot({ x: 10, y: 20, largeur: 100, hauteur: 30 }, 1, { x: 0, y: 356, width: 1200, height: 44 }, [1200, 400], { hautMin: 356, hauteur: 190 })).toEqual({ x: 10, y: 356, width: 320, height: 190 });
    // A site app: an element at the bottom of a short window stays under the 36 px bar (y 36, not 10).
    expect(bubbleSlot({ x: 10, y: 150, largeur: 50, hauteur: 20 }, 1, { x: 0, y: 36, width: 1200, height: 164 }, [1200, 200], { hautMin: 36, hauteur: 190 })).toEqual({ x: 10, y: 36, width: 320, height: 190 });
    // Zoomed 1.5: the CSS rect scaled into the window.
    expect(bubbleSlot({ x: 100, y: 20, largeur: 100, hauteur: 30 }, 1.5, bounds, [1200, 800])).toEqual({ x: 450, y: 131, width: 320, height: 170 });
  });
});
