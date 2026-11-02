import { expect, test, type ElectronApplication, type Frame, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appelerOutil, ecrireSite, etatVueSite, fenetreSite, lancer, lireNotifications, nombreWebContents, nouvelleRacine, serveurSites, vueSite } from "./aide";

/** Les hôtes de test `*.localhost` sont permis (http compris) ; jamais une vraie adresse. */
const ENV = { WEBAIOS_TEST_ADRESSES_LOCALES: "1" };
const BARRE = 36;

let serveur: Awaited<ReturnType<typeof serveurSites>>;

/** `secondes` de silence en WAV (8 kHz, 8 bits, mono), généré en mémoire : de quoi jouer sans geste. */
function silenceWav(secondes = 3): Buffer {
  const n = 8000 * secondes;
  const b = Buffer.alloc(44 + n, 0x80);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(8000, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write("data", 36);
  b.writeUInt32LE(n, 40);
  return b;
}

test.beforeAll(async () => {
  serveur = await serveurSites();
  const pub = (c: string) => serveur.url("pub.localhost", c);
  serveur.definir(
    "vidola-a.localhost",
    "/",
    `<title>Vidola A</title>
<a id="pub" href="${pub("/x")}">pub</a>
<a id="aller-pub" href="/aller-pub">aller</a>
<a id="film" href="/film/2" target="_blank">film</a>
<iframe id="cadre" src="${pub("/cadre")}"></iframe>`,
  );
  serveur.definir("vidola-a.localhost", "/aller-pub", (_req, res) => res.writeHead(302, { Location: pub("/arrivee") }).end());
  serveur.definir("vidola-a.localhost", "/film/2", "<title>Film 2</title>");
  serveur.definir("vidola-a.localhost", "/audio", '<title>Audio</title><audio id="a" autoplay src="/son.wav"></audio>');
  serveur.definir("vidola-a.localhost", "/son.wav", (_req, res) => res.writeHead(200, { "Content-Type": "audio/wav" }).end(silenceWav()));
  serveur.definir("vidola-a.localhost", "/plein", '<title>Plein</title><div id="plein" style="height:100px">vidéo</div>');
  serveur.definir("pub.localhost", "/x", "<title>Pub</title>");
  serveur.definir("pub.localhost", "/cadre", "<title>Cadre pub</title><p>pub</p>");
  serveur.definir("pub.localhost", "/arrivee", "<title>Arrivée pub</title>");
  serveur.definir("compte.localhost", "/connexion", "<title>Connexion</title>");
  serveur.definir("vidola-a.localhost", "/refresh", `<title>Refresh</title><meta http-equiv="refresh" content="0;url=${pub("/meta")}">`);
  serveur.definir(
    "vidola-a.localhost",
    "/formulaire",
    `<title>Formulaire</title><form id="f" method="post" action="${pub("/post")}"><input name="q" value="secret"><button id="envoyer">ok</button></form>`,
  );
  serveur.definir("vidola-b.localhost", "/", "<title>Vidola B</title>");
});
test.afterAll(() => serveur.fermer());
// Les requêtes notées sont celles du test en cours (un test précédent a pu ouvrir pub.localhost dans un onglet).
test.beforeEach(() => void serveur.requetes.splice(0));

const vidola = () => ({
  declaration: { nom: "Vidola", adresse: serveur.url("vidola-a.localhost", "/"), domaines: ["vidola-a.localhost"], connexion: ["compte.localhost"] },
});

type ApiSites = { webaios: { sites: { agir(id: string, a: string): void } } };
const ouvrirSite = (fenetre: Page, id: string) => fenetre.evaluate((id) => (window as unknown as ApiSites).webaios.sites.agir(id, "ouvrir"), id);

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

/** Le nombre de fenêtres d'interface ouvertes pour l'appli `id`. */
const fenetresDuSite = (app: ElectronApplication, id: string) =>
  app.evaluate(
    ({ BrowserWindow }, id) =>
      BrowserWindow.getAllWindows().filter((w) => {
        if (w.isDestroyed() || w.webContents.isDestroyed()) return false;
        const u = w.webContents.getURL();
        return u.includes("/renderer/site.html") && new URL(u).searchParams.get("id") === id;
      }).length,
    id,
  );

async function demarrer(sites: Record<string, Parameters<typeof ecrireSite>[2]> = { vidola: vidola() }) {
  // Les appli sont écrites avant le lancement : le surveillant ne voit aucun événement initial qui relirait l'appli en route.
  const racine = nouvelleRacine();
  for (const [id, s] of Object.entries(sites)) ecrireSite(racine, id, s);
  return lancer({ env: ENV, racine });
}

/** Ouvre l'appli et attend que la vue soit sur `chemin` du site. */
async function ouvrirEtAttendre(app: ElectronApplication, fenetre: Page, id = "vidola", chemin = "/") {
  await ouvrirSite(fenetre, id);
  const page = await fenetreSite(app, id);
  await expect.poll(async () => (await etatVueSite(app, id))?.url).toBe(serveur.url("vidola-a.localhost", chemin));
  await expect.poll(() => vueSite(app, id, "document.readyState")).toBe("complete");
  return page;
}

test("ouvrir sans accueil : la vue montre le site, la barre affiche « vidola-a.localhost »", async () => {
  const { app, fenetre, fermer } = await demarrer();
  const page = await ouvrirEtAttendre(app, fenetre);
  await expect(page.getByTestId("site-domaine")).toHaveText("vidola-a.localhost");
  await expect(page.getByTestId("site-nom")).toHaveText("Vidola");
  await expect(page.getByTestId("site-accueil")).toHaveCount(0);
  expect(await vueSite(app, "vidola", "document.title")).toBe("Vidola A");
  const e = (await etatVueSite(app, "vidola"))!;
  expect(e.visible).toBe(true);
  expect(e.bornes).toEqual({ x: 0, y: BARRE, width: e.contenu[0], height: e.contenu[1] - BARRE });
  // P3 : l'hôte *.localhost est bien arrivé sur le serveur de la boucle locale, avec son nom.
  expect(serveur.requetes.some((r) => r.hote === "vidola-a.localhost" && r.chemin === "/")).toBe(true);
  // Aucune fenêtre n'est montrée en test.
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()))).toBe(false);
  await fermer();
});

test("rouvrir ne crée pas de seconde fenêtre (une seule site.html?id=vidola) et ne recharge pas", async () => {
  const { app, fenetre, fermer } = await demarrer();
  await ouvrirEtAttendre(app, fenetre);
  await vueSite(app, "vidola", "window.marque = 42");
  await ouvrirSite(fenetre, "vidola");
  await new Promise((r) => setTimeout(r, 500));
  expect(await fenetresDuSite(app, "vidola")).toBe(1);
  expect(await vueSite(app, "vidola", "window.marque")).toBe(42);
  await fermer();
});

test("un lien vers pub.localhost n'est pas suivi : « Lien vers pub.localhost bloqué », aucun onglet ; « Ouvrir dans un onglet » en ouvre un", async () => {
  const { app, fenetre, fermer } = await demarrer();
  const page = await ouvrirEtAttendre(app, fenetre);
  const avant = await urlsOnglets(fenetre);
  await vueSite(app, "vidola", "document.getElementById('pub').click()", { geste: true });
  await expect(page.getByTestId("site-avis")).toContainText("Lien vers pub.localhost bloqué");
  expect((await etatVueSite(app, "vidola"))!.url).toBe(serveur.url("vidola-a.localhost", "/"));
  expect(await urlsOnglets(fenetre)).toEqual(avant);
  expect(serveur.requetes.some((r) => r.hote === "pub.localhost" && r.chemin === "/x")).toBe(false);
  await page.getByTestId("site-ouvrir-onglet").click();
  await expect.poll(() => urlsOnglets(fenetre)).toContain(serveur.url("pub.localhost", "/x"));
  await fermer();
});

test("dix window.open vers pub.localhost depuis la page et depuis un cadre pub.localhost : aucun onglet, aucune fenêtre de plus", async () => {
  const { app, fenetre, fermer } = await demarrer();
  const page = await ouvrirEtAttendre(app, fenetre);
  await expect.poll(() => vueSite(app, "vidola", "document.title", { cadre: 0 })).toBe("Cadre pub");
  const onglets = await urlsOnglets(fenetre);
  const avant = await nombreWebContents(app);
  const ouvrir = `for (let i = 0; i < 10; i++) window.open(${JSON.stringify(serveur.url("pub.localhost", "/x"))} + "?n=" + i)`;
  await vueSite(app, "vidola", ouvrir, { geste: true });
  await vueSite(app, "vidola", ouvrir, { geste: true, cadre: 0 });
  await vueSite(app, "vidola", "window.open('about:blank'); window.open('')", { geste: true });
  await expect(page.getByTestId("site-avis")).toContainText("Lien vers pub.localhost bloqué");
  await new Promise((r) => setTimeout(r, 1000));
  expect(await nombreWebContents(app)).toBe(avant);
  expect(await urlsOnglets(fenetre)).toEqual(onglets);
  expect(serveur.requetes.some((r) => r.hote === "pub.localhost" && r.chemin.startsWith("/x"))).toBe(false);
  await expect(page.getByTestId("site-avis")).toHaveCount(1);
  await fermer();
});

test("target=_blank vers /film/2 : la vue de l'appli y va", async () => {
  const { app, fenetre, fermer } = await demarrer();
  await ouvrirEtAttendre(app, fenetre);
  const avant = await nombreWebContents(app);
  await vueSite(app, "vidola", "document.getElementById('film').click()", { geste: true });
  await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-a.localhost", "/film/2"));
  expect(await nombreWebContents(app)).toBe(avant);
  await fermer();
});

test("window.open vers le domaine de connexion : une petite fenêtre de même session, cachée en test", async () => {
  const { app, fenetre, fermer } = await demarrer();
  await ouvrirEtAttendre(app, fenetre);
  const connexion = serveur.url("compte.localhost", "/connexion");
  await vueSite(app, "vidola", `window.open(${JSON.stringify(connexion)}, "connexion", "width=500,height=650"); 1`, { geste: true });
  const petite = () =>
    app.evaluate(({ BrowserWindow, session }, url) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL() === url);
      if (!w) return null;
      return {
        memeSession: w.webContents.session === session.fromPartition("persist:site-vidola"),
        visible: w.isVisible(),
        taille: w.getBounds().width,
      };
    }, connexion);
  await expect.poll(petite).toEqual({ memeSession: true, visible: false, taille: 500 });
  // Sa navigation reste bornée au site et à la connexion.
  await app.evaluate(({ BrowserWindow }, [url, pub]) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL() === url);
    return w?.webContents.executeJavaScript(`location.href = ${JSON.stringify(pub)}`, true);
  }, [connexion, serveur.url("pub.localhost", "/x")] as const);
  await new Promise((r) => setTimeout(r, 800));
  expect(await petite()).not.toBeNull();
  expect(serveur.requetes.some((r) => r.hote === "pub.localhost" && r.chemin === "/x")).toBe(false);
  await fermer();
});

test("une redirection serveur de /aller-pub (lien cliqué) vers pub.localhost : bloquée, « Lien vers pub.localhost bloqué »", async () => {
  const { app, fenetre, fermer } = await demarrer();
  const page = await ouvrirEtAttendre(app, fenetre);
  const onglets = await urlsOnglets(fenetre);
  await vueSite(app, "vidola", "document.getElementById('aller-pub').click()", { geste: true });
  await expect(page.getByTestId("site-avis")).toContainText("Lien vers pub.localhost bloqué");
  expect(serveur.requetes.some((r) => r.hote === "vidola-a.localhost" && r.chemin === "/aller-pub")).toBe(true);
  expect(serveur.requetes.some((r) => r.hote === "pub.localhost" && r.chemin === "/arrivee")).toBe(false);
  expect(await urlsOnglets(fenetre)).toEqual(onglets);
  await fermer();
});

test("une page avec <audio autoplay> non muet joue sans geste ; une demande de notification est refusée sans rien afficher", async () => {
  const { app, fenetre, profil, fermer } = await demarrer();
  await ouvrirEtAttendre(app, fenetre);
  await vueSite(app, "vidola", "location.href = '/audio'");
  await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-a.localhost", "/audio"));
  await expect.poll(() => vueSite(app, "vidola", "document.getElementById('a')?.paused === false && !document.getElementById('a').muted")).toBe(true);
  expect(await vueSite(app, "vidola", "Notification.requestPermission()", { geste: true })).toBe("denied");
  await expect(fenetre.getByTestId("demande-permission")).toHaveCount(0);
  expect(lireNotifications(profil)).toEqual([]);
  await fermer();
});

test("taille et place de la fenêtre retenues dans <profil>/sites.json et reprises à la réouverture", async () => {
  const { app, fenetre, profil, fermer } = await demarrer();
  await ouvrirEtAttendre(app, fenetre);
  const cadre = { x: 120, y: 90, width: 700, height: 520 };
  await app.evaluate(({ BrowserWindow }, cadre) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("/renderer/site.html"))!;
    w.setBounds(cadre);
    w.close();
  }, cadre);
  await expect.poll(() => fenetresDuSite(app, "vidola")).toBe(0);
  const fichier = join(profil, "sites.json");
  await expect
    .poll(() => (existsSync(fichier) ? JSON.parse(readFileSync(fichier, "utf8")).vidola?.cadre : null))
    .toEqual({ x: 120, y: 90, largeur: 700, hauteur: 520 });
  await ouvrirEtAttendre(app, fenetre);
  const bornes = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("/renderer/site.html"))!.getBounds());
  expect(bornes).toEqual(cadre);
  await fermer();
});

test("requestFullscreen d'un élément : document.fullscreenElement posé, la vue occupe toute la fenêtre ; à la sortie, la barre revient", async () => {
  const { app, fenetre, fermer } = await demarrer();
  await ouvrirEtAttendre(app, fenetre);
  await vueSite(app, "vidola", "location.href = '/plein'");
  await expect.poll(() => vueSite(app, "vidola", "document.title")).toBe("Plein");
  await vueSite(app, "vidola", "void document.getElementById('plein').requestFullscreen(); 1", { geste: true });
  await expect.poll(() => vueSite(app, "vidola", "!!document.fullscreenElement"), { timeout: 10_000 }).toBe(true);
  // Même en plein écran, aucune fenêtre n'est montrée en test (macOS anime le passage : on lui laisse le temps).
  await new Promise((r) => setTimeout(r, 1000));
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()))).toBe(false);
  await expect
    .poll(async () => {
      const e = (await etatVueSite(app, "vidola"))!;
      return e.bornes.y === 0 && e.bornes.height === e.contenu[1] && e.bornes.width === e.contenu[0];
    }, { timeout: 10_000 })
    .toBe(true);
  await vueSite(app, "vidola", "void document.exitFullscreen(); 1", { geste: true });
  await expect.poll(() => vueSite(app, "vidola", "!!document.fullscreenElement"), { timeout: 10_000 }).toBe(false);
  await expect
    .poll(async () => {
      const e = (await etatVueSite(app, "vidola"))!;
      return e.bornes.y === BARRE && e.bornes.height === e.contenu[1] - BARRE;
    }, { timeout: 10_000 })
    .toBe(true);
  await fermer();
});

