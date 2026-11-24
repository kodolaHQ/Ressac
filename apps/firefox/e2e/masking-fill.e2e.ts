import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { callMcpTool } from "../test/mcp";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import { writePassport } from "./passport-file";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, startAgentSession, waitUi } from "./ui";

// fill_field in Firefox (spec § 5.4): the seal, then a check and a write in one block. Each case has its page under
// e2e/pages/fill/; a page sends what its fields hold to its own server (`/log`), the test waits there or on the field.
// Two servers on 127.0.0.1, two ports: two origins. Values are built, never written whole.
const CODE = ["38", "16", "24"].join("");
const PASSWORD = ["pw", "e2e", "4417"].join("-");
const FILLED = "Champ rempli.";
const CHANGED = "Le champ a changé avant le remplissage : rien n'a été écrit. Redemande.";
const SAVED_LOGIN_REFUSED = "Le mot de passe enregistré ne se remplit que sur son site exact, dans un champ mot de passe ou identifiant, sans cadre ni formulaire d'un autre site.";
const FILL_DENIED = "L'utilisateur a refusé ce remplissage : rien n'a été écrit.";
const CARD = '[data-testid="mask-request"]';
const ACCESS = '[data-testid="permission-request"] button';
const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";

type Log = { f: string | null; v: string | null };
const logs: { a: Log[]; b: Log[] } = { a: [], b: [] };
const logRoute = (into: Log[]) => (req: IncomingMessage, res: ServerResponse) => {
  const q = new URL(req.url ?? "/", "http://x").searchParams;
  into.push({ f: q.get("f"), v: q.get("v") });
  res.writeHead(204).end();
};
const html = (res: ServerResponse, body: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
// `/compte/` makes the webmail sensitive: a masking source once the user reached it, so its code fills on another site.
const mail = (_req: unknown, res: ServerResponse) => html(res, `<title>Messagerie</title><p>Votre code de vérification : ${CODE}</p>`);
const FAMILY = ["Aub", "rac"].join("");
// A shop's account page on the passport's own origin: a source there (design § 6.1), with a field for the name.
const client = (_req: unknown, res: ServerResponse) => html(res, `<title>Compte client</title><p>Client : Camille ${FAMILY}</p><form action="/fill/next.html"><label for="nom">Nom</label><input id="nom"></form>`);

let a: Awaited<ReturnType<typeof startServer>>;
let b: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac | undefined;
let m: Marionette;
/** The Firefox profile a test made for its passport, deleted after it. */
let profile: string | undefined;
// A page's hero form and its form further down, each with an « Email » field: the user looks at the second.
const TWO_FORMS = `<title>Inscription</title><form><input type="email" aria-label="Email"></form><div style="height:3000px"></div><form><label for="mail">Email</label><input id="mail" type="email"></form>`;
// A sign-up form's box, radios and list; each change the page sees is counted (a framework listens the same way).
const CHOICES = `<title>Inscription</title><form><label><input type="checkbox" id="cgu"> J'accepte les conditions</label>
<fieldset><legend>Formule</legend><label><input type="radio" name="f" id="mois"> Mensuelle</label><label><input type="radio" name="f" id="an"> Annuelle</label></fieldset>
<label for="pays">Pays</label><select id="pays"><option>France</option><option>Belgique</option><option>Suisse</option></select></form>
<script>window.seen = 0; document.addEventListener("change", () => window.seen++);</script>`;
// A page of 45 filter boxes before its form: over the 40-field cap, the form's text fields stay listed.
const FILTERS = `<title>Filtres</title>${Array.from({ length: 45 }, (_, i) => `<label><input type="checkbox"> Filtre ${i}</label>`).join("")}<form><label for="nom">Nom</label><input id="nom"><label for="ville">Ville</label><input id="ville"></form>`;
beforeAll(async () => {
  a = await startServer({ routes: { "/log": logRoute(logs.a), "/fill/compte/mail.html": mail, "/fill/deux.html": (_req: unknown, res: ServerResponse) => html(res, TWO_FORMS), "/fill/choix.html": (_req: unknown, res: ServerResponse) => html(res, CHOICES), "/fill/filtres.html": (_req: unknown, res: ServerResponse) => html(res, FILTERS) } });
  b = await startServer({ routes: { "/log": logRoute(logs.b), "/fill/client.html": client } });
});
afterAll(() => Promise.all([a?.close(), b?.close()]));
beforeEach(() => {
  logs.a.length = 0;
  logs.b.length = 0;
});
afterEach(async () => {
  await w?.close();
  w = undefined;
  if (profile) await rm(profile, { recursive: true, force: true });
  profile = undefined;
});

/** A tab the user opened (never the agent's), loaded. */
async function userTab(url: string): Promise<string> {
  const before = new Set(Object.keys((await state(m)).tabs));
  const s = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url, agentReached: false });
  await waitFor(m, `return gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec === ${JSON.stringify(url)} && !t.linkedBrowser.webProgress.isLoadingDocument)`, (v) => v === true, 15_000);
  return Object.keys(s.tabs).find((x) => !before.has(x))!;
}

