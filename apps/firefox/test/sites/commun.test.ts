import { expect, test } from "vitest";
import {
  adresseChangee,
  adresseInchangee,
  adresseIntrouvable,
  confirmerOubli,
  confirmerSuppressionSite,
  lienBloque,
  MessageDeLAccueil,
  modifierAvecAgent,
  titreAccordRetouches,
} from "../../shared/sites";

test("messages de la fenêtre d'une appli de site", () => {
  expect(lienBloque("pub.localhost")).toBe("Lien vers pub.localhost bloqué");
  expect(adresseIntrouvable("adresses.localhost")).toBe("Adresse introuvable sur adresses.localhost");
  expect(adresseChangee("Vidola", "vidola-b.localhost")).toBe("Vidola a changé d'adresse : vidola-b.localhost. Il faudra peut-être te reconnecter.");
  expect(adresseInchangee("Vidola")).toBe("Vidola ne répond pas, et sa page de référence donne toujours la même adresse");
  expect(titreAccordRetouches("Vidola")).toBe("Autoriser les retouches de « Vidola » ?");
  expect(confirmerOubli("Vidola")).toBe("Oublier tout ce que « Vidola » a retenu (séries, positions des vidéos) ?");
  expect(confirmerSuppressionSite("Vidola")).toBe("Supprimer « Vidola » ? Sa connexion et sa mémoire sont effacées, son dossier va à la corbeille.");
  expect(modifierAvecAgent("vidola")).toBe("Appli de site ~/WebAiOs/sites/vidola/ : ");
});

test("MessageDeLAccueil : les trois messages permis", () => {
  expect(MessageDeLAccueil.parse({ type: "pret" })).toEqual({ type: "pret" });
  expect(MessageDeLAccueil.parse({ type: "ouvrir", adresse: "/series/the-bear" })).toEqual({ type: "ouvrir", adresse: "/series/the-bear" });
  expect(MessageDeLAccueil.parse({ type: "image", n: 3, url: "https://vidola-a.localhost/a.jpg" })).toEqual({ type: "image", n: 3, url: "https://vidola-a.localhost/a.jpg" });
});

test("MessageDeLAccueil : le reste est refusé", () => {
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
    expect(MessageDeLAccueil.safeParse(m).success).toBe(false);
  }
});