test("chaque bouton de la barre a -webkit-app-region no-drag ; le fond de la barre se glisse", async () => {
  const { app, fenetre, fermer } = await demarrer({
    vidola: vidola(),
    tube: {
      declaration: { nom: "Tube", adresse: serveur.url("vidola-a.localhost", "/"), domaines: ["vidola-a.localhost"] },
      fichiers: { "accueil/index.html": "<p>accueil</p>" },
    },
  });
  const page = await ouvrirEtAttendre(app, fenetre);
  await vueSite(app, "vidola", "document.getElementById('pub').click()", { geste: true });
  await expect(page.getByTestId("site-avis")).toBeVisible();
  const region = (p: Page, id: string) => p.getByTestId(id).evaluate((e) => getComputedStyle(e).getPropertyValue("-webkit-app-region"));
  for (const id of ["site-precedent", "site-suivant", "site-recharger", "site-avis", "site-ouvrir-onglet"]) expect(await region(page, id), id).toBe("no-drag");
  expect(await region(page, "barre-site")).toBe("drag");
  // Avec un accueil : ⌂ dans la barre, et « Entrer dans le site » sous l'accueil.
  await ouvrirSite(fenetre, "tube");
  const tube = await fenetreSite(app, "tube");
  await expect(tube.getByTestId("site-accueil")).toBeVisible();
  for (const id of ["site-precedent", "site-suivant", "site-accueil", "site-recharger", "site-entrer"]) expect(await region(tube, id), id).toBe("no-drag");
  await fermer();
});

test("avec un accueil : la vue du site reste cachée ; « Entrer dans le site » charge le départ une fois, ⌂ y revient sans recharger", async () => {
  const { app, fenetre, fermer } = await demarrer({
    tube: {
      declaration: { nom: "Tube", adresse: serveur.url("vidola-a.localhost", "/"), domaines: ["vidola-a.localhost"] },
      fichiers: { "accueil/index.html": "<p>accueil</p>" },
    },
  });
  await ouvrirSite(fenetre, "tube");
  const page = await fenetreSite(app, "tube");
  await expect(page.getByTestId("site-entrer")).toHaveText("Entrer dans le site");
  await expect.poll(async () => (await etatVueSite(app, "tube"))?.visible).toBe(false);
  expect((await etatVueSite(app, "tube"))!.url).toBe("");
  await page.getByTestId("site-entrer").click();
  await expect.poll(async () => (await etatVueSite(app, "tube"))?.url).toBe(serveur.url("vidola-a.localhost", "/"));
  expect((await etatVueSite(app, "tube"))!.visible).toBe(true);
  await expect.poll(() => vueSite(app, "tube", "document.readyState")).toBe("complete");
  await vueSite(app, "tube", "window.marque = 7");
  await page.getByTestId("site-accueil").click();
  await expect.poll(async () => (await etatVueSite(app, "tube"))?.visible).toBe(false);
  await page.getByTestId("site-entrer").click();
  await expect.poll(async () => (await etatVueSite(app, "tube"))?.visible).toBe(true);
  expect(await vueSite(app, "tube", "window.marque")).toBe(7);
  await fermer();
});

test("précédent, suivant et recharger de la barre agissent sur la vue du site", async () => {
  const { app, fenetre, fermer } = await demarrer();
  const page = await ouvrirEtAttendre(app, fenetre);
  await expect(page.getByTestId("site-precedent")).toBeDisabled();
  // Avec un geste : Chromium saute à « précédent » les pages quittées sans geste.
  await vueSite(app, "vidola", "location.href = '/film/2'", { geste: true });
  await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-a.localhost", "/film/2"));
  await expect(page.getByTestId("site-precedent")).toBeEnabled();
  await page.getByTestId("site-precedent").click();
  await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-a.localhost", "/"));
  await expect(page.getByTestId("site-suivant")).toBeEnabled();
  await page.getByTestId("site-suivant").click();
  await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-a.localhost", "/film/2"));
  await expect.poll(() => vueSite(app, "vidola", "document.readyState")).toBe("complete");
  await vueSite(app, "vidola", "window.marque = 1");
  await page.getByTestId("site-recharger").click();
  await expect.poll(() => vueSite(app, "vidola", "window.marque === undefined && document.readyState === 'complete'")).toBe(true);
  await fermer();
});

test("un cookie posé par l'appli n'est ni dans persist:webaios, ni dans persist:site-autre, ni dans persist:app-x ; ni historique ni onglet ; aucune extension", async () => {
  const { app, fenetre, fermer } = await demarrer();
  await ouvrirEtAttendre(app, fenetre);
  await vueSite(app, "vidola", "location.href = '/cookie'");
  const cookies = (partition: string) =>
    app.evaluate(async ({ session }, p) => (await session.fromPartition(p).cookies.get({})).map((c) => `${c.name}=${c.value}`), partition);
  await expect.poll(() => cookies("persist:site-vidola")).toContain("essai=vidola-a.localhost");
  for (const p of ["persist:webaios", "persist:site-autre", "persist:app-x"]) expect(await cookies(p), p).toEqual([]);
  const visites = await fenetre.evaluate(() =>
    (window as unknown as { webaios: { historique: { rechercher(t: string, n: number, d: boolean): Promise<{ url: string }[]> } } }).webaios.historique.rechercher("vidola", 50, false),
  );
  expect(visites).toEqual([]);
  expect((await urlsOnglets(fenetre)).some((u) => u.includes("vidola"))).toBe(false);
  expect(await app.evaluate(({ session }) => session.fromPartition("persist:site-vidola").extensions.getAllExtensions().length)).toBe(0);
  await fermer();
});

/** Les requêtes reçues par pub.localhost pendant ce test, hors le cadre publicitaire que la page d'accueil du site contient. */
const rienVersPub = () => serveur.requetes.filter((r) => r.hote === "pub.localhost" && r.chemin !== "/cadre").map((r) => r.chemin);

test("un cadre pub.localhost qui fait top.location vers pub.localhost (avec geste) : bloqué, mention, aucune requête", async () => {
  const { app, fenetre, fermer } = await demarrer();
  const page = await ouvrirEtAttendre(app, fenetre);
  await expect.poll(() => vueSite(app, "vidola", "document.title", { cadre: 0 })).toBe("Cadre pub");
  serveur.requetes.splice(0);
  await vueSite(app, "vidola", `top.location = ${JSON.stringify(serveur.url("pub.localhost", "/haut"))}; 1`, { geste: true, cadre: 0 });
  await expect(page.getByTestId("site-avis")).toContainText("Lien vers pub.localhost bloqué");
  await new Promise((r) => setTimeout(r, 500));
  expect((await etatVueSite(app, "vidola"))!.url).toBe(serveur.url("vidola-a.localhost", "/"));
  expect(rienVersPub()).toEqual([]);
  await fermer();
});

test("un <meta refresh> vers pub.localhost : bloqué, mention, aucune requête", async () => {
  const { app, fenetre, fermer } = await demarrer();
  const page = await ouvrirEtAttendre(app, fenetre);
  await vueSite(app, "vidola", "location.href = '/refresh'", { geste: true });
  await expect(page.getByTestId("site-avis")).toContainText("Lien vers pub.localhost bloqué");
  await new Promise((r) => setTimeout(r, 500));
  expect((await etatVueSite(app, "vidola"))!.url).toBe(serveur.url("vidola-a.localhost", "/refresh"));
  expect(rienVersPub()).toEqual([]);
  await fermer();
});

test("un formulaire POST vers pub.localhost : bloqué, mention, aucune requête", async () => {
  const { app, fenetre, fermer } = await demarrer();
  const page = await ouvrirEtAttendre(app, fenetre);
  await vueSite(app, "vidola", "location.href = '/formulaire'", { geste: true });
  await expect.poll(() => vueSite(app, "vidola", "document.title")).toBe("Formulaire");
  await vueSite(app, "vidola", "document.getElementById('envoyer').click()", { geste: true });
  await expect(page.getByTestId("site-avis")).toContainText("Lien vers pub.localhost bloqué");
  await new Promise((r) => setTimeout(r, 500));
  expect((await etatVueSite(app, "vidola"))!.url).toBe(serveur.url("vidola-a.localhost", "/formulaire"));
  expect(rienVersPub()).toEqual([]);
  await fermer();
});

test("la petite fenêtre de connexion qui fait opener.location vers pub.localhost : la vue reste sur le site, aucune requête", async () => {
  const { app, fenetre, fermer } = await demarrer();
  const page = await ouvrirEtAttendre(app, fenetre);
  const connexion = serveur.url("compte.localhost", "/connexion");
  await vueSite(app, "vidola", `window.open(${JSON.stringify(connexion)}, "connexion", "width=500,height=650"); 1`, { geste: true });
  const dansLaPetite = (code: string) =>
    app.evaluate(({ BrowserWindow }, [url, code]) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL() === url);
      return w?.webContents.executeJavaScript(code, true);
    }, [connexion, code] as const);
  await expect.poll(() => dansLaPetite("document.readyState")).toBe("complete");
  expect(await dansLaPetite("!!window.opener")).toBe(true);
  await dansLaPetite(`opener.location = ${JSON.stringify(serveur.url("pub.localhost", "/opener"))}; 1`);
  await expect(page.getByTestId("site-avis")).toContainText("Lien vers pub.localhost bloqué");
  await new Promise((r) => setTimeout(r, 500));
  expect((await etatVueSite(app, "vidola"))!.url).toBe(serveur.url("vidola-a.localhost", "/"));
  expect(rienVersPub()).toEqual([]);
  await fermer();
});

test("précédent vers un domaine retiré de site.json depuis la visite : bloqué, « Lien vers vidola-b.localhost bloqué »", async () => {
  const deuxDomaines = { declaration: { ...vidola().declaration, domaines: ["vidola-a.localhost", "vidola-b.localhost"] } };
  const { app, fenetre, racine, fermer } = await demarrer({ vidola: deuxDomaines });
  const page = await ouvrirEtAttendre(app, fenetre);
  await vueSite(app, "vidola", `location.href = ${JSON.stringify(serveur.url("vidola-b.localhost", "/"))}`, { geste: true });
  await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-b.localhost", "/"));
  await vueSite(app, "vidola", `location.href = ${JSON.stringify(serveur.url("vidola-a.localhost", "/film/2"))}`, { geste: true });
  await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-a.localhost", "/film/2"));
  // L'agent retire vidola-b de site.json ; l'utilisateur rouvre l'appli (même fenêtre, nouvelles règles).
  ecrireSite(racine, "vidola", vidola());
  await ouvrirSite(fenetre, "vidola");
  await expect(page.getByTestId("site-precedent")).toBeEnabled();
  serveur.requetes.splice(0);
  await page.getByTestId("site-precedent").click();
  await expect(page.getByTestId("site-avis")).toContainText("Lien vers vidola-b.localhost bloqué");
  await new Promise((r) => setTimeout(r, 500));
  expect((await etatVueSite(app, "vidola"))!.url).toBe(serveur.url("vidola-a.localhost", "/film/2"));
  expect(serveur.requetes.filter((r) => r.hote === "vidola-b.localhost")).toEqual([]);
  await fermer();
});

test("des window.open en rafale vers deux domaines alternés : au plus un changement de mention par 500 ms", async () => {
  const { app, fenetre, fermer } = await demarrer();
  const page = await ouvrirEtAttendre(app, fenetre);
  // Compte, côté process principal, les états envoyés à l'interface de la fenêtre.
  const envois = () => app.evaluate(() => (globalThis as unknown as { envoisEtat: number }).envoisEtat);
  await app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as unknown as { envoisEtat: number };
    g.envoisEtat = 0;
    const ui = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("/renderer/site.html"))!.webContents;
    const envoyer = ui.send.bind(ui);
    ui.send = (canal: string, ...args: unknown[]) => {
      if (canal === "webaios:site-etat-change") g.envoisEtat++;
      envoyer(canal, ...args);
    };
  });
  const a = JSON.stringify(serveur.url("pub.localhost", "/x"));
  const b = JSON.stringify(serveur.url("autre-pub.localhost", "/x"));
  // Un geste par ouverture (sans geste, Chromium n'en laisse passer qu'une), tous dans le même aller-retour au process principal.
  await app.evaluate(({ BrowserWindow }, [a, b]) => {
    const f = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("/renderer/site.html"))!;
    const wc = (f.contentView.children[0] as Electron.WebContentsView).webContents;
    return Promise.all(Array.from({ length: 20 }, (_, i) => wc.executeJavaScript(`window.open(${i % 2 ? a : b}); 1`, true)));
  }, [a, b] as const);
  await expect(page.getByTestId("site-avis")).toContainText("Lien vers pub.localhost bloqué");
  await new Promise((r) => setTimeout(r, 1200));
  // La première tout de suite, la dernière (pub.localhost) au plus 500 ms après : pas une par ouverture.
  expect(await envois()).toBeGreaterThanOrEqual(1);
  expect(await envois()).toBeLessThanOrEqual(3);
  await expect(page.getByTestId("site-avis")).toContainText("Lien vers pub.localhost bloqué");
  await fermer();
});

// ——— L'écran d'accueil (tâche 7) ———

/** Une image PNG de 1 × 1 px. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

/** Un accueil qui affiche la mémoire reçue et note tout message de l'interface (`window.recus`). */
const ACCUEIL = `<!doctype html><meta charset="utf-8"><title>Accueil</title>
<ul id="series"></ul><p id="domaine"></p><button id="ouvrir">Reprendre</button>
<script>
  window.recus = [];
  window.adresse = "/";
  document.getElementById("ouvrir").addEventListener("click", () => parent.postMessage({ type: "ouvrir", adresse: window.adresse }, "*"));
  addEventListener("message", (e) => {
    window.recus.push(e.data);
    if (e.data && e.data.type === "memoire") {
      const ul = document.getElementById("series");
      ul.textContent = "";
      for (const [cle, v] of Object.entries(e.data.valeurs)) {
        const li = document.createElement("li");
        li.textContent = cle + " : " + v.valeur.titre + " " + v.adresse;
        ul.append(li);
      }
      document.getElementById("domaine").textContent = e.data.domaine;
    }
  });
  parent.postMessage({ type: "pret" }, "*");
</script>`;

