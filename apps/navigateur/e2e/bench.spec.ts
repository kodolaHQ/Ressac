import { expect, test } from "@playwright/test";
import { dansLaVue, lancer, ouvrirOnglet, serveurTest } from "./aide";

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
