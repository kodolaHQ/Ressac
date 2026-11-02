import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dansLaVue, ecrireSite, etatVueSite, fenetreSite, lancer, nouveauProfil, nouvelleRacine, ouvrirOnglet, serveurSites, vueSite, type SiteTest } from "./aide";
import { ecrireExtensionAgent, installerStoreFactice } from "./extensions/fixtures";
import { activeDans, AUCUNE_EXTENSION_SITE, DOMAINES_CHANGES_EXTENSION, GERER_EXTENSIONS, VOIT_LES_PAGES_SITE } from "../src/commun/extensions-messages";

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

/**
 * C10 : une extension de l'agent accordée et active dans le profil par défaut, écrite au registre comme le ferait
 * l'accord (avant `installerStoreFactice`, qui garde les autres entrées).
 */
function poserExtensionAgent(profil: string, racine: string): void {
  ecrireExtensionAgent(racine, "cacheur", {
    "manifest.json": { manifest_version: 3, name: "Cacheur de l'agent", version: "1.0.0", content_scripts: [{ matches: ["http://127.0.0.1/*"], css: ["cache.css"] }] },
    "cache.css": "#cache-moi { display: none !important; }\n",
  });
  const dossier = join(profil, "extensions");
  mkdirSync(dossier, { recursive: true });
  const entree = {
    source: "agent",
    idChrome: null,
    nom: "Cacheur de l'agent",
    version: "1.0.0",
    accord: { permissions: [], hotes: ["http://127.0.0.1/*"], reseau: [], tousLesSites: false, scriptsTousLesSites: false, scripts: true },
    profils: ["defaut"],
    epinglee: false,
    modifieeLe: null,
    desactivee: null,
    majEnAttente: null,
    vues: {},
  };
  writeFileSync(join(dossier, "etat.json"), JSON.stringify({ version: 1, toutesCoupees: false, extensions: { "agent:cacheur": entree } }));
}

/** L'extension installée comme si elle venait du Store (avant le lancement), puis WebAiOs lancé et ses extensions prêtes. */
async function demarrer(o: { profils?: string[]; sansExtension?: boolean; agent?: boolean; sites?: Record<string, SiteTest> } = {}) {
  const profil = nouveauProfil();
  const racine = nouvelleRacine();
  if (o.agent) poserExtensionAgent(profil, racine);
  const { id } = o.sansExtension ? { id: "" } : installerStoreFactice(profil, "ublock-factice", { profils: o.profils ?? [] });
  ecrireSite(racine, "vidola", vidola());
  ecrireSite(racine, "autre", autre());
  for (const [i, s] of Object.entries(o.sites ?? {})) ecrireSite(racine, i, s);
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
    // Chargée seulement fenêtre ouverte : la réouverture ne trouve rien de déjà chargé, elle attend ses extensions.
    await expect.poll(() => extensionsDe(app, "persist:site-vidola")).toEqual([]);
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

// --- La barre de l'appli (tâche 5) : le menu « Extensions », les boutons des extensions et leurs popups

const HAUTEUR_BARRE = 36;
const PANNEAU_MAX = 320;

/** Ouvre le menu « Extensions » de la barre et attend sa liste. */
async function ouvrirMenu(page: Page) {
  await page.getByTestId("site-extensions").click();
  const panneau = page.getByTestId("panneau-extensions-site");
  await expect(panneau).toBeVisible();
  await expect(page.getByTestId("site-extensions")).toHaveAttribute("aria-expanded", "true");
  return panneau;
}

/**
 * Active (ou désactive) par l'interrupteur et attend la fin : l'interrupteur n'est plus en attente (C5, jusqu'à 10 s),
 * et la vue du site a été rechargée si sa page était chargée.
 */
async function interrupteurEtAttendre(app: ElectronApplication, page: Page, actif: boolean, o: { recharge?: boolean } = {}) {
  const recharge = o.recharge ?? true;
  if (recharge) {
    await vueSite(app, "vidola", "window.marque = 1");
    serveur.requetes.splice(0);
  }
  const inter = page.getByTestId("interrupteur-extension-site");
  await inter.click();
  await expect(inter).toHaveAttribute("aria-checked", String(actif));
  await expect(inter).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  await expect(inter).toHaveAttribute("aria-checked", String(actif));
  if (recharge) await expect.poll(() => vueSite(app, "vidola", "window.marque === undefined && document.readyState === 'complete'")).toBe(true);
}

const region = (page: Page, testId: string) => page.getByTestId(testId).first().evaluate((e) => getComputedStyle(e).getPropertyValue("-webkit-app-region"));

/** La popup de l'extension `id` : son état lu dans sa page, et sa fenêtre vue du process principal. */
const popup = (app: ElectronApplication, id: string) =>
  app.evaluate(async ({ BrowserWindow }, id) => {
    const p = BrowserWindow.getAllWindows().find((f) => !f.isDestroyed() && f.webContents.getURL().startsWith(`chrome-extension://${id}/popup.html`));
    if (!p) return null;
    const lu = (await p.webContents
      .executeJavaScript("({ etat: document.getElementById('etat')?.textContent ?? null, onglets: document.body.dataset.onglets ?? null, fenetres: document.body.dataset.fenetres ?? null })")
      .catch(() => null)) as { etat: string | null; onglets: string | null; fenetres: string | null } | null;
    const parent = p.getParentWindow();
    const u = parent?.webContents.getURL() ?? "";
    return {
      ...lu,
      visible: p.isVisible(),
      parent: u.includes("/renderer/site.html") ? new URL(u).searchParams.get("id") : u,
    };
  }, id);

/** `chrome.tabs.update(onglet, { url })` lancé depuis la popup ouverte de l'extension `id` : « ok » ou le message du refus. */
const mettreAJourDepuisPopup = (app: ElectronApplication, id: string, onglet: number | null, url: string) =>
  app.evaluate(
    async ({ webContents }, [id, onglet, url]) => {
      const p = webContents.getAllWebContents().find((x) => !x.isDestroyed() && x.getURL().startsWith(`chrome-extension://${id}/popup.html`));
      if (!p) return "pas de popup";
      return (await p.executeJavaScript(`chrome.tabs.update(${onglet}, { url: ${JSON.stringify(url)} }).then(() => "ok", (e) => String(e && e.message || e))`)) as string;
    },
    [id, onglet, url] as const,
  );

/** L'id (webContents) de la vue du site de l'appli `id`. */
const idVue = (app: ElectronApplication, id: string) =>
  app.evaluate(({ BrowserWindow }, id) => {
    const f = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("/renderer/site.html") && new URL(w.webContents.getURL()).searchParams.get("id") === id);
    return (f?.contentView.children[0] as Electron.WebContentsView | undefined)?.webContents.id ?? null;
  }, id);