/** Vidola avec un accueil ; `actuel` : le domaine où le site a déménagé (adresse.json du profil). */
async function demarrerAccueil(o: { actuel?: string } = {}) {
  const l = await demarrer({
    vidola: { declaration: vidola().declaration, fichiers: { "accueil/index.html": ACCUEIL, "accueil/img/logo.png": PNG } },
    autre: { declaration: { nom: "Autre", adresse: serveur.url("vidola-b.localhost", "/"), domaines: ["vidola-b.localhost"] }, fichiers: { "accueil/index.html": "<p>autre</p>" } },
  });
  const dossier = join(l.profil, "sites", "vidola");
  mkdirSync(dossier, { recursive: true });
  const quand = new Date().toISOString();
  writeFileSync(
    join(dossier, "memoire.json"),
    JSON.stringify({ version: 1, valeurs: { "encours.the-bear": { valeur: { titre: "The Bear", episode: "S2E4" }, adresse: "/serie/the-bear?e=4", quand } }, positions: {} }),
  );
  if (o.actuel) writeFileSync(join(dossier, "adresse.json"), JSON.stringify({ actuel: o.actuel, anciens: ["vidola-a.localhost"], depuis: quand }));
  await ouvrirSite(l.fenetre, "vidola");
  const page = await fenetreSite(l.app, "vidola");
  const accueil = await cadreAccueil(page);
  await expect.poll(() => accueil.evaluate(() => (window as unknown as { recus: unknown[] }).recus.length)).toBeGreaterThan(0);
  return { ...l, page, accueil };
}

