import { describe, expect, it } from "vitest";
import { colourAlpha, joinPieces, runsToPieces } from "../../core/hide/text-map";

describe("joinPieces", () => {
  it("keeps a field's value apart from the text around it: a run never crosses a field's edge", () => {
    // piecesOf gives a field `block: true` and marks the next piece as a block too.
    const j = joinPieces([
      { text: "Nom :", block: true },
      { text: "Camille Aubrac", block: true, field: true },
      { text: "suite", block: true },
    ]);
    expect(j.text).toBe("Nom :\nCamille Aubrac\nsuite");
    expect(runsToPieces([{ start: 6, end: 20 }], j.starts, [5, 14, 5])).toEqual([[{ piece: 1, from: 0, to: 14 }]]);
  });

  it("joins inline pieces with nothing and block boundaries with a newline", () => {
    const j = joinPieces([
      { text: "Jean ", block: true },
      { text: "Dupont", block: false },
      { text: "Paris", block: true },
    ]);
    expect(j.text).toBe("Jean Dupont\nParis");
    expect(j.starts).toEqual([0, 5, 12]);
  });
});

describe("runsToPieces", () => {
  const pieces = [
    { text: "Jean ", block: false },
    { text: "Dupont", block: false },
    { text: "Paris", block: true },
  ];
  const { starts } = joinPieces(pieces);
  const lengths = pieces.map((p) => p.text.length);

  it("a run spanning two pieces maps to two slices", () => {
    expect(runsToPieces([{ start: 0, end: 11 }], starts, lengths)).toEqual([[{ piece: 0, from: 0, to: 5 }, { piece: 1, from: 0, to: 6 }]]);
  });

  it("a run ending exactly at a piece boundary does not spill into the next piece", () => {
    expect(runsToPieces([{ start: 1, end: 5 }], starts, lengths)).toEqual([[{ piece: 0, from: 1, to: 5 }]]);
  });

  it("the block newline belongs to no piece", () => {
    expect(runsToPieces([{ start: 5, end: 17 }], starts, lengths)).toEqual([[{ piece: 1, from: 0, to: 6 }, { piece: 2, from: 0, to: 5 }]]);
  });
});

describe("colourAlpha", () => {
  it("reads the alpha after the colour's own name, never a digit in it", () => {
    expect(colourAlpha("color(display-p3 1 1 0)")).toBe(1);
    expect(colourAlpha("color(display-p3 1 1 0 / 0)")).toBe(0);
    expect(colourAlpha("rgb(1, 2, 3)")).toBe(1);
    expect(colourAlpha("rgba(1, 2, 3, 0)")).toBe(0);
    expect(colourAlpha("rgb(1 2 3 / 50%)")).toBe(0.5);
    expect(colourAlpha("transparent")).toBe(0);
  });
});
