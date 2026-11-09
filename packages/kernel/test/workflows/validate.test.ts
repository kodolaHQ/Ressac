import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { DEFAULT_CONTEXT, STREAMING_ACTION, OUTPUT_PAGE_DENIED, OUTPUT_PAGE_REQUIRED, WEB_REQUIRED, validateWorkflow, implicitWorkflow } from "../../src/index.js";
import { BLOCK_REGISTRY } from "../../src/workflows/blocks/index.js";

const output = (id = "s", extra: object = {}) => ({ id, type: "sortie", parametres: { vers: "widget", ...extra } });
const wf = (blocks: unknown[], liens: unknown[] = []) => ({ version: 1, blocs: blocks, liens });
const denial = (raw: unknown): string => {
  const r = validateWorkflow(raw);
  if (r.ok) throw new Error("accepté à tort");
  expect(r.erreur.startsWith("Workflow invalide : ")).toBe(true);
  expect(r.erreur.length).toBeLessThanOrEqual(300);
  return r.erreur;
};

test("a valid workflow gives the topological order, ties in block order", () => {
  const r = validateWorkflow(
    wf(
      [
        { id: "c", type: "liste.garder", parametres: { nombre: 3 } },
        { id: "a", type: "source.flux", parametres: { urls: ["https://x.fr/rss"] } },
        { id: "b", type: "source.flux", parametres: { urls: ["https://y.fr/rss"] } },
        output(),
      ],
      [{ de: "a", vers: "c" }, { de: "b", vers: "c" }, { de: "c", vers: "s" }],
    ),
  );
  if (!r.ok) throw new Error(r.erreur);
  expect(r.valide.ordre).toEqual(["a", "b", "c", "s"]);
  expect(r.valide.predecesseurs).toEqual({ c: ["a", "b"], a: [], b: [], s: ["c"] });
  expect(r.valide.sortie).toEqual({ id: "s", vers: "widget" });
});

test("parameters receive their defaults", () => {
  const r = validateWorkflow(wf([{ id: "src", type: "source.flux", parametres: { urls: ["https://x.fr/rss"] } }, { id: "tri", type: "ia.trier", parametres: { question: "q", texte: "t" } }, output()], [{ de: "src", vers: "tri" }, { de: "tri", vers: "s" }]));
  if (!r.ok) throw new Error(r.erreur);
  const sorting = r.valide.workflow.blocs[1]!;
  expect(sorting.parametres).toMatchObject({ seuil: 0.5, champ: "p", siErreur: "sauter" });
  expect(sorting.position).toEqual({ x: 0, y: 0 });
  expect(r.valide.workflow.blocs[2]!.parametres).toEqual({ vers: "widget" });
});

test("the implicit workflow is valid", () => {
  const r = validateWorkflow(implicitWorkflow());
  expect(r.ok && r.valide.ordre).toEqual(["recolte", "sortie"]);
});

test("a JSON not conforming to the schema is refused", () => {
  expect(denial({ version: 2, blocs: [] })).toContain("version");
  expect(denial("pas un objet")).toMatch(/^Workflow invalide : /);
  expect(denial(wf([{ id: "A B", type: "sortie" }]))).toContain("blocs.0.id");
});

test("an unknown type is refused", () => {
  expect(denial(wf([{ id: "x", type: "web.inconnu" }, output()]))).toBe("Workflow invalide : type inconnu : web.inconnu");
});

test("a cycle is named", () => {
  const blocks = [{ id: "a", type: "liste.garder", parametres: { nombre: 1 } }, { id: "b", type: "liste.garder", parametres: { nombre: 1 } }, output()];
  expect(denial(wf(blocks, [{ de: "a", vers: "b" }, { de: "b", vers: "a" }]))).toBe("Workflow invalide : cycle : a → b → a");
  expect(denial(wf(blocks, [{ de: "a", vers: "a" }]))).toBe("Workflow invalide : cycle : a → a");
});

test("a link to a missing block is refused", () => {
  expect(denial(wf([output()], [{ de: "s", vers: "x" }]))).toBe("Workflow invalide : lien vers un bloc absent : x");
});

test("a duplicate block id is refused", () => {
  const b = { id: "a", type: "liste.garder", parametres: { nombre: 1 } };
  expect(denial(wf([b, b, output()]))).toBe("Workflow invalide : id de bloc en double : a");
});

test("one sortie is mandatory and unique", () => {
  expect(denial(wf([{ id: "a", type: "liste.garder", parametres: { nombre: 1 } }]))).toBe("Workflow invalide : aucune sortie");
  expect(denial(wf([output("s1"), output("s2")]))).toBe("Workflow invalide : plusieurs sorties : s1, s2");
});

