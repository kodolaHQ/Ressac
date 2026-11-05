import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor, waitReady, waitWindowCount } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, waitUi } from "./ui";

// La page d'accueil dans la barre latérale : widgets du dossier, placement libre, thème de l'agent, cadre isolé et liens,
// puis accords, récoltes (manuelle, en échec, atelier arrêté), notifications, retrait et host arrêté.
// Non lancé dans ce worktree (pas de build ni de moteur) : à lancer après `pnpm build:ui` par l'utilisateur.

interface PlacementTest {
  id: string;
  x: number;
  y: number;
  l: number;
  h: number;
}

interface AccordTest {
  domaines: string[];
  publiques: string[];
  profil: string;
}

type AccordsTest = Record<string, AccordTest>;

const RACINE = (dataDir: string) => path.join(dataDir, "espace");
const ACCUEIL = (dataDir: string) => path.join(RACINE(dataDir), "accueil");
const WIDGETS = (dataDir: string) => path.join(dataDir, "widgets");
const ACCORDS = (dataDir: string) => path.join(WIDGETS(dataDir), "accords.json");
const ETAT = (dataDir: string, id: string) => path.join(WIDGETS(dataDir), id, "etat.json");
const DONNEES = (dataDir: string, id: string) => path.join(WIDGETS(dataDir), id, "donnees.json");

async function ecrireWidget(dataDir: string, id: string, o: { nom: string; affichage: string; declaration?: Record<string, unknown> }): Promise<void> {
  const dossier = path.join(ACCUEIL(dataDir), "widgets", id);
  await mkdir(dossier, { recursive: true });
  await writeFile(
    path.join(dossier, "widget.json"),
    JSON.stringify({
      nom: o.nom,
      description: "",
      tailles: { min: { l: 2, h: 1 }, max: { l: 6, h: 4 }, defaut: { l: 3, h: 2 } },
      sources: { compte: [], publiques: [], web: false },
      ...o.declaration,
    }),
  );
  await writeFile(path.join(dossier, "affichage.html"), o.affichage);
}

async function ecrireRecolte(dataDir: string, id: string, code: string): Promise<void> {
  await writeFile(path.join(ACCUEIL(dataDir), "widgets", id, "recolte.mjs"), code);
}

async function ecrireDisposition(dataDir: string, widgets: PlacementTest[]): Promise<void> {
  await writeFile(path.join(ACCUEIL(dataDir), "disposition.json"), JSON.stringify({ version: 3, widgets }));
}

async function lireDisposition(dataDir: string): Promise<PlacementTest[]> {
  return JSON.parse(await readFile(path.join(ACCUEIL(dataDir), "disposition.json"), "utf8")).widgets;
}

async function lireJson<T>(fichier: string): Promise<T> {
  return JSON.parse(await readFile(fichier, "utf8")) as T;
}

async function ecrireJson(fichier: string, valeur: unknown): Promise<void> {
  await mkdir(path.dirname(fichier), { recursive: true });
  await writeFile(fichier, JSON.stringify(valeur));
}

async function lireAccords(dataDir: string): Promise<AccordsTest> {
  return existsSync(ACCORDS(dataDir)) ? lireJson<AccordsTest>(ACCORDS(dataDir)) : {};
}

