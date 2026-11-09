import { expect, test } from "vitest";
import { choisirCibleDesign } from "../../core/design/premier-plan";

test("appli et site à la fois → cible app", () => {
  expect(choisirCibleDesign({ appli: "essai", site: "tuning", autreFenetre: true, fenetreActive: "f1" })).toEqual({ type: "cible", cible: { type: "app", dossier: "essai" } });
});

test("site seul → cible site", () => {
  expect(choisirCibleDesign({ site: "tuning", autreFenetre: true, fenetreActive: "f1" })).toEqual({ type: "cible", cible: { type: "site", id: "tuning" } });
});

test("petite fenêtre d'une appli de site → avis-site, jamais la fenêtre active", () => {
  expect(choisirCibleDesign({ petiteDeSite: "tuning", autreFenetre: true, fenetreActive: "f1" })).toEqual({ type: "avis-site", id: "tuning" });
  expect(choisirCibleDesign({ petiteDeSite: "tuning", autreFenetre: false, fenetreActive: "f1" })).toEqual({ type: "avis-site", id: "tuning" });
});

test("autre fenêtre (ni principale, ni appli) avec une fenêtre active → rien", () => {
  expect(choisirCibleDesign({ autreFenetre: true, fenetreActive: "f1" })).toEqual({ type: "rien" });
});

test("rien au premier plan, fenêtre active f1 → cible fenetre f1", () => {
  expect(choisirCibleDesign({ autreFenetre: false, fenetreActive: "f1" })).toEqual({ type: "cible", cible: { type: "fenetre", fenetreId: "f1" } });
});

test("rien du tout → rien", () => {
  expect(choisirCibleDesign({ autreFenetre: false })).toEqual({ type: "rien" });
});
