import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { dansLaVue, ecrireSite, etatVueSite, fenetreSite, lancer, nouveauProfil, nouvelleRacine, ouvrirOnglet, serveurSites, vueSite } from "./aide";
import { installerStoreFactice } from "./extensions/fixtures";

/**
 * Plan 16 : les extensions du Store dans les applis de site, activées appli par appli. L'extension de ces tests imite
 * uBlock Origin Lite (`ublock-factice`) : elle bloque `pub.localhost` et cache `.pub`. Jamais le réseau réel ni le vrai
 * Store ; aucune fenêtre n'est jamais montrée.
 */

/** Les hôtes de test `*.localhost` sont permis (http compris) ; jamais une vraie adresse. */
const ENV = { WEBAIOS_TEST_ADRESSES_LOCALES: "1" };

let serveur: Awaited<ReturnType<typeof serveurSites>>;

test.beforeAll(async () => {
  serveur = await serveurSites();
  const pub = (c: string) => serveur.url("pub.localhost", c);
  serveur.definir(
    "vidola-a.localhost",
    "/pubs",
    `<title>Pubs</title><div class="pub" id="banniere">pub</div><img id="img" src="${pub("/pub.png")}"><script src="${pub("/pub.js")}"></script>`,
  );
  serveur.definir("vidola-a.localhost", "/film/2", "<title>Film 2</title>");
  serveur.definir("vidola-b.localhost", "/", "<title>Autre</title>");
  serveur.definir("pub.localhost", "/pub.js", (_req, res) => res.writeHead(200, { "Content-Type": "text/javascript" }).end("window.pubChargee = 1;"));
  serveur.definir("pub.localhost", "/pub.png", (_req, res) => res.writeHead(200, { "Content-Type": "image/png" }).end());
});
test.afterAll(() => serveur.fermer());
test.beforeEach(() => void serveur.requetes.splice(0));

const vidola = () => ({
  declaration: { nom: "Vidola", adresse: serveur.url("vidola-a.localhost", "/pubs"), domaines: ["vidola-a.localhost"], connexion: ["compte.localhost"] },
});
const autre = () => ({ declaration: { nom: "Autre", adresse: serveur.url("vidola-b.localhost", "/"), domaines: ["vidola-b.localhost"] } });

/** Les requêtes de la page vers `pub.localhost` (`/pub.js`, `/pub.png`) reçues depuis le dernier effacement. */
const pubsDemandees = () => serveur.requetes.filter((r) => r.hote === "pub.localhost" && (r.chemin === "/pub.js" || r.chemin === "/pub.png")).map((r) => r.chemin);

/** L'extension installée comme si elle venait du Store (avant le lancement), puis WebAiOs lancé et ses extensions prêtes. */
async function demarrer(o: { profils?: string[] } = {}) {
  const profil = nouveauProfil();
  const { id } = installerStoreFactice(profil, "ublock-factice", { profils: o.profils ?? [] });
  const racine = nouvelleRacine();
  ecrireSite(racine, "vidola", vidola());
  ecrireSite(racine, "autre", autre());
  const lance = await lancer({ profil, racine, env: ENV });
  await expect.poll(() => lance.app.evaluate(() => (globalThis as { __webaiosExtensionsPretes?: boolean }).__webaiosExtensionsPretes === true)).toBe(true);
  return { ...lance, id, cle: `store:${id}` };
}

type ApiSites = { webaios: { sites: { agir(id: string, a: string): void } } };
const ouvrirSite = (fenetre: Page, id: string) => fenetre.evaluate((id) => (window as unknown as ApiSites).webaios.sites.agir(id, "ouvrir"), id);

/** Ouvre l'appli et attend que sa vue ait chargé `chemin`. */
async function ouvrirEtAttendre(app: ElectronApplication, fenetre: Page, id = "vidola", hote = "vidola-a.localhost", chemin = "/pubs") {
  await ouvrirSite(fenetre, id);
  const page = await fenetreSite(app, id);
  await expect.poll(async () => (await etatVueSite(app, id))?.url).toBe(serveur.url(hote, chemin));
  await expect.poll(() => vueSite(app, id, "document.readyState")).toBe("complete");
  return page;
}

type ApiSite = { webaios: { site: { extensions: { basculer(cle: string, actif: boolean): Promise<{ ok: boolean; erreur?: string }> } } } };
const basculer = (page: Page, cle: string, actif: boolean) =>
  page.evaluate(([cle, actif]) => (window as unknown as ApiSite).webaios.site.extensions.basculer(cle, actif), [cle, actif] as const);

/** Bascule depuis l'interface de l'appli et attend que la vue du site ait été rechargée (et finisse de charger). */
async function basculerEtAttendre(app: ElectronApplication, page: Page, cle: string, actif: boolean) {
  await vueSite(app, "vidola", "window.marque = 1");
  serveur.requetes.splice(0);
  expect(await basculer(page, cle, actif)).toEqual({ ok: true });
  await expect.poll(() => vueSite(app, "vidola", "window.marque === undefined && document.readyState === 'complete'")).toBe(true);
}

