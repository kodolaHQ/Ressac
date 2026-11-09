import { describe, expect, test } from "vitest";
import { addBlock, move, History, idForType, sameDraft, set, link, rename, followFile, deleteBlocks, deleteLink, toDraft, type Brouillon } from "../../ui/builder/draft";

const empty = (): Brouillon => ({ version: 1, blocs: [], liens: [] });
const block = (id: string, type = "code") => ({ id, type, position: { x: 0, y: 0 }, parametres: {} });
const updateEntry = (blocks: Brouillon["blocs"], liens: Brouillon["liens"] = []): Brouillon => ({ version: 1, blocs: blocks, liens });

test("adding two ia.trier gives ia-trier then ia-trier-2", () => {
  const a = addBlock(empty(), "ia.trier", { x: 1, y: 2 }, {});
  const b = addBlock(a.brouillon, "ia.trier", { x: 3, y: 4 }, {});
  expect([a.id, b.id]).toEqual(["ia-trier", "ia-trier-2"]);
  expect(b.brouillon.blocs[1]!.position).toEqual({ x: 3, y: 4 });
});

test("idPourType truncates to 40", () => {
  expect(idForType("a".repeat(60), []).length).toBe(40);
  expect(idForType("a".repeat(60), ["a".repeat(40)]).length).toBeLessThanOrEqual(40);
});

test("a second output is not added", () => {
  const a = addBlock(empty(), "sortie", { x: 0, y: 0 }, {});
  const b = addBlock(a.brouillon, "sortie", { x: 0, y: 0 }, {});
  expect(b.id).toBe("");
  expect(b.brouillon).toBe(a.brouillon);
});

test("supprimer output does nothing; supprimer a block removes its links", () => {
  const b = updateEntry([block("a"), block("b"), block("sortie", "sortie")], [{ de: "a", vers: "b" }, { de: "b", vers: "sortie" }]);
  expect(deleteBlocks(b, ["sortie"])).toBe(b);
  const c = deleteBlocks(b, ["b"]);
  expect(c.blocs.map((x) => x.id)).toEqual(["a", "sortie"]);
  expect(c.liens).toEqual([]);
});

test("relier refuses itself, a duplicate and a start from an output", () => {
  const b = updateEntry([block("a"), block("b"), block("sortie", "sortie")]);
  expect(link(b, "a", "a")).toBe(b);
  expect(link(b, "sortie", "a")).toBe(b);
  const c = link(b, "a", "b");
  expect(c.liens).toEqual([{ de: "a", vers: "b" }]);
  expect(link(c, "a", "b")).toBe(c);
  expect(deleteLink(c, "a", "b").liens).toEqual([]);
});

test("renommer \"\" removes the name, 80 characters are cut to 60", () => {
  const b = updateEntry([block("a")]);
  const n = rename(b, "a", "x".repeat(80));
  expect(n.blocs[0]!.nom).toHaveLength(60);
  const r = rename(n, "a", "");
  expect("nom" in r.blocs[0]!).toBe(false);
});

test("regler replaces the params", () => {
  expect(set(updateEntry([block("a")]), "a", { k: 1 }).blocs[0]!.parametres).toEqual({ k: 1 });
});

test("deplacer: without a position change, returns the same draft", () => {
  const b = updateEntry([block("a"), block("b")]);
  expect(move(b, { a: { x: 0, y: 0 } })).toBe(b);
  expect(move(b, {})).toBe(b);
  const c = move(b, { a: { x: 5, y: 6 } });
  expect(c).not.toBe(b);
  expect(c.blocs[0]!.position).toEqual({ x: 5, y: 6 });
});

test("deplacer ignores non-finite positions", () => {
  const b = updateEntry([block("a")]);
  expect(move(b, { a: { x: NaN, y: 1 } })).toBe(b);
  expect(move(b, { a: { x: 1, y: Infinity } })).toBe(b);
});

test("versBrouillon is lenient", () => {
  expect(toDraft({ blocs: [{ id: "a", type: "code" }] })).toEqual({ version: 1, blocs: [{ id: "a", type: "code", position: { x: 0, y: 0 }, parametres: {} }], liens: [] });
  expect(toDraft({ blocs: "non" })).toBeNull();
  expect(toDraft({ blocs: [{ id: 1, type: "code" }] })).toBeNull();
  expect(toDraft(null)).toBeNull();
});

test("memeBrouillon ignores key order", () => {
  const a = updateEntry([{ ...block("a"), parametres: { x: 1, y: 2 } }]);
  const b = updateEntry([{ ...block("a"), parametres: { y: 2, x: 1 } }]);
  expect(sameDraft(a, b)).toBe(true);
});

describe("Historique", () => {
  const state = (n: number): Brouillon => updateEntry([block(`b${n}`)]);
  test("annuler then rétablir returns the states in order", () => {
    const h = new History(state(0));
    h.faire(state(1)); h.faire(state(2));
    expect(h.annuler()).toEqual(state(1));
    expect(h.annuler()).toEqual(state(0));
    expect(h.annuler()).toBeNull();
    expect(h.retablir()).toEqual(state(1));
    expect(h.retablir()).toEqual(state(2));
    expect(h.retablir()).toBeNull();
  });
  test("faire after annuler clears the redo", () => {
    const h = new History(state(0));
    h.faire(state(1)); h.annuler(); h.faire(state(5));
    expect(h.retablir()).toBeNull();
  });
  test("101 states: the oldest goes", () => {
    const h = new History(state(0));
    for (let i = 1; i <= 100; i++) h.faire(state(i));
    let last: Brouillon | null = null, n = 0;
    for (let r = h.annuler(); r; r = h.annuler()) { last = r; n++; }
    expect(n).toBe(99);
    expect(last).toEqual(state(1));
  });
  test("reinitialiser clears the history", () => {
    const h = new History(state(0));
    h.faire(state(1)); h.reinitialiser(state(9));
    expect(h.courant).toEqual(state(9));
    expect(h.annuler()).toBeNull();
  });
});

describe("suivreFichier", () => {
  const A = updateEntry([block("a")]), B = updateEntry([block("b")]), C = updateEntry([block("c")]), D = updateEntry([block("d")]);
  test("echo of our own write ignored", () => {
    expect(followFile({ local: A, dernierConnu: B, disque: B, envoyes: [] })).toBe("ignorer");
    expect(followFile({ local: A, dernierConnu: B, disque: A, envoyes: [] })).toBe("ignorer");
  });
  test("agent change adopted when nothing is pending", () => {
    expect(followFile({ local: A, dernierConnu: A, disque: B, envoyes: [] })).toBe("adopter");
  });
  test("offered when the user has an unsaved draft", () => {
    expect(followFile({ local: C, dernierConnu: A, disque: B, envoyes: [] })).toBe("proposer");
  });
  test("first load (dernierConnu null) and different disk → offer", () => {
    expect(followFile({ local: A, dernierConnu: null, disque: B, envoyes: [] })).toBe("proposer");
  });
  test("unreadable JSON → illisible", () => {
    expect(followFile({ local: A, dernierConnu: A, disque: null, envoyes: [] })).toBe("illisible");
  });
  test("disk equal to an in-flight draft while the local one moved on → ignore", () => {
    expect(followFile({ local: D, dernierConnu: A, disque: B, envoyes: [B, C] })).toBe("ignorer");
    expect(followFile({ local: D, dernierConnu: A, disque: B, envoyes: [C] })).toBe("proposer");
  });
});
