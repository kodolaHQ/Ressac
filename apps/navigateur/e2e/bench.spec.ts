import { expect, test } from "@playwright/test";
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

const titre = (app: Parameters<typeof dansLaVue>[0], n: number) => dansLaVue(app, `?n=${n}`, "document.title") as Promise<string | undefined>;
/** Whether the page's rAF runs, within 1 s. */
const rafTourne = (app: Parameters<typeof dansLaVue>[0], n: number) =>
  dansLaVue(app, `?n=${n}`, "new Promise((r) => { requestAnimationFrame(() => r(true)); setTimeout(() => r(false), 1000); })");

test("probe: a tab shown again fires visibilitychange and two rAF", async () => {
  // In a hidden window a background tab stays "visible" with rAF running, so the signal never fires (plan 22, task 1):
  // this probe only checks the headed bench pass, which shows a window.
  test.skip(!process.env.WEBAIOS_BENCH_HEADED, "headed bench pass only");
  const { app, fenetre, fermer } = await lancer({ visible: true });
  try {
    await ouvrirOnglet(fenetre, `${serveur.url}/bench-visible.html?n=1`);
    await expect.poll(() => titre(app, 1)).toBe("n1");
    await ouvrirOnglet(fenetre, `${serveur.url}/bench-visible.html?n=2`);
    await expect.poll(() => titre(app, 2)).toBe("n2");
    const avant = { visibilityState: await dansLaVue(app, "?n=1", "document.visibilityState"), rafHiddenTab: await rafTourne(app, 1) };
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("onglet-1")!.click());
    const vu = await expect
      .poll(() => titre(app, 1), { timeout: 5_000 })
      .toMatch(/^v\d+$/)
      .then(() => true, () => false);
    console.log(
      "probe E:",
      JSON.stringify({
        signal: vu,
        avant,
        titre: await titre(app, 1),
        visibilityState: await dansLaVue(app, "?n=1", "document.visibilityState"),
        rafShownTab: await rafTourne(app, 1),
      }),
    );
    expect(vu).toBe(true);
  } finally {
    await fermer();
  }
});

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
async function lancerBench(o: { racine?: string; profil?: string } = {}) {
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