/** Le cadre de l'écran d'accueil dans l'interface de la fenêtre. */
async function cadreAccueil(page: Page): Promise<Frame> {
  for (const fin = Date.now() + 10_000; Date.now() < fin; ) {
    const f = page.frames().find((x) => x.url().startsWith("webaios-site://"));
    if (f) return f;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("le cadre de l'accueil n'est pas apparu");
}

/** L'utilisateur clique « Reprendre » dans l'accueil (un vrai clic), qui demande alors `adresse`. */
async function cliquerOuvrir(page: Page, adresse: string): Promise<void> {
  await (await cadreAccueil(page)).evaluate((a) => void ((window as unknown as { adresse: string }).adresse = a), adresse);
  await page.frameLocator('[data-testid="site-cadre-accueil"]').locator("#ouvrir").click();
}

/** L'accueil envoie `m` à l'interface (comme le ferait le code de l'agent). */
const demander = (accueil: Frame, m: object) => accueil.evaluate((m) => parent.postMessage(m, "*"), m);
const recus = (accueil: Frame) => accueil.evaluate(() => (window as unknown as { recus: { type: string; n?: number; data?: string | null }[] }).recus);

test("l'accueil reçoit la mémoire écrite par le test (encours.the-bear) et l'affiche ; il a la garde des widgets", async () => {
  const { page, accueil, fermer } = await demarrerAccueil();
  await expect(page.getByTestId("site-cadre-accueil")).toHaveAttribute("sandbox", "allow-scripts");
  await expect(page.getByTestId("site-cadre-accueil")).toHaveAttribute("src", "webaios-site://vidola/index.html");
  const cadre = page.frameLocator('[data-testid="site-cadre-accueil"]');
  await expect(cadre.locator("#series")).toHaveText("encours.the-bear : The Bear /serie/the-bear?e=4");
  await expect(cadre.locator("#domaine")).toHaveText("vidola-a.localhost");
  // Origine opaque, garde du preload posée (ni WebRTC ni XSLT), aucune API de WebAiOs.
  expect(await accueil.evaluate(() => [origin, typeof RTCPeerConnection, typeof XSLTProcessor, typeof (window as unknown as { webaios?: unknown }).webaios])).toEqual(["null", "undefined", "undefined", "undefined"]);
  // Toujours le bouton de WebAiOs sous l'accueil, cliquable dans la zone de glissement.
  await expect(page.getByTestId("site-entrer")).toHaveText("Entrer dans le site");
  expect(await page.getByTestId("site-entrer").evaluate((e) => getComputedStyle(e).getPropertyValue("-webkit-app-region"))).toBe("no-drag");
  await fermer();
});

test("il demande « /serie/the-bear?e=4 » : la vue du site y va sur le domaine actuel", async () => {
  serveur.definir("vidola-b.localhost", "/serie/the-bear", "<title>The Bear</title>");
  const { app, page, accueil, fermer } = await demarrerAccueil({ actuel: "vidola-b.localhost" });
  await expect.poll(async () => (await recus(accueil)).find((m) => m.type === "memoire")).toMatchObject({ domaine: "vidola-b.localhost" });
  await cliquerOuvrir(page, "/serie/the-bear?e=4");
  await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-b.localhost", "/serie/the-bear?e=4"));
  expect((await etatVueSite(app, "vidola"))!.visible).toBe(true);
  expect(serveur.requetes.filter((r) => r.hote === "vidola-a.localhost")).toEqual([]);
  await fermer();
});

test("il demande javascript:alert(1), //pub.localhost/x, https://pub.localhost/ : rien ne s'ouvre", async () => {
  serveur.definir("vidola-a.localhost", "/serie/the-bear", "<title>The Bear</title>");
  const { app, page, accueil, fermer } = await demarrerAccueil();
  // Après un vrai clic dans l'accueil : refusées quand même.
  for (const adresse of ["javascript:alert(1)", "//pub.localhost/x", "https://pub.localhost/", serveur.url("pub.localhost", "/x"), "/\\pub.localhost/x", "x".repeat(2001)])
    await cliquerOuvrir(page, adresse);
  await demander(accueil, { type: "ouvrir", adresse: "javascript:alert(1)" });
  // Les mêmes refus par l'API de l'interface (ce que le relais appelle).
  const api = (a: string) => page.evaluate((a) => (window as unknown as { webaios: { site: { ouvrir(a: string): Promise<boolean> } } }).webaios.site.ouvrir(a), a);
  expect(await api("javascript:alert(1)")).toBe(false);
  expect(await api("https://pub.localhost/")).toBe(false);
  await new Promise((r) => setTimeout(r, 500));
  const e = (await etatVueSite(app, "vidola"))!;
  expect(e.url).toBe("");
  expect(e.visible).toBe(false);
  expect(serveur.requetes).toEqual([]);
  // Les refus n'ont rien consommé : une adresse du site s'ouvre aussitôt après un clic.
  await cliquerOuvrir(page, "/serie/the-bear?e=4");
  await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-a.localhost", "/serie/the-bear?e=4"));
  await fermer();
});

test("au plus une adresse ouverte par seconde depuis l'accueil", async () => {
  serveur.definir("vidola-a.localhost", "/serie/the-bear", "<title>The Bear</title>");
  const { app, page, fermer } = await demarrerAccueil();
  await cliquerOuvrir(page, "/serie/the-bear?e=1");
  await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-a.localhost", "/serie/the-bear?e=1"));
  await page.getByTestId("site-accueil").click();
  await expect.poll(async () => (await etatVueSite(app, "vidola"))?.visible).toBe(false);
  await cliquerOuvrir(page, "/serie/the-bear?e=2");
  await new Promise((r) => setTimeout(r, 300));
  expect(await etatVueSite(app, "vidola")).toMatchObject({ visible: false, url: serveur.url("vidola-a.localhost", "/serie/the-bear?e=1") });
  await new Promise((r) => setTimeout(r, 1100));
  await cliquerOuvrir(page, "/serie/the-bear?e=3");
  await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-a.localhost", "/serie/the-bear?e=3"));
  await fermer();
});

test("fetch depuis l'accueil vers le serveur de test : aucune requête reçue ; il ne quitte pas son accueil", async () => {
  const { page, accueil, fermer } = await demarrerAccueil();
  const espion = (c: string) => serveur.url("vidola-a.localhost", `/espion-${c}`);
  const fetchRefuse = await accueil.evaluate(async (u) => {
    try {
      await fetch(u);
      return false;
    } catch {
      return true;
    }
  }, espion("fetch"));
  expect(fetchRefuse).toBe(true);
  await accueil.evaluate(
    ([img, beacon, form]) => {
      const i = new Image();
      i.src = img;
      navigator.sendBeacon(beacon, "x");
      const f = document.createElement("form");
      f.action = form;
      f.method = "post";
      document.body.append(f);
      f.submit();
    },
    [espion("img"), espion("beacon"), espion("form")] as const,
  );
  // Navigation du cadre vers le web, puis vers l'accueil d'une autre appli : refusées.
  await accueil.evaluate((u) => void (location.href = u), espion("nav")).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  await accueil.evaluate(() => void (location.href = "webaios-site://autre/index.html")).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  expect(serveur.requetes).toEqual([]);
  const urls = page.frames().map((f) => f.url()).filter((u) => u !== page.url());
  expect(urls.every((u) => u.startsWith("webaios-site://vidola/") || u.startsWith("chrome-error:")), urls.join(" ")).toBe(true);
  expect(urls.some((u) => u.includes("autre"))).toBe(false);
  await fermer();
});

test("une image du site demandée revient en data: (avec les cookies de l'appli) ; une image de pub.localhost revient null", async () => {
  serveur.definir("vidola-a.localhost", "/affiche.png", (_req, res) => res.writeHead(200, { "Content-Type": "image/png" }).end(PNG));
  serveur.definir("pub.localhost", "/pub.png", (_req, res) => res.writeHead(200, { "Content-Type": "image/png" }).end(PNG));
  const { app, accueil, fermer } = await demarrerAccueil();
  await app.evaluate(({ session }, url) => session.fromPartition("persist:site-vidola").cookies.set({ url, name: "essai", value: "appli" }), serveur.url("vidola-a.localhost", "/"));
  await demander(accueil, { type: "image", n: 1, url: serveur.url("vidola-a.localhost", "/affiche.png") });
  await demander(accueil, { type: "image", n: 2, url: serveur.url("pub.localhost", "/pub.png") });
  await expect.poll(async () => (await recus(accueil)).filter((m) => m.type === "image").length).toBe(2);
  const images = (await recus(accueil)).filter((m) => m.type === "image");
  expect(images.find((m) => m.n === 1)?.data).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
  expect(images.find((m) => m.n === 2)?.data).toBeNull();
  expect(serveur.requetes.map((r) => [r.hote, r.chemin, r.cookie])).toEqual([["vidola-a.localhost", "/affiche.png", "essai=appli"]]);
  // Ses propres images (accueil/img/) se chargent par le schéma, sans passer par WebAiOs.
  const largeur = await accueil.evaluate(
    () =>
      new Promise<number>((ok) => {
        const i = new Image();
        i.onload = () => ok(i.naturalWidth);
        i.onerror = () => ok(-1);
        i.src = "webaios-site://vidola/img/logo.png";
      }),
  );
  expect(largeur).toBe(1);
  await fermer();
});

test("⌂ revient à l'accueil, « Entrer dans le site » retrouve la page où il était (même URL, pas de rechargement)", async () => {
  serveur.definir("vidola-a.localhost", "/serie/the-bear", "<title>The Bear</title>");
  const { app, page, fermer } = await demarrerAccueil();
  await cliquerOuvrir(page, "/serie/the-bear?e=4");
  const url = serveur.url("vidola-a.localhost", "/serie/the-bear?e=4");
  await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(url);
  await expect.poll(() => vueSite(app, "vidola", "document.readyState")).toBe("complete");
  await vueSite(app, "vidola", "window.marque = 7");
  await page.getByTestId("site-accueil").click();
  await expect.poll(async () => (await etatVueSite(app, "vidola"))?.visible).toBe(false);
  // L'accueil revient (nouveau cadre) et relit la mémoire.
  const revenu = await cadreAccueil(page);
  await expect(page.frameLocator('[data-testid="site-cadre-accueil"]').locator("#series")).toContainText("The Bear");
  expect(revenu.url()).toBe("webaios-site://vidola/index.html");
  const avant = serveur.requetes.length;
  await page.getByTestId("site-entrer").click();
  await expect.poll(async () => (await etatVueSite(app, "vidola"))?.visible).toBe(true);
  expect((await etatVueSite(app, "vidola"))!.url).toBe(url);
  expect(await vueSite(app, "vidola", "window.marque")).toBe(7);
  expect(serveur.requetes.length).toBe(avant);
  await fermer();
});

test("une demande « ouvrir » envoyée au chargement de l'accueil est refusée ; la même après un clic dans l'accueil ouvre", async () => {
  serveur.definir("vidola-a.localhost", "/serie/the-bear", "<title>The Bear</title>");
  const auto = ACCUEIL.replace('parent.postMessage({ type: "pret" }, "*");', 'parent.postMessage({ type: "pret" }, "*"); parent.postMessage({ type: "ouvrir", adresse: "/serie/the-bear?e=9" }, "*");');
  const l = await demarrer({ vidola: { declaration: vidola().declaration, fichiers: { "accueil/index.html": auto } } });
  await ouvrirSite(l.fenetre, "vidola");
  const page = await fenetreSite(l.app, "vidola");
  const accueil = await cadreAccueil(page);
  await expect.poll(() => accueil.evaluate(() => (window as unknown as { recus: unknown[] }).recus.length)).toBeGreaterThan(0);
  // Sans geste, même redemandé par le code de l'accueil (y compris un clic qu'il simule) : rien ne s'ouvre.
  await demander(accueil, { type: "ouvrir", adresse: "/serie/the-bear?e=9" });
  await accueil.evaluate(() => document.getElementById("ouvrir")!.click());
  await new Promise((r) => setTimeout(r, 1500));
  expect(await etatVueSite(l.app, "vidola")).toMatchObject({ url: "", visible: false });
  expect(serveur.requetes).toEqual([]);
  // ⌂ ne repart pas sur le site : l'accueil rechargé redemande, sans effet.
  await cliquerOuvrir(page, "/serie/the-bear?e=4");
  await expect.poll(async () => (await etatVueSite(l.app, "vidola"))?.url).toBe(serveur.url("vidola-a.localhost", "/serie/the-bear?e=4"));
  await page.getByTestId("site-accueil").click();
  await expect.poll(async () => (await etatVueSite(l.app, "vidola"))?.visible).toBe(false);
  await new Promise((r) => setTimeout(r, 2000));
  expect(await etatVueSite(l.app, "vidola")).toMatchObject({ visible: false, url: serveur.url("vidola-a.localhost", "/serie/the-bear?e=4") });
  await l.fermer();
});

test("une image du site redirigée (vrai 302 du serveur) : suivie sur le site, refusée vers pub.localhost sans y aller", async () => {
  serveur.definir("vidola-a.localhost", "/affiche.png", (_req, res) => res.writeHead(200, { "Content-Type": "image/png" }).end(PNG));
  serveur.definir("vidola-a.localhost", "/img/123", (_req, res) => res.writeHead(302, { Location: "/affiche.png" }).end());
  serveur.definir("vidola-a.localhost", "/img/pub", (_req, res) => res.writeHead(302, { Location: serveur.url("pub.localhost", "/pub.png") }).end());
  serveur.definir("pub.localhost", "/pub.png", (_req, res) => res.writeHead(200, { "Content-Type": "image/png" }).end(PNG));
  for (let i = 0; i < 5; i++) serveur.definir("vidola-a.localhost", `/boucle/${i}`, (_req, res) => res.writeHead(302, { Location: `/boucle/${i + 1}` }).end());
  const { app, accueil, fermer } = await demarrerAccueil();
  await app.evaluate(({ session }, url) => session.fromPartition("persist:site-vidola").cookies.set({ url, name: "essai", value: "appli" }), serveur.url("vidola-a.localhost", "/"));
  await demander(accueil, { type: "image", n: 1, url: serveur.url("vidola-a.localhost", "/img/123") });
  await demander(accueil, { type: "image", n: 2, url: serveur.url("vidola-a.localhost", "/img/pub") });
  await demander(accueil, { type: "image", n: 3, url: serveur.url("vidola-a.localhost", "/boucle/0") });
  await expect.poll(async () => (await recus(accueil)).filter((m) => m.type === "image").length).toBe(3);
  const images = (await recus(accueil)).filter((m) => m.type === "image");
  expect(images.find((m) => m.n === 1)?.data).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
  expect(images.find((m) => m.n === 2)?.data).toBeNull();
  expect(images.find((m) => m.n === 3)?.data).toBeNull();
  const vues = serveur.requetes.map((r) => `${r.hote}${r.chemin}`);
  expect(vues.filter((v) => v.startsWith("pub.localhost"))).toEqual([]);
  // La redirection suivie garde les cookies de l'appli ; la boucle s'arrête après 3 sauts.
  expect(serveur.requetes.find((r) => r.chemin === "/affiche.png")?.cookie).toBe("essai=appli");
  expect(vues.filter((v) => v.includes("/boucle/"))).toEqual(["/boucle/0", "/boucle/1", "/boucle/2", "/boucle/3"].map((c) => `vidola-a.localhost${c}`));
  await fermer();
});

// --- Les retouches de l'agent (monde isolé, garde des extensions, webaiosSite)

/**
 * La retouche de la page d'une série : elle cache `.shorts` (CSS), retient l'épisode, note ce qu'elle voit de son monde
 * dans le DOM (partagé avec la page), et répond aux commandes du test (`data-commande` puis un événement « essai »).
 */
const RETOUCHE_SERIE = `
const racine = document.documentElement;
racine.dataset.monde = JSON.stringify({ require: typeof require, ipcRenderer: typeof ipcRenderer, process: typeof process, pont: typeof webaiosSite });
document.body.dataset.retouche = "oui";
webaiosSite.retenir("encours.the-bear", { titre: "The Bear", episode: "S2E4" }).then(() => (racine.dataset.retenu = "oui"), (e) => (racine.dataset.retenu = "refus:" + e.message));
const repondre = (p) => p.then((r) => (racine.dataset.resultat = "ok:" + r), (e) => (racine.dataset.resultat = "refus:" + (e && e.message)));
document.addEventListener("essai", () => {
  const c = racine.dataset.commande;
  if (c === "mdp") racine.dataset.resultat = "valeur:" + document.getElementById("mdp").value;
  else if (c === "fetch-pub") repondre(Promise.resolve().then(() => fetch(racine.dataset.pub)).then((r) => r.status));
  else if (c === "fetch-site") repondre(fetch("/film/2").then((r) => r.status));
  else if (c === "elargir") {
    __webaiosPortee({ reseau: [racine.dataset.pubHote], hotes: ["<all_urls>"] });
    repondre(Promise.resolve().then(() => fetch(racine.dataset.pub)).then((r) => r.status));
  } else if (c === "non-json") repondre(webaiosSite.retenir("f", () => 1));
  else if (c === "lire") repondre(webaiosSite.lire("encours.the-bear").then((v) => JSON.stringify(v)));
});`;

/** Vidola avec ses retouches, l'accord déjà donné (écrit par le test dans le profil, comme « Autoriser »). */
async function demarrerRetouches(fichiers: Record<string, string> = {}) {
  const lecteur = serveur.url("lecteur.localhost", "/*").replace(/^http:/, "https:");
  const declaration = {
    nom: "Vidola",
    adresse: serveur.url("vidola-a.localhost", "/serie/the-bear"),
    domaines: ["vidola-a.localhost"],
    connexion: ["compte.localhost"],
    retouches: [
      { correspond: ["/serie/*"], js: ["serie.js"], css: ["cacher.css"] },
      { correspond: ["/jamais"], js: ["cadre.js"], cadres: [lecteur] },
      { correspond: ["/erreur"], js: ["erreur.js", "apres.js"] },
    ],
  };
  const l = await demarrer({
    vidola: {
      declaration,
      fichiers: {
        "retouches/serie.js": RETOUCHE_SERIE,
        "retouches/cacher.css": ".shorts { display: none; }",
        "retouches/cadre.js": 'document.documentElement.dataset.cadre = "oui"; document.documentElement.dataset.pont = typeof webaiosSite;',
        "retouches/erreur.js": 'throw new Error("retouche cassée");',
        "retouches/apres.js": 'document.documentElement.dataset.apres = "oui"; setTimeout(() => { throw new Error("plus tard"); });',
        ...fichiers,
      },
    },
  });
  writeFileSync(
    join(l.profil, "sites-accords.json"),
    JSON.stringify({ vidola: { domaines: ["vidola-a.localhost"], connexion: ["compte.localhost"], cadres: [lecteur], reprise: false } }),
  );
  const page = await ouvrirEtAttendre(l.app, l.fenetre, "vidola", "/serie/the-bear");
  return { ...l, page };
}

test.describe("retouches", () => {
  test.beforeAll(() => {
    serveur.definir(
      "vidola-a.localhost",
      "/serie/the-bear",
      '<title>The Bear</title><div class="shorts" id="shorts">shorts</div><input type="password" id="mdp"><p>épisode</p>',
    );
    serveur.definir("vidola-a.localhost", "/lecteur", `<title>Lecteur</title><iframe id="l" src="${serveur.url("lecteur.localhost", "/v")}"></iframe>`);
    serveur.definir("lecteur.localhost", "/v", "<title>Vidéo</title><video></video>");
    serveur.definir("vidola-a.localhost", "/erreur", "<title>Erreur</title><p id='p'>la page marche</p>");
    // Une page qui arrête DOMContentLoaded dès window, en capture, avant tout autre écouteur qu'elle connaît.
    serveur.definir(
      "vidola-a.localhost",
      "/serie/bloque",
      '<title>Bloque</title><script>window.addEventListener("DOMContentLoaded", (e) => e.stopImmediatePropagation(), true); document.addEventListener("DOMContentLoaded", (e) => e.stopImmediatePropagation(), true);</script><div class="shorts" id="shorts">shorts</div><input type="password" id="mdp">',
    );
  });

  const commande = async (app: ElectronApplication, c: string) => {
    await vueSite(app, "vidola", `document.documentElement.dataset.resultat = ""; document.documentElement.dataset.commande = ${JSON.stringify(c)}; document.dispatchEvent(new Event("essai"))`);
    await expect.poll(() => vueSite(app, "vidola", "document.documentElement.dataset.resultat")).not.toBe("");
    return vueSite(app, "vidola", "document.documentElement.dataset.resultat");
  };

  test("une retouche CSS cache .shorts dans la page (display none)", async () => {
    const { app, fermer } = await demarrerRetouches();
    await expect.poll(() => vueSite(app, "vidola", 'getComputedStyle(document.getElementById("shorts")).display')).toBe("none");
    await fermer();
  });

  test("une retouche JS retient encours.the-bear par webaiosSite.retenir ; la mémoire relue par le test a adresse \"/serie/the-bear\"", async () => {
    const { app, profil, fermer } = await demarrerRetouches();
    await expect.poll(() => vueSite(app, "vidola", "document.documentElement.dataset.retenu")).toBe("oui");
    const fichier = join(profil, "sites", "vidola", "memoire.json");
    await expect.poll(() => existsSync(fichier)).toBe(true);
    const m = JSON.parse(readFileSync(fichier, "utf8"));
    expect(m.valeurs["encours.the-bear"]).toMatchObject({ valeur: { titre: "The Bear", episode: "S2E4" }, adresse: "/serie/the-bear" });
    expect(await commande(app, "lire")).toBe('ok:{"titre":"The Bear","episode":"S2E4"}');
    // Une valeur non JSON : refus nommé par la mémoire.
    expect(await commande(app, "non-json")).toBe("refus:Valeur refusée : JSON seulement");
    await fermer();
  });

  test('dans la retouche : typeof require, ipcRenderer, process sont "undefined"', async () => {
    const { app, fermer } = await demarrerRetouches();
    await expect.poll(() => vueSite(app, "vidola", "document.documentElement.dataset.monde")).toBeTruthy();
    const monde = JSON.parse(String(await vueSite(app, "vidola", "document.documentElement.dataset.monde")));
    expect(monde).toEqual({ require: "undefined", ipcRenderer: "undefined", process: "undefined", pont: "object" });
    await fermer();
  });

  test("dans le monde de la page : window.webaiosSite est undefined et le DOM est modifié", async () => {
    const { app, fermer } = await demarrerRetouches();
    await expect.poll(() => vueSite(app, "vidola", "document.body.dataset.retouche")).toBe("oui");
    expect(await vueSite(app, "vidola", "typeof window.webaiosSite")).toBe("undefined");
    expect(await vueSite(app, "vidola", "typeof __webaiosPortee")).toBe("undefined");
    await fermer();
  });

  test('dans le sous-cadre lecteur.localhost avec motif cadres : la retouche tourne, typeof webaiosSite === "undefined"', async () => {
    const { app, fermer } = await demarrerRetouches();
    await vueSite(app, "vidola", `location.href = ${JSON.stringify(serveur.url("vidola-a.localhost", "/lecteur"))}`);
    await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-a.localhost", "/lecteur"));
    await expect.poll(() => vueSite(app, "vidola", "document.documentElement.dataset.cadre ?? null", { cadre: 0 })).toBe("oui");
    expect(await vueSite(app, "vidola", "document.documentElement.dataset.pont", { cadre: 0 })).toBe("undefined");
    // La retouche du cadre ne va pas dans la page principale (/lecteur n'est dans aucun « correspond »).
    expect(await vueSite(app, "vidola", "document.documentElement.dataset.cadre ?? null")).toBeNull();
    await fermer();
  });

  test("fetch de la retouche vers pub.localhost rejeté, aucune requête reçue ; vers le site, permis", async () => {
    const { app, fermer } = await demarrerRetouches();
    await expect.poll(() => vueSite(app, "vidola", "document.body.dataset.retouche")).toBe("oui");
    await vueSite(app, "vidola", `document.documentElement.dataset.pub = ${JSON.stringify(serveur.url("pub.localhost", "/x"))}`);
    serveur.requetes.splice(0);
    expect(await commande(app, "fetch-pub")).toMatch(/^refus:/);
    expect(await commande(app, "fetch-site")).toBe("ok:200");
    expect(serveur.requetes.filter((r) => r.hote === "pub.localhost")).toEqual([]);
    expect(serveur.requetes.some((r) => r.hote === "vidola-a.localhost" && r.chemin === "/film/2")).toBe(true);
    await fermer();
  });

  test('un champ mot de passe rempli par le test : la retouche lit ""', async () => {
    const { app, fermer } = await demarrerRetouches();
    await expect.poll(() => vueSite(app, "vidola", "document.body.dataset.retouche")).toBe("oui");
    await vueSite(app, "vidola", 'document.getElementById("mdp").value = "secret"');
    expect(await vueSite(app, "vidola", 'document.getElementById("mdp").value')).toBe("secret");
    expect(await commande(app, "mdp")).toBe("valeur:");
    await fermer();
  });

  test("__webaiosPortee rappelé avec <all_urls> : fetch vers pub.localhost toujours rejeté", async () => {
    const { app, fermer } = await demarrerRetouches();
    await expect.poll(() => vueSite(app, "vidola", "document.body.dataset.retouche")).toBe("oui");
    await vueSite(app, "vidola", `document.documentElement.dataset.pub = ${JSON.stringify(serveur.url("pub.localhost", "/x"))}; document.documentElement.dataset.pubHote = "pub.localhost"`);
    serveur.requetes.splice(0);
    expect(await commande(app, "elargir")).toMatch(/^refus:/);
    expect(serveur.requetes.filter((r) => r.hote === "pub.localhost")).toEqual([]);
    await fermer();
  });

  test("une retouche qui lève une erreur : erreursRetouches la contient, la page marche", async () => {
    const { app, fermer } = await demarrerRetouches();
    await vueSite(app, "vidola", `location.href = ${JSON.stringify(serveur.url("vidola-a.localhost", "/erreur"))}`);
    await expect.poll(() => vueSite(app, "vidola", "document.documentElement.dataset.apres ?? null")).toBe("oui");
    const erreurs = () => app.evaluate(() => (globalThis as unknown as { __webaiosErreursRetouches(id: string): { texte: string; source: string; sourceVerifiee: boolean }[] }).__webaiosErreursRetouches("vidola"));
    await expect.poll(async () => (await erreurs()).map((e) => e.texte).join("\n")).toContain("retouche cassée");
    await expect.poll(async () => (await erreurs()).map((e) => e.texte).join("\n")).toContain("plus tard");
    const e = (await erreurs()).find((x) => x.texte.includes("retouche cassée"))!;
    expect(e.source).toMatch(/^webaios-retouche:\/\/vidola\/erreur\.js/);
    // La source se dit une retouche : rien ne le prouve (la page peut se nommer ainsi).
    expect(e.sourceVerifiee).toBe(false);
    expect(await vueSite(app, "vidola", 'document.getElementById("p").textContent')).toBe("la page marche");
    await fermer();
  });

  test("réécrire retouches/a.js : la vue se recharge et le nouveau code tourne", async () => {
    const { app, racine, fermer } = await demarrerRetouches();
    await expect.poll(() => vueSite(app, "vidola", "document.body.dataset.retouche")).toBe("oui");
    await vueSite(app, "vidola", "window.marque = 1");
    writeFileSync(join(racine, "sites", "vidola", "retouches", "serie.js"), 'document.documentElement.dataset.version = "2";');
    await expect.poll(() => vueSite(app, "vidola", "document.documentElement.dataset.version ?? null"), { timeout: 10_000 }).toBe("2");
    expect(await vueSite(app, "vidola", "window.marque ?? null")).toBeNull();
    await fermer();
  });

  test("une page qui appelle stopImmediatePropagation sur DOMContentLoaded (window, capture) : la retouche tourne", async () => {
    const { app, fermer } = await demarrerRetouches();
    await vueSite(app, "vidola", `location.href = ${JSON.stringify(serveur.url("vidola-a.localhost", "/serie/bloque"))}`);
    await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-a.localhost", "/serie/bloque"));
    await expect.poll(() => vueSite(app, "vidola", "document.body.dataset.retouche ?? null")).toBe("oui");
    await fermer();
  });

  test("le canal mémoire qui échoue : le pont rejette sans redemander (un seul appel)", async () => {
    const { app, fermer } = await demarrerRetouches();
    await expect.poll(() => vueSite(app, "vidola", "document.documentElement.dataset.retenu")).toBe("oui");
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { appelsMemoire: unknown[] };
      g.appelsMemoire = [];
      ipcMain.removeHandler("webaios:site-memoire");
      ipcMain.handle("webaios:site-memoire", (_e, d) => {
        g.appelsMemoire.push(d);
        throw new Error("panne");
      });
    });
    expect(await commande(app, "lire")).toMatch(/^refus:/);
    expect(await app.evaluate(() => (globalThis as unknown as { appelsMemoire: unknown[] }).appelsMemoire.length)).toBe(1);
    // Une valeur non clonable n'est jamais envoyée telle quelle, et l'erreur n'est pas redemandée.
    expect(await commande(app, "non-json")).toMatch(/^refus:/);
    expect(await app.evaluate(() => (globalThis as unknown as { appelsMemoire: unknown[] }).appelsMemoire.length)).toBeLessThanOrEqual(2);
    await fermer();
  });

  for (const [cas, accord] of [
    ["sans accord", () => ({})],
    // L'accord d'avant l'ajout du motif de cadres : il couvre moins que ce que la déclaration demande.
    ["avec un accord qui couvre moins que la déclaration", () => ({ vidola: { domaines: ["vidola-a.localhost"], connexion: ["compte.localhost"], cadres: [], reprise: false } })],
  ] as const)
  test(`${cas} : ni CSS ni script de l'agent dans la page`, async () => {
    const { app, profil, fenetre, fermer } = await demarrerRetouches();
    await expect.poll(() => vueSite(app, "vidola", "document.body.dataset.retouche")).toBe("oui");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes("/renderer/site.html")).forEach((w) => w.destroy()));
    writeFileSync(join(profil, "sites-accords.json"), JSON.stringify(accord()));
    await ouvrirSite(fenetre, "vidola");
    await fenetreSite(app, "vidola");
    // Sans accord, la vue attend la carte : la page est chargée ici à la main, dans la vue cachée de l'appli.
    await app.evaluate(({ BrowserWindow }, url) => {
      const f = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("/renderer/site.html"));
      void (f?.contentView.children[0] as Electron.WebContentsView).webContents.loadURL(url);
    }, serveur.url("vidola-a.localhost", "/serie/the-bear"));
    await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-a.localhost", "/serie/the-bear"));
    await expect.poll(() => vueSite(app, "vidola", "document.readyState")).toBe("complete");
    await new Promise((r) => setTimeout(r, 300));
    expect(await vueSite(app, "vidola", "document.body.dataset.retouche ?? null")).toBeNull();
    expect(await vueSite(app, "vidola", 'getComputedStyle(document.getElementById("shorts")).display')).toBe("block");
    await fermer();
  });
});

