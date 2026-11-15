import { join } from "node:path";
import { callMcpTool } from "../test/mcp";
import type { Marionette } from "./marionette";
import { click, waitUi } from "./ui";

/** Calls a tool of the kernel's MCP server of a launched Ressac (config at `<dataDir>/workspace/.ressac/mcp.json`). */
export const callTool = (dataDir: string, name: string, args: Record<string, unknown> = {}) => callMcpTool(join(dataDir, "workspace"), name, args);

const HISTORY_CARD = '[data-testid="widget-data-request"]';
/** The history card, put up by a first history read and answered with `button` (once per conversation); resolves with that read. */
export async function answerHistory(m: Marionette, dataDir: string, button: "Refuser" | "Autoriser pour cette conversation" = "Autoriser pour cette conversation") {
  const first = callTool(dataDir, "search_history", { query: "x" });
  await waitUi(m, `return !!doc.querySelector(${JSON.stringify(`${HISTORY_CARD} [data-testid="history-request"]`)})`, [], 15_000);
  await click(m, `${HISTORY_CARD} button`, { text: button });
  return first;
}
