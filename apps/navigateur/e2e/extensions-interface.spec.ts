import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dansLaVue, lancer, nouveauProfil, nouvelleRacine, ouvrirOnglet, serveurTest } from "./aide";
import { construireCrx } from "./extensions/crx";
import { ecrireExtension, ecrireExtensionAgent, EXTENSIONS_TEST, installerStoreFactice } from "./extensions/fixtures";

// La carte d'accord des extensions, posée au démarrage par WEBAIOS_TEST_CARTE_EXTENSION (ni Store, ni agent) ; la
// réponse de l'utilisateur est notée dans `<chemin>.reponse`. Tout reste invisible. La session est écrite avant le lancement :
// deux espaces connus (« Perso » e1 et « Lecture » e2, même profil), que la carte vise.

const MODALE = "modale-demande";
const CARTE = "demande-extension";

const carte = (champs: Record<string, unknown> = {}) => ({
  cle: "agent:essai",
  nom: "Essai",
  source: "agent",
  version: "1.0.0",
  droits: ["Modifier l'apparence et le contenu des pages"],
  sites: ["https://exemple.com/*"],
  tousLesSites: false,
  reseau: [],
  renforce: false,
  espace: "Perso",
  espaceId: "e1",
  autresEspaces: [],
  remplaceAussi: [],
  maj: null,
  empreinte: "0".repeat(64),
  ...champs,
});

const session = {
  version: 2,
  espaces: [
    { id: "e1", nom: "Perso", icone: "🏠", epingles: [], prive: false, profil: "defaut" },
    { id: "e2", nom: "Lecture", icone: "📚", epingles: [], prive: false, profil: "defaut" },
  ],
  profils: [{ id: "defaut" }],
  essentiels: [],
  onglets: {},
  fenetres: [
    { id: "f1", espaceActif: "e1", ordre: { e1: [], e2: [] }, actif: { e1: null, e2: null }, compact: false, panneauAgentOuvert: false, fermesRecemment: [], cadre: null },
  ],
  reglages: { moteur: "google", profilAgent: "claude", largeurPanneauAgent: 420 },
};

async function avecCarte(c: Record<string, unknown>) {
  const profil = nouveauProfil();
  writeFileSync(join(profil, "session.json"), JSON.stringify(session));
  const chemin = join(profil, "carte-extension.json");
  writeFileSync(chemin, JSON.stringify(c));
  const lance = await lancer({ profil, env: { WEBAIOS_TEST_CARTE_EXTENSION: chemin } });
  const reponse = () => (existsSync(`${chemin}.reponse`) ? readFileSync(`${chemin}.reponse`, "utf8") : null);
  return { ...lance, reponse };
}

const focusDansLaModale = (fenetre: Page) =>
  expect.poll(() => fenetre.evaluate(() => !!document.activeElement?.closest('[data-testid="modale-demande"]'))).toBe(true);

test("la carte d'une extension de l'agent sans réseau dit « Elle ne peut rien envoyer vers internet. »", async () => {
  const { fenetre, reponse, fermer } = await avecCarte(carte({ autresEspaces: ["Lecture"], remplaceAussi: ["Travail", "Achats"] }));
  const c = fenetre.getByTestId(MODALE).getByTestId(CARTE);
  await expect(c.getByTestId("carte-extension-remplace")).toHaveText("La nouvelle version remplacera aussi celle de « Travail », « Achats ».");
  await expect(c).toContainText("Activer « Essai » dans « Perso » ?");
  await expect(c).toContainText("Écrite par l'agent");
  await expect(c).toContainText("Ce qu'elle veut faire :");
  await expect(c).toContainText("Modifier l'apparence et le contenu des pages");
  await expect(c).toContainText("Sur : https://exemple.com/*");
  await expect(c).toContainText("Elle sera active aussi dans « Lecture » (même profil).");
  await expect(c).toContainText("Elle ne peut rien envoyer vers internet.");
  await expect(c).toContainText("Ses scripts tournent dans les pages : ils pourraient faire charger une ressource à la page");
  await expect(c).toContainText("L'agent ne voit pas ce que cette extension lit sur les onglets que tu ne lui as pas partagés.");
  await expect(c).not.toContainText("l'agent pourra voir");
  await expect(c.getByTestId("carte-extension-tous-sites")).toHaveCount(0);
  await expect(c.getByTestId("carte-extension-confirmer")).toHaveCount(0);
  await c.getByRole("button", { name: "Activer" }).click();
  await expect.poll(reponse).toBe("true");
  await expect(fenetre.getByTestId(MODALE)).toHaveCount(0);
  await fermer();
});

