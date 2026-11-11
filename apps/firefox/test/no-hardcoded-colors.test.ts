import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Aura guard: every colour of the interface comes from ui/theme.css's tokens (DESIGN.md). A literal colour in a
 * component (hex, rgb(), hsl(), white / black) is a surface that would turn grey again when the aura or the theme
 * changes.
 */
const ROOT = path.resolve(import.meta.dirname, "..");
const SCANNED = [
  ["ui", /\.(svelte|css)$/],
  ["chrome", /\.ts$/],
] as const;
/** Whole files: the tokens themselves. */
const ALLOWED_FILES = new Set(["ui/theme.css"]);
/** Single lines, each with its reason: the line's text must still contain `match`. */
const ALLOWED_LINES: { file: string; match: string; reason: string }[] = [
  {
    file: "chrome/window/widget-frame.ts",
    match: "light-dark(#c9473e, #e5736b)",
    reason: "an isolated srcdoc error page: it cannot read the UI's tokens",
  },
  {
    file: "chrome/agent/bridge.ts",
    match: 'drawSnapshot(null, 1, "white")',
    reason: "the backdrop of a web page's snapshot for the agent, not a UI colour",
  },
  {
    file: "chrome/store/design.ts",
    match: '"white", { drawView: true }',
    reason: "the backdrop of a web page's snapshot for the design mode, not a UI colour",
  },
];

// `%23…`: a hex escaped in a data: URI (an SVG chevron).
const COLOR = /(?:#|%23)[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(\s*[\d.]|(?<![-\w])(?:white|black)(?![-\w])/;

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && ext.test(e.name))
    .map((e) => path.relative(ROOT, path.join(e.parentPath, e.name)));
}

/** The source without its comments, line numbers kept. */
function withoutComments(source: string): string[] {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .split("\n")
    // A line comment, not the `//` of a URL (`https://`).
    .map((line) => line.replace(/(^|[^:"'`])\/\/.*$/, "$1"));
}

export function hardcodedColors(): string[] {
  const found: string[] = [];
  for (const [dir, ext] of SCANNED) {
    for (const file of files(dir, ext)) {
      if (ALLOWED_FILES.has(file)) continue;
      withoutComments(readFileSync(path.join(ROOT, file), "utf8")).forEach((line, i) => {
        if (!COLOR.test(line)) return;
        // --accent-ink is the one token a component may set to white / black (text on the accent).
        if (/--accent-ink\s*:/.test(line) && !/#|rgba?\(|hsla?\(/.test(line)) return;
        if (ALLOWED_LINES.some((a) => a.file === file && line.includes(a.match))) return;
        found.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  return found;
}

describe("no hard-coded colours", () => {
  it("every colour of ui/ and chrome/ comes from the theme's tokens", () => {
    expect(hardcodedColors()).toEqual([]);
  });

  it("the allowed lines still exist (a stale exception would hide nothing)", () => {
    for (const a of ALLOWED_LINES) expect(readFileSync(path.join(ROOT, a.file), "utf8"), a.file).toContain(a.match);
  });
});
