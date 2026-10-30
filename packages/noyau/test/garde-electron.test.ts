import { expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const racine = join(import.meta.dirname, "..");

function fichiers(dossier: string): string[] {
  return readdirSync(dossier, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? fichiers(join(dossier, e.name)) : [join(dossier, e.name)],
  );
}

test("le noyau ne dépend pas d'electron", () => {
  const pkg = JSON.parse(readFileSync(join(racine, "package.json"), "utf8"));
  for (const champ of ["dependencies", "devDependencies", "peerDependencies"]) {
    expect(Object.keys(pkg[champ] ?? {})).not.toContain("electron");
  }
  const sources = fichiers(join(racine, "src"));
  expect(sources.length).toBeGreaterThan(0);
  for (const f of sources) {
    expect(readFileSync(f, "utf8"), f).not.toMatch(/from ["']electron["']|require\(["']electron["']\)/);
  }
});

test("src/workflows n'importe ni widgets/, accueil/, actions/ ni pages/", () => {
  const sources = fichiers(join(racine, "src", "workflows"));
  expect(sources.length).toBeGreaterThan(0);
  // `from "…"`, `import "…"` (effet de bord) et `import("…")` (dynamique).
  const interdit = /(?:\bfrom|\bimport)\s*\(?\s*["'](\.\.\/)+(widgets|accueil|actions|pages)\//;
  for (const exemple of [
    'import { x } from "../widgets/recolte.js";',
    'import "../accueil/donnees.js";',
    'const m = await import("../../widgets/recolte.js");',
    "await import( '../accueil/schemas.js')",
    'import { x } from "../actions/donnees.js";',
    'import { x } from "../pages/plan.js";',
  ]) {
    expect(exemple).toMatch(interdit);
  }
  expect('import { x } from "./acces.js";').not.toMatch(interdit);
  for (const f of sources) {
    expect(readFileSync(f, "utf8"), f).not.toMatch(interdit);
  }
});
