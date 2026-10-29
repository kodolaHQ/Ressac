import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { dansLaVue, lancer, nouveauProfil, ouvrirOnglet, serveurTest } from "./aide";
import { installerStoreFactice } from "./extensions/fixtures";

// Extensions de test « du Store » (construites et posées dans le profil avant le lancement, jamais le vrai Store),
// actives dans le profil de connexion par défaut. Tout reste invisible : fenêtres cachées, notifications détournées.

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => {
  serveur = await serveurTest();
});
test.afterAll(async () => {
  await serveur.fermer();
});

type Etat = {
  espaces: { id: string; profil: string }[];
  onglets: Record<string, { url: string; espaceId: string }>;
  fenetres: { id: string; espaceActif: string }[];
};
type Api = { webaios: { fenetreId: string; agir(a: unknown): void; surEtat(r: (e: Etat) => void): () => void } };

const lireEtat = (fenetre: Page) =>
  fenetre.evaluate(
    () =>
      new Promise<Etat>((ok) => {
        const w = window as unknown as Window & Api;
        const fin = w.webaios.surEtat((e) => {
          setTimeout(() => fin());
          ok(e);
        });
      }),
  );

const agir = (fenetre: Page, actions: unknown[]) =>
  fenetre.evaluate((actions) => {
    const w = window as unknown as Window & Api;
    for (const a of actions) w.webaios.agir(JSON.parse(JSON.stringify(a).replaceAll("$fenetre", w.webaios.fenetreId)));
  }, actions);

/** Crée un espace sur un nouveau profil de connexion (il devient l'espace actif) ; son id et celui du profil. */
async function espaceAutreProfil(fenetre: Page): Promise<{ espace: string; profil: string }> {
  const avant = new Set((await lireEtat(fenetre)).espaces.map((e) => e.id));
  await agir(fenetre, [{ type: "creerEspace", nom: "Autre", icone: "🧪", prive: false, profil: "nouveau", fenetreId: "$fenetre" }]);
  let cree: { id: string; profil: string } | undefined;
  await expect.poll(async () => (cree = (await lireEtat(fenetre)).espaces.find((e) => !avant.has(e.id)))).toBeTruthy();
  return { espace: cree!.id, profil: cree!.profil };
}

/** Recharge la vue dont l'URL contient `morceau` vers `url` et rend son titre (ou le message d'échec du chargement). */
const charger = (app: ElectronApplication, morceau: string, url: string) =>
  app.evaluate(
    async ({ webContents }, [morceau, url]) => {
      const w = webContents.getAllWebContents().find((x) => x.getURL().includes(morceau));
      if (!w) return "vue absente";
      try {
        await w.loadURL(url);
        return w.getTitle();
      } catch (e) {
        return (e as Error).message;
      }
    },
    [morceau, url] as const,
  );

/** Extensions chargées dans une session (par partition ; `""` : la session par défaut, celle de l'interface). */
const extensionsDe = (app: ElectronApplication, partition: string) =>
  app.evaluate(({ session }, partition) => (partition ? session.fromPartition(partition) : session.defaultSession).extensions.getAllExtensions().map((e) => e.name), partition);

/** Rapports de la sonde (`sonde:<JSON>` dans la console de son service worker), notés depuis l'appel. */
async function ecouterSonde(app: ElectronApplication): Promise<() => Promise<SondeRapport[]>> {
  await app.evaluate(({ session }) => {
    const g = globalThis as unknown as { __sonde?: string[] };
    g.__sonde = [];
    session.fromPartition("persist:webaios").serviceWorkers.on("console-message", (_e, d) => {
      if (d.message.startsWith("sonde:")) g.__sonde!.push(d.message.slice("sonde:".length));
    });
  });
  return async () => (await app.evaluate(() => (globalThis as unknown as { __sonde: string[] }).__sonde)).map((l) => JSON.parse(l));
}
type SondeRapport = { raison: string; onglets: { url: string }[]; fenetres: { onglets: string[] }[]; stockage: string[] };

test("le bloqueur actif dans le profil de l'espace A bloque /pub.js (ERR_BLOCKED_BY_CLIENT) ; dans un espace d'un autre profil, /pub.js se charge", async () => {
  const profil = nouveauProfil();
  installerStoreFactice(profil, "bloqueur", { profils: ["defaut"] });
  const { app, fenetre, fermer } = await lancer({ profil });
  try {
    await ouvrirOnglet(fenetre, `${serveur.url}/pub.html?a`);
    await expect.poll(() => dansLaVue(app, "pub.html?a", "document.title")).toMatch(/^pub /);
    // La règle est posée par le service worker peu après son démarrage : on recharge jusqu'à ce qu'elle agisse.
    await expect.poll(() => charger(app, "pub.html?a", `${serveur.url}/pub.html?a`), { timeout: 10_000 }).toBe("pub bloquée");
    expect(await charger(app, "pub.html?a", `${serveur.url}/pub.js`)).toContain("ERR_BLOCKED_BY_CLIENT");

    const { profil: autre } = await espaceAutreProfil(fenetre);
    await ouvrirOnglet(fenetre, `${serveur.url}/pub.html?b`);
    await expect.poll(() => dansLaVue(app, "pub.html?b", "document.title")).toMatch(/^pub /);
    expect(await charger(app, "pub.html?b", `${serveur.url}/pub.html?b`)).toBe("pub chargée");
    expect(await extensionsDe(app, `persist:webaios-${autre}`)).toEqual([]);
  } finally {
    await fermer();
  }
});

