import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lancer, nouveauProfil } from "./aide";

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
