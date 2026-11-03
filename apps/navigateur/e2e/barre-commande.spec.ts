import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { appelerOutil, dansLaVue, ecrireAction, ecrireSite, fenetreSite, lancer, nouvelleRacine, ouvrirOnglet, reglerEspaceActifPrive, serveurSites, serveurTest } from "./aide";

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => (serveur = await serveurTest()));
test.afterAll(() => serveur.fermer());

const onglets = '[data-testid^="onglet-"]';
const actif = '[data-testid^="onglet-"][aria-selected="true"]';
const menu = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`entrée de menu inconnue : ${id}`);
    item.click();
  }, id);

test("⌘T ouvre la modale vide, focus dans le champ", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "nouvel-onglet");
  const saisie = fenetre.getByTestId("saisie-commande");
  await expect(saisie).toBeFocused();
  await expect(saisie).toHaveValue("");
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await fermer();
});

test("⌘T + Entrée à vide affiche l'accueil", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "nouvel-onglet");
  await fenetre.getByTestId("saisie-commande").press("Enter");
  await expect(fenetre.getByTestId("page-vide")).toBeVisible();
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await fermer();
});

test("⌘T + adresse ouvre un nouvel onglet", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "nouvel-onglet");
  await fenetre.getByTestId("saisie-commande").fill(`${serveur.url}/b.html`);
  await fenetre.getByTestId("saisie-commande").press("Enter");
  await expect(fenetre.locator(onglets)).toHaveCount(2);
  await expect(fenetre.locator(actif)).toContainText("Page B");
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await fermer();
});

test("⌘L préremplit l'URL active, tout sélectionné", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "adresse");
  const saisie = fenetre.getByTestId("saisie-commande");
  await expect(saisie).toHaveValue(`${serveur.url}/a.html`);
  await expect(saisie).toBeFocused();
  const sel = await saisie.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd, el.value.length]);
  expect(sel).toEqual([0, `${serveur.url}/a.html`.length, `${serveur.url}/a.html`.length]);
  await saisie.fill(`${serveur.url}/b.html`);
  await saisie.press("Enter");
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await expect(fenetre.locator(actif)).toContainText("Page B");
  await fermer();
});

test("⌘L sur l'accueil = champ vide", async () => {
  const { app, fenetre, fermer } = await lancer();
  await menu(app, "adresse");
  const saisie = fenetre.getByTestId("saisie-commande");
  await expect(saisie).toHaveValue("");
  await saisie.press("Enter");
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await expect(fenetre.getByTestId("page-vide")).toBeVisible();
  await fermer();
});

test("Échap ferme et la page réapparaît", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await menu(app, "nouvel-onglet");
  await expect(fenetre.getByTestId("modale-apercu")).toBeVisible();
  await fenetre.getByTestId("saisie-commande").press("Escape");
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await expect(fenetre.getByTestId("modale-apercu")).toHaveCount(0);
  await fermer();
});

test("frappe pendant la capture conservée", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "nouvel-onglet");
  await fenetre.keyboard.type("abc");
  await expect(fenetre.getByTestId("saisie-commande")).toHaveValue("abc");
  await fermer();
});

