import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { waitUi } from "./ui";

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());
beforeEach(async () => {
  w = await launchWebAiOs({ env: { WEBAIOS_MEMORY_LOOP: "1" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  // The kernel is up once its MCP config is written.
  const config = join(w.dataDir, "workspace", ".webaios", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
  // The home page's panel starts the agent's session, which takes back every access.
  await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('ready>')", [], 20_000, "agent");
});
afterEach(() => w?.close());

const titleOf = (url: string) =>
  waitFor<string>(m, `const t = gBrowser.tabs.find((t) => t.linkedBrowser.currentURI.spec === ${JSON.stringify(url)} && !t.linkedBrowser.webProgress.isLoadingDocument); return t ? t.linkedBrowser.contentTitle : ""`, (v) => v !== "");

it("a tab in the agent's profile does not see the cookies of the user's tabs", async () => {
  const windowId = (await state(m)).windows[0]!.id;
  // The server sets the cookie as the user's tab loads /cookie; /lire-cookie shows what a tab sends.
  await dispatch(m, { type: "openTab", windowId, url: `${server.url}/cookie` });
  await titleOf(`${server.url}/cookie`);
  await dispatch(m, { type: "openTab", windowId, url: `${server.url}/lire-cookie?user` });
  expect(await titleOf(`${server.url}/lire-cookie?user`)).toBe("essai=1");
  await dispatch(m, { type: "openTab", windowId, url: `${server.url}/lire-cookie?agent`, profile: "agent" });
  expect(await titleOf(`${server.url}/lire-cookie?agent`)).toBe("aucun");
});
