import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { CONTEXTE_PAR_DEFAUT, FIL_DE_L_EAU_ACTION, SORTIE_PAGE_REFUSEE, SORTIE_PAGE_REQUISE, WEB_REQUIS, validerWorkflow, workflowImplicite } from "../../src/index.js";
import { REGISTRE_BLOCS } from "../../src/workflows/blocs/index.js";

const sortie = (id = "s", extra: object = {}) => ({ id, type: "sortie", parametres: { vers: "widget", ...extra } });
const wf = (blocs: unknown[], liens: unknown[] = []) => ({ version: 1, blocs, liens });
const refus = (brut: unknown): string => {
  const r = validerWorkflow(brut);
  if (r.ok) throw new Error("accepté à tort");
  expect(r.erreur.startsWith("Workflow invalide : ")).toBe(true);
  expect(r.erreur.length).toBeLessThanOrEqual(300);
  return r.erreur;
};

test("un workflow valide donne l'ordre topologique, à égalité dans l'ordre des blocs", () => {
  const r = validerWorkflow(
    wf(
      [
        { id: "c", type: "liste.garder", parametres: { nombre: 3 } },
        { id: "a", type: "source.flux", parametres: { urls: ["https://x.fr/rss"] } },
        { id: "b", type: "source.flux", parametres: { urls: ["https://y.fr/rss"] } },
        sortie(),
      ],
      [{ de: "a", vers: "c" }, { de: "b", vers: "c" }, { de: "c", vers: "s" }],
    ),
  );
  if (!r.ok) throw new Error(r.erreur);
  expect(r.valide.ordre).toEqual(["a", "b", "c", "s"]);
  expect(r.valide.predecesseurs).toEqual({ c: ["a", "b"], a: [], b: [], s: ["c"] });
  expect(r.valide.sortie).toEqual({ id: "s", vers: "widget" });
});

test("les paramètres reçoivent leurs défauts", () => {
  const r = validerWorkflow(wf([{ id: "src", type: "source.flux", parametres: { urls: ["https://x.fr/rss"] } }, { id: "tri", type: "ia.trier", parametres: { question: "q", texte: "t" } }, sortie()], [{ de: "src", vers: "tri" }, { de: "tri", vers: "s" }]));
  if (!r.ok) throw new Error(r.erreur);
  const tri = r.valide.workflow.blocs[1]!;
  expect(tri.parametres).toMatchObject({ seuil: 0.5, champ: "p", siErreur: "sauter" });
  expect(tri.position).toEqual({ x: 0, y: 0 });
  expect(r.valide.workflow.blocs[2]!.parametres).toEqual({ vers: "widget" });
});

test("le workflow implicite est valide", () => {
  const r = validerWorkflow(workflowImplicite());
  expect(r.ok && r.valide.ordre).toEqual(["recolte", "sortie"]);
});

test("un JSON non conforme au schéma est refusé", () => {
  expect(refus({ version: 2, blocs: [] })).toContain("version");
  expect(refus("pas un objet")).toMatch(/^Workflow invalide : /);
  expect(refus(wf([{ id: "A B", type: "sortie" }]))).toContain("blocs.0.id");
});

test("un type inconnu est refusé", () => {
  expect(refus(wf([{ id: "x", type: "web.inconnu" }, sortie()]))).toBe("Workflow invalide : type inconnu : web.inconnu");
});

test("un cycle est nommé", () => {
  const blocs = [{ id: "a", type: "liste.garder", parametres: { nombre: 1 } }, { id: "b", type: "liste.garder", parametres: { nombre: 1 } }, sortie()];
  expect(refus(wf(blocs, [{ de: "a", vers: "b" }, { de: "b", vers: "a" }]))).toBe("Workflow invalide : cycle : a → b → a");
  expect(refus(wf(blocs, [{ de: "a", vers: "a" }]))).toBe("Workflow invalide : cycle : a → a");
});

