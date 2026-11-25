import { expect, test } from "vitest";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AccessPolicy, DEV_RIGHTS } from "../../src/access/policy.js";
import { FakeBridge } from "../../src/mcp/fake-bridge.js";
import { generateToken, startMcpServer } from "../../src/mcp/server.js";
import { TOOL_KINDS } from "../../src/mask/inventory.js";
import { SearchSessions } from "../../src/search/sessions.js";
import { BrowsingNotes } from "../../src/search/notes.js";
import { createRecaps } from "../../src/recaps/recaps.js";
import { Outflow } from "../../src/outflow/outflow.js";
import { tempFolder } from "../helpers/temp.js";

/** Tools classified ahead of the task that registers them. */
const NOT_YET_REGISTERED: string[] = [];

const none = <T extends object>() => new Proxy({} as T, { get: () => async () => null });

test("every tool of a server with every option is classified, and every classified tool is registered", async () => {
  const folder = await tempFolder();
  const notesFile = join(folder, "carnet.md");
  await writeFile(notesFile, "# Carnet\n");
  const bridge = new FakeBridge([], { active: null, allow: true, devTools: true, grantDev: [...DEV_RIGHTS], history: { results: [] }, bookmarks: [], widgetData: true, search: {} });
  const token = generateToken();
  const s = await startMcpServer({
    lab: () => true,
    bridge, policy: new AccessPolicy(), token,
    apps: none(), widgets: none(), actions: none(), sites: none(),
    recaps: createRecaps({ folder }), search: new SearchSessions({ show: () => {} }), notes: new BrowsingNotes(notesFile, async () => "# Carnet\n"),
    openWorkflow: () => null, outflow: new Outflow(),
  });
  const c = new Client({ name: "test", version: "0" });
  try {
    // An Atelier session: the notebook (`note_lesson`) is registered for it only.
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${s.openSession("W1", undefined, undefined, "workshop")}` } } }));
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names.filter((n) => !(n in TOOL_KINDS))).toEqual([]);
    expect(Object.keys(TOOL_KINDS).filter((n) => !names.includes(n) && !NOT_YET_REGISTERED.includes(n))).toEqual([]);
  } finally {
    await c.close();
    await s.stop();
  }
});

test("the outflows the spec lists, run_js among them, are outflows; the shared stores' writers are store writes", () => {
  for (const n of ["navigate", "open_tab", "read_pages", "fill_field"]) expect(TOOL_KINDS[n]).toBe("outflow");
  for (const n of ["search_web", "open_site", "launch_app", "launch_action", "open_workflow", "hand_over", "run_js", "reload"]) expect(TOOL_KINDS[n]).toBe("outflow-no-destination");
  for (const n of ["note_lesson", "show_recap", "harvest_widget"]) expect(TOOL_KINDS[n]).toBe("store-write");
  expect(TOOL_KINDS.read_tab).toBe("read");
  expect(TOOL_KINDS.reveal_value).toBe("read");
});
