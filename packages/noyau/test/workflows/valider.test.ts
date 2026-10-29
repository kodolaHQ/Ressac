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
  const r = validerWorkflow(wf([{ id: "tri", type: "ia.trier", parametres: { question: "q", texte: "t" } }, sortie()], [{ de: "tri", vers: "s" }]));
  if (!r.ok) throw new Error(r.erreur);
  const tri = r.valide.workflow.blocs[0]!;
  expect(tri.parametres).toMatchObject({ seuil: 0.5, champ: "p", siErreur: "sauter" });
  expect(tri.position).toEqual({ x: 0, y: 0 });
  expect(r.valide.workflow.blocs[1]!.parametres).toEqual({ vers: "widget" });
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
