import { describe, expect, it } from "vitest";
import { ETAT_WIDGET_PAR_DEFAUT, type DeclarationWidget, type EtatAccueil, type WidgetLu } from "../../../packages/noyau/src/index";
import { validerPlacements, versWidgetsAffiches } from "../noyau/widgets";

const declaration = (o: Partial<DeclarationWidget> = {}): DeclarationWidget => ({
  nom: "Démo",
  description: "",
  tailles: { min: { l: 2, h: 1 }, max: { l: 6, h: 4 }, defaut: { l: 4, h: 2 } },
  sources: { compte: [], publiques: [], web: false },
  ...o,
});

const widget = (o: Partial<Extract<WidgetLu, { declaration: DeclarationWidget }>> = {}): WidgetLu => ({
  id: "demo",
  dossier: "/espace/accueil/widgets/demo",
  declaration: declaration(),
  etat: { ...ETAT_WIDGET_PAR_DEFAUT },
  donnees: null,
  exemple: null,
  aRecolte: false,
  aWorkflow: false,
  aAffichage: true,
  ...o,
});

const etat = (widgets: WidgetLu[]): EtatAccueil => ({ disposition: [], widgets });

describe("versWidgetsAffiches", () => {
  it("rend les données, l'exemple, l'état et l'affichage versionné par la date", () => {
    const theme = { version: 1 as const, fond: "#101014" };
    const lu = versWidgetsAffiches({
      etat: etat([widget({ donnees: { n: 1 }, exemple: { n: 0 }, etat: { ...ETAT_WIDGET_PAR_DEFAUT, statut: "en-cours" } })]),
      placements: [],
      theme,
      mtimes: { demo: 1730000000123 },
    });
    expect(lu.theme).toBe(theme);
    expect(lu.widgets).toEqual([
      {
        id: "demo",
        nom: "Démo",
        // 4 unités de large sur 12 → 333 ‰ ; 2 rangées de 90 px.
        placement: { id: "demo", x: 0, y: 0, l: 333, h: 180 },
        tailles: { min: { l: 2, h: 1 }, max: { l: 6, h: 4 }, defaut: { l: 4, h: 2 } },
        src: "webaios-widget://demo/affichage.html?v=1730000000123",
        donnees: { n: 1 },
        exemple: { n: 0 },
        etat: { ...ETAT_WIDGET_PAR_DEFAUT, statut: "en-cours" },
        compte: [],
        publiques: [],
        aRecolte: false,
        heures: [],
        minutes: null,
      },
    ]);
  });

  it("sans affichage, src est null et la date n'est pas lue", () => {
    const lu = versWidgetsAffiches({ etat: etat([widget({ aAffichage: false })]), placements: [], theme: null, mtimes: {} });
    expect(lu.theme).toBeNull();
    expect(lu.widgets[0]).toMatchObject({ src: null });
  });

  it("garde la place voulue quand elle vient de disposition.json", () => {
    const lu = versWidgetsAffiches({ etat: etat([widget()]), placements: [{ id: "demo", x: 250, y: 360, l: 100, h: 90 }], theme: null, mtimes: {} });
    expect(lu.widgets[0]?.placement).toEqual({ id: "demo", x: 250, y: 360, l: 100, h: 90 });
  });

  it("place un widget illisible à sa taille par défaut (4 × 2)", () => {
    const lu = versWidgetsAffiches({
      etat: etat([{ id: "casse", dossier: "/espace/accueil/widgets/casse", erreur: "widget.json invalide" }]),
      placements: [],
      theme: null,
      mtimes: {},
    });
    expect(lu.widgets).toEqual([
      { id: "casse", erreur: "widget.json invalide", placement: { id: "casse", x: 0, y: 0, l: 333, h: 180 } },
    ]);
  });
});

describe("validerPlacements", () => {
  const ids = ["demo", "meteo"];
  const p = (o: Record<string, unknown> = {}) => ({ id: "demo", x: 0, y: 0, l: 500, h: 90, ...o });

  it("garde les placements entiers, dans la grille", () => {
    expect(validerPlacements([p(), p({ id: "meteo", x: 500 })], ids)).toEqual([p(), p({ id: "meteo", x: 500 })]);
  });

  it("refuse un nombre non entier", () => {
    expect(() => validerPlacements([p({ x: 1.5 })], ids)).toThrow();
  });

  it("refuse une position ou une taille hors bornes, et un débordement à droite", () => {
    expect(() => validerPlacements([p({ x: -1 })], ids)).toThrow();
    expect(() => validerPlacements([p({ y: -1 })], ids)).toThrow();
    expect(() => validerPlacements([p({ l: 0 })], ids)).toThrow();
    expect(() => validerPlacements([p({ h: 0 })], ids)).toThrow();
    expect(() => validerPlacements([p({ x: 501, l: 500 })], ids)).toThrow();
  });

  it("refuse un widget inconnu", () => {
    expect(() => validerPlacements([p({ id: "inconnu" })], ids)).toThrow(/inconnu/);
  });

  it("refuse un widget placé deux fois", () => {
    expect(() => validerPlacements([p(), p({ x: 500 })], ids)).toThrow(/deux fois/);
  });

  it("refuse autre chose qu'une liste", () => {
    expect(() => validerPlacements("nope", ids)).toThrow();
  });
});
