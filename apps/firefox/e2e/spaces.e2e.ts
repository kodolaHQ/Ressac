import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Action } from "../shared/api";
import type { Space } from "../shared/model";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, missingApi, pressKeys, waitUi } from "./ui";

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
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"barre-laterale\"]')");
});
afterEach(async () => {
  try {
    expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
  }
});

const spaces = async () => (await state(m)).espaces;
const windowId = async () => (await state(m)).fenetres[0]!.id;
async function create(name: string, icon: string, isPrivate: boolean, profile: string): Promise<Space> {
  await dispatch(m, { type: "creerEspace", nom: name, icone: icon, prive: isPrivate, profil: profile, fenetreId: await windowId() } as Action);
  return (await spaces()).find((e) => e.nom === name)!;
}
const button = (id: string) => `[data-testid="espace-${id}"]`;
const MODAL = '[data-testid="modale-espace"]';
const modalOpen = (title: string) => waitUi(m, "return doc.querySelector(arguments[0] + ' h2')?.textContent === arguments[1]", [MODAL, title]);
const modalClosed = () => waitUi(m, "return !doc.querySelector(arguments[0])", [MODAL]);
/** The modal's fields, as shown. */
const fields = () =>
  inUi<{ icon: string; name: string; private: boolean; options: string[]; chosen: string; firstDisabled: boolean; submit: boolean }>(
    m,
    `const q = (s) => doc.querySelector(${JSON.stringify(MODAL)} + " " + s);
     const select = q("select");
     return {
       icon: q('[aria-label="Icône"]').value,
       name: q('[aria-label="Nom de l\\'espace"]').value,
       private: q('input[type="checkbox"]').checked,
       options: [...select.options].map((o) => o.textContent),
       chosen: select.selectedOptions[0]?.textContent ?? null,
       firstDisabled: select.options[0].disabled,
       submit: !q('button[type="submit"]').disabled,
     };`,
  );
/** Types into a modal field (Svelte's bind:value listens to input). */
const fill = (label: string, value: string) =>
  inUi(m, `const f = doc.querySelector(arguments[0] + ' [aria-label="' + arguments[1] + '"]'); f.value = arguments[2]; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`, [
    MODAL,
    label,
    value,
  ]);
/** Picks a profile option by its text (bind:value on a select listens to change). */
const choose = (text: string) =>
  inUi(
    m,
    `const s = doc.querySelector(arguments[0] + " select"); s.value = [...s.options].find((o) => o.textContent === arguments[1]).value; s.dispatchEvent(new ui.Event("change", { bubbles: true }));`,
    [MODAL, text],
  );
