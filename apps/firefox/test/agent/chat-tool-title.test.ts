import { expect, test } from "vitest";
import { openedTab, toolTitle } from "../../core/agent/chat/engine";

test("maps tool names to French titles and kinds", () => {
  expect(toolTitle("mcp__ressac__read_tab", { title: "Réserver un train" })).toEqual({ title: "Lit la page « Réserver un train »", kind: "read" });
  expect(toolTitle("read_tab", { id: "t1" }, { tabTitle: (id) => (id === "t1" ? "Billets" : undefined) })).toEqual({ title: "Lit la page « Billets »", kind: "read" });
  expect(toolTitle("read_tab", { id: "t2" }, { tabTitle: () => undefined })).toEqual({ title: "Lit une page", kind: "read" });
  expect(toolTitle("mcp__ressac__fill_field", {})).toEqual({ title: "Remplit le formulaire", kind: "edit" });
  expect(toolTitle("mcp__ressac__search_web", { query: "trains" })).toEqual({ title: "Cherche « trains »", kind: "search" });
  expect(toolTitle("Bash", { command: "ls" })).toEqual({ title: "Lance une commande", kind: "execute" });
  expect(toolTitle("mcp__ressac__list_tabs", {})).toEqual({ title: "Regarde les onglets ouverts", kind: "read" });
  expect(toolTitle("Edit", { file_path: "/workspace/a/b.ts" })).toEqual({ title: "Modifie b.ts", kind: "edit" });
  expect(toolTitle("mcp__ressac__navigate", { url: "https://example.com/x" })).toEqual({ title: "Ouvre example.com", kind: "fetch" });
  expect(toolTitle("commandExecution", {})).toEqual({ title: "Lance une commande", kind: "execute" });
  expect(toolTitle("mcp__ressac__unknown_x", {})).toEqual({ title: "unknown_x", kind: "other" });
});

test("a successful navigate names the tab of its input; open_tab the tab its result gives", () => {
  expect(toolTitle("mcp__ressac__navigate", { id: "t1", url: "https://example.com/" })).toEqual({ title: "Ouvre example.com", kind: "fetch" });
  expect(openedTab("mcp__ressac__navigate", { id: "t1", url: "https://example.com/" }, "Onglet t1 → https://example.com/")).toEqual({ tab: "t1" });
  const id = "0f8e2c1a-1b2c-4d3e-8f90-a1b2c3d4e5f6";
  expect(openedTab("mcp__ressac__open_tab", {}, ` ${id}\n`)).toEqual({ tab: id });
  expect(openedTab("open_tab", {}, [{ type: "text", text: id }])).toEqual({ tab: id });
  expect(openedTab("open_tab", {}, "URL refusée (http ou https uniquement) : x")).toEqual({});
  expect(openedTab("read_tab", { id }, id)).toEqual({});
});
