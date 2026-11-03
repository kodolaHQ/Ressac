import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { Action } from "../../navigateur/src/commun/api";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { startServer } from "./server";
import { click, inUi, missingApi, waitUi } from "./ui";

// Electron's agent.spec.ts « Read permission » tests, and the access badge of outils-dev.spec.ts.
const REFUSED = "Accès refusé par l'utilisateur à cet onglet.";
const CARD = '[data-testid="demande-permission"]';

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());
beforeEach(async () => {
  w = await launchWebAiOs();
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  const config = join(w.dataDir, "espace", ".webaios", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the noyau did not write its MCP config");
  // The home page's panel starts the agent's session, which takes back every access: tools are called after it.
  await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('prêt>')", [], 20_000, "agent");
});
afterEach(() => w?.close());

const call = (name: string, args: Record<string, unknown> = {}) => callTool(w.dataDir, name, args);
/** Opens a user tab (not the agent's) and returns its id once its page is loaded. */
async function openTab(path: string, activer = true): Promise<string> {
  const before = new Set(Object.keys((await state(m)).onglets));
  const s = await dispatch(m, { type: "ouvrirOnglet", fenetreId: (await state(m)).fenetres[0]!.id, url: `${server.url}${path}`, activer } as Action);
  const id = Object.keys(s.onglets).find((x) => !before.has(x))!;
  if (activer)
    await waitFor(m, `return gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec.endsWith(${JSON.stringify(path)}) && !t.linkedBrowser.webProgress.isLoadingDocument)`, (v) => v === true);
  return id;
}
const cardText = () => waitUi<string>(m, `return doc.querySelector(${JSON.stringify(CARD)})?.textContent`);
const cardGone = () => waitUi(m, `return !doc.querySelector(${JSON.stringify(CARD)})`);
const answer = (button: "Refuser" | "Autoriser une fois") => click(m, `${CARD} button`, { text: button });

it("Refuser: the agent gets the refusal", async () => {
  const id = await openTab("/a.html");
  const reading = call("lire_onglet", { id });
  expect(await cardText()).toContain("L'agent veut lire l'onglet « Page A »");
  await answer("Refuser");
  expect((await reading).texte).toBe(REFUSED);
  await cardGone();
});

it("the card covers the whole window, agent panel included", async () => {
  const id = await openTab("/a.html");
  // The panel opened on another tab: only that one is shared with the agent.
  await openTab("/b.html");
  if (!(await state(m)).fenetres[0]!.panneauAgentOuvert) await dispatch(m, { type: "basculerPanneauAgent", fenetreId: (await state(m)).fenetres[0]!.id });
  await waitFor(m, "return document.getElementById('webaios-agent').getBoundingClientRect().width", (v: number) => v > 0);
  const reading = call("lire_onglet", { id });
  await cardText();
  const sizes = await m.execute<{ frame: number; window: number }>(
    "return { frame: document.getElementById('webaios-sidebar').getBoundingClientRect().width, window: window.innerWidth };",
  );
  expect(sizes.frame).toBe(sizes.window);
  await answer("Refuser");
  await reading;
  await cardGone();
});

it("Autoriser une fois: the page is read and the question does not come back for the same site", async () => {
  const id = await openTab("/texte.html");
  const reading = call("lire_onglet", { id });
  await cardText();
  await answer("Autoriser une fois");
  expect((await reading).texte).toContain("Le chat dort");
  await cardGone();
  expect((await call("lire_onglet", { id })).texte).toContain("Le chat dort");
  expect(await inUi(m, `return !!doc.querySelector(${JSON.stringify(CARD)})`)).toBe(false);
});

it("a tab never shown is loaded for reading", async () => {
  const id = await openTab("/texte.html", false);
  expect((await state(m)).onglets[id]).toBeTruthy();
  const reading = call("lire_onglet", { id });
  await cardText();
  await answer("Autoriser une fois");
  expect((await reading).texte).toContain("Le chat dort");
});

it("a tab closed during the question: refused, card gone", async () => {
  const id = await openTab("/a.html");
  const reading = call("lire_onglet", { id });
  await cardText();
  await dispatch(m, { type: "fermerOnglet", id });
  expect((await reading).texte).toBe(REFUSED);
  await cardGone();
});

it("a tab moved to a private space during the question: refused, card gone", async () => {
  const id = await openTab("/texte.html");
  const reading = call("lire_onglet", { id });
  await cardText();
  const s = await state(m);
  const e = s.espaces.find((x) => x.id === s.fenetres[0]!.espaceActif)!;
  await dispatch(m, { type: "reglerEspace", id: e.id, nom: e.nom, icone: e.icone, prive: true, profil: e.profil } as Action);
  const r = await reading;
  expect(r.texte).not.toContain("Le chat dort");
  expect(r.texte).toBe(REFUSED);
  await cardGone();
});

it("the access badge shows on a tab the agent reads and Couper removes it", async () => {
  const id = await openTab("/texte.html");
  const badge = `[data-testid="onglet-${id}"] [data-testid="pastille-acces"]`;
  expect(await inUi(m, `return !!doc.querySelector(arguments[0])`, [badge])).toBe(false);
  const reading = call("lire_onglet", { id });
  await cardText();
  await answer("Autoriser une fois");
  await reading;
  await waitUi(m, `return !!doc.querySelector(arguments[0])`, [badge]);
  await click(m, badge);
  await click(m, '[data-testid="bulle-acces"] button', { text: "Couper l'accès" });
  await waitUi(m, `return !doc.querySelector(arguments[0]) && !doc.querySelector('[data-testid="bulle-acces"]')`, [badge]);
  // Cut: reading asks again.
  const again = call("lire_onglet", { id });
  await cardText();
  await answer("Refuser");
  expect((await again).texte).toBe(REFUSED);
  expect(await missingApi(m)).toEqual([]);
});
