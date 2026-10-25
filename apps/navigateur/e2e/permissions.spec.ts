import { expect, test } from "@playwright/test";
import { dansLaVue, lancer, ouvrirOnglet, serveurTest } from "./aide";

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => (serveur = await serveurTest()));
test.afterAll(() => serveur.fermer());

test("une page qui demande les notifications affiche le bandeau ; Autoriser → Notification.permission === 'granted'", async () => {
  const { app, fenetre, profil, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/notif.html`);
  await expect.poll(() => dansLaVue(app, "notif.html", "document.title")).toBe("Notifications");
  await dansLaVue(app, "notif.html", "document.getElementById('demander').click()");
  const bandeau = fenetre.getByTestId("demande-permission");
  await expect(bandeau).toContainText("127.0.0.1");
  await expect(bandeau).toContainText("notifications");
  await bandeau.getByRole("button", { name: "Autoriser" }).click();
  await expect(bandeau).toBeHidden();
  await expect.poll(() => dansLaVue(app, "notif.html", "document.title")).toBe("reponse:granted");
  expect(await dansLaVue(app, "notif.html", "Notification.permission")).toBe("granted");
  await fermer();
  // La décision est mémorisée : au redémarrage, plus de question.
  const second = await lancer({ profil });
  await ouvrirOnglet(second.fenetre, `${serveur.url}/notif.html`);
  await expect.poll(() => dansLaVue(second.app, "notif.html", "Notification.permission")).toBe("granted");
  await second.fermer();
});

test("Refuser → la page reçoit 'denied'", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/notif.html`);
  await expect.poll(() => dansLaVue(app, "notif.html", "document.title")).toBe("Notifications");
  await dansLaVue(app, "notif.html", "document.getElementById('demander').click()");
  await fenetre.getByTestId("demande-permission").getByRole("button", { name: "Refuser" }).click();
  await expect.poll(() => dansLaVue(app, "notif.html", "document.title")).toBe("reponse:denied");
  await fermer();
});
