import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { state, waitFor, waitReady, waitWindowCount } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { inUi, waitUi } from "./ui";

// La page d'accueil dans la barre latérale : widgets du dossier, placement libre, thème de l'agent, cadre isolé et liens.
// Écrit ici par la tâche 7 ; les accords, la récolte et le retrait sont complétés par la tâche 8.
// Non lancé par la tâche 7 (pas de build ni de moteur dans ce worktree) : à lancer après `pnpm build:ui` par l'utilisateur.

interface PlacementTest {
  id: string;
  x: number;
  y: number;
  l: number;
  h: number;
}

const RACINE = (dataDir: string) => path.join(dataDir, "espace");
const ACCUEIL = (dataDir: string) => path.join(RACINE(dataDir), "accueil");

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

async function ecrireDisposition(dataDir: string, widgets: PlacementTest[]): Promise<void> {
  await writeFile(path.join(ACCUEIL(dataDir), "disposition.json"), JSON.stringify({ version: 3, widgets }));
}

async function lireDisposition(dataDir: string): Promise<PlacementTest[]> {
  return JSON.parse(await readFile(path.join(ACCUEIL(dataDir), "disposition.json"), "utf8")).widgets;
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

const AFFICHAGE = (titre: string) => `<!doctype html><meta charset="utf-8"><title>${titre}</title><p>${titre}</p>`;

describe("la page d'accueil", () => {
  let dataDir: string;
  let w: LaunchedWebAiOs;
  let m: Marionette;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-accueil-"));
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
    await ecrireDisposition(dataDir, [
      { id: "alpha", x: 0, y: 0, l: 250, h: 180 },
      { id: "beta", x: 500, y: 0, l: 250, h: 180 },
      { id: "refus", x: 0, y: 200, l: 250, h: 180 },
      { id: "lien", x: 500, y: 200, l: 250, h: 180 },
    ]);
    w = await launchWebAiOs({ dataDir });
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
      (ts) => ts.length === 4,
      "les quatre widgets",
      15_000,
    );
    expect(titres).toEqual(["Alpha", "Beta", "Refus", "Lien"]);
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
});
