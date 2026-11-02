import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ecrireProjet, lancer, nouvelleRacine, ouvrirOnglet } from "./aide";

// La page Relecture : le diff d'un projet depuis sa dernière relecture, en lecture seule.
const ENV = { WEBAIOS_PORTS_APPS: "15280-15284", WEBAIOS_PORT_MCP_EXTERNE: "0" };

const menu = (app: ElectronApplication, id: string) => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.click(), id);
const aucuneFenetreVisible = async (app: ElectronApplication) =>
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()))).toBe(false);

const LIGNES = Array.from({ length: 30 }, (_, i) => `ligne ${i + 1}`);
const ecrireAppJs = (racine: string, lignes: string[]) => writeFileSync(join(racine, "projets", "essai", "app.js"), lignes.join("\n") + "\n");

/** Une racine avec `projets/essai` (Essai), son `app.js` de 30 lignes et `logo.bin`. */
function racineEssai(): string {
  const racine = nouvelleRacine();
  ecrireProjet(racine, "essai", { manifeste: { nom: "Essai" }, serveur: "formulaire" });
  ecrireAppJs(racine, LIGNES);
  writeFileSync(join(racine, "projets", "essai", "logo.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return racine;
}

const refRelu = (profil: string) => join(profil, "design", "relecture", "app-essai.git", "refs", "webaios", "relu");

/** Lance le navigateur sur la racine et attend la première photo de essai. */
async function demarrer(racine: string, env: Record<string, string> = {}) {
  const l = await lancer({ racine, env: { ...ENV, ...env } });
  if (!env.WEBAIOS_GIT) await expect.poll(() => existsSync(refRelu(l.profil)), { timeout: 15_000 }).toBe(true);
  return l;
}

/** « Relire » de la carte essai, sur la page Applications. */
async function relireDepuisCarte(app: ElectronApplication, fenetre: Page) {
  await menu(app, "applications");
  await fenetre.getByTestId("appli-essai").getByRole("button", { name: "Relire" }).click();
  const page = fenetre.getByTestId("page-relecture");
  await expect(page).toBeVisible();
  return page;
}

const fichier = (page: ReturnType<Page["getByTestId"]>, chemin: string) => page.getByTestId("fichier-relecture").filter({ hasText: chemin });
/** Numéros (nouveaux) des lignes de contexte affichées. */
const contexte = (page: ReturnType<Page["getByTestId"]>) =>
  page.locator('[data-testid="ligne-diff"].contexte').evaluateAll((ls) => ls.map((l) => Number((l as HTMLElement).dataset.nouveau)));

test("au démarrage, la première photo de essai est prise (refs/webaios/relu sous <profil>/design/relecture/app-essai.git) et aucun .git n'apparaît dans projets/essai", async () => {
  const racine = racineEssai();
  const { app, profil, fermer } = await demarrer(racine);
  try {
    expect(existsSync(refRelu(profil))).toBe(true);
    expect(readdirSync(join(racine, "projets", "essai")).sort()).toEqual(["app.js", "logo.bin", "serveur.mjs", "webaios.json"]);
    expect(existsSync(join(racine, "projets", ".git"))).toBe(false);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("après modification de app.js (ligne 15) et ajout de note.md : « Relire » de la carte essai ouvre page-relecture avec app.js (~) et note.md (+) ; app.js montre la ligne 15 en retrait et en ajout, 3 lignes de contexte de chaque côté", async () => {
  const racine = racineEssai();
  const { app, fenetre, fermer } = await demarrer(racine);
  try {
    ecrireAppJs(racine, LIGNES.map((l, i) => (i === 14 ? "ligne 15 modifiée" : l)));
    writeFileSync(join(racine, "projets", "essai", "note.md"), "# Note\n");
    const page = await relireDepuisCarte(app, fenetre);
    await expect(fenetre.getByRole("tab", { name: /Relecture — Essai/ })).toHaveCount(1);
    await expect(page.getByTestId("fichier-relecture")).toHaveCount(2);
    await expect(fichier(page, "app.js")).toContainText("~");
    await expect(fichier(page, "app.js")).toContainText("+1 −1");
    await expect(fichier(page, "note.md")).toContainText("+");
    await fichier(page, "app.js").click();
    await expect(page.locator('[data-testid="ligne-diff"].retrait')).toHaveText(["15ligne 15"]);
    await expect(page.locator('[data-testid="ligne-diff"].ajout')).toHaveText(["15ligne 15 modifiée"]);
    expect(await contexte(page)).toEqual([12, 13, 14, 16, 17, 18]);
    // Lecture seule : aucun champ éditable sur le code.
    await expect(page.locator("textarea, input, [contenteditable]")).toHaveCount(0);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("deplier-contexte montre les lignes 1 à 11", async () => {
  const racine = racineEssai();
  const { app, fenetre, fermer } = await demarrer(racine);
  try {
    ecrireAppJs(racine, LIGNES.map((l, i) => (i === 14 ? "ligne 15 modifiée" : l)));
    const page = await relireDepuisCarte(app, fenetre);
    await fichier(page, "app.js").click();
    await expect.poll(() => contexte(page)).toEqual([12, 13, 14, 16, 17, 18]);
    await page.getByTestId("deplier-contexte").first().click();
    await expect.poll(() => contexte(page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18]);
    await expect(page.locator('[data-testid="ligne-diff"][data-nouveau="1"]')).toHaveText("11ligne 1");
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("logo.bin modifié (octet NUL) : « fichier binaire »", async () => {
  const racine = racineEssai();
  const { app, fenetre, fermer } = await demarrer(racine);
  try {
    writeFileSync(join(racine, "projets", "essai", "logo.bin"), Buffer.from([0x89, 0x00, 0x4e, 0x47]));
    const page = await relireDepuisCarte(app, fenetre);
    await fichier(page, "logo.bin").click();
    await expect(page.getByTestId("diff-fichier")).toContainText("fichier binaire");
    await expect(page.getByTestId("ligne-diff")).toHaveCount(0);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("fichier modifié pendant que la page est ouverte : rien ne change avant « Rafraîchir », puis le nouveau diff", async () => {
  const racine = racineEssai();
  const { app, fenetre, fermer } = await demarrer(racine);
  try {
    ecrireAppJs(racine, LIGNES.map((l, i) => (i === 14 ? "ligne 15 modifiée" : l)));
    const page = await relireDepuisCarte(app, fenetre);
    await fichier(page, "app.js").click();
    await expect(page.locator('[data-testid="ligne-diff"].ajout')).toHaveText(["15ligne 15 modifiée"]);
    ecrireAppJs(racine, LIGNES.map((l, i) => (i === 14 ? "ligne 15 modifiée" : i === 24 ? "ligne 25 modifiée" : l)));
    writeFileSync(join(racine, "projets", "essai", "autre.txt"), "autre\n");
    await new Promise((r) => setTimeout(r, 1500));
    await fichier(page, "app.js").click();
    await expect(page.locator('[data-testid="ligne-diff"].ajout')).toHaveText(["15ligne 15 modifiée"]);
    await expect(page.getByTestId("fichier-relecture")).toHaveCount(1);
    await page.getByRole("button", { name: "Rafraîchir" }).click();
    await expect(page.getByTestId("fichier-relecture")).toHaveCount(2);
    await expect(page.locator('[data-testid="ligne-diff"].ajout')).toHaveText(["15ligne 15 modifiée", "25ligne 25 modifiée"]);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("fichier modifié, puis un autre onglet et retour : la page montre encore l'ancien diff jusqu'à « Rafraîchir »", async () => {
  const racine = racineEssai();
  const { app, fenetre, fermer } = await demarrer(racine);
  try {
    ecrireAppJs(racine, LIGNES.map((l, i) => (i === 14 ? "ligne 15 modifiée" : l)));
    const page = await relireDepuisCarte(app, fenetre);
    await fichier(page, "app.js").click();
    await expect(page.locator('[data-testid="ligne-diff"].ajout')).toHaveText(["15ligne 15 modifiée"]);
    ecrireAppJs(racine, LIGNES.map((l, i) => (i === 14 ? "ligne 15 modifiée" : i === 24 ? "ligne 25 modifiée" : l)));
    // Un autre onglet (la page Applications), puis retour sur l'onglet Relecture : la page est remontée.
    await fenetre.getByRole("tab", { name: /Applications/ }).click();
    await expect(page).toHaveCount(0);
    await fenetre.getByRole("tab", { name: /Relecture — Essai/ }).click();
    await expect(page).toBeVisible();
    await fichier(page, "app.js").click();
    await expect(page.locator('[data-testid="ligne-diff"].ajout')).toHaveText(["15ligne 15 modifiée"]);
    await page.getByRole("button", { name: "Rafraîchir" }).click();
    await expect(page.locator('[data-testid="ligne-diff"].ajout')).toHaveText(["15ligne 15 modifiée", "25ligne 25 modifiée"]);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("« Relire ce projet » depuis la pastille de la fenêtre d'appli essai, puis depuis le menu relire-projet, ramènent la même page, sans second onglet", async () => {
  const racine = racineEssai();
  const { app, fenetre, fermer } = await demarrer(racine);
  try {
    await menu(app, "applications");
    const ligne = fenetre.getByTestId("appli-essai");
    await ligne.getByRole("button", { name: "Lancer" }).click();
    await expect(ligne).toHaveAttribute("data-etat", "en-marche", { timeout: 15_000 });
    let pastille: Page | undefined;
    for (const fin = Date.now() + 10_000; !pastille && Date.now() < fin; await new Promise((r) => setTimeout(r, 100)))
      pastille = app.windows().find((x) => x.url().includes("pastille.html"));
    expect(pastille).toBeTruthy();
    await pastille!.getByTestId("pastille-webaios").click();
    await pastille!.getByRole("menuitem", { name: "Relire ce projet" }).click();
    await expect(fenetre.getByTestId("page-relecture")).toBeVisible();
    const onglets = fenetre.getByRole("tab", { name: /Relecture — Essai/ });
    await expect(onglets).toHaveCount(1);
    // L'appli dans un onglet de la fenêtre principale : le menu « Relire ce projet » vise son projet.
    const url = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => /^http:\/\/localhost:1528\d\//.test(w.getURL()))!.getURL());
    await ouvrirOnglet(fenetre, url);
    await expect(fenetre.getByTestId("page-relecture")).toHaveCount(0);
    await expect.poll(() => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().filter((w) => w.getURL() === url && !w.isLoading()).length, url)).toBe(2);
    await expect(fenetre.getByTestId("bouton-design")).toBeEnabled();
    await menu(app, "relire-projet");
    await expect(fenetre.getByTestId("page-relecture")).toBeVisible();
    await expect(onglets).toHaveCount(1);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("WEBAIOS_GIT=/chemin/absent : la page affiche « git est nécessaire » et le mode design marche toujours", async () => {
  const racine = racineEssai();
  const { app, fenetre, profil, fermer } = await demarrer(racine, { WEBAIOS_GIT: "/chemin/absent" });
  try {
    const page = await relireDepuisCarte(app, fenetre);
    await expect(page).toContainText("git est nécessaire");
    expect(existsSync(refRelu(profil))).toBe(false);
    // Le mode design, lui, ne dépend pas de git.
    const ligne = fenetre.getByTestId("appli-essai");
    await menu(app, "applications");
    await ligne.getByRole("button", { name: "Lancer" }).click();
    await expect(ligne).toHaveAttribute("data-etat", "en-marche", { timeout: 15_000 });
    const url = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => /^http:\/\/localhost:1528\d\//.test(w.getURL()))!.getURL());
    await ouvrirOnglet(fenetre, url);
    const bouton = fenetre.getByTestId("bouton-design");
    await expect(bouton).toBeEnabled();
    await bouton.click();
    await expect(bouton).toHaveAttribute("aria-pressed", "true");
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});
