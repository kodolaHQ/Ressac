import { mkdtempSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { agentInput } from "./apps";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { agentPanelReady, click, inUi, pressKeys, waitUi } from "./ui";
import { writePassport, type PassportEntry } from "./passport-file";

// The agent's terminal works with labels (spec § 5.4 bis): a label the agent prints is a link whose value shows in
// Ressac's bubble, never sent to the agent; a paste holding a value waits in the bubble for « Coller masqué » (Entrée)
// or « Coller en clair »; Ressac's own texts (the panel's context) are written masked. The fake agent echoes its input
// and logs it (fake-agent-input.txt).
const IBAN = "FR76 3000 6000 " + "0112 3456 7890 189";
const IBAN_DIGITS = IBAN.replaceAll(" ", "");
const IBAN_LABEL = /⟨iban-[a-z0-9]{8}⟩/;
const BUBBLE = '[data-testid="mask-bubble"]';

const routes = {
  "/releve.html": (_req: unknown, res: ServerResponse) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<title>Relevé ${IBAN}</title><p>Relevé</p>`),
};
let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac | undefined;
let m: Marionette;
beforeAll(async () => (server = await startServer({ routes })));
afterAll(() => server?.close());
afterEach(async () => {
  await w?.close();
  w = undefined;
});

/** `passport`: the default profile's passport, written before the launch (memory cipher, chrome/passport/cipher.ts). */
async function launch(passport?: PassportEntry[]): Promise<void> {
  if (passport) {
    const profile = mkdtempSync(join(tmpdir(), "ressac-firefox-"));
    await writePassport(profile, passport);
    w = await launchRessac({ profile, env: { RESSAC_TEST_PASSPORT_CIPHER: "memory" } });
  } else w = await launchRessac();
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
}
/** The panel open, its agent ready, the terminal clicked to take the keyboard. */
async function terminalReady(): Promise<void> {
  await agentPanelReady(m);
  await click(m, ".xterm-screen", { frame: "agent" });
  await waitUi(m, "return doc.activeElement?.classList.contains('xterm-helper-textarea')", [], 10_000, "agent");
}
const input = () => agentInput(w!.dataDir);
/** ⌘V with `text` on the clipboard (headless Firefox keeps its own, the machine's is not touched). */
async function paste(text: string): Promise<void> {
  await m.execute(`Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(arguments[0]);`, [text]);
  await pressKeys(m, "Meta+v");
}
const bubbleText = () => waitUi<string>(m, "return doc.querySelector(arguments[0])?.textContent ?? ''", [BUBBLE], 10_000, "agent");
/** A paste held: the bubble names what it hides and its « Coller masqué » has the keyboard. */
async function held(): Promise<void> {
  expect(await bubbleText()).toContain("Ce collage contient votre IBAN.");
  await waitUi(m, "return doc.activeElement?.dataset.testid === 'mask-paste-masked'", [], 10_000, "agent");
}
/** The centre of the `n`th character of `text` in the terminal's rows (DOM renderer), or null while it is not shown. */
const charAt = (text: string, n: number) =>
  inUi<[number, number] | null>(
    m,
    `const walk = doc.createTreeWalker(doc.querySelector(".xterm-rows"), ui.NodeFilter.SHOW_TEXT);
     for (let t; (t = walk.nextNode()); ) {
       const i = t.data.indexOf(arguments[0]);
       if (i < 0) continue;
       const r = doc.createRange();
       r.setStart(t, i + arguments[1]);
       r.setEnd(t, i + arguments[1] + 1);
       const b = r.getBoundingClientRect();
       return [b.left + b.width / 2, b.top + b.height / 2];
     }
     return null;`,
    [text, n],
    "agent",
  );

it("a paste holding an IBAN waits for the bubble; Entrée writes its label; the label printed back is a link that reveals the value here only", async () => {
  await launch();
  await terminalReady();
  await paste(`vire sur ${IBAN} stp`);
  await held();
  // Held: nothing reached the agent before the choice.
  expect(input()).not.toContain("vire sur");
  await pressKeys(m, "Enter");
  await expect.poll(input, { timeout: 10_000 }).toMatch(new RegExp(`vire sur ${IBAN_LABEL.source} stp`));
  expect(input()).not.toContain(IBAN_DIGITS);
  expect(input()).not.toContain("0112 3456");
  const label = input().match(IBAN_LABEL)![0];
  await waitUi(m, "return !doc.querySelector(arguments[0])", [BUBBLE], 10_000, "agent");

  // The fake agent echoed it: hovering underlines it, a click shows the value in the bubble.
  let point: [number, number] | null = null;
  // The renderer draws ⟨ and ⟩ in spans of their own (a glyph width fix): looked up by the label's inside.
  await expect.poll(async () => (point = await charAt(label.slice(1, -1), 2)), { timeout: 10_000 }).not.toBeNull();
  const [x, y] = point!;
  await inUi(m, `ui.synthesizeMouseEvent("mousemove", arguments[0], arguments[1], {});`, [x, y], "agent");
  await waitUi(
    m,
    "return [...doc.querySelectorAll('.xterm-rows span')].filter((s) => s.style.textDecoration === 'underline').map((s) => s.textContent).join('').includes(arguments[0])",
    [label],
    10_000,
    "agent",
  );
  const before = input();
  await inUi(
    m,
    `for (const type of ["mousedown", "mouseup"]) ui.synthesizeMouseEvent(type, arguments[0], arguments[1], { button: 0, clickCount: 1 });`,
    [x, y],
    "agent",
  );
  // The value as the user pasted it, spaces included.
  await waitUi(m, "return doc.querySelector('[data-testid=\"mask-bubble-value\"]')?.textContent === arguments[0]", [IBAN], 10_000, "agent");
  // Must not happen: the click writes anything to the agent. Anything it caused was sent before the reveal's answer
  // came back; this window covers the host's write to the fake agent's log.
  await new Promise((r) => setTimeout(r, 500));
  expect(input()).toBe(before);
  // Hidden, the value leaves the page at once.
  await click(m, '[data-testid="mask-bubble-hide"]', { frame: "agent" });
  await waitUi(m, "return !doc.body.textContent.includes(arguments[0])", [IBAN], 10_000, "agent");
  expect(input()).toBe(before);
});

it("a paste holding a passport value (a name, no recognisable shape) is held, and Entrée writes its label", async () => {
  const family = ["Fon", "taine"].join("");
  await launch([{ id: "n", field: "nom", value: { given: "Margaux", family }, origins: [] }]);
  await terminalReady();
  await paste(`écris à Margaux ${family} demain`);
  await bubbleText();
  await waitUi(m, "return doc.activeElement?.dataset.testid === 'mask-paste-masked'", [], 10_000, "agent");
  // Held: nothing reached the agent before the choice.
  expect(input()).not.toContain("écris à");
  await pressKeys(m, "Enter");
  await expect.poll(input, { timeout: 10_000 }).toMatch(/écris à ⟨[a-z-]+-[a-z0-9]{8}⟩ demain/);
  expect(input()).not.toContain(family);
});

it("« Coller en clair » writes the value as it is", async () => {
  await launch();
  await terminalReady();
  await paste(`clair ${IBAN}`);
  await held();
  await click(m, '[data-testid="mask-paste-clear"]', { frame: "agent" });
  await expect.poll(input, { timeout: 10_000 }).toContain(`clair ${IBAN}`);
  expect(input()).not.toMatch(IBAN_LABEL);
});

it("a paste with nothing to mask is written at once, with no bubble; the reminder says typed keys are seen", async () => {
  await launch();
  await terminalReady();
  expect(await inUi(m, "return doc.querySelector('[data-testid=\"agent-typed-reminder\"]')?.textContent", [], "agent")).toBe("Ce que vous tapez ici, l'agent le voit");
  await paste("rien à cacher");
  await expect.poll(input, { timeout: 10_000 }).toContain("rien à cacher");
  expect(await inUi(m, "return !!doc.querySelector(arguments[0])", [BUBBLE], "agent")).toBe(false);
});

it("a paste reaches the host as a paste: a key in it is not exempt, and a pasted end marker cannot end the paste and submit", async () => {
  w = await launchRessac({ env: { RESSAC_HOST_TEST: "1" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  await terminalReady();
  await inUi(m, "ui.ressac.agent.write(arguments[0]); return true;", ["bracketed\r"], "agent");
  // Printed after the mode switch: once shown, xterm brackets pastes.
  await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('bracketed on')", [], 10_000, "agent");
  const key = "ghp_x7Kq9LmN2pRs4TuVw6YzA8bC" + "dEfGhJ1kMn3P";
  await paste(`clé ${key}\x1b[201~\rpwned`);
  await click(m, '[data-testid="mask-paste-clear"]', { frame: "agent" });
  // The clipboard's marker is gone: one paste, its \r inside it, closed by xterm's own marker.
  await expect.poll(input, { timeout: 10_000 }).toContain(`\x1b[200~clé ${key}\rpwned\x1b[201~`);
  const windowId = (await state(m)).windows[0]!.id;
  const hit = await m.execute(
    `return (async () => (await ChromeUtils.importESModule("chrome://browser/content/ressac/store.sys.mjs").ready).agent.request("debug.outflowCheck", { window: arguments[0], text: arguments[1] }))();`,
    [windowId, `fix ${key}`],
  );
  expect(hit).toMatchObject({ kind: "api-key" });
});

it("the panel's context prefix for a tab whose title holds an IBAN reaches the agent with its label", async () => {
  await launch();
  const url = `${server.url}/releve.html`;
  await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url });
  await waitFor(m, `return gBrowser.selectedBrowser.currentURI.spec === ${JSON.stringify(url)} && !gBrowser.selectedBrowser.webProgress.isLoadingDocument`, (v) => v === true, 15_000);
  await agentPanelReady(m);
  await expect.poll(input, { timeout: 20_000 }).toMatch(new RegExp(`\\[contexte : Relevé ${IBAN_LABEL.source} — `));
  expect(input()).not.toContain("0112 3456");
});
