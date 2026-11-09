import { expect, test } from "vitest";
import { targetOfKey, targetKey, directDesActions, isActionKey } from "../../ui/constructeur/cible";

test("cleCible: a widget's id as is, action:<id> for an action, and back", () => {
  expect(targetKey({ type: "widget", id: "gitlab" })).toBe("gitlab");
  expect(targetKey({ type: "action", id: "gitlab" })).toBe("action:gitlab");
  expect(targetOfKey("gitlab")).toEqual({ type: "widget", id: "gitlab" });
  expect(targetOfKey("action:gitlab")).toEqual({ type: "action", id: "gitlab" });
  expect(isActionKey("action:gitlab")).toBe(true);
  expect(isActionKey("gitlab")).toBe(false);
});

test("directDesActions: a current action becomes a run (or a trial) of its key, without its progress traces", () => {
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
