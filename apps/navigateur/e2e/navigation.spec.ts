import { expect, test, type ElectronApplication } from "@playwright/test";
import { dansLaVue, lancer, ouvrirOnglet, serveurTest } from "./aide";

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => (serveur = await serveurTest()));
test.afterAll(() => serveur.fermer());

const onglets = '[data-testid^="onglet-"]';
const titreVue = (app: ElectronApplication, morceau: string) => dansLaVue(app, morceau, "document.title");

/** Bornes des vues web attachées à la première fenêtre. */
const bornesVues = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.map((v) => v.getBounds()));

test("taper une adresse charge la page ; taper un texte lance une recherche Google", async () => {
  const { app, fenetre, fermer } = await lancer();
  await app.evaluate(({ session }) => {
    const g = globalThis as unknown as { demandes: string[] };
    g.demandes = [];
    session.fromPartition("persist:webaios").webRequest.onBeforeRequest({ urls: ["https://www.google.com/*"] }, (d, rappel) => {
      g.demandes.push(d.url);
      rappel({ cancel: true });
    });
  });
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => titreVue(app, "a.html")).toBe("Page A");
  const barre = fenetre.getByTestId("barre-adresse");
  await expect(barre).toHaveValue("127.0.0.1");
  await barre.click();
  await expect(barre).toHaveValue(`${serveur.url}/a.html`);
  await barre.fill(`${serveur.url}/b.html`);
  await barre.press("Enter");
  await expect.poll(() => titreVue(app, "b.html")).toBe("Page B");
  await barre.click();
  await barre.fill("chats mignons");
  await barre.press("Enter");
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { demandes: string[] }).demandes))
    .toContain("https://www.google.com/search?q=chats%20mignons");
  await fermer();
});

test("javascript:alert(1) dans la barre ne fait rien", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => titreVue(app, "a.html")).toBe("Page A");
  const barre = fenetre.getByTestId("barre-adresse");
  await barre.click();
  await barre.fill("javascript:document.title='pirate'");
  await barre.press("Enter");
  await new Promise((r) => setTimeout(r, 500));
  expect(await titreVue(app, "a.html")).toBe("Page A");
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await fermer();
});

test("← et → suivent l'historique de l'onglet", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => titreVue(app, "a.html")).toBe("Page A");
  await expect(fenetre.getByRole("button", { name: "Reculer" })).toBeDisabled();
  const barre = fenetre.getByTestId("barre-adresse");
  await barre.click();
  await barre.fill(`${serveur.url}/b.html`);
  await barre.press("Enter");
  await expect(fenetre.locator(onglets).first()).toContainText("Page B");
  await fenetre.getByRole("button", { name: "Reculer" }).click();
  await expect(fenetre.locator(onglets).first()).toContainText("Page A");
  await fenetre.getByRole("button", { name: "Avancer" }).click();
  await expect(fenetre.locator(onglets).first()).toContainText("Page B");
  await fermer();
});

/** Défilements horizontaux d'un trackpad (deux doigts) envoyés à la page dont l'URL contient `morceau`. */
const balayer = (app: ElectronApplication, morceau: string, deltaX: number, fois = 20) =>
  app.evaluate(
    async ({ webContents }, { morceau, deltaX, fois }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(morceau))!;
      for (let i = 0; i < fois; i++) {
        wc.sendInputEvent({ type: "mouseWheel", x: 150, y: 100, deltaX, deltaY: 0, hasPreciseScrollingDeltas: true, canScroll: true });
        await new Promise((r) => setTimeout(r, 16));
      }
    },
    { morceau, deltaX, fois },
  );

test("balayer à deux doigts recule puis avance ; une bande qui défile garde le geste", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => titreVue(app, "a.html")).toBe("Page A");
  const barre = fenetre.getByTestId("barre-adresse");
  await barre.click();
  await barre.fill(`${serveur.url}/b.html`);
  await barre.press("Enter");
  await expect(fenetre.locator(onglets).first()).toContainText("Page B");
  // L'élan d'un geste ne navigue qu'une fois : 20 défilements reculent d'une seule page.
  await balayer(app, "b.html", 20);
  await expect(fenetre.locator(onglets).first()).toContainText("Page A");
  await new Promise((r) => setTimeout(r, 400));
  await balayer(app, "a.html", -20);
  await expect(fenetre.locator(onglets).first()).toContainText("Page B");

  // Une page qui défile horizontalement prend le geste : on reste dessus.
  await barre.click();
  await barre.fill(`${serveur.url}/large.html`);
  await barre.press("Enter");
  await expect(fenetre.locator(onglets).first()).toContainText("Page large");
  await new Promise((r) => setTimeout(r, 400));
  await balayer(app, "large.html", -20);
  await new Promise((r) => setTimeout(r, 400));
  await balayer(app, "large.html", 20);
  await new Promise((r) => setTimeout(r, 800));
  await expect(fenetre.locator(onglets).first()).toContainText("Page large");
  await fermer();
});

test("⌘+ puis redémarrage : le zoom de l'onglet est conservé", async () => {
  const premier = await lancer();
  await ouvrirOnglet(premier.fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => titreVue(premier.app, "a.html")).toBe("Page A");
  await premier.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("zoom-plus")?.click());
  const zoom = (app: ElectronApplication) =>
    app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().includes("a.html"))?.getZoomFactor());
  await expect.poll(() => zoom(premier.app)).toBeCloseTo(1.1);
  await premier.fermer();
  const second = await lancer({ profil: premier.profil });
  await expect.poll(() => zoom(second.app)).toBeCloseTo(1.1);
  await second.fermer();
});

