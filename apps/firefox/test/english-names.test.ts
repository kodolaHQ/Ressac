import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test } from "vitest";
import * as NAMES from "../../../packages/kernel/src/migration/names";

// French words a binding, member or file name may no longer contain.
const FORBIDDEN = new Set(
  ("etat fenetre fenetres onglet onglets espace espaces accueil fichier fichiers dossier dossiers chemin chemins donnees erreur erreurs " +
    "texte textes nom noms cle cles liste resultat resultats profil profils projet projets memoire recolte relecture noyau hote retouche " +
    "retouches empreinte accord accords ouvrir fermer ecrire lire enregistrer supprimer ajouter afficher attendre demarrer arreter " +
    "envoyer garder valider charger creer chercher lancer executer traiter trier rediger saisie libelle brouillon demande panneau " +
    "barre bouton composant composants parametres adresse adresses delai duree suivi refus atelier viseur panier sonde").split(" "),
);

const repoRoot = join(import.meta.dirname, "..", "..", "..");
// Rolldown ships with vite: its oxc parser reads TypeScript (TS 7 has no JS API).
const { parseAst } = (await import(createRequire(createRequire(import.meta.url).resolve("vite")).resolve("rolldown/parseAst"))) as {
  parseAst: (code: string, o: { lang: "ts" }) => { body: unknown[] };
};

const words = (name: string) =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/[-_.$]/g, " ").toLowerCase().split(/\s+/);
const french = (name: string) => words(name).filter((w) => FORBIDDEN.has(w));

type Node = { type: string; [k: string]: unknown };
type Names = { bindings: string[]; members: string[]; keys: string[]; reads: string[]; strings: string[] };
const keyName = (k: Node | undefined) =>
  k?.type === "Identifier" ? (k.name as string) : k?.type === "Literal" && typeof k.value === "string" ? k.value : undefined;

/**
 * Names in a module. bindings: variables, functions, classes, types, parameters, local imports. members: class,
 * interface, type-literal and enum members. keys: object literal and destructuring keys. reads: `.x` property reads.
 * strings: string literals and templates without expressions.
 */
export function names(code: string, svelte = false): Names {
  const found: Names = { bindings: [], members: [], keys: [], reads: [], strings: [] };
  const out = found.bindings;
  const pattern = (p: Node | null | undefined): void => {
    if (!p) return;
    if (p.type === "Identifier") out.push(p.name as string);
    else if (p.type === "ObjectPattern") for (const q of p.properties as Node[]) pattern(q.type === "RestElement" ? q : (q.value as Node));
    else if (p.type === "ArrayPattern") for (const q of p.elements as Node[]) pattern(q);
    else if (p.type === "AssignmentPattern") pattern(p.left as Node);
    else if (p.type === "RestElement") pattern(p.argument as Node);
  };
  const walk = (n: unknown, parent?: Node): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, parent));
    const node = n as Node;
    // A Svelte component's exports are its instance API (members).
    if (svelte && node.type === "ExportNamedDeclaration") return;
    const key = node.computed ? undefined : keyName(node.key as Node);
    switch (node.type) {
      case "Property": if (key !== undefined) found.keys.push(key); break;
      case "PropertyDefinition": case "MethodDefinition": case "AccessorProperty": case "TSPropertySignature": case "TSMethodSignature":
        if (key !== undefined) found.members.push(key);
        break;
      case "TSEnumMember": if (keyName(node.id as Node) !== undefined) found.members.push(keyName(node.id as Node)!); break;
      case "MemberExpression": if (!node.computed) found.reads.push((node.property as Node).name as string); break;
      case "Literal": if (typeof node.value === "string") found.strings.push(node.value); break;
      case "TemplateLiteral": if ((node.quasis as Node[]).length === 1) found.strings.push(((node.quasis as Node[])[0]!.value as { cooked: string }).cooked); break;
      case "VariableDeclarator": pattern(node.id as Node); break;
      case "FunctionDeclaration": case "FunctionExpression": case "ArrowFunctionExpression":
        if ((node.id as Node | null)?.name) out.push((node.id as Node).name as string);
        for (const p of node.params as Node[]) if (p.type !== "TSParameterProperty") pattern(p);
        break;
      case "ClassDeclaration": case "TSInterfaceDeclaration": case "TSTypeAliasDeclaration": case "TSEnumDeclaration":
        if (node.id) out.push((node.id as Node).name as string);
        break;
      case "ImportDefaultSpecifier": case "ImportNamespaceSpecifier": case "ImportSpecifier": out.push((node.local as Node).name as string); break;
      case "CatchClause": pattern(node.param as Node); break;
    }
    for (const k in node) if (k !== "type" && typeof node[k] === "object") walk(node[k], node);
  };
  walk(parseAst(code, { lang: "ts" }).body);
  return found;
}
export const bindings = (code: string, svelte = false) => names(code, svelte).bindings;

