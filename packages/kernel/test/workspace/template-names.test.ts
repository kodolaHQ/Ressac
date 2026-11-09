import { expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DEFAULT_MODELS } from "../../src/workspace/initialize.js";
import * as N from "../../src/migration/names.js";

/**
 * Guard: the shipped templates (AGENTS.md, CLAUDE.md, the agent profile, the starter widgets) never name an old French
 * format. In a .md file only code is read (inline spans and fenced blocks: the prose stays French), and the block
 * between `<!-- anciens-noms:debut -->` and `<!-- anciens-noms:fin -->` (the old → new table) is skipped.
 */

/** Data keys of the starter widgets' own data (not formats: the meteo harvest writes them, its display reads them). */
const DATA_KEYS = new Set(["heure", "heures", "actuel", "libelle"]);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (s: string) => new RegExp(`(?<![\\w$.-])${esc(s)}(?![\\w$-])`);

const names = [
  ...Object.keys(N.MCP_TOOLS),
  ...Object.keys(N.EXTERNAL_MCP),
  // A bare `sortie` is also a block id (the starters' output block): only the type is checked, below.
  ...Object.keys(N.BLOCK_TYPES).filter((t) => t !== "sortie"),
  ...Object.keys(N.ENGINE_API).filter((n) => /[.{]/.test(n) || ["lirePage", "recuperer", "chercherWeb"].includes(n)),
  ...Object.keys(N.FRAME_MESSAGES).filter((n) => n.startsWith("webaios")),
  ...Object.keys(N.FILES).filter((f) => /^[\w-]+\.\w+$/.test(f)),
  ...Object.keys(N.ENV),
  ...Object.keys(N.DOCKER),
  ...Object.keys(N.ERROR_NAMES),
  "webaios-retouche",
];
const checks: [string, RegExp][] = [
  ...names.map((n): [string, RegExp] => [n, word(n)]),
  ...Object.keys(N.FOLDERS).map((f): [string, RegExp] => [`${f}/`, new RegExp(`(?<![\\w.-])${esc(f)}/`)]),
  // object keys, quoted (JSON) or not (inline code, scripts), and property reads
  ...Object.keys(N.KEYS)
    .filter((k) => !DATA_KEYS.has(k))
    .map((k): [string, RegExp] => [`clé ${k}`, new RegExp(`"${esc(k)}"\\s*:|(?<=[{,]\\s*)${esc(k)}\\s*:|\\.${esc(k)}(?![\\w$-])`)]),
  // message types and block types given as values
  ...[...Object.keys(N.FRAME_MESSAGES), "sortie"].map((t): [string, RegExp] => [`type ${t}`, new RegExp(`\\btype"?\\s*:\\s*"${esc(t)}"`)]),
];

/** The code of a template: whole file, or the code spans and blocks of a .md (outside the marked table). */
function codeOf(file: string, text: string): string {
  if (!file.endsWith(".md")) return text;
  const rest = text.replace(/<!-- anciens-noms:debut -->[\s\S]*?<!-- anciens-noms:fin -->/g, "");
  const blocks = [...rest.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const spans = [...rest.replace(/```[^\n]*\n[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
  return [...blocks, ...spans].join("\n");
}

function files(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(folder, e.name)) : [join(folder, e.name)],
  );
}

test("no old French format name in the shipped templates (outside the marked old-names table)", () => {
  const found: string[] = [];
  for (const path of files(DEFAULT_MODELS)) {
    const code = codeOf(path, readFileSync(path, "utf8"));
    for (const [name, re] of checks) if (re.test(code)) found.push(`${relative(DEFAULT_MODELS, path)} : ${name}`);
  }
  expect(found).toEqual([]);
});

test("the guard sees an old name, and skips the marked table", () => {
  const md = "Écris `recolte.mjs`.\n";
  expect(checks.some(([, re]) => re.test(codeOf("a.md", md)))).toBe(true);
  const marked = "<!-- anciens-noms:debut -->\n`recolte.mjs`, `{ \"nom\": 1 }`\n<!-- anciens-noms:fin -->\nLa récolte, le nom.\n";
  expect(checks.filter(([, re]) => re.test(codeOf("a.md", marked)))).toEqual([]);
  expect(checks.some(([, re]) => re.test(codeOf("w.json", '{ "nom": "x" }')))).toBe(true);
});
