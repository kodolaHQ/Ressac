import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  WebContentsView: class {
    webContents = { isDestroyed: () => false, loadFile: async () => undefined, loadURL: async () => undefined, send: () => undefined, focus: () => undefined, close: () => undefined };
    setBackgroundColor() {}
    bornes: unknown = null;
    setBounds(b: unknown) {
      this.bornes = b;
    }
  },
}));

const { Calques } = await import("../../src/main/design/calque");

function fausseFenetre() {
  const f = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const enfants: unknown[] = [];
  Object.assign(f, {
    isDestroyed: () => false,
    getContentSize: () => [800, 600],
    contentView: { children: enfants, addChildView: (v: unknown) => {
        // Comme Electron : une vue rajoutée passe au-dessus, sans doublon.
        if (enfants.includes(v)) enfants.splice(enfants.indexOf(v), 1);
        enfants.push(v);
      }, removeChildView: (v: unknown) => enfants.splice(enfants.indexOf(v), 1) },
  });
  return f;
}

test("un calque recréé pour la même fenêtre n'ajoute pas un écouteur resize de plus", () => {
  const calques = new Calques();
  const f = fausseFenetre();
  const place = { x: 0, y: 0, width: 10, height: 10 };
  for (let i = 0; i < 5; i++) {
    calques.montrerBulle("fenetre:1", f as never, place, {} as never);
    calques.oublier("fenetre:1");
  }
  calques.montrerBulle("fenetre:1", f as never, place, {} as never);
  expect(f.listenerCount("resize")).toBe(1);
  expect(f.listenerCount("closed")).toBe(1);
  calques.oublier("fenetre:1");
  expect(f.listenerCount("resize")).toBe(0);
});

test("montrerPanier avec la marge 48 dans une fenêtre 800×600 : sous la barre ; sans marge : 12 px des bords", () => {
  const calques = new Calques();
  const f = fausseFenetre();
  const enfants = (f.contentView as { children: { bornes: unknown }[] }).children;
  calques.montrerPanier("site:tuning", f as never, {} as never, 48);
  expect(enfants[0]!.bornes).toEqual({ x: 448, y: 48, width: 340, height: 540 });
  // Recalculées au resize, avec la même marge.
  f.emit("resize");
  expect(enfants[0]!.bornes).toEqual({ x: 448, y: 48, width: 340, height: 540 });
  const g = fausseFenetre();
  calques.montrerPanier("app:essai", g as never, {} as never);
  expect((g.contentView as { children: { bornes: unknown }[] }).children[0]!.bornes).toEqual({ x: 448, y: 12, width: 340, height: 576 });
});

test("montrerMessage : vue ajoutée aux bornes données, contexte mode message ; retirée après 4 000 ms ; fermerMessage la retire tout de suite ; pendant une bulle, montrerMessage ne change rien", () => {
  vi.useFakeTimers();
  try {
    const calques = new Calques();
    const f = fausseFenetre();
    const enfants = (f.contentView as { children: { bornes: unknown }[] }).children;
    const place = { x: 428, y: 12, width: 360, height: 56 };
    calques.montrerMessage("fenetre:1", f as never, place, "Indisponible");
    expect(enfants).toHaveLength(1);
    expect(enfants[0]!.bornes).toEqual(place);
    expect(calques.contexte("fenetre:1")).toEqual({ mode: "message", message: "Indisponible", projet: "", etiquette: "", source: null, destination: null, sansDestination: null, avertissement: null });
    vi.advanceTimersByTime(3999);
    expect(enfants).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(enfants).toHaveLength(0);
    expect(calques.contexte("fenetre:1")).toBeNull();

    // Un nouveau message relance la minuterie.
    calques.montrerMessage("fenetre:1", f as never, place, "Indisponible");
    vi.advanceTimersByTime(3000);
    calques.montrerMessage("fenetre:1", f as never, place, "Indisponible");
    vi.advanceTimersByTime(3000);
    expect(enfants).toHaveLength(1);
    calques.fermerMessage("fenetre:1");
    expect(enfants).toHaveLength(0);
    expect(calques.contexte("fenetre:1")).toBeNull();

    // Pendant une bulle : rien ne change.
    const bulle = { mode: "bulle" } as never;
    const placeBulle = { x: 0, y: 0, width: 320, height: 170 };
    calques.montrerBulle("fenetre:1", f as never, placeBulle, bulle);
    calques.montrerMessage("fenetre:1", f as never, place, "Indisponible");
    expect(calques.contexte("fenetre:1")).toBe(bulle);
    expect(enfants[enfants.length - 1]!.bornes).toEqual(placeBulle);
    calques.fermerBulle("fenetre:1");
    expect(calques.contexte("fenetre:1")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
