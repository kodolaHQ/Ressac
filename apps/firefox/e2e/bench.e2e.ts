import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Action } from "../../navigateur/src/commun/api";
import type { BenchFile } from "../scripts/bench-stats";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import { callTool } from "./mcp";
import { startServer } from "./server";
import { waitUi } from "./ui";

const STORE = "chrome://browser/content/webaios/store.sys.mjs";

// Benchmarks: run only with WEBAIOS_BENCH (see docs/superpowers/notes/2026-11-04-point-de-controle-firefox.md).
describe.skipIf(!process.env.WEBAIOS_BENCH)("bench", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let w: LaunchedWebAiOs | undefined;
  beforeAll(async () => (server = await startServer()));
  afterAll(() => server?.close());
  afterEach(() => w?.close());

  const ready = (l: LaunchedWebAiOs) =>
    waitFor(l.marionette, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);

  /** Same layout as Electron's ecrireWidget / ecrireEtatWidget (e2e/aide.ts): fresh state, so no harvest at launch. */
  const writeWidget = (dataDir: string, code: string) => {
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
    writeFileSync(join(widget, "recolte.mjs"), code);
    mkdirSync(join(dataDir, "widgets", "bench-lecture"), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(join(dataDir, "widgets", "bench-lecture", "etat.json"), JSON.stringify({ statut: "ok", derniereMaj: now, derniereTentative: now }));
  };

  /** The switch benches (and their probe) show a window in the visible pass; the reads always stay headless. */
  const headed = !!process.env.WEBAIOS_BENCH_HEADED;

  /** Launches with local addresses allowed, waits for the UI and the agent (so the MCP answers), then one second of calm. */
  const launchBench = async (o: { dataDir?: string; headed?: boolean } = {}) => {
    w = await launchWebAiOs({ ...o, env: { WEBAIOS_TEST_ADRESSES_LOCALES: "1" } });
    await w.marionette.setContext("chrome");
    await ready(w);
    await waitUi(w.marionette, "return doc.querySelector('.xterm-rows')?.textContent.includes('prêt>')", [], 20_000, "agent");
    await new Promise((r) => setTimeout(r, 1_000));
    return w;
  };

  /** Merges one measure into WEBAIOS_BENCH_OUT (a BenchFile, scripts/bench-stats.ts). */
  const record = (name: string, xs: number[]) => {
    console.log(`bench F ${name}:`, JSON.stringify(xs));
    const out = process.env.WEBAIOS_BENCH_OUT;
    if (!out) return;
    const measures = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as BenchFile).measures : {};
    const file: BenchFile = { app: "firefox", headed: !!process.env.WEBAIOS_BENCH_HEADED, measures: { ...measures, [name]: xs } };
    writeFileSync(out, JSON.stringify(file));
  };

  it("probe: a tab shown again fires visibilitychange and two rAF", async () => {
    w = await launchWebAiOs({ headed });
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
      writeWidget(dataDir, "export default async (webaios) => ({ titre: (await webaios.lirePage(`${webaios.config.base}/texte.html`)).titre });");
      await launchBench({ dataDir });
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

  it("bench: invisible read", async () => {
    const dataDir = mkdtempSync(join(os.tmpdir(), "webaios-data-"));
    try {
      writeWidget(
        dataDir,
        `export default async (webaios) => {
  const ms = [];
  for (let k = 0; k < 11; k++) {
    const t = Date.now();
    await webaios.lirePage(\`\${webaios.config.base}/texte.html?i=\${Date.now()}-\${k}\`);
    ms.push(Date.now() - t);
  }
  return { ms };
};`,
      );
      await launchBench({ dataDir });
      // Two harvests of 11 reads: one of 22 takes about 46 s, close to the MCP SDK's 60 s request timeout.
      const ms: number[] = [];
      for (let call = 0; call < 2; call++) {
        const r = await callTool(dataDir, "recolter_widget", { id: "bench-lecture" });
        const result = JSON.parse(r.texte.slice(r.texte.indexOf("\n") + 1));
        expect(result.statut, r.texte).toBe("ok");
        expect(result.donnees.ms).toHaveLength(11);
        ms.push(...result.donnees.ms);
      }
      // The first 2 reads are the warm-up.
      record("invisibleRead", ms.slice(2));
    } finally {
      await w?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 300_000);

  it("bench: lire_onglet on an agent tab", async () => {
    const l = await launchBench();
    const { texte: id, erreur } = await callTool(l.dataDir, "ouvrir_onglet", { url: `${server.url}/texte.html` });
    expect(erreur, id).toBe(false);
    for (const deadline = Date.now() + 10_000; (await state(l.marionette)).onglets[id]?.titre !== "Texte"; await new Promise((r) => setTimeout(r, 100)))
      if (Date.now() > deadline) throw new Error("agent tab did not load");
    const ms: number[] = [];
    for (let k = 0; k < 33; k++) {
      const t = performance.now();
      const lu = await callTool(l.dataDir, "lire_onglet", { id });
      ms.push(performance.now() - t);
      expect(lu.texte).toContain("Le chat dort");
    }
    record("tabRead", ms.slice(3));
  }, 300_000);

  /** Opens a tab in the active space and returns its id. */
  const openTab = async (m: LaunchedWebAiOs["marionette"], url: string, activer = true) => {
    const before = new Set(Object.keys((await state(m)).onglets));
    const action: Action = { type: "ouvrirOnglet", fenetreId: (await state(m)).fenetres[0]!.id, url, activer };
    return Object.keys((await dispatch(m, action)).onglets).find((id) => !before.has(id))!;
  };
  const waitTitle = async (m: LaunchedWebAiOs["marionette"], id: string, ok: (t: string | undefined) => boolean, what: string) => {
    for (const deadline = Date.now() + 10_000; ; await new Promise((r) => setTimeout(r, 10))) {
      const t = (await state(m)).onglets[id]?.titre;
      if (ok(t)) return t!;
      if (Date.now() > deadline) throw new Error(`${what}: last title ${t}`);
    }
  };

  /**
   * Dispatches `action` from chrome and returns the time from the dispatch to the `v<ms>` the target page writes once
   * shown, plus the time spent in store.containerFor during the dispatch (when the bench wraps it).
   */
  const switchTo = async (m: LaunchedWebAiOs["marionette"], action: Action, target: string) => {
    const { t, container } = await m.execute<{ t: number; container: number }>(
      `return (async () => {
        const store = await ChromeUtils.importESModule("${STORE}").ready;
        const c0 = store.benchContainerMs ?? 0;
        const t = performance.timeOrigin + performance.now();
        store.dispatch(arguments[0]);
        return { t, container: (store.benchContainerMs ?? 0) - c0 };
      })();`,
      [action],
    );
    const shown = await waitTitle(m, target, (s) => /^v\d+$/.test(s ?? "") && Number(s!.slice(1)) >= Math.floor(t), `tab ${target} not shown`);
    return { ms: Number(shown.slice(1)) - t, container };
  };

  it("bench: tab switch", async () => {
    const m = (await launchBench({ headed })).marionette;
    const ids = [await openTab(m, `${server.url}/bench-visible.html?n=1`), await openTab(m, `${server.url}/bench-visible.html?n=2`)];
    await waitTitle(m, ids[0]!, (t) => t === "n1", "tab 1 did not load");
    await waitTitle(m, ids[1]!, (t) => t === "n2", "tab 2 did not load");
    // TabSync.containerOf calls store.containerFor (a property of the store) on every dispatch: time it, then restore.
    await m.execute(`return (async () => {
      const store = await ChromeUtils.importESModule("${STORE}").ready;
      const original = store.containerFor;
      store.benchOriginalContainerFor = original;
      store.benchContainerMs = 0;
      store.benchContainerCalls = 0;
      store.containerFor = (...a) => {
        const t = performance.now();
        try { return original.apply(store, a); } finally { store.benchContainerMs += performance.now() - t; store.benchContainerCalls++; }
      };
    })();`);
    try {
      const ms: number[] = [];
      const container: number[] = [];
      // Tab 2 is shown: 2 round trips of warm-up (4 switches), then 50.
      for (let k = 0; k < 54; k++) {
        const id = ids[k % 2]!;
        const r = await switchTo(m, { type: "activerOnglet", id }, id);
        if (k < 4) continue;
        ms.push(r.ms);
        container.push(r.container);
      }
      expect(await m.execute(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).benchContainerCalls)();`)).toBeGreaterThan(0);
      record("tabSwitch", ms);
      record("containerForPerDispatch", container);
    } finally {
      await m.execute(`return (async () => {
        const store = await ChromeUtils.importESModule("${STORE}").ready;
        store.containerFor = store.benchOriginalContainerFor;
        for (const k of ["benchOriginalContainerFor", "benchContainerMs", "benchContainerCalls"]) delete store[k];
      })();`);
    }
  }, 300_000);

  it("bench: cold tab switch", async () => {
    const m = (await launchBench({ headed })).marionette;
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) ids.push(await openTab(m, `${server.url}/bench-visible.html?n=c${i}&cold`, false));
    const ms: number[] = [];
    for (const id of ids) ms.push((await switchTo(m, { type: "activerOnglet", id }, id)).ms);
    record("tabSwitchCold", ms);
  }, 300_000);

  it("bench: space switch", async () => {
    const m = (await launchBench({ headed })).marionette;
    const fenetreId = (await state(m)).fenetres[0]!.id;
    const tabs = [await openTab(m, `${server.url}/bench-visible.html?n=1`)];
    await dispatch(m, { type: "creerEspace", nom: "Bench", icone: "💼", prive: false, profil: "defaut", fenetreId });
    tabs.push(await openTab(m, `${server.url}/bench-visible.html?n=2`));
    await waitTitle(m, tabs[0]!, (t) => t === "n1", "tab 1 did not load");
    await waitTitle(m, tabs[1]!, (t) => t === "n2", "tab 2 did not load");
    const s = await state(m);
    const spaces = s.espaces.map((e) => e.id);
    expect(spaces).toHaveLength(2);
    expect(s.fenetres[0]!.espaceActif).toBe(spaces[1]);
    const ms: number[] = [];
    // Space 2 is shown: 2 alternations of warm-up, then 50.
    for (let k = 0; k < 52; k++) {
      const r = await switchTo(m, { type: "activerEspace", fenetreId, id: spaces[k % 2]! }, tabs[k % 2]!);
      if (k >= 2) ms.push(r.ms);
    }
    record("spaceSwitch", ms);
  }, 300_000);
});
