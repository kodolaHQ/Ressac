import { expect, test } from "vitest";
import { AURA_IDS, AURAS, auraVariables } from "../shared/aura";

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

test("auraVariables gives the three colors and both accents", () => {
  expect(auraVariables("lagon")).toMatchObject({ "--a2": "#3B8BEB", "--aura-accent-light": "#1D64C8", "--aura-accent-dark": "#6FB3FF" });
});

test.each(AURA_IDS)("%s: three #RRGGBB colors and AA accents on both themes", (id) => {
  const a = AURAS[id];
  for (const c of [...a.colors, a.accentLight, a.accentDark]) expect(c).toMatch(/^#[0-9A-F]{6}$/);
  expect(contrast(a.accentLight, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
  expect(contrast(a.accentDark, "#0E1014")).toBeGreaterThanOrEqual(4.5);
});