test("le cacheur cache #cache-moi sur une page locale", async () => {
  const profil = nouveauProfil();
  installerStoreFactice(profil, "cacheur", { profils: ["defaut"] });
  const { app, fenetre, fermer } = await lancer({ profil });
  try {
    await ouvrirOnglet(fenetre, `${serveur.url}/cache.html`);
    await expect
      .poll(() => dansLaVue(app, "cache.html", "[getComputedStyle(document.getElementById('cache-moi')).display, getComputedStyle(document.getElementById('reste')).display].join()"))
      .toBe("none,block");
  } finally {
    await fermer();
  }
});

test("la sonde ne voit que les onglets des espaces de son profil, jamais l'interface", async () => {
  const profil = nouveauProfil();
  installerStoreFactice(profil, "sonde", { profils: ["defaut"] });
  const { app, fenetre, fermer } = await lancer({ profil });
  try {
    const rapports = await ecouterSonde(app);
    const espaceA = (await lireEtat(fenetre)).fenetres[0]!.espaceActif;
    await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
    await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBeTruthy();
    await espaceAutreProfil(fenetre);
    await ouvrirOnglet(fenetre, `${serveur.url}/b.html`);
    await expect.poll(() => dansLaVue(app, "b.html", "document.title")).toBeTruthy();
    // De retour dans A, une nouvelle page : la sonde fait un rapport après que b.html s'est chargé.
    await agir(fenetre, [{ type: "activerEspace", id: espaceA, fenetreId: "$fenetre" }]);
    await ouvrirOnglet(fenetre, `${serveur.url}/texte.html`);
    let dernier: SondeRapport | undefined;
    await expect
      .poll(async () => {
        dernier = (await rapports()).findLast((r) => r.onglets.some((o) => o.url.includes("texte.html")));
        return dernier?.onglets.map((o) => o.url.replace(serveur.url, "")).sort();
      })
      .toEqual(["/a.html", "/texte.html"]);
    const vues = dernier!.fenetres.flatMap((f) => f.onglets);
    expect(vues.some((u) => u.includes("b.html") || u.includes("renderer/index.html"))).toBe(false);
    expect(dernier!.stockage).toContain("vu");
  } finally {
    await fermer();
  }
});

test("aucune extension dans session.defaultSession, webaios-lecture-publique, webaios-icones ni dans la session d'une appli", async () => {
  const profil = nouveauProfil();
  installerStoreFactice(profil, "sonde", { profils: ["defaut"] });
  installerStoreFactice(profil, "cacheur", { profils: ["defaut"] });
  const { app, fenetre, fermer } = await lancer({ profil });
  try {
    await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
    await expect.poll(async () => (await extensionsDe(app, "persist:webaios")).sort()).toEqual(["Cacheur de test", "Sonde de test"]);
    for (const partition of ["", "webaios-lecture-publique", "webaios-icones", "persist:app-essai"]) {
      expect(await extensionsDe(app, partition), partition || "session par défaut").toEqual([]);
    }
  } finally {
    await fermer();
  }
});

test("un tabs.create de la sonde ouvre un onglet dans l'espace de son profil", async () => {
  const profil = nouveauProfil();
  installerStoreFactice(profil, "sonde", { profils: ["defaut"] });
  const { fenetre, fermer } = await lancer({ profil });
  try {
    const espaceA = (await lireEtat(fenetre)).fenetres[0]!.espaceActif;
    const { espace: espaceB } = await espaceAutreProfil(fenetre);
    // La page déclencheuse s'ouvre dans A (sa vue est créée), puis la fenêtre repasse aussitôt dans B, d'un autre
    // profil : l'onglet de la sonde doit aller dans A, jamais dans l'espace actif B.
    await agir(fenetre, [
      { type: "activerEspace", id: espaceA, fenetreId: "$fenetre" },
      { type: "ouvrirOnglet", fenetreId: "$fenetre", url: `${serveur.url}/a.html?ouvrir-onglet` },
      { type: "activerEspace", id: espaceB, fenetreId: "$fenetre" },
    ]);
    let ouvert: { url: string; espaceId: string } | undefined;
    await expect
      .poll(async () => (ouvert = Object.values((await lireEtat(fenetre)).onglets).find((o) => o.url.includes("ouverte-par-sonde"))), { timeout: 10_000 })
      .toBeTruthy();
    expect(ouvert!.espaceId).toBe(espaceA);
    expect((await lireEtat(fenetre)).fenetres[0]!.espaceActif).toBe(espaceB);
  } finally {
    await fermer();
  }
});
