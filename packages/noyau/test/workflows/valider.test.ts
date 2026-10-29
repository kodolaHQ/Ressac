import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { validerWorkflow, workflowImplicite } from "../../src/index.js";
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
  expect(refus(wf([{ id: "x", type: "web.chercher" }, sortie()]))).toBe("Workflow invalide : type inconnu : web.chercher");
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

test("un fichier de bloc code hors du dossier est refusé", () => {
  for (const source of ["../x.mjs", "/etc/x.mjs", "x.js", "a/b.mjs"]) {
    expect(refus(wf([{ id: "c", type: "code", parametres: { source } }, sortie()]))).toMatch(/^Workflow invalide : c\.source : /);
  }
});

test("parElement est refusé sur un type qui ne l'accepte pas", () => {
  expect(refus(wf([{ id: "g", type: "liste.garder", parametres: { nombre: 1, parElement: true } }, sortie()]))).toContain("g.parElement");
});

test("chaque type du registre a un module et un schéma de paramètres", () => {
  const types = ["source.page", "source.flux", "source.recuperer", "liste.nouveaux", "liste.dedoublonner", "liste.garder", "ia.trier", "ia.rediger", "code", "sortie"];
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
  expect(blocErreur(wf([{ id: "x", type: "web.chercher" }, sortie()]))).toBe("x");
  expect(blocErreur(wf([{ id: "c", type: "liste.garder", parametres: { nombre: 1, parElement: true } }, sortie()]))).toBe("c");
  expect(blocErreur(wf([{ id: "d", type: "code", parametres: { source: "d.mjs" } }, { id: "d", type: "code", parametres: { source: "d.mjs" } }, sortie()]))).toBe("d");
  expect(blocErreur(wf([sortie()], [{ de: "s", vers: "absent" }]))).toBe("s");
  expect(blocErreur(wf([sortie()], [{ de: "absent", vers: "s" }]))).toBe("s");
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