test("un lien vers un bloc absent est refusé", () => {
  expect(refus(wf([sortie()], [{ de: "s", vers: "x" }]))).toBe("Workflow invalide : lien vers un bloc absent : x");
});

test("un id de bloc en double est refusé", () => {
  const b = { id: "a", type: "liste.garder", parametres: { nombre: 1 } };
  expect(refus(wf([b, b, sortie()]))).toBe("Workflow invalide : id de bloc en double : a");
});

test("une sortie est obligatoire et unique", () => {
  expect(refus(wf([{ id: "a", type: "liste.garder", parametres: { nombre: 1 } }]))).toBe("Workflow invalide : aucune sortie");
  expect(refus(wf([sortie("s1"), sortie("s2")]))).toBe("Workflow invalide : plusieurs sorties : s1, s2");
});

test("une destination de sortie inconnue est refusée", () => {
  expect(refus(wf([sortie("s", { vers: "notification" })]))).toContain("s.vers : vers inconnu : notification");
});

test("des paramètres invalides sont nommés par l'id du bloc", () => {
  expect(refus(wf([{ id: "tri", type: "ia.trier", parametres: { question: "q", texte: "t", seuil: 2 } }, sortie()]))).toMatch(/^Workflow invalide : tri\.seuil : /);
  expect(refus(wf([{ id: "tri", type: "ia.trier", parametres: { texte: "t" } }, sortie()]))).toMatch(/tri\.question/);
});

test("source.page : defiler entier de 0 à 20, facultatif et sans défaut (l'empreinte d'un bloc existant ne change pas)", () => {
  const page = (parametres: object) => wf([{ id: "p", type: "source.page", parametres: { url: "https://a.fr/", ...parametres } }, sortie()], [{ de: "p", vers: "s" }]);
  for (const defiler of [21, -1, 1.5, "8"]) expect(refus(page({ defiler }))).toMatch(/^Workflow invalide : p\.defiler : /);
  const r = validerWorkflow(page({ defiler: 8 }));
  expect(r.ok && r.valide.workflow.blocs[0]!.parametres.defiler).toBe(8);
  const sans = validerWorkflow(page({}));
  expect(sans.ok && sans.valide.workflow.blocs[0]!.parametres).not.toHaveProperty("defiler");
});

test("un fichier de bloc code hors du dossier est refusé", () => {
  for (const source of ["../x.mjs", "/etc/x.mjs", "x.js", "a/b.mjs"]) {
    expect(refus(wf([{ id: "c", type: "code", parametres: { source } }, sortie()]))).toMatch(/^Workflow invalide : c\.source : /);
  }
});

test("parElement est refusé sur un type qui ne l'accepte pas", () => {
  expect(refus(wf([{ id: "g", type: "liste.garder", parametres: { nombre: 1, parElement: true } }, sortie()]))).toContain("g.parElement");
});

test("chaque type du registre a un module et un schéma de paramètres", () => {
  const types = ["source.page", "source.flux", "source.recuperer", "web.chercher", "liste.nouveaux", "liste.dedoublonner", "liste.garder", "ia.trier", "ia.rediger", "code", "sortie"];
  expect([...REGISTRE_BLOCS.keys()].sort()).toEqual([...types].sort());
  for (const t of types) expect(typeof REGISTRE_BLOCS.get(t)!.parametres.safeParse).toBe("function");
  expect(REGISTRE_BLOCS.get("ia.trier")!.parElement).toBe("toujours");
});