test("an unknown output destination is refused", () => {
  expect(denial(wf([output("s", { vers: "notification" })]))).toContain("s.vers : vers inconnu : notification");
});

test("invalid parameters are named by the block id", () => {
  expect(denial(wf([{ id: "tri", type: "ia.trier", parametres: { question: "q", texte: "t", seuil: 2 } }, output()]))).toMatch(/^Workflow invalide : tri\.seuil : /);
  expect(denial(wf([{ id: "tri", type: "ia.trier", parametres: { texte: "t" } }, output()]))).toMatch(/tri\.question/);
});

test("source.page: defiler an integer from 0 to 20, optional and without a default (an existing block's hash does not change)", () => {
  const page = (params: object) => wf([{ id: "p", type: "source.page", parametres: { url: "https://a.fr/", ...params } }, output()], [{ de: "p", vers: "s" }]);
  for (const scroll of [21, -1, 1.5, "8"]) expect(denial(page({ defiler: scroll }))).toMatch(/^Workflow invalide : p\.defiler : /);
  const r = validateWorkflow(page({ defiler: 8 }));
  expect(r.ok && r.valide.workflow.blocs[0]!.parametres.defiler).toBe(8);
  const without = validateWorkflow(page({}));
  expect(without.ok && without.valide.workflow.blocs[0]!.parametres).not.toHaveProperty("defiler");
});

test("a code block file outside the folder is refused", () => {
  for (const source of ["../x.mjs", "/etc/x.mjs", "x.js", "a/b.mjs"]) {
    expect(denial(wf([{ id: "c", type: "code", parametres: { source } }, output()]))).toMatch(/^Workflow invalide : c\.source : /);
  }
});

test("parElement is refused on a type that does not accept it", () => {
  expect(denial(wf([{ id: "g", type: "liste.garder", parametres: { nombre: 1, parElement: true } }, output()]))).toContain("g.parElement");
});

test("each registry type has a module and a parameter schema", () => {
  const types = ["source.page", "source.flux", "source.recuperer", "web.chercher", "liste.nouveaux", "liste.dedoublonner", "liste.garder", "ia.trier", "ia.rediger", "code", "sortie"];
  expect([...BLOCK_REGISTRY.keys()].sort()).toEqual([...types].sort());
  for (const t of types) expect(typeof BLOCK_REGISTRY.get(t)!.parametres.safeParse).toBe("function");
  expect(BLOCK_REGISTRY.get("ia.trier")!.parElement).toBe("toujours");
});

test("zod's common messages are worded in French", () => {
  expect(denial({ version: 2, blocs: [] })).toBe('Workflow invalide : version : 1 attendu');
  expect(denial({ version: 1, blocs: "x" })).toBe("Workflow invalide : blocs : liste attendue");
  expect(denial({ version: 1 })).toBe("Workflow invalide : blocs : manquant (liste attendue)");
  expect(denial(wf([{ id: "t", type: "ia.trier", parametres: { question: "q", texte: "t", siErreur: "ignorer" } }, output()]))).toBe(
    'Workflow invalide : t.siErreur : une valeur parmi "sauter", "echouer" attendue',
  );
  expect(denial(wf([{ id: "f", type: "source.flux", parametres: { urls: [] } }, output()]))).toMatch(/^Workflow invalide : f\.urls : au moins 1 élément$/);
  expect(denial(wf([output()], [{ de: "", vers: "s" }]))).toBe("Workflow invalide : liens.0.de : vide");
  expect(denial(wf([{ ...output(), nom: "x".repeat(61) }]))).toBe("Workflow invalide : blocs.0.nom : 60 caractères au plus");
  expect(denial({ ...wf([output()]), autre: 1 })).toBe("Workflow invalide : autre : paramètre inconnu");
  // A message written in a schema is kept as is.
  expect(denial(wf([output("ID!")]))).toContain("id de bloc invalide");
});

