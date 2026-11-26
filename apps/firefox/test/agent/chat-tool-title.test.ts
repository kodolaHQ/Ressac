import { expect, test } from "vitest";
import { toolTitle } from "../../core/agent/chat/engine";

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