test("les messages courants de zod sont dits en français", () => {
  expect(refus({ version: 2, blocs: [] })).toBe('Workflow invalide : version : 1 attendu');
  expect(refus({ version: 1, blocs: "x" })).toBe("Workflow invalide : blocs : liste attendue");
  expect(refus({ version: 1 })).toBe("Workflow invalide : blocs : manquant (liste attendue)");
  expect(refus(wf([{ id: "t", type: "ia.trier", parametres: { question: "q", texte: "t", siErreur: "ignorer" } }, sortie()]))).toBe(
    'Workflow invalide : t.siErreur : une valeur parmi "sauter", "echouer" attendue',
  );
  expect(refus(wf([{ id: "f", type: "source.flux", parametres: { urls: [] } }, sortie()]))).toMatch(/^Workflow invalide : f\.urls : au moins 1 élément$/);
  expect(refus(wf([sortie()], [{ de: "", vers: "s" }]))).toBe("Workflow invalide : liens.0.de : vide");
  expect(refus(wf([{ ...sortie(), nom: "x".repeat(61) }]))).toBe("Workflow invalide : blocs.0.nom : 60 caractères au plus");
  expect(refus({ ...wf([sortie()]), autre: 1 })).toBe("Workflow invalide : autre : paramètre inconnu");
  // Un message écrit dans un schéma est gardé tel quel.
  expect(refus(wf([sortie("ID!")]))).toContain("id de bloc invalide");
});

test("plus de 100 blocs, ou plus de 400 liens : refusé", () => {
  const blocs = Array.from({ length: 101 }, (_, i) => ({ id: `b${i}`, type: "liste.garder", parametres: { nombre: 1 } }));
  expect(refus(wf(blocs))).toBe("Workflow invalide : blocs : 100 éléments au plus");
  const liens = Array.from({ length: 401 }, () => ({ de: "s", vers: "s" }));
  expect(refus(wf([sortie()], liens))).toBe("Workflow invalide : liens : 400 éléments au plus");
  // À la limite : accepté par le schéma (100 blocs, 400 liens).
  const cent = [{ id: "b0", type: "source.flux", parametres: { urls: ["https://x.fr/rss"] } }, ...blocs.slice(1, 99), sortie()];
  const chaine = cent.slice(1).map((b, i) => ({ de: cent[i]!.id, vers: b.id }));
  const doublons = Array.from({ length: 400 - chaine.length }, () => chaine[0]!);
  const r = validerWorkflow(wf(cent, [...chaine, ...doublons]));
  if (!r.ok) throw new Error(r.erreur);
  expect(r.valide.ordre).toHaveLength(100);
});

const blocErreur = (brut: unknown): string | undefined => {
  const r = validerWorkflow(brut);
  if (r.ok) throw new Error("accepté à tort");
  return r.bloc;
};

test("une erreur de paramètre nomme le bloc en cause", () => {
  const brut = wf([{ id: "tri", type: "ia.trier", parametres: { question: "q", texte: "t", seuil: 2 } }, sortie()], [{ de: "tri", vers: "s" }]);
  expect(blocErreur(brut)).toBe("tri");
  expect(blocErreur(wf([{ id: "x", type: "web.inconnu" }, sortie()]))).toBe("x");
  expect(blocErreur(wf([{ id: "c", type: "liste.garder", parametres: { nombre: 1, parElement: true } }, sortie()]))).toBe("c");
  expect(blocErreur(wf([{ id: "d", type: "code", parametres: { source: "d.mjs" } }, { id: "d", type: "code", parametres: { source: "d.mjs" } }, sortie()]))).toBe("d");
  expect(blocErreur(wf([sortie()], [{ de: "s", vers: "absent" }]))).toBe("s");
  expect(blocErreur(wf([sortie()], [{ de: "absent", vers: "s" }]))).toBe("s");
  expect(blocErreur(wf([sortie()], [{ de: "a", vers: "b" }]))).toBeUndefined();
});

test("un cycle nomme son premier bloc dans l'ordre du tableau", () => {
  const blocs = [{ id: "b", type: "liste.garder", parametres: { nombre: 1 } }, { id: "a", type: "liste.garder", parametres: { nombre: 1 } }, sortie()];
  expect(blocErreur(wf(blocs, [{ de: "a", vers: "b" }, { de: "b", vers: "a" }]))).toBe("b");
});

