import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { callMcpTool } from "../test/mcp";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, missingApi, pressKeys, startAgentSession, waitUi } from "./ui";

// Réglages › Passeport (design § 9.2-9.3, § 10.2): Touch ID through RESSAC_TEST_REAUTH, the memory cipher (its key is
// SHA-256 of « ressac-passport-dev-key », as chrome/passport/cipher.ts), short times through RESSAC_TEST_PASSPORT_TIMES.

const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const KEY = createHash("sha256").update("ressac-passport-dev-key").digest();
// Secret-shaped values are built from parts at run time (global constraints).
const ibanOf = (bban: string) => {
  const n = (bban + "FR00").replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  const check = 98 - Number([...n].reduce((r, d) => (r * 10n + BigInt(d)) % 97n, 0n));
  return `FR${String(check).padStart(2, "0")}${bban}`;
};
const IBAN = ibanOf(["30006", "00001", "12345678901", "89"].join(""));
const secuOf = (head: string) => head + String(97 - Number(BigInt(head) % 97n)).padStart(2, "0");
const SECU = secuOf(["1", "90", "03", "44", "109", "123"].join(""));
const FAMILY = ["Fon", "taine"].join("");
const PHONE = ["06", "12", "34", "56", "78"].join(" ");

const html = (res: ServerResponse, body: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
// `/compte/` makes the page sensitive: a masking source once reached (e2e/masking-visits.e2e.ts).
const routes = { "/compte/releve.html": (_req: unknown, res: ServerResponse) => html(res, "<title>Relevé</title><p>Solde du compte</p>") };

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac | undefined;
let m: Marionette;
beforeAll(async () => (server = await startServer({ routes })));
afterAll(() => server?.close());
afterEach(async () => {
  try {
    if (w) expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
    w = undefined;
  }
});

/** A passport file the memory cipher reads (chrome/passport/store.ts format), written before the launch. */
function writePassport(profileDir: string, profile: string, entries: object[]) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", KEY, iv);
  const out = Buffer.concat([c.update(JSON.stringify({ version: 1, entries })), c.final(), c.getAuthTag()]);
  const dir = join(profileDir, "ressac", "passport");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${profile}.json`), JSON.stringify({ format: "ressac-passport", version: 1, profile, cipher: `${iv.toString("base64")}.${out.toString("base64")}` }));
}
/** The entries of a passport file, decrypted with the memory key. */
function readPassport(profile: string): { id: string; field: string; value: Record<string, string>; variants: string[]; origins: string[] }[] {
  const file = join(w!.profile, "ressac", "passport", `${profile}.json`);
  if (!existsSync(file)) return [];
  const [iv, data] = JSON.parse(readFileSync(file, "utf8")).cipher.split(".").map((p: string) => Buffer.from(p, "base64"));
  const d = createDecipheriv("aes-256-gcm", KEY, iv);
  d.setAuthTag(data.subarray(-16));
  return JSON.parse(Buffer.concat([d.update(data.subarray(0, -16)), d.final()]).toString()).entries;
}
const entry = (id: string, field: string, value: object, more: object = {}) => ({ id, field, value, variants: [], origins: [], how: "typed", created: "2026-11-23T00:00:00.000Z", updated: "2026-11-23T00:00:00.000Z", ...more });

async function launch(o: { reauth?: "pass" | "fail"; cipher?: "memory" | "absent"; times?: string; files?: Record<string, object[]>; env?: Record<string, string> } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "ressac-firefox-"));
  for (const [p, entries] of Object.entries(o.files ?? {})) writePassport(profile, p, entries);
  w = await launchRessac({
    profile,
    env: { RESSAC_TEST_REAUTH: o.reauth ?? "pass", RESSAC_TEST_PASSPORT_CIPHER: o.cipher ?? "memory", RESSAC_TEST_PASSPORT_TIMES: o.times ?? "600000,1500", ...o.env },
  });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
}
const has = (sel: string, ms = 10_000) => waitUi(m, "return !!doc.querySelector(arguments[0])", [sel], ms);
const gone = (sel: string, ms = 10_000) => waitUi(m, "return !doc.querySelector(arguments[0])", [sel], ms);
const tid = (id: string) => `[data-testid="${id}"]`;
const shows = (id: string, wanted: string, ms = 10_000) =>
  waitUi(m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ').includes(arguments[1])", [tid(id), wanted], ms);
const textOf = (sel: string) => inUi<string>(m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ') ?? ''", [sel]);
async function openPassport() {
  await click(m, tid("settings-button"));
  await has(tid("settings-page"));
  await click(m, tid("settings-nav-passport"));
  await has(tid("settings-passport"));
}
async function unlock() {
  await click(m, tid("passport-unlock"));
  await has(tid("passport-open"));
}
/** Sets a field as typing would (an input event), for the values the key synthesizer cannot type (« @ », a date). */
const fill = (sel: string, value: string) =>
  inUi(m, "const el = doc.querySelector(arguments[0]); el.focus(); el.value = arguments[1]; el.dispatchEvent(new ui.Event('input', { bubbles: true }));", [sel, value]);
const chooseType = (field: string) =>
  inUi(m, "const el = doc.querySelector(arguments[0]); el.value = arguments[1]; el.dispatchEvent(new ui.Event('change', { bubbles: true }));", [tid("passport-type"), field]);
/** Picks a passport profile in the switch, as a choice in the list would (a change event). */
const chooseProfile = (profile: string) =>
  inUi(m, "const el = doc.querySelector(arguments[0]); el.value = arguments[1]; el.dispatchEvent(new ui.Event('change', { bubbles: true }));", [tid("passport-profiles"), profile]);
const saveEnabled = (on: boolean) => waitUi(m, "return doc.querySelector(arguments[0])?.disabled === arguments[1]", [tid("passport-save"), !on]);

describe("Réglages › Passeport", () => {
  it("an empty passport: locked and said empty; Touch ID refused stays locked", async () => {
    await launch({ reauth: "fail" });
    await openPassport();
    await shows("passport-locked", "Passeport « Perso » vide");
    expect(await inUi(m, "return ui.ressac.settings.passport.unlock('default')")).toBeNull();
    await click(m, tid("passport-unlock"));
    // The press disables the button until Touch ID answers (set in the click handler, before click() returns):
    // re-armed means the refusal came back.
    await waitUi(m, "return doc.querySelector(arguments[0])?.disabled === false", [tid("passport-unlock")]);
    // A short window after that answer: nothing may open the passport late from it.
    await new Promise((r) => setTimeout(r, 500));
    await has(tid("passport-locked"));
    expect(await inUi(m, "return !!doc.querySelector(arguments[0])", [tid("passport-open")])).toBe(false);
  });

  it("first run: unlocked, the welcome's three shortcuts; « Ajouter mon nom » opens the name editor", async () => {
    await launch();
    await openPassport();
    await unlock();
    await shows("passport-countdown", "Déverrouillé · se reverrouille dans");
    await shows("passport-welcome", "Votre passeport est vide.");
    await click(m, tid("passport-add-name"));
    await has(tid("passport-given"));
    await has(tid("passport-family"));
  });

  it("adds each type, a validation error first; the file holds them and no value in clear", async () => {
    await launch();
    await openPassport();
    await unlock();
    const cases: { field: string; bad: string; error: string; good: string; masked: string }[] = [
      { field: "naissance", bad: "2999-01-01", error: "Une date passée, s'il vous plaît.", good: "1990-03-14", masked: "••/••/••••" },
      { field: "adresse", bad: "rue des Tilleuls", error: "Indiquez au moins un numéro et une rue.", good: "12 rue des Tilleuls\n44000 Nantes", masked: "r•• d•• T•••••••" },
      { field: "tel", bad: "06 12", error: "10 chiffres, ou +33 …", good: PHONE.replace(/ /g, ""), masked: "•••• 56 78" },
      { field: "email", bad: "camille@", error: "Adresse incomplète", good: "camille@exemple.fr", masked: "c••••••@exemple.fr" },
      { field: "iban", bad: IBAN.slice(0, 10), error: "IBAN incomplet", good: IBAN, masked: `•••• ${IBAN.slice(-4, -2)} ${IBAN.slice(-2)}` },
      { field: "piece", bad: "X4R", error: "De 6 à 20 lettres ou chiffres.", good: "X4RTBPFW4", masked: "•••• PF W4" },
      { field: "secu", bad: SECU.slice(0, 13) + "00", error: "La clé ne correspond pas.", good: SECU, masked: `•••• ${SECU.slice(-4, -2)} ${SECU.slice(-2)}` },
      { field: "plaque", bad: "AB-12", error: "Format AB-123-CD", good: "AB-123-CD", masked: "•••• 23 CD" },
      { field: "libre", bad: "1234 €", error: "dont une lettre", good: "Dossier Morel", masked: "D•••••• M••••" },
    ];
    for (const c of cases) {
      await click(m, tid("passport-add"));
      await has(tid("passport-type"));
      await chooseType(c.field);
      await fill(tid("passport-value"), c.bad);
      await shows("passport-hint", c.error);
      await saveEnabled(false);
      await fill(tid("passport-value"), c.good);
      await saveEnabled(true);
      await click(m, tid("passport-save"));
      await gone(tid("passport-editor"));
      await shows(`passport-row-${c.field}`, c.masked);
    }
    // The name: two inputs, a refused first try (no family name).
    await click(m, tid("passport-add"));
    await chooseType("nom");
    await fill(tid("passport-given"), "Camille");
    await shows("passport-hint", "Indiquez un prénom et un nom.");
    await saveEnabled(false);
    await fill(tid("passport-family"), FAMILY);
    await saveEnabled(true);
    await pressKeys(m, "Enter");
    await shows("passport-row-nom", "C•••••• F•••••••");
    await shows("passport-row-nom", "L'agent voit ⟨nom-…⟩");
    await shows("passport-saved", "Enregistré.");
    const saved = readPassport("default");
    expect(saved.map((e) => e.field).sort()).toEqual([...cases.map((c) => c.field), "nom"].sort());
    expect(readFileSync(join(w!.profile, "ressac", "passport", "default.json"), "utf8")).not.toContain(FAMILY);
  });

  it("« Voir » shows the value, then it is masked again", async () => {
    // « Voir » lasts 8 s here: long enough to see the shown value on a loaded Mac.
    await launch({ times: "600000,8000", files: { default: [entry("a1", "tel", { text: PHONE })] } });
    await openPassport();
    await unlock();
    await shows("passport-row-tel", "•••• 56 78");
    await click(m, tid("passport-see"));
    await shows("passport-row-tel", PHONE);
    await shows("passport-see", "Masquer");
    // Then, on its own, the final state: the masked value again.
    await waitUi(m, "const v = doc.querySelector(arguments[0]); return v && !v.textContent.includes('06 12') && v.textContent.includes('•••• 56 78')", [tid("passport-row-tel")], 20_000);
    await shows("passport-see", "Voir");
  });

  it("edits an entry, then deletes it after the inline confirmation (Garder keeps it)", async () => {
    await launch({ files: { default: [entry("a1", "tel", { text: PHONE }), entry("a2", "email", { text: "camille@exemple.fr" })] } });
    await openPassport();
    await unlock();
    await click(m, `${tid("passport-row-tel")} ${tid("passport-edit")}`);
    await shows("passport-editor", "Modifier « Téléphone »");
    await fill(tid("passport-value"), "0712345678");
    await click(m, tid("passport-save"));
    await shows("passport-row-tel", "•••• 56 78");
    await expect.poll(() => readPassport("default").find((e) => e.id === "a1")?.value.text).toBe("07 12 34 56 78");
    await click(m, `${tid("passport-row-email")} ${tid("passport-edit")}`);
    // The phone's editor may still be fading out, its own « Supprimer » first in the page: only the e-mail's is pressed.
    await waitUi(m, "return doc.querySelectorAll(arguments[0]).length === 1", [tid("passport-editor")]);
    await click(m, tid("passport-delete"));
    await shows("passport-delete-confirm", "Supprimer « E-mail » ? L'agent pourra de nouveau lire cette valeur");
    await click(m, tid("passport-keep"));
    await gone(tid("passport-delete-confirm"));
    await click(m, tid("passport-delete"));
    await click(m, tid("passport-delete-yes"));
    await gone(tid("passport-row-email"));
    await expect.poll(() => readPassport("default").map((e) => e.id)).toEqual(["a1"]);
  });

  it("chips: Enter and comma add, Backspace removes, a bad host is refused with its reason", async () => {
    await launch({ files: { default: [entry("a1", "adresse", { text: "12 rue des Tilleuls" })] } });
    await openPassport();
    await unlock();
    await click(m, `${tid("passport-row-adresse")} ${tid("passport-edit")}`);
    const chips = (kind: string) => inUi<string[]>(m, "return [...doc.querySelectorAll(arguments[0] + ' .chip')].map((c) => c.firstChild.textContent)", [tid(`passport-${kind}`)]);
    // fill() focuses the input, then the keys are real.
    await fill(tid("passport-origins-input"), "https://impots.gouv.fr/page");
    await pressKeys(m, "Enter");
    await fill(tid("passport-origins-input"), "ameli.fr");
    await pressKeys(m, ",");
    await expect.poll(() => chips("origins")).toEqual(["impots.gouv.fr", "ameli.fr"]);
    await fill(tid("passport-origins-input"), "pas un site");
    await pressKeys(m, "Enter");
    await shows("passport-origins-hint", "Ce site n'a pas l'air d'une adresse valide.");
    await fill(tid("passport-origins-input"), "");
    await pressKeys(m, "Backspace");
    await expect.poll(() => chips("origins")).toEqual(["impots.gouv.fr"]);
    await fill(tid("passport-variants-input"), "12 r des Tilleuls");
    await pressKeys(m, "Enter");
    await expect.poll(() => chips("variants")).toEqual(["12 r des Tilleuls"]);
    await click(m, tid("passport-save"));
    await shows("passport-row-adresse", "Remplissable sur : impots.gouv.fr");
    await shows("passport-row-adresse", "· aussi « 12 r des Tilleuls »");
    await expect.poll(() => readPassport("default")[0]?.origins).toEqual(["impots.gouv.fr"]);
  });

  it("the profile switch: each profile its own passport; switching locks the one open", async () => {
    await launch({ files: { default: [entry("a1", "tel", { text: PHONE })] } });
    const id = (await state(m)).windows[0]!.id;
    const s = await dispatch(m, { type: "createSpace", name: "Travail", icon: "💼", private: false, profile: "new", windowId: id });
    const work = s.spaces.find((x) => x.name === "Travail")!.profile;
    await openPassport();
    await has(tid(`passport-profile-${work}`));
    await unlock();
    await chooseProfile(work);
    await shows("passport-locked", "Passeport « Travail » vide");
    await chooseProfile("default");
    await shows("passport-locked", "Passeport « Perso » verrouillé");
  });

  it("relocks on the timer; an open editor is discarded and said, nothing saved", async () => {
    await launch({ times: "8000,1500", files: { default: [entry("a1", "tel", { text: PHONE })] } });
    await openPassport();
    await unlock();
    await click(m, tid("passport-edit"));
    await fill(tid("passport-value"), "0712345678");
    await has(tid("passport-locked"), 20_000);
    await shows("passport-notice", "Verrouillé : vos modifications non enregistrées ont été abandonnées.");
    expect(readPassport("default")[0]!.value.text).toBe(PHONE);
    await unlock();
    await gone(tid("passport-notice"));
  });

  it("relocks on leaving the section: the editor is discarded and said, and chrome revoked the page's token", async () => {
    // A long unlock: only leaving the section can lock it here.
    await launch({ files: { default: [entry("a1", "tel", { text: PHONE })] } });
    await click(m, tid("settings-button"));
    await has(tid("settings-page"));
    // The page's API records the token it gets (the component reads the same object once mounted).
    await inUi(m, "const p = ui.ressac.settings.passport; const unlock = p.unlock; p.unlock = async (id) => { const u = await unlock(id); ui.passportToken = u?.token; return u; };");
    await click(m, tid("settings-nav-passport"));
    await unlock();
    expect(await inUi(m, "return !!(await ui.ressac.settings.passport.read('default', ui.passportToken))")).toBe(true);
    await click(m, tid("passport-edit"));
    await click(m, tid("settings-nav-privacy"));
    await has(tid("settings-privacy"));
    // Wait for the final state: chrome revoked the token (read answers null).
    await waitUi(m, "return (await ui.ressac.settings.passport.read('default', ui.passportToken)) === null");
    await click(m, tid("settings-nav-passport"));
    await has(tid("passport-locked"));
    await shows("passport-notice", "Verrouillé : vos modifications non enregistrées ont été abandonnées.");
  });

  it("Review Focus 2: a save from a stale passport is refused, the other window's entry stays, the draft too", async () => {
    await launch({ files: { default: [entry("a1", "tel", { text: PHONE })] } });
    await openPassport();
    await unlock();
    // Another page saves first, from its own Touch ID.
    await m.execute(
      `return (async () => {
        const p = (await ChromeUtils.importESModule("${STORE}").ready).passport;
        const u = await p.unlock("default", "test");
        const r = await p.read("default", u.token);
        return p.save("default", u.token, [...r.entries, arguments[0]], r.revision);
      })();`,
      [entry("b1", "email", { text: "camille@exemple.fr" })],
    );
    await expect.poll(() => readPassport("default").map((e) => e.id)).toEqual(["a1", "b1"]);
    await click(m, tid("passport-add"));
    await chooseType("piece");
    await fill(tid("passport-value"), "X4RTBPFW4");
    await click(m, tid("passport-save"));
    await shows("passport-error", "Ce passeport a changé dans une autre fenêtre : rouvrez-le.");
    await has(tid("passport-editor"));
    expect(readPassport("default").map((e) => e.id)).toEqual(["a1", "b1"]);
  });

  it("« non couverte »: an entry added while a conversation has read a page marks it; one that read nothing stays covered", async () => {
    await launch({ env: { RESSAC_TEST_PUBLIC_ADDRESSES: "127.0.0.1" } });
    // Started before the web tab opens: a panel opened on one pre-fills its title and address, Ressac's own text masked
    // with the session's table, which counts as read (ruling F30).
    await startAgentSession(m);
    const url = `${server.url}/compte/releve.html`;
    const before = new Set(Object.keys((await state(m)).tabs));
    const s = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url, agentReached: false });
    await waitFor(m, `return gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec === ${JSON.stringify(url)} && !t.linkedBrowser.webProgress.isLoadingDocument)`, (v) => v === true, 15_000);
    const tab = Object.keys(s.tabs).find((x) => !before.has(x))!;
    const addLibre = async (text: string) => {
      await click(m, tid("passport-add"));
      await chooseType("libre");
      await fill(tid("passport-value"), text);
      await click(m, tid("passport-save"));
      await has(tid("passport-saved"));
    };
    // Nothing read yet: saved, nothing marked.
    await openPassport();
    await unlock();
    await addLibre("Dossier Morel");
    expect(await textOf(tid("passport-saved"))).not.toContain("non couverte");
    // Back on the tab (its access card shows there), the conversation reads it.
    await dispatch(m, { type: "activateTab", id: tab });
    const folder = join(w!.dataDir, "workspace", ".ressac", "sessions");
    const config = join(folder, readdirSync(folder).find((f) => f.endsWith(".json"))!);
    let done = false;
    const read = callMcpTool(join(w!.dataDir, "workspace"), "read_tab", { id: tab }, config).finally(() => (done = true));
    while (!done) {
      const allow = await inUi<boolean>(m, "return [...doc.querySelectorAll('[data-testid=\"permission-request\"] button')].some((b) => /^Autoriser/.test(b.textContent.trim()))");
      // The card may fall between the look and the press (the call answered): looked at again on the next turn.
      if (allow) await click(m, '[data-testid="permission-request"] button', { text: "Autoriser" }).catch(() => {});
      else await new Promise((r) => setTimeout(r, 100));
    }
    expect((await read).error).toBe(false);
    // Then an entry is added: the conversation that read the page is marked, the editor says so.
    await openPassport();
    await unlock();
    await addLibre("Projet Aubrac");
    await shows("passport-uncovered", "1 conversation(s) de l'agent ouverte(s) ont pu lire cette donnée en clair avant son ajout");
    await click(m, tid("agent-button"));
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"agent-mask-uncovered-passport\"]')", [], 15_000, "agent");
  });

  it("a passport no space uses: « Sans espace », still listed; « Déplacer vers… » merges it into Perso and removes it", async () => {
    const tel = entry("a1", "tel", { text: PHONE });
    await launch({ files: { gone: [tel, entry("b1", "libre", { text: "Dossier Morel" })], default: [entry("a1", "libre", { text: "Projet Aubrac" })] } });
    await openPassport();
    await shows("passport-profile-gone", "Sans espace");
    await chooseProfile("gone");
    await shows("passport-kept", "Ce passeport n'appartient plus à aucun espace. Il masque toujours ses données.");
    await click(m, tid("passport-move"));
    await shows("passport-move-to-default", "Perso");
    await click(m, tid("passport-move-to-default"));
    await shows("passport-notice", "Passeport déplacé.");
    await gone(tid("passport-profile-gone"));
    expect(existsSync(join(w!.profile, "ressac", "passport", "gone.json"))).toBe(false);
    // The clashing id « a1 » was renewed: both values are in Perso.
    expect(readPassport("default").map((e) => e.value.text).sort()).toEqual([PHONE, "Dossier Morel", "Projet Aubrac"]);
  });

  it("« Supprimer ce passeport » on a space's passport: Touch ID, then the confirmation; the file and its set-aside copies go", async () => {
    const profile = mkdtempSync(join(tmpdir(), "ressac-firefox-"));
    writePassport(profile, "default", [entry("a1", "libre", { text: "Projet Aubrac" }), entry("b1", "libre", { text: "Dossier Morel" })]);
    writeFileSync(join(profile, "ressac", "passport", "default.illisible-1.json"), "{}");
    w = await launchRessac({ profile, env: { RESSAC_TEST_REAUTH: "pass", RESSAC_TEST_PASSPORT_CIPHER: "memory", RESSAC_TEST_PASSPORT_TIMES: "600000,1500" } });
    m = w.marionette;
    await m.setContext("chrome");
    await waitReady(m);
    await openPassport();
    await click(m, tid("passport-remove"));
    await shows("passport-remove-confirm", "Supprimer ce passeport et ses 2 données ? L'agent pourra de nouveau les lire là où elles s'affichent.");
    // « Garder »: nothing removed.
    await click(m, tid("passport-remove-keep"));
    await gone(tid("passport-remove-confirm"));
    expect(readdirSync(join(profile, "ressac", "passport")).sort()).toEqual(["default.illisible-1.json", "default.json"]);
    await click(m, tid("passport-remove"));
    await click(m, tid("passport-remove-yes"));
    await shows("passport-notice", "Passeport supprimé.");
    expect(readdirSync(join(profile, "ressac", "passport"))).toEqual([]);
    // The profile stays (its space does), its passport now empty.
    await shows("passport-locked", "Passeport « Perso » vide");
  });

  it("« Supprimer ce passeport » with Touch ID refused: no confirmation, nothing removed", async () => {
    await launch({ reauth: "fail", files: { default: [entry("a1", "libre", { text: "Projet Aubrac" })] } });
    await openPassport();
    await click(m, tid("passport-remove"));
    // Re-armed means the refusal came back (disabled from the press until Touch ID answers).
    await waitUi(m, "return doc.querySelector(arguments[0])?.disabled === false", [tid("passport-remove")]);
    // A short window after that answer: no confirmation may show late from it.
    await new Promise((r) => setTimeout(r, 500));
    expect(await inUi(m, "return !!doc.querySelector(arguments[0])", [tid("passport-remove-confirm")])).toBe(false);
    expect(readPassport("default")).toHaveLength(1);
  });

  it("an unreadable passport: its text in Réglages; the agent panel's banner opens it", async () => {
    await launch({ cipher: "absent", files: { default: [entry("a1", "tel", { text: PHONE })] } });
    await click(m, tid("agent-button"));
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"agent-mask-passport-unreadable\"]')", [], 20_000, "agent");
    await click(m, tid("agent-mask-passport-open"), { frame: "agent" });
    await has(tid("settings-passport"));
    await shows("passport-unreadable", "Ce passeport ne peut plus être déchiffré");
  });

  it("« Recommencer un passeport vide » on an unreadable passport: Touch ID, the confirmation; the old file is kept aside, the passport empty", async () => {
    await launch({ cipher: "absent", files: { default: [entry("a1", "tel", { text: PHONE })] } });
    const dir = join(w!.profile, "ressac", "passport");
    const bytes = readFileSync(join(dir, "default.json"), "utf8");
    await openPassport();
    await shows("passport-unreadable", "Ce passeport ne peut plus être déchiffré");
    await click(m, tid("passport-restart"));
    await shows("passport-restart-confirm", "L'ancien fichier sera gardé à côté, mais Ressac ne pourra plus le lire. Recommencer ?");
    // « Garder »: nothing moved.
    await click(m, tid("passport-restart-keep"));
    await gone(tid("passport-restart-confirm"));
    expect(readdirSync(dir)).toEqual(["default.json"]);
    await click(m, tid("passport-restart"));
    await click(m, tid("passport-restart-yes"));
    await shows("passport-locked", "Passeport « Perso » vide");
    const left = readdirSync(dir);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^default\.illisible-\d{4}-\d{2}-\d{2}\.json$/);
    expect(readFileSync(join(dir, left[0]!), "utf8")).toBe(bytes);
    // An empty passport offers no restart (only an unreadable one does).
    expect(await inUi(m, "return !!doc.querySelector(arguments[0])", [tid("passport-restart")])).toBe(false);
  });
});