/** Every English name of NAMES: an old name spelled like one of them is an English word, not a leftover. */
const ENGLISH = new Set(Object.values(NAMES).flatMap((m) => Object.values(m).flatMap((v) => (typeof v === "string" ? [v] : Object.values(v)))));
// `declare` (the external registry's method) and `applications` (WebExtension manifest key) are English too.
for (const w of ["declare", "applications"]) ENGLISH.add(w);
const old = (maps: object[]) => new Set(maps.flatMap((m) => Object.keys(m)).filter((k) => k.length > 1 && !ENGLISH.has(k)));
const { KEYS, ENGINE_FIELDS, KEY_EXCEPTIONS, VALUE_EXCEPTIONS, ...FORMATS } = NAMES;
/** Old object keys of the stored and wire formats. */
const OLD_KEYS = old([KEYS, ENGINE_FIELDS, ...Object.values(KEY_EXCEPTIONS)]);
/** Old names given as strings: values, file and folder names, methods, tools, messages, variables… */
const OLD_STRINGS = old([...Object.values(FORMATS), ...Object.values(VALUE_EXCEPTIONS)]);

/** Old French names (or French member names) that stay on purpose, by file. */
const KEPT: Record<string, string[]> = {
  // CSS classes and custom properties
  "apps/firefox/ui/builder/BlockNode.svelte": ["echec", "en-cours"],
  "apps/firefox/ui/builder/labels.ts": ["echec"],
  "apps/firefox/ui/components/DiffFile.svelte": ["contexte"],
  "apps/firefox/ui/theme.ts": ["texte"],
  "apps/firefox/e2e/builder-runs.e2e.ts": ["en-cours"],
  // data-testids
  "apps/firefox/e2e/actions-scenarios.e2e.ts": ["en-attente"],
  // the test page's field ids, read back by the test extension
  "apps/firefox/e2e/agent-extensions-guards.e2e.ts": ["texte"],
  // visible French texts
  "apps/firefox/ui/action/ActionHeader.svelte": ["partielle", "interrompue"],
  "apps/firefox/ui/builder/BlockOutput.svelte": ["partiel", "interrompu", "repris"],
  "apps/firefox/ui/components/DesignBasket.svelte": ["lu"],
  "packages/kernel/src/mcp/extensions.ts": ["espace"],
  "packages/kernel/src/pages/preview.ts": ["texte", "textes", "nombre", "liste"],
  "packages/kernel/src/pages/resolve.ts": ["non"],
  // field names an agent may write in French: the fallback layout looks for them
  "packages/kernel/src/pages/fallback.ts": ["lien", "titre"],
};

/**
 * Old format names left in code: members (all files), and in product code object keys and `.x` reads equal to an old
 * format key. Strings equal to an old format name: in product code any; in tests and e2e only the compound ones
 * (`agent.demarrer`, `recolte.mjs`…), since their plain French words are fixture data (block ids, agent outputs).
 */
export function leftovers(file: string, code: string, svelte = false): string[] {
  const n = names(code, svelte);
  const test = /\/(test|e2e)\//.test(file);
  const kept = new Set(KEPT[file]);
  const member = (k: string) => /^[\w$]+$/.test(k) && french(k).length > 0 && !kept.has(k);
  return [
    ...n.members.filter((k) => member(k) || (!test && OLD_KEYS.has(k))).map((k) => `member ${k}`),
    ...(test ? [] : n.keys.filter((k) => member(k) || OLD_KEYS.has(k)).map((k) => `key ${k}`)),
    ...(test ? [] : n.reads.filter((k) => OLD_KEYS.has(k)).map((k) => `.${k}`)),
    ...n.strings.filter((s) => OLD_STRINGS.has(s) && !kept.has(s) && (!test || /[^a-z]/.test(s))).map((s) => `"${s}"`),
  ];
}