test("un bloc dont l'entrée est requise et sans prédécesseur est refusé", () => {
  const brut = wf([{ id: "top", type: "liste.garder", parametres: { nombre: 3 } }, sortie()], [{ de: "top", vers: "s" }]);
  expect(refus(brut)).toBe("Workflow invalide : top : entrée manquante (relie un bloc avant lui)");
  expect(blocErreur(brut)).toBe("top");
  const tri = wf([{ id: "tri", type: "ia.trier", parametres: { question: "q", texte: "t" } }, sortie()], [{ de: "tri", vers: "s" }]);
  expect(refus(tri)).toContain("tri : entrée manquante");
});

test("une sortie sans prédécesseur est refusée", () => {
  expect(refus(wf([sortie()]))).toBe("Workflow invalide : s : entrée manquante (relie un bloc avant lui)");
});

test("source.page sans parElement n'a pas besoin d'entrée ; avec parElement, si", () => {
  const avec = (parElement: boolean) =>
    wf([{ id: "p", type: "source.page", parametres: { url: "https://x.fr", parElement } }, sortie()], [{ de: "p", vers: "s" }]);
  expect(validerWorkflow(avec(false)).ok).toBe(true);
  expect(refus(avec(true))).toContain("p : entrée manquante");
});

test("l'entrée manquante passe après la sortie unique et les cycles", () => {
  expect(refus(wf([{ id: "top", type: "liste.garder", parametres: { nombre: 3 } }]))).toBe("Workflow invalide : aucune sortie");
});

test("le workflow implicite et les trois modèles livrés restent valides", () => {
  expect(validerWorkflow(workflowImplicite()).ok).toBe(true);
  for (const m of ["meteo", "actus-tech", "daily-dev"]) {
    const brut = JSON.parse(readFileSync(new URL(`../../modeles/widgets/${m}/workflow.json`, import.meta.url), "utf8"));
    const r = validerWorkflow(brut);
    expect(r.ok, m + (r.ok ? "" : " : " + r.erreur)).toBe(true);
  }
});

const avecPage = (parametres: Record<string, unknown>) =>
  wf(
    [{ id: "f", type: "source.flux", parametres: { urls: ["https://x.fr/rss"] } }, { id: "p", type: "source.page", parametres: { url: "https://x.fr/{url}", parElement: true, ...parametres } }, sortie()],
    [{ de: "f", vers: "p" }, { de: "p", vers: "s" }],
  );

test("budgetSecondes 600 refusé sans durée (170 au plus), accepté avec dureeMaxMinutes 30, 1900 refusé (1800 au plus)", () => {
  expect(refus(avecPage({ budgetSecondes: 600 }))).toBe("Workflow invalide : p.budgetSecondes : 170 au plus");
  expect(validerWorkflow(avecPage({ budgetSecondes: 170 })).ok).toBe(true);
  const long = { web: false, dureeMaxMinutes: 30, proprietaire: "widget" as const, saisie: false };
  expect(validerWorkflow(avecPage({ budgetSecondes: 600 }), long).ok).toBe(true);
  const r = validerWorkflow(avecPage({ budgetSecondes: 1900 }), long);
  expect(r).toEqual({ ok: false, erreur: "Workflow invalide : p.budgetSecondes : 1800 au plus", bloc: "p" });
  expect(validerWorkflow(avecPage({ budgetSecondes: 3601 }), { web: false, dureeMaxMinutes: 60, proprietaire: "widget" as const, saisie: false }).ok).toBe(false);
  expect(validerWorkflow(avecPage({ budgetSecondes: 600 }), CONTEXTE_PAR_DEFAUT).ok).toBe(false);
  expect(CONTEXTE_PAR_DEFAUT).toEqual({ web: false, dureeMaxMinutes: null, proprietaire: "widget" as const, saisie: false });
});