test("carte du Store, mise à jour : nom borné et à part, versions, sites bornés, aucune phrase propre à l'agent", async () => {
  const long = `<b>Gras</b> » dans « Perso ${"x".repeat(80)}`;
  const sites = Array.from({ length: 25 }, (_, i) => `https://s${i}.com/*`);
  const { fenetre, fermer } = await avecCarte(carte({ cle: `store:${"a".repeat(32)}`, source: "store", reseau: null, version: "2.0.0", maj: { de: "1.0.0" }, sites, nom: long }));
  const c = fenetre.getByTestId(CARTE);
  // Le nom venu du manifeste reste du texte, tronqué à 60 caractères, dans son propre élément.
  const nom = c.getByTestId("carte-extension-nom");
  await expect(nom).toHaveText(`« ${long.slice(0, 59)}… »`);
  await expect(c.locator("b", { hasText: "Gras" })).toHaveCount(0);
  await expect(c.locator("h3")).toContainText("Mettre à jour");
  await expect(c).toContainText("Version 1.0.0 → 2.0.0");
  await expect(c).toContainText("Chrome Web Store");
  await expect(c).toContainText(`Sur : ${sites.slice(0, 20).join(", ")} et 5 autres`);
  await expect(c).not.toContainText("https://s20.com/*");
  await expect(c).not.toContainText("envoyer");
  await expect(c).not.toContainText("Ses scripts tournent");
  await fermer();
});

test("carte renforcée : « Activer » sans effet tant que la case n'est pas cochée ; un « oui » sans la case est refusé par le processus principal", async () => {
  const { fenetre, reponse, fermer } = await avecCarte(carte({ renforce: true, tousLesSites: true, sites: ["<all_urls>"] }));
  const c = fenetre.getByTestId(CARTE);
  const activer = c.getByRole("button", { name: "Activer" });
  await expect(c).toContainText("Je comprends : elle lira toutes les pages de cet espace");
  await expect(activer).toBeDisabled();
  // La raison du blocage est donnée aux lecteurs d'écran ; la carte est décrite par son avertissement.
  await expect(activer).toHaveAccessibleDescription(/Coche « Je comprends »/);
  await expect(fenetre.getByRole("alertdialog")).toHaveAccessibleDescription(/lire et modifier chaque page/);
  await activer.click({ force: true });
  await new Promise((r) => setTimeout(r, 300));
  expect(reponse()).toBeNull();
  // Un « oui » envoyé sans la case cochée (renderer compromis ou bogué) : refus.
  await fenetre.evaluate(async () => {
    const w = window as unknown as { webaios: { permissions: { enAttente(): Promise<{ id: string }[]>; repondre(id: string, d: string): void } } };
    const [d] = await w.webaios.permissions.enAttente();
    w.webaios.permissions.repondre(d!.id, "autoriser");
  });
  await expect.poll(reponse).toBe("false");
  await fermer();
});

test("carte renforcée : la case cochée, « Activer » active", async () => {
  const { fenetre, reponse, fermer } = await avecCarte(carte({ renforce: true, tousLesSites: true, sites: ["<all_urls>"] }));
  const c = fenetre.getByTestId(CARTE);
  await c.getByTestId("carte-extension-confirmer").check();
  await c.getByRole("button", { name: "Activer" }).click();
  await expect.poll(reponse).toBe("true");
  await fermer();
});

test("Entrée refuse une carte d'extension, même renforcée et cochée", async () => {
  const { fenetre, reponse, fermer } = await avecCarte(carte({ renforce: true, tousLesSites: true, sites: ["<all_urls>"] }));
  const c = fenetre.getByTestId(CARTE);
  await c.getByTestId("carte-extension-confirmer").check();
  await expect(fenetre.getByTestId(MODALE)).toHaveAttribute("data-armee");
  await fenetre.keyboard.press("Enter");
  await expect.poll(reponse).toBe("false");
  await expect(fenetre.getByTestId(MODALE)).toHaveCount(0);
  await fermer();
});

test("Échap refuse", async () => {
  const { fenetre, reponse, fermer } = await avecCarte(carte());
  await expect(fenetre.getByTestId(CARTE)).toBeVisible();
  await focusDansLaModale(fenetre);
  await fenetre.keyboard.press("Escape");
  await expect.poll(reponse).toBe("false");
  await expect(fenetre.getByTestId(MODALE)).toHaveCount(0);
  await fermer();
});

const fenetresInterface = (app: Awaited<ReturnType<typeof lancer>>["app"]) => app.windows().filter((p) => p.url().includes("/renderer/index.html"));

test("la fenêtre de la carte se ferme : la carte passe dans une autre fenêtre ; plus aucune fenêtre : refus", async () => {
  const { app, fenetre, reponse, fermer } = await avecCarte(carte());
  await expect(fenetre.getByTestId(CARTE)).toBeVisible();
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("nouvelle-fenetre")?.click());
  await expect.poll(() => fenetresInterface(app).length).toBe(2);
  const seconde = fenetresInterface(app).find((p) => p !== fenetre)!;
  await expect(seconde.getByTestId(CARTE)).toHaveCount(0);
  // La première fenêtre (celle de la carte) se ferme : la carte passe dans la seconde, sans réponse.
  await fenetre.evaluate(() => window.close()).catch(() => {});
  await expect.poll(() => fenetresInterface(app).length).toBe(1);
  await expect(seconde.getByTestId(CARTE)).toBeVisible();
  expect(reponse()).toBeNull();
  // La dernière fenêtre se ferme : plus personne pour répondre, refus.
  await seconde.evaluate(() => window.close()).catch(() => {});
  await expect.poll(reponse).toBe("false");
  await fermer();
});

