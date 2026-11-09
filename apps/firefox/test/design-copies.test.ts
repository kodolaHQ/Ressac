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
    selector: "h1", label: "h1", html: "<h1>x</h1>", neighborhood: { parent: "body", siblings: ["p : a"] }, styles: { display: "block" },
    rect: { x: 1, y: 2, width: 3, height: 4 }, url: "http://127.0.0.1/", view: { width: 800, height: 600 },
  });

  it("cleanCapture: the shape checks, then the html is cut", () => {
    expect(cleanCapture(valid())).toEqual(valid());
    expect(cleanCapture({ ...valid(), rect: { x: Number.NaN, y: 2, width: 3, height: 4 } })).toBeNull();
    expect(cleanCapture({ ...valid(), neighborhood: { parent: "body", siblings: "p" } })).toBeNull();
    expect(cleanCapture({ ...valid(), styles: { display: 1 } })).toBeNull();
    expect(cleanCapture(null)).toBeNull();
    expect(cleanCapture("x")).toBeNull();
    const long = cleanCapture({ ...valid(), html: "a".repeat(5000) });
    expect(long?.html.endsWith("… [tronqué]")).toBe(true);
    expect(long!.html.length).toBeLessThan(5000);
  });

  it("cleanSource: the shape checks", () => {
    expect(cleanSource({ file: {}, line: "x" })).toBeNull();
    expect(cleanSource({ file: {}, line: "x" })).toBeNull();
    expect(cleanSource({ file: "a.svelte", line: -3, column: 1.5 })).toEqual({ file: "a.svelte" });
    expect(cleanSource({ file: "src/A.svelte", line: 12, column: 3 })).toEqual({ file: "src/A.svelte", line: 12, column: 3 });
    expect(cleanSource(null)).toBeNull();
  });

  it("targetKey names a target; the site bubble has its size", () => {
    expect(SITE_BUBBLE_SIZE).toEqual({ width: 320, height: 190 });
    expect(targetKey({ type: "fenetre", windowId: "f1" })).toBe("fenetre:f1");
    expect(targetKey({ type: "app", folder: "essai" })).toBe("app:essai");
    expect(targetKey({ type: "site", id: "tuning" })).toBe("site:tuning");
  });

  it("drift: the home's MOUSE (design-home.ts) is the actor's (design-actor.ts), word for word", () => {
    const mouse = (file: string) => line(readFileSync(path.resolve(import.meta.dirname, file), "utf8").split("\n").map((l) => l.replace(/^export /, "")).join("\n"), "const MOUSE = ");
    expect(mouse("../chrome/store/design-home.ts")).toBe(mouse("../chrome/agent/design-actor.ts"));
    expect(mouse("../chrome/agent/design-actor.ts")).toContain('"pointerdown"');
  });

  it("bubbleSlot: under the element, bounded to the window", () => {
    const bounds = { x: 300, y: 50, width: 900, height: 750 };
    expect(bubbleSlot({ x: 10, y: 20, width: 100, height: 30 }, 1, bounds, [1200, 800])).toEqual({ x: 310, y: 106, width: 320, height: 170 });
    expect(bubbleSlot({ x: 1000, y: 700, width: 50, height: 30 }, 1, bounds, [1200, 800])).toEqual({ x: 880, y: 630, width: 320, height: 170 });
    expect(bubbleSlot({ x: 10, y: 20, width: 100, height: 30 }, 1, { x: 0, y: 356, width: 1200, height: 44 }, [1200, 400], { minHeight: 356, height: 190 })).toEqual({ x: 10, y: 356, width: 320, height: 190 });
    // A site app: an element at the bottom of a short window stays under the 36 px bar (y 36, not 10).
    expect(bubbleSlot({ x: 10, y: 150, width: 50, height: 20 }, 1, { x: 0, y: 36, width: 1200, height: 164 }, [1200, 200], { minHeight: 36, height: 190 })).toEqual({ x: 10, y: 36, width: 320, height: 190 });
    // Zoomed 1.5: the CSS rect scaled into the window.
    expect(bubbleSlot({ x: 100, y: 20, width: 100, height: 30 }, 1.5, bounds, [1200, 800])).toEqual({ x: 450, y: 131, width: 320, height: 170 });
  });
});
