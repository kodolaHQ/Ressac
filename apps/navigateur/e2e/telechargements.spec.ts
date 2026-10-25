import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { dansLaVue, lancer, ouvrirOnglet, serveurTest } from "./aide";

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => (serveur = await serveurTest()));
test.afterAll(() => serveur.fermer());

test("télécharger un fichier du serveur local : il arrive dans le dossier et passe à « termine »", async () => {
  const dossier = realpathSync(mkdtempSync(join(tmpdir(), "webaios-dl-")));
  const { app, fenetre, fermer } = await lancer({ env: { WEBAIOS_TELECHARGEMENTS: dossier } });
  await ouvrirOnglet(fenetre, `${serveur.url}/telecharger.html`);
  await expect.poll(() => dansLaVue(app, "telecharger.html", "document.title")).toBe("Télécharger");
  await dansLaVue(app, "telecharger.html", "document.getElementById('lien').click()");
  await expect.poll(() => existsSync(join(dossier, "fichier.txt"))).toBe(true);
  await dansLaVue(app, "telecharger.html", "document.getElementById('lien').click()");
  await expect.poll(() => existsSync(join(dossier, "fichier (1).txt"))).toBe(true);
  expect(readFileSync(join(dossier, "fichier.txt"), "utf8")).toContain("Bonjour");

  await fenetre.getByRole("button", { name: "Téléchargements" }).click();
  const liste = fenetre.getByTestId("telechargements").getByTestId("telechargement");
  await expect(liste).toHaveCount(2);
  await expect(liste.first()).toHaveAttribute("data-etat", "termine");
  await expect(liste.first()).toContainText("fichier (1).txt");
  await expect(liste.first().getByRole("button", { name: "Afficher dans le Finder" })).toBeVisible();
  await fermer();
});
