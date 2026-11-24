import { expect, test } from "vitest";
import { join } from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AccessPolicy, DEV_RIGHTS } from "../../src/access/policy.js";
import { FakeBridge } from "../../src/mcp/fake-bridge.js";
import { generateToken, startMcpServer } from "../../src/mcp/server.js";
import { STORES, TOOL_KINDS, TOOL_WRITES } from "../../src/mask/inventory.js";
import { Masker } from "../../src/mask/masker.js";
import { WorkspaceLock } from "../../src/mask/lock.js";
import { SearchSessions } from "../../src/search/sessions.js";
import { BrowsingNotes } from "../../src/search/notes.js";
import { createRecaps } from "../../src/recaps/recaps.js";
import { SeenUrls } from "../../src/mcp/seen.js";
import { Outflow } from "../../src/outflow/outflow.js";
import { tempFolder } from "../helpers/temp.js";

const STORE_LOCKED = "L'atelier est verrouillé depuis une révélation : rien ne s'écrit dans ce qui survit à la conversation tant que vous n'avez pas levé le verrou.";

test("every store a tool writes is classified, every store-write tool names its stores, and every shared store is written only by store-write tools", () => {
  for (const stores of Object.values(TOOL_WRITES)) for (const s of stores) expect(STORES[s], s).toBeDefined();
  const writers = Object.keys(TOOL_KINDS).filter((n) => TOOL_KINDS[n] === "store-write").sort();
  expect(Object.keys(TOOL_WRITES).sort()).toEqual(writers);
  for (const n of writers) expect(TOOL_WRITES[n]!.length, n).toBeGreaterThan(0);
  // The browser's own stores are never agent-written.
  for (const stores of Object.values(TOOL_WRITES)) for (const s of stores) expect(STORES[s]).not.toBe("browser");
});

test("the closed inventory of the spec's stores", () => {
  expect(STORES).toEqual({
    workspace: "space", "agent-home": "space", "container-tmp": "space", "ressac-logs": "space",
    notebook: "shared", "site-memories": "shared", "widget-data": "shared", "action-results": "shared", "workflow-runs": "shared",
    recaps: "shared", "agent-extension-storage": "shared", "design-external": "shared",
    history: "browser", "outflow-memory": "browser",
  });
});

/** Every call on a tool family is recorded: a refused store write never reaches it. */
const recording = <T extends object>(calls: string[]) => new Proxy({} as T, { get: (_, k) => async () => (calls.push(String(k)), null) });

const ARGS: Record<string, Record<string, unknown>> = {
  note_lesson: { lesson: "une leçon" },
  show_recap: { title: "Récap", results: {}, plan: { blocks: [] } },
  harvest_widget: { id: "meteo" },
  request_extension: { id: "ext" },
  reload_extension: { id: "ext" },
};

test("under the workspace lock, each store-write tool is refused before its handler, and the stores on disk stay unchanged", async () => {
  const folder = await tempFolder();
  const notesFile = join(folder, "carnet.md");
  await writeFile(notesFile, "# Carnet\n");
  const recapsFolder = join(folder, "recaps");
  const lock = new WorkspaceLock(join(folder, "masking", "lock.json"));
  await lock.lock({ names: ["votre code"] });
  const masker = new Masker({ locale: () => "fr", workspace: lock });
  const calls: string[] = [];
  const bridge = new FakeBridge([], { active: null, allow: true, devTools: true, grantDev: [...DEV_RIGHTS], history: { results: [] }, bookmarks: [], widgetData: true, search: {} });
  const notes = new BrowsingNotes(notesFile, async () => "# Carnet\n");
  notes.allow("W1", ["https://site.test/"]);
  const token = generateToken();
  const s = await startMcpServer({
    bridge, policy: new AccessPolicy(), token, masker, locale: () => "fr",
    apps: recording(calls), widgets: recording(calls), actions: recording(calls), sites: recording(calls), extensions: recording(calls),
    recaps: createRecaps({ folder: recapsFolder }), search: new SearchSessions({ show: () => {} }), notes,
    openWorkflow: () => null, outflow: new Outflow(),
  });
  masker.open("A", "W1");
  const session = s.openSession("W1", undefined, "A");
  const c = new Client({ name: "test", version: "0" });
  try {
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${session}` } } }));
    for (const name of Object.keys(TOOL_WRITES)) {
      const r = await c.callTool({ name, arguments: ARGS[name]! });
      expect((r.content as { text: string }[])[0]!.text, name).toBe(STORE_LOCKED);
    }
    expect(calls).toEqual([]);
    expect(await readFile(notesFile, "utf8")).toBe("# Carnet\n");
    expect(await readdir(recapsFolder).catch(() => [])).toEqual([]);
  } finally {
    await c.close();
    await s.stop();
  }
});

test("at their own layer too: the notebook takes no lesson and a recap does not publish while locked", async () => {
  const folder = await tempFolder();
  let locked = true;
  const notesFile = join(folder, "carnet.md");
  const notes = new BrowsingNotes(notesFile, async () => "# Carnet\n", undefined, () => locked);
  await notes.ensure();
  notes.allow("W1", ["https://site.test/"]);
  expect(await notes.add("W1", "une leçon")).toBe(false);
  expect(await readFile(notesFile, "utf8")).toBe("# Carnet\n");
  const recaps = createRecaps({ folder: join(folder, "recaps"), locked: () => locked });
  const r = await recaps.publish({ title: "Récap", results: {}, plan: { blocks: [] }, seen: new SeenUrls() });
  expect(r.ok).toBe(false);
  expect(await readdir(join(folder, "recaps")).catch(() => [])).toEqual([]);
  locked = false;
  notes.allow("W1", ["https://site.test/"]);
  expect(await notes.add("W1", "une leçon")).toBe(true);
});