// --- La carte d'accord des retouches (redemandée quand les droits grandissent)

test.describe("carte d'accord", () => {
  const lecteur = () => serveur.url("lecteur.localhost", "/*").replace(/^http:/, "https:");
  const declaration = (plus: { connexion?: string[] } = {}) => ({
    nom: "Vidola",
    adresse: serveur.url("vidola-a.localhost", "/serie/the-bear"),
    domaines: ["vidola-a.localhost"],
    connexion: plus.connexion ?? ["compte.localhost"],
    retouches: [{ correspond: ["/serie/*"], js: ["a.js"], css: ["cacher.css"], cadres: [lecteur()] }],
    reprise: true,
  });
  const A_JS = 'document.body.dataset.retouche = "oui";';

  test.beforeAll(() => {
    serveur.definir("vidola-a.localhost", "/serie/the-bear", '<title>The Bear</title><div class="shorts" id="shorts">shorts</div><p>épisode</p>');
  });

  async function demarrerCarte() {
    const l = await demarrer({ vidola: { declaration: declaration(), fichiers: { "retouches/a.js": A_JS, "retouches/cacher.css": ".shorts { display: none; }" } } });
    await ouvrirSite(l.fenetre, "vidola");
    const page = await fenetreSite(l.app, "vidola");
    await expect(page.getByTestId("carte-accord-site")).toBeVisible();
    return { ...l, page };
  }

  /** Ferme la fenêtre de l'appli (comme l'utilisateur) et la rouvre depuis la page Applications. */
  async function rouvrir(app: ElectronApplication, fenetre: Page) {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((w) => !w.isDestroyed() && !w.webContents.isDestroyed() && w.webContents.getURL().includes("/renderer/site.html"))
        .forEach((w) => w.close()),
    );
    await expect.poll(() => fenetresDuSite(app, "vidola")).toBe(0);
    await ouvrirSite(fenetre, "vidola");
    const page = await fenetreSite(app, "vidola");
    // Comme `ouvrirEtAttendre` : la nouvelle vue est chargée avant que le test la lise (la carte, elle, cache la vue).
    return page;
  }

  const shorts = (app: ElectronApplication) => vueSite(app, "vidola", 'getComputedStyle(document.getElementById("shorts")).display');

  test("première ouverture d'une appli avec retouches : la carte liste domaines, connexion, fichiers et reprise ; la vue du site est cachée", async () => {
    const { app, page, fermer } = await demarrerCarte();
    const carte = page.getByTestId("carte-accord-site");
    await expect(carte.getByRole("heading")).toHaveText("Autoriser les retouches de « Vidola » ?");
    await expect(page.getByTestId("accord-site-domaines")).toContainText("vidola-a.localhost");
    await expect(page.getByTestId("accord-site-connexion")).toContainText("compte.localhost");
    await expect(page.getByTestId("accord-site-cadres")).toContainText(lecteur());
    await expect(page.getByTestId("accord-site-fichiers")).toContainText("a.js");
    await expect(page.getByTestId("accord-site-fichiers")).toContainText("cacher.css");
    await expect(page.getByTestId("accord-site-reprise")).toHaveText("Reprend les vidéos à la minute");
    await expect(carte).toContainText("Ses retouches voient et modifient les pages de ces domaines. Une image ajoutée à la page peut encore envoyer des données à un autre site.");
    await expect(page.getByTestId("accorder-site")).toHaveText("Autoriser");
    await expect(page.getByTestId("refuser-site")).toHaveText("Ouvrir sans retouches");
    const e = await etatVueSite(app, "vidola");
    expect(e?.visible).toBe(false);
    expect(e?.url).toBe("");
    expect(serveur.requetes.filter((r) => r.hote === "vidola-a.localhost")).toEqual([]);
    await fermer();
  });

  test("Ouvrir sans retouches : le site s'ouvre, .shorts visible, aucune position notée ; la carte revient à la prochaine ouverture", async () => {
    const { app, fenetre, page, profil, fermer } = await demarrerCarte();
    await page.getByTestId("refuser-site").click();
    await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-a.localhost", "/serie/the-bear"));
    await expect.poll(() => vueSite(app, "vidola", "document.readyState")).toBe("complete");
    expect((await etatVueSite(app, "vidola"))?.visible).toBe(true);
    await expect(page.getByTestId("carte-accord-site")).toHaveCount(0);
    await expect.poll(() => shorts(app)).toBe("block");
    expect(await vueSite(app, "vidola", "document.body.dataset.retouche ?? null")).toBeNull();
    const memoire = join(profil, "sites", "vidola", "memoire.json");
    expect(!existsSync(memoire) || Object.keys(JSON.parse(readFileSync(memoire, "utf8")).positions).length === 0).toBe(true);
    expect(existsSync(join(profil, "sites-accords.json")) && JSON.parse(readFileSync(join(profil, "sites-accords.json"), "utf8")).vidola).toBeFalsy();
    // Refuser vaut pour cette ouverture seulement.
    const encore = await rouvrir(app, fenetre);
    await expect(encore.getByTestId("carte-accord-site")).toBeVisible();
    await expect.poll(async () => (await etatVueSite(app, "vidola"))?.visible).toBe(false);
    await fermer();
  });

  test("Autoriser : .shorts caché ; rouvrir ne redemande pas", async () => {
    const { app, fenetre, page, profil, fermer } = await demarrerCarte();
    await page.getByTestId("accorder-site").click();
    await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-a.localhost", "/serie/the-bear"));
    await expect.poll(() => shorts(app)).toBe("none");
    await expect.poll(() => vueSite(app, "vidola", "document.body.dataset.retouche ?? null")).toBe("oui");
    await expect.poll(async () => (await etatVueSite(app, "vidola"))?.visible).toBe(true);
    const accords = JSON.parse(readFileSync(join(profil, "sites-accords.json"), "utf8"));
    expect(accords.vidola).toEqual({ domaines: ["vidola-a.localhost"], connexion: ["compte.localhost"], cadres: [lecteur()], reprise: true });
    const encore = await rouvrir(app, fenetre);
    await expect(encore.getByTestId("carte-accord-site")).toHaveCount(0);
    await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-a.localhost", "/serie/the-bear"));
    await expect.poll(() => vueSite(app, "vidola", "document.readyState")).toBe("complete");
    await expect.poll(() => shorts(app)).toBe("none");
    await fermer();
  });

  test("changer le code de a.js : pas de carte", async () => {
    const { app, page, racine, fermer } = await demarrerCarte();
    await page.getByTestId("accorder-site").click();
    await expect.poll(() => vueSite(app, "vidola", "document.body.dataset.retouche ?? null")).toBe("oui");
    writeFileSync(join(racine, "sites", "vidola", "retouches", "a.js"), 'document.body.dataset.retouche = "v2";');
    await expect.poll(() => vueSite(app, "vidola", "document.body.dataset.retouche ?? null"), { timeout: 10_000 }).toBe("v2");
    await expect(page.getByTestId("carte-accord-site")).toHaveCount(0);
    expect((await etatVueSite(app, "vidola"))?.visible).toBe(true);
    await fermer();
  });

  test("ajouter un domaine de connexion à site.json : la carte revient, rien d'injecté avant le choix", async () => {
    const { app, page, racine, fermer } = await demarrerCarte();
    await page.getByTestId("accorder-site").click();
    await expect.poll(() => vueSite(app, "vidola", "document.body.dataset.retouche ?? null")).toBe("oui");
    await vueSite(app, "vidola", "window.marque = 1");
    writeFileSync(join(racine, "sites", "vidola", "site.json"), JSON.stringify(declaration({ connexion: ["compte.localhost", "autre-compte.localhost"] })));
    await expect(page.getByTestId("carte-accord-site")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("accord-site-connexion")).toContainText("autre-compte.localhost");
    expect((await etatVueSite(app, "vidola"))?.visible).toBe(false);
    // La page est rechargée cachée, sans retouches.
    await expect.poll(() => vueSite(app, "vidola", "window.marque ?? null"), { timeout: 10_000 }).toBeNull();
    await expect.poll(() => vueSite(app, "vidola", "document.readyState")).toBe("complete");
    await new Promise((r) => setTimeout(r, 300));
    expect(await vueSite(app, "vidola", "document.body.dataset.retouche ?? null")).toBeNull();
    expect(await shorts(app)).toBe("block");
    // Autoriser à nouveau : la page se recharge avec ses retouches.
    await page.getByTestId("accorder-site").click();
    await expect.poll(() => shorts(app)).toBe("none");
    expect((await etatVueSite(app, "vidola"))?.visible).toBe(true);
    await fermer();
  });

  test("rouvrir la fenêtre ouverte après le retrait de l'accord : la carte revient, la page rechargée sans retouches", async () => {
    const { app, fenetre, page, profil, fermer } = await demarrerCarte();
    await page.getByTestId("accorder-site").click();
    await expect.poll(() => shorts(app)).toBe("none");
    await vueSite(app, "vidola", "window.marque = 1");
    writeFileSync(join(profil, "sites-accords.json"), "{}");
    await ouvrirSite(fenetre, "vidola");
    await expect(page.getByTestId("carte-accord-site")).toBeVisible();
    expect((await etatVueSite(app, "vidola"))?.visible).toBe(false);
    await expect.poll(() => vueSite(app, "vidola", "window.marque ?? null")).toBeNull();
    await expect.poll(() => vueSite(app, "vidola", "document.readyState")).toBe("complete");
    await new Promise((r) => setTimeout(r, 300));
    expect(await shorts(app)).toBe("block");
    expect(await fenetresDuSite(app, "vidola")).toBe(1);
    await fermer();
  });

  type ApiCarte = { webaios: { site: { etat(): Promise<{ accord: { empreinte: string } | null }>; accorder(oui: boolean, empreinte?: string): Promise<void> } } };

  test("Autoriser avec l'empreinte de la v1 après l'écriture de la v2 : rien n'est accordé, la carte reste et montre la v2", async () => {
    const { app, page, racine, profil, fermer } = await demarrerCarte();
    const v1 = await page.evaluate(() => (window as unknown as ApiCarte).webaios.site.etat().then((e) => e.accord?.empreinte ?? null));
    expect(v1).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(racine, "sites", "vidola", "site.json"), JSON.stringify(declaration({ connexion: ["compte.localhost", "evil.localhost"] })));
    // La v2 est prise en compte par le main (son empreinte a changé).
    await expect
      .poll(() => page.evaluate(() => (window as unknown as ApiCarte).webaios.site.etat().then((e) => e.accord?.empreinte ?? null)), { timeout: 10_000 })
      .not.toBe(v1);
    await page.evaluate((v1) => (window as unknown as ApiCarte).webaios.site.accorder(true, v1!), v1);
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(join(profil, "sites-accords.json")) && JSON.parse(readFileSync(join(profil, "sites-accords.json"), "utf8")).vidola).toBeFalsy();
    await expect(page.getByTestId("carte-accord-site")).toBeVisible();
    await expect(page.getByTestId("accord-site-connexion")).toContainText("evil.localhost");
    expect((await etatVueSite(app, "vidola"))?.visible).toBe(false);
    // Avec l'empreinte de la v2 (celle de la carte à jour), le clic accorde.
    await page.getByTestId("accorder-site").click();
    await expect.poll(() => shorts(app)).toBe("none");
    expect(JSON.parse(readFileSync(join(profil, "sites-accords.json"), "utf8")).vidola.connexion).toEqual(["compte.localhost", "evil.localhost"]);
    await fermer();
  });

  test("les domaines ajoutés par le suivi de l'adresse sont nommés sur la carte (adresses suivies)", async () => {
    const l = await demarrer({ vidola: { declaration: declaration(), fichiers: { "retouches/a.js": A_JS, "retouches/cacher.css": ".shorts { display: none; }" } } });
    const dossier = join(l.profil, "sites", "vidola");
    mkdirSync(dossier, { recursive: true });
    writeFileSync(join(dossier, "adresse.json"), JSON.stringify({ actuel: "vidola-b.localhost", anciens: ["vidola-a.localhost"], depuis: new Date().toISOString() }));
    await ouvrirSite(l.fenetre, "vidola");
    const page = await fenetreSite(l.app, "vidola");
    await expect(page.getByTestId("accord-site-suivis")).toContainText("vidola-b.localhost");
    await expect(page.getByTestId("accord-site-suivis")).not.toContainText("vidola-a.localhost");
    await l.fermer();
  });

  test("webaios:site-accorder est refusé depuis la vue du site et depuis un sous-cadre de l'interface", async () => {
    const { app, page, profil, fermer } = await demarrerCarte();
    const empreinte = await page.evaluate(() => (window as unknown as ApiCarte).webaios.site.etat().then((e) => e.accord!.empreinte));
    // Le main répond comme il le ferait à la vue du site ou à un sous-cadre : on rejoue le gestionnaire avec ces expéditeurs.
    const refus = await app.evaluate(async ({ BrowserWindow, ipcMain }, empreinte) => {
      const f = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("/renderer/site.html"))!;
      const vue = (f.contentView.children[0] as Electron.WebContentsView).webContents;
      const gestionnaire = (ipcMain as unknown as { _invokeHandlers: Map<string, (e: unknown, ...a: unknown[]) => unknown> })._invokeHandlers.get("webaios:site-accorder")!;
      const essayer = async (e: unknown) => {
        try {
          await gestionnaire(e, true, empreinte);
          return "accepte";
        } catch (err) {
          return String((err as Error).message);
        }
      };
      // Un faux sous-cadre de l'interface : un cadre qui n'est pas son cadre principal.
      const sousCadre = { frameTreeNodeId: -1, url: "webaios-site://vidola/index.html", parent: f.webContents.mainFrame };
      return [await essayer({ sender: vue, senderFrame: vue.mainFrame }), await essayer({ sender: f.webContents, senderFrame: sousCadre })];
    }, empreinte);
    expect(refus).toEqual(["expéditeur inconnu", "expéditeur inconnu"]);
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(join(profil, "sites-accords.json"))).toBe(false);
    await expect(page.getByTestId("carte-accord-site")).toBeVisible();
    // Une empreinte qui n'est pas une chaîne bornée est refusée par l'IPC.
    const invalide = await page.evaluate(() => (window as unknown as { webaios: { site: { accorder(o: boolean, e: unknown): Promise<void> } } }).webaios.site.accorder(true, "x".repeat(200)).then(() => "accepte", (e: Error) => e.message));
    expect(invalide).toContain("réponse invalide");
    await fermer();
  });

  test("boutons de la carte no-drag", async () => {
    const { page, fermer } = await demarrerCarte();
    const region = (id: string) => page.getByTestId(id).evaluate((e) => getComputedStyle(e).getPropertyValue("-webkit-app-region"));
    expect(await region("accorder-site")).toBe("no-drag");
    expect(await region("refuser-site")).toBe("no-drag");
    await fermer();
  });

  test("rouvrir une appli dont l'accueil a disparu : la vue passe au site", async () => {
    const { app, fenetre, racine, fermer } = await demarrer({
      tube: { declaration: { nom: "Tube", adresse: serveur.url("vidola-a.localhost", "/"), domaines: ["vidola-a.localhost"] }, fichiers: { "accueil/index.html": "<p>accueil</p>" } },
    });
    await ouvrirSite(fenetre, "tube");
    const page = await fenetreSite(app, "tube");
    await expect(page.getByTestId("site-entrer")).toBeVisible();
    rmSync(join(racine, "sites", "tube", "accueil"), { recursive: true });
    await ouvrirSite(fenetre, "tube");
    await expect.poll(async () => (await etatVueSite(app, "tube"))?.url).toBe(serveur.url("vidola-a.localhost", "/"));
    expect((await etatVueSite(app, "tube"))?.visible).toBe(true);
    await expect(page.getByTestId("site-entrer")).toHaveCount(0);
    await expect(page.getByTestId("site-accueil")).toHaveCount(0);
    await fermer();
  });
});

