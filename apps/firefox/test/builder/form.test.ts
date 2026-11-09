import { blockCatalog } from "@webaios/kernel";
import { expect, test } from "vitest";
import { shownFields, entryOf, paramsWith, textOf } from "../../ui/builder/form";

const catalog = (type: string) => blockCatalog().find((c) => c.type === type)!;
const field = (type: string, name: string) => catalog(type).fields.find((c) => c.name === name)!;
const names = (type: string, params: Record<string, unknown>) => shownFields(catalog(type), params).map((c) => c.name);

test("the « only per item » fields only appear if parElement is ticked", () => {
  expect(names("ai.write", {})).not.toContain("onError");
  expect(names("ai.write", { perItem: false })).not.toContain("reuse");
  expect(names("ai.write", { perItem: true })).toEqual(expect.arrayContaining(["onError", "budgetSeconds", "reuse"]));
  expect(names("ai.write", {})).toContain("perItem");
});

test("ia.trier (always item by item) shows siErreur, budget, reutiliser and a field without the parElement box", () => {
  expect(names("ai.sort", {})).toEqual(expect.arrayContaining(["threshold", "field", "onError", "budgetSeconds", "reuse"]));
  expect(names("ai.sort", {})).not.toContain("perItem");
});

test("a cleared non-required text field removes its key; required, it stays empty", () => {
  expect(paramsWith({ field: "p", threshold: 0.5 }, field("ai.sort", "field"), "")).toEqual({ threshold: 0.5 });
  expect(paramsWith({ question: "q" }, field("ai.sort", "question"), "")).toEqual({ question: "" });
  expect(paramsWith({}, field("ai.sort", "question"), "{config.x} ?")).toEqual({ question: "{config.x} ?" });
});

test("number: converted, cleared removes the key, unreadable changes nothing", () => {
  expect(paramsWith({ threshold: 0.5 }, field("ai.sort", "threshold"), "0.7")).toEqual({ threshold: 0.7 });
  expect(paramsWith({ threshold: 0.5 }, field("ai.sort", "threshold"), " ")).toEqual({});
  expect(paramsWith({ threshold: 0.5 }, field("ai.sort", "threshold"), "abc")).toBeNull();
});

test("texts: one line per value, empty lines ignored", () => {
  const keys = field("list.dedupe", "keys");
  expect(paramsWith({}, keys, "url\n\n titre \n")).toEqual({ keys: ["url", "titre"] });
  expect(textOf(keys, ["url", "titre"])).toBe("url\ntitre");
  expect(paramsWith({ keys: ["url"] }, keys, "")).toEqual({ keys: [] });
});

test("checkbox and choice: values as is; displayed value by default the catalog's", () => {
  expect(paramsWith({}, field("ai.write", "perItem"), true)).toEqual({ perItem: true });
  expect(paramsWith({ call: "input" }, field("code", "call"), "harvest")).toEqual({ call: "harvest" });
  expect(entryOf(field("ai.sort", "threshold"), {})).toBe(0.5);
  expect(entryOf(field("ai.sort", "threshold"), { threshold: 0.9 })).toBe(0.9);
  expect(textOf(field("ai.sort", "threshold"), 0.9)).toBe("0.9");
  expect(textOf(field("ai.sort", "question"), undefined)).toBe("");
});

test("a cleared required number changes nothing", () => {
  expect(paramsWith({ count: 10 }, field("list.keep", "count"), "")).toBeNull();
});

test("checkbox without a default value (auFilDeLEau): unticked, the key goes; ticked, true", () => {
  const f = field("output", "live");
  expect(paramsWith({ to: "widget" }, f, true)).toEqual({ to: "widget", live: true });
  expect(paramsWith({ to: "widget", live: true }, f, false)).toEqual({ to: "widget" });
  expect(entryOf(f, {})).toBeUndefined();
  // A checkbox with a default value keeps the unticked value as is.
  expect(paramsWith({ perItem: true }, field("ai.write", "perItem"), false)).toEqual({ perItem: false });
});
