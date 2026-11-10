import type { HomeTheme } from "../../../packages/kernel/src/home/theme";

// The theme validated by the kernel becomes CSS variables on the home root; when absent, home keeps the
// application's variables (and follows light/dark mode). A color is re-checked here: nothing but a
// #rrggbb must reach the style, even if the object was not validated.
const COLOR = /^#[0-9a-f]{6}$/i;

/** Theme key → suffix of the `--home-*` variable. */
const COLORS = { background: "bg", card: "card", text: "text", mutedText: "text-muted", accent: "accent", border: "border" } as const;

const FONTS = {
  system: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
  serif: "serif",
  mono: "ui-monospace, monospace",
} as const;

export function variablesTheme(t: HomeTheme | null): Record<string, string> {
  const variables: Record<string, string> = {};
  if (!t) return variables;
  for (const [key, suffix] of Object.entries(COLORS)) {
    const color = t[key as keyof typeof COLORS];
    if (typeof color === "string" && COLOR.test(color)) variables[`--home-${suffix}`] = color;
  }
  if (Number.isInteger(t.radius) && t.radius! >= 0 && t.radius! <= 24) variables["--home-radius"] = `${t.radius}px`;
  if (Number.isInteger(t.spacing) && t.spacing! >= 0 && t.spacing! <= 24) variables["--home-spacing"] = `${t.spacing}px`;
  // hasOwn: « toString » or « constructor » must not pass for a font.
  if (t.font && Object.hasOwn(FONTS, t.font)) variables["--home-font"] = FONTS[t.font];
  return variables;
}
