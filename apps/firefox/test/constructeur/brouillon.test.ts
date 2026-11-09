import { describe, expect, test } from "vitest";
import { ajouterBloc, deplacer, Historique, idPourType, memeBrouillon, regler, relier, renommer, suivreFichier, supprimerBlocs, supprimerLien, versBrouillon, type Brouillon } from "../../ui/constructeur/brouillon";

const vide = (): Brouillon => ({ version: 1, blocs: [], liens: [] });
const bloc = (id: string, type = "code") => ({ id, type, position: { x: 0, y: 0 }, parametres: {} });
const avec = (blocs: Brouillon["blocs"], liens: Brouillon["liens"] = []): Brouillon => ({ version: 1, blocs, liens });

test("adding two ia.trier gives ia-trier then ia-trier-2", () => {
  const a = ajouterBloc(vide(), "ia.trier", { x: 1, y: 2 }, {});
  const b = ajouterBloc(a.brouillon, "ia.trier", { x: 3, y: 4 }, {});
  expect([a.id, b.id]).toEqual(["ia-trier", "ia-trier-2"]);
  expect(b.brouillon.blocs[1]!.position).toEqual({ x: 3, y: 4 });
});

test("idPourType truncates to 40", () => {
  expect(idPourType("a".repeat(60), []).length).toBe(40);
  expect(idPourType("a".repeat(60), ["a".repeat(40)]).length).toBeLessThanOrEqual(40);
});

test("a second output is not added", () => {
  const a = ajouterBloc(vide(), "sortie", { x: 0, y: 0 }, {});
  const b = ajouterBloc(a.brouillon, "sortie", { x: 0, y: 0 }, {});
  expect(b.id).toBe("");
  expect(b.brouillon).toBe(a.brouillon);
});

test("supprimer output does nothing; supprimer a block removes its links", () => {
  const b = avec([bloc("a"), bloc("b"), bloc("sortie", "sortie")], [{ de: "a", vers: "b" }, { de: "b", vers: "sortie" }]);
  expect(supprimerBlocs(b, ["sortie"])).toBe(b);
  const c = supprimerBlocs(b, ["b"]);
  expect(c.blocs.map((x) => x.id)).toEqual(["a", "sortie"]);
  expect(c.liens).toEqual([]);
});

test("relier refuses itself, a duplicate and a start from an output", () => {
  const b = avec([bloc("a"), bloc("b"), bloc("sortie", "sortie")]);
  expect(relier(b, "a", "a")).toBe(b);
  expect(relier(b, "sortie", "a")).toBe(b);
  const c = relier(b, "a", "b");
  expect(c.liens).toEqual([{ de: "a", vers: "b" }]);
  expect(relier(c, "a", "b")).toBe(c);
  expect(supprimerLien(c, "a", "b").liens).toEqual([]);
});

test("renommer \"\" removes the name, 80 characters are cut to 60", () => {
  const b = avec([bloc("a")]);
  const n = renommer(b, "a", "x".repeat(80));
  expect(n.blocs[0]!.nom).toHaveLength(60);
  const r = renommer(n, "a", "");
  expect("nom" in r.blocs[0]!).toBe(false);
});

test("regler replaces the params", () => {
  expect(regler(avec([bloc("a")]), "a", { k: 1 }).blocs[0]!.parametres).toEqual({ k: 1 });
});

test("deplacer: without a position change, returns the same draft", () => {
  const b = avec([bloc("a"), bloc("b")]);
  expect(deplacer(b, { a: { x: 0, y: 0 } })).toBe(b);
  expect(deplacer(b, {})).toBe(b);
  const c = deplacer(b, { a: { x: 5, y: 6 } });
  expect(c).not.toBe(b);
  expect(c.blocs[0]!.position).toEqual({ x: 5, y: 6 });
});

test("deplacer ignores non-finite positions", () => {
  const b = avec([bloc("a")]);
  expect(deplacer(b, { a: { x: NaN, y: 1 } })).toBe(b);
  expect(deplacer(b, { a: { x: 1, y: Infinity } })).toBe(b);
});

