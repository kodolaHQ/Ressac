import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dansLaVue, ecrireProjet, entreeAgent, lancer, nouveauProfil, nouvelleRacine, ouvrirOnglet, serveurTest, terminal } from "./aide";

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

async function ouvrir(o: { profil?: string; racine?: string } = {}) {
  const l = await lancer({ env: ENV, ...o });
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

async function cliquerSur(app: ElectronApplication, selecteur: string, o: { bouton?: "left" | "middle" | "right"; fois?: number } = {}) {
  const c = await dansPage<{ x: number; y: number }>(app, `(() => { const r = document.querySelector(${JSON.stringify(selecteur)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  const bouton = o.bouton ?? "left";
  const fois = o.fois ?? 1;
  await app.evaluate(async ({ webContents }, [c, bouton, fois]) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith("http://127.0.0.1:15283"))!;
    wc.sendInputEvent({ type: "mouseMove", x: c.x, y: c.y });
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 1; i <= fois; i++) {
      wc.sendInputEvent({ type: "mouseDown", x: c.x, y: c.y, button: bouton, clickCount: i });
      wc.sendInputEvent({ type: "mouseUp", x: c.x, y: c.y, button: bouton, clickCount: i });
    }
  }, [c, bouton, fois] as const);
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
    const r = await app.evaluate(async ({ webContents, nativeImage, screen }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith("http://127.0.0.1:15283"))!;
      const rect = { x: 50, y: 20, largeur: 80, hauteur: 30 };
      const vue = { largeur: 600, hauteur: 400 };
      const png = await (globalThis as unknown as { __webaiosViseur: { capturer(wc: unknown, r: unknown, v: unknown): Promise<Buffer | null> } }).__webaiosViseur.capturer(wc, rect, vue);
      if (!png) return null;
      const t = nativeImage.createFromBuffer(png).getSize();
      return { t, signature: png.subarray(1, 4).toString("latin1"), zoom: wc.getZoomFactor(), echelle: screen.getPrimaryDisplay().scaleFactor };
    });
    expect(r?.signature).toBe("PNG");
    // 80 + 32 de large, 30 + 32 de haut (le rect est loin des bords de la vue).
    expect(r!.t.width).toBe(Math.round(112 * r!.zoom * r!.echelle));
    expect(r!.t.height).toBe(Math.round(62 * r!.zoom * r!.echelle));
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

test("navigation sans nouveau document : le viseur s'arrête et les clics suivants atteignent la page", async () => {
  const { app, fermer } = await ouvrir();
  try {
    await armer(app);
    await dansPage(app, `history.pushState({}, "", "/x")`);
    expect(await resultat(app)).toBeNull();
    expect(await dansPage(app, `document.querySelectorAll("webaios-viseur").length`)).toBe(0);
    await cliquerSur(app, "#email");
    await expect.poll(() => dansPage<string[]>(app, "window.reactions")).toContain("click:email");
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("clic du milieu, clic droit et double clic n'atteignent pas la page", async () => {
  const { app, fermer } = await ouvrir();
  try {
    await armer(app);
    await cliquerSur(app, "#lien", { bouton: "middle" });
    await cliquerSur(app, "#lien", { bouton: "right" });
    await new Promise((r) => setTimeout(r, 300));
    expect(await dansPage(app, "window.reactions")).toEqual([]);
    expect(await dansPage(app, "location.href")).toBe(`${BASE}/`);
    // Le double clic : le premier clic capture, la suite (deuxième clic, dblclick) est avalée.
    await cliquerSur(app, "#envoyer", { fois: 2 });
    expect((await resultat(app))?.selecteur).toBe("#envoyer");
    await new Promise((r) => setTimeout(r, 300));
    expect(await dansPage(app, "window.reactions")).toEqual([]);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("un clic fabriqué par la page ne capture rien, un Échap fabriqué n'annule rien", async () => {
  const { app, fermer } = await ouvrir();
  try {
    await armer(app);
    await dansPage(app, `document.querySelector("li").click(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    await new Promise((r) => setTimeout(r, 300));
    expect(await dansPage(app, `document.querySelectorAll("webaios-viseur").length`)).toBe(1);
    await cliquerSur(app, "#email");
    expect((await resultat(app))?.selecteur).toBe("#email");
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("lireSource écarte les valeurs de la page qui n'ont pas la bonne forme", async () => {
  const { app, fermer } = await ouvrir();
  try {
    await dansPage(app, `document.querySelector("#nue").__svelte_meta = { loc: { file: {}, line: "x" } }`);
    const lire = () =>
      app.evaluate(({ webContents }) => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith("http://127.0.0.1:15283"))!;
        return (globalThis as unknown as { __webaiosViseur: { lireSource(wc: unknown, s: string): Promise<unknown> } }).__webaiosViseur.lireSource(wc, "#nue");
      });
    expect(await lire()).toBeNull();
    await dansPage(app, `document.querySelector("#nue").__svelte_meta = { loc: { file: "a.svelte", line: -3, column: 1.5 } }`);
    expect(await lire()).toEqual({ fichier: "a.svelte" });
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

// Le mode design branché dans l'interface : bouton, ⌘⇧D, bulle (calque design.html), panier.
const INDISPONIBLE = "Le mode design marche sur les applis de l'agent, les applis de site et les projets branchés par un Claude Code";
const menu = (app: ElectronApplication, id: string) => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.click(), id);
const viseurs = (app: ElectronApplication) => dansPage<number>(app, `document.querySelectorAll("webaios-viseur").length`);

/** La page du calque (bulle ou panier) : une vue posée sur une fenêtre. */
async function pageCalque(app: ElectronApplication): Promise<Page> {
  for (const fin = Date.now() + 10_000; Date.now() < fin; ) {
    const p = app.windows().find((x) => x.url().includes("design.html"));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("le calque du mode design n'est pas apparu");
}

/** Largeur de la vue de l'onglet de la démo, vue du process principal. */
const largeurVue = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows())
      for (const v of w.contentView.children) {
        const wc = (v as Electron.WebContentsView).webContents;
        if (wc && !wc.isDestroyed() && wc.getURL().startsWith("http://127.0.0.1:15283")) return v.getBounds().width;
      }
    return -1;
  });

/** Écrit une remarque dans la bulle ouverte sur `selecteur`, et l'ajoute au panier par ⌘Entrée. */
async function remarquer(app: ElectronApplication, selecteur: string, etiquette: string, texte: string) {
  await cliquerSur(app, selecteur);
  const calque = await pageCalque(app);
  const bulle = calque.getByTestId("bulle-design");
  await expect(bulle).toContainText(etiquette);
  await bulle.locator("textarea").fill(texte);
  await bulle.locator("textarea").press("Meta+Enter");
  return calque;
}

test("onglet hors des projets suivis : bouton désactivé, ⌘⇧D ne pose aucun viseur", async () => {
  const serveur = await serveurTest();
  const { app, fenetre, fermer } = await lancer({ env: ENV });
  try {
    await ouvrirOnglet(fenetre, `${serveur.url}/design.html`);
    await expect.poll(() => dansLaVue(app, "/design.html", "document.readyState")).toBe("complete");
    const bouton = fenetre.getByTestId("bouton-design");
    await expect(bouton).toBeDisabled();
    await expect(bouton).toHaveAttribute("title", INDISPONIBLE);
    await menu(app, "mode-design");
    await new Promise((r) => setTimeout(r, 400));
    expect(await dansLaVue(app, "/design.html", `document.querySelectorAll("webaios-viseur").length`)).toBe(0);
    await expect(bouton).toHaveAttribute("aria-pressed", "false");
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
    await serveur.fermer();
  }
});

test("onglet hors projet : ⌘⇧D (menu mode-design) n'injecte aucun viseur et le calque montre message-design = INDISPONIBLE, puis plus rien après 4 s", async () => {
  const serveur = await serveurTest();
  const { app, fenetre, fermer } = await lancer({ env: ENV });
  try {
    await ouvrirOnglet(fenetre, `${serveur.url}/design.html`);
    await expect.poll(() => dansLaVue(app, "/design.html", "document.readyState")).toBe("complete");
    await menu(app, "mode-design");
    let calque: Page | undefined;
    for (const fin = Date.now() + 10_000; !calque && Date.now() < fin; await new Promise((r) => setTimeout(r, 100)))
      calque = app.windows().find((x) => !x.url().startsWith("http") && x.url().includes("design.html"));
    expect(calque).toBeDefined();
    await expect(calque!.getByTestId("message-design")).toHaveText(INDISPONIBLE);
    expect(await dansLaVue(app, "/design.html", `document.querySelectorAll("webaios-viseur").length`)).toBe(0);
    await expect(fenetre.getByTestId("bouton-design")).toHaveAttribute("aria-pressed", "false");
    // Fermé seul au bout de 4 s : le calque est retiré de la fenêtre.
    const calqueAttache = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((w) => w.contentView.children.some((v) => { const u = (v as Electron.WebContentsView).webContents?.getURL() ?? ""; return !u.startsWith("http") && u.includes("design.html"); })),
      );
    expect(await calqueAttache()).toBe(true);
    await expect.poll(calqueAttache, { timeout: 8_000 }).toBe(false);
    await expect(calque!.getByTestId("message-design")).toHaveCount(0);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
    await serveur.fermer();
  }
});

test("⌘⇧D sur la démo : volet du panier, bulle sur #email, remarque au panier, viseur réarmé ; Annuler puis Échap", async () => {
  const { app, fenetre, fermer } = await ouvrir();
  try {
    await expect.poll(() => largeurVue(app)).toBeGreaterThan(300);
    const avant = await largeurVue(app);
    const bouton = fenetre.getByTestId("bouton-design");
    await expect(bouton).toBeEnabled();
    await menu(app, "mode-design");
    await expect(bouton).toHaveAttribute("aria-pressed", "true");
    await expect(fenetre.getByTestId("panier-design")).toBeVisible();
    await expect.poll(() => largeurVue(app)).toBe(avant - 300);
    await expect.poll(() => viseurs(app)).toBe(1);
    const calque = await remarquer(app, "#email", "input#email.champ", "Champ plus large");
    await expect(fenetre.getByTestId("remarque-panier")).toHaveCount(1);
    await expect(fenetre.getByTestId("remarque-panier")).toContainText("input#email.champ");
    await expect(fenetre.getByTestId("compteur-panier")).toHaveText("1");
    await expect(fenetre.getByTestId("envoyer-remarques")).toHaveText("Envoyer 1 remarque à l'agent");
    await expect.poll(() => viseurs(app)).toBe(1);
    // Annuler (Échap dans la bulle) : rien d'ajouté, le viseur revient aussitôt (clic juste après le réarmement).
    await cliquerSur(app, "#envoyer");
    await expect(calque.getByTestId("bulle-design")).toContainText("button#envoyer");
    await calque.getByTestId("bulle-design").locator("textarea").press("Escape");
    await expect.poll(() => viseurs(app)).toBe(1);
    await expect(fenetre.getByTestId("remarque-panier")).toHaveCount(1);
    // Échap dans la page : le mode s'arrête, le panier reste.
    await app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().find((w) => w.getURL().startsWith("http://127.0.0.1:15283"))!.sendInputEvent({ type: "keyDown", keyCode: "Escape" }),
    );
    await expect(bouton).toHaveAttribute("aria-pressed", "false");
    await expect(fenetre.getByTestId("panier-design")).toHaveCount(0);
    expect(await viseurs(app)).toBe(0);
    await expect(fenetre.getByTestId("compteur-panier")).toHaveText("1");
    expect(await dansPage(app, "window.reactions")).toEqual([]);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("deux remarques, rechargement puis redémarrage : le mode est coupé, le panier reste (racine/.webaios/remarques/demo-15283)", async () => {
  const profil = nouveauProfil();
  const racine = nouvelleRacine();
  let l = await ouvrir({ profil, racine });
  try {
    await menu(l.app, "mode-design");
    await expect.poll(() => viseurs(l.app)).toBe(1);
    await remarquer(l.app, "#email", "input#email.champ", "Champ plus large");
    await expect(l.fenetre.getByTestId("compteur-panier")).toHaveText("1");
    await expect.poll(() => viseurs(l.app)).toBe(1);
    await remarquer(l.app, "#envoyer", "button#envoyer", "Bouton en vert");
    await expect(l.fenetre.getByTestId("compteur-panier")).toHaveText("2");
    await l.app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().startsWith("http://127.0.0.1:15283"))!.reload());
    await expect(l.fenetre.getByTestId("bouton-design")).toHaveAttribute("aria-pressed", "false");
    await expect(l.fenetre.getByTestId("compteur-panier")).toHaveText("2");
    await aucuneFenetreVisible(l.app);
  } finally {
    await l.fermer();
  }
  l = await lancer({ profil, racine, env: ENV });
  try {
    await expect(l.fenetre.getByTestId("compteur-panier")).toHaveText("2", { timeout: 15_000 });
    const dossier = join(racine, ".webaios", "remarques", "demo-15283");
    expect(existsSync(join(dossier, "panier.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dossier, "panier.json"), "utf8"))).toHaveLength(2);
    await aucuneFenetreVisible(l.app);
  } finally {
    await l.fermer();
  }
});

test("changer d'onglet pendant le mode : le mode est coupé", async () => {
  const { app, fenetre, fermer } = await ouvrir();
  try {
    await menu(app, "mode-design");
    await expect(fenetre.getByTestId("bouton-design")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => viseurs(app)).toBe(1);
    await ouvrirOnglet(fenetre, "about:blank");
    await expect.poll(() => viseurs(app)).toBe(0);
    await expect(fenetre.getByTestId("bouton-design")).toHaveAttribute("aria-pressed", "false");
    await expect(fenetre.getByTestId("panier-design")).toHaveCount(0);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("fenêtre d'appli lancée par la page Applications : pastille WebAiOs, Mode design, bulle dans son calque, Panier", async () => {
  const racine = nouvelleRacine();
  ecrireProjet(racine, "essai", { manifeste: { nom: "Essai" }, serveur: "formulaire" });
  const { app, fenetre, fermer } = await lancer({ racine, env: ENV });
  try {
    await menu(app, "applications");
    const ligne = fenetre.getByTestId("appli-essai");
    await ligne.getByRole("button", { name: "Lancer" }).click();
    await expect(ligne).toHaveAttribute("data-etat", "en-marche", { timeout: 15_000 });
    const dansAppli = <T>(code: string) =>
      app.evaluate(({ webContents }, code) => webContents.getAllWebContents().find((w) => /^http:\/\/localhost:1528\d\//.test(w.getURL()))?.executeJavaScript(code) as Promise<T>, code);
    await expect.poll(() => dansAppli<string>("document.title")).toBe("Inscription");
    let pastille: Page | undefined;
    for (const fin = Date.now() + 10_000; !pastille && Date.now() < fin; await new Promise((r) => setTimeout(r, 100)))
      pastille = app.windows().find((x) => x.url().includes("pastille.html"));
    expect(pastille).toBeTruthy();
    await expect(pastille!.getByTestId("pastille-webaios")).toBeVisible();
    // L'appli lancée est « construite » : l'agent y a accès (88×28). Accès coupé, la pastille WebAiOs reste seule (48×28).
    await expect(pastille!.getByTestId("pastille-acces")).toHaveCount(1);
    await expect.poll(() => pastille!.evaluate(() => [innerWidth, innerHeight])).toEqual([88, 28]);
    await pastille!.getByTestId("pastille-acces").click();
    await pastille!.getByTestId("bulle-acces").getByRole("button", { name: "Couper l'accès" }).click();
    await expect(pastille!.getByTestId("pastille-acces")).toHaveCount(0);
    await expect(pastille!.getByTestId("pastille-webaios")).toBeVisible();
    await expect.poll(() => pastille!.evaluate(() => [innerWidth, innerHeight])).toEqual([48, 28]);
    await pastille!.getByTestId("pastille-webaios").click();
    await pastille!.getByRole("menuitem", { name: /Mode design/ }).click();
    await expect.poll(() => dansAppli<number>(`document.querySelectorAll("webaios-viseur").length`)).toBe(1);
    // Clic sur #email dans la fenêtre d'appli.
    const c = await dansAppli<{ x: number; y: number }>(`(() => { const r = document.querySelector("#email").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    await app.evaluate(async ({ webContents }, c) => {
      const wc = webContents.getAllWebContents().find((w) => /^http:\/\/localhost:1528\d\//.test(w.getURL()))!;
      wc.sendInputEvent({ type: "mouseMove", x: c.x, y: c.y });
      await new Promise((r) => setTimeout(r, 50));
      wc.sendInputEvent({ type: "mouseDown", x: c.x, y: c.y, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x: c.x, y: c.y, button: "left", clickCount: 1 });
    }, c);
    const calque = await pageCalque(app);
    await expect(calque.getByTestId("bulle-design")).toContainText("input#email.champ");
    // Le calque est un enfant de la fenêtre d'appli.
    expect(
      await app.evaluate(({ BrowserWindow }) => {
        const f = BrowserWindow.getAllWindows().find((w) => /^http:\/\/localhost:1528\d\//.test(w.webContents.getURL()));
        return !!f && f.contentView.children.some((v) => (v as Electron.WebContentsView).webContents?.getURL().includes("design.html"));
      }),
    ).toBe(true);
    await calque.getByTestId("bulle-design").locator("textarea").fill("Champ plus large");
    await calque.getByTestId("bulle-design").locator("textarea").press("Meta+Enter");
    await expect.poll(() => dansAppli<number>(`document.querySelectorAll("webaios-viseur").length`)).toBe(1);
    // « Panier » : le calque montre le panier de l'appli.
    await pastille!.getByTestId("pastille-webaios").click();
    await pastille!.getByRole("menuitem", { name: "Panier (1)" }).click();
    await expect(calque.getByTestId("panier-design")).toBeVisible();
    await expect(calque.getByTestId("remarque-panier")).toHaveCount(1);
    await expect(calque.getByTestId("envoyer-remarques")).toHaveText("Envoyer 1 remarque à l'agent");
    expect(readdirSync(join(racine, ".webaios", "remarques"))).toEqual(["app-essai"]);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

// L'envoi à l'agent : le texte est pré-rempli dans son terminal, jamais envoyé ; le panneau « Envoyés » suit le lot.
test("deux remarques sur la démo puis envoi : l'agent a le texte pré-rempli sans Entrée, le lot est sur disque, « Traité » ferme le lot", async () => {
  const racine = nouvelleRacine();
  const { app, fenetre, fermer } = await ouvrir({ racine });
  try {
    await menu(app, "mode-design");
    await expect.poll(() => viseurs(app)).toBe(1);
    await remarquer(app, "#email", "input#email.champ", "Champ plus large");
    await expect(fenetre.getByTestId("compteur-panier")).toHaveText("1");
    await expect.poll(() => viseurs(app)).toBe(1);
    await new Promise((r) => setTimeout(r, 600));
    await remarquer(app, "#envoyer", "button#envoyer", "Bouton en vert");
    await expect(fenetre.getByTestId("compteur-panier")).toHaveText("2");
    await fenetre.getByTestId("envoyer-remarques").click();
    await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
    await expect(terminal(fenetre)).toContainText("faux agent prêt>");
    await expect.poll(() => entreeAgent(racine)).toMatch(/^\[remarques de l'utilisateur — démo http:\/\/localhost:15283 : 1\) /);
    expect(entreeAgent(racine)).toContain("/workspace/.webaios/remarques/demo-15283/");
    await new Promise((r) => setTimeout(r, 300));
    expect(entreeAgent(racine)).not.toContain("\r");
    const dossier = join(racine, ".webaios", "remarques", "demo-15283");
    const lots = readdirSync(dossier).filter((n) => /^\d{8}T\d{6}Z-[0-9a-f]{4}$/.test(n));
    expect(lots).toHaveLength(1);
    expect(existsSync(join(dossier, lots[0]!, "lot.json"))).toBe(true);
    expect(readdirSync(join(dossier, lots[0]!)).filter((n) => n.endsWith(".png"))).toHaveLength(2);
    expect(entreeAgent(racine)).toContain(`/workspace/.webaios/remarques/demo-15283/${lots[0]}/lot.json] `);
    await expect(fenetre.getByTestId("remarque-panier")).toHaveCount(0);
    const lot = fenetre.getByTestId("lot-envoye");
    await expect(lot).toHaveCount(1);
    await expect(lot).toContainText("en attente");
    await expect(lot).toContainText("input#email.champ");
    // « Traité » : l'état passe à traité, le bouton disparaît.
    await lot.getByRole("button", { name: "Traité" }).click();
    await expect(lot).toContainText("traité");
    await expect(lot.getByRole("button", { name: "Traité" })).toHaveCount(0);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

test("fenêtre d'appli essai : l'envoi depuis le calque pré-remplit le terminal de la fenêtre principale", async () => {
  const racine = nouvelleRacine();
  ecrireProjet(racine, "essai", { manifeste: { nom: "Essai" }, serveur: "formulaire" });
  const { app, fenetre, fermer } = await lancer({ racine, env: ENV });
  try {
    await menu(app, "applications");
    const ligne = fenetre.getByTestId("appli-essai");
    await ligne.getByRole("button", { name: "Lancer" }).click();
    await expect(ligne).toHaveAttribute("data-etat", "en-marche", { timeout: 15_000 });
    const dansAppli = <T>(code: string) =>
      app.evaluate(({ webContents }, code) => webContents.getAllWebContents().find((w) => /^http:\/\/localhost:1528\d\//.test(w.getURL()))?.executeJavaScript(code) as Promise<T>, code);
    await expect.poll(() => dansAppli<string>("document.title")).toBe("Inscription");
    let pastille: Page | undefined;
    for (const fin = Date.now() + 10_000; !pastille && Date.now() < fin; await new Promise((r) => setTimeout(r, 100)))
      pastille = app.windows().find((x) => x.url().includes("pastille.html"));
    expect(pastille).toBeTruthy();
    await pastille!.getByTestId("pastille-webaios").click();
    await pastille!.getByRole("menuitem", { name: /Mode design/ }).click();
    await expect.poll(() => dansAppli<number>(`document.querySelectorAll("webaios-viseur").length`)).toBe(1);
    const c = await dansAppli<{ x: number; y: number }>(`(() => { const r = document.querySelector("#email").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    await app.evaluate(async ({ webContents }, c) => {
      const wc = webContents.getAllWebContents().find((w) => /^http:\/\/localhost:1528\d\//.test(w.getURL()))!;
      wc.sendInputEvent({ type: "mouseMove", x: c.x, y: c.y });
      await new Promise((r) => setTimeout(r, 50));
      wc.sendInputEvent({ type: "mouseDown", x: c.x, y: c.y, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x: c.x, y: c.y, button: "left", clickCount: 1 });
    }, c);
    const calque = await pageCalque(app);
    await calque.getByTestId("bulle-design").locator("textarea").fill("Champ plus large");
    await calque.getByTestId("bulle-design").locator("textarea").press("Meta+Enter");
    await pastille!.getByTestId("pastille-webaios").click();
    await pastille!.getByRole("menuitem", { name: "Panier (1)" }).click();
    await expect(calque.getByTestId("envoyer-remarques")).toHaveText("Envoyer 1 remarque à l'agent");
    await calque.getByTestId("envoyer-remarques").click();
    await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
    await expect(terminal(fenetre)).toContainText("faux agent prêt>");
    await expect.poll(() => entreeAgent(racine)).toContain("appli Essai (/workspace/projets/essai)");
    expect(entreeAgent(racine)).toContain("/workspace/.webaios/remarques/app-essai/");
    await new Promise((r) => setTimeout(r, 300));
    expect(entreeAgent(racine)).not.toContain("\r");
    await expect(calque.getByTestId("lot-envoye")).toHaveCount(1);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});

// De bout en bout : remarques de design dans la fenêtre d'appli, envoi à l'agent, relecture du changement, commentaire.
test("réussite de la spec : remarques sur l'appli inscription, envoi, modification par l'agent, relecture, commentaire, marquer comme relu", async () => {
  test.setTimeout(90_000);
  const racine = nouvelleRacine();
  ecrireProjet(racine, "inscription", { manifeste: { nom: "Inscription" }, serveur: "formulaire" });
  const { app, fenetre, profil, fermer } = await lancer({ racine, env: { ...ENV, WEBAIOS_PORT_MCP_EXTERNE: "0" } });
  try {
    // La première photo du projet est prise avant que « l'agent » ne le modifie.
    await expect.poll(() => existsSync(join(profil, "design", "relecture", "app-inscription.git", "refs", "webaios", "relu")), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => app.evaluate(({ Menu }) => !!Menu.getApplicationMenu()?.getMenuItemById("applications"))).toBe(true);
    await menu(app, "applications");
    const carte = fenetre.getByTestId("appli-inscription");
    await carte.getByRole("button", { name: "Lancer" }).click();
    await expect(carte).toHaveAttribute("data-etat", "en-marche", { timeout: 15_000 });
    const dansAppli = <T>(code: string) =>
      app.evaluate(({ webContents }, code) => webContents.getAllWebContents().find((w) => /^http:\/\/localhost:1528\d\//.test(w.getURL()))?.executeJavaScript(code) as Promise<T>, code);
    await expect.poll(() => dansAppli<string>("document.title")).toBe("Inscription");
    const cliquerAppli = async (selecteur: string) => {
      const c = await dansAppli<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(selecteur)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      await app.evaluate(async ({ webContents }, c) => {
        const wc = webContents.getAllWebContents().find((w) => /^http:\/\/localhost:1528\d\//.test(w.getURL()))!;
        wc.sendInputEvent({ type: "mouseMove", x: c.x, y: c.y });
        await new Promise((r) => setTimeout(r, 50));
        wc.sendInputEvent({ type: "mouseDown", x: c.x, y: c.y, button: "left", clickCount: 1 });
        wc.sendInputEvent({ type: "mouseUp", x: c.x, y: c.y, button: "left", clickCount: 1 });
      }, c);
    };
    let pastille: Page | undefined;
    for (const fin = Date.now() + 10_000; !pastille && Date.now() < fin; await new Promise((r) => setTimeout(r, 100)))
      pastille = app.windows().find((x) => x.url().includes("pastille.html"));
    expect(pastille).toBeTruthy();
    await pastille!.getByTestId("pastille-webaios").click();
    await pastille!.getByRole("menuitem", { name: /Mode design/ }).click();
    await expect.poll(() => dansAppli<number>(`document.querySelectorAll("webaios-viseur").length`)).toBe(1);
    const remarquerAppli = async (selecteur: string, etiquette: string, texte: string) => {
      await cliquerAppli(selecteur);
      const calque = await pageCalque(app);
      const bulle = calque.getByTestId("bulle-design");
      await expect(bulle).toContainText(etiquette);
      await bulle.locator("textarea").fill(texte);
      await bulle.locator("textarea").press("Meta+Enter");
      await expect.poll(() => dansAppli<number>(`document.querySelectorAll("webaios-viseur").length`)).toBe(1);
      return calque;
    };
    const calque = await remarquerAppli("#email", "input#email.champ", "refuser une adresse sans domaine");
    await new Promise((r) => setTimeout(r, 600));
    await remarquerAppli("#envoyer", "button#envoyer", "Bouton en vert");
    await pastille!.getByTestId("pastille-webaios").click();
    await pastille!.getByRole("menuitem", { name: "Panier (2)" }).click();
    await expect(calque.getByTestId("remarque-panier")).toHaveCount(2);
    await calque.getByTestId("envoyer-remarques").click();
    await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
    await expect(terminal(fenetre)).toContainText("faux agent prêt>");
    await expect.poll(() => entreeAgent(racine)).toContain(`1) "input#email.champ" : « refuser une adresse sans domaine »`);
    expect(entreeAgent(racine)).toContain(`2) "button#envoyer"`);
    expect(entreeAgent(racine)).toMatch(/\/workspace\/\.webaios\/remarques\/app-inscription\/\d{8}T\d{6}Z-[0-9a-f]{4}\/lot\.json/);
    await new Promise((r) => setTimeout(r, 300));
    expect(entreeAgent(racine)).not.toContain("\r");
    // L'agent modifie le projet.
    const serveurMjs = join(racine, "projets", "inscription", "serveur.mjs");
    writeFileSync(serveurMjs, readFileSync(serveurMjs, "utf8").replace(">Envoyer<", ">Valider<"));
    await pastille!.getByTestId("pastille-webaios").click();
    await pastille!.getByRole("menuitem", { name: "Relire ce projet" }).click();
    const page = fenetre.getByTestId("page-relecture");
    await expect(page).toBeVisible();
    const fichierServeur = page.getByTestId("fichier-relecture").filter({ hasText: "serveur.mjs" });
    await expect(fichierServeur).toHaveCount(1);
    await fichierServeur.click();
    await expect(page.locator('[data-testid="ligne-diff"].ajout')).toContainText([">Valider<"]);
    const ligneAjout = page.locator('[data-testid="ligne-diff"].ajout').first();
    await ligneAjout.getByTestId("ajouter-commentaire").click();
    await expect(page.getByTestId("formulaire-commentaire")).toBeVisible();
    const formulaire = page.getByTestId("formulaire-commentaire");
    await formulaire.locator("textarea").fill("garder le mot Envoyer");
    await formulaire.getByRole("button", { name: "Commenter" }).click();
    await page.getByTestId("envoyer-commentaires").click();
    await expect.poll(() => entreeAgent(racine)).toContain(`"serveur.mjs":`);
    expect(entreeAgent(racine)).toContain("« garder le mot Envoyer »");
    await expect(page.getByTestId("commentaire")).toContainText("envoyé");
    await page.getByTestId("marquer-relu").click();
    await expect(page.getByTestId("fichier-relecture")).toHaveCount(0);
    await aucuneFenetreVisible(app);
  } finally {
    await fermer();
  }
});
