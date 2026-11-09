import { expect, test } from "vitest";
import {
  urlChanged,
  urlUnchanged,
  urlNotFound,
  confirmForget,
  confirmSiteDeletion,
  blockedLink,
  HomeMessage,
  editWithAgent,
  tweaksGrantTitle,
} from "../../shared/sites";

test("messages of a site app's window", () => {
  expect(blockedLink("pub.localhost")).toBe("Lien vers pub.localhost bloqué");
  expect(urlNotFound("adresses.localhost")).toBe("Adresse introuvable sur adresses.localhost");
  expect(urlChanged("Vidola", "vidola-b.localhost")).toBe("Vidola a changé d'adresse : vidola-b.localhost. Il faudra peut-être te reconnecter.");
  expect(urlUnchanged("Vidola")).toBe("Vidola ne répond pas, et sa page de référence donne toujours la même adresse");
  expect(tweaksGrantTitle("Vidola")).toBe("Autoriser les retouches de « Vidola » ?");
  expect(confirmForget("Vidola")).toBe("Oublier tout ce que « Vidola » a retenu (séries, positions des vidéos) ?");
  expect(confirmSiteDeletion("Vidola")).toBe("Supprimer « Vidola » ? Sa connexion et sa mémoire sont effacées, son dossier va à la corbeille.");
  expect(editWithAgent("vidola")).toBe("Appli de site ~/WebAiOs/sites/vidola/ : ");
});

test("MessageDeLAccueil: the three allowed messages", () => {
  expect(HomeMessage.parse({ type: "pret" })).toEqual({ type: "pret" });
  expect(HomeMessage.parse({ type: "ouvrir", adresse: "/series/the-bear" })).toEqual({ type: "ouvrir", adresse: "/series/the-bear" });
  expect(HomeMessage.parse({ type: "image", n: 3, url: "https://vidola-a.localhost/a.jpg" })).toEqual({ type: "image", n: 3, url: "https://vidola-a.localhost/a.jpg" });
});

test("MessageDeLAccueil: the rest is refused", () => {
  for (const m of [
    null,
    "pret",
    {},
    { type: "fermer" },
    { type: "pret", en: "trop" },
    { type: "ouvrir" },
    { type: "ouvrir", adresse: 3 },
    { type: "ouvrir", adresse: "x".repeat(4097) },
    { type: "image", n: -1, url: "a" },
    { type: "image", n: 1.5, url: "a" },
    { type: "image", n: 1, url: "x".repeat(4097) },
    { type: "image", n: 1 },
  ]) {
    expect(HomeMessage.safeParse(m).success).toBe(false);
  }
});
