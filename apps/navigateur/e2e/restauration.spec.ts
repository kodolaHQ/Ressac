import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { creerEspace, dansLaVue, lancer, nombreWebContents, ouvrirOnglet, serveurTest } from "./aide";

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => (serveur = await serveurTest()));
test.afterAll(() => serveur.fermer());

const onglets = '[data-testid^="onglet-"]';
const menu = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.click(), id);
const interfaces = (app: ElectronApplication) => app.windows().filter((p) => p.url().includes("/renderer/index.html"));
const clicDroit = async (fenetre: Page, texte: string, entree: string) => {
  await fenetre.locator(onglets, { hasText: texte }).click({ button: "right" });
  await fenetre.getByRole("menuitem", { name: entree }).click();
};

test("onglets, espaces, épinglés, essentiels et fenêtres restaurés après redémarrage", async () => {
  const premier = await lancer();
  const f = premier.fenetre;
  for (const p of ["a.html", "b.html", "plante.html", "texte.html"]) await ouvrirOnglet(f, `${serveur.url}/${p}`, { activer: false });
  await expect(f.locator(onglets)).toHaveCount(4);
  await clicDroit(f, "a.html", "Épingler");
  await clicDroit(f, "b.html", "Ajouter aux essentiels");
  await expect(f.locator(onglets)).toHaveCount(2);
  await creerEspace(f, "Boulot", "💼");
  await ouvrirOnglet(f, `${serveur.url}/b.html`);
  await expect(f.locator(onglets)).toHaveCount(1);
  await menu(premier.app, "nouvelle-fenetre");
  await expect.poll(() => interfaces(premier.app).length).toBe(2);
  await premier.fermer();

  const second = await lancer({ profil: premier.profil });
  await expect.poll(() => interfaces(second.app).length).toBe(2);
  const g = second.fenetre;
  await expect(g.locator('[data-testid^="espace-"]')).toHaveCount(2);
  await expect(g.getByTestId("essentiels").locator('[data-testid^="favori-"]')).toHaveCount(1);
  // Chaque fenêtre retrouve son espace actif : celle d'origine est sur Boulot, avec son onglet.
  const pagesEtEspaces = await Promise.all(
    interfaces(second.app).map(async (p) => [await p.locator('[data-testid^="espace-"][aria-current="true"]').textContent(), await p.locator(onglets).count()]),
  );
  expect(pagesEtEspaces).toContainEqual(["💼", 1]);
  const perso = interfaces(second.app)[0]!;
  await perso.locator('[data-testid^="espace-"]', { hasText: "🏠" }).click();
  await expect(perso.getByTestId("epingles").locator('[data-testid^="favori-"]')).toHaveCount(1);
  await second.fermer();
});

test("un cookie posé par le serveur local survit au redémarrage", async () => {
  const premier = await lancer();
  await ouvrirOnglet(premier.fenetre, `${serveur.url}/cookie`);
  await expect.poll(() => dansLaVue(premier.app, "/cookie", "document.title")).toBe("cookie");
  await premier.fermer();
  const second = await lancer({ profil: premier.profil });
  await ouvrirOnglet(second.fenetre, `${serveur.url}/lire-cookie`);
  await expect.poll(() => dansLaVue(second.app, "/lire-cookie", "document.title")).toBe("essai=1");
  await second.fermer();
});

test("100 onglets restaurés : une seule vue web créée par fenêtre", async () => {
  const premier = await lancer();
  await premier.fenetre.evaluate((base) => {
    const w = window as unknown as { webaios: { agir(a: unknown): void; fenetreId: string } };
    for (let i = 0; i < 100; i++) w.webaios.agir({ type: "ouvrirOnglet", fenetreId: w.webaios.fenetreId, url: `${base}/b.html?n=${i}`, activer: i === 99 });
  }, serveur.url);
  await expect(premier.fenetre.locator(onglets)).toHaveCount(100);
  await premier.fermer();
  const second = await lancer({ profil: premier.profil });
  await expect(second.fenetre.locator(onglets)).toHaveCount(100);
  await expect.poll(() => dansLaVue(second.app, "n=99", "document.title")).toBe("Page B");
  await new Promise((r) => setTimeout(r, 500));
  expect(await nombreWebContents(second.app)).toBe(2); // l'interface + l'onglet actif
  await second.fenetre.locator(onglets).first().click();
  await expect.poll(() => nombreWebContents(second.app)).toBe(3);
  await second.fermer();
});

test("le moteur choisi est conservé et utilisé pour la recherche", async () => {
  const premier = await lancer();
  await menu(premier.app, "moteur-duckduckgo");
  await expect
    .poll(() => premier.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("moteur-duckduckgo")?.checked))
    .toBe(true);
  await new Promise((r) => setTimeout(r, 700)); // enregistrement de la session (500 ms)
  await premier.fermer();
  const second = await lancer({ profil: premier.profil });
  expect(await second.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("moteur-duckduckgo")?.checked)).toBe(true);
  expect(await second.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("moteur-google")?.checked)).toBe(false);
  await second.app.evaluate(({ session }) => {
    const g = globalThis as unknown as { demandes: string[] };
    g.demandes = [];
    session.fromPartition("persist:webaios").webRequest.onBeforeRequest({ urls: ["https://duckduckgo.com/*"] }, (d, rappel) => {
      g.demandes.push(d.url);
      rappel({ cancel: true });
    });
  });
  await second.fenetre.getByTestId("saisie-page-vide").fill("chats mignons");
  await second.fenetre.getByTestId("saisie-page-vide").press("Enter");
  await expect
    .poll(() => second.app.evaluate(() => (globalThis as unknown as { demandes: string[] }).demandes))
    .toContain("https://duckduckgo.com/?q=chats%20mignons");
  await second.fermer();
});

test("la taille et la position de la fenêtre sont restaurées", async () => {
  const premier = await lancer();
  const cadre = { x: 120, y: 90, width: 1000, height: 700 };
  await premier.app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.setBounds(c), cadre);
  await expect
    .poll(() => premier.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds()))
    .toEqual(cadre);
  await premier.fermer();
  const second = await lancer({ profil: premier.profil });
  expect(await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds())).toEqual(cadre);
  await second.fermer();
});
