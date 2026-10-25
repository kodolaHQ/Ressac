import { expect, test } from "@playwright/test";
import { lancer } from "./aide";

test("la fenêtre s'ouvre avec la barre latérale, le contenu et un panneau agent fermé", async () => {
  const { fenetre, fermer } = await lancer();
  await expect(fenetre.getByTestId("barre-laterale")).toBeVisible();
  await expect(fenetre.getByTestId("zone-contenu")).toBeVisible();
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await fermer();
});

test("l'interface n'expose pas Node", async () => {
  const { fenetre, fermer } = await lancer();
  expect(await fenetre.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe("undefined");
  expect(await fenetre.evaluate(() => typeof (window as unknown as { webaios?: unknown }).webaios)).toBe("object");
  await fermer();
});
