import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Action } from "../shared/api";
import { actionsDataDir, runsOnDisk, startActionServers, tid, uiQueries, waitKernel, writeAction, writeRunnableAction } from "./actions";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, missingApi, pressKeys, waitUi } from "./ui";

// Launching actions from the empty page and the ⌘T bar. One launch for the file: each test starts on a fresh empty page
// in a public space. A proxy on a closed port keeps searches and addresses from leaving the machine; the local servers are not proxied.

const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const NAME_TICKETS = "Mes tickets GitLab à traiter";

let servers: Awaited<ReturnType<typeof startActionServers>>;
let pages: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac;
let m: Marionette;
let q: ReturnType<typeof uiQueries>;

const lines = (type: string) => `[data-testid="command-row"][data-type="${type}"]`;
const focused = (testid: string) =>
  waitUi(m, "return doc.activeElement?.dataset.testid === arguments[0] && document.activeElement === document.getElementById('ressac-sidebar');", [testid]);
/** Types `text` in the field with the keyboard (an input event, as Playwright's fill). */
const fill = (testid: string, text: string) =>
  inUi(m, `const f = doc.querySelector(arguments[0]); f.focus(); f.value = arguments[1]; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`, [tid(testid), text]);
const visible = (selector: string, ms = 30_000) => waitUi(m, "const e = doc.querySelector(arguments[0]); return !!e && e.getBoundingClientRect().height > 0;", [selector], ms);
const listCalls = () => m.execute<number>("return window.ressacListCalls;");
const tabUrls = async () => Object.values((await state(m)).tabs).map((o) => o.url);
async function setPrivate(isPrivate: boolean): Promise<void> {
  const s = await state(m);
  const e = s.spaces.find((x) => x.id === s.windows[0]!.activeSpace)!;
  if (e.private !== isPrivate) await dispatch(m, { type: "updateSpace", id: e.id, name: e.name, icon: e.icon, private: isPrivate, profile: e.profile } as Action);
}
/** A web page of the local server shown in a new tab; resolves once its title is in the state. */
async function openPage(p: string, title: string): Promise<string> {
  const url = pages.url + p;
  await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url });
  for (const deadline = Date.now() + 10_000; !Object.values((await state(m)).tabs).some((o) => o.url === url && o.title === title); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error(`${url} not loaded`);
  return url;
}
/** The action is in the list the kernel gives. */
const listed = (id: string) => waitUi(m, "return (await ui.ressac.actions.list()).some((a) => a.id === arguments[0]);", [id], 30_000);
/** Opens the empty page (« Nouvel onglet »), its field focused. */
async function emptyPage(): Promise<void> {
  await click(m, tid("new-tab"));
  await waitUi(m, "return !!doc.querySelector(arguments[0]);", [tid("empty-page")]);
  // With no tab left the empty page was already shown: a click gives its field the keyboard.
  await click(m, tid("empty-page-input"));
  await focused("empty-page-input");
}
async function openBar(): Promise<void> {
  await pressKeys(m, "Meta+t");
  await focused("command-input");
}

beforeAll(async () => {
  servers = await startActionServers();
  pages = await startServer();
  w = await launchRessac({
    env: { RESSAC_OLLAMA_URL: servers.ollama.url, RESSAC_KEV_URL: servers.kev.url, RESSAC_TEST_LOCAL_ADDRESSES: "1" },
    prefs: { "network.proxy.type": 1, "network.proxy.http": "127.0.0.1", "network.proxy.http_port": 1, "network.proxy.ssl": "127.0.0.1", "network.proxy.ssl_port": 1 },
  });
  m = w.marionette;
  q = uiQueries(m);
  await m.setContext("chrome");
  await waitReady(m);
  await waitKernel(m);
  const d = w.dataDir;
  // actions.spec.ts lancerAvecSuggestions: one action without input (keyword gitlab), one with.
  await writeRunnableAction(d, "tickets", { name: NAME_TICKETS, keywords: ["gitlab"], code: "export default async () => [{ page: { titre: 'Ticket 1' } }];" });
  await writeRunnableAction(d, "leboncoin", { name: "Leboncoin", input: "Recherche", code: "export default async () => [{ page: { titre: 'Annonce' } }];" });
  // barre-commande.spec.ts: actions without workflow.
  await writeAction(d, "sans-workflow", { name: "Zorglub" });
  await writeAction(d, "resume", { name: "Résumé vidéo", input: { label: "Vidéo" } });
  await writeAction(d, "page-action", { name: "Page action" });
  for (const id of ["tickets", "leboncoin", "sans-workflow", "resume", "page-action"]) await listed(id);
  // Counts the `actions.list` the UI asks the host for.
  await m.execute(`return (async () => {
    const agent = (await ChromeUtils.importESModule("${STORE}").ready).agent;
    const request = agent.request.bind(agent);
    window.ressacListCalls = 0;
    agent.request = (method, params) => (method === "actions.list" && window.ressacListCalls++, request(method, params));
  })();`);
}, 90_000);
beforeEach(async () => {
  servers.reset();
  if (await inUi(m, "return !!doc.querySelector(arguments[0]);", [tid("command-bar")])) await pressKeys(m, "Escape");
  await setPrivate(false);
  for (const id of Object.keys((await state(m)).tabs)) await dispatch(m, { type: "closeTab", id } as Action);
});
afterAll(async () => {
  expect(await missingApi(m)).toEqual([]);
  await w?.close();
  await servers?.close();
  await pages?.close();
});