async function attendre<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 10_000): Promise<T> {
  const fin = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > fin) throw new Error(`délai dépassé en attendant ${what}: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Un glisser ou un redimensionnement, par événements de pointeur directs dans l'interface. Le geste ne dépend pas de
 * `isTrusted` (seuls les liens du widget le font, et ils passent par `synthesizeMouseEvent`) : ce test porte sur le
 * placement et l'écriture de disposition.json.
 */
async function glisser(m: Marionette, selection: string, dx: number, dy: number): Promise<void> {
  await inUi(
    m,
    `
    const el = doc.querySelector(arguments[0]);
    if (!el) throw new Error("introuvable : " + arguments[0]);
    const r = el.getBoundingClientRect();
    const x0 = r.left + r.width / 2, y0 = r.top + Math.min(12, r.height / 2);
    const pointeur = (type, cible, x, y) => cible.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y, pointerId: 1, isPrimary: true,
    }));
    pointeur("pointerdown", el, x0, y0);
    for (let i = 1; i <= 4; i++) pointeur("pointermove", ui, x0 + arguments[1] * i / 4, y0 + arguments[2] * i / 4);
    pointeur("pointerup", ui, x0 + arguments[1], y0 + arguments[2]);`,
    [selection, dx, dy],
  );
}

/** Le texte affiché dans le cadre d'un widget (origine opaque : on lit le document depuis le contexte chrome). */
function texteCadre(m: Marionette, id: string): Promise<string> {
  return inUi(
    m,
    `const f = doc.querySelector('[data-testid="widget-' + arguments[0] + '"] iframe');
     return f?.contentDocument?.body?.textContent ?? "";`,
    [id],
  );
}

/** Les données reçues par l'affichage (le `<pre id="donnees">` de AFFICHAGE_DONNEES), pas tout le corps du cadre. */
function texteDonnees(m: Marionette, id: string): Promise<string> {
  return inUi(
    m,
    `const f = doc.querySelector('[data-testid="widget-' + arguments[0] + '"] iframe');
     return f?.contentDocument?.getElementById("donnees")?.textContent ?? "";`,
    [id],
  );
}

/** Le texte d'une carte de widget : en-tête, bandeau d'accord et avertissements compris. */
function texteWidget(m: Marionette, id: string): Promise<string> {
  return inUi(m, `return doc.querySelector('[data-testid="widget-' + arguments[0] + '"]')?.textContent ?? "";`, [id]);
}

/** « Mettre à jour maintenant » par le menu du widget (comme l'e2e d'Electron). */
async function recolter(m: Marionette, id: string): Promise<void> {
  await click(m, `[data-testid="widget-${id}"] button[aria-label="Options du widget"]`);
  await click(m, '[role="menuitem"]', { text: "Mettre à jour maintenant" });
}

const AFFICHAGE = (titre: string) => `<!doctype html><meta charset="utf-8"><title>${titre}</title><p>${titre}</p>`;

/** Un affichage qui rend les données reçues par postMessage, pour voir arriver une récolte. */
const AFFICHAGE_DONNEES = `<!doctype html><meta charset="utf-8"><pre id="donnees"></pre>
<script>
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || e.data.type !== "widget") return;
    document.getElementById("donnees").textContent = JSON.stringify(e.data.donnees);
  });
</script>`;

describe("la page d'accueil", () => {
  let dataDir: string;
  let w: LaunchedWebAiOs;
  let m: Marionette;
  let notifications: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-accueil-"));
    notifications = path.join(dataDir, "notifications.jsonl");
    await mkdir(path.join(ACCUEIL(dataDir), "widgets"), { recursive: true });
    await ecrireWidget(dataDir, "alpha", { nom: "Alpha", affichage: AFFICHAGE("alpha") });
    await ecrireWidget(dataDir, "beta", { nom: "Beta", affichage: AFFICHAGE("beta") });
    // Un indice réseau dans l'affichage : servi remplacé par AFFICHAGE_REFUSE, avant tout script.
    await ecrireWidget(dataDir, "refus", {
      nom: "Refus",
      affichage: '<!doctype html><title>refus</title><link rel="stylesheet" href="https://exemple.invalid/x.css"><p>jamais</p>',
    });
    // Un lien demandé au chargement (ignoré) et un autre au clic (accepté seulement après un vrai appui).
    await ecrireWidget(dataDir, "lien", {
      nom: "Lien",
      affichage: `<!doctype html><meta charset="utf-8"><title>lien</title><button id="go">ouvrir</button>
<script>
  parent.postMessage({ type: "ouvrir", url: "https://exemple.invalid/auto" }, "*");
  document.getElementById("go").onclick = () => parent.postMessage({ type: "ouvrir", url: "https://exemple.invalid/clic" }, "*");