test("more than 100 blocks, or more than 400 links: refused", () => {
  const blocks = Array.from({ length: 101 }, (_, i) => ({ id: `b${i}`, type: "liste.garder", parametres: { nombre: 1 } }));
  expect(denial(wf(blocks))).toBe("Workflow invalide : blocs : 100 éléments au plus");
  const liens = Array.from({ length: 401 }, () => ({ de: "s", vers: "s" }));
  expect(denial(wf([output()], liens))).toBe("Workflow invalide : liens : 400 éléments au plus");
  // At the limit: accepted by the schema (100 blocks, 400 links).
  const hundred = [{ id: "b0", type: "source.flux", parametres: { urls: ["https://x.fr/rss"] } }, ...blocks.slice(1, 99), output()];
  const chain = hundred.slice(1).map((b, i) => ({ de: hundred[i]!.id, vers: b.id }));
  const duplicates = Array.from({ length: 400 - chain.length }, () => chain[0]!);
  const r = validateWorkflow(wf(hundred, [...chain, ...duplicates]));
  if (!r.ok) throw new Error(r.erreur);
  expect(r.valide.ordre).toHaveLength(100);
});

const errorBlock = (raw: unknown): string | undefined => {
  const r = validateWorkflow(raw);
  if (r.ok) throw new Error("accepté à tort");
  return r.bloc;
};

test("a parameter error names the block concerned", () => {
  const raw = wf([{ id: "tri", type: "ia.trier", parametres: { question: "q", texte: "t", seuil: 2 } }, output()], [{ de: "tri", vers: "s" }]);
  expect(errorBlock(raw)).toBe("tri");
  expect(errorBlock(wf([{ id: "x", type: "web.inconnu" }, output()]))).toBe("x");
  expect(errorBlock(wf([{ id: "c", type: "liste.garder", parametres: { nombre: 1, parElement: true } }, output()]))).toBe("c");
  expect(errorBlock(wf([{ id: "d", type: "code", parametres: { source: "d.mjs" } }, { id: "d", type: "code", parametres: { source: "d.mjs" } }, output()]))).toBe("d");
  expect(errorBlock(wf([output()], [{ de: "s", vers: "absent" }]))).toBe("s");
  expect(errorBlock(wf([output()], [{ de: "absent", vers: "s" }]))).toBe("s");
  expect(errorBlock(wf([output()], [{ de: "a", vers: "b" }]))).toBeUndefined();
});

test("a cycle names its first block in the array order", () => {
  const blocks = [{ id: "b", type: "liste.garder", parametres: { nombre: 1 } }, { id: "a", type: "liste.garder", parametres: { nombre: 1 } }, output()];
  expect(errorBlock(wf(blocks, [{ de: "a", vers: "b" }, { de: "b", vers: "a" }]))).toBe("b");
});

test("a block whose input is required and without a predecessor is refused", () => {
  const raw = wf([{ id: "top", type: "liste.garder", parametres: { nombre: 3 } }, output()], [{ de: "top", vers: "s" }]);
  expect(denial(raw)).toBe("Workflow invalide : top : entrée manquante (relie un bloc avant lui)");
  expect(errorBlock(raw)).toBe("top");
  const sorting = wf([{ id: "tri", type: "ia.trier", parametres: { question: "q", texte: "t" } }, output()], [{ de: "tri", vers: "s" }]);
  expect(denial(sorting)).toContain("tri : entrée manquante");
});

test("an output without a predecessor is refused", () => {
  expect(denial(wf([output()]))).toBe("Workflow invalide : s : entrée manquante (relie un bloc avant lui)");
});

test("source.page without parElement needs no input; with parElement, it does", () => {
  const updateEntry = (byElement: boolean) =>
    wf([{ id: "p", type: "source.page", parametres: { url: "https://x.fr", parElement: byElement } }, output()], [{ de: "p", vers: "s" }]);
  expect(validateWorkflow(updateEntry(false)).ok).toBe(true);
  expect(denial(updateEntry(true))).toContain("p : entrée manquante");
});

test("the missing input comes after the unique output and the cycles", () => {
  expect(denial(wf([{ id: "top", type: "liste.garder", parametres: { nombre: 3 } }]))).toBe("Workflow invalide : aucune sortie");
});

test("the implicit workflow and the three shipped templates stay valid", () => {
  expect(validateWorkflow(implicitWorkflow()).ok).toBe(true);
  for (const m of ["meteo", "actus-tech", "daily-dev"]) {
    const raw = JSON.parse(readFileSync(new URL(`../../modeles/widgets/${m}/workflow.json`, import.meta.url), "utf8"));
    const r = validateWorkflow(raw);
    expect(r.ok, m + (r.ok ? "" : " : " + r.erreur)).toBe(true);
  }
});

const withPage = (params: Record<string, unknown>) =>
  wf(
    [{ id: "f", type: "source.flux", parametres: { urls: ["https://x.fr/rss"] } }, { id: "p", type: "source.page", parametres: { url: "https://x.fr/{url}", parElement: true, ...params } }, output()],
    [{ de: "f", vers: "p" }, { de: "p", vers: "s" }],
  );