test("the guard sees French binding names", () => {
  const found = bindings("import { x as noyau } from 'y'; const etatOnglet = 1; function ouvrir(fenetre: string) {} type Donnees = {}; class A { constructor(readonly nom: string) {} }");
  expect(found.flatMap(french).sort()).toEqual(["donnees", "etat", "fenetre", "noyau", "onglet", "ouvrir"]);
  expect(bindings("export function lire() {} let x = 1;", true)).toEqual(["x"]);
});

test("the guard sees French members, old format keys and old format strings", () => {
  const code = "class A { fermer() {} } type T = { nomOnglet: string }; const o = { titre: 1, url: 2 }; o.espaceId; f('agent.demarrer', 'sortie');";
  expect(leftovers("apps/firefox/ui/a.ts", code)).toEqual(["member fermer", "member nomOnglet", "key titre", ".espaceId", '"agent.demarrer"', '"sortie"']);
  // In tests the plain words are fixture data; `declare` is English.
  expect(leftovers("apps/firefox/test/a.test.ts", code + " r.declare();")).toEqual(["member fermer", "member nomOnglet", '"agent.demarrer"']);
});

test("no old French member, format key or format string under apps/firefox and packages/kernel", (ctx) => {
  const r = spawnSync("git", ["ls-files", "apps/firefox", "packages/kernel"], { cwd: repoRoot, encoding: "utf8" });
  if (r.error || r.status !== 0) return ctx.skip();
  // Old names on purpose: the migration and its fixtures (kernel and Firefox store), the shipped harvests kept byte for
  // byte, the guards themselves. modeles/ has its own guard (template-names.test.ts).
  // shortcut: the extension guard scripts (packages/kernel/extensions/*.js) and the e2e spikes (.js/.mjs) are not read; read them once renamed.
  const skip =
    /^packages\/kernel\/(src\/migration|test\/migration|test\/workspace\/shipped-harvests|modeles)\/|^apps\/firefox\/src\/|^apps\/firefox\/(chrome\/store\/migration\.ts|test\/migration-store\.test\.ts|e2e\/migration\.e2e\.ts|test\/english-names\.test\.ts)$|\/template-names\.test\.ts$/;
  const files = r.stdout.split("\n").filter((f) => !skip.test(f) && /\.(ts|mts|svelte)$|^packages\/kernel\/docker\/.*\.mjs$/.test(f));
  const bad: string[] = [];
  for (const f of files) {
    let code = readFileSync(join(repoRoot, f), "utf8");
    if (f.endsWith(".svelte")) code = [...code.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n"); // shortcut: markup is not read
    for (const l of leftovers(f, code, f.endsWith(".svelte"))) bad.push(`${f}: ${l}`);
  }
  expect([...new Set(bad)]).toEqual([]);
});

test("no binding or file name under apps/firefox and packages/kernel is French", (ctx) => {
  const r = spawnSync("git", ["ls-files", "apps/firefox", "packages/kernel"], { cwd: repoRoot, encoding: "utf8" });
  if (r.error || r.status !== 0) return ctx.skip();
  // modeles/ has its own guard (template-names.test.ts: its block files are agent data ids); the migration fixtures are old data on purpose.
  const files = r.stdout.split("\n").filter((f) => f && !/^packages\/kernel\/(modeles|test\/migration\/fixtures)\//.test(f));
  const bad: string[] = [];
  for (const f of files) {
    if (/\.(ts|mts|js|mjs|cjs|svelte)$/.test(f) && french(f.split("/").pop()!).length) bad.push(`${f}: file name`);
    for (const d of f.split("/").slice(0, -1)) if (french(d).length) bad.push(`${f}: folder ${d}`);
    if (!/\.(ts|mts|svelte)$/.test(f)) continue;
    let code = readFileSync(join(repoRoot, f), "utf8");
    if (f.endsWith(".svelte")) code = [...code.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n"); // shortcut: names declared in markup ({#each as x}) are not read
    for (const n of bindings(code, f.endsWith(".svelte"))) if (french(n).length) bad.push(`${f}: ${n}`);
  }
  expect([...new Set(bad)]).toEqual([]);
});
