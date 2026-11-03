import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Action } from "../../navigateur/src/commun/api";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import { callTool } from "./mcp";
import { startServer } from "./server";
import { waitUi } from "./ui";

// Benchmarks: run only with WEBAIOS_BENCH (see docs/superpowers/notes/2026-11-04-point-de-controle-firefox.md).
describe.skipIf(!process.env.WEBAIOS_BENCH)("bench", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let w: LaunchedWebAiOs | undefined;
  beforeAll(async () => (server = await startServer()));
  afterAll(() => server?.close());
  afterEach(() => w?.close());

  const ready = (l: LaunchedWebAiOs) =>
    waitFor(l.marionette, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);

  it("probe: a tab shown again fires visibilitychange and two rAF", async () => {
    w = await launchWebAiOs();
    const m = w.marionette;
    await m.setContext("chrome");
    await ready(w);
    const open = async (n: number) => {
      const before = new Set(Object.keys((await state(m)).onglets));
      const action: Action = { type: "ouvrirOnglet", fenetreId: (await state(m)).fenetres[0]!.id, url: `${server.url}/bench-visible.html?n=${n}` };
      const id = Object.keys((await dispatch(m, action)).onglets).find((id) => !before.has(id))!;
      for (const deadline = Date.now() + 10_000; (await state(m)).onglets[id]?.titre !== `n${n}`; await new Promise((r) => setTimeout(r, 100)))
        if (Date.now() > deadline) throw new Error(`tab ${n} did not load`);
      return id;
    };
    const first = await open(1);
    await open(2);
    await dispatch(m, { type: "activerOnglet", id: first });
    let title: string | undefined;
    for (const deadline = Date.now() + 5_000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 50))) {
      title = (await state(m)).onglets[first]?.titre;
      if (title?.startsWith("v")) break;
    }
    console.log("probe F:", JSON.stringify({ title }));
    expect(title).toMatch(/^v\d+$/);
  });

  it("probe: Firefox harvests a public widget", async () => {
    const dataDir = mkdtempSync(join(os.tmpdir(), "webaios-data-"));
    try {
      // Same layout as Electron's ecrireWidget / ecrireEtatWidget (e2e/aide.ts): fresh state, so no harvest at launch.
      const widget = join(dataDir, "espace", "accueil", "widgets", "bench-lecture");
      mkdirSync(widget, { recursive: true });
      writeFileSync(
        join(widget, "widget.json"),
        JSON.stringify({
          nom: "Bench lecture",
          tailles: { min: { l: 2, h: 2 }, max: { l: 12, h: 8 }, defaut: { l: 4, h: 3 } },
          recolte: { minutes: 60, dureeMaxMinutes: 5 },
          sources: { compte: [], publiques: ["127.0.0.1"] },
          config: { base: server.url },
        }),
      );
      writeFileSync(
        join(widget, "recolte.mjs"),
        "export default async (webaios) => ({ titre: (await webaios.lirePage(`${webaios.config.base}/texte.html`)).titre });",
      );
      mkdirSync(join(dataDir, "widgets", "bench-lecture"), { recursive: true });
      const now = new Date().toISOString();
      writeFileSync(join(dataDir, "widgets", "bench-lecture", "etat.json"), JSON.stringify({ statut: "ok", derniereMaj: now, derniereTentative: now }));

      w = await launchWebAiOs({ dataDir, env: { WEBAIOS_TEST_ADRESSES_LOCALES: "1" } });
      const m = w.marionette;
      await m.setContext("chrome");
      await ready(w);
      await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('prêt>')", [], 20_000, "agent");
      const r = await callTool(dataDir, "recolter_widget", { id: "bench-lecture" });
      console.log("probe F harvest:", r.texte);
      const result = JSON.parse(r.texte.slice(r.texte.indexOf("\n") + 1));
      expect(result.statut).toBe("ok");
      expect(result.donnees.titre).toBe("Texte");
    } finally {
      await w?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
