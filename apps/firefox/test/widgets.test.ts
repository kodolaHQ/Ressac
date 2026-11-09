import { describe, expect, it } from "vitest";
import { DEFAULT_WIDGET_STATE, type DeclarationWidget, type HomeState, type WidgetLu } from "../../../packages/noyau/src/index";
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
  etat: { ...DEFAULT_WIDGET_STATE },
  donnees: null,
  exemple: null,
  aRecolte: false,
  aWorkflow: false,
  aAffichage: true,
  ...o,
});

const etat = (widgets: WidgetLu[]): HomeState => ({ disposition: [], widgets });

describe("versWidgetsAffiches", () => {
  it("returns the data, the example, the state and the display versioned by date", () => {
    const theme = { version: 1 as const, fond: "#101014" };
    const lu = versWidgetsAffiches({
      etat: etat([widget({ donnees: { n: 1 }, exemple: { n: 0 }, etat: { ...DEFAULT_WIDGET_STATE, statut: "en-cours" } })]),
      placements: [],
      theme,
      mtimes: { demo: 1730000000123 },
    });
    expect(lu.theme).toBe(theme);
    expect(lu.widgets).toEqual([
      {
        id: "demo",
        nom: "Démo",
        // 4 units wide out of 12 → 333 ‰; 2 rows of 90 px.
        placement: { id: "demo", x: 0, y: 0, l: 333, h: 180 },
        tailles: { min: { l: 2, h: 1 }, max: { l: 6, h: 4 }, defaut: { l: 4, h: 2 } },
        src: "resource://webaios-widget-demo/affichage-1730000000123.html",
        donnees: { n: 1 },
        exemple: { n: 0 },
        etat: { ...DEFAULT_WIDGET_STATE, statut: "en-cours" },
        compte: [],
        publiques: [],
        aRecolte: false,
        heures: [],
        minutes: null,
      },
    ]);
  });

  it("without a display, src is null and the date is not read", () => {
    const lu = versWidgetsAffiches({ etat: etat([widget({ aAffichage: false })]), placements: [], theme: null, mtimes: {} });
    expect(lu.theme).toBeNull();
    expect(lu.widgets[0]).toMatchObject({ src: null });
  });

  it("keeps the wanted place when it comes from disposition.json", () => {
    const lu = versWidgetsAffiches({ etat: etat([widget()]), placements: [{ id: "demo", x: 250, y: 360, l: 100, h: 90 }], theme: null, mtimes: {} });
    expect(lu.widgets[0]?.placement).toEqual({ id: "demo", x: 250, y: 360, l: 100, h: 90 });
  });

  it("places an unreadable widget at its default size (4 × 2)", () => {
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

  it("keeps whole placements, within the grid", () => {
    expect(validerPlacements([p(), p({ id: "meteo", x: 500 })], ids)).toEqual([p(), p({ id: "meteo", x: 500 })]);
  });

  it("refuse un nombre non entier", () => {
    expect(() => validerPlacements([p({ x: 1.5 })], ids)).toThrow();
  });

  it("refuses a position or size out of bounds, and an overflow on the right", () => {
    expect(() => validerPlacements([p({ x: -1 })], ids)).toThrow();
    expect(() => validerPlacements([p({ y: -1 })], ids)).toThrow();
    expect(() => validerPlacements([p({ l: 0 })], ids)).toThrow();
    expect(() => validerPlacements([p({ h: 0 })], ids)).toThrow();
    expect(() => validerPlacements([p({ x: 501, l: 500 })], ids)).toThrow();
  });

  it("refuse un widget inconnu", () => {
    expect(() => validerPlacements([p({ id: "inconnu" })], ids)).toThrow(/inconnu/);
  });

  it("refuses a widget placed twice", () => {
    expect(() => validerPlacements([p(), p({ x: 500 })], ids)).toThrow(/deux fois/);
  });

  it("refuses widgets that overlap (an overlapping list would erase the layout on the next read)", () => {
    expect(() => validerPlacements([p(), p({ id: "meteo", x: 100 })], ids)).toThrow(/chevauchent/);
    // Edges that touch do not overlap.
    expect(validerPlacements([p(), p({ id: "meteo", x: 500 })], ids)).toHaveLength(2);
  });

  it("refuses anything other than a list", () => {
    expect(() => validerPlacements("nope", ids)).toThrow();
  });
});
