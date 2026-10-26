import { expect, test, type ElectronApplication } from "@playwright/test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ecrireBloc, ecrireDisposition, lancer, nouvelleRacine, ouvrirOnglet, serveurTest } from "./aide";

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => (serveur = await serveurTest()));
test.afterAll(() => serveur.fermer());

const onglets = '[data-testid^="onglet-"]';
const titres = '[data-testid^="bloc-"] [data-testid="titre-bloc"]';
const iframe = (id: string) => `[data-testid="bloc-${id}"] iframe`;
const urls = (app: ElectronApplication) =>
  app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => `${w.getType()} ${w.getURL()}`));

test("la page d'accueil affiche les blocs dans l'ordre de disposition.json, avec le panneau agent ouvert", async () => {
  const racine = nouvelleRacine();
  ecrireBloc(racine, "veille", { titre: "Veille", type: "agent", html: "<p>Article du jour</p>" });
  ecrireBloc(racine, "app", { titre: "Page A", type: "app", url: `${serveur.url}/a.html` });
  ecrireDisposition(racine, ["app", "veille"]);
  const { app, fenetre, fermer } = await lancer({ racine });
  await expect(fenetre.locator(titres)).toHaveText(["Page A", "Veille"]);
  await expect(fenetre.frameLocator(iframe("veille")).locator("p")).toHaveText("Article du jour");
  await expect
    .poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getType() === "webview")?.getTitle()))
    .toBe("Page A");
  await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
  await fermer();
});

test("fermer le panneau sur la page d'accueil le laisse fermé", async () => {
  const { fenetre, fermer } = await lancer();
  await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
  await fenetre.getByTestId("bouton-agent").click();
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await new Promise((r) => setTimeout(r, 500));
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await fermer();
});

test("quitter la page d'accueil referme le panneau qui ne s'était ouvert que pour elle, y revenir le rouvre", async () => {
  const { fenetre, fermer } = await lancer();
  await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await fenetre.getByTestId("nouvel-onglet").click();
  await expect(fenetre.getByTestId("page-vide")).toBeVisible();
  await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
  await fermer();
});

test("l'agent écrit un nouveau bloc : il apparaît sans recharger", async () => {
  const { fenetre, racine, fermer } = await lancer();
  await expect(fenetre.getByTestId("page-vide")).toBeVisible();
  await new Promise((r) => setTimeout(r, 1000)); // surveillance du dossier en place
  ecrireBloc(racine, "nouveau", { titre: "Nouveau", type: "agent", html: "<p>tout neuf</p>" });
  await expect(fenetre.locator(titres)).toHaveText(["Nouveau"], { timeout: 5000 });
  await expect(fenetre.frameLocator(iframe("nouveau")).locator("p")).toHaveText("tout neuf");
  await fermer();
});

test("modifier index.html met le bloc à jour", async () => {
  const racine = nouvelleRacine();
  ecrireBloc(racine, "veille", { titre: "Veille", type: "agent", html: "<p>avant</p>" });
  const { fenetre, fermer } = await lancer({ racine });
  await expect(fenetre.frameLocator(iframe("veille")).locator("p")).toHaveText("avant");
  writeFileSync(join(racine, "accueil", "blocs", "veille", "index.html"), "<p>après</p>");
  await expect(fenetre.frameLocator(iframe("veille")).locator("p")).toHaveText("après", { timeout: 5000 });
  await fermer();
});

test("un lien d'un bloc s'ouvre dans un onglet", async () => {
  const racine = nouvelleRacine();
  ecrireBloc(racine, "veille", { titre: "Veille", type: "agent", html: `<a id="lien" href="${serveur.url}/b.html">B</a>` });
  const { fenetre, fermer } = await lancer({ racine });
  const lien = fenetre.frameLocator(iframe("veille")).locator("#lien");
  await expect(lien).toBeVisible();
  // Le relâchement du clic ne rend parfois jamais la main à Playwright (la vue du nouvel onglet recouvre l'interface
  // à cet instant) : on ne l'attend pas, l'onglet ouvert suffit comme preuve.
  const b = (await lien.boundingBox())!;
  await fenetre.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await fenetre.mouse.down();
  void fenetre.mouse.up().catch(() => {});
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await expect(fenetre.locator(onglets)).toContainText("Page B");
  await fermer();
});

