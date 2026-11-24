import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, missingApi, waitUi } from "./ui";

// Réglages › Mots de passe: Firefox's saved logins, Touch ID through RESSAC_TEST_REAUTH, a short « Afficher » through
// RESSAC_TEST_PASSPORT_TIMES (the passport's seam, shared). Passwords are obviously fake.

let w: LaunchedRessac | undefined;
let m: Marionette;
afterEach(async () => {
  try {
    if (w) expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
    w = undefined;
  }
});

async function launch(reauth: "pass" | "fail", logins: [string, string, string][]) {
  w = await launchRessac({ profile: mkdtempSync(join(tmpdir(), "ressac-firefox-")), env: { RESSAC_TEST_REAUTH: reauth, RESSAC_TEST_PASSPORT_TIMES: "600000,1500" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await m.execute(
    `return (async () => {
      for (const [origin, username, password] of arguments[0]) {
        const l = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
        l.init(origin, origin, null, username, password, "", "");
        await Services.logins.addLoginAsync(l);
      }
    })();`,
    [logins],
  );
}
/** The saved logins of one origin, as Firefox has them. */
const saved = (origin: string) =>
  m.execute<{ username: string; password: string }[]>(
    "return Services.logins.searchLoginsAsync({ origin: arguments[0] }).then((l) => l.map(({ username, password }) => ({ username, password })));",
    [origin],
  );
const clipboardText = () =>
  m.execute<string>(`const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
    t.init(null); t.addDataFlavor("text/plain");
    Services.clipboard.getData(t, Ci.nsIClipboard.kGlobalClipboard, window.browsingContext.currentWindowContext);
    const o = {}; try { t.getTransferData("text/plain", o); } catch { return ""; }
    return o.value.QueryInterface(Ci.nsISupportsString).data;`);

const tid = (id: string) => `[data-testid="${id}"]`;
const row = (host: string) => `${tid("password-row")}[data-host="${host}"]`;
const has = (sel: string, ms = 10_000) => waitUi(m, "return !!doc.querySelector(arguments[0])", [sel], ms);
const gone = (sel: string, ms = 10_000) => waitUi(m, "return !doc.querySelector(arguments[0])", [sel], ms);
const textOf = (sel: string) => inUi<string>(m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ') ?? ''", [sel]);
const shows = (sel: string, wanted: string, ms = 10_000) =>
  waitUi(m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ').includes(arguments[1])", [sel, wanted], ms);
const hosts = () => inUi<string[]>(m, "return [...doc.querySelectorAll(arguments[0])].map((r) => r.dataset.host)", [tid("password-row")]);
/** Sets a field as typing would (an input event). */
const fill = (sel: string, value: string) =>
  inUi(m, "const el = doc.querySelector(arguments[0]); el.focus(); el.value = arguments[1]; el.dispatchEvent(new ui.Event('input', { bubbles: true }));", [sel, value]);
async function openPasswords() {
  await click(m, tid("settings-button"));
  await has(tid("settings-page"));
  await click(m, tid("settings-nav-passwords"));
  await has(tid("settings-passwords"));
}

describe("Réglages › Mots de passe", () => {
  it("lists, searches, shows, copies, adds, edits and deletes Firefox's saved logins", { timeout: 120_000 }, async () => {
    await launch("pass", [
      ["https://alpha.test", "camille", "mot-de-passe-test-1"],
      ["https://zeta.test", "aubrac", "mot-de-passe-test-2"],
    ]);
    await openPasswords();
    await waitUi(m, "return doc.querySelectorAll(arguments[0]).length === 2", [tid("password-row")]);
    expect(await hosts()).toEqual(["alpha.test", "zeta.test"]);
    const listed = await textOf(tid("settings-passwords"));
    expect(listed).toContain("camille");
    expect(listed).toContain("aubrac");
    expect(listed).toContain("Vos mots de passe sont communs à tous vos espaces.");
    expect(listed).not.toContain("mot-de-passe-test");

    // Search by host, then by username.
    await fill(tid("passwords-search"), "zeta");
    await waitUi(m, "return doc.querySelectorAll(arguments[0]).length === 1", [tid("password-row")]);
    expect(await hosts()).toEqual(["zeta.test"]);
    await fill(tid("passwords-search"), "CAMILLE");
    await waitUi(m, "return doc.querySelectorAll(arguments[0]).length === 1", [tid("password-row")]);
    expect(await hosts()).toEqual(["alpha.test"]);
    await fill(tid("passwords-search"), "");
    await waitUi(m, "return doc.querySelectorAll(arguments[0]).length === 2", [tid("password-row")]);

    // « Afficher »: the one password, hidden again after the test's 1.5 s.
    await click(m, `${row("alpha.test")} ${tid("password-show")}`);
    await shows(`${row("alpha.test")} ${tid("password-shown")}`, "mot-de-passe-test-1");
    expect(await textOf(row("zeta.test"))).not.toContain("mot-de-passe-test");
    await gone(tid("password-shown"));

    // « Copier »: the clipboard holds it.
    await click(m, `${row("zeta.test")} ${tid("password-copy")}`);
    await expect.poll(clipboardText, { timeout: 10_000 }).toBe("mot-de-passe-test-2");
    await shows(tid("passwords-notice"), "Copié");

    // Add, then the same again: refused as a duplicate, nothing more stored.
    await click(m, tid("passwords-add"));
    await has(tid("passwords-add-form"));
    await fill(tid("passwords-add-site"), "https://exemple.test");
    await fill(tid("passwords-add-username"), "camille");
    await fill(tid("passwords-add-password"), "mot-de-passe-test-1");
    await click(m, tid("passwords-add-save"));
    await has(row("exemple.test"));
    await gone(tid("passwords-add-form"));
    expect(await saved("https://exemple.test")).toEqual([{ username: "camille", password: "mot-de-passe-test-1" }]);
    await click(m, tid("passwords-add"));
    await fill(tid("passwords-add-site"), "exemple.test/connexion");
    await fill(tid("passwords-add-username"), "camille");
    await fill(tid("passwords-add-password"), "mot-de-passe-test-3");
    await click(m, tid("passwords-add-save"));
    await shows(tid("passwords-add-error"), "Un mot de passe existe déjà pour cet identifiant sur ce site.");
    expect(await saved("https://exemple.test")).toEqual([{ username: "camille", password: "mot-de-passe-test-1" }]);
    await click(m, tid("passwords-add-cancel"));
    await gone(tid("passwords-add-form"));

    // Edit its password.
    await click(m, `${row("exemple.test")} ${tid("password-edit")}`);
    await has(tid("password-editor"));
    await fill(tid("password-edit-password"), "mot-de-passe-test-5");
    await click(m, tid("password-edit-save"));
    await gone(tid("password-editor"));
    await expect.poll(() => saved("https://exemple.test"), { timeout: 10_000 }).toEqual([{ username: "camille", password: "mot-de-passe-test-5" }]);

    // Delete, after the confirmation in the row.
    await click(m, `${row("exemple.test")} ${tid("password-delete")}`);
    await shows(tid("password-delete-confirm"), "Supprimer le mot de passe de camille pour exemple.test ?");
    await click(m, tid("password-delete-yes"));
    await gone(row("exemple.test"));
    expect(await saved("https://exemple.test")).toEqual([]);
    expect(await hosts()).toEqual(["alpha.test", "zeta.test"]);
  });

  it("Touch ID refused: « Afficher » says so and shows nothing", { timeout: 60_000 }, async () => {
    await launch("fail", [["https://alpha.test", "camille", "mot-de-passe-test-1"]]);
    await openPasswords();
    await has(row("alpha.test"));
    await click(m, `${row("alpha.test")} ${tid("password-show")}`);
    await shows(tid("passwords-notice"), "Touch ID refusé : rien n'a changé.");
    // The refusal is the answer: nothing can come after it.
    expect(await inUi(m, "return !!doc.querySelector(arguments[0])", [tid("password-shown")])).toBe(false);
    expect(await textOf(tid("settings-passwords"))).not.toContain("mot-de-passe-test");
    // Nor through the API: no token without Touch ID.
    expect(await inUi(m, "return ui.ressac.settings.passwords.unlock()")).toBeNull();
  });
});
