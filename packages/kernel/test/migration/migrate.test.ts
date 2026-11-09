import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { readResult } from "../../src/actions/data.js";
import { ComponentDeclaration } from "../../src/pages/agent-components.js";
import { readExtensionsState } from "../../src/extensions/registry.js";
import { hashOf, readFolder } from "../../src/extensions/copy.js";
import { DeclarationWidget, WidgetState } from "../../src/home/schemas.js";
import { HomeTheme } from "../../src/home/theme.js";
import { readHome } from "../../src/home/read.js";
import { Manifest } from "../../src/applications/manifest.js";
import { Profile } from "../../src/profiles/profile.js";
import { readSiteGrants, siteExtensionsHash } from "../../src/sites/grants.js";
import { DeclarationSite } from "../../src/sites/schemas.js";
import { readUrlState } from "../../src/sites/tracking.js";
import { readGrants } from "../../src/widgets/grants.js";
import { Execution } from "../../src/workflows/executions.js";
import { paramsHash, readMemory } from "../../src/workflows/memory.js";
import { BLOCK_REGISTRY } from "../../src/workflows/blocks/index.js";
import { validateWorkflow } from "../../src/workflows/validate.js";
import { spacePaths } from "../../src/paths.js";
import { DEFAULT_MODELS, initSpace } from "../../src/workspace/initialize.js";
import { FutureFormatError, StoreNotMigratedError, migrateKernel, readMarker } from "../../src/migration/index.js";
import { RESIGN } from "../../src/migration/extensions.js";
import { fakeDocker, oldDataDir, readJson, snapshot } from "./helpers.js";

const now = () => new Date("2026-11-09T12:00:00.000Z");
const hashOfBlock = (type: string, params: Record<string, unknown>) => paramsHash(BLOCK_REGISTRY.get(type)!.params.parse(params) as Record<string, unknown>);

