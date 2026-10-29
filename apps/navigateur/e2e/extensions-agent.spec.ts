import { expect, test, type ElectronApplication } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dansLaVue, lancer, nouveauProfil, nouvelleRacine, ouvrirOnglet, serveurTest } from "./aide";
import { ecrireExtensionAgent } from "./extensions/fixtures";

// Extensions de l'agent (`<racine>/extensions/<id>/`, le ~/WebAiOs du test). Sans point d'entrée avant les tâches 14 et 17
// (P10), l'accord est posé au registre du profil avant le lancement, et chaque effet vérifié par un redémarrage. Les
// tests « demander dans un espace privé » et « la carte revient au rechargement » sont ceux de la tâche 17 (MCP).

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => {
  serveur = await serveurTest();
});
test.afterAll(async () => {
  await serveur.fermer();
});

const HOTE = "http://127.0.0.1/*";
const manifeste = (matches: string[]) => ({
  manifest_version: 3,
  name: "Cacheur de l'agent",
  version: "1.0.0",
  content_scripts: [{ matches, css: ["cache.css"] }],
});
const CACHE = "#cache-moi { display: none !important; }\n";
const CACHE_TOUT = "#cache-moi, #reste { display: none !important; }\n";
/** La portée du cacheur sur 127.0.0.1, telle que la carte l'aurait montrée. */
const ACCORD = { permissions: [], hotes: [HOTE], reseau: [], tousLesSites: false, scriptsTousLesSites: false, scripts: true };

type Entree = { idChrome: string | null; accord: unknown; profils: string[]; modifieeLe: string | null; desactivee: { raison: string } | null };
const entree = (accord: unknown) => ({
  source: "agent",
  idChrome: null,
  nom: "Cacheur de l'agent",
  version: "1.0.0",
  accord,
  profils: ["defaut"],
  epinglee: false,
  modifieeLe: null,
  desactivee: null,
  majEnAttente: null,
  vues: {},
});

/** Écrit un registre dans `dossier` (`etat.json`) avec l'entrée `agent:cacheur`. */
function poserRegistre(dossier: string, x: unknown): void {
  mkdirSync(dossier, { recursive: true });
  writeFileSync(join(dossier, "etat.json"), JSON.stringify({ version: 1, toutesCoupees: false, extensions: { "agent:cacheur": x } }));
}
const lireEntree = (profil: string) =>
  (JSON.parse(readFileSync(join(profil, "extensions", "etat.json"), "utf8")) as { extensions: Record<string, Entree> }).extensions["agent:cacheur"];

/** `display` de #cache-moi et #reste dans l'onglet de cache.html. */
const affichage = (app: ElectronApplication) =>
  dansLaVue(app, "cache.html", "[getComputedStyle(document.getElementById('cache-moi')).display, getComputedStyle(document.getElementById('reste')).display].join()");

const extensionsDuProfil = (app: ElectronApplication) =>
  app.evaluate(({ session }) => session.fromPartition("persist:webaios").extensions.getAllExtensions().map((e) => e.name));

/** Lance, ouvre cache.html et rend ce qu'on y voit une fois la page chargée (après un délai pour les extensions). */
async function voir(profil: string, racine: string): Promise<{ affiche: unknown; extensions: string[] }> {
  const { app, fenetre, fermer } = await lancer({ profil, racine });
  try {
    await ouvrirOnglet(fenetre, `${serveur.url}/cache.html`);
    await expect.poll(() => dansLaVue(app, "cache.html", "document.readyState")).toBe("complete");
    return { affiche: await affichage(app), extensions: await extensionsDuProfil(app) };
  } finally {
    await fermer();
  }
}

test("une extension de l'agent posée dans ~/WebAiOs/extensions n'est jamais chargée sans accord (redémarrage compris)", async () => {
  const profil = nouveauProfil();
  const racine = nouvelleRacine();
  ecrireExtensionAgent(racine, "cacheur", { "manifest.json": manifeste([HOTE]), "cache.css": CACHE });
  for (let i = 0; i < 2; i++) {
    const vu = await voir(profil, racine);
    expect(vu.affiche).toBe("block,block");
    expect(vu.extensions).toEqual([]);
  }
  expect(existsSync(join(profil, "extensions", "copies", "cacheur"))).toBe(false);
});

test("un faux accord écrit dans ~/WebAiOs/extensions n'active rien", async () => {
  const profil = nouveauProfil();
  const racine = nouvelleRacine();
  ecrireExtensionAgent(racine, "cacheur", { "manifest.json": manifeste([HOTE]), "cache.css": CACHE });
  // Le registre tel que WebAiOs l'écrirait, mais dans le dossier de l'agent (et dans le dossier de l'extension).
  poserRegistre(join(racine, "extensions"), entree(ACCORD));
  poserRegistre(join(racine, "extensions", "cacheur"), entree(ACCORD));
  const vu = await voir(profil, racine);
  expect(vu.affiche).toBe("block,block");
  expect(vu.extensions).toEqual([]);
  expect(existsSync(join(profil, "extensions", "copies", "cacheur"))).toBe(false);
});

test("accordée, elle cache #cache-moi ; modifiée sans nouveau droit puis rechargée, elle passe sans carte", async () => {
  const profil = nouveauProfil();
  const racine = nouvelleRacine();
  ecrireExtensionAgent(racine, "cacheur", { "manifest.json": manifeste([HOTE]), "cache.css": CACHE });
  poserRegistre(join(profil, "extensions"), entree(ACCORD));

  let lance = await lancer({ profil, racine });
  try {
    await ouvrirOnglet(lance.fenetre, `${serveur.url}/cache.html`);
    await expect.poll(() => affichage(lance.app), { timeout: 10_000 }).toBe("none,block");
  } finally {
    await lance.fermer();
  }
  const premiere = lireEntree(profil)!;
  expect(premiere.modifieeLe).not.toBeNull();
  // L'id que Chromium a donné à la copie est noté au registre.
  expect(premiere.idChrome).toMatch(/^[a-p]{32}$/);

  // Modifiée par l'agent (même portée) : rechargée au démarrage, sans carte.
  ecrireExtensionAgent(racine, "cacheur", { "cache.css": CACHE_TOUT });
  lance = await lancer({ profil, racine });
  try {
    await ouvrirOnglet(lance.fenetre, `${serveur.url}/cache.html`);
    await expect.poll(() => affichage(lance.app), { timeout: 10_000 }).toBe("none,none");
    // Aucune carte d'accord dans la fenêtre.
    await expect(lance.fenetre.getByText("Cacheur de l'agent")).toHaveCount(0);
  } finally {
    await lance.fermer();
  }
  const seconde = lireEntree(profil)!;
  expect(seconde.desactivee).toBeNull();
  expect(seconde.modifieeLe).not.toBe(premiere.modifieeLe);
  expect(seconde.accord).toEqual(ACCORD);
});

test("modifiée avec un nouveau site : désactivée, plus chargée, l'accord gardé", async () => {
  const profil = nouveauProfil();
  const racine = nouvelleRacine();
  ecrireExtensionAgent(racine, "cacheur", { "manifest.json": manifeste([HOTE, "https://exemple.com/*"]), "cache.css": CACHE });
  poserRegistre(join(profil, "extensions"), entree(ACCORD));
  const vu = await voir(profil, racine);
  expect(vu.affiche).toBe("block,block");
  expect(vu.extensions).toEqual([]);
  const x = lireEntree(profil)!;
  expect(x.desactivee?.raison).toBe("portee-elargie");
  expect(x.accord).toEqual(ACCORD);
});