test("une carte devenue caduque (espace supprimé) tombe et vaut refus", async () => {
  const { fenetre, reponse, fermer } = await avecCarte(carte({ espaceId: "e2", espace: "Lecture" }));
  await expect(fenetre.getByTestId(CARTE)).toBeVisible();
  await fenetre.evaluate(() => (window as unknown as { webaios: { agir(a: unknown): void } }).webaios.agir({ type: "supprimerEspace", id: "e2" }));
  await expect.poll(reponse).toBe("false");
  await expect(fenetre.getByTestId(MODALE)).toHaveCount(0);
  await fermer();
});

// Les extensions dans les réglages d'un espace (tâche 14). Sessions écrites avant le lancement : « Perso » (e1) et
// « Lecture » (e2) partagent le profil par défaut, « Banque » (e3) a le sien (p2).

const ERREUR_PROFIL_PRIVE = "Donne à cet espace privé son propre profil pour y utiliser des extensions de l'agent";
const HOTE = "http://127.0.0.1/*";
const ACCORD = { permissions: [], hotes: [HOTE], reseau: [], tousLesSites: false, scriptsTousLesSites: false, scripts: true };
const NOM_AGENT = "Cacheur de l'agent";

let pages: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => {
  pages = await serveurTest();
});
test.afterAll(async () => {
  await pages.fermer();
});

const espaceDe = (id: string, nom: string, icone: string, profil: string, prive = false) => ({ id, nom, icone, epingles: [], prive, profil });
function ecrireSession(profil: string, espaces: ReturnType<typeof espaceDe>[], actif = "e1") {
  const ordre = Object.fromEntries(espaces.map((e) => [e.id, []]));
  const aucun = Object.fromEntries(espaces.map((e) => [e.id, null]));
  writeFileSync(
    join(profil, "session.json"),
    JSON.stringify({
      ...session,
      espaces,
      profils: [...new Set(espaces.map((e) => e.profil))].map((id) => ({ id })),
      fenetres: [{ ...session.fenetres[0], espaceActif: actif, ordre, actif: aucun }],
    }),
  );
}

/** Pose l'extension de l'agent « cacheur » (accordée, active dans `profils`) : son dossier et son registre. */
function poserAgent(profil: string, racine: string, profils: string[], fichiers: Record<string, string | object> = { "cache.css": "#cache-moi { display: none !important; }\n" }) {
  ecrireExtensionAgent(racine, "cacheur", {
    "manifest.json": { manifest_version: 3, name: NOM_AGENT, version: "1.0.0", content_scripts: [{ matches: [HOTE], css: ["cache.css"], ...(fichiers["vivant.js"] ? { js: ["vivant.js"] } : {}) }] },
    ...fichiers,
  });
  const entree = { source: "agent", idChrome: null, nom: NOM_AGENT, version: "1.0.0", accord: ACCORD, profils, epinglee: false, modifieeLe: null, desactivee: null, majEnAttente: null, vues: {} };
  const dossier = join(profil, "extensions");
  mkdirSync(dossier, { recursive: true });
  writeFileSync(join(dossier, "etat.json"), JSON.stringify({ version: 1, toutesCoupees: false, extensions: { "agent:cacheur": entree } }));
}

type Entree = { profils: string[]; vues: Record<string, string> };
const registre = (profil: string): Record<string, Entree> => JSON.parse(readFileSync(join(profil, "extensions", "etat.json"), "utf8")).extensions;
const noms = (app: Awaited<ReturnType<typeof lancer>>["app"], partition: string) =>
  app.evaluate(({ session }, p) => session.fromPartition(p).extensions.getAllExtensions().map((e) => e.name), partition);

const modaleReglages = async (fenetre: Page, icone: string) => {
  await fenetre.locator('[data-testid^="espace-"]', { hasText: icone }).click({ button: "right" });
  await fenetre.getByRole("menuitem", { name: "Réglages" }).click();
  const modale = fenetre.getByRole("dialog", { name: "Réglages de l'espace" });
  await expect(modale).toBeVisible();
  return modale;
};
const ligne = (modale: ReturnType<Page["getByRole"]>, nom: string) => modale.getByTestId("extension-ligne").filter({ hasText: nom });

