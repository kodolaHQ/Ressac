import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { armerViseur, desarmerViseur, rectCapture, resultatViseurCadre } from "../../src/main/design/viseur";

test("rectCapture : marge de 16 de chaque côté, bornée à la vue", () => {
  expect(rectCapture({ x: 10, y: 10, largeur: 100, hauteur: 20 }, { largeur: 800, hauteur: 600 }, 1)).toEqual({ x: 0, y: 0, width: 126, height: 46 });
});

test("rectCapture : le zoom double tout puis borne à 1600×1200", () => {
  expect(rectCapture({ x: 10, y: 10, largeur: 100, hauteur: 20 }, { largeur: 800, hauteur: 600 }, 2)).toEqual({ x: 4, y: 4, width: 232, height: 72 });
  expect(rectCapture({ x: 0, y: 0, largeur: 900, hauteur: 700 }, { largeur: 800, hauteur: 600 }, 2)).toEqual({ x: 0, y: 0, width: 1600, height: 1200 });
});

test("rectCapture : un élément au bord bas-droit est borné à la vue", () => {
  expect(rectCapture({ x: 700, y: 560, largeur: 100, hauteur: 40 }, { largeur: 800, hauteur: 600 }, 1)).toEqual({ x: 684, y: 544, width: 116, height: 56 });
});

test("rectCapture : décalé de la place du cadre dans sa page, après le bornage à la vue du cadre", () => {
  expect(rectCapture({ x: 0, y: 0, largeur: 50, hauteur: 20 }, { largeur: 800, hauteur: 600 }, 1, { x: 10, y: 36 })).toEqual({ x: 10, y: 36, width: 66, height: 36 });
});

/** Un faux cadre (id 7) : ce qu'il reçoit est noté ; la page de l'interface ne doit jamais être visée. */
function fauxCadre() {
  const envois: { jeton: number; monde: number; code: string }[] = [];
  const cadre = { frameTreeNodeId: 7, isDestroyed: () => false, send: (_c: string, m: (typeof envois)[number]) => envois.push(m), executeJavaScript: async () => null };
  const wc = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: vi.fn(async () => null),
  });
  return { cadre, wc, envois };
}

test("armerViseur dans un cadre : le code part au preload du cadre (monde 1999), jamais dans la page ; un résultat d'un autre cadre est ignoré", async () => {
  const { cadre, wc, envois } = fauxCadre();
  const p = armerViseur(wc as never, cadre);
  expect(wc.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  expect(envois).toHaveLength(1);
  expect(envois[0]!.monde).toBe(1999);
  const capture = {
    selecteur: "h1", etiquette: "h1", html: "<h1>x</h1>", voisinage: { parent: "body", freres: [] }, styles: {},
    rect: { x: 1, y: 2, largeur: 3, hauteur: 4 }, adresse: "webaios-site://tuning/index.html", vue: { largeur: 800, hauteur: 600 },
  };
  resultatViseurCadre({ frameTreeNodeId: 8 }, envois[0]!.jeton, capture);
  resultatViseurCadre(null, envois[0]!.jeton, capture);
  let fini = false;
  void p.then(() => (fini = true));
  await new Promise((ok) => setTimeout(ok, 0));
  expect(fini).toBe(false);
  resultatViseurCadre({ frameTreeNodeId: 7 }, envois[0]!.jeton, capture);
  expect((await p)?.selecteur).toBe("h1");
});

test("armerViseur dans un cadre : la navigation de ce cadre l'arrête (null) ; celle de la page de l'interface, non", async () => {
  const { cadre, wc, envois } = fauxCadre();
  const p = armerViseur(wc as never, cadre);
  let fini = false;
  void p.then(() => (fini = true));
  wc.emit("did-start-navigation", { isMainFrame: true, frame: { frameTreeNodeId: 1 } });
  await new Promise((ok) => setTimeout(ok, 0));
  expect(fini).toBe(false);
  wc.emit("did-start-navigation", { isMainFrame: false, frame: { frameTreeNodeId: 7 } });
  expect(await p).toBeNull();
  // L'arrêt est aussi envoyé au cadre.
  expect(envois).toHaveLength(2);
});

test("desarmerViseur dans un cadre déjà retiré : rend la main sans réponse du cadre, l'armement en cours rend null", async () => {
  const { cadre, wc, envois } = fauxCadre();
  const p = armerViseur(wc as never, cadre);
  await desarmerViseur(wc as never, cadre);
  expect(await p).toBeNull();
  // L'arrêt est tout de même envoyé ; les réponses tardives sont ignorées.
  expect(envois.length).toBeGreaterThanOrEqual(2);
  resultatViseurCadre({ frameTreeNodeId: 7 }, envois[0]!.jeton, { selecteur: "x" });
  await desarmerViseur(wc as never, cadre);
});
