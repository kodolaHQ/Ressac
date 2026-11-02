import { expect, test, type ElectronApplication } from "@playwright/test";
import { dansLaVue, lancer, ouvrirOnglet, serveurTest } from "./aide";

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => (serveur = await serveurTest()));
test.afterAll(() => serveur.fermer());

const onglets = '[data-testid^="onglet-"]';
const menu = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`entrée de menu inconnue : ${id}`);
    item.click();
  }, id);
const bornesVues = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.map((v) => v.getBounds()));

test("⌘T puis ⌘W : l'onglet s'ouvre puis se ferme ; ⇧⌘T le rouvre avec son URL", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "nouvel-onglet");
  await expect(fenetre.getByTestId("saisie-page-vide")).toBeFocused();
  await fenetre.getByTestId("saisie-page-vide").fill(`${serveur.url}/b.html`);
  await fenetre.getByTestId("saisie-page-vide").press("Enter");
  await expect(fenetre.locator(onglets)).toHaveCount(2);
  await menu(app, "fermer-onglet");
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "rouvrir-onglet");
  await expect(fenetre.locator(onglets)).toHaveCount(2);
  await expect.poll(() => dansLaVue(app, "b.html", "document.title")).toBe("Page B");
  await menu(app, "adresse");
  await expect(fenetre.getByTestId("barre-adresse")).toBeFocused();
  await fermer();
});

test("⌘N ouvre une seconde fenêtre avec ses propres onglets ; les fermer une à une laisse l'app ouverte (macOS)", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "nouvelle-fenetre");
  const interfaces = () => app.windows().filter((p) => p.url().includes("/renderer/index.html"));
  await expect.poll(() => interfaces().length).toBe(2);
  const seconde = interfaces().find((p) => p !== fenetre)!;
  await expect(seconde.getByTestId("page-vide")).toBeVisible();
  await expect(seconde.locator(onglets)).toHaveCount(0);
  await seconde.getByTestId("saisie-page-vide").fill(`${serveur.url}/b.html`);
  await seconde.getByTestId("saisie-page-vide").press("Enter");
  await expect(seconde.locator(onglets)).toHaveCount(1);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  // Même espace que la fenêtre d'origine.
  await expect(seconde.locator('[data-testid^="espace-"][aria-current="true"]')).toHaveText("🏠");

  await seconde.evaluate(() => window.close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  expect(await fenetre.evaluate(() => 1 + 1)).toBe(2);
  await menu(app, "fermer-fenetre");
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  await new Promise((r) => setTimeout(r, 300));
  expect(await app.evaluate(() => 1 + 1)).toBe(2); // toujours vivante
  await fermer();
});

/** Trois onglets a, b, plante ; ordre récent : plante (actif), a, b. */
async function troisOnglets(app: ElectronApplication, fenetre: import("@playwright/test").Page) {
  for (const p of ["a.html", "b.html", "plante.html"]) await ouvrirOnglet(fenetre, `${serveur.url}/${p}`, { activer: false });
  await expect(fenetre.locator(onglets)).toHaveCount(3);
  await menu(app, "onglet-1");
  await expect(fenetre.locator(onglets).nth(0)).toHaveAttribute("aria-current", "page");
  await menu(app, "onglet-3");
  await expect(fenetre.locator(onglets).nth(2)).toHaveAttribute("aria-current", "page");
}

/**
 * Relâche ⌃ dans l'interface. `fenetre.keyboard.up` (CDP) n'atteint pas `before-input-event` : seul `sendInputEvent`
 * passe par là, comme une vraie touche (le process principal valide le parcours).
 */
const relacherCtrl = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.sendInputEvent({ type: "keyUp", keyCode: "Control" }));

test("⌃Tab bref revient à l'onglet précédent", async () => {
  const { app, fenetre, fermer } = await lancer();
  await troisOnglets(app, fenetre);
  const panneau = fenetre.getByTestId("panneau-onglets");
  await menu(app, "onglet-suivant");
  await relacherCtrl(app);
  await expect(fenetre.locator(onglets).nth(0)).toHaveAttribute("aria-current", "page");
  await new Promise((r) => setTimeout(r, 300));
  await expect(panneau).toHaveCount(0);
  await menu(app, "onglet-9");
  await expect(fenetre.locator(onglets).nth(2)).toHaveAttribute("aria-current", "page");
  await fermer();
});