test("le zoom est propre à l'onglet, pas au site", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await ouvrirOnglet(fenetre, `${serveur.url}/b.html`);
  await expect.poll(() => titreVue(app, "b.html")).toBe("Page B");
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("zoom-plus")?.click());
  await fenetre.locator(onglets).first().click();
  await expect.poll(() => titreVue(app, "a.html")).toBe("Page A");
  expect(
    await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().includes("a.html"))?.getZoomFactor()),
  ).toBeCloseTo(1);
  await fermer();
});

test("mode compact : la barre réapparaît à 14 px du bord, ou quand la souris sort vite par la gauche ; son bouton dit comment quitter le compact", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => titreVue(app, "a.html")).toBe("Page A");
  await fenetre.getByRole("button", { name: "Mode compact" }).click();
  await expect(fenetre.getByTestId("barre-laterale")).toBeHidden();
  await expect.poll(async () => (await bornesVues(app))[0]?.x).toBe(0);
  const souris = (type: "mouseMove" | "mouseLeave", x: number) =>
    app.evaluate(({ webContents }, [type, x]) => webContents.getAllWebContents().find((w) => w.getURL().includes("a.html"))?.sendInputEvent({ type, x, y: 300 } as Electron.MouseInputEvent), [type, x] as const);
  await souris("mouseMove", 14);
  await expect(fenetre.getByTestId("barre-laterale")).toBeVisible();
  await expect(fenetre.getByRole("button", { name: "Quitter le mode compact" })).toHaveAttribute("aria-pressed", "true");
  await fenetre.mouse.move(700, 300);
  await expect(fenetre.getByTestId("barre-laterale")).toBeHidden();
  // Geste rapide : le dernier mouvement vu est à 40 px, puis la souris quitte la page par la gauche.
  await souris("mouseMove", 40);
  await souris("mouseLeave", 40);
  await expect(fenetre.getByTestId("barre-laterale")).toBeVisible();
  await fermer();
});

test("mode compact : la souris immobile au bord garde la barre ouverte (la page qui glisse ne la referme pas) ; elle se ferme au-delà de la barre", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => titreVue(app, "a.html")).toBe("Page A");
  await fenetre.getByRole("button", { name: "Mode compact" }).click();
  await expect(fenetre.getByTestId("barre-laterale")).toBeHidden();
  await expect.poll(async () => (await bornesVues(app))[0]?.x).toBe(0);
  const souris = (type: "mouseMove" | "mouseLeave", x: number) =>
    app.evaluate(({ webContents }, [type, x]) => webContents.getAllWebContents().find((w) => w.getURL().includes("a.html"))?.sendInputEvent({ type, x, y: 300 } as Electron.MouseInputEvent), [type, x] as const);
  // La souris de l'interface quitte le bouton « Mode compact » : seule la page voit désormais la souris.
  await fenetre.mouse.move(700, 300);
  await souris("mouseMove", 3);
  await expect(fenetre.getByTestId("barre-laterale")).toBeVisible();
  await expect.poll(async () => (await bornesVues(app))[0]?.x).toBe(240);
  // Chaque apparition ou disparition de la barre est comptée : aucune tant que la souris reste au bord.
  await fenetre.evaluate(() => {
    const w = window as unknown as { bascules: number };
    w.bascules = 0;
    new MutationObserver(() => w.bascules++).observe(document.querySelector('[data-testid="barre-laterale"]')!, { attributeFilter: ["hidden"] });
  });
  // La page s'est décalée sous la souris restée à 3 px : elle la quitte, sans que la souris ait bougé.
  await souris("mouseLeave", 3);
  await new Promise((r) => setTimeout(r, 800));
  await expect(fenetre.getByTestId("barre-laterale")).toBeVisible();
  expect(await fenetre.evaluate(() => (window as unknown as { bascules: number }).bascules)).toBe(0);
  // Sur la page, juste à droite de la barre : elle reste ouverte ; plus loin, elle se ferme.
  await souris("mouseMove", 20);
  await new Promise((r) => setTimeout(r, 800));
  await expect(fenetre.getByTestId("barre-laterale")).toBeVisible();
  await souris("mouseMove", 200);
  await expect(fenetre.getByTestId("barre-laterale")).toBeHidden();
  await fermer();
});

test("mode compact : barre cachée, réapparaît au bord gauche, le contenu prend toute la largeur", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => titreVue(app, "a.html")).toBe("Page A");
  await expect.poll(async () => (await bornesVues(app))[0]?.x).toBe(240);
  await fenetre.getByRole("button", { name: "Mode compact" }).click();
  await expect(fenetre.getByTestId("barre-laterale")).toBeHidden();
  await expect.poll(async () => (await bornesVues(app))[0]?.x).toBe(0);
  // La souris arrive au bord gauche, au-dessus de la page web.
  await app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().find((w) => w.getURL().includes("a.html"))?.sendInputEvent({ type: "mouseMove", x: 3, y: 300 }),
  );
  await expect(fenetre.getByTestId("barre-laterale")).toBeVisible();
  await fenetre.mouse.move(120, 300);
  await fenetre.mouse.move(700, 300);
  await expect(fenetre.getByTestId("barre-laterale")).toBeHidden();
  await expect.poll(async () => (await bornesVues(app))[0]?.x).toBe(0);
  await fermer();
});