test("basculer une extension du Store dans la modale l'active pour le profil ; la ligne d'un autre espace du profil dit « Active aussi dans … »", async () => {
  const profil = nouveauProfil();
  ecrireSession(profil, [espaceDe("e1", "Perso", "🏠", "defaut"), espaceDe("e2", "Lecture", "📚", "defaut"), espaceDe("e3", "Banque", "🏦", "p2")]);
  installerStoreFactice(profil, "bloqueur", { profils: ["defaut"] });
  const { app, fenetre, fermer } = await lancer({ profil });
  try {
    const cle = Object.keys(registre(profil))[0]!;
    let modale = await modaleReglages(fenetre, "🏦");
    const interrupteur = ligne(modale, "Bloqueur de test").getByRole("switch");
    await expect(modale.getByTestId("extensions-espace")).toBeVisible();
    await expect(interrupteur).not.toBeChecked();
    await interrupteur.click();
    await expect(interrupteur).toBeChecked();
    await expect.poll(() => registre(profil)[cle]!.profils.sort()).toEqual(["defaut", "p2"]);
    await expect.poll(() => noms(app, "persist:webaios-p2")).toEqual(["Bloqueur de test"]);
    await expect(ligne(modale, "Bloqueur de test")).not.toContainText("Active aussi dans");
    await modale.getByRole("button", { name: "Annuler" }).click();

    // Un autre espace du profil par défaut : l'extension y est active, et dit où elle tourne aussi.
    modale = await modaleReglages(fenetre, "📚");
    await expect(ligne(modale, "Bloqueur de test").getByRole("switch")).toBeChecked();
    await expect(ligne(modale, "Bloqueur de test")).toContainText("Active aussi dans « Perso » (même profil)");
    await modale.getByRole("button", { name: "Annuler" }).click();

    // Désactivée pour Banque : retirée de son profil seulement.
    modale = await modaleReglages(fenetre, "🏦");
    await ligne(modale, "Bloqueur de test").getByRole("switch").click();
    await expect.poll(() => registre(profil)[cle]!.profils).toEqual(["defaut"]);
    await expect.poll(() => noms(app, "persist:webaios-p2")).toEqual([]);
  } finally {
    await fermer();
  }
});

test("l'interrupteur d'une extension de l'agent est grisé dans un espace privé, avec ERREUR_PROFIL_PRIVE", async () => {
  const profil = nouveauProfil();
  const racine = nouvelleRacine();
  ecrireSession(profil, [espaceDe("e1", "Perso", "🏠", "defaut", true)]);
  poserAgent(profil, racine, ["defaut"]);
  // Un dossier de l'agent jamais accordé est listé lui aussi, grisé de même.
  ecrireExtensionAgent(racine, "jamais-accordee", { "manifest.json": { manifest_version: 3, name: "Jamais", version: "1.0.0" } });
  const { fenetre, fermer } = await lancer({ profil, racine });
  try {
    const modale = await modaleReglages(fenetre, "🏠");
    for (const nom of [NOM_AGENT, "jamais-accordee"]) {
      await expect(ligne(modale, nom).getByRole("switch")).toBeDisabled();
      await expect(ligne(modale, nom)).toContainText(ERREUR_PROFIL_PRIVE);
    }
    // Le processus principal refuse aussi, sans passer par l'interrupteur.
    const r = await fenetre.evaluate(() => {
      const w = window as unknown as { webaios: { extensions: { basculer(c: string, e: string, a: boolean): Promise<unknown> } } };
      return w.webaios.extensions.basculer("agent:cacheur", "e1", true);
    });
    expect(r).toEqual({ ok: false, erreur: ERREUR_PROFIL_PRIVE });
  } finally {
    await fermer();
  }
});

test("cocher « Espace privé » montre l'avertissement et la liste des extensions désactivées ; après Enregistrer, l'extension de l'agent n'est plus chargée", async () => {
  const profil = nouveauProfil();
  const racine = nouvelleRacine();
  ecrireSession(profil, [espaceDe("e1", "Perso", "🏠", "defaut"), espaceDe("e2", "Lecture", "📚", "defaut")]);
  poserAgent(profil, racine, ["defaut"]);
  const { app, fenetre, fermer } = await lancer({ profil, racine });
  try {
    await expect.poll(() => noms(app, "persist:webaios"), { timeout: 15_000 }).toEqual([NOM_AGENT]);
    const modale = await modaleReglages(fenetre, "🏠");
    await expect(modale.getByTestId("avertissement-extensions-prive")).toHaveCount(0);
    await expect(modale.getByTestId("extensions-desactivees")).toHaveCount(0);
    await modale.getByLabel("Espace privé").check();
    await expect(modale.getByTestId("avertissement-extensions-prive")).toContainText(
      "Cet espace privé partage son profil avec « Lecture » : les extensions actives dans ce profil tournent aussi ici. Pour qu'elles n'y tournent jamais, donne-lui son propre profil.",
    );
    await expect(modale.getByTestId("extensions-desactivees")).toContainText(`En enregistrant, ces extensions de l'agent seront désactivées pour ce profil : ${NOM_AGENT}. Les onglets ouverts où elles tournent seront rechargés.`);
    await modale.getByRole("button", { name: "Enregistrer" }).click();
    await expect.poll(() => registre(profil)["agent:cacheur"]!.profils).toEqual([]);
    await expect.poll(() => noms(app, "persist:webaios")).toEqual([]);
  } finally {
    await fermer();
  }
});

