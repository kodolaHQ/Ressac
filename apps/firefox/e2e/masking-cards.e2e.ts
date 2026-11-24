import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { callMcpTool } from "../test/mcp";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, pressKeys, startAgentSession, typeText, waitUi } from "./ui";

// The masking cards (spec § 8) and the panel's banners: a card names the value (« votre téléphone »), never carries it;
// « Voir » shows it from the host on click; Touch ID runs after « Montrer » (RESSAC_TEST_REAUTH stands in for it).
const PHONE = "06 12 34 56 78";
const DIGITS = "0612345678";
const REVEAL_DENIED = "L'utilisateur a refusé : la valeur reste masquée.";
const REVEALED = "Valeur révélée pour cette conversation";
const LABEL_REFUSED = "L'utilisateur a refusé d'envoyer cette étiquette.";
const CARD = '[data-testid="mask-request"]';
const ACCESS = '[data-testid="permission-request"] button, [data-testid="devtools-request"] button';

const html = (res: ServerResponse, body: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
// `/compte/` makes the page sensitive: a masking source once the user reached it (e2e/masking-visits.e2e.ts).
const routes = {
  "/compte/releve.html": (_req: unknown, res: ServerResponse) => html(res, `<title>Relevé</title><p>Tél : ${PHONE}</p><script>console.log("relevé prêt")</script>`),
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

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out: last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Launches with the Touch ID seam, the user's sensitive tab open, then the agent's session started on it. */
async function start(reauth: "pass" | "fail"): Promise<string> {
  w = await launchRessac({ env: { RESSAC_TEST_REAUTH: reauth, RESSAC_TEST_PUBLIC_ADDRESSES: "127.0.0.1", RESSAC_TEST_SEARCH_URL: `${server.url}/compte/releve.html?q=%s` } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  const url = `${server.url}/compte/releve.html`;
  const before = new Set(Object.keys((await state(m)).tabs));
  const s = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url, agentReached: false });
  await waitFor(m, `return gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec === ${JSON.stringify(url)} && !t.linkedBrowser.webProgress.isLoadingDocument)`, (v) => v === true, 15_000);
  const id = Object.keys(s.tabs).find((x) => !before.has(x))!;
  await startAgentSession(m);
  return id;
}

/** The window's session config (`.ressac/sessions/<id>.json`): its token resolves this conversation's labels. */
const sessionConfig = () => {
  const folder = join(w!.dataDir, "workspace", ".ressac", "sessions");
  const name = existsSync(folder) ? readdirSync(folder).find((f) => f.endsWith(".json")) : undefined;
  if (!name) throw new Error("no session config");
  return join(folder, name);
};
/** A tool call as the window's agent makes it, every access card it puts up allowed, until it answers. */
async function call(name: string, args: Record<string, unknown>, allow = false): Promise<{ text: string; error: boolean }> {
  let done = false;
  const reply = callMcpTool(join(w!.dataDir, "workspace"), name, args, sessionConfig()).finally(() => (done = true));
  while (allow && !done) {
    const label = await inUi<string | null>(m, `const b = [...doc.querySelectorAll(arguments[0])].find((x) => /^Autoriser/.test(x.textContent.trim())); return b ? b.textContent.trim() : null;`, [ACCESS]);
    // The card may fall between the look and the press (the call answered): looked at again on the next turn.
    if (label) await click(m, ACCESS, { text: label }).catch(() => {});
    else await new Promise((r) => setTimeout(r, 100));
  }
  return reply;
}
/** The phone's label in a read of the user's tab. */
async function phoneLabel(id: string): Promise<string> {
  const text = (await call("read_tab", { id }, true)).text;
  expect(text).not.toContain(PHONE);
  return text.match(/⟨tel-[a-z0-9]{8}⟩/)![0];
}
const cardText = () => waitUi<string>(m, `const c = doc.querySelector(arguments[0]); return c && c.dataset.kind && c.textContent;`, [CARD], 15_000);
const cardGone = () => waitUi(m, "return !doc.querySelector(arguments[0])", [CARD]);
const press = (text: string) => click(m, `${CARD} button`, { text });
/** No run of the value's digits, spaced or not. */
const noValue = (s: string) => expect(s.replace(/\D/g, "")).not.toContain(DIGITS);

it("the reveal card names the value and never shows it; « Voir » shows it here only; Refuser answers no", async () => {
  const id = await start("pass");
  const label = await phoneLabel(id);
  const reveal = call("reveal_value", { label, reason: "le donner au livreur" });
  const text = await cardText();
  expect(text).toContain("votre téléphone");
  noValue(text);
  await click(m, '[data-testid="mask-request-see"]');
  const shown = await waitUi<string>(m, "return doc.querySelector('[data-testid=\"mask-request-value\"]')?.textContent", [], 10_000);
  expect(shown.replace(/\D/g, "")).toBe(DIGITS);
  // Hidden again, the value leaves the card (after its fade).
  await click(m, '[data-testid="mask-request-see"]');
  await waitUi(m, "return !doc.querySelector('[data-testid=\"mask-request-value\"]')", [], 10_000);
  await press("Refuser");
  expect((await reveal).text).toBe(REVEAL_DENIED);
  await cardGone();
});

it("Montrer then Touch ID: the value goes back, the lock banner names it and survives a panel reopen", async () => {
  const id = await start("pass");
  const label = await phoneLabel(id);
  const reveal = call("reveal_value", { label, reason: "le donner au livreur" });
  await cardText();
  await press("Montrer");
  const r = await reveal;
  expect(r.text).toContain(REVEALED);
  expect(r.text.replace(/\D/g, "")).toContain(DIGITS);
  const banner = () => waitUi<string>(m, "return doc.querySelector('[data-testid=\"agent-mask-locked\"]')?.textContent", [], 15_000, "agent");
  expect(await banner()).toContain("Conversation verrouillée : votre téléphone a été révélé");
  // Shown, closed and opened again (the session started with it closed): the banner is read from the lock, not kept by the panel.
  const toggle = async (hidden: boolean) => {
    await click(m, '[data-testid="agent-button"]');
    await waitFor(m, "return document.getElementById('ressac-agent').hidden", (v) => v === hidden);
  };
  if (await m.execute("return document.getElementById('ressac-agent').hidden")) await toggle(false);
  await toggle(true);
  await toggle(false);
  expect(await banner()).toContain("votre téléphone");
});

it("a failed Touch ID after Montrer is a refusal: the value stays masked, no lock", async () => {
  const id = await start("fail");
  const label = await phoneLabel(id);
  const reveal = call("reveal_value", { label, reason: "le donner au livreur" });
  await cardText();
  await press("Montrer");
  const r = await reveal;
  expect(r.text).toBe(REVEAL_DENIED);
  noValue(r.text);
  expect(existsSync(join(w!.dataDir, "masking", "lock.json"))).toBe(false);
});

it("the label alert: the label never the value, Refuser answers no", async () => {
  const id = await start("pass");
  const label = await phoneLabel(id);
  const search = call("search_web", { query: `livraison ${label}`, goal: "suivre la livraison" });
  const text = await cardText();
  expect(text).toContain("L'agent envoie l'étiquette de votre téléphone (sans la valeur) vers votre moteur de recherche");
  noValue(text);
  await press("Refuser");
  expect((await search).text).toBe(LABEL_REFUSED);
  await cardGone();
});

it("the dev tools of a tab that shows the user's data: the unlock card, Refuser keeps them locked", async () => {
  const id = await start("pass");
  await phoneLabel(id);
  const reading = call("read_console", { id }, true);
  const text = await cardText();
  expect(text).toContain("Les outils de développement verraient vos données en clair.");
  noValue(text);
  await press("Refuser");
  expect((await reading).text).toBe("Accès refusé par l'utilisateur à cet outil sur cet onglet.");
});

it("« non couverte »: a resume of a conversation that is in covered.json is covered, one that is not shows the banner", async () => {
  await start("pass");
  const args = () => JSON.parse(readFileSync(join(w!.dataDir, "workspace", "fake-agent-args.json"), "utf8")) as string[];
  const started = args();
  const conversation = started[started.indexOf("--session-id") + 1]!;
  const covered = join(w!.dataDir, "masking", "covered.json");
  const input = () => join(w!.dataDir, "workspace", "fake-agent-input.txt");
  await until(() => (existsSync(covered) ? readFileSync(covered, "utf8") : ""), (t) => t.includes(conversation));
  // Claude resumes only a conversation that got a message, by its id.
  await click(m, '[data-testid="agent-button"]');
  await click(m, ".xterm-screen", { frame: "agent" });
  await typeText(m, "bonjour");
  await pressKeys(m, "Enter");
  // The panel opened on the user's tab: the line starts with its pre-filled context, then the message.
  await until(() => (existsSync(input()) ? readFileSync(input(), "utf8") : ""), (t) => t.includes("bonjour\r"), 20_000);
  const relaunch = async () => {
    const pid = readFileSync(join(w!.dataDir, "workspace", "fake-agent-pid"), "utf8");
    await inUi(m, "await ui.ressac.agent.relaunch()", [], "agent");
    await until(() => readFileSync(join(w!.dataDir, "workspace", "fake-agent-pid"), "utf8"), (p) => p !== pid, 20_000);
    expect(args().join(" ")).toContain(`--resume ${conversation}`);
    await waitUi(m, "return (doc.querySelector('.xterm-rows')?.textContent ?? '').includes('ready>')", [], 20_000, "agent");
  };
  await relaunch();
  // Covered: the status is read when the session's state turns active; the window starts after that read is sent.
  await inUi(m, "await ui.ressac.agent.masking(); await new Promise((ok) => ui.setTimeout(ok, 500));", [], "agent");
  expect(await inUi<boolean>(m, "return !!doc.querySelector('[data-testid=\"agent-mask-uncovered\"]')", [], "agent")).toBe(false);

  writeFileSync(covered, "[]");
  await relaunch();
  expect(await waitUi<string>(m, "return doc.querySelector('[data-testid=\"agent-mask-uncovered\"]')?.textContent", [], 15_000, "agent")).toContain(
    "Conversation non couverte : commencée avant le masquage, elle a pu voir vos données en clair.",
  );
});