test("versBrouillon is lenient", () => {
  expect(versBrouillon({ blocs: [{ id: "a", type: "code" }] })).toEqual({ version: 1, blocs: [{ id: "a", type: "code", position: { x: 0, y: 0 }, parametres: {} }], liens: [] });
  expect(versBrouillon({ blocs: "non" })).toBeNull();
  expect(versBrouillon({ blocs: [{ id: 1, type: "code" }] })).toBeNull();
  expect(versBrouillon(null)).toBeNull();
});

test("memeBrouillon ignores key order", () => {
  const a = avec([{ ...bloc("a"), parametres: { x: 1, y: 2 } }]);
  const b = avec([{ ...bloc("a"), parametres: { y: 2, x: 1 } }]);
  expect(memeBrouillon(a, b)).toBe(true);
});

describe("Historique", () => {
  const etat = (n: number): Brouillon => avec([bloc(`b${n}`)]);
  test("annuler then rétablir returns the states in order", () => {
    const h = new Historique(etat(0));
    h.faire(etat(1)); h.faire(etat(2));
    expect(h.annuler()).toEqual(etat(1));
    expect(h.annuler()).toEqual(etat(0));
    expect(h.annuler()).toBeNull();
    expect(h.retablir()).toEqual(etat(1));
    expect(h.retablir()).toEqual(etat(2));
    expect(h.retablir()).toBeNull();
  });
  test("faire after annuler clears the redo", () => {
    const h = new Historique(etat(0));
    h.faire(etat(1)); h.annuler(); h.faire(etat(5));
    expect(h.retablir()).toBeNull();
  });
  test("101 states: the oldest goes", () => {
    const h = new Historique(etat(0));
    for (let i = 1; i <= 100; i++) h.faire(etat(i));
    let dernier: Brouillon | null = null, n = 0;
    for (let r = h.annuler(); r; r = h.annuler()) { dernier = r; n++; }
    expect(n).toBe(99);
    expect(dernier).toEqual(etat(1));
  });
  test("reinitialiser clears the history", () => {
    const h = new Historique(etat(0));
    h.faire(etat(1)); h.reinitialiser(etat(9));
    expect(h.courant).toEqual(etat(9));
    expect(h.annuler()).toBeNull();
  });
});

describe("suivreFichier", () => {
  const A = avec([bloc("a")]), B = avec([bloc("b")]), C = avec([bloc("c")]), D = avec([bloc("d")]);
  test("echo of our own write ignored", () => {
    expect(suivreFichier({ local: A, dernierConnu: B, disque: B, envoyes: [] })).toBe("ignorer");
    expect(suivreFichier({ local: A, dernierConnu: B, disque: A, envoyes: [] })).toBe("ignorer");
  });
  test("agent change adopted when nothing is pending", () => {
    expect(suivreFichier({ local: A, dernierConnu: A, disque: B, envoyes: [] })).toBe("adopter");
  });
  test("offered when the user has an unsaved draft", () => {
    expect(suivreFichier({ local: C, dernierConnu: A, disque: B, envoyes: [] })).toBe("proposer");
  });
  test("first load (dernierConnu null) and different disk → offer", () => {
    expect(suivreFichier({ local: A, dernierConnu: null, disque: B, envoyes: [] })).toBe("proposer");
  });
  test("unreadable JSON → illisible", () => {
    expect(suivreFichier({ local: A, dernierConnu: A, disque: null, envoyes: [] })).toBe("illisible");
  });
  test("disk equal to an in-flight draft while the local one moved on → ignore", () => {
    expect(suivreFichier({ local: D, dernierConnu: A, disque: B, envoyes: [B, C] })).toBe("ignorer");
    expect(suivreFichier({ local: D, dernierConnu: A, disque: B, envoyes: [C] })).toBe("proposer");
  });
});