test("budgetSecondes 600 refused without a duration (170 at most), accepted with dureeMaxMinutes 30, 1900 refused (1800 at most)", () => {
  expect(denial(withPage({ budgetSecondes: 600 }))).toBe("Workflow invalide : p.budgetSecondes : 170 au plus");
  expect(validateWorkflow(withPage({ budgetSecondes: 170 })).ok).toBe(true);
  const long = { web: false, dureeMaxMinutes: 30, proprietaire: "widget" as const, saisie: false };
  expect(validateWorkflow(withPage({ budgetSecondes: 600 }), long).ok).toBe(true);
  const r = validateWorkflow(withPage({ budgetSecondes: 1900 }), long);
  expect(r).toEqual({ ok: false, erreur: "Workflow invalide : p.budgetSecondes : 1800 au plus", bloc: "p" });
  expect(validateWorkflow(withPage({ budgetSecondes: 3601 }), { web: false, dureeMaxMinutes: 60, proprietaire: "widget" as const, saisie: false }).ok).toBe(false);
  expect(validateWorkflow(withPage({ budgetSecondes: 600 }), DEFAULT_CONTEXT).ok).toBe(false);
  expect(DEFAULT_CONTEXT).toEqual({ web: false, dureeMaxMinutes: null, proprietaire: "widget" as const, saisie: false });
});

test("garderJours without reutiliser refused on source.page, accepted on liste.nouveaux", () => {
  const r = validateWorkflow(withPage({ garderJours: 7 }));
  expect(r).toEqual({ ok: false, erreur: "Workflow invalide : p.garderJours : seulement avec reutiliser", bloc: "p" });
  const updateEntry = validateWorkflow(withPage({ garderJours: 7, reutiliser: "url" }));
  expect(updateEntry.ok && updateEntry.valide.workflow.blocs[1]!.parametres.garderJours).toBe(7);
  const fresh = wf(
    [{ id: "f", type: "source.flux", parametres: { urls: ["https://x.fr/rss"] } }, { id: "n", type: "liste.nouveaux", parametres: { cle: "url", garderJours: 30 } }, output()],
    [{ de: "f", vers: "n" }, { de: "n", vers: "s" }],
  );
  const lu = validateWorkflow(fresh);
  expect(lu.ok && lu.valide.workflow.blocs[1]!.parametres).toEqual({ cle: "url", garderJours: 30 });
});

test("garderJours 0 and 366 refused", () => {
  expect(denial(withPage({ garderJours: 0, reutiliser: "url" }))).toBe("Workflow invalide : p.garderJours : au moins 1");
  expect(denial(withPage({ garderJours: 366, reutiliser: "url" }))).toBe("Workflow invalide : p.garderJours : 365 au plus");
  expect(denial(withPage({ garderJours: 1.5, reutiliser: "url" }))).toContain("p.garderJours");
});

test("sortie: auFilDeLEau optional, absent from the validated parameters when not written", () => {
  const base = wf([{ id: "f", type: "source.flux", parametres: { urls: ["https://x.fr/rss"] } }, output()], [{ de: "f", vers: "s" }]);
  const r = validateWorkflow(base);
  expect(r.ok && r.valide.workflow.blocs[1]!.parametres).toEqual({ vers: "widget" });
  const stream = validateWorkflow(wf([{ id: "f", type: "source.flux", parametres: { urls: ["https://x.fr/rss"] } }, output("s", { auFilDeLEau: true })], [{ de: "f", vers: "s" }]));
  expect(stream.ok && stream.valide.workflow.blocs[1]!.parametres).toEqual({ vers: "widget", auFilDeLEau: true });
  expect(denial(wf([output("s", { auFilDeLEau: "oui" })]))).toContain("s.auFilDeLEau");
});

test("the three shipped templates and the implicit workflow stay valid, default context", () => {
  expect(validateWorkflow(implicitWorkflow(), DEFAULT_CONTEXT).ok).toBe(true);
  for (const m of ["meteo", "actus-tech", "daily-dev"]) {
    const raw = JSON.parse(readFileSync(new URL(`../../modeles/widgets/${m}/workflow.json`, import.meta.url), "utf8"));
    const r = validateWorkflow(raw, DEFAULT_CONTEXT);
    expect(r.ok, m + (r.ok ? "" : " : " + r.erreur)).toBe(true);
  }
});

