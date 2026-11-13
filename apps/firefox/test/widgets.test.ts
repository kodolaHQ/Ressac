import { describe, expect, it } from "vitest";
import { DEFAULT_WIDGET_STATE, type DeclarationWidget, type HomeState, type WidgetRead } from "../../../packages/kernel/src/index";
import { validatePlacements, toShownWidgets } from "../host/widgets";

const declaration = (o: Partial<DeclarationWidget> = {}): DeclarationWidget => ({
  name: "Démo",
  description: "",
  sizes: { min: { w: 2, h: 1 }, max: { w: 6, h: 4 }, default: { w: 4, h: 2 } },
  sources: { account: [], public: [], web: false },
  ...o,
});

const widget = (o: Partial<Extract<WidgetRead, { declaration: DeclarationWidget }>> = {}): WidgetRead => ({
  id: "demo",
  folder: "/espace/home/widgets/demo",
  declaration: declaration(),
  state: { ...DEFAULT_WIDGET_STATE },
  data: null,
  example: null,
  hasHarvest: false,
  hasWorkflow: false,
  hasDisplay: true,
  ...o,
});

const state = (widgets: WidgetRead[]): HomeState => ({ layout: [], widgets });

describe("toShownWidgets", () => {
  it("returns the data, the example, the state and the display versioned by date", () => {
    const theme = { version: 1 as const, background: "#101014" };
    const parsed = toShownWidgets({
      state: state([widget({ data: { n: 1 }, example: { n: 0 }, state: { ...DEFAULT_WIDGET_STATE, status: "running" } })]),
      placements: [],
      theme,
      mtimes: { demo: 1730000000123 },
    });
    expect(parsed.theme).toBe(theme);
    expect(parsed.widgets).toEqual([
      {
        id: "demo",
        name: "Démo",
        // 4 units wide out of 12 → 333 ‰; 2 rows of 90 px.
        placement: { id: "demo", x: 0, y: 0, w: 333, h: 180 },
        sizes: { min: { w: 2, h: 1 }, max: { w: 6, h: 4 }, default: { w: 4, h: 2 } },
        src: "resource://ressac-widget-demo/display-1730000000123.html",
        data: { n: 1 },
        example: { n: 0 },
        state: { ...DEFAULT_WIDGET_STATE, status: "running" },
        account: [],
        public: [],
        hasHarvest: false,
        hours: [],
        minutes: null,
      },
    ]);
  });

  it("without a display, src is null and the date is not read", () => {
    const parsed = toShownWidgets({ state: state([widget({ hasDisplay: false })]), placements: [], theme: null, mtimes: {} });
    expect(parsed.theme).toBeNull();
    expect(parsed.widgets[0]).toMatchObject({ src: null });
  });

  it("keeps the wanted place when it comes from layout.json", () => {
    const parsed = toShownWidgets({ state: state([widget()]), placements: [{ id: "demo", x: 250, y: 360, w: 100, h: 90 }], theme: null, mtimes: {} });
    expect(parsed.widgets[0]?.placement).toEqual({ id: "demo", x: 250, y: 360, w: 100, h: 90 });
  });

  it("places an unreadable widget at its default size (4 × 2)", () => {
    const parsed = toShownWidgets({
      state: state([{ id: "casse", folder: "/espace/home/widgets/casse", error: "widget.json invalide" }]),
      placements: [],
      theme: null,
      mtimes: {},
    });
    expect(parsed.widgets).toEqual([
      { id: "casse", error: "widget.json invalide", placement: { id: "casse", x: 0, y: 0, w: 333, h: 180 } },
    ]);
  });
});

describe("validatePlacements", () => {
  const ids = ["demo", "meteo"];
  const p = (o: Record<string, unknown> = {}) => ({ id: "demo", x: 0, y: 0, w: 500, h: 90, ...o });

  it("keeps whole placements, within the grid", () => {
    expect(validatePlacements([p(), p({ id: "meteo", x: 500 })], ids)).toEqual([p(), p({ id: "meteo", x: 500 })]);
  });

  it("refuse un nombre non entier", () => {
    expect(() => validatePlacements([p({ x: 1.5 })], ids)).toThrow();
  });

  it("refuses a position or size out of bounds, and an overflow on the right", () => {
    expect(() => validatePlacements([p({ x: -1 })], ids)).toThrow();
    expect(() => validatePlacements([p({ y: -1 })], ids)).toThrow();
    expect(() => validatePlacements([p({ w: 0 })], ids)).toThrow();
    expect(() => validatePlacements([p({ h: 0 })], ids)).toThrow();
    expect(() => validatePlacements([p({ x: 501, w: 500 })], ids)).toThrow();
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