test("garderJours sans reutiliser refusé sur source.page, accepté sur liste.nouveaux", () => {
  const r = validerWorkflow(avecPage({ garderJours: 7 }));
  expect(r).toEqual({ ok: false, erreur: "Workflow invalide : p.garderJours : seulement avec reutiliser", bloc: "p" });
  const avec = validerWorkflow(avecPage({ garderJours: 7, reutiliser: "url" }));
  expect(avec.ok && avec.valide.workflow.blocs[1]!.parametres.garderJours).toBe(7);
  const nouveaux = wf(
    [{ id: "f", type: "source.flux", parametres: { urls: ["https://x.fr/rss"] } }, { id: "n", type: "liste.nouveaux", parametres: { cle: "url", garderJours: 30 } }, sortie()],
    [{ de: "f", vers: "n" }, { de: "n", vers: "s" }],
  );
  const lu = validerWorkflow(nouveaux);
  expect(lu.ok && lu.valide.workflow.blocs[1]!.parametres).toEqual({ cle: "url", garderJours: 30 });
});

test("garderJours 0 et 366 refusés", () => {
  expect(refus(avecPage({ garderJours: 0, reutiliser: "url" }))).toBe("Workflow invalide : p.garderJours : au moins 1");
  expect(refus(avecPage({ garderJours: 366, reutiliser: "url" }))).toBe("Workflow invalide : p.garderJours : 365 au plus");
  expect(refus(avecPage({ garderJours: 1.5, reutiliser: "url" }))).toContain("p.garderJours");
});

test("sortie : auFilDeLEau facultatif, absent des paramètres validés quand il n'est pas écrit", () => {
  const base = wf([{ id: "f", type: "source.flux", parametres: { urls: ["https://x.fr/rss"] } }, sortie()], [{ de: "f", vers: "s" }]);
  const r = validerWorkflow(base);
  expect(r.ok && r.valide.workflow.blocs[1]!.parametres).toEqual({ vers: "widget" });
  const fil = validerWorkflow(wf([{ id: "f", type: "source.flux", parametres: { urls: ["https://x.fr/rss"] } }, sortie("s", { auFilDeLEau: true })], [{ de: "f", vers: "s" }]));
  expect(fil.ok && fil.valide.workflow.blocs[1]!.parametres).toEqual({ vers: "widget", auFilDeLEau: true });
  expect(refus(wf([sortie("s", { auFilDeLEau: "oui" })]))).toContain("s.auFilDeLEau");
});

test("les trois modèles livrés et le workflow implicite restent valides, contexte par défaut", () => {
  expect(validerWorkflow(workflowImplicite(), CONTEXTE_PAR_DEFAUT).ok).toBe(true);
  for (const m of ["meteo", "actus-tech", "daily-dev"]) {
    const brut = JSON.parse(readFileSync(new URL(`../../modeles/widgets/${m}/workflow.json`, import.meta.url), "utf8"));
    const r = validerWorkflow(brut, CONTEXTE_PAR_DEFAUT);
    expect(r.ok, m + (r.ok ? "" : " : " + r.erreur)).toBe(true);
  }
});

const avecRecherche = (parametres: Record<string, unknown> = {}) =>
  wf(
    [{ id: "f", type: "source.flux", parametres: { urls: ["https://x.fr/rss"] } }, { id: "w", type: "web.chercher", parametres: { requete: "{titre} avis", parElement: true, ...parametres } }, sortie()],
    [{ de: "f", vers: "w" }, { de: "w", vers: "s" }],
  );

test('web.chercher sans web : « Workflow invalide : web.chercher : le widget doit déclarer "web": true », bloc en cause', () => {
  expect(WEB_REQUIS).toBe('web.chercher : le widget doit déclarer "web": true');
  const attendu = { ok: false, erreur: 'Workflow invalide : web.chercher : le widget doit déclarer "web": true', bloc: "w" };
  expect(validerWorkflow(avecRecherche())).toEqual(attendu);
  expect(validerWorkflow(avecRecherche(), { web: false, dureeMaxMinutes: 30, proprietaire: "widget" as const, saisie: false })).toEqual(attendu);
});

