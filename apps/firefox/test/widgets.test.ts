import { describe, expect, it } from "vitest";
import { DEFAULT_WIDGET_STATE, type DeclarationWidget, type HomeState, type WidgetLu } from "../../../packages/kernel/src/index";
import { validatePlacements, toShownWidgets } from "../host/widgets";

const declaration = (o: Partial<DeclarationWidget> = {}): DeclarationWidget => ({
  name: "Démo",
  description: "",
  sizes: { min: { l: 2, h: 1 }, max: { l: 6, h: 4 }, default: { l: 4, h: 2 } },
  sources: { account: [], public: [], web: false },
  ...o,
});

const widget = (o: Partial<Extract<WidgetLu, { declaration: DeclarationWidget }>> = {}): WidgetLu => ({
  id: "demo",
  folder: "/espace/accueil/widgets/demo",
  declaration: declaration(),
  state: { ...DEFAULT_WIDGET_STATE },
  data: null,
  example: null,
  hasHarvest: false,
  hasWorkflow: false,
  hasDisplay: true,
  ...o,
});

const state = (widgets: WidgetLu[]): HomeState => ({ layout: [], widgets });

describe("toShownWidgets", () => {
  it("returns the data, the example, the state and the display versioned by date", () => {
    const theme = { version: 1 as const, background: "#101014" };
    const lu = toShownWidgets({
      state: state([widget({ data: { n: 1 }, example: { n: 0 }, state: { ...DEFAULT_WIDGET_STATE, status: "en-cours" } })]),
      placements: [],
      theme,
      mtimes: { demo: 1730000000123 },
    });
    expect(lu.theme).toBe(theme);
    expect(lu.widgets).toEqual([
      {
        id: "demo",
        name: "Démo",
        // 4 units wide out of 12 → 333 ‰; 2 rows of 90 px.
        placement: { id: "demo", x: 0, y: 0, l: 333, h: 180 },
        sizes: { min: { l: 2, h: 1 }, max: { l: 6, h: 4 }, default: { l: 4, h: 2 } },
        src: "resource://webaios-widget-demo/display-1730000000123.html",
        data: { n: 1 },
        example: { n: 0 },
        state: { ...DEFAULT_WIDGET_STATE, status: "en-cours" },
        account: [],
        public: [],
        hasHarvest: false,
        hours: [],
        minutes: null,
      },
    ]);
  });

  it("without a display, src is null and the date is not read", () => {
    const lu = toShownWidgets({ state: state([widget({ hasDisplay: false })]), placements: [], theme: null, mtimes: {} });
    expect(lu.theme).toBeNull();
    expect(lu.widgets[0]).toMatchObject({ src: null });
  });

  it("keeps the wanted place when it comes from disposition.json", () => {
    const lu = toShownWidgets({ state: state([widget()]), placements: [{ id: "demo", x: 250, y: 360, l: 100, h: 90 }], theme: null, mtimes: {} });
    expect(lu.widgets[0]?.placement).toEqual({ id: "demo", x: 250, y: 360, l: 100, h: 90 });
  });

  it("places an unreadable widget at its default size (4 × 2)", () => {
    const lu = toShownWidgets({
      state: state([{ id: "casse", folder: "/espace/accueil/widgets/casse", error: "widget.json invalide" }]),
      placements: [],
      theme: null,
      mtimes: {},
    });
    expect(lu.widgets).toEqual([
      { id: "casse", error: "widget.json invalide", placement: { id: "casse", x: 0, y: 0, l: 333, h: 180 } },
    ]);
  });
});

describe("validatePlacements", () => {
  const ids = ["demo", "meteo"];
  const p = (o: Record<string, unknown> = {}) => ({ id: "demo", x: 0, y: 0, l: 500, h: 90, ...o });

  it("keeps whole placements, within the grid", () => {
    expect(validatePlacements([p(), p({ id: "meteo", x: 500 })], ids)).toEqual([p(), p({ id: "meteo", x: 500 })]);
  });

  it("refuse un nombre non entier", () => {
    expect(() => validatePlacements([p({ x: 1.5 })], ids)).toThrow();
  });

  it("refuses a position or size out of bounds, and an overflow on the right", () => {
    expect(() => validatePlacements([p({ x: -1 })], ids)).toThrow();
    expect(() => validatePlacements([p({ y: -1 })], ids)).toThrow();
    expect(() => validatePlacements([p({ l: 0 })], ids)).toThrow();
    expect(() => validatePlacements([p({ h: 0 })], ids)).toThrow();
    expect(() => validatePlacements([p({ x: 501, l: 500 })], ids)).toThrow();
  });

  it("refuse un widget inconnu", () => {
    expect(() => validatePlacements([p({ id: "inconnu" })], ids)).toThrow(/inconnu/);
  });

  it("refuses a widget placed twice", () => {
    expect(() => validatePlacements([p(), p({ x: 500 })], ids)).toThrow(/deux fois/);
  });

  it("refuses widgets that overlap (an overlapping list would erase the layout on the next read)", () => {
    expect(() => validatePlacements([p(), p({ id: "meteo", x: 100 })], ids)).toThrow(/chevauchent/);
    // Edges that touch do not overlap.
    expect(validatePlacements([p(), p({ id: "meteo", x: 500 })], ids)).toHaveLength(2);
  });

  it("refuses anything other than a list", () => {
    expect(() => validatePlacements("nope", ids)).toThrow();
  });
});
