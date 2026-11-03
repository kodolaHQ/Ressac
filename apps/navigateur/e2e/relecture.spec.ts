import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ecrireProjet, entreeAgent, lancer, nouvelleRacine, ouvrirOnglet } from "./aide";

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

// --- Tâche 12 : commenter, envoyer les commentaires, marquer comme relu.

const PLAGE_HORS_BLOC = "Un commentaire porte sur des lignes d'un seul bloc du diff.";
const LIGNE_CHANGEE = "la ligne a changé";
const modifie = (...n: number[]) => LIGNES.map((l, i) => (n.includes(i + 1) ? `${l} modifiée` : l));
type Zone = ReturnType<Page["getByTestId"]>;
/** La ligne affichée de numéro nouveau `n` (l'ajout pour une ligne modifiée). */
const ligne = (page: Zone, n: number) => page.locator(`[data-testid="ligne-diff"][data-nouveau="${n}"]`);
const plus = (page: Zone, n: number) => ligne(page, n).getByTestId("ajouter-commentaire");

async function commenter(page: Zone, texte: string) {
  const f = page.getByTestId("formulaire-commentaire");
  await expect(f).toBeVisible();
  await f.locator("textarea").fill(texte);
  await f.getByRole("button", { name: "Commenter" }).click();
  await expect(f).toHaveCount(0);
}

/** app.js modifié (lignes `n`), la page Relecture ouverte sur app.js. */
async function pageSurAppJs(app: ElectronApplication, fenetre: Page, racine: string, ...n: number[]) {
  ecrireAppJs(racine, modifie(...n));
  const page = await relireDepuisCarte(app, fenetre);
  await fichier(page, "app.js").click();
  await expect(ligne(page, n[0]!)).toBeVisible();
  return page;
}