test("créer un espace privé sur un profil partagé désactive l'extension de l'agent de ce profil", async () => {
  const profil = nouveauProfil();
  const racine = nouvelleRacine();
  ecrireSession(profil, [espaceDe("e1", "Perso", "🏠", "defaut")]);
  poserAgent(profil, racine, ["defaut"]);
  const { app, fenetre, fermer } = await lancer({ profil, racine });
  try {
    await expect.poll(() => noms(app, "persist:webaios"), { timeout: 15_000 }).toEqual([NOM_AGENT]);
    // Sans passer par la modale : l'action `creerEspace`, comme l'enverrait une autre fenêtre.
    await fenetre.evaluate(() => {
      const w = window as unknown as { webaios: { fenetreId: string; agir(a: unknown): void } };
      w.webaios.agir({ type: "creerEspace", nom: "Secret", icone: "🔒", prive: true, profil: "defaut", fenetreId: w.webaios.fenetreId });
    });
    await expect.poll(() => noms(app, "persist:webaios")).toEqual([]);
    await expect.poll(() => registre(profil)["agent:cacheur"]!.profils).toEqual([]);
  } finally {
    await fermer();
  }
});

test("supprimer le dernier espace d'un profil retire ce profil des extensions", async () => {
  const profil = nouveauProfil();
  ecrireSession(profil, [espaceDe("e1", "Perso", "🏠", "defaut"), espaceDe("e3", "Banque", "🏦", "p2")]);
  installerStoreFactice(profil, "bloqueur", { profils: ["defaut", "p2"] });
  const { fenetre, fermer } = await lancer({ profil });
  try {
    const cle = Object.keys(registre(profil))[0]!;
    expect(registre(profil)[cle]!.profils.sort()).toEqual(["defaut", "p2"]);
    await fenetre.evaluate(() => (window as unknown as { webaios: { agir(a: unknown): void } }).webaios.agir({ type: "supprimerEspace", id: "e3" }));
    await expect.poll(() => registre(profil)[cle]!.profils).toEqual(["defaut"]);
    expect(Object.keys(registre(profil)[cle]!.vues)).not.toContain("p2");
  } finally {
    await fermer();
  }
});

test("supprimer le dernier espace d'un profil efface les réglages de ses extensions, dans le vrai dossier de sa session", async () => {
  const profil = nouveauProfil();
  ecrireSession(profil, [espaceDe("e1", "Perso", "🏠", "defaut"), espaceDe("e3", "Banque", "🏦", "p2")]);
  // La sonde écrit dans chrome.storage.local à son démarrage : `Local Extension Settings` naît dans la session de p2.
  installerStoreFactice(profil, "sonde", { profils: ["p2"] });
  const { app, fenetre, fermer } = await lancer({ profil });
  try {
    const stockage = await app.evaluate(({ session }) => session.fromPartition("persist:webaios-p2").storagePath);
    expect(stockage).toBeTruthy();
    expect(stockage!.startsWith(profil)).toBe(true);
    const reglages = join(stockage!, "Local Extension Settings");
    await expect.poll(() => existsSync(reglages), { timeout: 15_000 }).toBe(true);
    await fenetre.evaluate(() => (window as unknown as { webaios: { agir(a: unknown): void } }).webaios.agir({ type: "supprimerEspace", id: "e3" }));
    await expect.poll(() => existsSync(reglages), { timeout: 15_000 }).toBe(false);
  } finally {
    await fermer();
  }
});

// ─── Tâche 15 : la barre, la page Extensions, la coupure générale, les plantages ───────────────────────────────────
// Tout reste invisible : la popup d'une extension est une fenêtre cachée (ExtensionsProfils neutralise `show` en tests),
// et le menu du clic droit n'est jamais montré (`Menu.buildFromTemplate` intercepté, `popup` remplacé).

const DESACTIVEE_PLANTAGES = "Désactivée : elle a planté 3 fois en une minute";

type Etat = { toutesCoupees: boolean; extensions: Record<string, Record<string, unknown>> };
const lireRegistre = (profil: string): Etat => JSON.parse(readFileSync(join(profil, "extensions", "etat.json"), "utf8"));
function changerEntree(profil: string, cle: string, champs: Record<string, unknown>) {
  const e = lireRegistre(profil);
  e.extensions[cle] = { ...e.extensions[cle], ...champs };
  writeFileSync(join(profil, "extensions", "etat.json"), JSON.stringify(e, null, 2));
}
const chargees = (app: ElectronApplication, partition = "persist:webaios") =>
  app.evaluate(({ session }, p) => session.fromPartition(p).extensions.getAllExtensions().map((e) => e.name).sort(), partition);
/** Aucune fenêtre n'est visible à l'écran (interface, popups d'extension). */
const fenetresVisibles = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((f) => f.isVisible()).length);
/** Le texte de la popup de l'extension `id` (webContents chrome-extension://<id>/popup.html), ou null. */
const textePopup = (app: ElectronApplication, id: string) =>
  app.evaluate(async ({ webContents }, id) => {
    const w = webContents.getAllWebContents().find((x) => !x.isDestroyed() && x.getURL().startsWith(`chrome-extension://${id}/popup.html`));
    return w ? ((await w.executeJavaScript("document.getElementById('contenu')?.textContent ?? null")) as string | null) : null;
  }, id);