const withSearch = (params: Record<string, unknown> = {}) =>
  wf(
    [{ id: "f", type: "source.flux", parametres: { urls: ["https://x.fr/rss"] } }, { id: "w", type: "web.chercher", parametres: { requete: "{titre} avis", parElement: true, ...params } }, output()],
    [{ de: "f", vers: "w" }, { de: "w", vers: "s" }],
  );

test('web.chercher without web: « Workflow invalide : web.chercher : le widget doit déclarer "web": true », block concerned', () => {
  expect(WEB_REQUIRED).toBe('web.chercher : le widget doit déclarer "web": true');
  const expected = { ok: false, erreur: 'Workflow invalide : web.chercher : le widget doit déclarer "web": true', bloc: "w" };
  expect(validateWorkflow(withSearch())).toEqual(expected);
  expect(validateWorkflow(withSearch(), { web: false, dureeMaxMinutes: 30, proprietaire: "widget" as const, saisie: false })).toEqual(expected);
});

test("web.chercher with web: valid, nombre 8 and default champ recherche", () => {
  const r = validateWorkflow(withSearch(), { web: true, dureeMaxMinutes: null, proprietaire: "widget" as const, saisie: false });
  if (!r.ok) throw new Error(r.erreur);
  expect(r.valide.workflow.blocs[1]!.parametres).toEqual({ requete: "{titre} avis", nombre: 8, parElement: true, siErreur: "sauter", champ: "recherche" });
  const web = { web: true, dureeMaxMinutes: null, proprietaire: "widget" as const, saisie: false };
  expect(validateWorkflow(withSearch({ nombre: 21 }), web)).toMatchObject({ ok: false, erreur: "Workflow invalide : w.nombre : 20 au plus", bloc: "w" });
  expect(validateWorkflow(withSearch({ nombre: 0 }), web).ok).toBe(false);
  expect(validateWorkflow(withSearch({ champ: "x".repeat(41) }), web).ok).toBe(false);
});

const action = { web: false, dureeMaxMinutes: null, proprietaire: "action" as const, saisie: false };
const stream = { id: "f", type: "source.flux", parametres: { urls: ["https://x.fr/rss"] } };
const withOutput = (extra: object, to?: string) =>
  wf([stream, { id: "s", type: "sortie", parametres: { ...(to === undefined ? {} : { vers: to }), ...extra } }], [{ de: "f", vers: "s" }]);

test("a widget with vers \"page\" is refused (OUTPUT_PAGE_DENIED, block = the sortie)", () => {
  expect(OUTPUT_PAGE_DENIED).toBe('sortie : vers "page" seulement dans une action');
  expect(validateWorkflow(withOutput({}, "page"))).toEqual({ ok: false, erreur: "Workflow invalide : " + OUTPUT_PAGE_DENIED, bloc: "s" });
});

test("an action with vers \"widget\" or without vers is refused (OUTPUT_PAGE_REQUIRED)", () => {
  expect(OUTPUT_PAGE_REQUIRED).toBe('sortie : une action rend une page (vers: "page")');
  const expected = { ok: false, erreur: "Workflow invalide : " + OUTPUT_PAGE_REQUIRED, bloc: "s" };
  expect(validateWorkflow(withOutput({}, "widget"), action)).toEqual(expected);
  expect(validateWorkflow(withOutput({}), action)).toEqual(expected);
});

test("an action with vers \"page\" is valid, sortie.vers === \"page\"", () => {
  const r = validateWorkflow(withOutput({}, "page"), action);
  if (!r.ok) throw new Error(r.erreur);
  expect(r.valide.sortie).toEqual({ id: "s", vers: "page" });
});

test("auFilDeLEau in an action: STREAMING_ACTION", () => {
  expect(STREAMING_ACTION).toBe("sortie.auFilDeLEau : pas dans une action");
  expect(validateWorkflow(withOutput({ auFilDeLEau: true }, "page"), action)).toEqual({ ok: false, erreur: "Workflow invalide : " + STREAMING_ACTION, bloc: "s" });
  expect(validateWorkflow(withOutput({ auFilDeLEau: false }, "page"), action).ok).toBe(true);
});

test("a widget's validated parameters are identical to before (vers \"widget\", no key added)", () => {
  const r = validateWorkflow(implicitWorkflow(), DEFAULT_CONTEXT);
  if (!r.ok) throw new Error(r.erreur);
  expect(DEFAULT_CONTEXT).toEqual({ web: false, dureeMaxMinutes: null, proprietaire: "widget", saisie: false });
  expect(r.valide.workflow.blocs.find((b) => b.id === "sortie")!.parametres).toEqual({ vers: "widget" });
  expect(validateWorkflow(withOutput({})).ok).toBe(true);
});
