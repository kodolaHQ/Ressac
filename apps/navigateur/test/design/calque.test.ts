import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  WebContentsView: class {
    webContents = { isDestroyed: () => false, loadFile: async () => undefined, loadURL: async () => undefined, send: () => undefined, focus: () => undefined, close: () => undefined };
    setBackgroundColor() {}
    setBounds() {}
  },
}));

const { Calques } = await import("../../src/main/design/calque");

function fausseFenetre() {
  const f = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const enfants: unknown[] = [];
  Object.assign(f, {
    isDestroyed: () => false,
    getContentSize: () => [800, 600],
    contentView: { children: enfants, addChildView: (v: unknown) => enfants.push(v), removeChildView: (v: unknown) => enfants.splice(enfants.indexOf(v), 1) },
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