const banniere = (app: ElectronApplication) => vueSite(app, "vidola", "getComputedStyle(document.getElementById('banniere')).display");
const extensionsDe = (app: ElectronApplication, partition: string) =>
  app.evaluate(({ session }, p) => session.fromPartition(p).extensions.getAllExtensions().map((e) => e.name), partition);
const aucuneVisible = async (app: ElectronApplication) =>
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()))).toBe(false);

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

/** Ferme la fenêtre de l'appli comme l'utilisateur (sa vue est détruite avec elle). */
const fermerAppli = (app: ElectronApplication, id: string) =>
  app.evaluate(({ BrowserWindow }, id) => {
    const f = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("/renderer/site.html") && new URL(w.webContents.getURL()).searchParams.get("id") === id);
    f?.close();
  }, id);

test("sans extension active : persist:site-vidola n'a que le preload webaios-site et aucune extension", async () => {
  const { app, fenetre, fermer } = await demarrer();
  try {
    await ouvrirEtAttendre(app, fenetre);
    expect(await app.evaluate(({ session }) => session.fromPartition("persist:site-vidola").getPreloadScripts().map((p) => p.id))).toEqual(["webaios-site"]);
    expect(await extensionsDe(app, "persist:site-vidola")).toEqual([]);
    expect(await vueSite(app, "vidola", "document.documentElement.dataset.ublock ?? null")).toBeNull();
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("activée dans Vidola : la vue se recharge, pub.js et pub.png ne sont jamais demandés, #banniere est caché ; persist:site-autre (seconde appli ouverte) n'a aucune extension ; site.html n'a pas data-ublock", async () => {
  const { app, fenetre, cle, fermer } = await demarrer();
  try {
    const page = await ouvrirEtAttendre(app, fenetre);
    await ouvrirEtAttendre(app, fenetre, "autre", "vidola-b.localhost", "/");
    expect(await banniere(app)).toBe("block");
    await basculerEtAttendre(app, page, cle, true);
    await expect.poll(() => vueSite(app, "vidola", "document.documentElement.dataset.ublock ?? null")).toBe("1");
    expect(await banniere(app)).toBe("none");
    expect(pubsDemandees()).toEqual([]);
    expect(await extensionsDe(app, "persist:site-vidola")).toEqual(["uBlock factice"]);
    expect(await extensionsDe(app, "persist:site-autre")).toEqual([]);
    expect(await vueSite(app, "autre", "document.documentElement.dataset.ublock ?? null")).toBeNull();
    expect(await page.evaluate(() => document.documentElement.dataset.ublock ?? null)).toBeNull();
    // Les deux preloads « frame » de la session coexistent : celui de l'appli d'abord, puis celui des pages d'extension.
    const cadres = await app.evaluate(({ session }) =>
      session
        .fromPartition("persist:site-vidola")
        .getPreloadScripts()
        .filter((p) => p.type === "frame")
        .map((p) => p.id),
    );
    expect(cadres[0]).toBe("webaios-site");
    expect(cadres).toContain("webaios-extensions-page");
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("même page dans un onglet d'un espace, extension active seulement dans l'appli : pub.js et pub.png demandés, #banniere visible", async () => {
  const { app, fenetre, cle, fermer } = await demarrer();
  try {
    const page = await ouvrirEtAttendre(app, fenetre);
    await basculerEtAttendre(app, page, cle, true);
    expect(await banniere(app)).toBe("none");
    serveur.requetes.splice(0);
    await ouvrirOnglet(fenetre, serveur.url("vidola-a.localhost", "/pubs?onglet"));
    await expect.poll(() => dansLaVue(app, "/pubs?onglet", "document.readyState")).toBe("complete");
    await expect.poll(() => pubsDemandees().sort()).toEqual(["/pub.js", "/pub.png"]);
    expect(await dansLaVue(app, "/pubs?onglet", "getComputedStyle(document.getElementById('banniere')).display")).toBe("block");
    expect(await dansLaVue(app, "/pubs?onglet", "document.documentElement.dataset.ublock ?? null")).toBeNull();
    expect(await extensionsDe(app, "persist:webaios")).toEqual([]);
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("active dans le profil seulement : bloquée dans l'onglet ; rien de bloqué ni chargé dans l'appli", async () => {
  const { app, fenetre, fermer } = await demarrer({ profils: ["defaut"] });
  try {
    await ouvrirOnglet(fenetre, serveur.url("vidola-a.localhost", "/pubs?onglet"));
    await expect.poll(() => dansLaVue(app, "/pubs?onglet", "document.readyState")).toBe("complete");
    // Un chargement de l'onglet sans aucune pub demandée (les règles du manifeste sont posées au démarrage du fond).
    await expect
      .poll(
        async () => {
          serveur.requetes.splice(0);
          await app.evaluate(async ({ webContents }) => {
            const w = webContents.getAllWebContents().find((x) => x.getURL().includes("/pubs?onglet"));
            await w?.loadURL(w.getURL());
          });
          return pubsDemandees();
        },
        { timeout: 15_000 },
      )
      .toEqual([]);
    expect(await dansLaVue(app, "/pubs?onglet", "getComputedStyle(document.getElementById('banniere')).display")).toBe("none");

    serveur.requetes.splice(0);
    await ouvrirEtAttendre(app, fenetre);
    await expect.poll(() => pubsDemandees().sort()).toEqual(["/pub.js", "/pub.png"]);
    expect(await banniere(app)).toBe("block");
    expect(await vueSite(app, "vidola", "document.documentElement.dataset.ublock ?? null")).toBeNull();
    expect(await extensionsDe(app, "persist:site-vidola")).toEqual([]);
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("désactivée depuis l'appli : la vue se recharge, pub.js est de nouveau demandé, #banniere visible ; la session n'a plus aucune extension", async () => {
  const { app, fenetre, cle, fermer } = await demarrer();
  try {
    const page = await ouvrirEtAttendre(app, fenetre);
    await basculerEtAttendre(app, page, cle, true);
    expect(await banniere(app)).toBe("none");
    await basculerEtAttendre(app, page, cle, false);
    await expect.poll(() => pubsDemandees()).toContain("/pub.js");
    expect(await banniere(app)).toBe("block");
    await expect.poll(() => extensionsDe(app, "persist:site-vidola")).toEqual([]);
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

/** Dans la vue du site : le script de contenu de l'extension demande à son fond d'ouvrir `url` (onglet, ou fenêtre). */
const demanderOuverture = (app: ElectronApplication, url: string, fenetre = false) =>
  vueSite(
    app,
    "vidola",
    `document.documentElement.dataset.ublockOuvrir = ${JSON.stringify(url)};
document.documentElement.dataset.ublockFenetre = ${JSON.stringify(fenetre ? "1" : "0")};
document.dispatchEvent(new Event("ublock-ouvrir")); 1`,
  );

test("tabs.create vers pub.localhost : « Lien vers pub.localhost bloqué », aucun onglet ; vers /film/2 : la vue y va ; windows.create vers options.html : une petite fenêtre cachée de la session persist:site-vidola, fermée avec l'appli", async () => {
  const { app, fenetre, id, cle, fermer } = await demarrer();
  try {
    const page = await ouvrirEtAttendre(app, fenetre);
    await basculerEtAttendre(app, page, cle, true);
    await expect.poll(() => vueSite(app, "vidola", "document.documentElement.dataset.ublock ?? null")).toBe("1");
    const ongletsAvant = await urlsOnglets(fenetre);

    await demanderOuverture(app, serveur.url("pub.localhost", "/ouvert"));
    await expect(page.getByTestId("site-avis")).toContainText("Lien vers pub.localhost bloqué");
    await new Promise((r) => setTimeout(r, 500));
    expect(await urlsOnglets(fenetre)).toEqual(ongletsAvant);
    expect(serveur.requetes.some((r) => r.hote === "pub.localhost")).toBe(false);

    await demanderOuverture(app, serveur.url("vidola-a.localhost", "/film/2"));
    await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-a.localhost", "/film/2"));
    await expect.poll(() => vueSite(app, "vidola", "document.readyState === 'complete' && document.documentElement.dataset.ublock === '1'")).toBe(true);
    expect(await urlsOnglets(fenetre)).toEqual(ongletsAvant);

    const options = `chrome-extension://${id}/options.html`;
    await demanderOuverture(app, options, true);
    const petite = () =>
      app.evaluate(({ BrowserWindow, session }, options) => {
        const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL() === options);
        if (!w) return null;
        const [l, h] = w.getSize();
        return { session: w.webContents.session === session.fromPartition("persist:site-vidola"), visible: w.isVisible(), taille: [l, h], titre: w.webContents.getTitle() };
      }, options);
    await expect.poll(async () => (await petite())?.titre).toBe("Options uBlock factice");
    expect(await petite()).toMatchObject({ session: true, visible: false, taille: [500, 650] });
    expect(await urlsOnglets(fenetre)).toEqual(ongletsAvant);
    // La vue du site est restée sur sa page.
    expect((await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-a.localhost", "/film/2"));
    await aucuneVisible(app);

    await fermerAppli(app, "vidola");
    await expect.poll(() => petite()).toBeNull();
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("fermer puis rouvrir l'appli : aucune requête vers pub.localhost dès le premier chargement", async () => {
  const { app, fenetre, cle, fermer } = await demarrer();
  try {
    const page = await ouvrirEtAttendre(app, fenetre);
    await basculerEtAttendre(app, page, cle, true);
    await fermerAppli(app, "vidola");
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.getURL().includes("/renderer/site.html")).length)).toBe(0);
    serveur.requetes.splice(0);
    await ouvrirEtAttendre(app, fenetre);
    expect(serveur.requetes.some((r) => r.hote === "vidola-a.localhost" && r.chemin === "/pubs")).toBe(true);
    expect(pubsDemandees()).toEqual([]);
    expect(await banniere(app)).toBe("none");
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});
