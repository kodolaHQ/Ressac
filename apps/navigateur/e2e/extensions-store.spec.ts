import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dansLaVue, lancer, nouveauProfil, ouvrirOnglet, serveurTest } from "./aide";
import { construireCrx } from "./extensions/crx";
import { ecrireExtension, EXTENSIONS_TEST } from "./extensions/fixtures";

// Installation depuis le Chrome Web Store : jamais le vrai Store. Un faux Store local (WEBAIOS_TEST_STORE_URL) sert des
// CRX construits ici ; l'installation est demandée comme le fera la page Extensions (window.webaios.extensions
// .installerStore). Tout reste invisible.

const ERREUR_STORE = "Le Chrome Web Store n'a pas fourni l'extension (réseau coupé, ou le Store a changé sa façon de les servir)";
const CRX_INVALIDE = "Fichier d'extension invalide ou mal signé : installation refusée";
const SAISIE_INVALIDE = "Adresse ou identifiant du Chrome Web Store attendu";
const REFUSEE = "Installation refusée";

let pages: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => {
  pages = await serveurTest();
});
test.afterAll(async () => {
  await pages.fermer();
});

/** Faux Store : `/<id>.crx`, et le nombre de requêtes reçues par id. */
async function fauxStore(): Promise<{ url: string; servir(crx: Buffer, id: string): void; requetes(id: string): number; fermer(): Promise<void> }> {
  const servis = new Map<string, Buffer>();
  const compte = new Map<string, number>();
  const serveur: Server = createServer((req, res) => {
    const id = (req.url ?? "").replace(/^\//, "").replace(/\.crx$/, "");
    compte.set(id, (compte.get(id) ?? 0) + 1);
    const corps = servis.get(id);
    if (!corps) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/x-chrome-extension" }).end(corps);
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`,
    servir: (crx, id) => void servis.set(id, crx),
    requetes: (id) => compte.get(id) ?? 0,
    fermer: () => new Promise<void>((ok) => serveur.close(() => ok())),
  };
}

/** Le CRX du bloqueur de test (bloque /pub.js), éventuellement mal signé. */
function crxBloqueur(o: { signatureFausse?: boolean } = {}): { crx: Buffer; id: string } {
  const source = mkdtempSync(join(tmpdir(), "webaios-store-e2e-"));
  try {
    ecrireExtension(source, EXTENSIONS_TEST.bloqueur);
    const { crx, id } = construireCrx(source, o);
    return { crx, id };
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
}

type Resultat = { ok: true } | { ok: false; erreur: string };
type Api = { webaios: { fenetreId: string; agir(a: unknown): void; extensions: { installerStore(s: string): Promise<Resultat> } } };

const installer = (fenetre: Page, saisie: string) =>
  fenetre.evaluate((s) => (window as unknown as Window & Api).webaios.extensions.installerStore(s), saisie);

const carte = (fenetre: Page) => fenetre.getByTestId("modale-demande").getByTestId("demande-extension");

const registre = (profil: string): { toutesCoupees: boolean; extensions: Record<string, { profils: string[]; version: string }> } => {
  const f = join(profil, "extensions", "etat.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { toutesCoupees: false, extensions: {} };
};
const contenu = (d: string) => (existsSync(d) ? readdirSync(d) : []);

type Etat = { espaces: { id: string; profil: string }[] };
const lireEtat = (fenetre: Page) =>
  fenetre.evaluate(
    () =>
      new Promise<Etat>((ok) => {
        const w = window as unknown as Window & { webaios: { surEtat(r: (e: Etat) => void): () => void } };
        const fin = w.webaios.surEtat((e) => {
          setTimeout(() => fin());
          ok(e);
        });
      }),
  );

/** Crée un espace sur un nouveau profil de connexion (il devient l'espace actif) ; l'id du profil. */
async function espaceAutreProfil(fenetre: Page): Promise<string> {
  const avant = new Set((await lireEtat(fenetre)).espaces.map((e) => e.id));
  await fenetre.evaluate(() => {
    const w = window as unknown as Window & Api;
    w.webaios.agir({ type: "creerEspace", nom: "Autre", icone: "🧪", prive: false, profil: "nouveau", fenetreId: w.webaios.fenetreId });
  });
  let cree: { id: string; profil: string } | undefined;
  await expect.poll(async () => (cree = (await lireEtat(fenetre)).espaces.find((e) => !avant.has(e.id)))).toBeTruthy();
  return cree!.profil;
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

const extensionsDe = (app: ElectronApplication, partition: string) =>
  app.evaluate(({ session }, partition) => session.fromPartition(partition).extensions.getAllExtensions().map((e) => e.name), partition);

test("installer par l'adresse, accepter la carte : l'extension bloque dans l'espace courant et pas dans un autre profil", async () => {
  const store = await fauxStore();
  const { crx, id } = crxBloqueur();
  store.servir(crx, id);
  const profil = nouveauProfil();
  const { app, fenetre, fermer } = await lancer({ profil, env: { WEBAIOS_TEST_STORE_URL: store.url } });
  try {
    const resultat = installer(fenetre, `https://chromewebstore.google.com/detail/bloqueur-de-test/${id}?hl=fr`);
    const c = carte(fenetre);
    await expect(c).toContainText("Bloqueur de test");
    await expect(c).toContainText("Bloquer ou modifier des requêtes");
    await c.getByRole("button", { name: "Activer" }).click();
    expect(await resultat).toEqual({ ok: true });

    expect(existsSync(join(profil, "extensions", "store", id, "1.0.0_0", "manifest.json"))).toBe(true);
    expect(contenu(join(profil, "extensions", "store-attente"))).toEqual([]);
    expect(registre(profil).extensions[`store:${id}`]).toMatchObject({ profils: ["defaut"], version: "1.0.0" });
    expect(await extensionsDe(app, "persist:webaios")).toEqual(["Bloqueur de test"]);
    // La page du Store est équipée dans la session du profil (preload de la bibliothèque), jamais dans celle de l'interface.
    const preloads = (partition: string) =>
      app.evaluate(({ session }, p) => (p ? session.fromPartition(p) : session.defaultSession).getPreloadScripts().map((x) => x.id), partition);
    expect(await preloads("persist:webaios")).toContain("electron-chrome-web-store");
    expect(await preloads("")).not.toContain("electron-chrome-web-store");

    await ouvrirOnglet(fenetre, `${pages.url}/pub.html?a`);
    await expect.poll(() => dansLaVue(app, "pub.html?a", "document.title")).toMatch(/^pub /);
    await expect.poll(() => charger(app, "pub.html?a", `${pages.url}/pub.html?a`), { timeout: 10_000 }).toBe("pub bloquée");

    const autre = await espaceAutreProfil(fenetre);
    await ouvrirOnglet(fenetre, `${pages.url}/pub.html?b`);
    await expect.poll(() => dansLaVue(app, "pub.html?b", "document.title")).toMatch(/^pub /);
    expect(await charger(app, "pub.html?b", `${pages.url}/pub.html?b`)).toBe("pub chargée");
    expect(await extensionsDe(app, `persist:webaios-${autre}`)).toEqual([]);
  } finally {
    await fermer();
    await store.fermer();
  }
});

test("refuser la carte : rien dans store/, rien dans le registre ; une saisie illisible est refusée sans carte", async () => {
  const store = await fauxStore();
  const { crx, id } = crxBloqueur();
  store.servir(crx, id);
  const profil = nouveauProfil();
  const { app, fenetre, fermer } = await lancer({ profil, env: { WEBAIOS_TEST_STORE_URL: store.url } });
  try {
    expect(await installer(fenetre, `https://exemple.com/detail/x/${id}`)).toEqual({ ok: false, erreur: SAISIE_INVALIDE });
    expect(store.requetes(id)).toBe(0);

    const resultat = installer(fenetre, id);
    await carte(fenetre).getByRole("button", { name: "Refuser" }).click();
    expect(await resultat).toEqual({ ok: false, erreur: REFUSEE });
    await expect(fenetre.getByTestId("modale-demande")).toHaveCount(0);
    expect(contenu(join(profil, "extensions", "store"))).toEqual([]);
    expect(contenu(join(profil, "extensions", "store-attente"))).toEqual([]);
    expect(registre(profil).extensions).toEqual({});
    expect(await extensionsDe(app, "persist:webaios")).toEqual([]);
  } finally {
    await fermer();
    await store.fermer();
  }
});

test("CRX mal signé : erreur CRX_INVALIDE, aucune carte, rien installé", async () => {
  const store = await fauxStore();
  const { crx, id } = crxBloqueur({ signatureFausse: true });
  store.servir(crx, id);
  const profil = nouveauProfil();
  const { app, fenetre, fermer } = await lancer({ profil, env: { WEBAIOS_TEST_STORE_URL: store.url } });
  try {
    expect(await installer(fenetre, id)).toEqual({ ok: false, erreur: CRX_INVALIDE });
    expect(store.requetes(id)).toBe(1);
    await expect(fenetre.getByTestId("modale-demande")).toHaveCount(0);
    expect(contenu(join(profil, "extensions", "store"))).toEqual([]);
    expect(contenu(join(profil, "extensions", "store-attente"))).toEqual([]);
    expect(registre(profil).extensions).toEqual({});
    expect(await extensionsDe(app, "persist:webaios")).toEqual([]);
  } finally {
    await fermer();
    await store.fermer();
  }
});

test("serveur fermé : erreur ERREUR_STORE", async () => {
  const store = await fauxStore();
  await store.fermer();
  const { id } = crxBloqueur();
  const profil = nouveauProfil();
  const { fenetre, fermer } = await lancer({ profil, env: { WEBAIOS_TEST_STORE_URL: store.url } });
  try {
    expect(await installer(fenetre, id)).toEqual({ ok: false, erreur: ERREUR_STORE });
    await expect(fenetre.getByTestId("modale-demande")).toHaveCount(0);
    expect(contenu(join(profil, "extensions", "store"))).toEqual([]);
    expect(registre(profil).extensions).toEqual({});
  } finally {
    await fermer();
  }
});

test("déjà installée, activée dans un second profil sans nouveau téléchargement (compteur du serveur)", async () => {
  const store = await fauxStore();
  const { crx, id } = crxBloqueur();
  store.servir(crx, id);
  const profil = nouveauProfil();
  const { app, fenetre, fermer } = await lancer({ profil, env: { WEBAIOS_TEST_STORE_URL: store.url } });
  try {
    const premiere = installer(fenetre, id);
    await carte(fenetre).getByRole("button", { name: "Activer" }).click();
    expect(await premiere).toEqual({ ok: true });
    expect(store.requetes(id)).toBe(1);

    const autre = await espaceAutreProfil(fenetre);
    expect(await extensionsDe(app, `persist:webaios-${autre}`)).toEqual([]);
    const seconde = installer(fenetre, `https://chrome.google.com/webstore/detail/bloqueur/${id}`);
    const c = carte(fenetre);
    await expect(c).toContainText("Autre");
    await c.getByRole("button", { name: "Activer" }).click();
    expect(await seconde).toEqual({ ok: true });

    expect(store.requetes(id)).toBe(1);
    expect(registre(profil).extensions[`store:${id}`]!.profils).toEqual(["defaut", autre]);
    await expect.poll(() => extensionsDe(app, `persist:webaios-${autre}`)).toEqual(["Bloqueur de test"]);
    expect(await extensionsDe(app, "persist:webaios")).toEqual(["Bloqueur de test"]);
  } finally {
    await fermer();
    await store.fermer();
  }
});