const menuApp = (app: ElectronApplication, id: string) => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.click(), id);
const ouvrirPage = async (fenetre: Page) => {
  await fenetre.getByTestId("menu-extensions").click();
  await fenetre.getByTestId("panneau-extensions").getByRole("button", { name: "Gérer les extensions" }).click();
  const page = fenetre.getByTestId("page-extensions");
  await expect(page).toBeVisible();
  return page;
};

test("une extension épinglée a son bouton dans la barre ; un clic ouvre sa popup (cachée), qui rend son contenu", async () => {
  const profil = nouveauProfil();
  writeFileSync(join(profil, "session.json"), JSON.stringify(session));
  const { id } = installerStoreFactice(profil, "bouton", { profils: ["defaut"] });
  changerEntree(profil, `store:${id}`, { epinglee: true });
  const { app, fenetre, fermer } = await lancer({ profil });
  try {
    await ouvrirOnglet(fenetre, `${pages.url}/a.html`);
    await expect.poll(() => dansLaVue(app, "a.html", "document.readyState")).toBe("complete");
    const bouton = fenetre.getByTestId("barre-extensions").locator(`button[is="browser-action"][id="${id}"]`);
    await expect(bouton).toHaveCount(1);
    await expect(bouton).toHaveAttribute("partition", "persist:webaios");
    // L'icône (crx://extension-icon/…) a bien été chargée par l'interface : la CSP la laisse passer.
    await expect.poll(() => bouton.evaluate((b) => (b as HTMLElement).style.backgroundImage)).toContain("crx://extension-icon/");
    await expect(bouton).not.toHaveClass(/no-icon/);
    await expect(bouton).toHaveAttribute("title", "Bouton de test");
    await bouton.click();
    await expect.poll(() => textePopup(app, id), { timeout: 10_000 }).toBe("Popup de test prête");
    expect(await fenetresVisibles(app)).toBe(0);
    // La console de la popup est notée (erreur) et lisible sur la page Extensions.
    const page = await ouvrirPage(fenetre);
    await expect(page.getByTestId("extension-page").filter({ hasText: "Bouton de test" })).toContainText("erreur de la popup");
  } finally {
    await fermer();
  }
});

test("le menu Extensions liste une extension non épinglée ; « Épingler » la met dans la barre", async () => {
  const profil = nouveauProfil();
  writeFileSync(join(profil, "session.json"), JSON.stringify(session));
  const { id } = installerStoreFactice(profil, "bouton", { profils: ["defaut"] });
  const { fenetre, fermer } = await lancer({ profil });
  try {
    const barre = fenetre.getByTestId("barre-extensions");
    await fenetre.getByTestId("menu-extensions").click();
    const panneau = fenetre.getByTestId("panneau-extensions");
    const ligne = panneau.getByTestId("ligne-barre-extension").filter({ hasText: "Bouton de test" });
    await expect(ligne).toBeVisible();
    await expect(ligne.locator(`button[is="browser-action"][id="${id}"]`)).toHaveCount(1);
    await expect(barre.locator(`button[is="browser-action"][id="${id}"]`)).toHaveCount(0);
    await ligne.getByRole("button", { name: "Épingler" }).click();
    await expect(barre.locator(`button[is="browser-action"][id="${id}"]`)).toHaveCount(1);
    await expect.poll(() => lireRegistre(profil).extensions[`store:${id}`]!.epinglee).toBe(true);
    await expect(panneau.getByTestId("ligne-barre-extension").filter({ hasText: "Bouton de test" }).getByRole("button", { name: "Détacher" })).toBeVisible();
  } finally {
    await fermer();
  }
});

test("l'entrée de menu contextuel d'une extension apparaît au clic droit sur une page", async () => {
  const profil = nouveauProfil();
  writeFileSync(join(profil, "session.json"), JSON.stringify(session));
  installerStoreFactice(profil, "bouton", { profils: ["defaut"] });
  const { app, fenetre, fermer } = await lancer({ profil });
  try {
    // Le menu construit est retenu, et jamais montré.
    await app.evaluate(({ Menu }) => {
      const g = globalThis as unknown as { menusConstruits: string[][] };
      g.menusConstruits = [];
      const original = Menu.buildFromTemplate.bind(Menu);
      Menu.buildFromTemplate = (modele) => {
        const menu = original(modele);
        g.menusConstruits.push(menu.items.map((x) => (x.type === "separator" ? "---" : x.label)));
        menu.popup = () => {};
        return menu;
      };
    });
    await ouvrirOnglet(fenetre, `${pages.url}/a.html`);
    await expect.poll(() => dansLaVue(app, "a.html", "document.readyState")).toBe("complete");
    const derniers = () => app.evaluate(() => (globalThis as unknown as { menusConstruits: string[][] }).menusConstruits.at(-1) ?? null);
    // Le menu de la bibliothèque arrive quand son service worker a posé l'entrée : clic droit renouvelé.
    await expect
      .poll(async () => {
        await app.evaluate(({ webContents }) => {
          const w = webContents.getAllWebContents().find((x) => x.getURL().includes("/a.html"));
          for (const type of ["mouseDown", "mouseUp"] as const) w?.sendInputEvent({ type, x: 20, y: 20, button: "right", clickCount: 1 });
        });
        return derniers();
      }, { timeout: 10_000 })
      .toEqual(expect.arrayContaining(["---", "Entrée de test"]));
    const menu = (await derniers())!;
    expect(menu.indexOf("Entrée de test")).toBeGreaterThan(menu.indexOf("---"));
    expect(await fenetresVisibles(app)).toBe(0);
  } finally {
    await fermer();
  }
});