const deuxOnglets = async (fenetre: Page) => {
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await ouvrirOnglet(fenetre, `${serveur.url}/b.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(2);
};

test("se ferme quand l'onglet actif change pendant qu'elle est ouverte", async () => {
  const { app, fenetre, fermer } = await lancer();
  await deuxOnglets(fenetre);
  await menu(app, "nouvel-onglet");
  await expect(fenetre.getByTestId("barre-commande")).toBeVisible();
  await fenetre.locator(onglets).nth(0).evaluate((el: HTMLElement) => el.click());
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await fermer();
});

test("un clic sur le voile ferme la barre", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "nouvel-onglet");
  await expect(fenetre.getByTestId("barre-commande")).toBeVisible();
  await fenetre.mouse.click(5, 5);
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await fermer();
});

test("⌃Tab par-dessus la barre : Échap annule le panneau ⌃Tab, la barre reste", async () => {
  const { app, fenetre, fermer } = await lancer();
  await deuxOnglets(fenetre);
  await menu(app, "nouvel-onglet");
  await expect(fenetre.getByTestId("barre-commande")).toBeVisible();
  await menu(app, "onglet-suivant");
  const panneau = fenetre.getByTestId("panneau-onglets");
  await expect(panneau).toBeVisible();
  await fenetre.keyboard.press("Escape");
  await expect(panneau).toHaveCount(0);
  await expect(fenetre.getByTestId("barre-commande")).toBeVisible();
  await fenetre.keyboard.press("Escape");
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await fermer();
});

test("Entrée à vide sur l'accueil avec l'historique ouvert : l'accueil, sans panneau", async () => {
  const { app, fenetre, fermer } = await lancer();
  await menu(app, "historique");
  await expect(fenetre.getByTestId("historique")).toBeVisible();
  await menu(app, "nouvel-onglet");
  await fenetre.getByTestId("saisie-commande").press("Enter");
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await expect(fenetre.getByTestId("historique")).toHaveCount(0);
  await expect(fenetre.getByTestId("page-vide")).toBeVisible();
  await fermer();
});

test("Échap rend le clavier à la page affichée", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await menu(app, "nouvel-onglet");
  await expect(fenetre.getByTestId("saisie-commande")).toBeFocused();
  await app.evaluate(({ webContents }) => {
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
  await fenetre.keyboard.press("Escape");
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const appels = (globalThis as { focusVues?: number[] }).focusVues ?? [];
        const affichee = BrowserWindow.getAllWindows()[0]!.contentView.children.map((v) => (v as Electron.WebContentsView).webContents).find(Boolean);
        return appels.length > 0 && appels.at(-1) === affichee?.id;
      }),
    )
    .toBe(true);
  await fermer();
});

const lignes = (fenetre: Page, type: string) => fenetre.locator(`[data-testid="ligne-commande"][data-type="${type}"]`);

test("une action se lance depuis la modale", async () => {
  const racine = nouvelleRacine();
  ecrireAction(racine, "sans-workflow", { nom: "Zorglub" });
  const { app, fenetre, fermer } = await lancer({ racine });
  await expect.poll(() => fenetre.evaluate(() => window.webaios.actions.liste().then((l) => l.some((a) => a.id === "sans-workflow"))), { timeout: 30_000 }).toBe(true);
  await menu(app, "nouvel-onglet");
  const saisie = fenetre.getByTestId("saisie-commande");
  await saisie.fill("Zorglub");
  await expect(lignes(fenetre, "action")).toHaveCount(1);
  await saisie.press("ArrowDown");
  await saisie.press("Enter");
  await expect(fenetre.getByTestId("page-action")).toBeVisible({ timeout: 30_000 });
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await fermer();
});

test("une action qui attend sa saisie : Entrée la demande, préremplie avec l'URL active toute sélectionnée ; Échap et ⌫ reviennent à la liste", async () => {
  const racine = nouvelleRacine();
  ecrireAction(racine, "resume", { nom: "Résumé vidéo", saisie: { libelle: "Vidéo" } });
  const { app, fenetre, fermer } = await lancer({ racine });
  await expect.poll(() => fenetre.evaluate(() => window.webaios.actions.liste().then((l) => l.some((a) => a.id === "resume"))), { timeout: 30_000 }).toBe(true);
  const url = `${serveur.url}/a.html`;
  await ouvrirOnglet(fenetre, url);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "nouvel-onglet");
  const saisie = fenetre.getByTestId("saisie-commande");
  await saisie.fill("résumé");
  await expect(lignes(fenetre, "action")).toHaveCount(1);
  await expect(lignes(fenetre, "action")).toContainText("Vidéo");
  await saisie.press("ArrowDown");
  await saisie.press("Enter");
  const parametre = fenetre.getByTestId("parametre-commande");
  await expect(fenetre.getByTestId("pastille-commande")).toHaveText("Résumé vidéo");
  await expect(parametre).toBeFocused();
  await expect(parametre).toHaveValue(url);
  expect(await parametre.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, url.length]);
  await expect(lignes(fenetre, "action")).toHaveCount(0);
  // Échap revient à la liste, le texte tapé intact, la barre reste ouverte.
  await parametre.press("Escape");
  await expect(saisie).toBeFocused();
  await expect(saisie).toHaveValue("résumé");
  await expect(fenetre.getByTestId("barre-commande")).toBeVisible();
  // L'action reste choisie : Tab la demande aussi ; ⌫ efface la sélection, puis ⌫ sur le champ vide revient à la liste.
  await expect(lignes(fenetre, "action")).toHaveAttribute("aria-selected", "true");
  await saisie.press("Tab");
  await expect(parametre).toHaveValue(url);
  await parametre.press("Backspace");
  await expect(parametre).toHaveValue("");
  await parametre.press("Backspace");
  await expect(saisie).toBeFocused();
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await fermer();
});

test("une action qui attend sa saisie, tapée avec elle (« résumé vidéo x ») : lancée sans la redemander", async () => {
  const racine = nouvelleRacine();
  ecrireAction(racine, "resume", { nom: "Résumé vidéo", saisie: { libelle: "Vidéo" } });
  const { app, fenetre, fermer } = await lancer({ racine });
  await expect.poll(() => fenetre.evaluate(() => window.webaios.actions.liste().then((l) => l.some((a) => a.id === "resume"))), { timeout: 30_000 }).toBe(true);
  await menu(app, "nouvel-onglet");
  const saisie = fenetre.getByTestId("saisie-commande");
  await saisie.fill("résumé vidéo https://y.fr/v");
  await expect(lignes(fenetre, "action")).toContainText("« https://y.fr/v »");
  await saisie.press("ArrowDown");
  await saisie.press("Enter");
  await expect(fenetre.getByTestId("page-action")).toBeVisible({ timeout: 30_000 });
  await expect(fenetre.getByTestId("parametre-commande")).toHaveCount(0);
  await fermer();
});

test("les lignes sont rangées sous un titre par section, chacune avec son icône", async () => {
  const racine = nouvelleRacine();
  ecrireAction(racine, "sans-workflow", { nom: "Page action" });
  const { app, fenetre, fermer } = await lancer({ racine });
  await expect.poll(() => fenetre.evaluate(() => window.webaios.actions.liste().then((l) => l.length > 0)), { timeout: 30_000 }).toBe(true);
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "nouvel-onglet");
  await fenetre.getByTestId("saisie-commande").fill("Page");
  await expect(lignes(fenetre, "onglet")).toHaveCount(1);
  await expect(fenetre.getByTestId("section-commande")).toHaveText(["Actions", "Onglets ouverts"]);
  for (const l of await fenetre.locator('[data-testid="ligne-commande"]').all()) await expect(l.locator(".pictogramme")).toHaveCount(1);
  await fermer();
});

test("un onglet ouvert s'active, sans nouvel onglet", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await ouvrirOnglet(fenetre, `${serveur.url}/b.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(2);
  await expect(fenetre.locator(actif)).toContainText("Page B");
  await expect(fenetre.locator(onglets).filter({ hasText: "Page A" })).toHaveCount(1);
  await menu(app, "nouvel-onglet");
  const saisie = fenetre.getByTestId("saisie-commande");
  await saisie.fill("Page A");
  await expect(lignes(fenetre, "onglet")).toHaveCount(1);
  await saisie.press("ArrowDown");
  await saisie.press("Enter");
  await expect(fenetre.locator(actif)).toContainText("Page A");
  await expect(fenetre.locator(onglets)).toHaveCount(2);
  await fermer();
});

