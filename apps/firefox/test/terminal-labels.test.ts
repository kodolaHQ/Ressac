import { expect, it } from "vitest";
import { labelsOn } from "../ui/components/terminalLabels";

/** A terminal row as xterm stores it: one cell per column, a wide character's second cell empty with width 0. */
const row = (cells: [string, number][]) => ({ length: cells.length, getCell: (x: number) => cells[x] && { getChars: () => cells[x]![0], getWidth: () => cells[x]![1] } });
const narrow = (s: string): [string, number][] => [...s].map((c) => [c, 1]);

it("labelsOn: each label with its first and last cell, counted in columns even after a wide character", () => {
  const label = "⟨iban-" + "a1b2c3d4⟩";
  expect(labelsOn(row(narrow(`IBAN ${label}, carte ⟨carte-00000000⟩`)))).toEqual([
    { label, start: 5, end: 19 },
    { label: "⟨carte-00000000⟩", start: 28, end: 43 },
  ]);
  // 🌊 takes two cells: the label starts one column further than its index in the text.
  expect(labelsOn(row([["🌊", 2], ["", 0], ...narrow(` ${label}`)]))).toEqual([{ label, start: 3, end: 17 }]);
  // Empty cells read as spaces; nothing that only looks like a label.
  expect(labelsOn(row([["", 1], ...narrow("⟨iban-short⟩ ⟨IBAN-A1B2C3D4⟩")]))).toEqual([]);
});
