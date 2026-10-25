import { mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type ElectronApplication } from "@playwright/test";
import { dansLaVue, lancer, ouvrirOnglet, serveurTest } from "./aide";

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => (serveur = await serveurTest()));
test.afterAll(() => serveur.fermer());

/** Arme l'écoute d'un événement de la fenêtre ; la promesse rendue attend qu'il soit survenu.
 * (Sonder isFullScreen() pendant l'animation de macOS dérègle l'état du plein écran.) */
async function evenementFenetre(app: ElectronApplication, nom: "enter-full-screen" | "leave-full-screen") {
  await app.evaluate(({ BrowserWindow }, nom) => {
    const g = globalThis as unknown as { vus: Set<string> };
    g.vus ??= new Set();
    g.vus.delete(nom);
    BrowserWindow.getAllWindows()[0]!.once(nom as "enter-full-screen", () => g.vus.add(nom));
  }, nom);
  return () =>
    expect
      .poll(() => app.evaluate((_, nom) => (globalThis as unknown as { vus: Set<string> }).vus.has(nom), nom), { timeout: 10_000 })
      .toBe(true);
}

const menu = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.click(), id);

test("⌘F trouve le mot et affiche le compteur ; Échap ferme la barre", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/texte.html`);
  await expect.poll(() => dansLaVue(app, "texte.html", "document.title")).toBe("Texte");
  await menu(app, "rechercher");
  const champ = fenetre.getByTestId("recherche-page");
  await expect(champ).toBeFocused();
  await champ.fill("chat");
  const compteur = fenetre.getByTestId("compteur-recherche");
  await expect(compteur).toHaveText("1/3");
  await champ.press("Enter");
  await expect(compteur).toHaveText("2/3");
  await champ.press("Shift+Enter");
  await expect(compteur).toHaveText("1/3");
  await champ.fill("licorne");
  await expect(compteur).toHaveText("0/0");
  await champ.press("Escape");
  await expect(champ).toBeHidden();
  await fermer();
});

test("une vidéo en plein écran masque la barre latérale ; Échap la rétablit", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/video.html`);
  await expect.poll(() => dansLaVue(app, "video.html", "document.title")).toBe("Vidéo");
  const entree = await evenementFenetre(app, "enter-full-screen");
  await dansLaVue(app, "video.html", "document.getElementById('plein').click()");
  await expect(fenetre.getByTestId("barre-laterale")).toBeHidden();
  await entree();
  await expect.poll(() => dansLaVue(app, "video.html", "!!document.fullscreenElement")).toBe(true);
  const sortie = await evenementFenetre(app, "leave-full-screen");
  await app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().find((w) => w.getURL().includes("video.html"))?.sendInputEvent({ type: "keyDown", keyCode: "Escape" }),
  );
  await sortie();
  await expect(fenetre.getByTestId("barre-laterale")).toBeVisible();
  await expect.poll(() => dansLaVue(app, "video.html", "!!document.fullscreenElement")).toBe(false);
  await fermer();
});

test("un PDF s'ouvre dans l'onglet, sans téléchargement", async () => {
  const dossier = realpathSync(mkdtempSync(join(tmpdir(), "webaios-dl-")));
  const { app, fenetre, fermer } = await lancer({ env: { WEBAIOS_TELECHARGEMENTS: dossier } });
  await ouvrirOnglet(fenetre, `${serveur.url}/doc.pdf`);
  await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().some((w) => w.getURL().endsWith("/doc.pdf")))).toBe(true);
  await expect(fenetre.locator('[data-testid^="onglet-"]').first()).not.toHaveAttribute("aria-busy", "true");
  await new Promise((r) => setTimeout(r, 1000));
  expect(readdirSync(dossier)).toEqual([]);
  await expect(fenetre.getByRole("button", { name: "Téléchargements" })).toHaveCount(0);
  await fermer();
});

// Limite connue : Échap dans les ~0,6 s de l'animation d'entrée de macOS sort la fenêtre du plein écran
// mais laisse le document de la page en plein écran (Électron intercepte Échap avant before-input-event).
test.fixme("Échap pendant l'animation d'entrée en plein écran ne bloque pas la page en plein écran", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/video.html`);
  await expect.poll(() => dansLaVue(app, "video.html", "document.title")).toBe("Vidéo");
  const sortie = await evenementFenetre(app, "leave-full-screen");
  await dansLaVue(app, "video.html", "document.getElementById('plein').click()");
  await new Promise((r) => setTimeout(r, 150));
  await app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().find((w) => w.getURL().includes("video.html"))?.sendInputEvent({ type: "keyDown", keyCode: "Escape" }),
  );
  await sortie();
  await expect.poll(() => dansLaVue(app, "video.html", "!!document.fullscreenElement")).toBe(false);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFullScreen())).toBe(false);
  await expect(fenetre.getByTestId("barre-laterale")).toBeVisible();
  await fermer();
});
