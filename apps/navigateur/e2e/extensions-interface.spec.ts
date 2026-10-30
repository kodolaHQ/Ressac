import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dansLaVue, lancer, nouveauProfil, nouvelleRacine, ouvrirOnglet, serveurTest } from "./aide";
import { ecrireExtensionAgent, installerStoreFactice } from "./extensions/fixtures";

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
  const { fenetre, reponse, fermer } = await avecCarte(carte({ autresEspaces: ["Lecture"] }));
  const c = fenetre.getByTestId(MODALE).getByTestId(CARTE);
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
    await expect(modale.getByTestId("extensions-desactivees")).toContainText(`En enregistrant, ces extensions de l'agent seront désactivées pour ce profil : ${NOM_AGENT}.`);
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