</script>`,
    });
    // Un widget qui lit avec le compte : le bandeau d'accord paraît tant qu'aucun accord n'est donné. Sa récolte ne lit
    // qu'une fois `config.lire` posé (le test « un autre profil redemande »), pour que l'accord soit en jeu.
    await ecrireWidget(dataDir, "compte", {
      nom: "Compte",
      affichage: AFFICHAGE_DONNEES,
      declaration: {
        recolte: { minutes: 60 },
        sources: { compte: ["exemple.invalid"], publiques: [], web: false },
        config: { lire: false, url: "https://exemple.invalid/x" },
      },
    });
    await ecrireRecolte(
      dataDir,
      "compte",
      `export default async (w) => { if (w.config?.lire) await w.lirePage(w.config.url, { compte: true }); return { vu: "compte" }; };`,
    );
    // Un autre widget à compte : L'utilisateur le refuse (le bandeau ne revient pas de la session).
    await ecrireWidget(dataDir, "sans-accord", {
      nom: "Sans accord",
      affichage: AFFICHAGE_DONNEES,
      declaration: { recolte: { minutes: 60 }, sources: { compte: ["exemple.invalid"], publiques: [], web: false } },
    });
    await ecrireRecolte(dataDir, "sans-accord", `export default async () => ({ secret: "du compte" });`);
    // Une récolte lente : « en cours » reste visible, puis les données arrivent.
    await ecrireWidget(dataDir, "lent", {
      nom: "Lent",
      affichage: AFFICHAGE_DONNEES,
      declaration: { recolte: { minutes: 60 }, sources: { compte: [], publiques: [], web: false } },
    });
    await ecrireRecolte(dataDir, "lent", `export default async () => { await new Promise((r) => setTimeout(r, 2500)); return { fait: Date.now() }; };`);
    // Une récolte qui échoue.
    await ecrireWidget(dataDir, "echec", {
      nom: "Échec",
      affichage: AFFICHAGE_DONNEES,
      declaration: { recolte: { minutes: 60 }, sources: { compte: [], publiques: [], web: false } },
    });
    await ecrireRecolte(dataDir, "echec", `export default async () => { throw new Error("boum"); };`);
    // Une veille qui notifie ses nouveautés (première récolte : les deux éléments sont nouveaux).
    await ecrireWidget(dataDir, "veille", {
      nom: "Veille",
      affichage: AFFICHAGE_DONNEES,
      declaration: { recolte: { minutes: 60, notifier: true }, sources: { compte: [], publiques: [], web: false } },
    });
    await ecrireRecolte(dataDir, "veille", `export default async () => [{ url: "https://exemple.invalid/a" }, { url: "https://exemple.invalid/b" }];`);
    // Un widget avec accord et données, récolté d'avance : le retrait doit emporter les trois.
    await ecrireWidget(dataDir, "retrait", {
      nom: "Retrait",
      affichage: AFFICHAGE_DONNEES,
      declaration: { sources: { compte: ["exemple.invalid"], publiques: [], web: false } },
    });
    const maintenant = new Date().toISOString();
    await ecrireJson(ETAT(dataDir, "retrait"), { statut: "ok", derniereMaj: maintenant, derniereTentative: maintenant });
    await ecrireJson(DONNEES(dataDir, "retrait"), { ancien: "compte" });
    await ecrireJson(ACCORDS(dataDir), { retrait: { domaines: ["exemple.invalid"], publiques: [], profil: "defaut" } });
    await ecrireDisposition(dataDir, [
      { id: "alpha", x: 0, y: 0, l: 250, h: 180 },
      { id: "beta", x: 500, y: 0, l: 250, h: 180 },
      { id: "refus", x: 0, y: 200, l: 250, h: 180 },
      { id: "lien", x: 500, y: 200, l: 250, h: 180 },
      { id: "compte", x: 0, y: 400, l: 250, h: 180 },
      { id: "sans-accord", x: 500, y: 400, l: 250, h: 180 },
      { id: "lent", x: 0, y: 600, l: 250, h: 180 },
      { id: "echec", x: 500, y: 600, l: 250, h: 180 },
      { id: "veille", x: 0, y: 800, l: 250, h: 180 },
      { id: "retrait", x: 500, y: 800, l: 250, h: 180 },
    ]);
    // Une notification de test est un fichier, jamais une bulle macOS.
    w = await launchWebAiOs({ dataDir, env: { WEBAIOS_TEST_NOTIFICATIONS: notifications } });
    m = w.marionette;
    await m.setContext("chrome");
    await waitReady(m);
  });
  afterAll(async () => {
    await w?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("l'écran sans onglet montre les widgets du dossier, servis par webaios-widget:", async () => {
    const titres = await attendre(
      () => inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="titre-widget"]')].map((e) => e.textContent);`),
      (ts) => ts.length === 10,
      "les dix widgets",
      15_000,
    );
    expect(titres).toEqual(["Alpha", "Beta", "Refus", "Lien", "Compte", "Sans accord", "Lent", "Échec", "Veille", "Retrait"]);
    const src = await inUi(m, `return doc.querySelector('[data-testid="widget-alpha"] iframe')?.getAttribute("src") ?? "";`);
    expect(src).toMatch(/^webaios-widget:\/\/alpha\/affichage\.html\?v=\d+$/);
  });

  it("un widget ajouté par l'agent apparaît sans redémarrer", async () => {
    await ecrireWidget(dataDir, "nouveau", { nom: "Nouveau", affichage: AFFICHAGE("nouveau") });
    const titres = await attendre(
      () => inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="titre-widget"]')].map((e) => e.textContent);`),
      (ts) => ts.includes("Nouveau"),
      "le widget ajouté",
    );
    expect(titres).toContain("Nouveau");
  });

  it("glisser un widget ne déplace aucun autre", async () => {
    const avant = await lireDisposition(dataDir);
    const betaAvant = avant.find((p) => p.id === "beta")!;
    // Loin vers la droite : le bord de bêta arrête alpha, qui ne le pousse pas.
    await glisser(m, '[data-testid="widget-alpha"] header', 1200, 0);
    const apres = await attendre(() => lireDisposition(dataDir), (ps) => ps.find((p) => p.id === "alpha")!.x > 0, "l'écriture du glisser");
    const alpha = apres.find((p) => p.id === "alpha")!;
    const beta = apres.find((p) => p.id === "beta")!;
    expect(alpha.x).toBeGreaterThan(0);
    expect(alpha.x + alpha.l).toBeLessThanOrEqual(1000);
    // Il s'arrête au bord gauche de bêta (500) sans le déplacer.
    expect(alpha.x).toBe(250);
    expect(beta).toEqual(betaAvant);
  });

  it("redimensionner reste dans les bornes et ne déborde pas à droite", async () => {
    // Max déclaré : 6 unités de large (500 ‰) et 4 rangées (360 px).
    await glisser(m, '[data-testid="widget-beta"] [data-testid="poignee-taille"]', 600, 300);
    const apres = await attendre(
      () => lireDisposition(dataDir),
      (ps) => {
        const b = ps.find((p) => p.id === "beta")!;
        return b.l > 250 || b.h > 180;
      },
      "l'écriture du redimensionnement",
    );
    const beta = apres.find((p) => p.id === "beta")!;
    expect(beta.l).toBeGreaterThanOrEqual(167); // min : 2 unités
    expect(beta.l).toBeLessThanOrEqual(500); // max : 6 unités
    expect(beta.h).toBeLessThanOrEqual(360);
    expect(beta.x + beta.l).toBeLessThanOrEqual(1000);
  });

  it("un <link> dans l'affichage est remplacé par AFFICHAGE_REFUSE", async () => {
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-refus"] iframe');`, [], 15_000);
    const texte = await attendre(() => texteCadre(m, "refus"), (t) => t.includes("Affichage refusé"), "le refus de l'affichage");
    expect(texte).toContain("Affichage refusé");
    expect(texte).not.toContain("jamais");
  });

  it("le thème de l'agent change les couleurs de l'accueil ; un thème invalide revient au défaut", async () => {
    const fond = () => inUi<string>(m, `return ui.getComputedStyle(doc.querySelector('[data-testid="accueil"]')).backgroundColor;`);
    const defaut = await fond();
    await writeFile(path.join(ACCUEIL(dataDir), "theme.json"), JSON.stringify({ version: 1, fond: "#101014", accent: "#8b7cf6", rayon: 4 }));
    await attendre(fond, (c) => c === "rgb(16, 16, 20)", "le fond du thème");
    await writeFile(path.join(ACCUEIL(dataDir), "theme.json"), "{ pas du json");
    await attendre(fond, (c) => c === defaut, "le retour au thème par défaut");
  });

  it("un lien du widget ne s'ouvre qu'après un vrai appui, jamais au chargement ni par un clic simulé", async () => {
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-lien"] iframe')?.contentDocument?.getElementById("go");`, [], 15_000);
    const urls = async () => Object.values((await state(m)).onglets).map((o) => o.url);
    // L'envoi du chargement : aucun geste, aucun onglet.
    await new Promise((r) => setTimeout(r, 2000));
    expect((await urls()).filter((u) => u.includes("exemple.invalid"))).toEqual([]);
    // Un clic simulé par le script : isTrusted faux, aucun geste, aucun onglet.
    await inUi(m, `doc.querySelector('[data-testid="widget-lien"] iframe').contentDocument.getElementById("go").click();`);
    await new Promise((r) => setTimeout(r, 2000));
    expect((await urls()).filter((u) => u.includes("exemple.invalid"))).toEqual([]);
    // Un vrai appui dans le cadre : l'acteur signale le geste, le lien s'ouvre.
    await inUi(
      m,
      `const f = doc.querySelector('[data-testid="widget-lien"] iframe');
       const b = f.contentDocument.getElementById("go");
       const r = f.getBoundingClientRect(), q = b.getBoundingClientRect();
       const x = r.left + q.left + q.width / 2, y = r.top + q.top + q.height / 2;
       ui.synthesizeMouseEvent("mousedown", x, y, { button: 0, clickCount: 1 });
       ui.synthesizeMouseEvent("mouseup", x, y, { button: 0, clickCount: 1 });`,
    );
    await attendre(urls, (us) => us.includes("https://exemple.invalid/clic"), "l'ouverture du lien");
    expect((await urls()).filter((u) => u.includes("/auto"))).toEqual([]);
    // L'ouverture a activé un onglet : l'accueil n'est plus monté (PageVide). On le referme pour la suite.
    const onglet = Object.entries((await state(m)).onglets).find(([, o]) => o.url.includes("exemple.invalid/clic"))?.[0];
    expect(onglet).toBeDefined();
    await dispatch(m, { type: "fermerOnglet", id: onglet! });
    await waitUi(m, `return !!doc.querySelector('[data-testid="accueil"]') && !!doc.querySelector('[data-testid="widget-alpha"]');`, [], 15_000);
  });

  it("un affichage de widget n'ouvre aucune fenêtre de Firefox", async () => {
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-alpha"] iframe')?.contentDocument;`, [], 15_000);
    await waitWindowCount(m, 1);
    await new Promise((r) => setTimeout(r, 500));
    expect(await waitWindowCount(m, 1)).toHaveLength(1);
    // Aucun <browser> de premier niveau ne charge le schéma : c'est un cadre de la barre latérale.
    const top = await waitFor<number>(m, `return [...gBrowser.browsers].filter((b) => b.currentURI?.spec?.startsWith("webaios-widget:")).length;`, (n) => n === 0);
    expect(top).toBe(0);
  });

  it("la carte d'accord : Autoriser retient le profil choisi et lance la récolte avec le compte", async () => {
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-compte"] [data-testid="bandeau-accord"]');`, [], 15_000);
    expect(await texteWidget(m, "compte")).toContain("exemple.invalid");
    // Rien n'est lu avec le compte tant que l'utilisateur n'a pas accordé.
    expect(existsSync(DONNEES(dataDir, "compte"))).toBe(false);
    await click(m, '[data-testid="widget-compte"] [data-testid="bandeau-accord"] button', { text: "Autoriser…" });
    const carte = await waitUi<string>(m, `const c = doc.querySelector('[data-testid="carte-accord"]'); return c ? c.textContent : "";`);
    expect(carte).toContain("exemple.invalid");
    expect(carte).toContain("ne contactera aucun autre site");
    // Le profil de l'espace actif (le profil par défaut) est coché.
    const profils = await waitUi<[string, boolean][]>(
      m,
      `const rs = [...doc.querySelectorAll('[data-testid="carte-accord"] input[type="radio"]')];
       return rs.length ? rs.map((r) => [r.value, r.checked]) : null;`,
    );
    expect(profils).toEqual([["defaut", true]]);
    await click(m, '[data-testid="carte-accord"] button', { text: "Autoriser" });
    // L'accord nomme les domaines montrés et le profil choisi ; la récolte démarre et ses données arrivent au cadre.
    const accord = await attendre(() => lireAccords(dataDir), (a) => a.compte?.profil === "defaut", "l'écriture de l'accord");
    expect(accord.compte).toEqual({ domaines: ["exemple.invalid"], publiques: [], profil: "defaut" });
    await attendre(() => (existsSync(DONNEES(dataDir, "compte")) ? lireJson<unknown>(DONNEES(dataDir, "compte")) : Promise.resolve(null)), (d) => d !== null, "les données de la récolte");
    expect(await lireJson(DONNEES(dataDir, "compte"))).toEqual({ vu: "compte" });
    await attendre(() => texteDonnees(m, "compte"), (t) => t === '{"vu":"compte"}', "les données dans le cadre");
    expect(await waitUi(m, `return !doc.querySelector('[data-testid="widget-compte"] [data-testid="bandeau-accord"]');`)).toBe(true);
  });

  it("Refuser ne revient pas : le bandeau reste caché après une relecture de la page", async () => {
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-sans-accord"] [data-testid="bandeau-accord"]');`, [], 15_000);
    // Un accord et des données d'avant (comme après un autre profil) : le refus doit vraiment les effacer.
    await ecrireJson(ACCORDS(dataDir), { ...(await lireAccords(dataDir)), "sans-accord": { domaines: ["exemple.invalid"], publiques: [], profil: "defaut" } });
    await ecrireJson(DONNEES(dataDir, "sans-accord"), { secret: "du compte" });
    await click(m, '[data-testid="widget-sans-accord"] [data-testid="bandeau-accord"] button', { text: "Refuser" });
    expect(await waitUi(m, `return !doc.querySelector('[data-testid="widget-sans-accord"] [data-testid="bandeau-accord"]');`)).toBe(true);
    // Un widget ajouté force une relecture (accueil.change) : le refus vaut pour la session, le bandeau ne revient pas.
    await ecrireWidget(dataDir, "temoin", { nom: "Témoin", affichage: AFFICHAGE("témoin") });
    await attendre(
      () => inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="titre-widget"]')].map((e) => e.textContent);`),
      (ts) => ts.includes("Témoin"),
      "la relecture après le refus",
    );
    expect(await inUi<boolean>(m, `return !!doc.querySelector('[data-testid="widget-sans-accord"] [data-testid="bandeau-accord"]');`)).toBe(false);
    await attendre(() => lireAccords(dataDir), (a) => a["sans-accord"] === undefined, "le retrait de l'accord refusé");
    expect(existsSync(DONNEES(dataDir, "sans-accord"))).toBe(false);
    expect(await lireJson<{ statut: string }>(ETAT(dataDir, "sans-accord"))).toMatchObject({ statut: "accord-requis" });
  });

  it("un accord qui nomme un profil invalide redemande : la récolte le refuse, l'accord et ses données partent", async () => {
    // L'accord nomme un profil de connexion ; un profil absent de la session le rend inutilisable. (Un profil qui
    // devient privé ne redemande qu'à la prochaine récolte planifiée du widget : voir la limite du README.)
    const declaration = await lireJson<Record<string, unknown>>(path.join(ACCUEIL(dataDir), "widgets", "compte", "widget.json"));
    await ecrireJson(path.join(ACCUEIL(dataDir), "widgets", "compte", "widget.json"), { ...declaration, config: { lire: true, url: "https://exemple.invalid/x" } });
    await ecrireJson(ACCORDS(dataDir), { ...(await lireAccords(dataDir)), compte: { domaines: ["exemple.invalid"], publiques: [], profil: "absent" } });
    await recolter(m, "compte");
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-compte"] [data-testid="bandeau-accord"]');`, [], 20_000);
    expect((await lireAccords(dataDir)).compte).toBeUndefined();
    expect(existsSync(DONNEES(dataDir, "compte"))).toBe(false);
    expect(await lireJson<{ statut: string }>(ETAT(dataDir, "compte"))).toMatchObject({ statut: "accord-requis" });
    // La nouvelle demande propose de nouveau un profil.
    await click(m, '[data-testid="widget-compte"] [data-testid="bandeau-accord"] button', { text: "Autoriser…" });
    const profils = await waitUi<[string, boolean][]>(m, `return [...doc.querySelectorAll('[data-testid="carte-accord"] input[type="radio"]')].map((r) => [r.value, r.checked]);`);
    expect(profils.map(([id]) => id)).toContain("defaut");
    await click(m, '[data-testid="carte-accord"] button', { text: "Annuler" });
  });

  it("une récolte à la main passe par « en cours » puis remplit le widget", async () => {
    const data = () => (existsSync(DONNEES(dataDir, "lent")) ? lireJson<{ fait: number }>(DONNEES(dataDir, "lent")) : Promise.resolve(null));
    await attendre(data, (d) => d !== null, "les données du lancement", 20_000);
    const avant = await attendre(
      async () => {
        try {
          return JSON.parse(await texteDonnees(m, "lent")) as { fait: number };
        } catch {
          return null;
        }
      },
      (d) => d !== null,
      "les données dans le cadre",
    );
    await recolter(m, "lent");
    // L'état « en cours » est écrit avant le conteneur : le badge reste visible pendant la récolte lente.
    await waitUi(m, `return (doc.querySelector('[data-testid="widget-lent"] header')?.textContent ?? '').includes('mise à jour…');`, [], 10_000);
    const apres = await attendre(
      async () => {
        try {
          return JSON.parse(await texteDonnees(m, "lent")) as { fait: number };
        } catch {
          return null;
        }
      },
      (d) => d !== null && d.fait > avant!.fait,
      "les nouvelles données dans le cadre",
      20_000,
    );
    expect(apres!.fait).toBeGreaterThan(avant!.fait);
  });

  it("une récolte en échec le dit et ne laisse pas de données", async () => {
    const texte = await attendre(() => texteWidget(m, "echec"), (t) => t.includes("échec du") && t.includes("boum"), "l'échec de la récolte", 20_000);
    expect(texte).toContain("échec du");
    expect(existsSync(DONNEES(dataDir, "echec"))).toBe(false);
    expect(await lireJson<{ statut: string; erreur: string }>(ETAT(dataDir, "echec"))).toMatchObject({ statut: "erreur", erreur: "boum" });
  });

  it("une récolte de nouveautés écrit sa notification dans WEBAIOS_TEST_NOTIFICATIONS", async () => {
    const lignes = await attendre(
      async () => ((existsSync(notifications) ? (await readFile(notifications, "utf8")).trim().split("\n").filter(Boolean) : []).map((l) => JSON.parse(l) as { titre: string; texte: string })),
      (ls) => ls.some((n) => n.titre === "Veille"),
      "la notification de nouveautés",
      20_000,
    );
    expect(lignes).toContainEqual({ titre: "Veille", texte: "2 nouveaux éléments" });
  });

  it("Retirer : le dossier part dans .corbeille, l'accord et les données sont effacés", async () => {
    // Le widget a un accord et des données avant le retrait.
    expect(existsSync(path.join(ACCUEIL(dataDir), "widgets", "retrait"))).toBe(true);
    expect((await lireAccords(dataDir)).retrait).toBeDefined();
    expect(existsSync(DONNEES(dataDir, "retrait"))).toBe(true);
    await click(m, '[data-testid="widget-retrait"] button[aria-label="Options du widget"]');
    await click(m, '[role="menuitem"]', { text: "Retirer" });
    const confirmation = await waitUi<string>(m, `const d = doc.querySelector('[data-testid="confirmation-retrait"]'); return d ? d.textContent : "";`);
    expect(confirmation).toContain("Retirer « Retrait » de la page d'accueil ?");
    await click(m, '[data-testid="confirmation-retrait"] button', { text: "Retirer" });
    await waitUi(m, `return !doc.querySelector('[data-testid="widget-retrait"]');`, [], 15_000);
    const corbeille = await attendre(
      () => readdir(path.join(ACCUEIL(dataDir), ".corbeille")).catch(() => [] as string[]),
      (noms) => noms.some((n) => n.startsWith("retrait-")),
      "le dossier du widget dans la corbeille",
    );
    expect(corbeille.some((n) => n.startsWith("retrait-"))).toBe(true);
    expect(existsSync(path.join(ACCUEIL(dataDir), "widgets", "retrait"))).toBe(false);
    // Le host retire l'accord puis les données : les deux ensemble.
    await attendre(
      async () => ({ accord: (await lireAccords(dataDir)).retrait, donnees: existsSync(DONNEES(dataDir, "retrait")) }),
      (v) => v.accord === undefined && !v.donnees,
      "le retrait de l'accord et des données",
    );
  });

  it("host arrêté : les actions restent sans effet et la page reste affichée", async () => {
    await m.execute(`return (async () => { await window.webaiosWindow.store.agent.stop(); return true; })();`);
    await waitFor<number | null>(m, `return window.webaiosWindow.store.agent.pid;`, (pid) => pid === null);
    await recolter(m, "veille");
    const texte = await attendre(() => texteWidget(m, "veille"), (t) => t.includes("Sans effet pour l'instant"), "l'avertissement sans effet", 12_000);
    expect(texte).toContain("le service des widgets ne répond pas");
    // Les widgets restent affichés, cadres compris.
    expect(await inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="titre-widget"]')].map((e) => e.textContent);`)).toContain("Veille");
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-veille"] iframe');`);
  });
});

