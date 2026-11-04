import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appelerOutil,
  dansLaVue,
  ecrireEtatWidget,
  ecrireWidget,
  lancer,
  nouveauProfil,
  nouvelleRacine,
  ouvrirOnglet,
  serveurTest,
  terminal,
} from "./aide";

// Benchmarks: run only with WEBAIOS_BENCH (see docs/superpowers/notes/2026-11-04-point-de-controle-firefox.md).
test.skip(!process.env.WEBAIOS_BENCH, "bench only");

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => (serveur = await serveurTest()));
test.afterAll(() => serveur.fermer());

/** Merges one measure into WEBAIOS_BENCH_OUT (same JSON as apps/firefox/scripts/bench-stats.ts BenchFile). */
function record(name: string, xs: number[]): void {
  console.log(`bench E ${name}:`, JSON.stringify(xs));
  const out = process.env.WEBAIOS_BENCH_OUT;
  if (!out) return;
  const measures = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")).measures : {};
  writeFileSync(out, JSON.stringify({ app: "electron", headed: !!process.env.WEBAIOS_BENCH_HEADED, measures: { ...measures, [name]: xs } }));
}

const pret = (racine: string) => expect.poll(() => existsSync(join(racine, ".webaios", "mcp.json"))).toBe(true);

/** Launches with local addresses allowed, waits for the MCP server and the agent, then one second of calm. */
async function lancerBench(o: { racine?: string; profil?: string; visible?: boolean } = {}) {
  const l = await lancer({ ...o, env: { WEBAIOS_TEST_ADRESSES_LOCALES: "1" } });
  await pret(l.racine);
  await expect(terminal(l.fenetre)).toContainText("faux agent prêt>", { timeout: 20_000 });
  await new Promise((r) => setTimeout(r, 1_000));
  return l;
}

test("bench: invisible read", async () => {
  test.setTimeout(300_000);
  const racine = nouvelleRacine();
  const profil = nouveauProfil();
  ecrireWidget(racine, "bench-lecture", {
    nom: "Bench lecture",
    recolte: { minutes: 60, dureeMaxMinutes: 5 },
    sources: { publiques: ["127.0.0.1"] },
    config: { base: serveur.url },
    code: `export default async (webaios) => {
  const ms = [];
  for (let k = 0; k < 11; k++) {
    const t = Date.now();
    await webaios.lirePage(\`\${webaios.config.base}/texte.html?i=\${Date.now()}-\${k}\`);
    ms.push(Date.now() - t);
  }
  return { ms };
};`,
  });
  ecrireEtatWidget(profil, "bench-lecture");
  const { fermer } = await lancerBench({ racine, profil });
  try {
    // Two harvests of 11 reads: one of 22 takes about 46 s, close to the MCP SDK's 60 s request timeout.
    const ms: number[] = [];
    for (let call = 0; call < 2; call++) {
      const r = await appelerOutil(racine, "recolter_widget", { id: "bench-lecture" });
      const result = JSON.parse(r.texte.slice(r.texte.indexOf("\n") + 1));
      expect(result.statut, r.texte).toBe("ok");
      expect(result.donnees.ms).toHaveLength(11);
      ms.push(...result.donnees.ms);
    }
    // The first 2 reads are the warm-up.
    record("invisibleRead", ms.slice(2));
  } finally {
    await fermer();
  }
});

test("bench: lire_onglet on an agent tab", async () => {
  test.setTimeout(300_000);
  const { app, racine, fermer } = await lancerBench();
  try {
    const { texte: id, erreur } = await appelerOutil(racine, "ouvrir_onglet", { url: `${serveur.url}/texte.html` });
    expect(erreur, id).toBe(false);
    await expect.poll(() => dansLaVue(app, "texte.html", "document.title")).toBe("Texte");
    const ms: number[] = [];
    for (let k = 0; k < 33; k++) {
      const t = performance.now();
      const lu = await appelerOutil(racine, "lire_onglet", { id });
      ms.push(performance.now() - t);
      expect(lu.texte).toContain("Le chat dort");
    }
    record("tabRead", ms.slice(3));
  } finally {
    await fermer();
  }
});

// The switch benches need a shown window: hidden, every view reports "visible" and no page signal fires, and capturePage
// of a detached view still returns its pixels (plan 22, task 4). They run only in the visible pass.
const headed = !!process.env.WEBAIOS_BENCH_HEADED;

type EtatBench = {
  espaces: { id: string; epingles: unknown[] }[];
  fenetres: { espaceActif: string; ordre: Record<string, string[]> }[];
  onglets: Record<string, { url: string }>;
};
/** The state, as the interface receives it. */
const etat = (fenetre: Page) =>
  fenetre.evaluate(
    () =>
      new Promise<EtatBench>((ok) => {
        const w = window as unknown as { webaios: { surEtat(r: (e: EtatBench) => void): () => void } };
        const fin = w.webaios.surEtat((e) => {
          setTimeout(() => fin());
          ok(e);
        });
      }),
  );
/** The ⌘N menu item that shows the tab whose URL contains `morceau` (pinned items come first, as in versNieme). */
async function itemOnglet(fenetre: Page, morceau: string): Promise<string> {
  const e = await etat(fenetre);
  const f = e.fenetres[0]!;
  const espace = e.espaces.find((x) => x.id === f.espaceActif)!;
  const n = espace.epingles.length + (f.ordre[espace.id] ?? []).findIndex((id) => e.onglets[id]!.url.includes(morceau)) + 1;
  expect(n, morceau).toBeGreaterThan(espace.epingles.length);
  expect(n).toBeLessThan(9);
  return `onglet-${n}`;
}

/** Clicks a menu item in the main process; returns the time from the click to the `v<ms>` of the page shown. */
// Warm tab and space switches are Firefox-only: a hidden Electron view still reports "visible" with rAF running, even
// headed (plan 22 visible pass), so the page has no signal for being shown again.
async function basculer(app: ElectronApplication, item: string, morceau: string): Promise<number> {
  const t = await app.evaluate(({ Menu }, item) => {
    const t = performance.timeOrigin + performance.now();
    Menu.getApplicationMenu()!.getMenuItemById(item)!.click();
    return t;
  }, item);
  for (const fin = Date.now() + 10_000; ; await new Promise((r) => setTimeout(r, 10))) {
    const titre = (await dansLaVue(app, morceau, "document.title")) as string | undefined;
    if (/^v\d+$/.test(titre ?? "") && Number(titre!.slice(1)) >= Math.floor(t)) return Number(titre!.slice(1)) - t;
    if (Date.now() > fin) throw new Error(`${morceau} not shown after ${item}: last title ${titre}`);
  }
}

test("bench: cold tab switch", async () => {
  test.skip(!headed, "visible pass only");
  test.setTimeout(300_000);
  const { app, fenetre, fermer } = await lancerBench({ visible: headed });
  try {
    const pages = [1, 2, 3, 4, 5].map((i) => `bench-visible.html?n=c${i}&cold`);
    for (const p of pages) await ouvrirOnglet(fenetre, `${serveur.url}/${p}`, { activer: false });
    await expect.poll(async () => Object.keys((await etat(fenetre)).onglets).length).toBeGreaterThanOrEqual(5);
    const ms: number[] = [];
    for (const p of pages) ms.push(await basculer(app, await itemOnglet(fenetre, p), p));
    record("tabSwitchCold", ms);
  } finally {
    await fermer();
  }
});
