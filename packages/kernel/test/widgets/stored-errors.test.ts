import { expect, test } from "vitest";
import { kernelError } from "../../src/widgets/harvest.js";

// Literal strings: errors stored before the languages existed must still be recognised as the kernel's own.
test("French errors stored by the version before the languages are still kernel errors", () => {
  for (const error of [
    "Délai dépassé",
    "Réponse trop grande",
    "Le profil de connexion choisi n'est plus utilisable (supprimé ou utilisé par un espace privé) : accord à redonner",
    "Mise à jour impossible : atelier arrêté",
    "Mise à jour impossible : erreur interne du navigateur",
    "Ce widget n'a ni workflow.json ni harvest.mjs",
    "Interrompue : Ressac s'est arrêté",
    "Ce widget n'a pas de harvest.mjs",
    "Données trop grosses (2 Mo au plus)",
    "Accord requis pour lire avec ton compte : a.com",
    "Accord requis pour lire avec ton compte : a.com, b.org…",
    "Workflow invalide : x",
  ]) {
    expect(kernelError(error), error).toBe(true);
  }
  expect(kernelError("Délai dépassé par le widget : secret")).toBe(false);
});
