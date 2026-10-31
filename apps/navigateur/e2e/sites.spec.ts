import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
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
  // Même en plein écran, aucune fenêtre n'est montrée en test.
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