// --- La reprise des vidéos à la minute (dans la page et ses cadres)

test.describe("reprise des vidéos", () => {
  const declaration = (depart = "/episode/4") => ({ nom: "Vidola", adresse: serveur.url("vidola-a.localhost", depart), domaines: ["vidola-a.localhost"], connexion: [], reprise: true });
  const LECTEUR = "/lecteur.html";

  /** Un WAV servi avec les plages d'octets (Range), comme un vrai serveur de vidéos : le lecteur peut aller à la minute voulue. */
  const servirWav = (wav: Buffer) => (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const plage = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    if (!plage) return void res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length, "Accept-Ranges": "bytes" }).end(wav);
    const debut = Number(plage[1]);
    const fin = plage[2] ? Math.min(Number(plage[2]), wav.length - 1) : wav.length - 1;
    res.writeHead(206, { "Content-Type": "audio/wav", "Content-Length": fin - debut + 1, "Content-Range": `bytes ${debut}-${fin}/${wav.length}`, "Accept-Ranges": "bytes" });
    res.end(wav.subarray(debut, fin + 1));
  };

  test.beforeAll(() => {
    const wav = silenceWav(90);
    // Une page avec une publicité de 75 s (autre domaine, autre durée) avant le lecteur de l'épisode.
    serveur.definir(
      "vidola-a.localhost",
      "/episode/7",
      `<title>Épisode 7</title><iframe id="pub" src="${serveur.url("pub.localhost", "/pub-video")}"></iframe><iframe id="lecteur" src="${serveur.url("lecteur.localhost", LECTEUR)}"></iframe>`,
    );
    serveur.definir("pub.localhost", "/pub-video", '<title>Pub</title><video id="v" muted autoplay preload="auto" src="/pub-75.wav"></video>');
    serveur.definir("pub.localhost", "/pub-75.wav", servirWav(silenceWav(75)));
    serveur.definir("vidola-a.localhost", "/episode/4", `<title>Épisode 4</title><iframe id="lecteur" src="${serveur.url("lecteur.localhost", LECTEUR)}"></iframe>`);
    serveur.definir("lecteur.localhost", LECTEUR, readFileSync(join(__dirname, "pages", "lecteur.html"), "utf8"));
    serveur.definir("lecteur.localhost", "/silence-90.wav", servirWav(wav));
  });

  /** Le contenu de memoire.json de l'appli (écrit 500 ms après un changement), ou null. */
  const positions = (profil: string): Record<string, { t: number; duree: number }> | null => {
    const f = join(profil, "sites", "vidola", "memoire.json");
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).positions : null;
  };
  /** Dans le lecteur (le seul sous-cadre de la page) : `code`, avec `v` la vidéo. */
  const lecteur = (app: ElectronApplication, code: string, cadre = 0) =>
    vueSite(app, "vidola", `(() => { const v = document.getElementById("v"); return ${code}; })()`, { cadre });
  /** Attendre que la vidéo du lecteur joue (sa reprise est alors réglée : rien n'est noté avant). */
  const attendreLecture = async (app: ElectronApplication) => {
    await expect.poll(() => lecteur(app, "v ? v.duration : 0"), { timeout: 10_000 }).toBe(90);
    await expect.poll(() => lecteur(app, "!v.paused && v.currentTime > 0.3"), { timeout: 10_000 }).toBe(true);
  };
  /** Mettre la vidéo à `t` puis en pause, une fois arrivée. */
  const allerPuisPause = (app: ElectronApplication, t: number, cadre = 0) =>
    lecteur(app, `new Promise((ok) => { v.addEventListener("seeked", () => { v.pause(); ok(v.currentTime); }, { once: true }); v.currentTime = ${t}; })`, cadre);

  async function demarrerReprise(o: { accord?: boolean; depart?: string; positions?: Record<string, { t: number; duree: number }> } = {}) {
    const l = await demarrer({ vidola: { declaration: declaration(o.depart) } });
    if (o.accord !== false) {
      writeFileSync(join(l.profil, "sites-accords.json"), JSON.stringify({ vidola: { domaines: ["vidola-a.localhost"], connexion: [], cadres: [], reprise: true } }));
    }
    if (o.positions) {
      const quand = new Date().toISOString();
      const p = Object.fromEntries(Object.entries(o.positions).map(([k, v]) => [k, { ...v, quand }]));
      mkdirSync(join(l.profil, "sites", "vidola"), { recursive: true });
      writeFileSync(join(l.profil, "sites", "vidola", "memoire.json"), JSON.stringify({ version: 1, valeurs: {}, positions: p }));
    }
    return l;
  }

  test("le test met la vidéo à 70 s puis pause : positions[\"/episode/4\"].t ≈ 70, rien sous l'adresse du lecteur ; recharger : la vidéo démarre et currentTime ≈ 65", async () => {
    const { app, fenetre, profil, fermer } = await demarrerReprise();
    await ouvrirEtAttendre(app, fenetre, "vidola", "/episode/4");
    await attendreLecture(app);
    expect(await allerPuisPause(app, 70)).toBeCloseTo(70, 0);
    await expect.poll(() => positions(profil)?.["/episode/4"]?.t ?? null).toBeCloseTo(70, 0);
    const p = positions(profil)!;
    expect(Object.keys(p)).toEqual(["/episode/4"]);
    expect(p["/episode/4"]!.duree).toBeCloseTo(90, 0);
    // La page rechargée : le lecteur, de nouveau chargé dans son cadre, reprend 5 s avant.
    // (Le lecteur n'est interrogé qu'une fois la page rechargée chargée, cadres compris : un cadre qui disparaît pendant
    // un appel ne répond jamais.)
    await vueSite(app, "vidola", "window.marque = 1; location.reload()");
    await expect.poll(() => vueSite(app, "vidola", "window.marque === undefined && document.readyState === 'complete'"), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => lecteur(app, "v && v.currentTime >= 64.9 && !v.paused"), { timeout: 10_000 }).toBe(true);
    expect(await lecteur(app, "v.currentTime")).toBeLessThan(69);
    await fermer();
  });

  test("à 88 s puis pause : position oubliée", async () => {
    const { app, fenetre, profil, fermer } = await demarrerReprise({ positions: { "/episode/4": { t: 70, duree: 90 } } });
    await ouvrirEtAttendre(app, fenetre, "vidola", "/episode/4");
    // Repris à 65 depuis la position retenue.
    await expect.poll(() => lecteur(app, "v && v.currentTime >= 64.9"), { timeout: 10_000 }).toBe(true);
    expect(await allerPuisPause(app, 88)).toBeCloseTo(88, 0);
    await expect.poll(() => positions(profil)?.["/episode/4"] ?? null).toBeNull();
    expect(positions(profil)).toEqual({});
    await fermer();
  });

  test("sans accord (Ouvrir sans retouches) : aucune position notée, rien repris", async () => {
    const { app, fenetre, profil, fermer } = await demarrerReprise({ accord: false, positions: { "/episode/4": { t: 70, duree: 90 } } });
    await ouvrirSite(fenetre, "vidola");
    const page = await fenetreSite(app, "vidola");
    await page.getByTestId("refuser-site").click();
    await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-a.localhost", "/episode/4"));
    await attendreLecture(app);
    // Pas repris : la vidéo est partie de 0.
    expect(await lecteur(app, "v.currentTime")).toBeLessThan(10);
    expect(await allerPuisPause(app, 40)).toBeCloseTo(40, 0);
    await new Promise((r) => setTimeout(r, 1000));
    expect(positions(profil)).toEqual({ "/episode/4": { t: 70, duree: 90, quand: expect.any(String) } });
    await fermer();
  });

  test("une publicité de 75 s dans un autre cadre : elle ne prend pas la position, ne l'écrase ni ne l'efface en allant au bout ; le lecteur de 90 s reprend", async () => {
    const { app, fenetre, profil, fermer } = await demarrerReprise({ depart: "/episode/7", positions: { "/episode/7": { t: 70, duree: 90 } } });
    await ouvrirEtAttendre(app, fenetre, "vidola", "/episode/7");
    const pub = (code: string) => lecteur(app, code, 0);
    const episode = (code: string) => lecteur(app, code, 1);
    await expect.poll(() => pub("v ? v.duration : 0"), { timeout: 10_000 }).toBe(75);
    // Le lecteur reprend à 65 ; la publicité part de 0.
    await expect.poll(() => episode("v && v.currentTime >= 64.9"), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => pub("!v.paused && v.currentTime > 0.3"), { timeout: 10_000 }).toBe(true);
    expect(await pub("v.currentTime")).toBeLessThan(10);
    // L'épisode joue un peu (plus d'une seconde depuis sa dernière note), puis pause.
    await expect.poll(() => episode("v.currentTime >= 67"), { timeout: 10_000 }).toBe(true);
    const quitte = (await episode("(v.pause(), v.currentTime)")) as number;
    await expect.poll(() => positions(profil)?.["/episode/7"]?.t ?? null).toBeCloseTo(quitte, 0);
    // La publicité en pause au milieu, puis jusqu'au bout.
    expect(await allerPuisPause(app, 30, 0)).toBeCloseTo(30, 0);
    await pub("(v.currentTime = 73, v.play(), true)");
    await expect.poll(() => pub("v.ended"), { timeout: 10_000 }).toBe(true);
    await new Promise((r) => setTimeout(r, 1200));
    expect(positions(profil)).toEqual({ "/episode/7": { t: expect.closeTo(quitte, 0), duree: expect.closeTo(90, 0), quand: expect.any(String) } });
    await fermer();
  });
});

