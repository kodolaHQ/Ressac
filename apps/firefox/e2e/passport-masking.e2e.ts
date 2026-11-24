import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { callMcpTool } from "../test/mcp";
import { readPassport, writePassport, type PassportEntry } from "./passport-file";
import { startServer } from "./server";
import { agentPanelReady, click, inUi, waitUi } from "./ui";

// Design § 10.2: the passports the chrome loads at the host start mask the user's sources (design § 5.2, § 6.1); the
// fill cards offer them (§ 8.3-8.5). The « non couverte » scenario needs the editor's save (Task 8, ruling F5).
const NAME = "AUBRAC Camille, signé C. Aubrac, pour Mme Aubrac.";
const ADDRESS = "Livré au 14, r. des Tanneurs, 69005 Lyon.";
const RELATIVE = "Contact : Julien Aubrac.";
const CARDS = '[data-testid="permission-request"] button, [data-testid="address-request"] button';

const html = (res: ServerResponse, body: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
const page = (title: string) => (_req: unknown, res: ServerResponse) => html(res, `<title>${title}</title><p>${NAME}</p><p>${ADDRESS}</p><p>${RELATIVE}</p>`);
// `/compte/` makes the page sensitive (packages/kernel/src/access/sensitive.ts): a source when the user reached it.
// A colleague's name, in another profile's passport (written by the test): a source page for the default profile's tab.
const COLLEAGUE = ["Fer", "rand"].join("");
const colleague = (_req: unknown, res: ServerResponse) => html(res, `<title>Équipe</title><p>Responsable : Lucie ${COLLEAGUE}</p>`);
const routes = { "/compte/fiche.html": page("Fiche"), "/profil.html": page("Profil"), "/compte/equipe.html": colleague };

let server: Awaited<ReturnType<typeof startServer>>;
// The passport's « Remplissable sur » origin: an ordinary path, a source only through the passport.
let shop: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac | undefined;
let m: Marionette;
let dataDir: string | undefined;
let profile: string | undefined;
beforeAll(async () => {
  server = await startServer({ routes });
  shop = await startServer({ routes });
});
afterAll(() => Promise.all([server?.close(), shop?.close()]));
afterEach(async () => {
  await w?.close();
  w = undefined;
  for (const d of [dataDir, profile]) if (d) await rm(d, { recursive: true, force: true });
  dataDir = profile = undefined;
});

const entries = (): PassportEntry[] => [
  { id: "0000000000000001", field: "nom", value: { given: "Camille", family: "Aubrac" }, origins: [new URL(shop.url).host] },
  { id: "0000000000000002", field: "proche", value: { given: "Julien", family: "Aubrac" }, origins: [] },
  { id: "0000000000000003", field: "adresse", value: { text: "14 rue des Tanneurs\n69005 Lyon" }, origins: [] },
];

/**
 * Launches with the default profile's passport on disk (plus `extra`; and `others`, profile → entries) and the given cipher seam, the
 * kernel up and the agent's session open. Touch ID passes (RESSAC_TEST_REAUTH).
 */
async function start(cipher: "memory" | "absent" = "memory", others: Record<string, PassportEntry[]> = {}, extra: PassportEntry[] = [], relaunch = false): Promise<void> {
  dataDir ??= await mkdtemp(join(os.tmpdir(), "ressac-data-"));
  profile ??= await mkdtemp(join(os.tmpdir(), "ressac-firefox-"));
  // `relaunch`: the same profile again, its passport as the app left it.
  if (!relaunch) await writePassport(profile, [...entries(), ...extra]);
  for (const [p, list] of Object.entries(others)) await writePassport(profile, list, p);
  w = await launchRessac({ dataDir, profile, env: { RESSAC_TEST_PASSPORT_CIPHER: cipher, RESSAC_TEST_LOCAL_ADDRESSES: "1", RESSAC_TEST_PUBLIC_ADDRESSES: "127.0.0.1", RESSAC_TEST_REAUTH: "pass" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  const config = join(w.dataDir, "workspace", ".ressac", "mcp.json");
  await until(async () => existsSync(config), Boolean, 20_000);
  await agentPanelReady(m);
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out: last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * A tool call as the window's agent makes it: through its conversation's token (`.ressac/sessions/<id>.json`), whose
 * table resolves and keeps labels; the main token's resolves none (packages/kernel/src/mask/masker.ts). The newest file:
 * a relaunch on the same data folder starts a new conversation.
 */
function callTool(name: string, args: Record<string, unknown>) {
  const folder = join(w!.dataDir, "workspace", ".ressac", "sessions");
  const config = readdirSync(folder).filter((f) => f.endsWith(".json")).map((f) => join(folder, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!config) throw new Error("no session config");
  return callMcpTool(join(w!.dataDir, "workspace"), name, args, config);
}

/** The tool call, every card it puts up allowed, until it answers. */
async function allowing(name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean }> {
  let done = false;
  const call = callTool(name, args).finally(() => (done = true));
  while (!done) {
    const label = await inUi<string | null>(m, `const b = [...doc.querySelectorAll(arguments[0])].find((x) => x.textContent.trim().startsWith("Autoriser")); return b ? b.textContent.trim() : null;`, [CARDS]);
    // The card may fall between the look and the press (the call answered): looked at again on the next turn.
    if (label) await click(m, CARDS, { text: label }).catch(() => {});
    else await new Promise((r) => setTimeout(r, 100));
  }
  return call;
}

const loaded = (url: string) =>
  waitFor(m, `return gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec === ${JSON.stringify(url)} && !t.linkedBrowser.webProgress.isLoadingDocument)`, (v) => v === true, 15_000);
/** A tab the user opens from Ressac's UI. */
async function userTab(url: string): Promise<string> {
  const before = new Set(Object.keys((await state(m)).tabs));
  const s = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url, agentReached: false });
  await loaded(url);
  return Object.keys(s.tabs).find((x) => !before.has(x))!;
}
const read = async (id: string) => (await allowing("read_tab", { id })).text;
const clear = (text: string) => ["Aubrac", "Tanneurs"].filter((v) => text.includes(v));

it("a user's sensitive tab: the name, the address and a relative, under several spellings, reach the agent as labels", async () => {
  await start();
  const text = await read(await userTab(`${server.url}/compte/fiche.html`));
  expect(text).toMatch(/⟨nom-[a-z0-9]{8}⟩/);
  expect(text).toMatch(/⟨adresse-[a-z0-9]{8}⟩, 69005 Lyon/);
  expect(clear(text)).toEqual([]);
});

it("the same page, once the agent navigated the tab, is the web's: in clear", async () => {
  await start();
  const url = `${server.url}/compte/fiche.html`;
  const id = await userTab(url);
  expect((await allowing("navigate", { id, url: `${url}?agent=1`, reason: "relire la fiche" })).error).toBe(false);
  await loaded(`${url}?agent=1`);
  await until(async () => (await state(m)).tabs[id]?.agentReached, (v) => v === true);
  expect(clear(await read(id))).toEqual(["Aubrac", "Tanneurs"]);
});

it("a user's tab on a passport origin is a source; the same path elsewhere is not", async () => {
  await start();
  expect(clear(await read(await userTab(`${shop.url}/profil.html`)))).toEqual([]);
  expect(clear(await read(await userTab(`${server.url}/profil.html`)))).toEqual(["Aubrac", "Tanneurs"]);
});

it("a passport whose key is missing: the agent panel says it is not masked, and the agent reads it in clear", async () => {
  await start("absent");
  expect(await waitUi<string>(m, "return doc.querySelector('[data-testid=\"agent-mask-passport-unreadable\"] p')?.textContent", [], 15_000, "agent")).toBe(
    "Votre passeport « Perso » n'a pas pu être lu : ses données ne sont pas masquées pour l'agent.",
  );
  expect(clear(await read(await userTab(`${server.url}/compte/fiche.html`)))).toEqual(["Aubrac", "Tanneurs"]);
});

// Second part: the fill cards (design § 8.3-8.5, § 9.4). The order form is on `server`, off every passport origin: each
// card asks Touch ID, which the seam passes.
const CARD = '[data-testid="mask-request"]';
const FILLED = "Champ rempli.";
const FILL_DENIED = "L'utilisateur a refusé ce remplissage : rien n'a été écrit.";
const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";
/** The fill card up, once its text passes `ok`. */
const cardText = (ok: string) =>
  waitUi<string>(m, `const c = doc.querySelector(arguments[0]); const t = c && c.dataset.kind === "mask-fill" && c.textContent; return t && t.includes(arguments[1]) && t;`, [CARD, ok], 15_000);
const press = (text: string) => click(m, `${CARD} button`, { text });
const fill = (args: Record<string, unknown>) => callTool("fill_field", args);
/** The number the read gives the field labelled `label`. */
function fieldOf(text: string, label: string): number {
  const line = text.split("\n").find((l) => new RegExp(`^\\d+\\. \\S+ — ${label}$`).test(l));
  if (!line) throw new Error(`no field « ${label} » in the read`);
  return Number(line.split(".")[0]);
}
/** A field's value in Ressac tab `id` (content context), then back to chrome. */
async function valueOf(id: string, field: string): Promise<string> {
  const handle = await m.execute<string>(
    `const t = gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === arguments[0]);
     return ChromeUtils.importESModule("${NAVIGABLES}").NavigableManager.getIdForBrowser(t.linkedBrowser);`,
    [id],
  );
  await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
  await m.setContext("content");
  try {
    return await m.execute<string>(`return document.getElementById(${JSON.stringify(field)}).value`);
  } finally {
    await m.setContext("chrome");
  }
}
const orderForm = async () => {
  const id = await userTab(`${server.url}/fill/passport.html`);
  return { id, form: await read(id) };
};

it("fill by kind: the tab's entry shown masked, « Voir » shows it here, Remplir writes it; the next read shows a label", async () => {
  await start();
  const { id, form } = await orderForm();
  const reply = fill({ id, field: fieldOf(form, "Nom"), passport: "nom_complet" });
  const card = await cardText("Remplir votre nom");
  expect(card).toContain(`Remplir votre nom sur ${new URL(server.url).host} ?`);
  expect(card).toContain("Nom : votre nom");
  expect(clear(card)).toEqual([]);
  await press("Voir");
  await waitUi(m, `return doc.querySelector(arguments[0])?.textContent.includes("Aubrac")`, [`${CARD} [data-testid="mask-request-choice"]`]);
  await press("Remplir");
  expect((await reply).text).toBe(FILLED);
  expect(await valueOf(id, "nom")).toContain("Aubrac");
  // Design § 8.5: the page now shows the value; a later read of that origin masks it.
  const after = await read(id);
  expect(after).toMatch(/⟨nom-[a-z0-9]{8}⟩/);
  expect(clear(after)).toEqual([]);
});

it("a kind the passport lacks: « n'a pas d'IBAN », only « Ouvrir le passeport » and « Refuser »; the agent gets a refusal's text", async () => {
  await start();
  const { id, form } = await orderForm();
  let reply = fill({ id, field: fieldOf(form, "IBAN"), passport: "iban" });
  expect(await cardText("Votre passeport n'a pas d'IBAN.")).not.toContain("Remplir 1");
  expect(await inUi<string[]>(m, "return [...doc.querySelectorAll(arguments[0])].map((b) => b.textContent.trim())", [`${CARD} .actions button`])).toEqual(["Ouvrir le passeport", "Refuser"]);
  await press("Ouvrir le passeport");
  // Design § 7 point 4: the same text as a refused card of a kind the passport has.
  expect((await reply).text).toBe(FILL_DENIED);
  await waitUi(m, `return doc.querySelector('[data-testid="settings-nav-passport"]')?.getAttribute("aria-current") === "page"`, [], 15_000);
  reply = fill({ id, field: fieldOf(form, "Nom"), passport: "nom_complet" });
  await cardText("Remplir votre nom");
  await press("Refuser");
  expect((await reply).text).toBe(FILL_DENIED);
});

it("several fields, one card: a line per field, one press fills them in order", async () => {
  await start();
  const { id, form } = await orderForm();
  const reply = fill({ id, field: fieldOf(form, "Nom"), passport: "nom_complet", also: [{ field: fieldOf(form, "Adresse"), passport: "adresse" }, { field: fieldOf(form, "Ville"), passport: "ville" }] });
  const card = await cardText("3 champs");
  expect(card).toContain(`Remplir 3 champs sur ${new URL(server.url).host} avec votre passeport ?`);
  for (const line of ["Nom : votre nom", "Adresse : votre adresse", "Ville : votre ville"]) expect(card).toContain(line);
  expect(clear(card)).toEqual([]);
  // One card and one Touch ID (the seam passes it): a single press answers the whole call.
  await press("Remplir");
  expect((await reply).text).toBe("Rempli : 0, 1, 2.");
  expect(await valueOf(id, "nom")).toContain("Aubrac");
  expect(await valueOf(id, "adresse")).toContain("Tanneurs");
  expect(await valueOf(id, "ville")).toBe("Lyon");
  expect(clear(await read(id))).toEqual([]);
});

it("a label of another profile's passport: the card names that passport", async () => {
  // A passport kept with no space (design § 9.1): « Sans espace ».
  await start("memory", { work: [{ id: "0000000000000009", field: "nom", value: { given: "Lucie", family: COLLEAGUE }, origins: [] }] });
  const text = await read(await userTab(`${server.url}/compte/equipe.html`));
  expect(text).not.toContain(COLLEAGUE);
  const { id, form } = await orderForm();
  const reply = fill({ id, field: fieldOf(form, "Nom"), value: text.match(/⟨nom-[a-z0-9]{8}⟩/)![0] });
  expect(await cardText("Cette donnée")).toContain("Cette donnée vient de votre passeport « Sans espace », pas de celui de cet onglet.");
  await press("Refuser");
  expect((await reply).text).toBe(FILL_DENIED);
});

it("two entries of a kind: none is picked for the user, « Remplir » waits for a pick, and fills the one picked", async () => {
  await start("memory", {}, [{ id: "0000000000000004", field: "adresse", value: { text: "3 place Bellecour\n69002 Lyon" }, origins: [] }]);
  const { id, form } = await orderForm();
  const reply = fill({ id, field: fieldOf(form, "Adresse"), passport: "adresse" });
  await cardText("Remplir votre adresse");
  const radios = `${CARD} [role="radiogroup"] input[type="radio"]`;
  expect(await inUi<boolean[]>(m, "return [...doc.querySelectorAll(arguments[0])].map((r) => r.checked)", [radios])).toEqual([false, false]);
  expect(await inUi<boolean>(m, "return [...doc.querySelectorAll(arguments[0])].find((b) => b.textContent.trim() === 'Remplir').disabled", [`${CARD} button`])).toBe(true);
  await click(m, `${CARD} [role="radiogroup"] label:nth-child(2) input`);
  await waitUi(m, "return [...doc.querySelectorAll(arguments[0])].find((b) => b.textContent.trim() === 'Remplir')?.disabled === false", [`${CARD} button`]);
  await press("Remplir");
  expect((await reply).text).toBe(FILLED);
  expect(await valueOf(id, "adresse")).toContain("Bellecour");
});

it("« Retenir ce site »: unticked by default; ticked, Remplir adds the site to the entry, and after a relaunch the site's echo of the value reads masked", async () => {
  await start();
  const host = new URL(server.url).host;
  // Control: off every passport origin, the echo page is the web's.
  expect(clear(await read(await userTab(`${server.url}/profil.html`)))).toEqual(["Aubrac", "Tanneurs"]);
  const { id, form } = await orderForm();
  const reply = fill({ id, field: fieldOf(form, "Adresse"), passport: "adresse" });
  await cardText(`Retenir ${host} pour votre adresse`);
  const box = `${CARD} [data-testid="mask-request-remember"] input`;
  expect(await inUi<boolean>(m, "return doc.querySelector(arguments[0]).checked", [box])).toBe(false);
  expect(await inUi<boolean>(m, "return !!doc.querySelector(arguments[0])", [`${CARD} [data-testid="mask-request-remember-hint"]`])).toBe(false);
  await click(m, box);
  expect(await waitUi<string>(m, "return doc.querySelector(arguments[0])?.textContent", [`${CARD} [data-testid="mask-request-remember-hint"]`])).toBe(
    "Sur ce site, la donnée restera masquée pour l'agent et se remplira sans Touch ID.",
  );
  await press("Remplir");
  expect((await reply).text).toBe(FILLED);
  // Written after the fill's answer: waited on, never read once.
  await expect.poll(async () => (await readPassport(profile!)).find((e) => e.id === "0000000000000003")?.origins, { timeout: 15_000 }).toEqual([host]);
  await w!.close();
  w = undefined;
  await start("memory", {}, [], true);
  // A new kernel, so no conversation table: the site is now a passport site, a source when the user opens it.
  expect(clear(await read(await userTab(`${server.url}/profil.html`)))).toEqual([]);
});
