import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appelerOutil, ecrireProjet, lancer, nouvelleRacine } from "./aide";

/** Ports d'essai, jamais ceux des vraies applis de l'utilisateur ; délai court avant « En erreur ». */
const ENV = { WEBAIOS_PORTS_APPS: "15280-15284", WEBAIOS_DELAI_APP_MS: "3000" };

const racines: string[] = [];
// Un test qui échoue en route ne doit pas laisser de serveur d'essai sur un port.
test.afterEach(() => {
  for (const racine of racines.splice(0))
    for (const f of existsSync(racine) ? readdirSync(racine) : [])
      if (/^faux-docker-app-.*\.pid$/.test(f))
        try {
          process.kill(-Number(readFileSync(join(racine, f), "utf8")), "SIGKILL");
        } catch {
          // déjà arrêté
        }
});

async function demarrer(o: { serveur?: "ok" | "plante" } = {}) {
  const racine = nouvelleRacine();
  racines.push(racine);
  ecrireProjet(racine, "essai", { manifeste: { nom: "Essai" }, serveur: o.serveur ?? "ok" });
  const l = await lancer({ racine, env: ENV });
  await expect.poll(() => existsSync(join(racine, ".webaios", "mcp.json")), { timeout: 10_000 }).toBe(true);
  return l;
}

/** Lance l'appli « essai » par l'outil de l'agent ; renvoie son port. */
async function lancerEssai(racine: string): Promise<number> {
  const { texte } = await appelerOutil(racine, "lancer_application", { dossier: "essai" });
  expect(texte).toContain("en marche sur http://localhost:1528");
  return Number(/localhost:(\d+)/.exec(texte)![1]);
}

async function pageAppli(app: ElectronApplication): Promise<Page> {
  for (const fin = Date.now() + 10_000; Date.now() < fin; ) {
    for (const p of app.windows()) if ((await p.title().catch(() => "")) === "Essai essai") return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("la fenêtre de l'appli n'est pas apparue");
}

async function repond(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

const arrets = (racine: string) => {
  const f = join(racine, "faux-docker-arrets.log");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};

/** URL des onglets de l'état, lue par l'interface. */
const urlsOnglets = (fenetre: Page) =>
  fenetre.evaluate(
    () =>
      new Promise<string[]>((ok) => {
        type Api = { webaios: { surEtat(r: (e: { onglets: Record<string, { url: string }> }) => void): () => void } };
        const fin = (window as unknown as Api).webaios.surEtat((e) => {
          setTimeout(() => fin());
          ok(Object.values(e.onglets).map((o) => o.url));
        });
      }),
  );

/** Agit sur la BrowserWindow de l'appli « Essai » depuis le process principal. */
const fenetreAppli = (app: ElectronApplication, action: "redimensionner" | "taille" | "fermer") =>
  app.evaluate(({ BrowserWindow }, action) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === "Essai");
    if (!w) return undefined;
    if (action === "redimensionner") w.setBounds({ x: 120, y: 90, width: 640, height: 480 });
    if (action === "fermer") w.close();
    const { width, height } = w.getBounds();
    return [width, height];
  }, action);

test("lancer_application ouvre une fenêtre sans barre sur l'appli", async () => {
  const { app, racine, fermer } = await demarrer();
  await lancerEssai(racine);
  const page = await pageAppli(app);
  expect(page.url()).toMatch(/^http:\/\/localhost:1528\d\/$/);
  await expect(page.getByTestId("barre-laterale")).toHaveCount(0);
  await fermer();
});

test("après lancer_application, l'agent lit et capture la fenêtre de l'appli sans demande", async () => {
  const { fenetre, racine, fermer } = await demarrer();
  const { texte } = await appelerOutil(racine, "lancer_application", { dossier: "essai" });
  expect(texte).toContain("(onglet app:essai)");
  const lu = await appelerOutil(racine, "lire_onglet", { id: "app:essai" });
  // Titre de la fenêtre (le nom de l'appli) puis texte de la page ; « Essai essai » est le <title> de la page, pas son texte.
  expect(lu.texte).toContain("Titre : Essai");
  expect(lu.texte).toContain("lien");
  const capture = await appelerOutil(racine, "capture_ecran", { id: "app:essai" });
  expect(capture.image!.length).toBeGreaterThan(1000);
  await expect(fenetre.getByTestId("demande-permission")).toHaveCount(0);
  await fermer();
});

test("fermer la fenêtre de l'appli l'arrête", async () => {
  const { app, racine, fermer } = await demarrer();
  const port = await lancerEssai(racine);
  const page = await pageAppli(app);
  expect(await repond(port)).toBe(true);
  await page.close();
  await expect.poll(() => arrets(racine), { timeout: 5_000 }).toContain("WEBAIOS_APP=essai");
  await expect.poll(() => repond(port), { timeout: 5_000 }).toBe(false);
  await fermer();
});

test("fermer la fenêtre de l'agent n'arrête pas l'appli", async () => {
  const { app, fenetre, racine, fermer } = await demarrer();
  const port = await lancerEssai(racine);
  const page = await pageAppli(app);
  const menu = (id: string) => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.click(), id);
  await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
  await menu("panneau-agent");
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await menu("panneau-agent");
  await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
  await menu("fermer-fenetre");
  await expect.poll(() => app.windows().some((p) => p.url().includes("/renderer/index.html"))).toBe(false);
  expect(page.isClosed()).toBe(false);
  expect(await repond(port)).toBe(true);
  expect(arrets(racine)).not.toContain("WEBAIOS_APP=essai");
  await fermer();
});

test("un lien externe de l'appli s'ouvre dans un onglet de la fenêtre principale", async () => {
  const { app, fenetre, racine, fermer } = await demarrer();
  await lancerEssai(racine);
  const page = await pageAppli(app);
  // Clic par la page : Playwright attendrait sans fin la navigation que l'appli annule.
  await page.evaluate(() => document.querySelector("a")!.click());
  await expect.poll(() => urlsOnglets(fenetre)).toContain("https://exemple.invalide/");
  expect(page.url()).toMatch(/^http:\/\/localhost:/);
  await fermer();
});

test("une appli qui plante n'ouvre pas de fenêtre", async () => {
  const { app, racine, fermer } = await demarrer({ serveur: "plante" });
  const { texte } = await appelerOutil(racine, "lancer_application", { dossier: "essai" });
  expect(texte).toContain("en erreur");
  expect(texte).toContain("boum");
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await fermer();
});

test("au lancement, les applis orphelines sont arrêtées", async () => {
  const { racine, fermer } = await demarrer();
  await expect.poll(() => arrets(racine), { timeout: 10_000 }).toContain("WEBAIOS_APP=.*");
  await fermer();
});

test("⌘Q arrête les applis en marche", async () => {
  const { app, racine } = await demarrer();
  const port = await lancerEssai(racine);
  await pageAppli(app);
  await app.close();
  expect(arrets(racine)).toContain("WEBAIOS_APP=essai");
  expect(await repond(port)).toBe(false);
});

test("taille de la fenêtre d'appli retenue", async () => {
  const { app, racine, fermer } = await demarrer();
  await lancerEssai(racine);
  await pageAppli(app);
  await fenetreAppli(app, "redimensionner");
  await fenetreAppli(app, "fermer");
  // Fenêtre fermée : son arrêt est demandé ; la relance attend la fin du script d'arrêt.
  await expect.poll(() => fenetreAppli(app, "taille")).toBeUndefined();
  await lancerEssai(racine);
  await pageAppli(app);
  expect(await fenetreAppli(app, "taille")).toEqual([640, 480]);
  await fermer();
});