test("↑ et ↓ font une boucle sur les lignes", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "nouvel-onglet");
  const saisie = fenetre.getByTestId("saisie-commande");
  await saisie.fill("Page A");
  await expect(lignes(fenetre, "onglet")).toHaveCount(1);
  const choisie = fenetre.locator('[data-testid="ligne-commande"][aria-selected="true"]');
  await expect(choisie).toHaveAttribute("data-type", "defaut");
  await saisie.press("ArrowUp");
  await expect(choisie).toHaveAttribute("data-type", "onglet");
  await saisie.press("ArrowDown");
  await expect(choisie).toHaveAttribute("data-type", "defaut");
  await fermer();
});

test("une appli de site s'ouvre", async () => {
  const sites = await serveurSites();
  try {
    sites.definir("vidola-a.localhost", "/", "<title>Vidola A</title>");
    const racine = nouvelleRacine();
    ecrireSite(racine, "vidola", {
      declaration: { nom: "Vidola", adresse: sites.url("vidola-a.localhost", "/"), domaines: ["vidola-a.localhost"], connexion: [] },
    });
    const { app, fenetre, fermer } = await lancer({ racine, env: { WEBAIOS_TEST_ADRESSES_LOCALES: "1" } });
    await expect.poll(() => fenetre.evaluate(() => window.webaios.sites.liste().then((l) => l.some((s) => s.id === "vidola"))), { timeout: 30_000 }).toBe(true);
    await menu(app, "nouvel-onglet");
    const saisie = fenetre.getByTestId("saisie-commande");
    await saisie.fill("Vidola");
    await expect(lignes(fenetre, "appli")).toHaveCount(1);
    await lignes(fenetre, "appli").locator("button").click();
    await fenetreSite(app, "vidola");
    await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
    await fermer();
  } finally {
    await sites.fermer();
  }
});

