import { expect, test, type ElectronApplication } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lancer, ouvrirOnglet } from "./aide";

const PORT = 15283;
const BASE = `http://127.0.0.1:${PORT}`;
const ENV = { WEBAIOS_PORTS_APPS: "15280-15284" };

let serveur: Server;
test.beforeAll(async () => {
  serveur = createServer((req, res) => {
    const chemin = (req.url ?? "/").split("?")[0];
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(chemin === "/autre" ? "<title>Autre</title>autre" : readFileSync(join(__dirname, "pages", "design.html")));
  });
  await new Promise<void>((ok) => serveur.listen(PORT, "127.0.0.1", ok));
});
test.afterAll(() => new Promise<void>((ok) => serveur.close(() => ok())));

async function ouvrir() {
  const l = await lancer({ env: ENV });
  await ouvrirOnglet(l.fenetre, `${BASE}/`);
  await expect.poll(() => l.app.evaluate(({ webContents }) => webContents.getAllWebContents().some((w) => w.getURL() === "http://127.0.0.1:15283/" && !w.isLoading()))).toBe(true);
  return l;
}

type Capture = { selecteur: string; html: string; styles: Record<string, string>; rect: { x: number; y: number; largeur: number; hauteur: number }; adresse: string; vue: { largeur: number; hauteur: number }; etiquette: string; voisinage: { parent: string; freres: string[] } } | null;

/** Arme le viseur et renvoie un jeton ; la capture se lit par `resultat`. */
async function armer(app: ElectronApplication) {
  await app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith("http://127.0.0.1:15283"))!;
    const g = globalThis as unknown as { __webaiosViseur: { armer(wc: unknown): Promise<unknown> }; __essai?: Promise<unknown> };
    g.__essai = g.__webaiosViseur.armer(wc);
  });
}
const resultat = (app: ElectronApplication) =>
  app.evaluate(async () => (globalThis as unknown as { __essai: Promise<unknown> }).__essai) as Promise<Capture>;

const dansPage = <T>(app: ElectronApplication, code: string) =>
  app.evaluate(({ webContents }, code) => webContents.getAllWebContents().find((w) => w.getURL().startsWith("http://127.0.0.1:15283"))!.executeJavaScript(code) as Promise<T>, code);

