import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Action } from "../../navigateur/src/commun/api";
import { dispatch, inWindow, newWindow, state, waitFor, waitWindowCount } from "./firefox";
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

it("Refuser: the agent gets the refusal, and the page gets the keyboard back", async () => {
  const id = await openTab("/a.html");
  await m.execute("gBrowser.selectedBrowser.focus()");
  const reading = call("lire_onglet", { id });
  expect(await cardText()).toContain("L'agent veut lire l'onglet « Page A »");
  await answer("Refuser");
  expect((await reading).texte).toBe(REFUSED);
  await cardGone();
  await waitFor(m, "return document.activeElement === gBrowser.selectedBrowser", (v) => v === true);
});

it("the card covers the whole window, agent panel included, and gives the terminal the keyboard back", async () => {
  const id = await openTab("/a.html");
  // The panel opened on another tab: only that one is shared with the agent.
  await openTab("/b.html");
  if (!(await state(m)).fenetres[0]!.panneauAgentOuvert) await dispatch(m, { type: "basculerPanneauAgent", fenetreId: (await state(m)).fenetres[0]!.id });
  await waitFor(m, "return document.getElementById('webaios-agent').getBoundingClientRect().width", (v: number) => v > 0);
  await m.execute("document.getElementById('webaios-agent').focus()");
  expect(await m.execute("return document.activeElement?.id")).toBe("webaios-agent");
  const reading = call("lire_onglet", { id });
  await cardText();
  const sizes = await m.execute<{ frame: number; window: number; over: string }>(
    `return {
      frame: document.getElementById('webaios-sidebar').getBoundingClientRect().width,
      window: window.innerWidth,
      over: document.elementFromPoint(innerWidth - 10, innerHeight / 2)?.id,
    };`,
  );
  expect(sizes.frame).toBe(sizes.window);
  expect(sizes.over).toBe("webaios-sidebar");
  await answer("Refuser");
  await reading;
  await cardGone();
  await waitFor(m, "return document.activeElement?.id", (v) => v === "webaios-agent");
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

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
/** The handle of each open window, by its state window id. */
async function handlesById(): Promise<Record<string, string>> {
  const r: Record<string, string> = {};
  for (const h of await m.command<string[]>("WebDriver:GetWindowHandles"))
    r[await inWindow(m, h, () => m.execute<string>("return window.webaiosWindow.fenetreId"))] = h;
  return r;
}
const activeId = () => m.execute<string>(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).windows.active())()`);
const hasCard = (h: string) => inWindow(m, h, () => inUi<boolean>(m, `return !!doc.querySelector(${JSON.stringify(CARD)})`));

describe("several windows", () => {
  it("a read question shows only in the active window", async () => {
    const id = await openTab("/a.html");
    await newWindow(m);
    const handles = await handlesById();
    const active = await activeId();
    const other = Object.keys(handles).find((x) => x !== active)!;
    // Never answered: it falls when the app closes.
    call("lire_onglet", { id }).catch(() => {});
    await inWindow(m, handles[active]!, cardText);
    await new Promise((r) => setTimeout(r, 300));
    expect(await hasCard(handles[other]!)).toBe(false);
  });

  it("a new agent session in another window resets access: the agent asks again", async () => {
    const id = await openTab("/texte.html");
    // Opening the panel on the tab gives it to the agent.
    if (!(await state(m)).fenetres[0]!.panneauAgentOuvert) await dispatch(m, { type: "basculerPanneauAgent", fenetreId: (await state(m)).fenetres[0]!.id });
    await waitFor(m, "return !document.getElementById('webaios-agent').hidden", (v) => v === true);
    expect((await call("lire_onglet", { id })).texte).toContain("Le chat dort");
    const second = await newWindow(m);
    await inWindow(m, second, () => waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('prêt>')", [], 20_000, "agent"));
    const reading = call("lire_onglet", { id });
    const handles = Object.values(await handlesById());
    // One window at a time: Marionette has a single current window.
    const withCard = async () => {
      const r: string[] = [];
      for (const h of handles) if (await hasCard(h)) r.push(h);
      return r;
    };
    for (const deadline = Date.now() + 10_000; (await withCard()).length !== 1; await new Promise((r) => setTimeout(r, 100)))
      if (Date.now() > deadline) throw new Error(`expected one card, got ${(await withCard()).length}`);
    await inWindow(m, (await withCard())[0]!, () => answer("Refuser"));
    expect((await reading).texte).toBe(REFUSED);
  });

  it("closing the window that shows a question moves the card to the other window; closing the last one refuses it at once", async () => {
    await newWindow(m);
    const handles = await handlesById();
    const active = await activeId();
    const other = Object.keys(handles).find((x) => x !== active)!;
    // The tab lives in the window that stays: closing the card's window must not close it.
    const before = new Set(Object.keys((await state(m)).onglets));
    const s = await dispatch(m, { type: "ouvrirOnglet", fenetreId: other, url: `${server.url}/a.html` });
    const id = Object.keys(s.onglets).find((x) => !before.has(x))!;
    let settled = 0;
    const reading = call("lire_onglet", { id }).finally(() => (settled = Date.now()));
    await inWindow(m, handles[active]!, cardText);
    await inWindow(m, handles[active]!, () => m.execute("window.close()"));
    await waitWindowCount(m, 1);
    await m.command("WebDriver:SwitchToWindow", { handle: handles[other]!, focus: false });
    expect(await cardText()).toContain("L'agent veut lire l'onglet");
    expect(settled).toBe(0);
    const closed = Date.now();
    await m.execute("window.close()");
    expect((await reading).texte).toBe(REFUSED);
    expect(settled - closed).toBeLessThan(2000);
  });
});