describe("la page d'accueil, atelier arrêté", () => {
  let dataDir: string;
  let w: LaunchedWebAiOs;
  let m: Marionette;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-accueil-atelier-"));
    await mkdir(path.join(ACCUEIL(dataDir), "widgets"), { recursive: true });
    await ecrireWidget(dataDir, "veille", {
      nom: "Veille",
      affichage: AFFICHAGE_DONNEES,
      declaration: { recolte: { minutes: 60 }, sources: { compte: [], publiques: [], web: false } },
    });
    await ecrireRecolte(dataDir, "veille", `export default async () => [{ url: "https://exemple.invalid/a" }];`);
    // Des données d'une récolte d'avant, et un état dû : la vérification du lancement doit les garder.
    await ecrireJson(DONNEES(dataDir, "veille"), { vieux: true });
    await ecrireJson(ETAT(dataDir, "veille"), { statut: "ok", derniereMaj: "2026-01-01T00:00:00.000Z", derniereTentative: "2026-01-01T00:00:00.000Z" });
    await ecrireDisposition(dataDir, [{ id: "veille", x: 0, y: 0, l: 250, h: 180 }]);
    w = await launchWebAiOs({ dataDir, env: { FAUX_DOCKER_ABSENT: "1" } });
    m = w.marionette;
    await m.setContext("chrome");
    await waitReady(m);
  });
  afterAll(async () => {
    await w?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("sans atelier, la récolte ne tourne pas : « atelier arrêté », les données gardées", async () => {
    await attendre(() => texteWidget(m, "veille"), (t) => t.includes("mise à jour impossible : atelier arrêté"), "l'atelier arrêté", 20_000);
    expect(await lireJson(DONNEES(dataDir, "veille"))).toEqual({ vieux: true });
    // « Mettre à jour maintenant » ne lance rien non plus : rien ne change, l'interface le dit après son délai.
    await recolter(m, "veille");
    await attendre(() => texteWidget(m, "veille"), (t) => t.includes("Sans effet pour l'instant"), "l'action sans effet", 12_000);
    expect(await lireJson<{ statut: string }>(ETAT(dataDir, "veille"))).toMatchObject({ statut: "atelier-arrete" });
    expect(await lireJson(DONNEES(dataDir, "veille"))).toEqual({ vieux: true });
    // La page reste affichée.
    expect(await inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="titre-widget"]')].map((e) => e.textContent);`)).toEqual(["Veille"]);
  });
});
