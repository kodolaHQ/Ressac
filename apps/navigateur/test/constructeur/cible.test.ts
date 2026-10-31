import { expect, test } from "vitest";
import { cibleDeCle, cleCible, directDesActions, estCleAction } from "../../src/renderer/constructeur/cible";

test("cleCible : l'id d'un widget tel quel, action:<id> pour une action, et retour", () => {
  expect(cleCible({ type: "widget", id: "gitlab" })).toBe("gitlab");
  expect(cleCible({ type: "action", id: "gitlab" })).toBe("action:gitlab");
  expect(cibleDeCle("gitlab")).toEqual({ type: "widget", id: "gitlab" });
  expect(cibleDeCle("action:gitlab")).toEqual({ type: "action", id: "gitlab" });
  expect(estCleAction("action:gitlab")).toBe(true);
  expect(estCleAction("gitlab")).toBe(false);
});

test("directDesActions : une action courante devient une exécution (ou un essai) de sa clé, sans ses traces d'avancement", () => {
  const d = directDesActions({
    courantes: [
      {
        action: "gitlab",
        debut: "2026-10-31T08:00:00.000Z",
        saisie: "x",
        essai: true,
        etape: "workflow",
        blocs: { lire: { statut: "en-cours", elements: null, hote: "gitlab.com", faits: 1, total: 3, type: "source.page" } },
      },
    ],
    enAttente: [{ action: "autre", depuis: "2026-10-31T08:00:00.000Z" }],
  });
  expect(d).toEqual({
    courants: [{ widget: "action:gitlab", genre: "essai", debut: "2026-10-31T08:00:00.000Z", blocs: { lire: { statut: "en-cours", elements: null } } }],
    enAttente: ["action:autre"],
  });
});
