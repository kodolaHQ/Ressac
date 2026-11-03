import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Action } from "../../navigateur/src/commun/api";
import type { Espace } from "../../navigateur/src/commun/modele";
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
const fenetreId = async () => (await state(m)).fenetres[0]!.id;
async function create(nom: string, icone: string, prive: boolean, profil: string): Promise<Espace> {
  await dispatch(m, { type: "creerEspace", nom, icone, prive, profil, fenetreId: await fenetreId() } as Action);
  return (await spaces()).find((e) => e.nom === nom)!;
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
async function openSettings(id: string): Promise<void> {
  await click(m, button(id), { button: 2 });
  await click(m, '[role="menuitem"]', { text: "Réglages" });
  await modalOpen("Réglages de l'espace");
}
async function waitSpaces<T>(read: (e: Espace[]) => T, ok: (v: T) => boolean): Promise<T> {
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
    const jeux = await waitSpaces((l) => l.find((e) => e.nom === "Jeux"), (e) => !!e);
    expect(jeux).toMatchObject({ icone: "🎮", prive: false, profil: travail.profil });
    await waitUi(m, "return doc.querySelector(arguments[0])?.getAttribute('aria-current') === 'true'", [button(jeux!.id)]);
  });

  it("“Réglages” shows the space's values; private and its own profile are saved", async () => {
    const banque = await create("Banque", "💶", false, "defaut");
    await openSettings(banque.id);
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
    const saved = await waitSpaces((l) => l.find((e) => e.id === banque.id)!, (e) => e.prive);
    expect(saved.profil).not.toBe("defaut");
    // Reopened, the modal shows its own profile.
    await openSettings(banque.id);
    expect(await fields()).toMatchObject({ private: true, chosen: "Son propre profil" });
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
    const jeux = await create("Jeux", "🎮", false, "defaut");
    await click(m, button(jeux.id), { button: 2 });
    await click(m, '[role="menuitem"]', { text: "Supprimer" });
    await waitSpaces((l) => l.some((e) => e.id === jeux.id), (v) => !v);
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

  it("changing a space's profile reloads its tabs in the new container", async () => {
    const travail = await create("Travail", "💼", false, "nouveau");
    await dispatch(m, { type: "ouvrirOnglet", fenetreId: await fenetreId(), url: server.url + "/a.html" });
    const tab = "return { ctx: gBrowser.selectedTab.userContextId, url: gBrowser.selectedBrowser.currentURI.spec, title: gBrowser.selectedBrowser.contentTitle }";
    const before = await waitFor<{ ctx: number; title: string }>(m, tab, (t) => t.title === "Page A");
    await openSettings(travail.id);
    await choose("Partagé avec « Perso »");
    await click(m, `${MODAL} button[type="submit"]`, { text: "Enregistrer" });
    await modalClosed();
    const after = await waitFor<{ ctx: number; url: string; title: string }>(m, tab, (t) => t.ctx !== before.ctx && t.title === "Page A");
    expect(after.url).toBe(server.url + "/a.html");
  });
});