test("la page liste source, version, droits, espaces et « Non pris en charge : activeTab »", async () => {
  const profil = nouveauProfil();
  writeFileSync(join(profil, "session.json"), JSON.stringify(session));
  installerStoreFactice(profil, "bouton", { profils: ["defaut"] });
  const { fenetre, fermer } = await lancer({ profil });
  try {
    const page = await ouvrirPage(fenetre);
    const ligne = page.getByTestId("extension-page").filter({ hasText: "Bouton de test" });
    await expect(ligne).toContainText("Chrome Web Store");
    await expect(ligne).toContainText("2.1.0");
    await expect(ligne).toContainText("Ajouter des entrées au menu du clic droit");
    await expect(ligne).toContainText("Garder ses réglages");
    await expect(ligne).toContainText("« Perso » (profil defaut)");
    await expect(ligne).toContainText("« Lecture » (profil defaut)");
    await expect(ligne).toContainText("Non pris en charge : activeTab");
    await ligne.getByRole("button", { name: "Détails" }).click();
    await expect(ligne.getByTestId("details-extension")).toBeVisible();
  } finally {
    await fermer();
  }
});

/** Faux Store : sert `/<id>.crx` (jamais le vrai Store). */
async function fauxStore(crx: Buffer, id: string) {
  const serveur = createServer((req, res) => {
    if (req.url === `/${id}.crx`) res.writeHead(200, { "content-type": "application/x-chrome-extension" }).end(crx);
    else res.writeHead(404).end();
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`, fermer: () => new Promise<void>((ok) => serveur.close(() => ok())) };
}

test("« Désactiver toutes les extensions » : plus rien de chargé, et toujours rien après redémarrage ; installer une extension pendant la coupure ne la charge pas", async () => {
  const profil = nouveauProfil();
  writeFileSync(join(profil, "session.json"), JSON.stringify(session));
  installerStoreFactice(profil, "bouton", { profils: ["defaut"] });
  const source = mkdtempSync(join(tmpdir(), "webaios-coupure-"));
  ecrireExtension(source, EXTENSIONS_TEST.bloqueur);
  const { crx, id: idBloqueur } = construireCrx(source, {});
  rmSync(source, { recursive: true, force: true });
  const store = await fauxStore(crx, idBloqueur);
  try {
    let l = await lancer({ profil, env: { WEBAIOS_TEST_STORE_URL: store.url } });
    try {
      await expect.poll(() => chargees(l.app)).toEqual(["Bouton de test"]);
      const page = await ouvrirPage(l.fenetre);
      await page.getByTestId("couper-extensions").click();
      await expect(page.getByTestId("couper-extensions")).toBeChecked();
      await expect.poll(() => chargees(l.app)).toEqual([]);
      expect(lireRegistre(profil).toutesCoupees).toBe(true);
      await expect(l.fenetre.getByTestId("barre-extensions").locator('button[is="browser-action"]')).toHaveCount(0);

      // Installée pendant la coupure (clic de l'utilisateur sur la page) : accord noté, rien de chargé.
      await page.getByTestId("ajout-store").fill(idBloqueur);
      await page.getByRole("button", { name: "Ajouter" }).click();
      const c = l.fenetre.getByTestId("modale-demande").getByTestId("demande-extension");
      await expect(c).toContainText("Bloqueur de test");
      await c.getByRole("button", { name: "Activer" }).click();
      await expect.poll(() => Object.keys(lireRegistre(profil).extensions)).toContain(`store:${idBloqueur}`);
      await expect(page.getByTestId("extension-page").filter({ hasText: "Bloqueur de test" })).toBeVisible();
      expect(await chargees(l.app)).toEqual([]);
    } finally {
      await l.fermer();
    }
    // Après un redémarrage : toujours rien, et l'interrupteur reste coché.
    l = await lancer({ profil, env: { WEBAIOS_TEST_STORE_URL: store.url } });
    try {
      const page = await ouvrirPage(l.fenetre);
      await expect(page.getByTestId("couper-extensions")).toBeChecked();
      await expect(page.getByTestId("extension-page")).toHaveCount(2);
      // Le service a fini de démarrer (première synchronisation faite) : l'absence se vérifie après, pas sur un délai.
      await expect.poll(() => l.app.evaluate(() => (globalThis as { __webaiosExtensionsPretes?: boolean }).__webaiosExtensionsPretes === true), { timeout: 15_000 }).toBe(true);
      expect(await chargees(l.app)).toEqual([]);
      // Réactivées : les deux repartent.
      await page.getByTestId("couper-extensions").click();
      await expect.poll(() => chargees(l.app)).toEqual(["Bloqueur de test", "Bouton de test"]);
    } finally {
      await l.fermer();
    }
  } finally {
    await store.fermer();
  }
});

test("« Supprimer » une extension du Store vide store/<id>", async () => {
  const profil = nouveauProfil();
  writeFileSync(join(profil, "session.json"), JSON.stringify(session));
  const { id } = installerStoreFactice(profil, "bouton", { profils: ["defaut"] });
  const { app, fenetre, fermer } = await lancer({ profil });
  try {
    await expect.poll(() => chargees(app)).toEqual(["Bouton de test"]);
    const page = await ouvrirPage(fenetre);
    const ligne = page.getByTestId("extension-page").filter({ hasText: "Bouton de test" });
    await ligne.getByRole("button", { name: "Supprimer" }).click();
    await fenetre.getByTestId("confirmation-suppression-extension").getByRole("button", { name: "Supprimer" }).click();
    await expect(ligne).toHaveCount(0);
    await expect.poll(() => existsSync(join(profil, "extensions", "store", id))).toBe(false);
    expect(lireRegistre(profil).extensions[`store:${id}`]).toBeUndefined();
    expect(await chargees(app)).toEqual([]);
  } finally {
    await fermer();
  }
});

test("une extension dont la popup plante 3 fois est désactivée avec DESACTIVEE_PLANTAGES", async () => {
  const profil = nouveauProfil();
  writeFileSync(join(profil, "session.json"), JSON.stringify(session));
  const { id } = installerStoreFactice(profil, "bouton", { profils: ["defaut"] });
  changerEntree(profil, `store:${id}`, { epinglee: true });
  const { app, fenetre, fermer } = await lancer({ profil });
  try {
    await ouvrirOnglet(fenetre, `${pages.url}/a.html`);
    await expect.poll(() => dansLaVue(app, "a.html", "document.readyState")).toBe("complete");
    const bouton = fenetre.getByTestId("barre-extensions").locator(`button[is="browser-action"][id="${id}"]`);
    const fermerPopup = () =>
      app.evaluate(({ BrowserWindow }, id) => {
        for (const f of BrowserWindow.getAllWindows()) if (f.webContents.getURL().startsWith(`chrome-extension://${id}/`)) f.destroy();
      }, id);
    // Ouvrir et fermer la popup n'est pas un plantage.
    for (let i = 0; i < 3; i++) {
      await bouton.click();
      await expect.poll(() => textePopup(app, id)).toBe("Popup de test prête");
      await fermerPopup();
      await expect.poll(() => textePopup(app, id)).toBe(null);
    }
    expect(lireRegistre(profil).extensions[`store:${id}`]!.desactivee).toBe(null);
    // Trois plantages de la popup en moins d'une minute.
    for (let i = 0; i < 3; i++) {
      await bouton.click();
      await expect.poll(() => textePopup(app, id)).toBe("Popup de test prête");
      await app.evaluate(({ webContents }, id) => {
        webContents.getAllWebContents().find((x) => x.getURL().startsWith(`chrome-extension://${id}/popup.html`))?.forcefullyCrashRenderer();
      }, id);
      if (i < 2) {
        await fermerPopup();
        await expect.poll(() => textePopup(app, id)).toBe(null);
      }
    }
    await expect.poll(() => (lireRegistre(profil).extensions[`store:${id}`]!.desactivee as { raison: string } | null)?.raison).toBe("plantages");
    await expect.poll(() => chargees(app)).toEqual([]);
    expect(await fenetresVisibles(app)).toBe(0);
    const page = await ouvrirPage(fenetre);
    const ligne = page.getByTestId("extension-page").filter({ hasText: "Bouton de test" });
    await expect(ligne).toContainText(DESACTIVEE_PLANTAGES);
    // « Réactiver » : elle repart.
    await ligne.getByRole("button", { name: "Réactiver" }).click();
    await expect.poll(() => chargees(app)).toEqual(["Bouton de test"]);
  } finally {
    await fermer();
  }
});

test("l'entrée « Extensions » du menu de l'application ouvre la page", async () => {
  const { app, fenetre, fermer } = await lancer();
  try {
    await menuApp(app, "extensions");
    await expect(fenetre.getByTestId("page-extensions")).toBeVisible();
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("extensions")?.accelerator ?? null)).toBe(null);
    await menuApp(app, "extensions");
    await expect(fenetre.getByTestId("page-extensions")).toHaveCount(1);
  } finally {
    await fermer();
  }
});
