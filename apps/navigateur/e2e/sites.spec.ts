import { expect, test, type ElectronApplication, type Frame, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ecrireSite, etatVueSite, fenetreSite, lancer, lireNotifications, nombreWebContents, serveurSites, vueSite } from "./aide";

/** Les hôtes de test `*.localhost` sont permis (http compris) ; jamais une vraie adresse. */
const ENV = { WEBAIOS_TEST_ADRESSES_LOCALES: "1" };
const BARRE = 36;

let serveur: Awaited<ReturnType<typeof serveurSites>>;

/** 3 s de silence en WAV (8 kHz, 8 bits, mono) : de quoi jouer sans geste. */
function silenceWav(): Buffer {
  const n = 8000 * 3;
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
        const u = w.webContents.getURL();
        return u.includes("/renderer/site.html") && new URL(u).searchParams.get("id") === id;
      }).length,
    id,
  );

async function demarrer(sites: Record<string, Parameters<typeof ecrireSite>[2]> = { vidola: vidola() }) {
  const l = await lancer({ env: ENV });
  for (const [id, s] of Object.entries(sites)) ecrireSite(l.racine, id, s);
  return l;
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