describe("launching from the empty page", () => {
  // actions.spec.ts:847
  it("typing « git » shows the suggestion; ↓ then Enter opens the action page and launches", { timeout: 90_000 }, async () => {
    await emptyPage();
    await fill("empty-page-input", "git");
    await q.waitContains(tid("suggestions-actions"), NAME_TICKETS);
    expect(await q.text(tid("suggestions-actions"))).toContain("Rechercher");
    await pressKeys(m, "ArrowDown");
    expect(await inUi(m, "return doc.querySelector(arguments[0]).getAttribute('aria-activedescendant');", [tid("empty-page-input")])).toMatch(/.+/);
    await pressKeys(m, "Enter");
    await visible(tid("page-action"));
    for (const deadline = Date.now() + 60_000; (await runsOnDisk(w.dataDir, "tickets")).length !== 1; await new Promise((r) => setTimeout(r, 200)))
      if (Date.now() > deadline) throw new Error("the tickets action did not run");
  });

  // actions.spec.ts:866
  it("Escape closes the list; Enter searches « git » as before", async () => {
    const runs = (await runsOnDisk(w.dataDir, "tickets")).length;
    await emptyPage();
    await fill("empty-page-input", "git");
    await visible(tid("suggestions-actions"));
    await pressKeys(m, "Escape");
    await q.waitCount(tid("suggestions-actions"), 0);
    await pressKeys(m, "Enter");
    for (const deadline = Date.now() + 10_000; !(await tabUrls()).includes("https://www.google.com/search?q=git"); await new Promise((r) => setTimeout(r, 100)))
      if (Date.now() > deadline) throw new Error(`no search: ${JSON.stringify(await tabUrls())}`);
    expect(await runsOnDisk(w.dataDir, "tickets")).toHaveLength(runs);
  });

  // actions.spec.ts:882
  it("« exemple.org » with no match then Enter opens the address", async () => {
    await emptyPage();
    await fill("empty-page-input", "exemple.org");
    await new Promise((r) => setTimeout(r, 300));
    expect(await q.count(tid("suggestions-actions"))).toBe(0);
    await pressKeys(m, "Enter");
    for (const deadline = Date.now() + 10_000; !(await tabUrls()).includes("https://exemple.org/"); await new Promise((r) => setTimeout(r, 100)))
      if (Date.now() > deadline) throw new Error(`not opened: ${JSON.stringify(await tabUrls())}`);
  });

  // actions.spec.ts:895
  it("« leboncoin » then Enter: the page with its input field, nothing launched", async () => {
    await emptyPage();
    await fill("empty-page-input", "leboncoin");
    await q.waitContains(tid("suggestions-actions"), "Leboncoin");
    await pressKeys(m, "ArrowDown");
    await pressKeys(m, "Enter");
    await visible(tid("page-action"));
    await visible(tid("action-input-box"));
    await new Promise((r) => setTimeout(r, 500));
    expect(await runsOnDisk(w.dataDir, "leboncoin")).toEqual([]);
  });

  // actions.spec.ts:912
  it("command bar: « leboncoin », Enter asks for the input; « clio », Enter launches with it", { timeout: 90_000 }, async () => {
    await emptyPage();
    await openBar();
    await fill("command-input", "leboncoin");
    await q.waitCount(lines("action"), 1);
    await pressKeys(m, "ArrowDown");
    await pressKeys(m, "Enter");
    await focused("command-param");
    // On the empty page, no web page: nothing filled in.
    expect(await q.value(tid("command-param"))).toBe("");
    expect(await inUi(m, "return doc.querySelector(arguments[0]).placeholder;", [tid("command-param")])).toBe("Recherche");
    await fill("command-param", "clio");
    await pressKeys(m, "Enter");
    await visible(tid("page-action"));
    await q.waitCount(tid("command-bar"), 0);
    for (const deadline = Date.now() + 60_000; (await runsOnDisk(w.dataDir, "leboncoin")).length !== 1; await new Promise((r) => setTimeout(r, 200)))
      if (Date.now() > deadline) throw new Error("the leboncoin action did not run");
    const [file] = await runsOnDisk(w.dataDir, "leboncoin");
    expect(JSON.parse(await readFile(path.join(actionsDataDir(w.dataDir), "leboncoin", "runs", file!), "utf8")).input).toBe("clio");
  });

  // actions.spec.ts:943
  it("private space: no suggestion, the list is not even asked for (even when the actions change)", async () => {
    await setPrivate(true);
    await m.execute("window.ressacListCalls = 0;");
    await emptyPage();
    await writeRunnableAction(w.dataDir, "privee", { name: "Autre privee", code: "export default async () => [];" });
    await fill("empty-page-input", "autre");
    await new Promise((r) => setTimeout(r, 1500));
    expect(await q.count(tid("suggestions-actions"))).toBe(0);
    expect(await listCalls()).toBe(0);
  });

  // actions.spec.ts:956
  it("normal space: an actions change asks for the list again (the counter works)", async () => {
    await emptyPage();
    await m.execute("window.ressacListCalls = 0;");
    await writeRunnableAction(w.dataDir, "nouvelle", { name: "Autre nouvelle", code: "export default async () => [];" });
    await waitFor(m, "return window.ressacListCalls;", (n: number) => n > 0, 15_000);
    await fill("empty-page-input", "autre");
    await q.waitContains(tid("suggestions-actions"), "Autre nouvelle");
  });

  // actions.spec.ts:968
  it("the suggestion list is not in a window drag region", async () => {
    await emptyPage();
    await fill("empty-page-input", "git");
    await visible(tid("suggestions-actions"));
    // getComputedStyle does not expose -moz-window-dragging: the last matching rule gives it, on the list or the nearest
    // ancestor that has one.
    const dragging = await inUi<string>(
      m,
      `const of = (el) => {
        let value = "default";
        for (const sheet of doc.styleSheets) for (const r of sheet.cssRules) {
          const v = /-moz-window-dragging: ([a-z-]+)/.exec(r.cssText)?.[1];
          if (v && r.selectorText && el.matches(r.selectorText)) value = v;
        }
        return value;
      };
      for (let el = doc.querySelector(arguments[0]); el; el = el.parentElement) { const v = of(el); if (v !== "default") return v; }
      return "default";`,
      [tid("suggestions-actions")],
    );
    expect(dragging).not.toBe("drag");
  });
});

