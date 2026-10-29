import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appelerOutil, dansLaVue, ecrireProjet, lancer, nouveauProfil, nouvelleRacine, ouvrirOnglet, serveurTest } from "./aide";
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
  onglets: Record<string, { id: string; url: string; espaceId: string }>;
  fenetres: { id: string; espaceActif: string; actif: Record<string, string | null> }[];
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
  const racine = nouvelleRacine();
  ecrireProjet(racine, "essai", { manifeste: { nom: "Essai" } });
  // Ports d'essai à part (applications.spec.ts prend 15280-15284) ; le faux docker d'e2e/outils lance le serveur.
  const { app, fenetre, fermer } = await lancer({ profil, racine, env: { WEBAIOS_PORTS_APPS: "15290-15294", WEBAIOS_DELAI_APP_MS: "3000" } });
  try {
    await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
    await expect.poll(async () => (await extensionsDe(app, "persist:webaios")).sort()).toEqual(["Cacheur de test", "Sonde de test"]);
    // Une vraie appli, dans sa vraie session (`persist:app-essai`), ouverte pendant que les extensions tournent.
    await expect.poll(() => existsSync(join(racine, ".webaios", "mcp.json")), { timeout: 10_000 }).toBe(true);
    expect((await appelerOutil(racine, "lancer_application", { dossier: "essai" })).texte).toContain("en marche sur http://localhost:1529");
    let extensionsAppli: string[] | null = null;
    await expect
      .poll(async () =>
        (extensionsAppli = await app.evaluate(({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith("http://localhost:1529"));
          return w ? w.webContents.session.extensions.getAllExtensions().map((e) => e.name) : null;
        })),
      )
      .not.toBeNull();
    expect(extensionsAppli).toEqual([]);
    // Les autres sessions hors profil (créées au démarrage ou à la demande) : aucune extension non plus.
    for (const partition of ["", "webaios-lecture-publique", "webaios-icones"]) {
      expect(await extensionsDe(app, partition), partition || "session par défaut").toEqual([]);
    }
  } finally {
    await fermer();
    // Le serveur d'essai de l'appli ne reste pas sur son port.
    for (const f of existsSync(racine) ? readdirSync(racine) : [])
      if (/^faux-docker-app-.*\.pid$/.test(f))
        try {
          process.kill(-Number(readFileSync(join(racine, f), "utf8")), "SIGKILL");
        } catch {
          // déjà arrêté
        }
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

test("un tabs.create({ active: true }) de la sonde ne fait jamais changer la fenêtre d'espace", async () => {
  const profil = nouveauProfil();
  installerStoreFactice(profil, "sonde", { profils: ["defaut"] });
  const { fenetre, fermer } = await lancer({ profil });
  try {
    const espaceA = (await lireEtat(fenetre)).fenetres[0]!.espaceActif;
    const { espace: espaceB } = await espaceAutreProfil(fenetre);
    await agir(fenetre, [
      { type: "activerEspace", id: espaceA, fenetreId: "$fenetre" },
      { type: "ouvrirOnglet", fenetreId: "$fenetre", url: `${serveur.url}/a.html?ouvrir-actif` },
      { type: "activerEspace", id: espaceB, fenetreId: "$fenetre" },
    ]);
    let ouvert: { id: string; espaceId: string } | undefined;
    await expect
      .poll(async () => (ouvert = Object.values((await lireEtat(fenetre)).onglets).find((o) => o.url.includes("ouverte-active"))), { timeout: 10_000 })
      .toBeTruthy();
    // L'activation demandée (onActivated) a eu le temps d'arriver.
    await new Promise((r) => setTimeout(r, 500));
    const etat = await lireEtat(fenetre);
    expect(ouvert!.espaceId).toBe(espaceA);
    expect(etat.fenetres[0]!.espaceActif).toBe(espaceB);
    expect(etat.fenetres[0]!.actif[espaceA]).toBe(ouvert!.id);
  } finally {
    await fermer();
  }
});

test("un tabs.update({ active: true }) d'un onglet d'un autre espace le choisit dans son espace, sans changer celui de la fenêtre", async () => {
  const profil = nouveauProfil();
  installerStoreFactice(profil, "sonde", { profils: ["defaut"] });
  const { fenetre, fermer } = await lancer({ profil });
  try {
    const espaceA = (await lireEtat(fenetre)).fenetres[0]!.espaceActif;
    const { espace: espaceB } = await espaceAutreProfil(fenetre);
    // Dans A : l'onglet qui sera activé (sa vue se crée et se charge), puis un autre par-dessus ; la fenêtre repasse dans B.
    await agir(fenetre, [
      { type: "activerEspace", id: espaceA, fenetreId: "$fenetre" },
      { type: "ouvrirOnglet", fenetreId: "$fenetre", url: `${serveur.url}/a.html?activer-plus-tard` },
      { type: "ouvrirOnglet", fenetreId: "$fenetre", url: `${serveur.url}/b.html` },
      { type: "activerEspace", id: espaceB, fenetreId: "$fenetre" },
    ]);
    const cible = Object.values((await lireEtat(fenetre)).onglets).find((o) => o.url.includes("activer-plus-tard"))!;
    expect((await lireEtat(fenetre)).fenetres[0]!.actif[espaceA]).not.toBe(cible.id);
    await expect.poll(async () => (await lireEtat(fenetre)).fenetres[0]!.actif[espaceA], { timeout: 10_000 }).toBe(cible.id);
    expect((await lireEtat(fenetre)).fenetres[0]!.espaceActif).toBe(espaceB);
  } finally {
    await fermer();
  }
});

// --- Correctifs de la spec §4.3 (sonde-correctifs, extension du Store factice) ---

type Rapport = {
  browserEstChrome: boolean;
  commandes: string;
  ajout: string;
  electron: string;
  journal: ({ e: "demarrage"; version: string } | { e: "installe"; raison: string; precedente: string | null })[];
  rulesets: string[];
};

/** Ouvre `url` dans un onglet et rend ce que le script de contenu de la sonde y a écrit dans `data-<cle>` (JSON). */
async function lireSonde(app: ElectronApplication, fenetre: Page, url: string, cle: string): Promise<unknown> {
  await ouvrirOnglet(fenetre, url);
  const morceau = url.replace(serveur.url, "");
  let brut: unknown = null;
  await expect
    .poll(async () => typeof (brut = await dansLaVue(app, morceau, `document.documentElement.dataset[${JSON.stringify(cle)}] ?? null`)), { timeout: 10_000 })
    .toBe("string");
  return JSON.parse(brut as string);
}
let numero = 0;
/** Un rapport du fond de la sonde (une nouvelle page à chaque fois). */
const rapport = (app: ElectronApplication, fenetre: Page) => lireSonde(app, fenetre, `${serveur.url}/a.html?rapport-${++numero}`, "rapport") as Promise<Rapport>;
const installations = (r: Rapport) => r.journal.filter((x) => x.e === "installe");
const demarrages = (r: Rapport) => r.journal.filter((x) => x.e === "demarrage");

test("browser est chrome dans le service worker (browser.commands défini)", async () => {
  const profil = nouveauProfil();
  installerStoreFactice(profil, "sonde-correctifs", { profils: ["defaut"] });
  const { app, fenetre, fermer } = await lancer({ profil });
  try {
    const r = await rapport(app, fenetre);
    expect(r.browserEstChrome).toBe(true);
    expect(r.commandes).toBe("object");
  } finally {
    await fermer();
  }
});

test("une propriété ajoutée à chrome par l'extension reste (chrome non gelé)", async () => {
  const profil = nouveauProfil();
  installerStoreFactice(profil, "sonde-correctifs", { profils: ["defaut"] });
  const { app, fenetre, fermer } = await lancer({ profil });
  try {
    expect((await rapport(app, fenetre)).ajout).toBe("gardee");
  } finally {
    await fermer();
  }
});

test("runtime.onInstalled reçu une fois avec reason install, pas au redémarrage, puis reason update et previousVersion après une nouvelle version", async () => {
  const profil = nouveauProfil();
  const { cle } = installerStoreFactice(profil, "sonde-correctifs", { profils: ["defaut"] });
  // 1er lancement : installation.
  let lance = await lancer({ profil });
  try {
    let r: Rapport | undefined;
    await expect.poll(async () => installations((r = await rapport(lance.app, lance.fenetre))).length, { timeout: 15_000 }).toBe(1);
    expect(installations(r!)).toEqual([{ e: "installe", raison: "install", precedente: null }]);
  } finally {
    await lance.fermer();
  }
  // 2e lancement : le fond redémarre, sans nouvel onInstalled ; le ruleset du manifeste, activé au 1er, bloque encore.
  lance = await lancer({ profil });
  try {
    let r: Rapport | undefined;
    await expect.poll(async () => demarrages((r = await rapport(lance.app, lance.fenetre))).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    await new Promise((ok) => setTimeout(ok, 1000));
    r = await rapport(lance.app, lance.fenetre);
    expect(installations(r)).toHaveLength(1);
    expect(r.rulesets).toEqual(["regles"]);
    await ouvrirOnglet(lance.fenetre, `${serveur.url}/pub.html?apres-redemarrage`);
    await expect.poll(() => dansLaVue(lance.app, "pub.html?apres-redemarrage", "document.title")).toBe("pub bloquée");
  } finally {
    await lance.fermer();
  }
  // Nouvelle version (même clé, donc même id) : update, avec la version précédente.
  installerStoreFactice(profil, "sonde-correctifs", { profils: ["defaut"], version: "1.1.0", cle });
  lance = await lancer({ profil });
  try {
    let r: Rapport | undefined;
    await expect.poll(async () => installations((r = await rapport(lance.app, lance.fenetre))).length, { timeout: 15_000 }).toBe(2);
    expect(installations(r!)[1]).toEqual({ e: "installe", raison: "update", precedente: "1.0.0" });
    expect(demarrages(r!).at(-1)).toEqual({ e: "demarrage", version: "1.1.0" });
  } finally {
    await lance.fermer();
  }
});

test("un ruleset statique enabled du manifeste bloque dès le chargement ; coupé par l'extension, il reste coupé après redémarrage", async () => {
  const profil = nouveauProfil();
  installerStoreFactice(profil, "sonde-correctifs", { profils: ["defaut"] });
  let lance = await lancer({ profil });
  try {
    // Aucune règle dynamique : seul le ruleset du manifeste peut bloquer /pub.js.
    await ouvrirOnglet(lance.fenetre, `${serveur.url}/pub.html?r1`);
    await expect.poll(() => dansLaVue(lance.app, "pub.html?r1", "document.title")).toMatch(/^pub /);
    await expect.poll(() => charger(lance.app, "pub.html?r1", `${serveur.url}/pub.html?r1`), { timeout: 10_000 }).toBe("pub bloquée");
    expect(await lireSonde(lance.app, lance.fenetre, `${serveur.url}/a.html?couper-regles`, "couper")).toEqual([]);
    expect(await charger(lance.app, "pub.html?r1", `${serveur.url}/pub.html?r1`)).toBe("pub chargée");
  } finally {
    await lance.fermer();
  }
  lance = await lancer({ profil });
  try {
    let r: Rapport | undefined;
    await expect.poll(async () => demarrages((r = await rapport(lance.app, lance.fenetre))).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    await new Promise((ok) => setTimeout(ok, 1000));
    expect((await rapport(lance.app, lance.fenetre)).rulesets).toEqual([]);
    await ouvrirOnglet(lance.fenetre, `${serveur.url}/pub.html?r2`);
    await expect.poll(() => dansLaVue(lance.app, "pub.html?r2", "document.title")).toBe("pub chargée");
  } finally {
    await lance.fermer();
  }
});

test("chrome.storage.sync.set puis get dans un script de contenu rend la valeur", async () => {
  const profil = nouveauProfil();
  installerStoreFactice(profil, "sonde-correctifs", { profils: ["defaut"] });
  const { app, fenetre, fermer } = await lancer({ profil });
  try {
    await ouvrirOnglet(fenetre, `${serveur.url}/b.html?sync`);
    await expect.poll(() => dansLaVue(app, "b.html?sync", "document.documentElement.dataset.sync ?? null"), { timeout: 10_000 }).toBe("valeur-sync");
  } finally {
    await fermer();
  }
});

test("connectNative rend un port fermé avec « Messagerie native non prise en charge », aucun processus lancé (Bitwarden-like : manifeste avec nativeMessaging)", async () => {
  const profil = nouveauProfil();
  const { id } = installerStoreFactice(profil, "sonde-correctifs", { profils: ["defaut"] });
  // Un hôte natif bien déclaré là où la bibliothèque les cherche (<userData>/NativeMessagingHosts) : lancé, il laisserait
  // une trace. Il ne doit jamais l'être.
  const trace = join(profil, "hote-lance");
  const hote = join(profil, "hote.sh");
  writeFileSync(hote, `#!/bin/sh\ntouch "${trace}"\ncat > /dev/null\n`);
  chmodSync(hote, 0o755);
  mkdirSync(join(profil, "NativeMessagingHosts"), { recursive: true });
  writeFileSync(
    join(profil, "NativeMessagingHosts", "com.webaios.essai.json"),
    JSON.stringify({ name: "com.webaios.essai", description: "essai", path: hote, type: "stdio", allowed_origins: [`chrome-extension://${id}/`] }),
  );
  const { app, fenetre, fermer } = await lancer({ profil });
  try {
    expect(await lireSonde(app, fenetre, `${serveur.url}/a.html?natif`, "natif")).toEqual({ erreur: "Messagerie native non prise en charge" });
    await new Promise((ok) => setTimeout(ok, 1000));
    expect(existsSync(trace)).toBe(false);
  } finally {
    await fermer();
  }
});

test("une extension ne peut pas appeler la bibliothèque au nom d'une autre (globalThis.electron reste visible)", async () => {
  const profil = nouveauProfil();
  installerStoreFactice(profil, "sonde-correctifs", { profils: ["defaut"] });
  const { id: autre } = installerStoreFactice(profil, "sonde", { profils: ["defaut"] });
  const { app, fenetre, fermer } = await lancer({ profil });
  try {
    const r = (await lireSonde(app, fenetre, `${serveur.url}/a.html?rapport-usurpation&autre=${autre}`, "rapport")) as Rapport & { usurpation: boolean; soi: boolean };
    // Mesure (constat ⚠️A de la revue) : le `delete globalThis.electron` de la bibliothèque n'a pas d'effet.
    expect(r.electron).toBe("object");
    // Mais l'id annoncé est lié à l'origine réelle : au nom de l'autre, refusé ; au sien, permis.
    expect(r.usurpation).toBe(false);
    expect(r.soi).toBe(true);
  } finally {
    await fermer();
  }
});

test("un bloqueur purement déclaratif (ni fond ni page) bloque dès le premier chargement", async () => {
  const profil = nouveauProfil();
  installerStoreFactice(profil, "bloqueur-statique", { profils: ["defaut"] });
  const { app, fenetre, fermer } = await lancer({ profil });
  try {
    await ouvrirOnglet(fenetre, `${serveur.url}/pub.html?statique`);
    await expect.poll(() => dansLaVue(app, "pub.html?statique", "document.title")).toMatch(/^pub /);
    await expect.poll(() => charger(app, "pub.html?statique", `${serveur.url}/pub.html?statique`), { timeout: 10_000 }).toBe("pub bloquée");
  } finally {
    await fermer();
  }
});

test("le ruleset du manifeste reste actif après que l'extension est retirée puis rechargée (profil coupé puis rallumé)", async () => {
  const profil = nouveauProfil();
  installerStoreFactice(profil, "sonde-correctifs", { profils: ["defaut"] });
  const { app, fenetre, fermer } = await lancer({ profil });
  try {
    await ouvrirOnglet(fenetre, `${serveur.url}/pub.html?b1`);
    await expect.poll(() => dansLaVue(app, "pub.html?b1", "document.title")).toMatch(/^pub /);
    await expect.poll(() => charger(app, "pub.html?b1", `${serveur.url}/pub.html?b1`), { timeout: 10_000 }).toBe("pub bloquée");
    // Ce que fait la synchronisation quand le profil est coupé puis rallumé : removeExtension, loadExtension, démarrage du fond.
    const rechargee = await app.evaluate(async ({ session }) => {
      const s = session.fromPartition("persist:webaios");
      const ext = s.extensions.getAllExtensions().find((e) => e.name === "Sonde des correctifs")!;
      s.extensions.removeExtension(ext.id);
      await new Promise((ok) => setTimeout(ok, 300));
      const nouvelle = await s.extensions.loadExtension(ext.path, { allowFileAccess: false });
      // Comme `appliquerProfil` : un démarrage en échec n'est que journalisé (le fond démarre au premier événement).
      await s.serviceWorkers.startWorkerForScope(nouvelle.url).catch(() => {});
      return nouvelle.id === ext.id;
    });
    expect(rechargee).toBe(true);
    await new Promise((ok) => setTimeout(ok, 1000));
    await expect.poll(() => charger(app, "pub.html?b1", `${serveur.url}/pub.html?b1`), { timeout: 5_000 }).toBe("pub bloquée");
    expect((await rapport(app, fenetre)).rulesets).toEqual(["regles"]);
  } finally {
    await fermer();
  }
});