test("sans extension installée, le menu dit AUCUNE_EXTENSION_SITE ; avec ublock-factice et une extension de l'agent accordée, une seule ligne (uBlock factice), interrupteur éteint, VOIT_LES_PAGES_SITE", async () => {
  {
    const { app, fenetre, fermer } = await demarrer({ sansExtension: true });
    try {
      const page = await ouvrirEtAttendre(app, fenetre);
      const panneau = await ouvrirMenu(page);
      await expect(panneau).toContainText(AUCUNE_EXTENSION_SITE);
      await expect(page.getByTestId("ligne-extension-site")).toHaveCount(0);
      await expect(page.getByTestId("site-gerer-extensions")).toHaveText(GERER_EXTENSIONS);
      await aucuneVisible(app);
    } finally {
      await fermer();
    }
  }
  const { app, fenetre, fermer } = await demarrer({ agent: true });
  try {
    // L'entrée de l'agent est bien acceptée (chargée dans le profil) : son absence du menu prouve le filtre.
    await expect.poll(() => extensionsDe(app, "persist:webaios")).toContain("Cacheur de l'agent");
    const page = await ouvrirEtAttendre(app, fenetre);
    const panneau = await ouvrirMenu(page);
    const lignes = page.getByTestId("ligne-extension-site");
    await expect(lignes).toHaveCount(1);
    await expect(lignes).toContainText("uBlock factice");
    await expect(lignes).toContainText(VOIT_LES_PAGES_SITE);
    await expect(panneau).not.toContainText("Cacheur de l'agent");
    await expect(panneau).not.toContainText(AUCUNE_EXTENSION_SITE);
    const inter = page.getByTestId("interrupteur-extension-site");
    await expect(inter).toHaveAttribute("role", "switch");
    await expect(inter).toHaveAttribute("aria-checked", "false");
    await expect(inter).toBeEnabled();
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("ouvrir le menu pousse la vue du site sous le panneau (bornes.y = 36 + hauteur du panneau) ; Echap la remet à 36", async () => {
  const { app, fenetre, fermer } = await demarrer();
  try {
    const page = await ouvrirEtAttendre(app, fenetre);
    expect((await etatVueSite(app, "vidola"))?.bornes.y).toBe(HAUTEUR_BARRE);
    const panneau = await ouvrirMenu(page);
    await expect(page.getByTestId("ligne-extension-site")).toHaveCount(1);
    await expect
      .poll(async () => {
        const h = await panneau.evaluate((e) => e.getBoundingClientRect().height);
        const y = (await etatVueSite(app, "vidola"))?.bornes.y;
        return y === HAUTEUR_BARRE + Math.min(PANNEAU_MAX, Math.ceil(h)) && h > 0;
      })
      .toBe(true);
    // Le panneau est sous la barre, jamais dedans (elle coupe ce qui dépasse).
    expect(await panneau.evaluate((e) => Math.round(e.getBoundingClientRect().top))).toBe(HAUTEUR_BARRE);
    await page.keyboard.press("Escape");
    await expect(panneau).toHaveCount(0);
    await expect(page.getByTestId("site-extensions")).toHaveAttribute("aria-expanded", "false");
    await expect.poll(async () => (await etatVueSite(app, "vidola"))?.bornes.y).toBe(HAUTEUR_BARRE);
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("activer par l'interrupteur : la page est bloquée ; un bouton action-extension-site apparaît avant site-extensions, son icône crx://extension-icon/ chargée", async () => {
  const { app, fenetre, id, fermer } = await demarrer();
  try {
    const page = await ouvrirEtAttendre(app, fenetre);
    await expect(page.getByTestId("action-extension-site")).toHaveCount(0);
    await ouvrirMenu(page);
    await interrupteurEtAttendre(app, page, true);
    expect(await banniere(app)).toBe("none");
    expect(pubsDemandees()).toEqual([]);
    expect(await extensionsDe(app, "persist:site-vidola")).toEqual(["uBlock factice"]);
    const bouton = page.getByTestId("action-extension-site");
    await expect(bouton).toHaveCount(1);
    await expect(bouton).toHaveAttribute("id", id);
    await expect(bouton).toHaveAttribute("partition", "persist:site-vidola");
    expect(await bouton.getAttribute("tab")).toBe(String(await idVue(app, "vidola")));
    // Avant le bouton « Extensions » dans la barre.
    expect(
      await page.evaluate(() => {
        const a = document.querySelector('[data-testid="action-extension-site"]')!;
        const m = document.querySelector('[data-testid="site-extensions"]')!;
        return Boolean(a.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING);
      }),
    ).toBe(true);
    // L'icône (crx://extension-icon/…) a été chargée par l'interface : la CSP de site.html la laisse passer.
    await expect.poll(() => bouton.evaluate((b) => (b as HTMLElement).style.backgroundImage)).toContain("crx://extension-icon/");
    await expect(bouton).not.toHaveClass(/no-icon/);
    await expect(bouton).toHaveAttribute("title", "uBlock factice");
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("clic sur le bouton : la popup s'ouvre cachée, sa fenêtre parente est celle de l'appli, « Popup prête », data-onglets = [id de la vue du site], data-fenetres = 1", async () => {
  const { app, fenetre, id, fermer } = await demarrer();
  try {
    const page = await ouvrirEtAttendre(app, fenetre);
    await ouvrirMenu(page);
    await interrupteurEtAttendre(app, page, true);
    await page.keyboard.press("Escape");
    const bouton = page.getByTestId("action-extension-site");
    await expect(bouton).toHaveCount(1);
    await bouton.click();
    await expect.poll(async () => (await popup(app, id))?.etat, { timeout: 10_000 }).toBe("Popup prête");
    const vue = await idVue(app, "vidola");
    expect(await popup(app, id)).toMatchObject({ visible: false, parent: "vidola", onglets: JSON.stringify([vue]), fenetres: "1" });
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("C8 : tabs.update de la vue vers options.html (depuis la popup) est refusé ; la vue reste sur sa page http", async () => {
  const { app, fenetre, id, fermer } = await demarrer();
  try {
    const page = await ouvrirEtAttendre(app, fenetre);
    await ouvrirMenu(page);
    await interrupteurEtAttendre(app, page, true);
    await page.keyboard.press("Escape");
    await page.getByTestId("action-extension-site").click();
    await expect.poll(async () => (await popup(app, id))?.etat, { timeout: 10_000 }).toBe("Popup prête");
    const vue = await idVue(app, "vidola");
    // I1 : refusé avant tout chargement (le crochet du correctif), sans attendre l'arrêt de secours.
    expect(await mettreAJourDepuisPopup(app, id, vue, `chrome-extension://${id}/options.html`)).toContain("Chargement refusé par WebAiOs");
    const etat = await etatVueSite(app, "vidola");
    expect(etat?.url).toBe(serveur.url("vidola-a.localhost", "/pubs"));
    expect(await vueSite(app, "vidola", "location.protocol")).toBe("http:");
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

/** Le nombre d'extensions de la barre de l'appli, lu comme le fait l'interface (le bouton, lui, ne s'affiche qu'en vue « site »). */
const actionsBarre = (page: Page) =>
  page.evaluate(async () => (await (window as unknown as { webaios: { site: { extensions: { barre(): Promise<{ actions: unknown[] }> } } } }).webaios.site.extensions.barre()).actions.length);

/** Une appli avec un écran d'accueil (vue « accueil » à l'ouverture), sur la page des pubs. */
const avecAccueil = (): SiteTest => ({
  declaration: { nom: "Vidola", adresse: serveur.url("vidola-a.localhost", "/pubs"), domaines: ["vidola-a.localhost"], connexion: ["compte.localhost"] },
  fichiers: { "accueil/index.html": "<p>accueil</p>" },
});
/** Une appli avec des retouches et sans accord : la carte d'accord s'affiche à l'ouverture. */
const avecCarte = (): SiteTest => ({
  declaration: {
    nom: "Carte",
    adresse: serveur.url("vidola-a.localhost", "/pubs"),
    domaines: ["vidola-a.localhost"],
    retouches: [{ correspond: ["/pubs"], js: ["a.js"] }],
  },
  fichiers: { "retouches/a.js": 'document.body.dataset.retouche = "oui";' },
});

test("les boutons des extensions ne s'affichent ni sur l'accueil ni sur la carte d'accord ; le bouton Extensions, si", async () => {
  const { app, fenetre, cle, fermer } = await demarrer({ sites: { tube: avecAccueil(), carte: avecCarte() } });
  try {
    // Accueil.
    await ouvrirSite(fenetre, "tube");
    const tube = await fenetreSite(app, "tube");
    await expect(tube.getByTestId("site-entrer")).toBeVisible();
    expect(await basculer(tube, cle, true)).toEqual({ ok: true });
    await expect(tube.getByTestId("site-extensions")).toBeVisible();
    await expect.poll(() => actionsBarre(tube)).toBe(1);
    await expect(tube.getByTestId("action-extension-site")).toHaveCount(0);
    await tube.getByTestId("site-entrer").click();
    await expect(tube.getByTestId("action-extension-site")).toHaveCount(1);
    await tube.getByTestId("site-accueil").click();
    await expect(tube.getByTestId("site-entrer")).toBeVisible();
    await expect(tube.getByTestId("action-extension-site")).toHaveCount(0);
    await expect(tube.getByTestId("site-extensions")).toBeVisible();

    // Carte d'accord.
    await ouvrirSite(fenetre, "carte");
    const carte = await fenetreSite(app, "carte");
    await expect(carte.getByTestId("carte-accord-site")).toBeVisible();
    expect(await basculer(carte, cle, true)).toEqual({ ok: true });
    await expect(carte.getByTestId("site-extensions")).toBeVisible();
    await expect.poll(() => actionsBarre(carte)).toBe(1);
    await expect(carte.getByTestId("action-extension-site")).toHaveCount(0);
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("activer sur l'accueil (page jamais chargée) : aucune requête vers vidola-a.localhost ; « Entrer dans le site » : bloquée dès le premier chargement", async () => {
  const { app, fenetre, fermer } = await demarrer({ sites: { tube: avecAccueil() } });
  try {
    await ouvrirSite(fenetre, "tube");
    const tube = await fenetreSite(app, "tube");
    await expect(tube.getByTestId("site-entrer")).toBeVisible();
    serveur.requetes.splice(0);
    await ouvrirMenu(tube);
    const inter = tube.getByTestId("interrupteur-extension-site");
    await inter.click();
    await expect(inter).toHaveAttribute("aria-checked", "true");
    await expect(inter).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
    await expect.poll(() => extensionsDe(app, "persist:site-tube")).toEqual(["uBlock factice"]);
    expect(serveur.requetes.filter((r) => r.hote === "vidola-a.localhost")).toEqual([]);
    await tube.keyboard.press("Escape");
    await tube.getByTestId("site-entrer").click();
    await expect.poll(async () => (await etatVueSite(app, "tube"))?.url).toBe(serveur.url("vidola-a.localhost", "/pubs"));
    await expect.poll(() => vueSite(app, "tube", "document.readyState")).toBe("complete");
    expect(serveur.requetes.filter((r) => r.hote === "vidola-a.localhost" && r.chemin === "/pubs")).toHaveLength(1);
    expect(pubsDemandees()).toEqual([]);
    expect(await vueSite(app, "tube", "getComputedStyle(document.getElementById('banniere')).display")).toBe("none");
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("deux clics rapides sur l'interrupteur : l'état final (aria-checked, extensions de la session) est celui du second", async () => {
  const { app, fenetre, profil, cle, fermer } = await demarrer();
  try {
    const page = await ouvrirEtAttendre(app, fenetre);
    await ouvrirMenu(page);
    const inter = page.getByTestId("interrupteur-extension-site");
    await inter.click();
    await inter.click();
    await expect(inter).toHaveAttribute("aria-checked", "false");
    await expect(inter).not.toHaveAttribute("aria-busy", "true", { timeout: 20_000 });
    await expect(inter).toHaveAttribute("aria-checked", "false");
    await expect.poll(() => extensionsDe(app, "persist:site-vidola")).toEqual([]);
    const registre = JSON.parse(readFileSync(join(profil, "extensions", "etat.json"), "utf8")) as { extensions: Record<string, { applis?: Record<string, string> }> };
    expect(registre.extensions[cle]?.applis?.vidola).toBeUndefined();
    // Relu depuis le process principal : toujours éteint.
    await page.keyboard.press("Escape");
    await ouvrirMenu(page);
    await expect(page.getByTestId("interrupteur-extension-site")).toHaveAttribute("aria-checked", "false");
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("site-extensions, interrupteur-extension-site, site-gerer-extensions et action-extension-site ont -webkit-app-region no-drag ; le fond de la barre reste drag", async () => {
  const { app, fenetre, fermer } = await demarrer();
  try {
    const page = await ouvrirEtAttendre(app, fenetre);
    await ouvrirMenu(page);
    await interrupteurEtAttendre(app, page, true);
    await expect(page.getByTestId("action-extension-site")).toHaveCount(1);
    for (const t of ["site-extensions", "interrupteur-extension-site", "site-gerer-extensions", "action-extension-site", "panneau-extensions-site"]) expect(await region(page, t), t).toBe("no-drag");
    expect(await region(page, "barre-site")).toBe("drag");
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("« Gérer les extensions » : la page Extensions (page-extensions) s'affiche dans la fenêtre principale ; aucune fenêtre visible", async () => {
  const { app, fenetre, fermer } = await demarrer();
  try {
    const page = await ouvrirEtAttendre(app, fenetre);
    await ouvrirMenu(page);
    await page.getByTestId("site-gerer-extensions").click();
    await expect(page.getByTestId("panneau-extensions-site")).toHaveCount(0);
    await expect.poll(async () => (await etatVueSite(app, "vidola"))?.bornes.y).toBe(HAUTEUR_BARRE);
    await expect(fenetre.getByTestId("page-extensions")).toBeVisible();
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("I1 : sur l'accueil, tabs.update de la vue vers une page de l'appli est refusé : aucune requête vers le site, la vue reste où elle est", async () => {
  const { app, fenetre, id, fermer } = await demarrer({ sites: { tube: avecAccueil() } });
  try {
    await ouvrirSite(fenetre, "tube");
    const tube = await fenetreSite(app, "tube");
    await ouvrirMenu(tube);
    const inter = tube.getByTestId("interrupteur-extension-site");
    await inter.click();
    await expect(inter).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
    await expect(inter).toHaveAttribute("aria-checked", "true");
    await tube.keyboard.press("Escape");
    // Entrer, ouvrir la popup (sur la vue « site »), puis revenir à l'accueil : la popup reste ouverte.
    await tube.getByTestId("site-entrer").click();
    await expect.poll(() => vueSite(app, "tube", "document.readyState")).toBe("complete");
    await tube.getByTestId("action-extension-site").click();
    await expect.poll(async () => (await popup(app, id))?.etat, { timeout: 10_000 }).toBe("Popup prête");
    await tube.getByTestId("site-accueil").click();
    await expect(tube.getByTestId("site-entrer")).toBeVisible();
    serveur.requetes.splice(0);
    const vue = await idVue(app, "tube");
    expect(await mettreAJourDepuisPopup(app, id, vue, serveur.url("vidola-a.localhost", "/film/2"))).toContain("Chargement refusé par WebAiOs");
    expect(serveur.requetes.filter((r) => r.hote === "vidola-a.localhost")).toEqual([]);
    expect((await etatVueSite(app, "tube"))?.url).toBe(serveur.url("vidola-a.localhost", "/pubs"));
    await expect(tube.getByTestId("site-entrer")).toBeVisible();
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("le panneau se ferme quand la vue du site reçoit un clic, et quand elle passe en plein écran", async () => {
  const { app, fenetre, fermer } = await demarrer();
  try {
    const page = await ouvrirEtAttendre(app, fenetre);
    const panneau = await ouvrirMenu(page);
    await expect.poll(async () => (await etatVueSite(app, "vidola"))?.bornes.y).toBeGreaterThan(HAUTEUR_BARRE);
    // Un clic dans la vue du site.
    await app.evaluate(({ BrowserWindow }) => {
      const f = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("/renderer/site.html"));
      const vue = (f?.contentView.children[0] as Electron.WebContentsView).webContents;
      vue.sendInputEvent({ type: "mouseDown", x: 20, y: 20, button: "left", clickCount: 1 });
      vue.sendInputEvent({ type: "mouseUp", x: 20, y: 20, button: "left", clickCount: 1 });
    });
    await expect(panneau).toHaveCount(0);
    await expect.poll(async () => (await etatVueSite(app, "vidola"))?.bornes.y).toBe(HAUTEUR_BARRE);
    // Le plein écran d'une vidéo : le panneau se ferme aussi.
    await ouvrirMenu(page);
    await app.evaluate(({ BrowserWindow }) => {
      const f = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("/renderer/site.html"));
      (f?.contentView.children[0] as Electron.WebContentsView).webContents.emit("enter-html-full-screen");
    });
    await expect(page.getByTestId("panneau-extensions-site")).toHaveCount(0);
    await expect(page.getByTestId("site-extensions")).toHaveAttribute("aria-expanded", "false");
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("« Désactiver toutes les extensions » : l'interrupteur de l'appli est grisé, avec la raison en texte", async () => {
  const { app, fenetre, fermer } = await demarrer();
  try {
    const page = await ouvrirEtAttendre(app, fenetre);
    await ouvrirMenu(page);
    const inter = page.getByTestId("interrupteur-extension-site");
    await expect(inter).toBeEnabled();
    await fenetre.evaluate(() => (window as unknown as { webaios: { extensions: { toutCouper(oui: boolean): Promise<unknown> } } }).webaios.extensions.toutCouper(true));
    // Relu sur surChange, menu ouvert.
    await expect(inter).toBeDisabled();
    const ligne = page.getByTestId("ligne-extension-site");
    await expect(ligne).not.toContainText(VOIT_LES_PAGES_SITE);
    await expect(ligne).toContainText("toutes désactivées");
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

// ---- Tâche 6 : la page Extensions, la coupure, les domaines qui changent, la suppression ----

type EtatRegistre = { extensions: Record<string, { applis?: Record<string, string>; vues?: Record<string, unknown> }> };
const registre = (profil: string): EtatRegistre => JSON.parse(readFileSync(join(profil, "extensions", "etat.json"), "utf8"));

/** La page Extensions, dans la fenêtre principale (par le menu des extensions). */
async function ouvrirPageExtensions(fenetre: Page) {
  await fenetre.getByTestId("menu-extensions").click();
  await fenetre.getByTestId("panneau-extensions").getByRole("button", { name: "Gérer les extensions" }).click();
  const page = fenetre.getByTestId("page-extensions");
  await expect(page).toBeVisible();
  return page;
}

test("activée dans Vidola : la page Extensions montre « Active dans : Vidola » ; « Désactiver partout » : plus aucune extension dans persist:site-vidola, la ligne disparaît, l'interrupteur de l'appli s'éteint", async () => {
  const { app, fenetre, profil, cle, fermer } = await demarrer();
  try {
    const page = await ouvrirEtAttendre(app, fenetre);
    await basculerEtAttendre(app, page, cle, true);
    await expect.poll(() => extensionsDe(app, "persist:site-vidola")).toEqual(["uBlock factice"]);
    const extensions = await ouvrirPageExtensions(fenetre);
    const ligne = extensions.getByTestId("extension-page").filter({ hasText: "uBlock factice" });
    await expect(ligne.getByTestId("extension-applis")).toHaveText(activeDans(["Vidola"]));
    // C12 : active seulement dans une appli, pas « Active nulle part ».
    await expect(ligne).toContainText("Espaces : aucun");
    await expect(ligne).not.toContainText("Active nulle part");
    const desactiver = ligne.getByRole("button", { name: "Désactiver partout" });
    await expect(desactiver).toBeEnabled();
    await desactiver.click();
    await expect(ligne.getByTestId("extension-applis")).toHaveCount(0);
    await expect(ligne).toContainText("Active nulle part");
    await expect(desactiver).toBeDisabled();
    await expect.poll(() => extensionsDe(app, "persist:site-vidola")).toEqual([]);
    expect(registre(profil).extensions[cle]!.applis).toBeUndefined();
    // L'interrupteur du menu de l'appli s'éteint (P2 : la vue n'est pas rechargée, on ne regarde pas la page).
    await ouvrirMenu(page);
    await expect(page.getByTestId("interrupteur-extension-site")).toHaveAttribute("aria-checked", "false");
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("« Désactiver toutes les extensions » : plus rien dans la session de l'appli, l'interrupteur est grisé avec TOUTES_COUPEES_AGENT ; réactivées : l'extension revient sans geste dans l'appli", async () => {
  const { app, fenetre, cle, fermer } = await demarrer();
  try {
    const page = await ouvrirEtAttendre(app, fenetre);
    await basculerEtAttendre(app, page, cle, true);
    await expect.poll(() => extensionsDe(app, "persist:site-vidola")).toEqual(["uBlock factice"]);
    await ouvrirMenu(page);
    const toutCouper = (oui: boolean) =>
      fenetre.evaluate((oui) => (window as unknown as { webaios: { extensions: { toutCouper(oui: boolean): Promise<unknown> } } }).webaios.extensions.toutCouper(oui), oui);
    await toutCouper(true);
    // G4/P2 : la vue n'est pas rechargée ; on lit ce que la session charge, pas la page.
    await expect.poll(() => extensionsDe(app, "persist:site-vidola")).toEqual([]);
    const inter = page.getByTestId("interrupteur-extension-site");
    await expect(inter).toBeDisabled();
    await expect(page.getByTestId("ligne-extension-site")).toContainText("toutes désactivées");
    await toutCouper(false);
    await expect.poll(() => extensionsDe(app, "persist:site-vidola")).toEqual(["uBlock factice"]);
    await expect(inter).toBeEnabled();
    await expect(inter).toHaveAttribute("aria-checked", "true");
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("site.json réécrit avec un domaine de plus, fenêtre ouverte : l'extension quitte la session, le menu montre DOMAINES_CHANGES_EXTENSION ; l'interrupteur la réactive (bloquée de nouveau)", async () => {
  const { app, fenetre, racine, cle, fermer } = await demarrer();
  try {
    const page = await ouvrirEtAttendre(app, fenetre);
    await basculerEtAttendre(app, page, cle, true);
    expect(await banniere(app)).toBe("none");
    await ouvrirMenu(page);
    ecrireSite(racine, "vidola", { declaration: { ...vidola().declaration, domaines: ["vidola-a.localhost", "autre.localhost"] } });
    await expect.poll(() => extensionsDe(app, "persist:site-vidola"), { timeout: 15_000 }).toEqual([]);
    await expect(page.getByTestId("ligne-extension-site")).toContainText(DOMAINES_CHANGES_EXTENSION);
    const inter = page.getByTestId("interrupteur-extension-site");
    await expect(inter).toHaveAttribute("aria-checked", "false");
    await interrupteurEtAttendre(app, page, true);
    await expect.poll(() => extensionsDe(app, "persist:site-vidola")).toEqual(["uBlock factice"]);
    expect(await banniere(app)).toBe("none");
    expect(pubsDemandees()).toEqual([]);
    await expect(page.getByTestId("ligne-extension-site")).not.toContainText(DOMAINES_CHANGES_EXTENSION);
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("site.json réécrit avec seulement un autre nom : l'extension reste chargée", async () => {
  const { app, fenetre, racine, cle, fermer } = await demarrer();
  try {
    const page = await ouvrirEtAttendre(app, fenetre);
    await basculerEtAttendre(app, page, cle, true);
    await ouvrirMenu(page);
    ecrireSite(racine, "vidola", { declaration: { ...vidola().declaration, nom: "Vidola renommé" } });
    // Le nouveau nom est lu (la page Extensions le montre), l'extension n'a pas bougé.
    const extensions = await ouvrirPageExtensions(fenetre);
    await expect(extensions.getByTestId("extension-applis")).toHaveText(activeDans(["Vidola renommé"]), { timeout: 15_000 });
    expect(await extensionsDe(app, "persist:site-vidola")).toEqual(["uBlock factice"]);
    await expect(page.getByTestId("interrupteur-extension-site")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("ligne-extension-site")).not.toContainText(DOMAINES_CHANGES_EXTENSION);
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("supprimer l'appli puis la recréer au même id : interrupteur éteint, registre sans applis.vidola ni vues[\"site:vidola\"] ; réactivée, elle bloque de nouveau", async () => {
  const { app, fenetre, racine, profil, cle, fermer } = await demarrer();
  try {
    const page = await ouvrirEtAttendre(app, fenetre);
    await basculerEtAttendre(app, page, cle, true);
    await expect.poll(() => registre(profil).extensions[cle]!.applis?.vidola).toBeTruthy();
    expect(registre(profil).extensions[cle]!.vues?.["site:vidola"]).toBeTruthy();
    await fenetre.evaluate(() => (window as unknown as ApiSites).webaios.sites.agir("vidola", "supprimer"));
    await expect.poll(() => existsSync(join(racine, "sites", "vidola"))).toBe(false);
    await expect.poll(() => registre(profil).extensions[cle]!.applis?.vidola, { timeout: 15_000 }).toBeUndefined();
    expect(registre(profil).extensions[cle]!.vues?.["site:vidola"]).toBeUndefined();

    ecrireSite(racine, "vidola", vidola());
    serveur.requetes.splice(0);
    const page2 = await ouvrirEtAttendre(app, fenetre);
    expect(await extensionsDe(app, "persist:site-vidola")).toEqual([]);
    expect(await banniere(app)).toBe("block");
    await ouvrirMenu(page2);
    await expect(page2.getByTestId("interrupteur-extension-site")).toHaveAttribute("aria-checked", "false");
    await interrupteurEtAttendre(app, page2, true);
    await expect.poll(() => extensionsDe(app, "persist:site-vidola")).toEqual(["uBlock factice"]);
    expect(await banniere(app)).toBe("none");
    expect(pubsDemandees()).toEqual([]);
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});

test("« Supprimer » l'extension sur la page Extensions, active dans l'appli : retirée de persist:site-vidola, absente du registre, store/<id> effacé ; le menu de l'appli dit AUCUNE_EXTENSION_SITE", async () => {
  const { app, fenetre, profil, id, cle, fermer } = await demarrer();
  try {
    const page = await ouvrirEtAttendre(app, fenetre);
    await basculerEtAttendre(app, page, cle, true);
    await expect.poll(() => extensionsDe(app, "persist:site-vidola")).toEqual(["uBlock factice"]);
    await ouvrirMenu(page);
    const extensions = await ouvrirPageExtensions(fenetre);
    const ligne = extensions.getByTestId("extension-page").filter({ hasText: "uBlock factice" });
    await ligne.getByRole("button", { name: "Supprimer" }).click();
    await fenetre.getByTestId("confirmation-suppression-extension").getByRole("button", { name: "Supprimer" }).click();
    await expect(ligne).toHaveCount(0);
    await expect.poll(() => extensionsDe(app, "persist:site-vidola")).toEqual([]);
    await expect.poll(() => existsSync(join(profil, "extensions", "store", id))).toBe(false);
    expect(registre(profil).extensions[cle]).toBeUndefined();
    await expect(page.getByTestId("panneau-extensions-site")).toContainText(AUCUNE_EXTENSION_SITE);
    await aucuneVisible(app);
  } finally {
    await fermer();
  }
});