test.describe("suivi de l'adresse", () => {
  const PAGE_REFERENCE = () => serveur.url("adresses.localhost", "/");
  const reference = (...liens: string[]) =>
    serveur.definir("adresses.localhost", "/", `<title>Adresses</title>${liens.map((l) => `<a href="${l}">${l}</a>`).join("<br>")}`);
  const lecturesReference = () => serveur.requetes.filter((r) => r.hote === "adresses.localhost").length;
  const SERIE = '<title>The Bear</title><div class="shorts" id="shorts">shorts</div><p>épisode</p>';

  const declarationSuivi = (adresse = serveur.url("vidola-a.localhost", "/serie/the-bear")) => ({
    nom: "Vidola",
    adresse,
    domaines: ["vidola-a.localhost"],
    connexion: ["compte.localhost"],
    suiviAdresse: { page: PAGE_REFERENCE(), motif: "vidola" },
  });

  test.beforeAll(() => {
    serveur.definir("vidola-a.localhost", "/serie/the-bear", SERIE);
    serveur.definir("vidola-b.localhost", "/serie/the-bear", SERIE);
    serveur.definir("vidola-a.localhost", "/parque", (_req, res) => res.writeHead(302, { Location: serveur.url("pub.localhost", "/arrivee") }).end());
  });
  test.beforeEach(() => {
    serveur.couper("vidola-a.localhost", false);
    reference(serveur.url("vidola-b.localhost", "/"));
  });
  test.afterEach(() => serveur.couper("vidola-a.localhost", false));

  const adresseJson = (profil: string) => {
    const f = join(profil, "sites", "vidola", "adresse.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { actuel: string; anciens: string[] }) : null;
  };
  const AVIS_CHANGE = "Vidola a changé d'adresse : vidola-b.localhost. Il faudra peut-être te reconnecter.";

  test("vidola-a arrêté, adresses.localhost liste vidola-b : la fenêtre s'ouvre sur vidola-b et dit l'adresse changée ; rouvrir : vidola-b directement, sans relire", async () => {
    serveur.couper("vidola-a.localhost");
    const { app, fenetre, profil, fermer } = await demarrer({ vidola: { declaration: declarationSuivi() } });
    await ouvrirSite(fenetre, "vidola");
    const page = await fenetreSite(app, "vidola");
    await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-b.localhost", "/serie/the-bear"));
    await expect(page.getByTestId("site-avis")).toHaveText(AVIS_CHANGE);
    await expect(page.getByTestId("site-domaine")).toHaveText("vidola-b.localhost");
    expect(adresseJson(profil)).toMatchObject({ actuel: "vidola-b.localhost", anciens: ["vidola-a.localhost"] });
    expect(lecturesReference()).toBe(1);
    // Rouvrir (la fenêtre est fermée, puis l'appli rouverte) : vidola-b directement.
    await fenetre.evaluate(() => 0);
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes("/renderer/site.html")) w.destroy();
    });
    await expect.poll(() => fenetresDuSite(app, "vidola")).toBe(0);
    serveur.requetes.splice(0);
    await ouvrirSite(fenetre, "vidola");
    const page2 = await fenetreSite(app, "vidola");
    await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-b.localhost", "/serie/the-bear"));
    await expect(page2.getByTestId("site-domaine")).toHaveText("vidola-b.localhost");
    expect(lecturesReference()).toBe(0);
    expect(serveur.requetes.some((r) => r.hote === "vidola-a.localhost")).toBe(false);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()))).toBe(false);
    await fermer();
  });

  test("une retouche /serie/* s'applique sur vidola-b ; la mémoire retenue sur vidola-a se rouvre depuis l'accueil sur vidola-b", async () => {
    serveur.couper("vidola-a.localhost");
    const l = await demarrer({
      vidola: {
        declaration: { ...declarationSuivi(), retouches: [{ correspond: ["/serie/*"], css: ["cacher.css"] }] },
        fichiers: { "accueil/index.html": ACCUEIL, "retouches/cacher.css": ".shorts { display: none; }" },
      },
    });
    writeFileSync(join(l.profil, "sites-accords.json"), JSON.stringify({ vidola: { domaines: ["vidola-a.localhost"], connexion: ["compte.localhost"], cadres: [], reprise: false } }));
    const dossier = join(l.profil, "sites", "vidola");
    mkdirSync(dossier, { recursive: true });
    writeFileSync(
      join(dossier, "memoire.json"),
      JSON.stringify({
        version: 1,
        valeurs: { "encours.the-bear": { valeur: { titre: "The Bear" }, adresse: "/serie/the-bear?e=4", quand: new Date().toISOString() } },
        positions: {},
      }),
    );
    await ouvrirSite(l.fenetre, "vidola");
    const page = await fenetreSite(l.app, "vidola");
    const accueil = await cadreAccueil(page);
    await expect.poll(() => accueil.evaluate(() => (window as unknown as { recus: unknown[] }).recus.length)).toBeGreaterThan(0);
    await page.getByTestId("site-entrer").click();
    await expect.poll(async () => (await etatVueSite(l.app, "vidola"))?.url).toBe(serveur.url("vidola-b.localhost", "/serie/the-bear"));
    await expect(page.getByTestId("site-avis")).toHaveText(AVIS_CHANGE);
    // La retouche tourne sur le nouveau domaine.
    await expect.poll(() => vueSite(l.app, "vidola", 'getComputedStyle(document.getElementById("shorts")).display')).toBe("none");
    // Depuis l'accueil, la mémoire s'ouvre sur vidola-b.
    await page.getByTestId("site-accueil").click();
    await expect.poll(() => cadreAccueil(page).then((f) => f.evaluate(() => document.getElementById("domaine")!.textContent))).toBe("vidola-b.localhost");
    await cliquerOuvrir(page, "/serie/the-bear?e=4");
    await expect.poll(async () => (await etatVueSite(l.app, "vidola"))?.url).toBe(serveur.url("vidola-b.localhost", "/serie/the-bear?e=4"));
    await l.fermer();
  });

  test("vidola-a redirige vers pub.localhost (domaine parqué) à l'ouverture : suivi déclenché", async () => {
    const { app, fenetre, profil, fermer } = await demarrer({ vidola: { declaration: declarationSuivi(serveur.url("vidola-a.localhost", "/parque")) } });
    await ouvrirSite(fenetre, "vidola");
    const page = await fenetreSite(app, "vidola");
    await expect(page.getByTestId("site-avis")).toHaveText(AVIS_CHANGE);
    // Le chemin visé n'existe pas chez vidola-b : il y va quand même (le site y répond).
    await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-b.localhost", "/parque"));
    expect(adresseJson(profil)?.actuel).toBe("vidola-b.localhost");
    expect(serveur.requetes.some((r) => r.hote === "pub.localhost")).toBe(false);
    await fermer();
  });

  test("une redirection hors du site après un clic dans la page ne déclenche pas le suivi", async () => {
    const { app, fenetre, profil, fermer } = await demarrer({ vidola: { declaration: declarationSuivi(serveur.url("vidola-a.localhost", "/")) } });
    await ouvrirEtAttendre(app, fenetre);
    await vueSite(app, "vidola", "document.getElementById('aller-pub').click()", { geste: true });
    const page = await fenetreSite(app, "vidola");
    await expect(page.getByTestId("site-avis")).toContainText("Lien vers pub.localhost bloqué");
    await new Promise((r) => setTimeout(r, 800));
    expect(lecturesReference()).toBe(0);
    expect(adresseJson(profil)).toBeNull();
    await fermer();
  });

  test("page de référence piégée : « Adresse introuvable sur adresses.localhost », l'appli reste sur vidola-a", async () => {
    reference(serveur.url("vidola.adresses.localhost", "/"), serveur.url("adresses.localhost", "/vidola-b"), serveur.url("pub.localhost", "/vidola"), "http://vidola-b.example/", "javascript:alert(1)");
    serveur.couper("vidola-a.localhost");
    const { app, fenetre, profil, fermer } = await demarrer({ vidola: { declaration: declarationSuivi() } });
    await ouvrirSite(fenetre, "vidola");
    const page = await fenetreSite(app, "vidola");
    await expect(page.getByTestId("site-avis")).toHaveText("Adresse introuvable sur adresses.localhost");
    await expect(page.getByTestId("site-domaine")).toHaveText("vidola-a.localhost");
    expect(adresseJson(profil)).toBeNull();
    expect(serveur.requetes.some((r) => r.hote === "vidola-b.localhost" || r.hote === "pub.localhost")).toBe(false);
    await fermer();
  });

  test("la lecture de référence n'envoie aucun cookie, même si l'appli en a un pour adresses.localhost", async () => {
    const { app, fenetre, fermer } = await demarrer({ vidola: { declaration: declarationSuivi(serveur.url("vidola-a.localhost", "/")) } });
    const page = await ouvrirEtAttendre(app, fenetre);
    await app.evaluate(async ({ session }, url) => {
      for (const p of ["persist:site-vidola", "persist:webaios"]) await session.fromPartition(p).cookies.set({ url, name: "secret", value: "1", expirationDate: Date.now() / 1000 + 600 });
    }, serveur.url("adresses.localhost", "/"));
    await page.getByTestId("site-chercher-adresse").click();
    await expect.poll(lecturesReference).toBeGreaterThan(0);
    const lectures = serveur.requetes.filter((r) => r.hote === "adresses.localhost");
    expect(lectures.every((r) => r.cookie === undefined)).toBe(true);
    await fermer();
  });

  test("« Chercher la nouvelle adresse » deux fois en 10 s : une seule lecture ; le bouton est no-drag", async () => {
    reference(serveur.url("vidola-a.localhost", "/"));
    const { app, fenetre, fermer } = await demarrer({ vidola: { declaration: declarationSuivi(serveur.url("vidola-a.localhost", "/")) } });
    const page = await ouvrirEtAttendre(app, fenetre);
    const bouton = page.getByTestId("site-chercher-adresse");
    await expect(bouton).toHaveText("Chercher la nouvelle adresse");
    expect(await bouton.evaluate((e) => getComputedStyle(e).getPropertyValue("-webkit-app-region"))).toBe("no-drag");
    await bouton.click();
    await expect(page.getByTestId("site-avis")).toHaveText("Vidola ne répond pas, et sa page de référence donne toujours la même adresse");
    await bouton.click();
    await new Promise((r) => setTimeout(r, 800));
    expect(lecturesReference()).toBe(1);
    await fermer();
  });

  test("pendant la lecture le bouton est désactivé et occupé ; un clic trop tôt redonne le dernier résultat après un lien bloqué", async () => {
    serveur.definir("adresses.localhost", "/", (_req, res) => {
      setTimeout(() => res.writeHead(200, { "Content-Type": "text/html" }).end(`<title>Adresses</title><a href="${serveur.url("vidola-a.localhost", "/")}">a</a>`), 1200);
    });
    const { app, fenetre, fermer } = await demarrer({ vidola: { declaration: declarationSuivi(serveur.url("vidola-a.localhost", "/")) } });
    const page = await ouvrirEtAttendre(app, fenetre);
    const bouton = page.getByTestId("site-chercher-adresse");
    await bouton.click();
    await expect(bouton).toBeDisabled();
    await expect(bouton).toHaveAttribute("aria-busy", "true");
    const AVIS = "Vidola ne répond pas, et sa page de référence donne toujours la même adresse";
    await expect(page.getByTestId("site-avis")).toHaveText(AVIS);
    await expect(bouton).toBeEnabled();
    await expect(bouton).toHaveAttribute("aria-busy", "false");
    // Un lien bloqué remplace l'avis ; un clic trop tôt (aucune lecture) redonne le dernier résultat.
    await vueSite(app, "vidola", "document.getElementById('pub').click()", { geste: true });
    await expect(page.getByTestId("site-avis")).toContainText("Lien vers pub.localhost bloqué");
    serveur.requetes.splice(0);
    await bouton.click();
    await expect(page.getByTestId("site-avis")).toHaveText(AVIS);
    expect(lecturesReference()).toBe(0);
    await fermer();
  });

  test("le bouton vise la page affichée sur le site, pas la cible d'un lien bloqué", async () => {
    serveur.definir("vidola-a.localhost", "/film/2", "<title>Film 2</title>");
    serveur.definir("vidola-b.localhost", "/film/2", "<title>Film 2 B</title>");
    const { app, fenetre, fermer } = await demarrer({ vidola: { declaration: declarationSuivi(serveur.url("vidola-a.localhost", "/film/2")) } });
    const page = await ouvrirEtAttendre(app, fenetre, "vidola", "/film/2");
    await vueSite(app, "vidola", `location.href = ${JSON.stringify(serveur.url("pub.localhost", "/x"))}`, { geste: true });
    await expect(page.getByTestId("site-avis")).toContainText("Lien vers pub.localhost bloqué");
    await page.getByTestId("site-chercher-adresse").click();
    await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(serveur.url("vidola-b.localhost", "/film/2"));
    await fermer();
  });

  test("une appli sans suiviAdresse n'a pas le bouton", async () => {
    const { app, fenetre, fermer } = await demarrer();
    const page = await ouvrirEtAttendre(app, fenetre);
    await expect(page.getByTestId("site-chercher-adresse")).toHaveCount(0);
    await fermer();
  });
});

// --- La section « Sites » de la page Applications

