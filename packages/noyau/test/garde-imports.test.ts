import { expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

function files(dossier: string): string[] {
  return readdirSync(dossier, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dossier, e.name)) : [join(dossier, e.name)],
  );
}

test("src/workflows n'importe ni widgets/, accueil/, actions/ ni pages/", () => {
  const sources = files(join(root, "src", "workflows"));
  expect(sources.length).toBeGreaterThan(0);
  // `from "…"`, `import "…"` (side effect) and `import("…")` (dynamic).
  const forbidden = /(?:\bfrom|\bimport)\s*\(?\s*["'](\.\.\/)+(widgets|accueil|actions|pages)\//;
  for (const example of [
    'import { x } from "../widgets/recolte.js";',
    'import "../accueil/donnees.js";',
    'const m = await import("../../widgets/recolte.js");',
    "await import( '../accueil/schemas.js')",
    'import { x } from "../actions/donnees.js";',
    'import { x } from "../pages/plan.js";',
  ]) {
    expect(example).toMatch(forbidden);
  }
  expect('import { x } from "./acces.js";').not.toMatch(forbidden);
  for (const f of sources) {
    expect(readFileSync(f, "utf8"), f).not.toMatch(forbidden);
  }
});
