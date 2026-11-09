import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test } from "vitest";

// French words a binding or file name may no longer contain (members and stored keys are not checked yet).
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
/** Binding names declared in a module: variables, functions, classes, types, parameters, local imports. */
export function bindings(code: string, svelte = false): string[] {
  const out: string[] = [];
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
    switch (node.type) {
      case "VariableDeclarator": pattern(node.id as Node); break;
      case "FunctionDeclaration": case "FunctionExpression": case "ArrowFunctionExpression":
        if ((node.id as Node | null)?.name) out.push((node.id as Node).name as string);
        for (const p of node.params as Node[]) if (p.type !== "TSParameterProperty") pattern(p);
        break;
      case "ClassDeclaration": case "TSInterfaceDeclaration": case "TSTypeAliasDeclaration": case "TSEnumDeclaration":
        if (node.id) out.push((node.id as Node).name as string);
        break;
      case "ImportDefaultSpecifier": case "ImportNamespaceSpecifier": out.push((node.local as Node).name as string); break;
      case "CatchClause": pattern(node.param as Node); break;
    }
    for (const k in node) if (k !== "type" && typeof node[k] === "object") walk(node[k], node);
  };
  walk(parseAst(code, { lang: "ts" }).body);
  return out;
}

test("the guard sees French binding names", () => {
  const found = bindings("const etatOnglet = 1; function ouvrir(fenetre: string) {} type Donnees = {}; class A { constructor(readonly nom: string) {} }");
  expect(found.flatMap(french).sort()).toEqual(["donnees", "etat", "fenetre", "onglet", "ouvrir"]);
  expect(bindings("export function lire() {} let x = 1;", true)).toEqual(["x"]);
});

test("no binding or file name under apps/firefox and packages/kernel is French", (ctx) => {
  const r = spawnSync("git", ["ls-files", "apps/firefox", "packages/kernel"], { cwd: repoRoot, encoding: "utf8" });
  if (r.error || r.status !== 0) return ctx.skip();
  // shortcut: docker/ and modeles/ (agent-facing API, shipped templates) and the engine's src/ are renamed with the formats (plan 41).
  const files = r.stdout.split("\n").filter((f) => f && !/^packages\/kernel\/(docker|modeles)\/|^apps\/firefox\/src\//.test(f));
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
