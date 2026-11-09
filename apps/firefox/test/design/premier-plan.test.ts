import { expect, test } from "vitest";
import { choisirCibleDesign } from "../../core/design/premier-plan";

test("app and site at once → app target", () => {
  expect(choisirCibleDesign({ appli: "essai", site: "tuning", autreFenetre: true, fenetreActive: "f1" })).toEqual({ type: "cible", cible: { type: "app", dossier: "essai" } });
});

test("site alone → site target", () => {
  expect(choisirCibleDesign({ site: "tuning", autreFenetre: true, fenetreActive: "f1" })).toEqual({ type: "cible", cible: { type: "site", id: "tuning" } });
});

test("small window of a site app → avis-site, never the active window", () => {
  expect(choisirCibleDesign({ petiteDeSite: "tuning", autreFenetre: true, fenetreActive: "f1" })).toEqual({ type: "avis-site", id: "tuning" });
  expect(choisirCibleDesign({ petiteDeSite: "tuning", autreFenetre: false, fenetreActive: "f1" })).toEqual({ type: "avis-site", id: "tuning" });
});

test("other window (neither main nor app) with an active window → nothing", () => {
  expect(choisirCibleDesign({ autreFenetre: true, fenetreActive: "f1" })).toEqual({ type: "rien" });
});

test("nothing in the foreground, active window f1 → target fenetre f1", () => {
  expect(choisirCibleDesign({ autreFenetre: false, fenetreActive: "f1" })).toEqual({ type: "cible", cible: { type: "fenetre", fenetreId: "f1" } });
});

test("nothing at all → nothing", () => {
  expect(choisirCibleDesign({ autreFenetre: false })).toEqual({ type: "rien" });
});
