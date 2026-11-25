import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { readPassport, type PassportEntry } from "./passport-file";
import { startServer } from "./server";
import { click, inUi, pressKeys, waitUi } from "./ui";

// « Remplir le passeport » Task 8: a typed address form, once sent, offers its values to the passport in Ressac's own
// bubble over the page (chrome/passport/form-capture.ts, ui/PassportSuggest.svelte, chrome/agent/typed-actor.ts), never
// in Firefox's doorhanger or address store. Every « no bubble » check waits for Firefox's own submission handling to end
// (a probe around `_onAddressSubmit`, which Ressac's wrapper awaits through to its decision): the bubble is decided by
// then, no sleep; and each such test ends with a positive control where it could otherwise pass on a blind check.

const B = "gBrowser.selectedBrowser";
const PARENT = "resource://autofill/FormAutofillParent.sys.mjs";
const STORAGE = "resource://autofill/FormAutofillStorage.sys.mjs";
const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";
const PATCHED = 'Symbol.for("ressac.formCapture")';
const PHONE = ["06", "12", "34", "56", "78"].join(" ");
const ME = { given: "Camille", family: "Aubrac", street: "14 rue des Tanneurs", postcode: "69001", city: "Lyon", tel: PHONE, email: "camille@exemple.fr" };
const SHOWN = ["Votre nom : Camille Aubrac", "Adresse postale : 14 rue des Tanneurs, 69001 Lyon", `Téléphone : ${PHONE}`, "E-mail : camille@exemple.fr"];

/** An address form's fields, by autocomplete (`section`: "shipping " or "billing "), ids prefixed with `p`. */
const fields = (p: string, section = "") =>
  [["given", "given-name", "Prénom"], ["family", "family-name", "Nom"], ["street", "street-address", "Adresse"], ["postcode", "postal-code", "Code postal"], ["city", "address-level2", "Ville"], ["tel", "tel", "Téléphone"], ["email", "email", "E-mail"]]
    .map(([id, ac, label]) => `<label>${label} <input id="${p}${id}" name="${p}${id}" autocomplete="${section}${ac}"${id === "tel" || id === "email" ? ` type="${id}"` : ""}></label><br>`)
    .join("");
const HEAD = '<!doctype html><meta charset="utf-8"><title>Formulaire</title><body style="font:16px sans-serif">';
// Two forms sent into a frame: the top document stays, so a second send is in the same document.
const TWICE = `${HEAD}<iframe name="sink" style="width:20px;height:20px"></iframe>
<form id="f1" method="post" action="/merci" target="sink">${fields("a-")}<button id="a-send">Envoyer</button></form>
<form id="f2" method="post" action="/merci" target="sink">${fields("b-")}<button id="b-send">Envoyer</button></form>`;
// A real French form: labels only, one « Adresse » field, a POST that navigates.
const FRENCH = `${HEAD}<form method="post" action="/merci">
<label for="p">Prénom</label> <input id="p" name="prenom"><br>
<label for="n">Nom</label> <input id="n" name="nom"><br>
<label for="a">Adresse</label> <input id="a" name="adresse"><br>
<label for="cp">Code postal</label> <input id="cp" name="code_postal"><br>
<label for="v">Ville</label> <input id="v" name="ville"><br>
<label for="t">Tél.</label> <input id="t" name="telephone" type="tel"><br>
<label for="e">E-mail</label> <input id="e" name="email" type="email"><br>
<button id="send">Envoyer</button></form>`;
// The page rewrites a typed field as it is sent.
const REWRITE = `${TWICE}<script>document.getElementById("f1").addEventListener("submit", () => (document.getElementById("a-given").value = "Lucie"));</script>`;
// Tab out of the first name, and the page types into it with execCommand (a trusted input event, no key).
const TAB = `${TWICE}<script>
  document.getElementById("a-family").addEventListener("focus", () => {
    const given = document.getElementById("a-given");
    given.focus();
    given.select();
    document.execCommand("insertText", false, "Lucie Piège");
    document.getElementById("a-family").focus();
  }, { once: true });
</script>`;
// Sent by fetch, then the form is removed: no navigation, the fields gone before Firefox asks.
const FETCH = `${HEAD}<form id="f1" method="post" action="/merci">${fields("a-")}<button id="a-send">Envoyer</button></form>
<script>
  const f = document.getElementById("f1");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    await fetch("/merci", { method: "POST", body: new FormData(f) });
    f.remove();
  });
</script>`;
// Shipping and billing in one form: two address sections, one send.
const TWO_SECTIONS = `${HEAD}<form method="post" action="/merci">${fields("s-", "shipping ")}${fields("b-", "billing ")}<button id="send">Envoyer</button></form>`;
const PAGES: Record<string, string> = { "/twice.html": TWICE, "/francais.html": FRENCH, "/reecrit.html": REWRITE, "/tab.html": TAB, "/fetch.html": FETCH, "/sections.html": TWO_SECTIONS, "/merci": `${HEAD}<p>Merci</p>` };

