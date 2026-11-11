/** A space's aura: three colors that tint the window chrome, plus an accent per theme (AA contrast). */
export const AURA_IDS = ["aube", "lagon", "verger", "glacier", "braise"] as const;
export type AuraId = (typeof AURA_IDS)[number];
export const DEFAULT_AURA: AuraId = "aube";

export interface Aura {
  name: string;
  colors: [string, string, string];
  accentLight: string;
  accentDark: string;
}

export const AURAS: Record<AuraId, Aura> = {
  aube: { name: "Aube", colors: ["#FF9F7A", "#FF6F91", "#FFD36E"], accentLight: "#C23A5E", accentDark: "#FF8FA8" },
  lagon: { name: "Lagon", colors: ["#4FD1C5", "#3B8BEB", "#B7F0D8"], accentLight: "#1D64C8", accentDark: "#6FB3FF" },
  verger: { name: "Verger", colors: ["#A3D977", "#2F9E6E", "#F2E27D"], accentLight: "#2B7A4B", accentDark: "#8FD18A" },
  glacier: { name: "Glacier", colors: ["#9CC3FF", "#7FE0F0", "#E8D9FF"], accentLight: "#3563C9", accentDark: "#9CC3FF" },
  braise: { name: "Braise", colors: ["#FF7A45", "#E8384F", "#FFB86B"], accentLight: "#C02A3C", accentDark: "#FF8A6B" },
};

export function auraVariables(id: AuraId): Record<string, string> {
  const { colors, accentLight, accentDark } = AURAS[id];
  return { "--a1": colors[0], "--a2": colors[1], "--a3": colors[2], "--aura-accent-light": accentLight, "--aura-accent-dark": accentDark };
}