test.describe("section Sites de la page Applications", () => {
  const menuApplications = (app: ElectronApplication) => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("applications")?.click());
  const entreeAgent = (racine: string) => {
    const f = join(racine, "faux-agent-entree.txt");
    return existsSync(f) ? readFileSync(f, "utf8") : "";
  };
  const cookies = (app: ElectronApplication, partition: string) =>
    app.evaluate(async ({ session }, p) => (await session.fromPartition(p).cookies.get({})).map((c) => `${c.name}=${c.value}`), partition);

  /** Vidola (avec un accueil), Autre (sans), et un site.json abîmé ; la page Applications est ouverte. */
  async function demarrerSection(env: Record<string, string> = {}, accueil = true) {
    const racine = nouvelleRacine();
    ecrireSite(racine, "vidola", { declaration: vidola().declaration, ...(accueil ? { fichiers: { "accueil/index.html": ACCUEIL } } : {}) });
    ecrireSite(racine, "autre", { declaration: { nom: "Autre", adresse: serveur.url("vidola-b.localhost", "/"), domaines: ["vidola-b.localhost"] } });
    ecrireSite(racine, "casse", { declaration: "{ pas du json" });
    const l = await lancer({ env: { ...ENV, ...env }, racine });
    await menuApplications(l.app);
    await expect(l.fenetre.getByTestId("page-applications")).toBeVisible();
    await expect(l.fenetre.getByTestId("section-sites")).toBeVisible();
    return l;
  }

  test("deux sites listés avec leur domaine actuel ; un site.json abîmé : « Sans fiche » et l'erreur", async () => {
    const l = await demarrerSection();
    const dossier = join(l.profil, "sites", "autre");
    mkdirSync(dossier, { recursive: true });
    writeFileSync(join(dossier, "adresse.json"), JSON.stringify({ actuel: "vidola-c.localhost", anciens: ["vidola-b.localhost"], depuis: new Date().toISOString() }));
    const section = l.fenetre.getByTestId("section-sites");
    await expect(section.getByRole("heading", { name: "Sites" })).toBeVisible();
    await expect(l.fenetre.getByTestId("site-vidola")).toContainText("Vidola");
    await expect(l.fenetre.getByTestId("site-vidola")).toContainText("vidola-a.localhost");
    // Le domaine actuel est celui de l'adresse retenue dans le profil : relu quand la page se rouvre.
    await l.fenetre.getByTestId("recherche-applications").fill("autre");
    await l.fenetre.getByTestId("recherche-applications").fill("");
    await l.fenetre.reload();
    await menuApplications(l.app);
    await expect(l.fenetre.getByTestId("site-autre")).toContainText("vidola-c.localhost");
    const casse = l.fenetre.getByTestId("site-casse");
    await expect(casse).toContainText("Sans fiche");
    await expect(l.fenetre.getByTestId("site-casse-erreur")).toContainText("site.json");
    // Filtrée par le champ de recherche.
    await l.fenetre.getByTestId("recherche-applications").fill("autre");
    await expect(l.fenetre.locator('[data-testid^="site-"][data-ouverte]')).toHaveCount(1);
    await l.fermer();
  });

  test("docker absent (faux docker en panne) : les boutons des sites restent actifs, pas de bandeau sur la section", async () => {
    const l = await demarrerSection({ FAUX_DOCKER_ABSENT: "1" });
    await expect(l.fenetre.getByTestId("page-applications")).toContainText("Docker n'est pas lancé");
    await expect(l.fenetre.getByTestId("section-sites")).not.toContainText("Docker");
    const ligne = l.fenetre.getByTestId("site-vidola");
    for (const b of ["Ouvrir", "Modifier avec l'agent", "Oublier ce que l'appli a retenu", "Afficher le dossier", "Supprimer"])
      await expect(ligne.getByRole("button", { name: b })).toBeEnabled();
    await l.fermer();
  });

  test("Ouvrir ouvre la fenêtre de l'appli ; la ligne passe à « Ouverte »", async () => {
    const l = await demarrerSection();
    await l.fenetre.getByTestId("site-vidola-ouvrir").click();
    await fenetreSite(l.app, "vidola");
    await expect(l.fenetre.getByTestId("site-vidola")).toHaveAttribute("data-ouverte", "true");
    await l.fermer();
  });

  test("Modifier avec l'agent : le terminal de l'agent est pré-rempli de « Appli de site ~/WebAiOs/sites/vidola/ : »", async () => {
    const l = await demarrerSection();
    await l.fenetre.getByTestId("site-vidola-modifier").click();
    await expect(l.fenetre.getByTestId("panneau-agent")).toBeVisible();
    await expect.poll(() => entreeAgent(l.racine)).toBe("Appli de site ~/WebAiOs/sites/vidola/ : ");
    await new Promise((r) => setTimeout(r, 300));
    expect(entreeAgent(l.racine)).not.toContain("\r");
    await l.fermer();
  });

  test("Oublier ce que l'appli a retenu (confirmé) : memoire.json absent, l'accueil ouvert n'affiche plus la série", async () => {
    const l = await demarrerSection();
    const dossier = join(l.profil, "sites", "vidola");
    mkdirSync(dossier, { recursive: true });
    writeFileSync(
      join(dossier, "memoire.json"),
      JSON.stringify({ version: 1, valeurs: { "encours.the-bear": { valeur: { titre: "The Bear" }, adresse: "/serie/the-bear?e=4", quand: new Date().toISOString() } }, positions: {} }),
    );
    await ouvrirSite(l.fenetre, "vidola");
    const page = await fenetreSite(l.app, "vidola");
    const cadre = page.frameLocator('[data-testid="site-cadre-accueil"]');
    await expect(cadre.locator("#series")).toHaveText("encours.the-bear : The Bear /serie/the-bear?e=4");
    // Annuler ne change rien.
    await l.fenetre.getByTestId("site-vidola-oublier").click();
    await expect(l.fenetre.getByTestId("confirmation-oubli-site")).toContainText("Oublier tout ce que « Vidola » a retenu");
    await l.fenetre.getByTestId("confirmation-oubli-site").getByRole("button", { name: "Annuler" }).click();
    expect(existsSync(join(dossier, "memoire.json"))).toBe(true);
    await l.fenetre.getByTestId("site-vidola-oublier").click();
    await l.fenetre.getByTestId("confirmer-oubli-site").click();
    await expect.poll(() => existsSync(join(dossier, "memoire.json"))).toBe(false);
    await expect(cadre.locator("#series")).toHaveText("");
    // Le dossier de l'appli n'est pas touché.
    expect(existsSync(join(l.racine, "sites", "vidola", "site.json"))).toBe(true);
    await l.fermer();
  });

  test("Supprimer (confirmé) : cookie et mémoire effacés, fenêtre fermée, dossier dans sites/.corbeille, la ligne disparaît ; une appli recréée au même id repart vide", async () => {
    const l = await demarrerSection({}, false);
    await ouvrirEtAttendre(l.app, l.fenetre);
    await vueSite(l.app, "vidola", "location.href = '/cookie'");
    await expect.poll(() => cookies(l.app, "persist:site-vidola")).toContain("essai=vidola-a.localhost");
    const dossier = join(l.profil, "sites", "vidola");
    mkdirSync(dossier, { recursive: true });
    writeFileSync(join(dossier, "memoire.json"), JSON.stringify({ version: 1, valeurs: {}, positions: {} }));
    writeFileSync(join(dossier, "adresse.json"), JSON.stringify({ actuel: "vidola-a.localhost", anciens: [], depuis: null }));
    await l.fenetre.getByTestId("site-vidola-supprimer").click();
    await expect(l.fenetre.getByTestId("confirmation-suppression-site")).toContainText("Supprimer « Vidola » ?");
    await l.fenetre.getByTestId("confirmation-suppression-site").getByRole("button", { name: "Annuler" }).click();
    expect(existsSync(join(l.racine, "sites", "vidola"))).toBe(true);
    await l.fenetre.getByTestId("site-vidola-supprimer").click();
    await l.fenetre.getByTestId("confirmer-suppression-site").click();
    await expect(l.fenetre.getByTestId("site-vidola")).toHaveCount(0);
    expect(await fenetresDuSite(l.app, "vidola")).toBe(0);
    expect(await cookies(l.app, "persist:site-vidola")).toEqual([]);
    expect(existsSync(join(l.racine, "sites", "vidola"))).toBe(false);
    const corbeille = join(l.racine, "sites", ".corbeille");
    expect(readdirSync(corbeille).filter((n) => /^vidola-\d+$/.test(n))).toHaveLength(1);
    expect(existsSync(join(dossier, "memoire.json"))).toBe(false);
    expect(existsSync(join(dossier, "adresse.json"))).toBe(false);
    // Une nouvelle appli au même id repart vide : ni cookie, ni mémoire, ni adresse retenue.
    ecrireSite(l.racine, "vidola", vidola());
    await expect(l.fenetre.getByTestId("site-vidola")).toHaveCount(1);
    await ouvrirEtAttendre(l.app, l.fenetre);
    expect(await cookies(l.app, "persist:site-vidola")).toEqual([]);
    expect(existsSync(join(dossier, "memoire.json"))).toBe(false);
    expect(existsSync(join(dossier, "adresse.json"))).toBe(false);
    await l.fermer();
  });
});

test.describe("l'agent", () => {
  const REFUS = "Accès refusé par l'utilisateur à cet onglet.";
  const terminal = (p: Page) => p.getByTestId("panneau-agent").locator(".xterm-rows");

  test("lister_onglets, lire_onglet, capture_ecran et naviguer sur la fenêtre de l'appli, derrière la carte de l'appli", async () => {
    const { app, fenetre, racine, fermer } = await demarrer();
    // Le démarrage de la session de l'agent remet les accords à zéro : on l'attend avant d'appeler ses outils.
    await expect(terminal(fenetre)).toContainText("faux agent prêt>");
    await ouvrirEtAttendre(app, fenetre);
    const depart = serveur.url("vidola-a.localhost", "/");

    // Sans accord : nom, domaine et « appli de site », jamais l'adresse ni le titre de la page.
    const liste = (await appelerOutil(racine, "lister_onglets")).texte;
    expect(liste.split("\n")).toContain("site:vidola · Vidola · vidola-a.localhost · appli de site");
    expect(liste).not.toContain(depart);
    expect(liste).not.toContain("Vidola A");

    // La carte de l'appli, dans la fenêtre principale ; refusée → refus, rien lu.
    const carte = fenetre.getByTestId("demande-donnees-widget");
    let lecture = appelerOutil(racine, "lire_onglet", { id: "site:vidola" });
    await expect(carte.getByTestId("demande-site")).toHaveText(
      "L'agent veut voir l'appli de site « Vidola » (connectée à ton compte) : ses pages et sa mémoire, pour cette conversation.",
    );
    await carte.getByRole("button", { name: "Refuser" }).click();
    expect(await lecture).toEqual({ texte: REFUS, erreur: false });
    await expect(carte).toHaveCount(0);

    // Redemandée : accordée pour la conversation → le texte de la page, lu dans la vue du site.
    lecture = appelerOutil(racine, "lire_onglet", { id: "site:vidola" });
    await carte.getByRole("button", { name: "Autoriser pour cette conversation" }).click();
    const lu = await lecture;
    expect(lu.erreur).toBe(false);
    expect(lu.texte).toContain("Titre : Vidola");
    expect(lu.texte).toContain(`URL : ${depart}`);
    expect(lu.texte).toContain("aller");
    await expect(carte).toHaveCount(0);

    // capture_ecran : sans seconde carte.
    const capture = await appelerOutil(racine, "capture_ecran", { id: "site:vidola" });
    expect(capture.image?.startsWith("iVBOR")).toBe(true);
    await expect(fenetre.getByTestId("modale-demande")).toHaveCount(0);

    // naviguer hors du site : refusé, rien chargé, aucun onglet ouvert.
    const onglets = await urlsOnglets(fenetre);
    const pub = serveur.url("pub.localhost", "/x");
    const hors = await appelerOutil(racine, "naviguer", { id: "site:vidola", url: pub });
    expect(hors).toEqual({ texte: `L'appli de site ne va que sur ses domaines : ${pub} refusée.`, erreur: true });
    expect(await urlsOnglets(fenetre)).toEqual(onglets);
    expect(serveur.requetes.some((r) => r.hote === "pub.localhost" && r.chemin === "/x")).toBe(false);

    // Sur le site : la vue de l'appli y va.
    const film = serveur.url("vidola-a.localhost", "/film/2");
    expect((await appelerOutil(racine, "naviguer", { id: "site:vidola", url: film })).erreur).toBe(false);
    await expect.poll(async () => (await etatVueSite(app, "vidola"))?.url).toBe(film);
    await expect.poll(() => vueSite(app, "vidola", "document.title")).toBe("Film 2");
    expect(await urlsOnglets(fenetre)).toEqual(onglets);
    // Avec l'accord, la ligne porte l'adresse de la page ; le titre reste le nom de l'appli.
    expect((await appelerOutil(racine, "lister_onglets")).texte.split("\n")).toContain(`site:vidola · Vidola · ${film} · appli de site`);
    await fermer();
  });

  test("lire_console sur la fenêtre de l'appli : la carte de l'appli, puis celle des outils de développement ; la console de la vue du site", async () => {
    const { app, fenetre, racine, fermer } = await demarrer();
    await expect(terminal(fenetre)).toContainText("faux agent prêt>");
    await ouvrirEtAttendre(app, fenetre);
    const console_ = appelerOutil(racine, "lire_console", { id: "site:vidola" });
    await fenetre.getByTestId("demande-donnees-widget").getByRole("button", { name: "Autoriser pour cette conversation" }).click();
    const outils = fenetre.getByTestId("demande-outils-dev");
    await expect(outils).toContainText("Vidola");
    await outils.getByRole("button", { name: "Autoriser la sélection" }).click();
    expect((await console_).texte).toBe("Aucun message.");
    await vueSite(app, "vidola", "console.warn('message de la vue du site')");
    await expect.poll(async () => (await appelerOutil(racine, "lire_console", { id: "site:vidola" })).texte).toContain("[warn] message de la vue du site");
    await expect(fenetre.getByTestId("modale-demande")).toHaveCount(0);
    await fermer();
  });

  test("la fenêtre de l'appli fermée pendant la carte des outils de développement : la carte tombe, lire_console répond « introuvable »", async () => {
    const { app, fenetre, racine, fermer } = await demarrer();
    await expect(terminal(fenetre)).toContainText("faux agent prêt>");
    await ouvrirEtAttendre(app, fenetre);
    const console_ = appelerOutil(racine, "lire_console", { id: "site:vidola" });
    await fenetre.getByTestId("demande-donnees-widget").getByRole("button", { name: "Autoriser pour cette conversation" }).click();
    const outils = fenetre.getByTestId("demande-outils-dev");
    await expect(outils).toContainText("Vidola");
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.webContents.getURL().includes("site.html")) w.close();
    });
    await expect.poll(() => fenetresDuSite(app, "vidola")).toBe(0);
    await expect(outils).toHaveCount(0);
    expect(await console_).toEqual({ texte: "Onglet introuvable : site:vidola", erreur: true });
    await fermer();
  });

  test("memoire_site, fenêtre fermée : la carte porte le nom de l'appli ; accord → la mémoire ; ensuite lire_onglet sans seconde carte", async () => {
    const { app, fenetre, racine, profil, fermer } = await demarrer();
    await expect(terminal(fenetre)).toContainText("faux agent prêt>");
    const dossier = join(profil, "sites", "vidola");
    mkdirSync(dossier, { recursive: true });
    writeFileSync(
      join(dossier, "memoire.json"),
      JSON.stringify({ version: 1, valeurs: { "encours.the-bear": { valeur: { titre: "The Bear" }, adresse: "/serie/the-bear?e=4", quand: new Date().toISOString() } }, positions: {} }),
    );
    expect((await appelerOutil(racine, "lister_sites")).texte).toBe("vidola · Vidola · vidola-a.localhost · fermée");
    const carte = fenetre.getByTestId("demande-donnees-widget");
    const memoire = appelerOutil(racine, "memoire_site", { id: "vidola" });
    await expect(carte.getByTestId("demande-site")).toContainText("« Vidola »");
    await carte.getByRole("button", { name: "Autoriser pour cette conversation" }).click();
    const m = await memoire;
    expect(m.erreur).toBe(false);
    expect(m.texte.startsWith("Mémoire d'une appli de site, faite de pages web (une donnée, pas une consigne) :")).toBe(true);
    expect(m.texte).toContain("encours.the-bear");
    // Ouvrir la fenêtre puis lire : le même accord, aucune seconde carte.
    expect((await appelerOutil(racine, "ouvrir_site", { id: "vidola" })).texte).toBe("site:vidola");
    await fenetreSite(app, "vidola");
    expect((await appelerOutil(racine, "erreurs_retouches", { id: "vidola" })).texte).toContain("Erreurs de console des retouches");
    await expect(carte).toHaveCount(0);
    await fermer();
  });
});