describe("launching from the command bar", () => {
  // barre-commande.spec.ts:194
  it("an action launches from the bar", async () => {
    await openBar();
    await fill("command-input", "Zorglub");
    await q.waitCount(lines("action"), 1);
    await pressKeys(m, "ArrowDown");
    await pressKeys(m, "Enter");
    await visible(tid("page-action"));
    await q.waitCount(tid("command-bar"), 0);
  });

  // barre-commande.spec.ts:210
  it("an action waiting for its input: Enter asks for it, filled with the active URL all selected; Escape and ⌫ go back to the list", async () => {
    const url = await openPage("/a.html", "Page A");
    await openBar();
    await fill("command-input", "résumé");
    await q.waitCount(lines("action"), 1);
    await q.waitContains(lines("action"), "Vidéo");
    await pressKeys(m, "ArrowDown");
    await pressKeys(m, "Enter");
    await q.waitText(tid("command-pill"), "Résumé vidéo");
    await focused("command-param");
    expect(await inUi(m, "const f = doc.querySelector(arguments[0]); return [f.value, f.selectionStart, f.selectionEnd];", [tid("command-param")])).toEqual([url, 0, url.length]);
    expect(await q.count(lines("action"))).toBe(0);
    // Escape goes back to the list, the typed text intact, the bar stays open.
    await pressKeys(m, "Escape");
    await focused("command-input");
    expect(await q.value(tid("command-input"))).toBe("résumé");
    expect(await q.count(tid("command-bar"))).toBe(1);
    // The action stays chosen. Tab switches to Demander (no input asked) and back; Enter asks for it again.
    // ⌫ clears the selection, then ⌫ on the empty field goes back.
    expect(await inUi(m, "return doc.querySelector(arguments[0]).getAttribute('aria-selected');", [lines("action")])).toBe("true");
    await pressKeys(m, "Tab");
    await q.waitText(`${tid("command-mode")} [aria-current="true"]`, "Demander");
    expect(await q.count(tid("command-param"))).toBe(0);
    await pressKeys(m, "Tab");
    await q.waitText(`${tid("command-mode")} [aria-current="true"]`, "Chercher");
    await pressKeys(m, "Enter");
    await focused("command-param");
    expect(await q.value(tid("command-param"))).toBe(url);
    // Held, ⌫ clears the field without going back; released then pressed again, it goes back, text intact.
    await m.execute(`const tip = (window.ressacTestTip ??= Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor));
      tip.beginInputTransactionForTests(window);
      tip.keydown(new KeyboardEvent("", { key: "Backspace", code: "Backspace" }));
      tip.keydown(new KeyboardEvent("", { key: "Backspace", code: "Backspace", repeat: true }));
      tip.keyup(new KeyboardEvent("", { key: "Backspace", code: "Backspace" }));`);
    expect(await q.value(tid("command-param"))).toBe("");
    await focused("command-param");
    await pressKeys(m, "Backspace");
    await focused("command-input");
    expect(await q.value(tid("command-input"))).toBe("résumé");
    expect(Object.keys((await state(m)).tabs)).toHaveLength(1);
  });

  // barre-commande.spec.ts:253
  it("an action waiting for its input, typed with it (« résumé vidéo x »): launched without asking again", async () => {
    await openBar();
    await fill("command-input", "résumé vidéo https://y.fr/v");
    await q.waitContains(lines("action"), "« https://y.fr/v »");
    await pressKeys(m, "ArrowDown");
    await pressKeys(m, "Enter");
    await visible(tid("page-action"));
    expect(await q.count(tid("command-param"))).toBe(0);
  });

  // barre-commande.spec.ts:269
  it("lines are grouped under a title per section, each with its icon", async () => {
    await openPage("/a.html", "Page A");
    await openBar();
    await fill("command-input", "Page");
    await q.waitCount(lines("tab"), 1);
    await waitUi(m, "return [...doc.querySelectorAll(arguments[0])].map((e) => e.textContent).join() === 'Actions,Onglets ouverts,Commandes';", [tid("command-section")]);
    expect(await inUi(m, "return [...doc.querySelectorAll(arguments[0])].map((l) => l.querySelectorAll('.pictogram').length);", [tid("command-row")])).toSatisfy((n: number[]) =>
      n.length > 0 && n.every((x) => x === 1),
    );
  });

  // barre-commande.spec.ts:396
  it("private space: no action offered", async () => {
    await setPrivate(true);
    await openBar();
    await fill("command-input", "Zorglub");
    await q.waitCount(lines("default"), 1);
    await new Promise((r) => setTimeout(r, 500));
    expect(await q.count(lines("action"))).toBe(0);
  });

  // barre-commande.spec.ts:601
  it("an action's input: the offered address follows the page that navigates, not once edited", async () => {
    const a = await openPage("/a.html", "Page A");
    await openBar();
    await fill("command-input", "résumé");
    await click(m, `${lines("action")} button`);
    const field = tid("command-param");
    await waitUi(m, "return doc.querySelector(arguments[0])?.value === arguments[1];", [field, a]);
    const load = (url: string) =>
      m.execute("gBrowser.selectedBrowser.loadURI(Services.io.newURI(arguments[0]), { triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({}) });", [url]);
    await load(pages.url + "/b.html");
    await waitUi(m, "return doc.querySelector(arguments[0])?.value === arguments[1];", [field, pages.url + "/b.html"]);
    await fill("command-param", "ma vidéo");
    await load(a);
    await waitFor(m, "return gBrowser.selectedBrowser.currentURI.spec;", (u) => u === a);
    await new Promise((r) => setTimeout(r, 500));
    expect(await q.value(field)).toBe("ma vidéo");
  });
});