test("⌃Tab tenu ouvre le panneau des onglets récents", async () => {
  const { app, fenetre, fermer } = await lancer();
  await troisOnglets(app, fenetre);
  const panneau = fenetre.getByTestId("panneau-onglets");
  const cartes = panneau.getByTestId("carte-onglet");
  await menu(app, "onglet-suivant");
  // Visible : le focus donné à l'interface par la capture du fond ne fait pas perdre le focus à la fenêtre.
  await expect(panneau).toBeVisible();
  await expect(cartes).toHaveCount(3);
  await expect(cartes.nth(1)).toHaveAttribute("aria-selected", "true");
  await menu(app, "onglet-suivant");
  await expect(cartes.nth(2)).toHaveAttribute("aria-selected", "true");
  await relacherCtrl(app);
  await expect(panneau).toHaveCount(0);
  await expect(fenetre.locator(onglets).nth(1)).toHaveAttribute("aria-current", "page");

  // Échap annule : l'onglet ne change pas.
  await menu(app, "onglet-suivant");
  await expect(panneau).toBeVisible();
  await fenetre.keyboard.press("Escape");
  await expect(panneau).toHaveCount(0);
  await expect(fenetre.locator(onglets).nth(1)).toHaveAttribute("aria-current", "page");
  await fermer();
});

/**
 * Fenêtre invisible (e2e) : `isFocused()` y reste toujours faux. On note donc les appels à `focus()` des vues d'onglet,
 * et l'on compare au dernier la vue attachée à la fenêtre.
 */
const espionnerFocus = (app: ElectronApplication) =>
  app.evaluate(({ webContents }) => {
    const g = globalThis as { focusVues?: number[] };
    g.focusVues = [];
    for (const wc of webContents.getAllWebContents()) {
      const focus = wc.focus.bind(wc);
      wc.focus = () => {
        g.focusVues!.push(wc.id);
        focus();
      };
    }
  });
/** Le dernier focus donné à une vue d'onglet vise celle affichée dans la fenêtre (null : aucun appel). */
const focusSurLaPage = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const appels = (globalThis as { focusVues?: number[] }).focusVues ?? [];
    if (!appels.length) return null;
    const affichee = BrowserWindow.getAllWindows()[0]!.contentView.children.map((v) => (v as Electron.WebContentsView).webContents).find(Boolean);
    return appels.at(-1) === affichee?.id;
  });

test("⌃Tab : le panneau fermé, le clavier revient à la page affichée", async () => {
  const { app, fenetre, fermer } = await lancer();
  await troisOnglets(app, fenetre);
  const panneau = fenetre.getByTestId("panneau-onglets");
  await menu(app, "onglet-suivant");
  await expect(panneau).toBeVisible();
  await espionnerFocus(app);
  await relacherCtrl(app);
  await expect(panneau).toHaveCount(0);
  await expect(fenetre.locator(onglets).nth(0)).toHaveAttribute("aria-current", "page");
  await expect.poll(() => focusSurLaPage(app)).toBe(true);
  // Annulé (Échap) : pareil, sur l'onglet resté affiché.
  await menu(app, "onglet-suivant");
  await expect(panneau).toBeVisible();
  await espionnerFocus(app);
  await fenetre.keyboard.press("Escape");
  await expect(panneau).toHaveCount(0);
  await expect.poll(() => focusSurLaPage(app)).toBe(true);
  // Appui bref : l'interface n'a jamais pris le clavier, rien à rendre.
  await espionnerFocus(app);
  await menu(app, "onglet-suivant");
  await relacherCtrl(app);
  await expect(fenetre.locator(onglets).nth(2)).toHaveAttribute("aria-current", "page");
  await new Promise((r) => setTimeout(r, 300));
  expect(await focusSurLaPage(app)).toBeNull();
  await fermer();
});

