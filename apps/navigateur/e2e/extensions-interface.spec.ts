import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lancer, nouveauProfil } from "./aide";

// La carte d'accord des extensions, posée au démarrage par WEBAIOS_TEST_CARTE_EXTENSION (ni Store, ni agent) ; la
// réponse de l'utilisateur est notée dans `<chemin>.reponse`. Tout reste invisible.

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
  autresEspaces: [],
  maj: null,
  ...champs,
});

async function avecCarte(c: Record<string, unknown>) {
  const profil = nouveauProfil();
  const chemin = join(profil, "carte-extension.json");
  writeFileSync(chemin, JSON.stringify(c));
  const lance = await lancer({ profil, env: { WEBAIOS_TEST_CARTE_EXTENSION: chemin } });
  const reponse = () => (existsSync(`${chemin}.reponse`) ? readFileSync(`${chemin}.reponse`, "utf8") : null);
  return { ...lance, reponse };
}

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

test("carte du Store, mise à jour : titre de mise à jour, versions, aucune phrase propre à l'agent", async () => {
  const { fenetre, fermer } = await avecCarte(
    carte({ cle: `store:${"a".repeat(32)}`, source: "store", reseau: null, version: "2.0.0", maj: { de: "1.0.0" }, tousLesSites: true, sites: ["<all_urls>"], nom: "<b>Gras</b>" }),
  );
  const c = fenetre.getByTestId(CARTE);
  // Un nom venu du manifeste reste du texte.
  await expect(c).toContainText("Mettre à jour « <b>Gras</b> » ?");
  await expect(c.locator("b", { hasText: "Gras" })).toHaveCount(0);
  await expect(c).toContainText("Version 1.0.0 → 2.0.0");
  await expect(c).toContainText("Chrome Web Store");
  await expect(c.getByTestId("carte-extension-tous-sites")).toHaveText("Sur tous les sites que tu visites");
  await expect(c).not.toContainText("envoyer");
  await expect(c).not.toContainText("Ses scripts tournent");
  await fermer();
});

test("carte renforcée : Entrée et « Activer » sans effet tant que la case n'est pas cochée", async () => {
  const { fenetre, reponse, fermer } = await avecCarte(carte({ renforce: true, tousLesSites: true, sites: ["<all_urls>"] }));
  const c = fenetre.getByTestId(CARTE);
  const activer = c.getByRole("button", { name: "Activer" });
  const caseConfirmer = c.getByTestId("carte-extension-confirmer");
  await expect(c).toContainText("Je comprends : elle lira toutes les pages de cet espace");
  await expect(activer).toBeDisabled();
  await expect(fenetre.getByTestId(MODALE)).toHaveAttribute("data-armee");
  await expect.poll(() => fenetre.evaluate(() => !!document.activeElement?.closest('[data-testid="modale-demande"]'))).toBe(true);
  await fenetre.keyboard.press("Enter");
  await activer.click({ force: true });
  await new Promise((r) => setTimeout(r, 300));
  expect(reponse()).toBeNull();
  await expect(c).toBeVisible();
  // Cochée : Entrée active.
  await caseConfirmer.check();
  await expect(activer).toBeEnabled();
  await fenetre.keyboard.press("Enter");
  await expect.poll(reponse).toBe("true");
  await fermer();
});

test("Échap refuse", async () => {
  const { fenetre, reponse, fermer } = await avecCarte(carte());
  await expect(fenetre.getByTestId(CARTE)).toBeVisible();
  await expect.poll(() => fenetre.evaluate(() => !!document.activeElement?.closest('[data-testid="modale-demande"]'))).toBe(true);
  await fenetre.keyboard.press("Escape");
  await expect.poll(reponse).toBe("false");
  await expect(fenetre.getByTestId(MODALE)).toHaveCount(0);
  await fermer();
});
