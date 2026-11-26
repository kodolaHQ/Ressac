import { expect, test } from "vitest";
import { toolTitle } from "../../core/agent/chat/engine";

test("maps tool names to French titles and kinds", () => {
  expect(toolTitle("claude", "mcp__ressac__read_tab", { title: "Réserver un train" })).toEqual({ title: "Lit la page « Réserver un train »", kind: "read" });
  expect(toolTitle("claude", "read_tab", {})).toEqual({ title: "Lit la page « la page »", kind: "read" });
  expect(toolTitle("claude", "Edit", { file_path: "/workspace/a/b.ts" })).toEqual({ title: "Modifie b.ts", kind: "edit" });
  expect(toolTitle("claude", "mcp__ressac__navigate", { url: "https://example.com/x" })).toEqual({ title: "Ouvre example.com", kind: "fetch" });
  expect(toolTitle("codex", "commandExecution", {})).toEqual({ title: "Lance une commande", kind: "execute" });
  expect(toolTitle("codex", "mcp__ressac__unknown_x", {})).toEqual({ title: "unknown_x", kind: "other" });
});
