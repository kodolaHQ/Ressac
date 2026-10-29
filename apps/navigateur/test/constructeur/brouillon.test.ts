import { describe, expect, test } from "vitest";
import { ajouterBloc, deplacer, Historique, idPourType, memeBrouillon, regler, relier, renommer, suivreFichier, supprimerBlocs, supprimerLien, versBrouillon, type Brouillon } from "../../src/renderer/constructeur/brouillon";

const vide = (): Brouillon => ({ version: 1, blocs: [], liens: [] });
const bloc = (id: string, type = "code") => ({ id, type, position: { x: 0, y: 0 }, parametres: {} });
const avec = (blocs: Brouillon["blocs"], liens: Brouillon["liens"] = []): Brouillon => ({ version: 1, blocs, liens });

test("ajouter deux ia.trier donne ia-trier puis ia-trier-2", () => {
  const a = ajouterBloc(vide(), "ia.trier", { x: 1, y: 2 }, {});
  const b = ajouterBloc(a.brouillon, "ia.trier", { x: 3, y: 4 }, {});
  expect([a.id, b.id]).toEqual(["ia-trier", "ia-trier-2"]);
  expect(b.brouillon.blocs[1]!.position).toEqual({ x: 3, y: 4 });
});

test("idPourType tronque à 40", () => {
  expect(idPourType("a".repeat(60), []).length).toBe(40);
  expect(idPourType("a".repeat(60), ["a".repeat(40)]).length).toBeLessThanOrEqual(40);
});

test("une seconde sortie n'est pas ajoutée", () => {
  const a = ajouterBloc(vide(), "sortie", { x: 0, y: 0 }, {});
  const b = ajouterBloc(a.brouillon, "sortie", { x: 0, y: 0 }, {});
  expect(b.id).toBe("");
  expect(b.brouillon).toBe(a.brouillon);
});

test("supprimer sortie ne fait rien ; supprimer un bloc retire ses liens", () => {
  const b = avec([bloc("a"), bloc("b"), bloc("sortie", "sortie")], [{ de: "a", vers: "b" }, { de: "b", vers: "sortie" }]);
  expect(supprimerBlocs(b, ["sortie"])).toBe(b);
  const c = supprimerBlocs(b, ["b"]);
  expect(c.blocs.map((x) => x.id)).toEqual(["a", "sortie"]);
  expect(c.liens).toEqual([]);
});

test("relier refuse soi-même, un doublon et un départ depuis sortie", () => {
  const b = avec([bloc("a"), bloc("b"), bloc("sortie", "sortie")]);
  expect(relier(b, "a", "a")).toBe(b);
  expect(relier(b, "sortie", "a")).toBe(b);
  const c = relier(b, "a", "b");
  expect(c.liens).toEqual([{ de: "a", vers: "b" }]);
  expect(relier(c, "a", "b")).toBe(c);
  expect(supprimerLien(c, "a", "b").liens).toEqual([]);
});

test("renommer \"\" retire le nom, 80 caractères sont coupés à 60", () => {
  const b = avec([bloc("a")]);
  const n = renommer(b, "a", "x".repeat(80));
  expect(n.blocs[0]!.nom).toHaveLength(60);
  const r = renommer(n, "a", "");
  expect("nom" in r.blocs[0]!).toBe(false);
});

test("regler remplace les paramètres", () => {
  expect(regler(avec([bloc("a")]), "a", { k: 1 }).blocs[0]!.parametres).toEqual({ k: 1 });
});

test("deplacer : sans changement de position, rend le même brouillon", () => {
  const b = avec([bloc("a"), bloc("b")]);
  expect(deplacer(b, { a: { x: 0, y: 0 } })).toBe(b);
  expect(deplacer(b, {})).toBe(b);
  const c = deplacer(b, { a: { x: 5, y: 6 } });
  expect(c).not.toBe(b);
  expect(c.blocs[0]!.position).toEqual({ x: 5, y: 6 });
});

test("versBrouillon est indulgent", () => {
  expect(versBrouillon({ blocs: [{ id: "a", type: "code" }] })).toEqual({ version: 1, blocs: [{ id: "a", type: "code", position: { x: 0, y: 0 }, parametres: {} }], liens: [] });
  expect(versBrouillon({ blocs: "non" })).toBeNull();
  expect(versBrouillon({ blocs: [{ id: 1, type: "code" }] })).toBeNull();
  expect(versBrouillon(null)).toBeNull();
});

test("memeBrouillon ignore l'ordre des clés", () => {
  const a = avec([{ ...bloc("a"), parametres: { x: 1, y: 2 } }]);
  const b = avec([{ ...bloc("a"), parametres: { y: 2, x: 1 } }]);
  expect(memeBrouillon(a, b)).toBe(true);
});

describe("Historique", () => {
  const etat = (n: number): Brouillon => avec([bloc(`b${n}`)]);
  test("annuler puis rétablir rend les états dans l'ordre", () => {
    const h = new Historique(etat(0));
    h.faire(etat(1)); h.faire(etat(2));
    expect(h.annuler()).toEqual(etat(1));
    expect(h.annuler()).toEqual(etat(0));
    expect(h.annuler()).toBeNull();
    expect(h.retablir()).toEqual(etat(1));
    expect(h.retablir()).toEqual(etat(2));
    expect(h.retablir()).toBeNull();
  });
  test("faire après annuler efface le rétablissement", () => {
    const h = new Historique(etat(0));
    h.faire(etat(1)); h.annuler(); h.faire(etat(5));
    expect(h.retablir()).toBeNull();
  });
  test("101 états : le plus ancien part", () => {
    const h = new Historique(etat(0));
    for (let i = 1; i <= 100; i++) h.faire(etat(i));
    let dernier: Brouillon | null = null, n = 0;
    for (let r = h.annuler(); r; r = h.annuler()) { dernier = r; n++; }
    expect(n).toBe(99);
    expect(dernier).toEqual(etat(1));
  });
  test("reinitialiser vide l'historique", () => {
    const h = new Historique(etat(0));
    h.faire(etat(1)); h.reinitialiser(etat(9));
    expect(h.courant).toEqual(etat(9));
    expect(h.annuler()).toBeNull();
  });
});

describe("suivreFichier", () => {
  const A = avec([bloc("a")]), B = avec([bloc("b")]), C = avec([bloc("c")]), D = avec([bloc("d")]);
  test("écho de notre écriture ignoré", () => {
    expect(suivreFichier({ local: A, dernierConnu: B, disque: B, envoyes: [] })).toBe("ignorer");
    expect(suivreFichier({ local: A, dernierConnu: B, disque: A, envoyes: [] })).toBe("ignorer");
  });
  test("changement de l'agent adopté quand rien n'est en suspens", () => {
    expect(suivreFichier({ local: A, dernierConnu: A, disque: B, envoyes: [] })).toBe("adopter");
  });
  test("proposé quand l'utilisateur a un brouillon non enregistré", () => {
    expect(suivreFichier({ local: C, dernierConnu: A, disque: B, envoyes: [] })).toBe("proposer");
  });
  test("JSON illisible → illisible", () => {
    expect(suivreFichier({ local: A, dernierConnu: A, disque: null, envoyes: [] })).toBe("illisible");
  });
  test("disque égal à un brouillon en vol alors que le local a avancé → ignorer", () => {
    expect(suivreFichier({ local: D, dernierConnu: A, disque: B, envoyes: [B, C] })).toBe("ignorer");
    expect(suivreFichier({ local: D, dernierConnu: A, disque: B, envoyes: [C] })).toBe("proposer");
  });
});
