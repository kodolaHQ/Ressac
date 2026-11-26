import { expect, test } from "vitest";
import { COMMANDS, REFS, matching, menuAt, nextIndex, parseCommand, withoutToken } from "../../ui/components/chat/commands";

const ids = (l: readonly { id: string }[]) => l.map((c) => c.id);

test("menuAt: « / » at the start opens the commands, filtered as typed", () => {
  expect(menuAt("/")).toEqual({ kind: "command", query: "", start: 0 });
  expect(menuAt("/mod")).toEqual({ kind: "command", query: "mod", start: 0 });
  // Only at the very start: a « / » in a sentence or an address is text.
  expect(menuAt("voir a/b")).toBeNull();
  expect(menuAt(" /")).toBeNull();
  // A command that takes a choice shows its options after a space; one that takes text shows nothing.
  expect(menuAt("/mode ")).toEqual({ kind: "option", command: "mode", query: "", start: 0 });
  expect(menuAt("/agent co")).toEqual({ kind: "option", command: "agent", query: "co", start: 0 });
  expect(menuAt("/cherche chats")).toBeNull();
});

test("menuAt: « @ » at a word's start opens the references, then the pick of a tab, a history or a bookmark page", () => {
  expect(menuAt("@")).toEqual({ kind: "ref", query: "", start: 0 });
  expect(menuAt("résume @ong")).toEqual({ kind: "ref", query: "ong", start: 7 });
  // An e-mail address is no reference.
  expect(menuAt("écris à a@b")).toBeNull();
  expect(menuAt("lis @onglet ")).toEqual({ kind: "pick", ref: "tab", query: "", start: 4 });
  expect(menuAt("lis @tab météo lyon")).toEqual({ kind: "pick", ref: "tab", query: "météo lyon", start: 4 });
  expect(menuAt("@historique recette")).toEqual({ kind: "pick", ref: "history", query: "recette", start: 0 });
  expect(menuAt("@favori x")).toEqual({ kind: "pick", ref: "bookmark", query: "x", start: 0 });
  // @page has nothing to pick: it is the shown page.
  expect(menuAt("@page x")).toBeNull();
  expect(menuAt("@inconnu x")).toBeNull();
});

test("matching: French names and English aliases, accents optional", () => {
  expect(ids(matching(COMMANDS, "mod"))).toEqual(["model", "mode"]);
  expect(ids(matching(COMMANDS, "modèl"))).toEqual(["model"]);
  expect(ids(matching(COMMANDS, "modele"))).toEqual(["model"]);
  expect(ids(matching(COMMANDS, "MODEL"))).toEqual(["model"]);
  expect(ids(matching(COMMANDS, "n"))).toEqual(["new"]);
  expect(ids(matching(COMMANDS, ""))).toEqual(ids(COMMANDS));
  expect(ids(matching(REFS, "h"))).toEqual(["history"]);
  expect(ids(matching(REFS, "fav"))).toEqual(["bookmark"]);
});

test("parseCommand: a known command, its text and where it starts", () => {
  expect(parseCommand("/cherche chats noirs")).toEqual({ id: "search", rest: "chats noirs", restStart: 9 });
  expect(parseCommand("/search  x")).toEqual({ id: "search", rest: "x", restStart: 9 });
  expect(parseCommand("/lis")).toEqual({ id: "read", rest: "", restStart: 4 });
  expect(parseCommand("/modèle")).toEqual({ id: "model", rest: "", restStart: 7 });
  expect(parseCommand("/inconnu x")).toBeNull();
  expect(parseCommand("pas /lis")).toBeNull();
});

test("withoutToken: the typed « @… » or « /… » goes from the text, the caret where it was", () => {
  expect(withoutToken("lis @onglet mét et dis", 4, 15)).toEqual({ text: "lis et dis", caret: 4 });
  expect(withoutToken("@page", 0, 5)).toEqual({ text: "", caret: 0 });
});

test("nextIndex: ↑ and ↓ wrap, Home and End jump", () => {
  expect(nextIndex(0, 3, "ArrowDown")).toBe(1);
  expect(nextIndex(2, 3, "ArrowDown")).toBe(0);
  expect(nextIndex(0, 3, "ArrowUp")).toBe(2);
  expect(nextIndex(1, 3, "Home")).toBe(0);
  expect(nextIndex(1, 3, "End")).toBe(2);
  expect(nextIndex(1, 3, "x")).toBe(1);
  expect(nextIndex(0, 0, "ArrowDown")).toBe(0);
});