describe("migrateKernel, full migration of every old format", async () => {
  const { root, dataDir } = await oldDataDir();
  const outside = readFileSync(join(root, "outside.json"), "utf8");
  const docker = fakeDocker();
  const result = await migrateKernel({ dataDir, docker, now });
  const w = join(dataDir, "workspace");
  const report = readFileSync(join(dataDir, "migration-anglais.md"), "utf8");

  it("ends with the marker and a report; a second run does nothing", async () => {
    expect(result).toEqual({ status: "done", report: join(dataDir, "migration-anglais.md") });
    expect(await readMarker(dataDir)).toEqual({ store: 2, kernel: 2 });
    const before = snapshot(dataDir);
    expect(await migrateKernel({ dataDir, docker, now })).toEqual({ status: "already", report: null });
    expect(snapshot(dataDir)).toEqual(before);
  });

  it("renames the data tree", () => {
    for (const p of ["espace", "profilage", "ia-locale", "historique.sqlite", "sites-accords.json", "applications.json", "webaios-composants", "design/remarques", "design/relecture", "extensions/signes", "extensions/etat.json"]) {
      expect(existsSync(join(dataDir, p)), p).toBe(false);
    }
    for (const p of ["workspace/home/widgets", "workspace/home/blocks/vieux.html", "workspace/components/barre/component.html", "workspace/projects/demo/.webaios/profiling/trace.json", "workspace/sites/vidola/home/index.html", "workspace/sites/vidola/tweaks/a.js", "workspace/.webaios/logs/demo.log", "profiling/trace.json", "local-ai/kev/README", "design/review/app-demo.git/HEAD", "extensions/signed/bloqueur.xpi", "widgets/veille/data.json", "workspace/home/widgets/simple/harvest.mjs", "workspace/home/widgets/veille/display.html", "workspace/home/widgets/veille/example.json"]) {
      expect(existsSync(join(dataDir, p)), p).toBe(true);
    }
    expect(readJson(join(dataDir, "widgets/veille/data.json"))).toEqual({ articles: [{ titre: "Gardé", resume: "données libres" }] });
  });

  it("migrates the home page: layout, theme, widget.json, state, grants", async () => {
    expect(readJson(join(w, "home/layout.json")).widgets[0]).toEqual({ id: "veille", x: 0, y: 0, w: 500, h: 270 });
    expect(HomeTheme.parse(readJson(join(w, "home/theme.json")))).toMatchObject({ background: "#101010", mutedText: "#999999", spacing: 12, font: "serif" });
    const widget = DeclarationWidget.parse(readJson(join(w, "home/widgets/veille/widget.json")));
    expect(widget).toMatchObject({ name: "Veille", sizes: { default: { w: 4, h: 3 } }, harvest: { hours: ["08:00", "18:00"], maxDurationMinutes: 10, notify: true }, sources: { public: ["news.ycombinator.com"] } });
    expect(widget.config).toEqual({ interets: "rust, bases de données", titre: "gardé tel quel" });
    expect(WidgetState.parse(readJson(join(dataDir, "widgets/veille/state.json")))).toEqual({
      status: "running", lastUpdate: "2026-11-01T08:00:00.000Z", lastAttempt: "2026-11-01T08:00:00.000Z", progress: { done: 1, total: 3 },
      hours: { done: "2026-11-01T08:00", failures: { hour: "18:00", count: 1, end: "2026-10-31T18:05:00.000Z" } },
      before: { status: "grant-required", error: "accord", kernelError: true }, log: "ligne",
    });
    expect(await readGrants(join(dataDir, "widgets"))).toEqual({
      veille: { domains: [], public: ["news.ycombinator.com"], profile: "default" },
      meteo: { domains: ["meteo.example"], public: [], profile: "a1b2c3d4-0000-0000-0000-000000000000" },
    });
  });

  it("replaces the starter files left as shipped by their current template", () => {
    for (const f of ["widget.json", "workflow.json", "ville.mjs", "prevision.mjs", "example.json"]) {
      expect(readFileSync(join(w, "home/widgets/meteo", f), "utf8"), f).toBe(readFileSync(join(DEFAULT_MODELS, "widgets/meteo", f), "utf8"));
    }
    expect(readFileSync(join(w, "home/layout.json"), "utf8")).not.toBe(readFileSync(join(DEFAULT_MODELS, "layout.json"), "utf8"));
    expect(readFileSync(join(w, ".webaios/profiles/claude.json"), "utf8")).toContain('"nom"'); // shipped copy: initSpace replaces it
  });

  it("migrates workflow.json: types, params, values, engine fields in templates and paths", () => {
    const wf = readJson(join(w, "home/widgets/veille/workflow.json"));
    const r = validateWorkflow(wf, { web: false, maxDurationMinutes: 10, owner: "widget", input: false } as never);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const params = Object.fromEntries(wf.blocks.map((b: { id: string; type: string; params: unknown }) => [b.id, [b.type, b.params]]));
    expect(params).toEqual({
      flux: ["source.feed", { urls: ["https://news.ycombinator.com/rss"], onError: "fail" }],
      nouveaux: ["list.new", { key: "url", keepDays: 30 }],
      tri: ["ai.sort", { question: "Pour qui suit {config.interets} ?", text: "Titre : {title}\n{summary?}", threshold: 0.6, reuse: "url" }],
      lire: ["source.page", { url: "{url}", perItem: true, scroll: 2, budgetSeconds: 60 }],
      resumes: ["ai.write", { prompt: "Résume {page.text} ({score})", perItem: true, field: "summary", maxText: 8000 }],
      uniques: ["list.dedupe", { keys: ["url", "title"] }],
      code: ["code", { source: "trier.mjs", call: "input" }],
      sortie: ["output", { to: "widget", live: true }],
    });
    expect(wf.links[0]).toEqual({ from: "flux", to: "nouveaux" });
    const action = readJson(join(w, "actions/resume/workflow.json"));
    expect(action.blocks.map((b: { params: unknown }) => b.params)).toEqual([
      { url: "{input}" },
      { query: "{input}", count: 3 },
      { url: "https://api.test/x", format: "text" },
      { count: 2 },
      { prompt: "Résume : {page.text} {search.0.excerpt} {content}", json: true },
      { to: "page" },
    ]);
  });

  it("re-stamps a memory hash only when it matched the old params", async () => {
    const wf = readJson(join(w, "home/widgets/veille/workflow.json"));
    const block = (id: string) => wf.blocks.find((b: { id: string }) => b.id === id);
    expect(await readMemory(join(dataDir, "widgets/veille"))).toEqual({
      nouveaux: { type: "list.new", value: [["https://un.test", "2026-11-01T08:00:00.000Z"]], hash: hashOfBlock("list.new", block("nouveaux").params) },
      resumes: { type: "ai.write", value: { reused: [] }, hash: hashOfBlock("ai.write", block("resumes").params) },
      lire: { type: "source.page", value: { reused: [] } },
      parti: { type: "list.new", value: [], hash: "1111111111111111" },
    });
    expect(await readMemory(join(dataDir, "widgets/simple"))).toEqual({
      harvest: { type: "code", value: { vu: ["a"] }, hash: hashOfBlock("code", { source: "harvest.mjs", call: "harvest" }) },
    });
    const writeBlock = readJson(join(w, "actions/resume/workflow.json")).blocks.find((b: { id: string }) => b.id === "ecrire");
    expect((await readMemory(join(dataDir, "actions/resume"))).ecrire).toEqual({ type: "ai.write", value: { reused: [["k", "v", "2026-11-01T00:00:00.000Z"]] }, hash: hashOfBlock("ai.write", writeBlock.params) });
  });

  it("migrates runs and results, try suffix included", async () => {
    const runs = join(dataDir, "widgets/veille/runs");
    expect(readdirSync(runs).sort()).toEqual(["2026-11-01T08-00-00-000Z.json", "2026-11-01T09-00-00-000Z-attempt.json"]);
    const run = Execution.parse(readJson(join(runs, "2026-11-01T08-00-00-000Z.json")));
    expect(run).toMatchObject({ owner: { type: "widget", id: "veille" }, trigger: "scheduled", status: "partial", kernelError: true });
    expect(run.blocks).toEqual([
      { id: "flux", type: "source.feed", status: "succeeded", start: "2026-11-01T08:00:00.000Z", end: "2026-11-01T08:00:10.000Z", items: 2, output: [{ titre: "Un", url: "https://un.test" }], log: ["ok"] },
      { id: "tri", type: "ai.sort", status: "not-run", start: null, end: null, items: null, outputTruncated: true, log: [] },
    ]);
    expect(Execution.parse(readJson(join(runs, "2026-11-01T09-00-00-000Z-attempt.json")))).toMatchObject({ id: "2026-11-01T09-00-00-000Z-attempt", trigger: "replay", attempt: { start: "tri", origin: "2026-11-01T08-00-00-000Z" }, status: "succeeded", blocks: [{ status: "resumed" }] });
    const actionRun = Execution.parse(readJson(join(dataDir, "actions/resume/runs/2026-11-02T10-00-00-000Z-attempt.json")));
    expect(actionRun).toMatchObject({ input: "https://page.test", trigger: "manual", status: "grant-required", blocks: [{ type: "output", status: "interrupted" }] });
    const result = await readResult(join(dataDir, "actions"), "resume", "2026-11-02T10-00-00-000Z-attempt");
    expect(result).toMatchObject({ run: "2026-11-02T10-00-00-000Z-attempt", input: "https://page.test", fallback: false, empty: false, results: { titre: "Données libres", liste: [{ nom: "a", prix: 3 }] } });
    expect(result!.plan!.blocks).toEqual([
      { component: "title", props: { text: "Résumé" } },
      { component: "callout", props: { level: "notice", title: "À noter", text: "garder (ce texte)" } },
      { component: "figures", props: { figures: [{ value: "count(liste)", label: "Annonces" }] } },
      { component: "group", props: { title: "Détail", collapsed: true }, blocks: [{ component: "table", props: { items: 'keep(sort(liste, prix, "desc"), 5)', columns: [{ field: "nom", label: "Nom" }] } }] },
      { component: "barre", props: { valeur: "liste.0.prix", titre: "prop de l'agent" } },
    ]);
    expect(readJson(join(dataDir, "actions/launch-denials.json"))).toEqual({ resume: { error: "Accord requis", when: "2026-11-01T10:00:00.000Z" } });
    expect(await readGrants(join(dataDir, "actions"))).toEqual({ resume: { domains: [], public: [], profile: "default" } });
  });

  it("migrates action.json, components and agent app manifests", () => {
    expect(readJson(join(w, "actions/resume/action.json"))).toEqual({ name: "Résumer", description: "Résume une page", keywords: ["résumé"], input: { label: "Adresse" }, sources: { account: [], public: [], web: true }, layout: "Un titre puis le résumé", maxDurationMinutes: 5 });
    expect(ComponentDeclaration.parse(readJson(join(w, "components/barre/component.json"))).properties).toEqual({
      valeur: { kind: "reference", description: "La valeur", required: true },
      titre: { kind: "text", description: "Titre", required: false },
      cle: { kind: "field", description: "Champ", required: false },
      max: { kind: "number", description: "Max", required: false },
      plein: { kind: "checkbox", description: "Plein", required: false },
    });
    expect(Manifest.parse(readJson(join(w, "projects/demo/webaios.json")))).toEqual({ name: "Démo", type: "app", launch: "npm run dev -- --port {port}", origin: "http://localhost:5173" });
    expect(Profile.parse(readJson(join(w, ".webaios/profiles/perso.json")))).toEqual({ id: "perso", name: "Perso", interactive: ["claude", "--mcp-config", "{mcpConfig}"], nonInteractive: ["claude", "-p", "{prompt}"], mcpConfig: "claude-json" });
  });

  it("migrates site apps: site.json, grants, url, memory, window records", async () => {
    const site = DeclarationSite.parse(readJson(join(w, "sites/vidola/site.json")));
    expect(site).toMatchObject({ name: "Vidola", url: "https://vidola.example/", login: ["auth.vidola.example"], urlTracking: { pattern: "vidola" }, tweaks: [{ matches: ["/series/*"], frames: ["https://player.example/*"] }], resume: true, icon: "accueil/icone.png" });
    expect(await readSiteGrants(dataDir)).toEqual({ vidola: { domains: ["vidola.example"], login: ["auth.vidola.example"], frames: ["https://player.example/*"], resume: true } });
    expect(await readUrlState(join(dataDir, "sites"), "vidola")).toEqual({ current: "vidola.example", previous: ["vidola.old.example"], since: "2026-10-01T00:00:00.000Z" });
    expect(readJson(join(dataDir, "sites/vidola/memory.json"))).toEqual({ version: 1, values: { vu: { value: { titre: "libre" }, url: "https://vidola.example/series/1", when: "2026-11-01T00:00:00.000Z" } }, positions: { "https://vidola.example/series/1": { t: 120, duration: 1500, when: "2026-11-01T00:00:00.000Z" } } });
    expect(readJson(join(dataDir, "sites.json")).vidola).toEqual({ frame: { x: 10, y: 20, width: 800, height: 600 }, lastLaunch: "2026-11-01T00:00:00.000Z", favicon: "data:image/png;base64,AA==" });
    expect(readJson(join(dataDir, "apps.json"))).toEqual({ demo: { frame: { x: 0, y: 0, width: 1000, height: 700 } } });
  });

  it("migrates the extensions registry and re-stamps hashes that matched", async () => {
    const state = await readExtensionsState(join(dataDir, "extensions"));
    const store = state.extensions["store:abcdefghijklmnopabcdefghijklmnop"]!;
    const site = DeclarationSite.parse(readJson(join(w, "sites/vidola/site.json")));
    expect(store).toMatchObject({ addonId: "ublock@example", name: "uBlock", profiles: ["default", "site-vidola"], seenVersions: { default: "1.0" }, pendingUpdate: { path: "/tmp/x.xpi", scope: { allSites: false } } });
    expect(store.siteApps).toEqual({ vidola: siteExtensionsHash(site), parti: "abc" });
    expect(state.extensions["agent:bloqueur"]).toMatchObject({ grant: { network: ["api.bloqueur.example"], scripts: false }, disabled: { reason: "scope-widened", at: "2026-11-02T00:00:00.000Z" }, hiddenConsole: ["default"] });
    expect(state.hiddenConsoles).toEqual(["bloqueur@agent.webaios"]);
    expect(readJson(join(w, "extensions/bloqueur/webaios.json"))).toEqual({ network: ["api.bloqueur.example"] });
    const signed = readJson(join(dataDir, "extensions/signed/bloqueur.json"));
    expect(signed).toEqual({ version: "1.0.3", hash: hashOf((await readFolder(join(w, "extensions/bloqueur"))).files) });
    expect(readdirSync(join(dataDir, "extensions/signed")).sort()).toEqual(["bloqueur.json", "bloqueur.xpi"]);
    expect(readdirSync(join(dataDir, "extensions/copies"))).toEqual(["bloqueur"]);
  });

  it("migrates design mode and review files", () => {
    expect(readJson(join(dataDir, "design/external-projects.json"))).toEqual([{ id: "0123456789abcdef", name: "Ext", folder: "/Users/u/ext", ports: [5173], client: "c1", declared: "2026-11-01T00:00:00.000Z" }]);
    expect(readJson(join(dataDir, "design/external-clients.json"))).toEqual([{ id: "c1", name: "Claude", hash: "deadbeef", created: "2026-11-01T00:00:00.000Z" }]);
    for (const basket of [join(dataDir, "design/remarks/ext-0123456789abcdef/basket.json"), join(w, ".webaios/remarks/app-demo/basket.json")]) {
      expect(readJson(basket)).toEqual([{ id: "e-0000000a", type: "design", text: "Plus grand", context: { selector: "h1", label: "h1", html: "<h1>Le titre</h1>", neighborhood: { parent: "main", siblings: ["p"] }, styles: { color: "red" }, source: { file: "src/App.svelte", line: 3, column: 1 }, url: "http://localhost:5173/", view: { width: 1280, height: 800 } }, capture: null }]);
    }
    expect(readJson(join(w, ".webaios/remarks/app-demo/20261101T101010Z-abcd/batch.json"))).toEqual({ id: "20261101T101010Z-abcd", project: "app-demo", created: "2026-11-01T10:10:10Z", destination: "agent", read: "2026-11-01T10:11:00Z", items: [{ id: "e-0000000b", type: "review", text: "Bug ici", context: { file: "src/a.ts", start: 1, end: 2, lines: [{ mark: "+", text: "x" }] }, handled: { when: "2026-11-01T11:00:00Z", note: "fait" } }] });
    expect(readJson(join(dataDir, "design/review/app-demo.comments.json"))).toEqual([{ id: "c-1", file: "src/a.ts", start: 1, end: 1, lines: [{ mark: " ", text: "x" }], text: "Pourquoi ?", created: "2026-11-01T00:00:00.000Z", sent: null, resolved: false, lineChanged: false }]);
  });

  it("migrates the history database: tables, columns, FTS rebuilt, triggers on the new names", () => {
    const db = new DatabaseSync(join(dataDir, "history.sqlite"));
    try {
      const names = (db.prepare("SELECT name FROM sqlite_master ORDER BY name").all() as { name: string }[]).map((r) => r.name).filter((n) => !/^(sqlite_|texts_fts_)/.test(n));
      expect(names).toEqual(["texts", "texts_date", "texts_delete", "texts_fts", "texts_insert", "texts_space", "texts_update", "visits", "visits_date"]);
      expect(db.prepare("SELECT url, space_id, title, last_visit, visits, private FROM visits ORDER BY url").all()).toEqual([
        { url: "https://deux.test/", space_id: "", title: "Page deux", last_visit: "2026-11-02T00:00:00.000Z", visits: 1, private: 1 },
        { url: "https://un.test/", space_id: "perso", title: "Page un", last_visit: "2026-11-01T00:00:00.000Z", visits: 3, private: 0 },
      ]);
      expect(db.prepare("SELECT rowid FROM texts_fts WHERE texts_fts MATCH 'crepes'").all()).toHaveLength(1);
      db.exec("UPDATE texts SET text = 'autre chose' WHERE id = 1");
      expect(db.prepare("SELECT rowid FROM texts_fts WHERE texts_fts MATCH 'crepes'").all()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("removes the old workshop containers and image, never the volume", () => {
    expect(docker.calls).toContain("rm -f webaios-atelier-firefox");
    expect(docker.calls).toContain("rmi webaios-atelier:1");
    expect(docker.calls).not.toContain("rm -f webaios-atelier");
    expect(docker.calls.some((c) => c.includes("volume") || c.includes("webaios-home"))).toBe(false);
  });

  it("touches nothing outside the data folder and leaves links and unreadable files", () => {
    expect(readdirSync(root).sort()).toEqual(["data", "outside.json"]);
    expect(readFileSync(join(root, "outside.json"), "utf8")).toBe(outside);
    expect(readFileSync(join(dataDir, "widgets/casse/etat.json"), "utf8")).toBe('{ "statut": "ok", ');
    expect(report).toContain("`widgets/casse/etat.json`");
    expect(report).toContain("`workspace/sites/lien/site.json`");
  });

  it("writes a report of paths and names, never content", () => {
    expect(report).toContain("`workspace/home/widgets/veille/trier.mjs` : `.titre`, `webaios.lirePage`");
    expect(report).toContain("`workspace/home/widgets/veille/display.html` : `.donnees`, `.taille`, `webaiosOuvrir`");
    expect(report).toContain("`workspace/home/widgets/simple/harvest.mjs` : `webaios.lirePage`");
    expect(report).toContain("`workspace/sites/vidola/home/index.html` : `webaiosSite.retenir`");
    expect(report).toContain("`workspace/sites/vidola/tweaks/a.js` : `webaiosSite.lire`");
    expect(report).not.toContain("meteo/display.html"); // shipped: initSpace replaces it
    expect(report).toContain("## AGENTS.md");
    expect(report).toContain("claude mcp add");
    expect(report).not.toContain("ne relit pas"); // every migrated file reads with the new schemas
    for (const content of ["secret", "Page un", "Le titre", "Pourquoi", "Données libres", "dehors", "https://un.test"]) expect(report).not.toContain(content);
  });

  it("leaves a workspace that initSpace and the home reader accept", async () => {
    const paths = spacePaths(w);
    await initSpace(paths);
    const home = await readHome(paths, join(dataDir, "widgets"));
    expect(home.widgets.map((x) => [x.id, "error" in x ? x.error : "ok"])).toEqual([["meteo", "ok"], ["simple", "ok"], ["veille", "ok"]]);
    expect(readFileSync(join(w, "home/widgets/meteo/display.html"), "utf8")).toBe(readFileSync(join(DEFAULT_MODELS, "widgets/meteo/display.html"), "utf8"));
  });
});

describe("migrateKernel, cut and run again", () => {
  it("gives the same data after a cut at any write", { timeout: 120_000 }, async () => {
    const clean = await oldDataDir();
    await migrateKernel({ dataDir: clean.dataDir, docker: fakeDocker(), now });
    const expected = snapshot(clean.dataDir);
    let total = 0;
    const counting = await oldDataDir();
    await migrateKernel({ dataDir: counting.dataDir, docker: fakeDocker(), now, checkpoint: () => void total++ });
    expect(total).toBeGreaterThan(50);
    for (let cut = 1; cut <= total; cut++) {
      const { dataDir } = await oldDataDir();
      const docker = fakeDocker();
      let n = 0;
      await expect(migrateKernel({ dataDir, docker, now, checkpoint: () => { if (++n === cut) throw new Error("coupure"); } })).rejects.toThrow("coupure");
      expect((await readMarker(dataDir)).kernel, `cut ${cut}`).toBe(1);
      await migrateKernel({ dataDir, docker, now });
      expect(snapshot(dataDir), `cut ${cut}`).toEqual(expected);
    }
  });
});

describe("migrateKernel refuses", () => {
  it("a marker from a newer version: FutureFormatError, nothing written", async () => {
    for (const marker of [{ store: 3, kernel: 1 }, { store: 2, kernel: 3 }]) {
      const { dataDir } = await oldDataDir(marker);
      const before = snapshot(dataDir);
      await expect(migrateKernel({ dataDir, docker: fakeDocker(), now })).rejects.toBeInstanceOf(FutureFormatError);
      expect(snapshot(dataDir)).toEqual(before);
    }
  });

  it("old data before the store half (store: 1 or no marker): nothing written", async () => {
    for (const marker of [{ store: 1, kernel: 1 }, null]) {
      const { dataDir } = await oldDataDir(marker);
      const before = snapshot(dataDir);
      const docker = fakeDocker();
      await expect(migrateKernel({ dataDir, docker, now })).rejects.toBeInstanceOf(StoreNotMigratedError);
      expect(snapshot(dataDir)).toEqual(before);
      expect(docker.calls).toEqual([]);
    }
  });

  it("a new data folder: nothing to migrate, nothing written", async () => {
    const { dataDir } = await oldDataDir(null);
    const fresh = join(dataDir, "..", "fresh");
    const docker = fakeDocker();
    expect(await migrateKernel({ dataDir: fresh, docker, now })).toEqual({ status: "already", report: null });
    expect(existsSync(fresh)).toBe(false);
    expect(docker.calls).toEqual([]);
  });

  it("data already in the new format (store marker only): left as is, even its own names that match old ones", async () => {
    const { root } = await oldDataDir(null);
    const dataDir = join(root, "new");
    const widget = join(dataDir, "workspace", "home", "widgets", "veille");
    mkdirSync(widget, { recursive: true });
    const workflow = JSON.stringify({ version: 1, blocks: [{ id: "avis", type: "ai.write", params: { field: "avis", prompt: "{titre}" } }], links: [] });
    writeFileSync(join(widget, "workflow.json"), workflow);
    writeFileSync(join(dataDir, ".format-version"), JSON.stringify({ store: 2 }));
    const docker = fakeDocker();
    expect(await migrateKernel({ dataDir, docker, now })).toEqual({ status: "already", report: null });
    expect(readFileSync(join(widget, "workflow.json"), "utf8")).toBe(workflow);
    expect(await readMarker(dataDir)).toEqual({ store: 2, kernel: 2 });
    expect(docker.calls).toEqual([]);
  });

  it("an old root next to its new name (a launch on mid-branch code): stopped before any write, both paths named", async () => {
    for (const [old, fresh] of [
      ["espace", "workspace"],
      ["historique.sqlite", "history.sqlite"],
      ["profilage", "profiling"],
      ["ia-locale", "local-ai"],
      ["design/remarques", "design/remarks"],
      ["design/relecture", "design/review"],
      ["extensions/signes", "extensions/signed"],
    ]) {
      const { dataDir } = await oldDataDir();
      if (fresh.endsWith(".sqlite")) writeFileSync(join(dataDir, fresh), "");
      else mkdirSync(join(dataDir, fresh), { recursive: true });
      const before = snapshot(dataDir);
      const docker = fakeDocker();
      const e = await migrateKernel({ dataDir, docker, now }).then(() => null, (e: Error) => e);
      expect(e?.message, old).toContain(join(dataDir, old!));
      expect(e?.message, old).toContain(join(dataDir, fresh!));
      expect(snapshot(dataDir), old).toEqual(before);
      expect(docker.calls).toEqual([]);
    }
  });

  it("the marker deleted after a real migration (the report stays): nothing rewritten", async () => {
    const { dataDir } = await oldDataDir();
    await migrateKernel({ dataDir, docker: fakeDocker(), now });
    // The user's own names that match old ones, written after the migration.
    const file = join(dataDir, "workspace/home/widgets/veille/workflow.json");
    writeFileSync(file, JSON.stringify({ version: 1, blocks: [{ id: "avis", type: "ai.write", params: { field: "avis", prompt: "{titre}" } }], links: [] }));
    // `.format-version` deleted: the store half writes its own marker again.
    writeFileSync(join(dataDir, ".format-version"), JSON.stringify({ store: 2 }));
    const { [".format-version"]: _, ...before } = snapshot(dataDir);
    const docker = fakeDocker();
    expect(await migrateKernel({ dataDir, docker, now })).toEqual({ status: "already", report: null });
    const { [".format-version"]: __, ...after } = snapshot(dataDir);
    expect(after).toEqual(before);
    expect(await readMarker(dataDir)).toEqual({ store: 2, kernel: 2 });
    expect(docker.calls).toEqual([]);
  });

  it("JSON files of an unexpected shape (null): listed and left, the rest migrated", async () => {
    const { dataDir } = await oldDataDir();
    writeFileSync(join(dataDir, "widgets/simple/memoire.json"), "null");
    writeFileSync(join(dataDir, "extensions/etat.json"), "null");
    writeFileSync(join(dataDir, "actions/resume/resultats/2026-11-02T10-00-00-000Z-essai.json"), "null");
    expect((await migrateKernel({ dataDir, docker: fakeDocker(), now })).status).toBe("done");
    expect(readFileSync(join(dataDir, "widgets/simple/memoire.json"), "utf8")).toBe("null");
    expect(readFileSync(join(dataDir, "extensions/etat.json"), "utf8")).toBe("null");
    expect(readFileSync(join(dataDir, "actions/resume/results/2026-11-02T10-00-00-000Z-essai.json"), "utf8")).toBe("null");
    const report = readFileSync(join(dataDir, "migration-anglais.md"), "utf8");
    for (const f of ["widgets/simple/memoire.json", "extensions/etat.json", "actions/resume/results/2026-11-02T10-00-00-000Z-essai.json"]) expect(report).toContain(`\`${f}\``);
    expect(existsSync(join(dataDir, "workspace/home/widgets/veille/widget.json"))).toBe(true);
    expect((await readMarker(dataDir)).kernel).toBe(2);
  });

  it("a folder linked out of the data folder: never read nor written through", async () => {
    const { root, dataDir } = await oldDataDir();
    mkdirSync(join(root, "elsewhere"));
    renameSync(join(dataDir, "design", "projets-externes.json"), join(root, "elsewhere", "projets-externes.json"));
    rmSync(join(dataDir, "design"), { recursive: true });
    symlinkSync(join(root, "elsewhere"), join(dataDir, "design"));
    const before = snapshot(join(root, "elsewhere"));
    expect((await migrateKernel({ dataDir, docker: fakeDocker(), now })).status).toBe("done");
    expect(snapshot(join(root, "elsewhere"))).toEqual(before);
    expect(readFileSync(join(dataDir, "migration-anglais.md"), "utf8")).toContain("`design/projets-externes.json`");
  });

  it("a Docker failure goes to the report without blocking", async () => {
    const { dataDir } = await oldDataDir();
    expect((await migrateKernel({ dataDir, docker: fakeDocker({ fail: true }), now })).status).toBe("done");
    expect(readFileSync(join(dataDir, "migration-anglais.md"), "utf8")).toContain("docker rm -f webaios-atelier-firefox : Cannot connect to the Docker daemon");
    expect((await readMarker(dataDir)).kernel).toBe(2);
  });
});

describe("migrateKernel, agent extensions signed with the old guards", () => {
  it("are marked to sign again (never re-stamped) and listed in the report", async () => {
    const { dataDir } = await oldDataDir();
    // The old copy's guard files (their names are also in the .xpi's zip directory).
    writeFileSync(join(dataDir, "extensions/copies/bloqueur/webaios-garde-fond.js"), "const w = globalThis.__webaios; w.urlPermise(u);");
    writeFileSync(join(dataDir, "extensions/signes/bloqueur.xpi"), "PK\x03\x04webaios-garde-fond.jsPK\x01\x02webaios-garde-page.js");
    await migrateKernel({ dataDir, docker: fakeDocker(), now });
    expect(readJson(join(dataDir, "extensions/signed/bloqueur.json"))).toEqual({ version: "1.0.3", hash: RESIGN });
    const report = readFileSync(join(dataDir, "migration-anglais.md"), "utf8");
    expect(report).toContain("## Extensions de l'agent à signer de nouveau");
    expect(report).toContain("- `workspace/extensions/bloqueur`");
  });

  it("the old guard API alone in the copy is enough", async () => {
    const { dataDir } = await oldDataDir();
    writeFileSync(join(dataDir, "extensions/copies/bloqueur/background.js"), "__webaios.hotePermis(tab)");
    await migrateKernel({ dataDir, docker: fakeDocker(), now });
    expect(readJson(join(dataDir, "extensions/signed/bloqueur.json")).hash).toBe(RESIGN);
  });
});