async function cliquerSur(app: ElectronApplication, selecteur: string) {
  const c = await dansPage<{ x: number; y: number }>(app, `(() => { const r = document.querySelector(${JSON.stringify(selecteur)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  await app.evaluate(async ({ webContents }, c) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith("http://127.0.0.1:15283"))!;
    wc.sendInputEvent({ type: "mouseMove", x: c.x, y: c.y });
    await new Promise((r) => setTimeout(r, 50));
    wc.sendInputEvent({ type: "mouseDown", x: c.x, y: c.y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: c.x, y: c.y, button: "left", clickCount: 1 });
  }, c);
}

const aucuneFenetreVisible = async (app: ElectronApplication) =>
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()))).toBe(false);

test("clic sur #envoyer : la page ne réagit pas, la capture décrit le bouton", async () => {
  const { app, fermer } = await ouvrir();
  try {
    await armer(app);
    await cliquerSur(app, "#envoyer");
    const c = await resultat(app);
    expect(c?.selecteur).toBe("#envoyer");
    expect(c?.html.startsWith("<button")).toBe(true);
    expect(c?.styles.display).toBeTruthy();
    expect(c!.rect.largeur).toBeGreaterThan(0);
    expect(c!.rect.hauteur).toBeGreaterThan(0);
    expect(c?.adresse).toBe(`${BASE}/`);
    expect(await dansPage(app, "window.reactions")).toEqual([]);
    expect(await dansPage(app, "location.href")).toBe(`${BASE}/`);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("clic sur #lien : l'adresse de l'onglet ne change pas", async () => {
  const { app, fermer } = await ouvrir();
  try {
    await armer(app);
    await cliquerSur(app, "#lien");
    expect((await resultat(app))?.selecteur).toBe("#lien");
    await new Promise((r) => setTimeout(r, 500));
    expect(await dansPage(app, "location.href")).toBe(`${BASE}/`);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("clic sur un élément sans id : le sélecteur n'en désigne qu'un, celui cliqué", async () => {
  const { app, fermer } = await ouvrir();
  try {
    await armer(app);
    await cliquerSur(app, "li:nth-child(2)");
    const c = await resultat(app);
    expect(c?.selecteur).toBeTruthy();
    expect(await dansPage(app, `(() => { const l = document.querySelectorAll(${JSON.stringify(c!.selecteur)}); return l.length === 1 && l[0].textContent === "deux"; })()`)).toBe(true);
    expect(c!.voisinage.freres.length).toBeGreaterThan(0);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("après la capture ou Échap : plus de viseur dans le DOM, aucun global ajouté à la page", async () => {
  const { app, fermer } = await ouvrir();
  try {
    const cles = await dansPage<string[]>(app, "Object.keys(window).sort()");
    await armer(app);
    expect(await dansPage(app, `document.querySelectorAll("webaios-viseur").length`)).toBe(1);
    await app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().find((w) => w.getURL().startsWith("http://127.0.0.1:15283"))!.sendInputEvent({ type: "keyDown", keyCode: "Escape" }),
    );
    expect(await resultat(app)).toBeNull();
    expect(await dansPage(app, `document.querySelectorAll("webaios-viseur").length`)).toBe(0);
    expect(await dansPage(app, "Object.keys(window).sort()")).toEqual(cles);
    await armer(app);
    await cliquerSur(app, "#email");
    expect((await resultat(app))?.selecteur).toBe("#email");
    expect(await dansPage(app, `document.querySelectorAll("webaios-viseur").length`)).toBe(0);
    expect(await dansPage(app, "Object.keys(window).sort()")).toEqual(cles);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("lireSource : data-source lu, null sans source", async () => {
  const { app, fermer } = await ouvrir();
  try {
    const lire = (sel: string) =>
      app.evaluate(({ webContents }, sel) => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith("http://127.0.0.1:15283"))!;
        return (globalThis as unknown as { __webaiosViseur: { lireSource(wc: unknown, s: string): Promise<unknown> } }).__webaiosViseur.lireSource(wc, sel);
      }, sel);
    expect(await lire("p[data-source]")).toEqual({ fichier: "src/Inscription.svelte", ligne: 12 });
    expect(await lire("#nue")).toBeNull();
    expect(await dansPage(app, "Object.keys(window).filter((k) => /viseur|webaios/i.test(k))")).toEqual([]);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("capturerElement rend un PNG de la taille de rectCapture", async () => {
  const { app, fermer } = await ouvrir();
  try {
    const r = await app.evaluate(async ({ webContents, nativeImage }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith("http://127.0.0.1:15283"))!;
      const rect = { x: 50, y: 20, largeur: 80, hauteur: 30 };
      const vue = { largeur: 600, hauteur: 400 };
      const png = await (globalThis as unknown as { __webaiosViseur: { capturer(wc: unknown, r: unknown, v: unknown): Promise<Buffer | null> } }).__webaiosViseur.capturer(wc, rect, vue);
      if (!png) return null;
      const t = nativeImage.createFromBuffer(png).getSize();
      return { t, signature: png.subarray(1, 4).toString("latin1"), zoom: wc.getZoomFactor() };
    });
    expect(r?.signature).toBe("PNG");
    // 80 + 32 de large, 30 + 32 de haut (le rect est loin des bords de la vue).
    expect(r!.t.width).toBe(112 * r!.zoom);
    expect(r!.t.height).toBe(62 * r!.zoom);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("recharger la page pendant le viseur : armerViseur rend null", async () => {
  const { app, fermer } = await ouvrir();
  try {
    await armer(app);
    await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().startsWith("http://127.0.0.1:15283"))!.reload());
    expect(await resultat(app)).toBeNull();
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});