test("un script dans index.html ne s'exécute pas", async () => {
  const racine = nouvelleRacine();
  ecrireBloc(racine, "veille", { titre: "Veille", type: "agent", html: "<script>document.body.innerHTML='PIRATE'</script><p>sain</p>" });
  const { fenetre, fermer } = await lancer({ racine });
  const cadre = fenetre.frameLocator(iframe("veille"));
  await expect(cadre.locator("p")).toHaveText("sain");
  await new Promise((r) => setTimeout(r, 500));
  await expect(cadre.locator("body")).not.toContainText("PIRATE");
  await expect(fenetre.getByTestId("saisie-page-vide")).toBeVisible();
  await fermer();
});

test("une webview injectée avec file:// ou un preload n'est pas attachée", async () => {
  const { app, fenetre, fermer } = await lancer();
  await expect(fenetre.getByTestId("page-vide")).toBeVisible();
  await fenetre.evaluate(() => {
    const w = document.createElement("webview");
    w.setAttribute("src", "file:///etc/hosts");
    document.body.append(w);
    const p = document.createElement("webview");
    p.setAttribute("src", "about:blank");
    p.setAttribute("preload", "file:///tmp/x.js");
    document.body.append(p);
  });
  await new Promise((r) => setTimeout(r, 2000));
  const toutes = await urls(app);
  expect(toutes.filter((u) => u.startsWith("webview"))).toEqual([]);
  await fermer();
});

test("statuts : mise à jour…, échec avec date, bloc illisible", async () => {
  const racine = nouvelleRacine();
  const maintenant = new Date().toISOString();
  ecrireBloc(racine, "enCours".toLowerCase(), { titre: "En cours", type: "agent", html: "<p>ancien</p>" });
  ecrireBloc(racine, "rate", {
    titre: "Raté",
    type: "agent",
    html: "<p>vieux contenu</p>",
    etat: { derniereMaj: "2026-10-20T08:00:00.000Z", derniereTentative: maintenant, statut: "erreur", erreur: "délai dépassé" },
  });
  mkdirSync(join(racine, "accueil", "blocs", "casse"), { recursive: true });
  writeFileSync(join(racine, "accueil", "blocs", "casse", "bloc.json"), "{ pas du json");
  const { fenetre, fermer } = await lancer({ racine });
  await expect(fenetre.getByTestId("bloc-casse")).toContainText("Bloc « casse » illisible");
  const rate = fenetre.getByTestId("bloc-rate");
  await expect(rate).toContainText("Échec de la mise à jour du");
  await expect(rate).toContainText("délai dépassé");
  await expect(fenetre.frameLocator(iframe("rate")).locator("p")).toHaveText("vieux contenu");
  // Pendant que l'app tourne : au lancement, un bloc « en-cours » serait relancé par le planificateur.
  writeFileSync(
    join(racine, "accueil", "blocs", "encours", "etat.json"),
    JSON.stringify({ derniereMaj: maintenant, derniereTentative: maintenant, statut: "en-cours" }),
  );
  await expect(fenetre.getByTestId("bloc-encours")).toContainText("mise à jour…", { timeout: 5000 });
  await fermer();
});

test("sans dossier accueil lisible, la page vide reste utilisable", async () => {
  const racine = nouvelleRacine();
  chmodSync(join(racine, "accueil"), 0o000);
  try {
    const { fenetre, fermer } = await lancer({ racine });
    await fenetre.getByTestId("saisie-page-vide").fill(`${serveur.url}/a.html`);
    await fenetre.getByTestId("saisie-page-vide").press("Enter");
    await expect(fenetre.locator(onglets)).toHaveCount(1);
    await fermer();
  } finally {
    chmodSync(join(racine, "accueil"), 0o755);
  }
});