test("+ sur la ligne 15 de app.js, « garder l'ancien nom » : un commentaire sous la ligne ; « Envoyer 1 commentaire à l'agent » : entreeAgent contient « 1) app.js:15-15 : « garder l'ancien nom » » et pas de \\r ; le commentaire affiche « envoyé »", async () => {
  const racine = racineEssai();
  const { app, fenetre, fermer } = await demarrer(racine);
  try {
    const page = await pageSurAppJs(app, fenetre, racine, 15);
    await plus(page, 15).click();
    await commenter(page, "garder l'ancien nom");
    const c = page.getByTestId("commentaire");
    await expect(c).toHaveCount(1);
    await expect(c).toContainText("garder l'ancien nom");
    await expect(c).toContainText("Ligne 15");
    expect(await c.evaluate((el) => (el.previousElementSibling as HTMLElement | null)?.dataset.nouveau)).toBe("15");
    await expect(c).not.toContainText("envoyé");
    const envoyer = page.getByTestId("envoyer-commentaires");
    await expect(envoyer).toHaveText("Envoyer 1 commentaire à l'agent");
    await envoyer.click();
    await expect.poll(() => entreeAgent(racine)).toContain(`1) "app.js":15-15 : « garder l'ancien nom »`);
    expect(entreeAgent(racine)).toContain("/workspace/.webaios/remarques/app-essai/");
    await new Promise((r) => setTimeout(r, 300));
    expect(entreeAgent(racine)).not.toContain("\r");
    await expect(c).toContainText("envoyé");
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("Maj+clic de la ligne 13 à 16 : le commentaire couvre 13–16 ; une plage sur deux blocs est refusée", async () => {
  const racine = racineEssai();
  const { app, fenetre, fermer } = await demarrer(racine);
  try {
    const page = await pageSurAppJs(app, fenetre, racine, 15, 25);
    await plus(page, 13).click();
    await plus(page, 16).click({ modifiers: ["Shift"] });
    await expect(page.locator('[data-testid="ligne-diff"].choisie')).toHaveCount(5);
    await commenter(page, "tout ce passage");
    const c = page.getByTestId("commentaire");
    await expect(c).toHaveCount(1);
    await expect(c).toContainText("Lignes 13–16");
    expect(await c.evaluate((el) => (el.previousElementSibling as HTMLElement | null)?.dataset.nouveau)).toBe("16");
    // De la ligne 13 (premier bloc) à la ligne 25 (second bloc) : refusé.
    await plus(page, 13).click();
    await plus(page, 25).click({ modifiers: ["Shift"] });
    await expect(page.getByTestId("erreur-commentaire")).toHaveText(PLAGE_HORS_BLOC);
    await expect(page.locator('[data-testid="ligne-diff"].choisie')).toHaveCount(1);
    await page.getByTestId("formulaire-commentaire").getByRole("button", { name: "Annuler" }).click();
    await expect(page.getByTestId("commentaire")).toHaveCount(1);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("ajout de 3 lignes en tête de app.js puis Rafraîchir : le commentaire suit à la ligne 18 sans LIGNE_CHANGEE ; ligne 18 réécrite puis Rafraîchir : LIGNE_CHANGEE", async () => {
  const racine = racineEssai();
  const { app, fenetre, fermer } = await demarrer(racine);
  try {
    const page = await pageSurAppJs(app, fenetre, racine, 15);
    await plus(page, 15).click();
    await commenter(page, "garder l'ancien nom");
    ecrireAppJs(racine, ["a", "b", "c", ...modifie(15)]);
    await page.getByRole("button", { name: "Rafraîchir" }).click();
    const c = page.getByTestId("commentaire");
    await expect(c).toContainText("Ligne 18");
    await expect(c).not.toContainText(LIGNE_CHANGEE);
    expect(await c.evaluate((el) => (el.previousElementSibling as HTMLElement | null)?.dataset.nouveau)).toBe("18");
    ecrireAppJs(racine, ["a", "b", "c", ...LIGNES.map((l, i) => (i === 14 ? "ligne 15 réécrite" : l))]);
    await page.getByRole("button", { name: "Rafraîchir" }).click();
    await expect(c).toContainText(LIGNE_CHANGEE);
    await expect(c).toContainText("garder l'ancien nom");
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("Résoudre puis Marquer comme relu : plus aucun fichier, le commentaire résolu a disparu, un non résolu reste rattaché à app.js", async () => {
  const racine = racineEssai();
  const { app, fenetre, fermer } = await demarrer(racine);
  try {
    const page = await pageSurAppJs(app, fenetre, racine, 15);
    await plus(page, 15).click();
    await commenter(page, "à résoudre");
    await plus(page, 13).click();
    await commenter(page, "reste ouvert");
    const resolu = page.getByTestId("commentaire").filter({ hasText: "à résoudre" });
    await resolu.getByRole("button", { name: "Résoudre" }).click();
    await expect(resolu).toContainText("résolu");
    await expect(page.getByTestId("envoyer-commentaires")).toHaveText("Envoyer 1 commentaire à l'agent");
    await page.getByTestId("marquer-relu").click();
    await expect(page.getByTestId("fichier-relecture")).toHaveCount(0);
    await expect(page.getByTestId("commentaire-relecture")).toHaveCount(1);
    await expect(page.getByTestId("commentaire-relecture")).toContainText("reste ouvert");
    await expect(page.getByTestId("commentaire-relecture")).toContainText("app.js");
    await expect(page).not.toContainText("à résoudre");
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("projet externe (déclaré comme à la tâche 10) : « Envoyer 1 commentaire à Claude Code (…) », lire_remarques rend type relecture avec fichier et lignes ; rien n'est pré-rempli", async () => {
  const parent = mkdtempSync(join(tmpdir(), "webaios-externe-"));
  const dossier = join(parent, "mon-site");
  mkdirSync(dossier);
  const reel = realpathSync(dossier);
  writeFileSync(join(reel, "app.js"), LIGNES.join("\n") + "\n");
  test.setTimeout(60_000);
  const { app, fenetre, profil, racine, fermer } = await lancer({ env: ENV });
  let c: Client | undefined;
  try {
    await expect.poll(() => app.evaluate(({ Menu }) => !!Menu.getApplicationMenu()?.getMenuItemById("applications"))).toBe(true);
    await menu(app, "applications");
    const section = fenetre.getByTestId("projets-externes");
    await section.getByTestId("brancher-externe").click();
    await section.getByTestId("valider-brancher").click();
    const commande = (await section.getByTestId("commande-branchement").textContent()) ?? "";
    const m = /http:\/\/127\.0\.0\.1:(\d+)\/mcp-externe --header "Authorization: Bearer ([0-9a-f]{64})"/.exec(commande)!;
    c = new Client({ name: "essai", version: "1.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${m[1]}/mcp-externe`), { requestInit: { headers: { Authorization: `Bearer ${m[2]}` } } }));
    await c.callTool({ name: "declarer_projet", arguments: { dossier: reel, ports: [18765] } });
    const id = createHash("sha256").update(reel).digest("hex").slice(0, 16);
    await expect.poll(() => existsSync(join(profil, "design", "relecture", `ext-${id}.git`, "refs", "webaios", "relu")), { timeout: 15_000 }).toBe(true);
    writeFileSync(join(reel, "app.js"), modifie(2).join("\n") + "\n");
    const ligneProjet = fenetre.getByTestId("projet-externe");
    await expect(ligneProjet).toHaveCount(1);
    await ligneProjet.getByRole("button", { name: "Relire" }).click();
    const page = fenetre.getByTestId("page-relecture");
    await expect(page).toBeVisible();
    await fichier(page, "app.js").click();
    await expect(ligne(page, 2)).toContainText("ligne 2 modifiée");
    await expect(plus(page, 2)).toHaveCount(1, { timeout: 2000 });
    await plus(page, 2).click();
    await commenter(page, "renommer");
    const envoyer = page.getByTestId("envoyer-commentaires");
    await expect(envoyer).toHaveText("Envoyer 1 commentaire à Claude Code (Claude Code)");
    await envoyer.click();
    await expect(page.getByTestId("commentaire")).toContainText("envoyé");
    const lu = await c.callTool({ name: "lire_remarques", arguments: { dossier: reel } });
    const texte = ((lu as { content: { type: string; text?: string }[] }).content ?? []).map((x) => x.text ?? "").join("\n");
    expect(texte).toContain("(relecture, lot ");
    expect(texte).toContain("texte de l'utilisateur : renommer");
    expect(texte).toContain('Fichier : "app.js", lignes 2–2');
    expect(texte).toContain("-ligne 2\n+ligne 2 modifiée");
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(join(racine, "faux-agent-entree.txt"))).toBe(false);
    await aucuneFenetreVisible(app);
  } finally {
    await c?.close().catch(() => undefined);
    await fermer();
  }
});

test("rouvrir le fichier déjà affiché (second clic dans la liste) ne ferme pas le commentaire en cours", async () => {
  const racine = racineEssai();
  const { app, fenetre, fermer } = await demarrer(racine);
  try {
    const page = await pageSurAppJs(app, fenetre, racine, 15);
    await plus(page, 15).click();
    const f = page.getByTestId("formulaire-commentaire");
    await expect(f).toBeVisible();
    await f.locator("textarea").fill("en cours");
    await fichier(page, "app.js").click();
    await new Promise((r) => setTimeout(r, 500));
    await expect(f).toBeVisible();
    await expect(f.locator("textarea")).toHaveValue("en cours");
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});