test("web.chercher avec web : valide, nombre 8 et champ recherche par défaut", () => {
  const r = validerWorkflow(avecRecherche(), { web: true, dureeMaxMinutes: null, proprietaire: "widget" as const, saisie: false });
  if (!r.ok) throw new Error(r.erreur);
  expect(r.valide.workflow.blocs[1]!.parametres).toEqual({ requete: "{titre} avis", nombre: 8, parElement: true, siErreur: "sauter", champ: "recherche" });
  const web = { web: true, dureeMaxMinutes: null, proprietaire: "widget" as const, saisie: false };
  expect(validerWorkflow(avecRecherche({ nombre: 21 }), web)).toMatchObject({ ok: false, erreur: "Workflow invalide : w.nombre : 20 au plus", bloc: "w" });
  expect(validerWorkflow(avecRecherche({ nombre: 0 }), web).ok).toBe(false);
  expect(validerWorkflow(avecRecherche({ champ: "x".repeat(41) }), web).ok).toBe(false);
});

const action = { web: false, dureeMaxMinutes: null, proprietaire: "action" as const, saisie: false };
const flux = { id: "f", type: "source.flux", parametres: { urls: ["https://x.fr/rss"] } };
const avecSortie = (extra: object, vers?: string) =>
  wf([flux, { id: "s", type: "sortie", parametres: { ...(vers === undefined ? {} : { vers }), ...extra } }], [{ de: "f", vers: "s" }]);

test("un widget avec vers \"page\" est refusé (SORTIE_PAGE_REFUSEE, bloc = la sortie)", () => {
  expect(SORTIE_PAGE_REFUSEE).toBe('sortie : vers "page" seulement dans une action');
  expect(validerWorkflow(avecSortie({}, "page"))).toEqual({ ok: false, erreur: "Workflow invalide : " + SORTIE_PAGE_REFUSEE, bloc: "s" });
});

test("une action avec vers \"widget\" ou sans vers est refusée (SORTIE_PAGE_REQUISE)", () => {
  expect(SORTIE_PAGE_REQUISE).toBe('sortie : une action rend une page (vers: "page")');
  const attendu = { ok: false, erreur: "Workflow invalide : " + SORTIE_PAGE_REQUISE, bloc: "s" };
  expect(validerWorkflow(avecSortie({}, "widget"), action)).toEqual(attendu);
  expect(validerWorkflow(avecSortie({}), action)).toEqual(attendu);
});

test("une action avec vers \"page\" est valide, sortie.vers === \"page\"", () => {
  const r = validerWorkflow(avecSortie({}, "page"), action);
  if (!r.ok) throw new Error(r.erreur);
  expect(r.valide.sortie).toEqual({ id: "s", vers: "page" });
});

test("auFilDeLEau dans une action : FIL_DE_L_EAU_ACTION", () => {
  expect(FIL_DE_L_EAU_ACTION).toBe("sortie.auFilDeLEau : pas dans une action");
  expect(validerWorkflow(avecSortie({ auFilDeLEau: true }, "page"), action)).toEqual({ ok: false, erreur: "Workflow invalide : " + FIL_DE_L_EAU_ACTION, bloc: "s" });
  expect(validerWorkflow(avecSortie({ auFilDeLEau: false }, "page"), action).ok).toBe(true);
});

test("les paramètres validés d'un widget sont identiques à avant (vers \"widget\", pas de clé ajoutée)", () => {
  const r = validerWorkflow(workflowImplicite(), CONTEXTE_PAR_DEFAUT);
  if (!r.ok) throw new Error(r.erreur);
  expect(CONTEXTE_PAR_DEFAUT).toEqual({ web: false, dureeMaxMinutes: null, proprietaire: "widget", saisie: false });
  expect(r.valide.workflow.blocs.find((b) => b.id === "sortie")!.parametres).toEqual({ vers: "widget" });
  expect(validerWorkflow(avecSortie({})).ok).toBe(true);
});