test("historique proposé après une visite", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/b.html`);
  await expect.poll(() => dansLaVue(app, "b.html", "document.title")).toBe("Page B");
  await expect
    .poll(() => fenetre.evaluate(() => window.webaios.historique.rechercher("b.html", 5, true).then((v) => v.length)), { timeout: 15_000 })
    .toBeGreaterThan(0);
  await menu(app, "nouvel-onglet");
  await fenetre.getByTestId("saisie-commande").fill("b.html");
  await expect(fenetre.locator('[data-testid="ligne-commande"][data-type="historique"], [data-testid="ligne-commande"][data-type="onglet"]').first()).toBeVisible();
  await fermer();
});

test("espace privé : pas d'action proposée", async () => {
  const racine = nouvelleRacine();
  ecrireAction(racine, "sans-workflow", { nom: "Zorglub" });
  const { app, fenetre, fermer } = await lancer({ racine });
  await expect.poll(() => fenetre.evaluate(() => window.webaios.actions.liste().then((l) => l.some((a) => a.id === "sans-workflow"))), { timeout: 30_000 }).toBe(true);
  await reglerEspaceActifPrive(fenetre, true);
  await menu(app, "nouvel-onglet");
  await fenetre.getByTestId("saisie-commande").fill("Zorglub");
  await expect(lignes(fenetre, "defaut")).toHaveCount(1);
  await fenetre.waitForTimeout(500);
  await expect(lignes(fenetre, "action")).toHaveCount(0);
  await fermer();
});

/** Un onglet tiers ouvert, l'agent du panneau démarré : de quoi lui faire demander la lecture de l'onglet. */
async function avecAgentEtOnglet() {
  const l = await lancer();
  await expect.poll(() => existsSync(join(l.racine, ".webaios", "mcp.json"))).toBe(true);
  await expect.poll(() => existsSync(join(l.racine, "faux-agent-pid")), { timeout: 10_000 }).toBe(true);
  await ouvrirOnglet(l.fenetre, `${serveur.url}/texte.html`);
  await expect.poll(() => dansLaVue(l.app, "texte.html", "document.title")).toBe("Texte");
  const titre = l.fenetre.locator(onglets, { hasText: "Texte" });
  await expect(titre).toHaveCount(1);
  const id = (await titre.getAttribute("data-testid"))!.slice("onglet-".length);
  return { ...l, id };
}
/** Lecture demandée par l'agent : la promesse ne rejette pas quand l'appli se ferme en fin de test. */
const lireOnglet = (racine: string, id: string) => {
  const p = appelerOutil(racine, "lire_onglet", { id }).then((r) => r.texte);
  p.catch(() => {});
  return p;
};
const enAttente = (p: Promise<unknown>, ms = 1500) => Promise.race([p.then(() => "répondue"), new Promise((ok) => setTimeout(() => ok("en attente"), ms))]);

test("Entrée dans la barre n'autorise pas la demande de l'agent cachée dessous", async () => {
  const { app, fenetre, racine, id, fermer } = await avecAgentEtOnglet();
  const lecture = lireOnglet(racine, id);
  const modale = fenetre.getByTestId("modale-demande");
  await expect(modale).toHaveAttribute("data-armee");
  await menu(app, "nouvel-onglet");
  const saisie = fenetre.getByTestId("saisie-commande");
  await expect(saisie).toBeFocused();
  await saisie.fill(`${serveur.url}/b.html`);
  await saisie.press("Enter");
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  expect(await enAttente(lecture)).toBe("en attente");
  await fermer();
});

test("Entrée dans la barre ne valide pas le brouillon des réglages d'espace caché dessous", async () => {
  const { app, fenetre, fermer } = await lancer();
  const boutonsEspace = fenetre.locator('[data-testid^="espace-"]');
  const avant = await boutonsEspace.count();
  await fenetre.getByTestId("nouvel-espace").click();
  const modale = fenetre.getByRole("dialog", { name: "Nouvel espace" });
  await modale.getByLabel("Nom de l'espace").fill("Jeux");
  await modale.getByLabel("Profil de connexion").selectOption({ label: "Nouveau profil" });
  await expect(modale.getByRole("button", { name: "Créer" })).toBeEnabled();
  await menu(app, "nouvel-onglet");
  const saisie = fenetre.getByTestId("saisie-commande");
  await expect(saisie).toBeFocused();
  await saisie.fill(`${serveur.url}/b.html`);
  await saisie.press("Enter");
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await fenetre.waitForTimeout(500);
  await expect(modale).toBeVisible();
  await expect(boutonsEspace).toHaveCount(avant);
  await fermer();
});

test("une demande de l'agent qui arrive pendant que la barre est ouverte la ferme, la demande est affichée", async () => {
  const { app, fenetre, racine, id, fermer } = await avecAgentEtOnglet();
  await menu(app, "nouvel-onglet");
  await expect(fenetre.getByTestId("saisie-commande")).toBeFocused();
  const lecture = lireOnglet(racine, id);
  await expect(fenetre.getByTestId("modale-demande")).toBeVisible();
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await expect.poll(() => fenetre.evaluate(() => !!document.activeElement?.closest('[data-testid="modale-demande"]'))).toBe(true);
  expect(await enAttente(lecture, 300)).toBe("en attente");
  await fermer();
});

test("sur l'accueil, Échap rend le clavier au champ de la page vide", async () => {
  const { app, fenetre, fermer } = await lancer();
  await expect(fenetre.getByTestId("saisie-page-vide")).toBeFocused();
  await menu(app, "nouvel-onglet");
  await expect(fenetre.getByTestId("saisie-commande")).toBeFocused();
  await fenetre.keyboard.press("Escape");
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await expect(fenetre.getByTestId("saisie-page-vide")).toBeFocused();
  await fermer();
});

test("Tab et ⇧Tab laissent le clavier dans le champ de la barre", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "nouvel-onglet");
  const saisie = fenetre.getByTestId("saisie-commande");
  await expect(saisie).toBeFocused();
  for (const t of ["Tab", "Tab", "Shift+Tab", "Tab"]) {
    await fenetre.keyboard.press(t);
    await expect(saisie).toBeFocused();
  }
  await fermer();
});

test("sur l'accueil, un clic sur le voile rend le clavier au champ de la page vide", async () => {
  const { app, fenetre, fermer } = await lancer();
  await menu(app, "nouvel-onglet");
  await expect(fenetre.getByTestId("saisie-commande")).toBeFocused();
  await fenetre.mouse.click(5, 5);
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await expect(fenetre.getByTestId("saisie-page-vide")).toBeFocused();
  await fermer();
});

/** Un clic dans la marge de la boîte, hors du champ et des lignes. */
const clicMarge = (fenetre: Page) => fenetre.getByTestId("barre-commande").click({ position: { x: 3, y: 3 } });

test("un clic dans la marge de la barre puis Entrée n'autorise pas la demande de l'agent dessous", async () => {
  const { app, fenetre, racine, id, fermer } = await avecAgentEtOnglet();
  const lecture = lireOnglet(racine, id);
  await expect(fenetre.getByTestId("modale-demande")).toHaveAttribute("data-armee");
  await menu(app, "nouvel-onglet");
  const saisie = fenetre.getByTestId("saisie-commande");
  await expect(saisie).toBeFocused();
  await clicMarge(fenetre);
  await expect(saisie).toBeFocused();
  await fenetre.keyboard.press("Enter");
  expect(await enAttente(lecture)).toBe("en attente");
  await fermer();
});

test("un clic dans la marge de la barre, Tab puis Espace n'autorisent pas la demande de l'agent dessous", async () => {
  const { app, fenetre, racine, id, fermer } = await avecAgentEtOnglet();
  const lecture = lireOnglet(racine, id);
  await expect(fenetre.getByTestId("modale-demande")).toHaveAttribute("data-armee");
  await menu(app, "nouvel-onglet");
  await expect(fenetre.getByTestId("saisie-commande")).toBeFocused();
  await clicMarge(fenetre);
  await fenetre.keyboard.press("Tab");
  await fenetre.keyboard.press("Space");
  expect(await fenetre.evaluate(() => !!document.activeElement?.closest('[data-testid="modale-demande"]'))).toBe(false);
  expect(await enAttente(lecture)).toBe("en attente");
  await fermer();
});

test("barre ouverte, clavier hors du champ : Entrée et Espace n'atteignent pas la demande de l'agent dessous", async () => {
  const { app, fenetre, racine, id, fermer } = await avecAgentEtOnglet();
  const lecture = lireOnglet(racine, id);
  await expect(fenetre.getByTestId("modale-demande")).toHaveAttribute("data-armee");
  await menu(app, "nouvel-onglet");
  await expect(fenetre.getByTestId("saisie-commande")).toBeFocused();
  // Le filet : même si le clavier quitte le champ, la modale cachée ne réagit pas tant que la barre est ouverte.
  await fenetre.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (const t of ["Enter", "Space", "Enter"]) await fenetre.keyboard.press(t);
  await expect(fenetre.getByTestId("barre-commande")).toBeVisible();
  expect(await enAttente(lecture)).toBe("en attente");
  await fermer();
});

test("un clic dans la marge de la barre puis Entrée ne valide pas le brouillon des réglages d'espace dessous", async () => {
  const { app, fenetre, fermer } = await lancer();
  const boutonsEspace = fenetre.locator('[data-testid^="espace-"]');
  const avant = await boutonsEspace.count();
  await fenetre.getByTestId("nouvel-espace").click();
  const modale = fenetre.getByRole("dialog", { name: "Nouvel espace" });
  await modale.getByLabel("Nom de l'espace").fill("Jeux");
  await modale.getByLabel("Profil de connexion").selectOption({ label: "Nouveau profil" });
  await expect(modale.getByRole("button", { name: "Créer" })).toBeEnabled();
  await menu(app, "nouvel-onglet");
  await expect(fenetre.getByTestId("saisie-commande")).toBeFocused();
  await clicMarge(fenetre);
  await fenetre.keyboard.press("Enter");
  await fenetre.waitForTimeout(500);
  await expect(modale).toBeVisible();
  await expect(boutonsEspace).toHaveCount(avant);
  await fermer();
});