const focusName = () => inUi(m, `doc.querySelector(arguments[0] + ' [aria-label="Nom de l\\'espace"]').focus()`, [MODAL]);
async function openSettings(id: string): Promise<void> {
  await click(m, button(id), { button: 2 });
  await click(m, '[role="menuitem"]', { text: "Réglages" });
  await modalOpen("Réglages de l'espace");
}
async function waitSpaces<T>(read: (e: Space[]) => T, ok: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const v = read(await spaces());
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out: last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("space settings", () => {
  it("“+” opens “Nouvel espace”: not private, no profile chosen; “Créer” waits for the choice, then adds the space", async () => {
    const travail = await create("Travail", "💼", false, "nouveau");
    await click(m, '[data-testid="nouvel-espace"]');
    await modalOpen("Nouvel espace");
    expect(await fields()).toMatchObject({
      private: false,
      options: ["Choisir un profil…", "Nouveau profil", "Partagé avec « Perso »", "Partagé avec « Travail »"],
      chosen: "Choisir un profil…",
      firstDisabled: true,
      submit: false,
    });
    expect(await inUi(m, "return [...doc.querySelectorAll(arguments[0] + ' button')].some((b) => b.textContent === 'Annuler')", [MODAL])).toBe(true);
    await fill("Icône", "🎮");
    await fill("Nom de l'espace", "Jeux");
    // No profile chosen: Enter does nothing.
    await pressKeys(m, "Enter");
    await new Promise((r) => setTimeout(r, 300));
    expect((await spaces()).some((e) => e.nom === "Jeux")).toBe(false);
    await choose("Partagé avec « Travail »");
    await waitUi(m, "return !doc.querySelector(arguments[0] + ' button[type=submit]').disabled", [MODAL]);
    await click(m, `${MODAL} button[type="submit"]`, { text: "Créer" });
    await modalClosed();
    const sets = await waitSpaces((l) => l.find((e) => e.nom === "Jeux"), (e) => !!e);
    expect(sets).toMatchObject({ icone: "🎮", prive: false, profil: travail.profil });
    await waitUi(m, "return doc.querySelector(arguments[0])?.getAttribute('aria-current') === 'true'", [button(sets!.id)]);

    // « Nouveau profil » makes a profile of its own.
    await click(m, '[data-testid="nouvel-espace"]');
    await modalOpen("Nouvel espace");
    await fill("Nom de l'espace", "Neuf");
    await choose("Nouveau profil");
    await focusName();
    await pressKeys(m, "Enter");
    await modalClosed();
    const fresh = await waitSpaces((l) => l.find((e) => e.nom === "Neuf")?.profil, (p) => !!p);
    expect([travail.profil, "defaut", "nouveau"]).not.toContain(fresh);
  });

  it("“Réglages” shows the space's values; private and its own profile are saved", async () => {
    const bank = await create("Banque", "💶", false, "defaut");
    await click(m, button(bank.id), { button: 2 });
    await waitUi(m, "return doc.querySelectorAll('[role=\"menuitem\"]').length");
    expect(await inUi(m, "return [...doc.querySelectorAll('[role=\"menuitem\"]')].map((e) => e.textContent.trim())")).not.toContain("Renommer");
    await click(m, '[role="menuitem"]', { text: "Réglages" });
    await modalOpen("Réglages de l'espace");
    const text = await inUi<string>(m, "return doc.querySelector(arguments[0]).textContent", [MODAL]);
    expect(text).toContain("L'agent ne voit pas ces onglets, ne lit rien, n'a pas les outils de développement, et rien n'est retenu dans sa mémoire.");
    expect(text).toContain(
      "Cookies, comptes connectés, autorisations des sites. Changer de profil : les onglets de l'espace se rechargent, tu devras peut-être te reconnecter.",
    );
    expect(await fields()).toMatchObject({
      icon: "💶",
      name: "Banque",
      private: false,
      options: ["Son propre profil", "Partagé avec « Perso »"],
      chosen: "Partagé avec « Perso »",
    });
    await click(m, `${MODAL} input[type="checkbox"]`);
    await choose("Son propre profil");
    await click(m, `${MODAL} button[type="submit"]`, { text: "Enregistrer" });
    await modalClosed();
    const saved = await waitSpaces((l) => l.find((e) => e.id === bank.id)!, (e) => e.prive);
    expect(saved.profil).not.toBe("defaut");
    // Reopened, the modal shows its own profile.
    await openSettings(bank.id);
    expect(await fields()).toMatchObject({ private: true, chosen: "Son propre profil" });
    // Keeping its own profile changes nothing.
    await fill("Nom de l'espace", "Banque pro");
    await focusName();
    await pressKeys(m, "Enter");
    await modalClosed();
    expect(await waitSpaces((l) => l.find((e) => e.id === bank.id)!, (e) => e.nom === "Banque pro")).toMatchObject({ profil: saved.profil });
  });

  it("Escape closes the modal without changing anything", async () => {
    const before = await spaces();
    await openSettings(before[0]!.id);
    // The rest of the UI is inert behind the modal.
    expect(await inUi(m, "return !!doc.querySelector('[data-testid=\"barre-laterale\"]').closest('[inert]')")).toBe(true);
    await fill("Nom de l'espace", "Autre");
    await click(m, `${MODAL} input[type="checkbox"]`);
    await pressKeys(m, "Escape");
    await modalClosed();
    expect(await spaces()).toEqual(before);
    await click(m, '[data-testid="nouvel-espace"]');
    await modalOpen("Nouvel espace");
    await fill("Nom de l'espace", "Jeux");
    await pressKeys(m, "Escape");
    await modalClosed();
    expect(await spaces()).toEqual(before);
  });

  it("a private space's button carries a padlock", async () => {
    const secret = await create("Secret", "🕵️", true, "defaut");
    const home = (await spaces())[0]!;
    await waitUi(m, "return doc.querySelector(arguments[0])?.dataset.prive === 'true'", [button(secret.id)]);
    expect(await inUi(m, "return doc.querySelector(arguments[0]).textContent", [button(secret.id)])).toContain("🔒");
    expect(await inUi(m, "return [doc.querySelector(arguments[0]).dataset.prive ?? null, doc.querySelector(arguments[0]).textContent]", [button(home.id)])).toEqual([
      null,
      "🏠",
    ]);
  });

  it("deleting a profile's last space warns that its logins will be lost, even without tabs", async () => {
    // Shares the default profile, no tab: deleted without confirmation.
    const sets = await create("Jeux", "🎮", false, "defaut");
    await click(m, button(sets.id), { button: 2 });
    await click(m, '[role="menuitem"]', { text: "Supprimer" });
    await waitSpaces((l) => l.some((e) => e.id === sets.id), (v) => !v);
    expect(await inUi(m, "return doc.querySelectorAll('[role=alertdialog]').length")).toBe(0);

    const travail = await create("Travail", "💼", false, "nouveau");
    await click(m, button(travail.id), { button: 2 });
    await click(m, '[role="menuitem"]', { text: "Supprimer" });
    const text = await waitUi<string>(m, "return doc.querySelector('[role=alertdialog]')?.textContent");
    expect(text).toContain("Travail");
    expect(text).toContain("Les connexions de cet espace seront perdues.");
    await click(m, "[role=alertdialog] button", { text: "Annuler" });
    await waitUi(m, "return !doc.querySelector('[role=alertdialog]')");
    expect((await spaces()).some((e) => e.id === travail.id)).toBe(true);
    await click(m, button(travail.id), { button: 2 });
    await click(m, '[role="menuitem"]', { text: "Supprimer" });
    await click(m, "[role=alertdialog] button", { text: "Supprimer" });
    await waitSpaces((l) => l.some((e) => e.id === travail.id), (v) => !v);
  });

  it("changing a space's profile reloads its tabs in the new container, and wipes the old profile no space uses any more", async () => {
    const tab = "return { ctx: gBrowser.selectedTab.userContextId, url: gBrowser.selectedBrowser.currentURI.spec, title: gBrowser.selectedBrowser.contentTitle }";
    // The default profile gets the cookie essai=1.
    await dispatch(m, { type: "ouvrirOnglet", fenetreId: await windowId(), url: server.url + "/cookie" });
    await waitFor<{ title: string }>(m, tab, (t) => t.title === "cookie");
    const travail = await create("Travail", "💼", false, "nouveau");
    await dispatch(m, { type: "ouvrirOnglet", fenetreId: await windowId(), url: server.url + "/lire-cookie" });
    const before = await waitFor<{ ctx: number; title: string }>(m, tab, (t) => t.title === "aucun");
    expect(before.ctx).not.toBe(0);
    // A cookie of the old profile, set by its page.
    const win = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
    const page = await m.execute<string>(
      `return ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs").NavigableManager.getIdForBrowser(gBrowser.selectedBrowser);`,
    );
    await m.command("WebDriver:SwitchToWindow", { handle: page, focus: false });
    await m.setContext("content");
    await m.execute("document.cookie = 'ancien=1; max-age=3600'");
    await m.setContext("chrome");
    await m.command("WebDriver:SwitchToWindow", { handle: win, focus: false });
    const oldCookies = `return Services.cookies.getCookiesWithOriginAttributes(JSON.stringify({ userContextId: ${before.ctx} })).length`;
    expect(await m.execute(oldCookies)).toBe(1);
    const container = `const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
      return !!ContextualIdentityService.getPrivateIdentity("userContextIdInternal.webaios-${travail.profil}");`;
    expect(await m.execute(container)).toBe(true);
    await openSettings(travail.id);
    await choose("Partagé avec « Perso »");
    await click(m, `${MODAL} button[type="submit"]`, { text: "Enregistrer" });
    await modalClosed();
    // Reloaded in the default profile: it sees that profile's cookie.
    const after = await waitFor<{ ctx: number; url: string; title: string }>(m, tab, (t) => t.ctx === 0 && t.title === "essai=1");
    expect(after.url).toBe(server.url + "/lire-cookie");
    // No space uses the old profile any more: it is wiped, its container gone.
    await waitFor(m, oldCookies, (n) => n === 0, 3_000);
    expect(await m.execute(container)).toBe(false);
  });
});