const html = (res: ServerResponse, body: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
type Site = { url: string; close(): Promise<void> };
let server: Site;
// The same pages over plain http: never offered.
let plain: Awaited<ReturnType<typeof startServer>>;
let certs: string;
let host: string;

async function startHttps(tls: { key: Buffer; cert: Buffer }): Promise<Site> {
  const srv = createHttpsServer(tls, (req, res) => {
    const body = PAGES[(req.url ?? "").split("?")[0]!];
    if (body === undefined) return void res.writeHead(404).end();
    // A POST's body is read before the answer (the form's values, unused).
    req.resume();
    req.on("end", () => html(res, body));
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const port = (srv.address() as { port: number }).port;
  return { url: `https://127.0.0.1:${port}`, close: () => new Promise((ok) => (srv.closeAllConnections(), srv.close(() => ok()))) };
}

let w: LaunchedRessac | undefined;
let m: Marionette;
let profile: string | undefined;

beforeAll(async () => {
  certs = mkdtempSync(join(os.tmpdir(), "ressac-cert-"));
  const [key, cert] = [join(certs, "key.pem"), join(certs, "cert.pem")];
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  server = await startHttps({ key: readFileSync(key), cert: readFileSync(cert) });
  host = new URL(server.url).host;
  plain = await startServer({ routes: Object.fromEntries(Object.entries(PAGES).map(([p, body]) => [p, (_req: unknown, res: ServerResponse) => html(res, body)])) });
});
afterAll(async () => {
  await Promise.all([server?.close(), plain?.close()]);
  rmSync(certs, { recursive: true, force: true });
});
afterEach(async () => {
  await w?.close();
  w = undefined;
  if (profile) await rm(profile, { recursive: true, force: true });
  profile = undefined;
});

// Marionette's recommended prefs switch Firefox's address autofill off (remote/shared/RecommendedPreferences.sys.mjs);
// a user value wins over them, and a real profile has it on.
const AUTOFILL = { "extensions.formautofill.addresses.enabled": true };
/** Launches with the memory cipher and the Touch ID test path; the probe around Firefox's address submission. */
async function start(o: { prefs?: Record<string, string | boolean> } = {}): Promise<void> {
  profile = await mkdtemp(join(os.tmpdir(), "ressac-firefox-"));
  w = await launchRessac({ profile, env: { RESSAC_TEST_PASSPORT_CIPHER: "memory", RESSAC_TEST_REAUTH: "pass" }, prefs: { ...AUTOFILL, ...o.prefs } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  // The self-signed certificate of the test site: accepted for this run.
  await m.execute('Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).setDisableAllSecurityChecksAndLetAttackersInterceptMyData(true);');
  // Around Ressac's wrapper (installed at startup): each submission Firefox hands over, noted once Ressac is done with it
  // (its bar shown or not). Only the record's filled field names are kept, never a value.
  await m.execute(
    `const { FormAutofillParent } = ChromeUtils.importESModule("${PARENT}");
     const P = FormAutofillParent.prototype;
     if (P[${PATCHED}] !== true) throw new Error("Ressac's form capture is not installed");
     if (FormAutofillParent.ressacTestSubmits) return;
     FormAutofillParent.ressacTestSubmits = [];
     // Firefox drops a send whose fields it has not identified yet (FormAutofillChild.formSubmitted): counted here.
     FormAutofillParent.ressacTestIdentified = 0;
     FormAutofillParent.addMessageObserver({ fieldsIdentified: () => FormAutofillParent.ressacTestIdentified++ });
     const inner = P._onAddressSubmit;
     P._onAddressSubmit = async function (address, browser) {
       try {
         return await inner.call(this, address, browser);
       } finally {
         const r = address?.record ?? {};
         FormAutofillParent.ressacTestSubmits.push(Object.keys(r).filter((k) => r[k]).sort());
       }
     };`,
  );
}

/** A tab opened from Ressac's UI (`agentReached`: as the agent's), selected and loaded. */
async function tab(url: string, o: { agentReached?: boolean; spaceId?: string } = {}): Promise<string> {
  const before = new Set(Object.keys((await state(m)).tabs));
  const s = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url, agentReached: o.agentReached ?? false, ...(o.spaceId ? { spaceId: o.spaceId } : {}) });
  const id = Object.keys(s.tabs).find((x) => !before.has(x))!;
  await dispatch(m, { type: "activateTab", id });
  await waitFor(m, `return ${B}.currentURI.spec === ${JSON.stringify(url)} && !${B}.webProgress.isLoadingDocument`, (v) => v === true, 15_000);
  return id;
}

/** Runs `fn` with Marionette in the selected tab's content, then back to the chrome window. */
async function inTab<T>(fn: () => Promise<T>): Promise<T> {
  const main = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
  const handle = await m.execute<string>(`return ChromeUtils.importESModule("${NAVIGABLES}").NavigableManager.getIdForBrowser(${B});`);
  await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
  await m.setContext("content");
  try {
    return await fn();
  } finally {
    await m.setContext("chrome");
    await m.command("WebDriver:SwitchToWindow", { handle: main, focus: false });
  }
}
const element = async (selector: string) => Object.values((await m.command<{ value: Record<string, string> }>("WebDriver:FindElement", { using: "css selector", value: selector })).value)[0]!;
/** Types into each field with real key events (WebDriver keys: keydown, input, keyup, trusted). */
const typeKeys = (values: [string, string][]) => inTab(async () => {
  for (const [selector, text] of values) await m.command("WebDriver:ElementSendKeys", { id: await element(selector), text });
});
/** The form typed by keyboard, ids prefixed with `p`. */
const typeForm = (p: string, v: typeof ME = ME) => typeKeys(Object.entries(v).map(([k, text]) => [`#${p}${k}`, text]));
/** Waits until Firefox identified the fields of `forms` forms (at least): before then it ignores a send. */
const identified = (forms: number) => waitFor<number>(m, `return ChromeUtils.importESModule("${PARENT}").FormAutofillParent.ressacTestIdentified`, (v) => v >= forms, 15_000);
/** A trusted click on the page's send button, once Firefox identified the fields of the `forms`-th form focused in this test. */
async function press(selector: string, forms = 1): Promise<void> {
  await identified(forms);
  await inTab(async () => m.command("WebDriver:ElementClick", { id: await element(selector) }));
}
const inPage = <T>(script: string, args: unknown[] = []) => inTab(() => m.execute<T>(script, args));

/** Waits until Firefox handed over `n` address submissions and Ressac was done with each; their field names. */
const submitted = (n: number) =>
  waitFor<string[][]>(m, `return ChromeUtils.importESModule("${PARENT}").FormAutofillParent.ressacTestSubmits`, (v) => v.length >= n, 20_000).catch((e) => {
    throw new Error(`Firefox handed over fewer than ${n} address submission(s): ${(e as Error).message}`);
  });

const FRAME = "ressac-passport-suggest";
const tid = (id: string) => `[data-testid="${id}"]`;
type Offer = { values: string[]; site: string; remember: boolean; phase: string; done?: string };
/** The chrome's bubble for the selected tab: decided as Firefox's submission is handled (before the frame draws it). */
const decided = () => m.execute<Offer | null>(`return document.getElementById("${FRAME}")?.ressacPassportSuggest?.api.context() ?? null;`);
/**
 * Waits for the tab's one bubble really on screen: one frame, shown, in the selected page's box, the one under the
 * pointer at its centre, its bubble drawn with a size; its values as shown. Fails if a second frame or bubble shows.
 */
async function oneOffer(): Promise<{ values: string[]; text: string }> {
  await expect.poll(decided, { timeout: 20_000 }).not.toBeNull();
  const shown = await waitFor<{ values: string[]; text: string } | null>(
    m,
    `const fs = document.querySelectorAll("#${FRAME}");
     if (fs.length !== 1) throw new Error(fs.length + " suggestion frames");
     const f = fs[0], d = f.contentDocument;
     const roots = d?.querySelectorAll('${tid("passport-suggest")}') ?? [];
     if (roots.length > 1) throw new Error(roots.length + " suggestion bubbles");
     const root = roots[0], seen = { opacityProperty: true, visibilityProperty: true };
     if (!root || !f.checkVisibility(seen) || !root.checkVisibility(seen)) return null;
     const r = f.getBoundingClientRect(), p = ${B}.getBoundingClientRect(), br = root.getBoundingClientRect();
     if (!r.width || !r.height || !br.width || !br.height) return null;
     if (r.left < p.left || r.right > p.right || r.top < p.top || r.bottom > p.bottom) return null;
     if (document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) !== f) return null;
     const values = [...d.querySelectorAll('${tid("passport-suggest-values")} li')].map((li) => li.textContent.trim());
     return values.length ? { values, text: values.join(" · ") } : null;`,
    (v) => v !== null,
    20_000,
  );
  return shown!;
}
/** Waits until the selected tab shows no bubble: none decided, and its frame hidden after the exit fade. */
async function gone(): Promise<void> {
  await expect.poll(decided, { timeout: 20_000 }).toBeNull();
  await waitFor(m, `const f = document.getElementById("${FRAME}"); return !f || !f.checkVisibility();`, (v) => v === true, 15_000);
}
/** Presses a bubble button like a person (a mouse click at its centre, once it takes the press). */
const pressBubble = (testid: string) => click(m, tid(testid), { frame: "passportSuggest" });
/** Ticks the bubble's « Retenir … » box with one click on it. */
async function tickRemember(): Promise<void> {
  await pressBubble("passport-suggest-remember");
  await expect.poll(async () => (await decided())?.remember).toBe(true);
}
/** After « Ajouter »: its done text, then the bubble fades out on its own. */
async function doneThenGone(): Promise<string> {
  const text = await waitUi<string>(m, `return doc.querySelector('${tid("passport-suggest-done")}')?.textContent?.trim()`, [], 20_000, "passportSuggest");
  await gone();
  return text;
}
/** Positive control: a typed form sent in a fresh plain https tab does offer (the `forms`-th form focused in this test). */
async function control(forms: number): Promise<void> {
  await tab(`${server.url}/twice.html`);
  await typeForm("a-");
  await press("#a-send", forms);
  await submitted(forms);
  const offer = await oneOffer();
  for (const v of SHOWN) expect(offer.text).toContain(v);
}

type Written = PassportEntry & { how?: string; from?: string };
const passport = async (): Promise<Written[]> => (existsSync(join(profile!, "ressac", "passport", "default.json")) ? ((await readPassport(profile!)) as Written[]) : []);
/** Firefox's own address store: what it holds (Ressac never writes there). */
const firefoxAddresses = () => m.execute<unknown[]>(`return (async () => { const { formAutofillStorage } = ChromeUtils.importESModule("${STORAGE}"); await formAutofillStorage.initialize(); return formAutofillStorage.addresses.getAll(); })();`);
const noFirefoxPrompt = async () => {
  expect(await m.execute(`return !!PopupNotifications.getNotification("address-save-update", ${B})`)).toBe(false);
  expect(await firefoxAddresses()).toEqual([]);
  const file = join(profile!, "autofill-profiles.json");
  if (existsSync(file)) expect(readFileSync(file, "utf8")).not.toContain("Aubrac");
};

describe("passport suggestions from typed forms", () => {
  it("startup: Ressac's wrapper replaces Firefox's address capture, the capture pref is off, the actor answers", async () => {
    await start();
    expect(await m.execute(`return ChromeUtils.importESModule("${PARENT}").FormAutofillParent.prototype[${PATCHED}] === true`)).toBe(true);
    expect(await m.execute('return [Services.prefs.getBoolPref("extensions.formautofill.addresses.capture.enabled"), Services.prefs.getBoolPref("ressac.passport.suggest"), Services.prefs.getCharPref("ressac.passport.suggestMuted")]')).toEqual([false, true, ""]);
    expect(await m.execute('return typeof ChromeUtils.importESModule("chrome://browser/content/ressac/typed-actor.sys.mjs").RessacTypedParent')).toBe("function");
    await tab(`${server.url}/twice.html`);
    expect(await m.execute(`return ${B}.browsingContext.currentWindowGlobal.getActor("RessacTyped").sendQuery("typedValues")`)).toEqual([]);
  });

  it("a French form typed by keyboard and sent (POST, navigates): one Ressac bubble on the page with each value's kind, no Firefox prompt; gone at the next navigation", async () => {
    await start();
    await tab(`${server.url}/francais.html`);
    await typeKeys([["#p", ME.given], ["#n", ME.family], ["#a", ME.street], ["#cp", ME.postcode], ["#v", ME.city], ["#t", ME.tel], ["#e", ME.email]]);
    await press("#send");
    const [keys] = await submitted(1);
    await waitFor(m, `return ${B}.currentURI.spec === ${JSON.stringify(`${server.url}/merci`)} && !${B}.webProgress.isLoadingDocument`, (v) => v === true, 15_000);
    // The bubble outlives the send's navigation and is on screen, over the page.
    const offer = await oneOffer();
    // A single « Adresse » field read as address-line1 offers no address: said here, not passed over.
    for (const s of SHOWN) expect(offer.text, `Firefox read the form as ${keys!.join(", ")}; the bubble says « ${offer.text} »`).toContain(s);
    // Unticked by default, and the keyboard stays where the user was.
    expect(await inUi(m, `return doc.querySelector('${tid("passport-suggest-remember")}').checked`, [], "passportSuggest")).toBe(false);
    expect(await m.execute("return document.activeElement?.id ?? null")).not.toBe(FRAME);
    await noFirefoxPrompt();
    // A further navigation of the tab: gone.
    await m.execute(`${B}.loadURI(Services.io.newURI(arguments[0]), { triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({}) });`, [`${server.url}/twice.html`]);
    await gone();
  });

  it("« Ajouter »: Touch ID, then the passport holds the values as typed from a form, with no site; the same values sent again: no bubble", async () => {
    await start();
    await tab(`${server.url}/twice.html`);
    await typeForm("a-");
    await press("#a-send");
    await submitted(1);
    const offer = await oneOffer();
    for (const s of SHOWN) expect(offer.text).toContain(s);
    await pressBubble("passport-suggest-add");
    expect(await doneThenGone()).not.toBe("");
    await expect.poll(async () => (await passport()).map((e) => e.field).sort()).toEqual(["adresse", "email", "nom", "tel"]);
    const written = await passport();
    expect(written.every((e) => e.how === "form" && e.from === host && e.origins.length === 0)).toBe(true);
    expect(written.find((e) => e.field === "nom")!.value).toEqual({ given: "Camille", family: "Aubrac" });
    expect(written.find((e) => e.field === "adresse")!.value.text).toBe("14 rue des Tanneurs\n69001 Lyon");
    expect(written.find((e) => e.field === "tel")!.value.text!.replace(/\s/g, "")).toBe(PHONE.replace(/\s/g, ""));
    await noFirefoxPrompt();
    // Everything already in the passport: the second form of the same page, the same values, offers nothing.
    await typeForm("b-");
    await press("#b-send", 2);
    await submitted(2);
    expect(await decided()).toBeNull();
  });

  it("« Retenir » ticked: the entries name the site", async () => {
    await start();
    await tab(`${server.url}/twice.html`);
    await typeForm("a-");
    await press("#a-send");
    await submitted(1);
    await oneOffer();
    await tickRemember();
    await pressBubble("passport-suggest-add");
    await doneThenGone();
    await expect.poll(async () => (await passport()).length).toBe(4);
    expect((await passport()).map((e) => e.origins)).toEqual([[host], [host], [host], [host]]);
  });

  it("« Non »: nothing written; a second send in the same document offers nothing", async () => {
    await start();
    await tab(`${server.url}/twice.html`);
    await typeForm("a-");
    await press("#a-send");
    await submitted(1);
    await oneOffer();
    await pressBubble("passport-suggest-no");
    await gone();
    await typeForm("b-");
    await press("#b-send", 2);
    await submitted(2);
    expect(await decided()).toBeNull();
    expect(await passport()).toEqual([]);
  });

  it("✕ and Escape decline the document like « Non »", async () => {
    await start();
    await tab(`${server.url}/twice.html`);
    await typeForm("a-");
    await press("#a-send");
    await submitted(1);
    await oneOffer();
    // Reached by the keyboard (a button of the bubble focused), Escape answers « Non ».
    await inUi(m, `doc.querySelector('${tid("passport-suggest-add")}').focus();`, [], "passportSuggest");
    await waitUi(m, `return doc.activeElement?.dataset.testid === "passport-suggest-add" && doc.hasFocus()`, [], 10_000, "passportSuggest");
    await pressKeys(m, "Escape");
    await gone();
    await typeForm("b-");
    await press("#b-send", 2);
    await submitted(2);
    expect(await decided()).toBeNull();
    // ✕ on another document's bubble.
    await control(3);
    await pressBubble("passport-suggest-close");
    await gone();
    expect(await passport()).toEqual([]);
  });

  it("« Ne plus proposer ▾ › Sur ce site »: the site is muted, the next send offers nothing", async () => {
    await start();
    await tab(`${server.url}/twice.html`);
    await typeForm("a-");
    await press("#a-send");
    await submitted(1);
    await oneOffer();
    await pressBubble("passport-suggest-mute");
    await pressBubble("passport-suggest-mute-site");
    await waitFor(m, 'return Services.prefs.getCharPref("ressac.passport.suggestMuted", "")', (v) => v === host);
    await gone();
    await typeForm("b-");
    await press("#b-send", 2);
    await submitted(2);
    expect(await decided()).toBeNull();
    expect(await m.execute('return Services.prefs.getBoolPref("ressac.passport.suggest")')).toBe(true);
  });

  it("« Ne plus proposer ▾ › Nulle part »: suggestions switched off", async () => {
    await start();
    await tab(`${server.url}/twice.html`);
    await typeForm("a-");
    await press("#a-send");
    await submitted(1);
    await oneOffer();
    await pressBubble("passport-suggest-mute");
    await pressBubble("passport-suggest-mute-all");
    await waitFor(m, 'return Services.prefs.getBoolPref("ressac.passport.suggest")', (v) => v === false);
    await gone();
    expect(await m.execute('return Services.prefs.getCharPref("ressac.passport.suggestMuted", "")')).toBe("");
  });

  it("the bubble belongs to its tab: hidden while another tab is selected, back with its ticked box on its own", async () => {
    await start();
    const sent = await tab(`${server.url}/twice.html`);
    await typeForm("a-");
    await press("#a-send");
    await submitted(1);
    const first = await oneOffer();
    await tickRemember();
    await tab(`${server.url}/merci`);
    await gone();
    await dispatch(m, { type: "activateTab", id: sent });
    expect((await oneOffer()).values).toEqual(first.values);
    expect(await inUi(m, `return doc.querySelector('${tid("passport-suggest-remember")}').checked`, [], "passportSuggest")).toBe(true);
  });

  it("a page script fills the form (execCommand, then requestSubmit): Firefox captures it, no bubble; typed by the user, it offers", async () => {
    await start();
    await tab(`${server.url}/twice.html`);
    await inPage(
      'document.getElementById("a-given").focus();',
    );
    await identified(1);
    await inPage(
      `for (const [k, v] of Object.entries(arguments[0])) { const el = document.getElementById("a-" + k); el.focus(); document.execCommand("insertText", false, v); }
       document.getElementById("f1").requestSubmit();`,
      [ME],
    );
    const [keys] = await submitted(1);
    expect(keys).toContain("given-name");
    expect(await decided()).toBeNull();
    // Positive control: the same document's other form typed by keyboard.
    await typeForm("b-");
    await press("#b-send", 2);
    await submitted(2);
    for (const s of SHOWN) expect((await oneOffer()).text).toContain(s);
  });

  it("a typed field the page rewrites as it is sent: the page's text is never offered, what was typed is", async () => {
    await start();
    await tab(`${server.url}/reecrit.html`);
    await typeForm("a-");
    await press("#a-send");
    await submitted(1);
    const offer = await oneOffer();
    // Firefox reads the fields before the page's submit handler rewrites them (measured on 161): the typed name stays.
    expect(offer.text).toContain("Votre nom : Camille Aubrac");
    expect(offer.text).toContain("Adresse postale : 14 rue des Tanneurs, 69001 Lyon");
    expect(offer.text).not.toContain("Lucie");
  });

  it("execCommand into a field just left by Tab is not offered", async () => {
    await start();
    await tab(`${server.url}/tab.html`);
    // U+E004: WebDriver's Tab key.
    await typeKeys([["#a-given", `${ME.given}\uE004`]]);
    // The page's script ran on the Tab: the first name is its text now, focus on the family name. Else the case was not set up.
    await expect.poll(() => inPage<[string, string]>('return [document.getElementById("a-given").value, document.activeElement.id]')).toEqual(["Lucie Piège", "a-family"]);
    const { given: _g, ...rest } = ME;
    await typeKeys(Object.entries(rest).map(([k, text]) => [`#a-${k}`, text]));
    await press("#a-send");
    await submitted(1);
    const offer = await oneOffer();
    expect(offer.text).toContain("Adresse postale");
    expect(offer.text).not.toContain("Piège");
    expect(offer.text).not.toContain("Votre nom");
  });

  it("sent by fetch, the form then removed: still one bubble", async () => {
    await start();
    await tab(`${server.url}/fetch.html`);
    await typeForm("a-");
    await press("#a-send");
    await submitted(1);
    const offer = await oneOffer();
    for (const s of SHOWN) expect(offer.text).toContain(s);
  });

  it("shipping and billing in one form: one bubble with the new values of both", async () => {
    await start();
    await tab(`${server.url}/sections.html`);
    await typeForm("s-");
    await typeForm("b-", { ...ME, street: "3 place Bellecour", postcode: "69002" });
    await press("#send");
    await submitted(2);
    // Both sections are in by now (each is merged as it is handled).
    const offer = await oneOffer();
    expect(offer.text).toContain("Adresse postale : 14 rue des Tanneurs, 69001 Lyon");
    expect(offer.text).toContain("Adresse postale : 3 place Bellecour, 69002 Lyon");
    expect(offer.text.split("Votre nom").length - 1).toBe(1);
    expect(offer.text.split("E-mail").length - 1).toBe(1);
  });

  it("no bubble: an agent-reached tab", async () => {
    await start();
    await tab(`${server.url}/twice.html`, { agentReached: true });
    await typeForm("a-");
    await press("#a-send");
    await submitted(1);
    expect(await decided()).toBeNull();
    await control(2);
  });

  it("no bubble: a private space", async () => {
    await start();
    const s = await dispatch(m, { type: "createSpace", name: "Secret", icon: "🔒", private: true, profile: "default", windowId: (await state(m)).windows[0]!.id });
    await tab(`${server.url}/twice.html`, { spaceId: s.spaces.at(-1)!.id });
    await typeForm("a-");
    await press("#a-send");
    await submitted(1);
    expect(await decided()).toBeNull();
    // The control in a normal space.
    await dispatch(m, { type: "activateSpace", windowId: (await state(m)).windows[0]!.id, id: s.spaces[0]!.id });
    await control(2);
  });

  it("no bubble: an http page", async () => {
    await start();
    await tab(`${plain.url}/twice.html`);
    await typeForm("a-");
    await press("#a-send");
    await submitted(1);
    expect(await decided()).toBeNull();
    await control(2);
  });

  it("no bubble: a muted site", async () => {
    await start({ prefs: { "ressac.passport.suggestMuted": `other.example,${host}` } });
    await tab(`${server.url}/twice.html`);
    await typeForm("a-");
    await press("#a-send");
    await submitted(1);
    expect(await decided()).toBeNull();
    await m.execute('Services.prefs.setCharPref("ressac.passport.suggestMuted", "other.example");');
    await control(2);
  });

  it("no bubble: suggestions switched off", async () => {
    await start({ prefs: { "ressac.passport.suggest": false } });
    await tab(`${server.url}/twice.html`);
    await typeForm("a-");
    await press("#a-send");
    await submitted(1);
    expect(await decided()).toBeNull();
    await m.execute('Services.prefs.setBoolPref("ressac.passport.suggest", true);');
    await control(2);
  });

  it("Réglages › Passeport: the switch and the muted sites follow the prefs, and back", async () => {
    await start({ prefs: { "ressac.passport.suggestMuted": "a.example,b.example" } });
    const pref = (js: string) => m.execute(`return ${js}`);
    await click(m, tid("settings-button"));
    await click(m, tid("settings-nav-passport"));
    await waitUi(m, "return doc.querySelector(arguments[0])?.checked === true", [tid("passport-suggest-switch")]);
    await waitUi(m, "return doc.querySelector(arguments[0])?.textContent.includes('a.example')", [tid("passport-muted")]);
    await click(m, tid("passport-unmute-a.example"));
    await expect.poll(() => pref('Services.prefs.getCharPref("ressac.passport.suggestMuted", "")')).toBe("b.example");
    await waitUi(m, "return !doc.querySelector(arguments[0])", [tid("passport-unmute-a.example")]);
    await click(m, tid("passport-suggest-switch"));
    await expect.poll(() => pref('Services.prefs.getBoolPref("ressac.passport.suggest")')).toBe(false);
    await click(m, tid("passport-suggest-switch"));
    await expect.poll(() => pref('Services.prefs.getBoolPref("ressac.passport.suggest")')).toBe(true);
    // Changed elsewhere (the bubble's « Ne plus proposer »): the section shows it when opened again.
    await m.execute('Services.prefs.setBoolPref("ressac.passport.suggest", false); Services.prefs.setCharPref("ressac.passport.suggestMuted", "b.example,c.example");');
    await click(m, tid("settings-nav-privacy"));
    await click(m, tid("settings-nav-passport"));
    await waitUi(m, "return doc.querySelector(arguments[0])?.checked === false", [tid("passport-suggest-switch")]);
    await waitUi(m, "return doc.querySelector(arguments[0])?.textContent.includes('c.example')", [tid("passport-muted")]);
    expect(await inUi(m, "return doc.querySelector(arguments[0]).textContent.includes('a.example')", [tid("passport-muted")])).toBe(false);
  });
});
