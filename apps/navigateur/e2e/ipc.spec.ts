import { expect, test } from "@playwright/test";
import { lancer } from "./aide";

type Fenetre = Window & { webaios: { agir(a: unknown): void; fenetreId: string } };

test("une action envoyée par l'interface revient dans l'état diffusé", async () => {
  const { fenetre, fermer } = await lancer();
  await fenetre.evaluate(() => (window as unknown as Fenetre).webaios.agir({ type: "creerEspace", nom: "Boulot", icone: "💼" }));
  await expect(fenetre.locator('[data-testid^="espace-"]', { hasText: "💼" })).toBeVisible();
  await fermer();
});

test("une action invalide est ignorée sans planter", async () => {
  const { fenetre, fermer } = await lancer();
  await fenetre.evaluate(() => {
    const w = window as unknown as Fenetre;
    w.webaios.agir({ type: "nimporte" });
    w.webaios.agir({ type: "creerEspace", nom: "Jeux", icone: "🎮" });
  });
  await expect(fenetre.locator('[data-testid^="espace-"]', { hasText: "🎮" })).toBeVisible();
  await fermer();
});

test("l'interface connaît l'id de sa fenêtre", async () => {
  const { fenetre, fermer } = await lancer();
  expect(await fenetre.evaluate(() => (window as unknown as Fenetre).webaios.fenetreId)).toMatch(/.+/);
  await fermer();
});