/** Launches with the Touch ID seam, the agent's session started; returns the code's label, read in the user's webmail. */
async function start(): Promise<string> {
  w = await launchRessac({ env: { RESSAC_TEST_REAUTH: "pass", RESSAC_TEST_PUBLIC_ADDRESSES: "127.0.0.1" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  const mailTab = await userTab(`${a.url}/fill/compte/mail.html`);
  await startAgentSession(m);
  const text = await read(mailTab);
  expect(text).not.toContain(CODE);
  return text.match(/⟨code-[a-z0-9]{8}⟩/)![0];
}

/** The window's session config: its token resolves this conversation's labels. */
const sessionConfig = () => {
  const folder = join(w!.dataDir, "workspace", ".ressac", "sessions");
  const name = existsSync(folder) ? readdirSync(folder).find((f) => f.endsWith(".json")) : undefined;
  if (!name) throw new Error("no session config");
  return join(folder, name);
};
/** A tool call as the window's agent makes it; with `allow`, every read access card it puts up is allowed until it answers. */
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
const read = async (id: string) => (await call("read_tab", { id }, true)).text;
/** The number the read gives the field labelled `label`. */
function fieldOf(text: string, label: string): number {
  const line = text.split("\n").find((l) => new RegExp(`^\\d+\\. \\S+ — ${label}$`).test(l));
  if (!line) throw new Error(`no field « ${label} » in the read`);
  return Number(line.split(".")[0]);
}
/** A fill_field call left waiting on its card, and the card's text once it is up. */
async function fillWithCard(args: Record<string, unknown>): Promise<{ reply: Promise<{ text: string }>; card: string }> {
  const reply = call("fill_field", args);
  const card = await waitUi<string>(m, `const c = doc.querySelector(arguments[0]); return c && c.dataset.kind === "mask-fill" && c.textContent;`, [CARD], 15_000);
  return { reply, card };
}
const press = (text: "Remplir" | "Refuser") => click(m, `${CARD} button`, { text });
const noCard = async () => expect(await inUi<boolean>(m, "return !!doc.querySelector(arguments[0])", [CARD])).toBe(false);

/** Runs `script` in the top document of Ressac tab `id` (content context), then comes back to chrome. */
async function inPage<T>(id: string, script: string): Promise<T> {
  const handle = await m.execute<string>(
    `const t = gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === arguments[0]);
     return ChromeUtils.importESModule("${NAVIGABLES}").NavigableManager.getIdForBrowser(t.linkedBrowser);`,
    [id],
  );
  await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
  await m.setContext("content");
  try {
    return await m.execute<T>(script);
  } finally {
    await m.setContext("chrome");
  }
}
const valueOf = (id: string, field: string) => inPage<string>(id, `return document.getElementById(${JSON.stringify(field)}).value`);

/** A login saved in Firefox for `origin`, as the user would have saved it. */
const saveLogin = (origin: string) =>
  m.execute(
    `return (async () => {
       const l = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
       l.init(arguments[0], arguments[0], null, "moi", arguments[1], "", "");
       await Services.logins.addLoginAsync(l);
     })();`,
    [origin, PASSWORD],
  );

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out: last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

it("two alike fields: the one out of view is read as « hors de l'écran », the one the user looks at is not", async () => {
  await start();
  const id = await userTab(`${a.url}/fill/deux.html`);
  await inPage(id, `document.getElementById("mail").scrollIntoView(); return true;`);
  const text = await read(id);
  expect(text).toContain("0. email — Email (hors de l'écran)");
  expect(text).toMatch(/1\. email — Email$/m);
});

it("boxes and lists on the user's tab: one card, then the box ticked, the radio chosen, the option set; the page sees each change", async () => {
  await start();
  const id = await userTab(`${a.url}/fill/choix.html`);
  const text = await read(id);
  const box = fieldOf(text, "J'accepte les conditions \\(pas coché\\)");
  const radio = fieldOf(text, "Formule : Annuelle \\(pas coché\\)");
  const list = Number(text.split("\n").find((l) => / select — Pays /.test(l))!.split(".")[0]);
  expect(text).toContain("Pays (choisi : France) ; options : 0. France · 1. Belgique · 2. Suisse");
  const { reply, card } = await fillWithCard({ id, field: box, check: true, also: [{ field: radio, check: true }, { field: list, option: 1 }] });
  expect(card).toContain("J'accepte les conditions : cocher");
  expect(card).toContain("Pays : choisir « Belgique »");
  await press("Remplir");
  expect((await reply).text).toBe(`Rempli : 0, 1, 2.`);
  expect(await inPage(id, `return [document.getElementById("cgu").checked, document.getElementById("an").checked, document.getElementById("pays").value, window.seen]`)).toEqual([true, true, "Belgique", 3]);
});

it("over the field cap, boxes give way: the form's text fields stay listed, every number still names its field", async () => {
  await start();
  const id = await userTab(`${a.url}/fill/filtres.html`);
  const lines = (await read(id)).split("\n").filter((l) => /^\d+\. \S+ — /.test(l));
  expect(lines).toHaveLength(40);
  expect(lines.at(-2)).toBe("38. text — Nom");
  expect(lines.at(-1)).toBe("39. text — Ville");
  const ville = fieldOf(lines.join("\n"), "Ville");
  expect((await call("fill_field", { id, field: ville, value: "Lyon" })).text).toBe(FILLED);
  expect(await valueOf(id, "ville")).toBe("Lyon");
});

it("a box relabelled while the card is up: the card's yes ticks nothing", async () => {
  await start();
  const id = await userTab(`${a.url}/fill/choix.html`);
  const box = fieldOf(await read(id), "J'accepte les conditions \\(pas coché\\)");
  const { reply } = await fillWithCard({ id, field: box, check: true });
  await inPage(id, `document.getElementById("cgu").parentElement.lastChild.textContent = " Supprimer mon compte"; return true;`);
  await press("Remplir");
  expect((await reply).text).toContain("a changé");
  expect(await inPage(id, `return document.getElementById("cgu").checked`)).toBe(false);
});

it("a list reordered between the read and the card's yes: nothing chosen", async () => {
  await start();
  const id = await userTab(`${a.url}/fill/choix.html`);
  const text = await read(id);
  const list = Number(text.split("\n").find((l) => / select — Pays /.test(l))!.split(".")[0]);
  const { reply } = await fillWithCard({ id, field: list, option: 1 });
  // The page swaps « Belgique » for « Suisse » while the card is up: option 1 is no longer the one read.
  await inPage(id, `const s = document.getElementById("pays"); s.insertBefore(s.options[2], s.options[1]); return true;`);
  await press("Remplir");
  expect((await reply).text).toContain("a changé");
  expect(await inPage(id, `return document.getElementById("pays").value`)).toBe("France");
});

it("1. a form injected after the read: its field has no number; the number read still names the field read", async () => {
  const label = await start();
  const id = await userTab(`${a.url}/fill/injected.html`);
  const field = fieldOf(await read(id), "Code de vérification");
  await inPage(id, `document.body.insertAdjacentHTML("afterbegin", '<form action="${b.url}/steal"><label for="injected">Code de vérification</label><input id="injected"></form>')`);
  expect((await call("fill_field", { id, field: field + 1, value: label })).text).toContain("inconnu");
  const { reply } = await fillWithCard({ id, field, value: label });
  await press("Remplir");
  expect((await reply).text).toBe(FILLED);
  expect(await valueOf(id, "code")).toBe(CODE);
  expect(await valueOf(id, "injected")).toBe("");
});

it("2. a legitimate action with a script that sends the value on input: it reaches that origin only (the delegation, documented)", async () => {
  const label = await start();
  const id = await userTab(`${a.url}/fill/exfil.html`);
  const { reply } = await fillWithCard({ id, field: fieldOf(await read(id), "Code de vérification"), value: label });
  await press("Remplir");
  expect((await reply).text).toBe(FILLED);
  await until(() => logs.a, (l) => l.some((x) => x.f === "code" && x.v === CODE));
  // The page's script sends where it likes: Ressac's guarantee is only that the field was on this origin.
  expect(logs.b.some((x) => x.v?.includes(CODE))).toBe(false);
});

it("3. a field replaced, or moved to another form with the same action, before the commit: « changed », nothing written", async () => {
  const label = await start();
  const id = await userTab(`${a.url}/fill/swap.html`);
  const text = await read(id);
  let { reply } = await fillWithCard({ id, field: fieldOf(text, "Code de vérification"), value: label });
  await inPage(id, `const n = document.createElement("input"); n.id = "code2"; document.getElementById("code").replaceWith(n);`);
  await press("Remplir");
  expect((await reply).text).toBe(CHANGED);
  expect(await valueOf(id, "code2")).toBe("");
  ({ reply } = await fillWithCard({ id, field: fieldOf(text, "Code de secours"), value: label }));
  await inPage(id, `document.getElementById("other").append(document.getElementById("backup"));`);
  await press("Remplir");
  expect((await reply).text).toBe(CHANGED);
  expect(await valueOf(id, "backup")).toBe("");
  expect(logs.a.some((x) => x.v === CODE)).toBe(false);
});

it("4. the form's action moved to another origin after prepare: « changed », nothing written", async () => {
  const label = await start();
  const id = await userTab(`${a.url}/fill/action.html`);
  const { reply } = await fillWithCard({ id, field: fieldOf(await read(id), "Code de vérification"), value: label });
  await inPage(id, `document.forms[0].action = ${JSON.stringify(b.url + "/steal")};`);
  await press("Remplir");
  expect((await reply).text).toBe(CHANGED);
  expect(await valueOf(id, "code")).toBe("");
});

it("5. a password field that is no login: the saved password only after the card, on its exact origin; refused in a frame", async () => {
  await start();
  await saveLogin(a.url);
  const id = await userTab(`${a.url}/fill/confirm.html`);
  const { reply, card } = await fillWithCard({ id, field: fieldOf(await read(id), "Confirmer le code"), saved_login: true });
  expect(card).toContain(`${a.url}/fill/confirm.html`);
  expect(card).not.toContain(PASSWORD);
  // Nothing goes before the card's answer.
  expect(await valueOf(id, "pin")).toBe("");
  await press("Remplir");
  expect((await reply).text).toBe(FILLED);
  expect(await valueOf(id, "pin")).toBe(PASSWORD);

  // The same form in a frame of another origin's page: no card can widen this.
  const framed = await userTab(`${b.url}/fill/framed.html?vers=${encodeURIComponent(`${a.url}/fill/confirm.html`)}`);
  const field = fieldOf(await until(() => read(framed), (t) => t.includes("Confirmer le code")), "Confirmer le code");
  const r = await call("fill_field", { id: framed, field, saved_login: true });
  expect(r.text).toBe(SAVED_LOGIN_REFUSED);
  await noCard();
});

it("a saved login on a login form: one call, one card naming both fields, the username and the password each in its field", async () => {
  await start();
  await saveLogin(a.url);
  const id = await userTab(`${a.url}/fill/login.html`);
  const { reply, card } = await fillWithCard({ id, field: fieldOf(await read(id), "Mot de passe"), saved_login: true });
  expect(card).toContain("votre identifiant et votre mot de passe");
  expect(card).not.toContain(PASSWORD);
  expect(await valueOf(id, "user")).toBe("");
  await press("Remplir");
  expect((await reply).text).toBe("Identifiant et mot de passe remplis.");
  expect(await valueOf(id, "user")).toBe("moi");
  expect(await valueOf(id, "pin")).toBe(PASSWORD);
});

it("a login form with no autocomplete: Firefox's pairing lets the username fill with the password, from the username field too", async () => {
  await start();
  await saveLogin(a.url);
  const id = await userTab(`${a.url}/fill/login-plain.html`);
  const { reply, card } = await fillWithCard({ id, field: fieldOf(await read(id), "Identifiant"), saved_login: true });
  expect(card).toContain("votre identifiant et votre mot de passe");
  await press("Remplir");
  expect((await reply).text).toBe("Identifiant et mot de passe remplis.");
  expect(await valueOf(id, "user")).toBe("moi");
  expect(await valueOf(id, "pin")).toBe(PASSWORD);
});

it("6. a field in a frame of another origin: the saved login refused without a card; a code's card names the frame's origin", async () => {
  const label = await start();
  await saveLogin(b.url);
  const id = await userTab(`${a.url}/fill/framed.html?vers=${encodeURIComponent(`${b.url}/fill/confirm.html`)}`);
  const field = fieldOf(await until(() => read(id), (t) => t.includes("Confirmer le code")), "Confirmer le code");
  expect((await call("fill_field", { id, field, saved_login: true })).text).toBe(SAVED_LOGIN_REFUSED);
  await noCard();
  const { reply, card } = await fillWithCard({ id, field, value: label });
  expect(card).toContain(`${b.url}/fill/confirm.html`);
  await press("Remplir");
  expect((await reply).text).toBe(FILLED);
  await until(() => logs.b, (l) => l.some((x) => x.f === "pin" && x.v === CODE));
  expect(logs.a.some((x) => x.v === CODE)).toBe(false);
});

it("7. the sealed field detached and an identical one put in its place: « changed », the twin stays empty", async () => {
  const label = await start();
  const id = await userTab(`${a.url}/fill/detach.html`);
  const { reply } = await fillWithCard({ id, field: fieldOf(await read(id), "Code de vérification"), value: label });
  await inPage(id, `const f = document.getElementById("code"); f.replaceWith(f.cloneNode(true));`);
  await press("Remplir");
  expect((await reply).text).toBe(CHANGED);
  expect(await valueOf(id, "code")).toBe("");
});

it("formaction: a submit button sending to another origin makes the form's destination that origin", async () => {
  const label = await start();
  await saveLogin(a.url);
  const id = await userTab(`${a.url}/fill/formaction.html?vers=${encodeURIComponent(b.url)}`);
  const text = await read(id);
  // The saved password: never into a form that may send it elsewhere.
  expect((await call("fill_field", { id, field: fieldOf(text, "Mot de passe"), saved_login: true })).text).toBe(SAVED_LOGIN_REFUSED);
  await noCard();
  // A code: the card's red line names where the form sends it.
  const { reply } = await fillWithCard({ id, field: fieldOf(text, "Code de vérification"), value: label });
  const danger = await inUi<string>(m, "return [...doc.querySelectorAll('[data-testid=\"mask-request-danger\"]')].map((d) => d.textContent).join(' ')", []);
  expect(danger).toContain(b.url);
  await press("Refuser");
  expect((await reply).text).toBe(FILL_DENIED);
  expect(await valueOf(id, "code")).toBe("");

  // A formaction added after the seal: the child sees it in its check, nothing is written.
  const plain = await userTab(`${a.url}/fill/formaction.html`);
  const again = await fillWithCard({ id: plain, field: fieldOf(await read(plain), "Code de vérification"), value: label });
  await inPage(plain, `const s = document.createElement("button"); s.setAttribute("formaction", ${JSON.stringify(b.url + "/steal")}); document.getElementById("main").append(s);`);
  await press("Remplir");
  expect((await again.reply).text).toBe(CHANGED);
  expect(await valueOf(plain, "code")).toBe("");
});

it("a code read in the webmail fills the bank's field after the card; the agent's next read shows its label, never the code", async () => {
  const label = await start();
  const id = await userTab(`${b.url}/fill/bank.html`);
  const { reply, card } = await fillWithCard({ id, field: fieldOf(await read(id), "Code reçu par e-mail"), value: label });
  expect(card).toContain(b.url);
  expect(card).not.toContain(CODE);
  await press("Remplir");
  expect((await reply).text).toBe(FILLED);
  expect(await valueOf(id, "code")).toBe(CODE);
  const after = await read(id);
  expect(after).toMatch(/Code saisi : ⟨code-[a-z0-9]{8}⟩/);
  expect(after).not.toContain(CODE);
});

it("a passport label on its own origin: its card, and no Touch ID (the failing seam would refuse one)", async () => {
  profile = await mkdtemp(join(os.tmpdir(), "ressac-firefox-"));
  await writePassport(profile, [{ id: "0000000000000001", field: "nom", value: { given: "Camille", family: FAMILY }, origins: [new URL(b.url).host] }]);
  w = await launchRessac({ profile, env: { RESSAC_TEST_REAUTH: "fail", RESSAC_TEST_PUBLIC_ADDRESSES: "127.0.0.1", RESSAC_TEST_PASSPORT_CIPHER: "memory", RESSAC_TEST_LOCAL_ADDRESSES: "1" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  const id = await userTab(`${b.url}/fill/client.html`);
  await startAgentSession(m);
  const text = await read(id);
  expect(text).not.toContain(FAMILY);
  const { reply, card } = await fillWithCard({ id, field: fieldOf(text, "Nom"), value: text.match(/⟨nom-[a-z0-9]{8}⟩/)![0] });
  expect(card).not.toContain(FAMILY);
  expect(await inUi<boolean>(m, "return !!doc.querySelector('[data-testid=\"mask-request-profile\"]')")).toBe(false);
  await press("Remplir");
  expect((await reply).text).toBe(FILLED);
  expect(await valueOf(id, "nom")).toContain(FAMILY);
});