test("⌃Tab : une carte sous la souris immobile ne prend pas la sélection, un vrai mouvement si", async () => {
  const { app, fenetre, fermer } = await lancer();
  await troisOnglets(app, fenetre);
  const panneau = fenetre.getByTestId("panneau-onglets");
  const cartes = panneau.getByTestId("carte-onglet");
  // Repère la place de la première carte, puis referme sans rien changer.
  await menu(app, "onglet-suivant");
  await expect(cartes).toHaveCount(3);
  const boite = (await cartes.nth(0).boundingBox())!;
  await fenetre.keyboard.press("Escape");
  await expect(panneau).toHaveCount(0);
  const x = boite.x + boite.width / 2;
  const y = boite.y + boite.height / 2;
  await fenetre.mouse.move(x, y);
  // Le panneau apparaît sous la souris immobile : la sélection reste celle du clavier.
  await menu(app, "onglet-suivant");
  await expect(cartes).toHaveCount(3);
  await expect(cartes.nth(1)).toHaveAttribute("aria-selected", "true");
  await new Promise((r) => setTimeout(r, 300));
  await expect(cartes.nth(1)).toHaveAttribute("aria-selected", "true");
  // Le panneau change de contenu (pas suivant) sous la souris toujours immobile : idem.
  await menu(app, "onglet-suivant");
  await expect(cartes.nth(2)).toHaveAttribute("aria-selected", "true");
  await new Promise((r) => setTimeout(r, 300));
  await expect(cartes.nth(2)).toHaveAttribute("aria-selected", "true");
  // Un vrai mouvement sur la carte la sélectionne.
  await fenetre.mouse.move(x + 6, y + 4, { steps: 3 });
  await expect(cartes.nth(0)).toHaveAttribute("aria-selected", "true");
  await relacherCtrl(app);
  await expect(panneau).toHaveCount(0);
  await expect(fenetre.locator(onglets).nth(2)).toHaveAttribute("aria-current", "page");
  await fermer();
});

test("⌃Tab par-dessus l'historique : Échap ferme le panneau ⌃Tab seulement", async () => {
  const { app, fenetre, fermer } = await lancer();
  await troisOnglets(app, fenetre);
  await menu(app, "historique");
  const historique = fenetre.getByTestId("historique");
  await expect(historique).toBeVisible();
  const panneau = fenetre.getByTestId("panneau-onglets");
  await menu(app, "onglet-suivant");
  await expect(panneau).toBeVisible();
  // Le panneau ⌃Tab est au-dessus (rien ne le couvre au centre de sa première carte).
  const carte = panneau.getByTestId("carte-onglet").nth(0);
  const b = (await carte.boundingBox())!;
  const dessus = await fenetre.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-testid="panneau-onglets"]'), { x: b.x + b.width / 2, y: b.y + b.height / 2 });
  expect(dessus).toBe(true);
  await espionnerFocus(app);
  await fenetre.keyboard.press("Escape");
  await expect(panneau).toHaveCount(0);
  await expect(historique).toBeVisible();
  // L'historique, resté ouvert, garde le clavier : la page cachée dessous ne le reprend pas.
  await new Promise((r) => setTimeout(r, 1200));
  expect(await focusSurLaPage(app)).not.toBe(true);
  await expect(fenetre.locator(onglets).nth(2)).toHaveAttribute("aria-current", "page");
  await fermer();
});

test("⌃2 active le deuxième espace", async () => {
  const { app, fenetre, fermer } = await lancer();
  await fenetre.evaluate(() => {
    const w = window as unknown as { webaios: { agir(a: unknown): void } };
    w.webaios.agir({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut" });
  });
  await expect(fenetre.locator('[data-testid^="espace-"]')).toHaveCount(2);
  await menu(app, "espace-2");
  await expect(fenetre.locator('[data-testid^="espace-"][aria-current="true"]')).toHaveText("💼");
  await fermer();
});

test("⌘J affiche puis masque le panneau agent, et la vue web se redimensionne", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  const largeur = (await bornesVues(app))[0]!.width;
  await menu(app, "panneau-agent");
  await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
  await expect.poll(async () => Math.abs(((await bornesVues(app))[0]?.width ?? 0) - (largeur - 420))).toBeLessThanOrEqual(1);
  await menu(app, "panneau-agent");
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await expect.poll(async () => (await bornesVues(app))[0]?.width).toBe(largeur);
  await fermer();
});

test("⇧⌘J ouvre les téléchargements ; ⌘[ et ⌘] suivent l'historique", async () => {
  const { app, fenetre, fermer } = await lancer();
  await menu(app, "telechargements");
  await expect(fenetre.getByTestId("telechargements")).toBeVisible();
  await menu(app, "telechargements");
  await expect(fenetre.getByTestId("telechargements")).toBeHidden();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await fenetre.getByTestId("barre-adresse").click();
  await fenetre.getByTestId("barre-adresse").fill(`${serveur.url}/b.html`);
  await fenetre.getByTestId("barre-adresse").press("Enter");
  await expect(fenetre.locator(onglets).first()).toContainText("Page B");
  await menu(app, "reculer");
  await expect(fenetre.locator(onglets).first()).toContainText("Page A");
  await menu(app, "avancer");
  await expect(fenetre.locator(onglets).first()).toContainText("Page B");
  await fermer();
});
