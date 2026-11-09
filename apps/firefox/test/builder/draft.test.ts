import { describe, expect, test } from "vitest";
import { addBlock, move, History, idForType, sameDraft, set, link, rename, followFile, deleteBlocks, deleteLink, toDraft, type Draft } from "../../ui/builder/draft";

const empty = (): Draft => ({ version: 1, blocks: [], links: [] });
const block = (id: string, type = "code") => ({ id, type, position: { x: 0, y: 0 }, params: {} });
const updateEntry = (blocks: Draft["blocks"], links: Draft["links"] = []): Draft => ({ version: 1, blocks: blocks, links });

test("adding two ai.sort gives ai-sort then ai-sort-2", () => {
  const a = addBlock(empty(), "ai.sort", { x: 1, y: 2 }, {});
  const b = addBlock(a.draft, "ai.sort", { x: 3, y: 4 }, {});
  expect([a.id, b.id]).toEqual(["ai-sort", "ai-sort-2"]);
  expect(b.draft.blocks[1]!.position).toEqual({ x: 3, y: 4 });
});

test("idForType truncates to 40", () => {
  expect(idForType("a".repeat(60), []).length).toBe(40);
  expect(idForType("a".repeat(60), ["a".repeat(40)]).length).toBeLessThanOrEqual(40);
});

test("a second output is not added", () => {
  const a = addBlock(empty(), "output", { x: 0, y: 0 }, {});
  const b = addBlock(a.draft, "output", { x: 0, y: 0 }, {});
  expect(b.id).toBe("");
  expect(b.draft).toBe(a.draft);
});

test("supprimer output does nothing; supprimer a block removes its links", () => {
  const b = updateEntry([block("a"), block("b"), block("sortie", "output")], [{ from: "a", to: "b" }, { from: "b", to: "sortie" }]);
  expect(deleteBlocks(b, ["sortie"])).toBe(b);
  const c = deleteBlocks(b, ["b"]);
  expect(c.blocks.map((x) => x.id)).toEqual(["a", "sortie"]);
  expect(c.links).toEqual([]);
});

test("relier refuses itself, a duplicate and a start from an output", () => {
  const b = updateEntry([block("a"), block("b"), block("sortie", "output")]);
  expect(link(b, "a", "a")).toBe(b);
  expect(link(b, "sortie", "a")).toBe(b);
  const c = link(b, "a", "b");
  expect(c.links).toEqual([{ from: "a", to: "b" }]);
  expect(link(c, "a", "b")).toBe(c);
  expect(deleteLink(c, "a", "b").links).toEqual([]);
});

test("renommer \"\" removes the name, 80 characters are cut to 60", () => {
  const b = updateEntry([block("a")]);
  const n = rename(b, "a", "x".repeat(80));
  expect(n.blocks[0]!.name).toHaveLength(60);
  const r = rename(n, "a", "");
  expect("name" in r.blocks[0]!).toBe(false);
});

test("regler replaces the params", () => {
  expect(set(updateEntry([block("a")]), "a", { k: 1 }).blocks[0]!.params).toEqual({ k: 1 });
});

test("deplacer: without a position change, returns the same draft", () => {
  const b = updateEntry([block("a"), block("b")]);
  expect(move(b, { a: { x: 0, y: 0 } })).toBe(b);
  expect(move(b, {})).toBe(b);
  const c = move(b, { a: { x: 5, y: 6 } });
  expect(c).not.toBe(b);
  expect(c.blocks[0]!.position).toEqual({ x: 5, y: 6 });
});

test("deplacer ignores non-finite positions", () => {
  const b = updateEntry([block("a")]);
  expect(move(b, { a: { x: NaN, y: 1 } })).toBe(b);
  expect(move(b, { a: { x: 1, y: Infinity } })).toBe(b);
});

test("toDraft is lenient", () => {
  expect(toDraft({ blocks: [{ id: "a", type: "code" }] })).toEqual({ version: 1, blocks: [{ id: "a", type: "code", position: { x: 0, y: 0 }, params: {} }], links: [] });
  expect(toDraft({ blocks: "non" })).toBeNull();
  expect(toDraft({ blocks: [{ id: 1, type: "code" }] })).toBeNull();
  expect(toDraft(null)).toBeNull();
});

test("sameDraft ignores key order", () => {
  const a = updateEntry([{ ...block("a"), params: { x: 1, y: 2 } }]);
  const b = updateEntry([{ ...block("a"), params: { y: 2, x: 1 } }]);
  expect(sameDraft(a, b)).toBe(true);
});

describe("Historique", () => {
  const state = (n: number): Draft => updateEntry([block(`b${n}`)]);
  test("annuler then rétablir returns the states in order", () => {
    const h = new History(state(0));
    h.do(state(1)); h.do(state(2));
    expect(h.cancel()).toEqual(state(1));
    expect(h.cancel()).toEqual(state(0));
    expect(h.cancel()).toBeNull();
    expect(h.restore()).toEqual(state(1));
    expect(h.restore()).toEqual(state(2));
    expect(h.restore()).toBeNull();
  });
  test("faire after annuler clears the redo", () => {
    const h = new History(state(0));
    h.do(state(1)); h.cancel(); h.do(state(5));
    expect(h.restore()).toBeNull();
  });
  test("101 states: the oldest goes", () => {
    const h = new History(state(0));
    for (let i = 1; i <= 100; i++) h.do(state(i));
    let last: Draft | null = null, n = 0;
    for (let r = h.cancel(); r; r = h.cancel()) { last = r; n++; }
    expect(n).toBe(99);
    expect(last).toEqual(state(1));
  });
  test("reinitialiser clears the history", () => {
    const h = new History(state(0));
    h.do(state(1)); h.reset(state(9));
    expect(h.current).toEqual(state(9));
    expect(h.cancel()).toBeNull();
  });
});

describe("followFile", () => {
  const A = updateEntry([block("a")]), B = updateEntry([block("b")]), C = updateEntry([block("c")]), D = updateEntry([block("d")]);
  test("echo of our own write ignored", () => {
    expect(followFile({ local: A, lastKnown: B, disk: B, sent: [] })).toBe("ignorer");
    expect(followFile({ local: A, lastKnown: B, disk: A, sent: [] })).toBe("ignorer");
  });
  test("agent change adopted when nothing is pending", () => {
    expect(followFile({ local: A, lastKnown: A, disk: B, sent: [] })).toBe("adopter");
  });
  test("offered when the user has an unsaved draft", () => {
    expect(followFile({ local: C, lastKnown: A, disk: B, sent: [] })).toBe("proposer");
  });
  test("first load (dernierConnu null) and different disk → offer", () => {
    expect(followFile({ local: A, lastKnown: null, disk: B, sent: [] })).toBe("proposer");
  });
  test("unreadable JSON → illisible", () => {
    expect(followFile({ local: A, lastKnown: A, disk: null, sent: [] })).toBe("illisible");
  });
  test("disk equal to an in-flight draft while the local one moved on → ignore", () => {
    expect(followFile({ local: D, lastKnown: A, disk: B, sent: [B, C] })).toBe("ignorer");
    expect(followFile({ local: D, lastKnown: A, disk: B, sent: [C] })).toBe("proposer");
  });
});
