import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE, oldHistory } from "../../../packages/kernel/test/migration/helpers";
import { waitReady } from "./firefox";
import { launchWebAiOs } from "./launch";
import { startServer } from "./server";

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const CIS = 'ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs").ContextualIdentityService';

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => (server = await startServer()));
afterAll(async () => await server?.close());

/** A session as the French build (format 2) wrote it. */
const oldSession = (page: string) => ({
  version: 2,
  espaces: [
    { id: "e1", nom: "Perso", icone: "🏠", epingles: [{ id: "f1", url: "webaios://applications", titre: "Applis", favicon: null }], prive: false, profil: "defaut" },
    { id: "e2", nom: "Banque", icone: "🏦", epingles: [], prive: true, profil: "p-123" },
  ],
  profils: [{ id: "defaut" }, { id: "p-123" }],
  essentiels: [],
  onglets: {
    o1: { id: "o1", fenetreId: "w1", espaceId: "e1", url: page, titre: "Page", favicon: null, lien: null, ouvertParAgent: false, zoom: 1 },
    o2: { id: "o2", fenetreId: "w1", espaceId: "e1", url: "webaios://applications", titre: "Applis", favicon: null, lien: { type: "epingle", id: "f1" }, ouvertParAgent: false, zoom: 1 },
  },
  fenetres: [{ id: "w1", espaceActif: "e1", ordre: { e1: ["o1", "o2"], e2: [] }, actif: { e1: "o1", e2: null }, compact: false, panneauAgentOuvert: false, fermesRecemment: [], cadre: null }],
  reglages: { moteur: "duckduckgo", profilAgent: "claude", largeurPanneauAgent: 420 },
});

/** The kernel tests' old data folder, without what would leave the machine (harvests, the agent extension's signing). */
async function oldDataDir(dataDir: string, page: string): Promise<void> {
  await cp(FIXTURE, dataDir, { recursive: true });
  oldHistory(path.join(dataDir, "historique.sqlite"));
  for (const id of await readdir(path.join(dataDir, "espace/accueil/widgets"))) {
    const file = path.join(dataDir, "espace/accueil/widgets", id, "widget.json");
    const { recolte: _, ...widget } = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify(widget, null, 2));
  }
  await Promise.all([rm(path.join(dataDir, "extensions"), { recursive: true }), rm(path.join(dataDir, "espace/extensions"), { recursive: true })]);
  await writeFile(path.join(dataDir, "session.json"), JSON.stringify(oldSession(page), null, 2));
  await writeFile(path.join(dataDir, "permissions.json"), JSON.stringify({ [`${server.url} notifications`]: "autoriser" }));
}

describe("migration to the English formats (store half, then the kernel's)", () => {
  it("old data and a profile with a webaios-defaut container: backup, session, permissions, container with its cookie, report", { timeout: 120_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "webaios-migration-"));
    const profile = path.join(root, "profile");
    const dataDir = path.join(root, "data");
    await mkdir(profile);
    // AMO never reached, whatever happens (no test key: nothing is signed).
    const env = { WEBAIOS_TEST_AMO_URL: "http://127.0.0.1:9" };
    try {
      // An older build's default-profile container, holding a cookie (started on a new data folder).
      let w = await launchWebAiOs({ profile, dataDir: path.join(root, "fresh"), env });
      let m = w.marionette;
      await m.setContext("chrome");
      await waitReady(m);
      const id = await m.execute<number>(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).containerFor("defaut"))();`);
      await m.execute(
        `return (async () => {
          const tab = gBrowser.addTab(arguments[0], { userContextId: arguments[1], triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
          for (let i = 0; i < 50 && tab.linkedBrowser.currentURI.spec !== arguments[0]; i++) await new Promise((r) => setTimeout(r, 100));
          await new Promise((r) => setTimeout(r, 500));
          gBrowser.removeTab(tab);
        })();`,
        [`${server.url}/cookie`, id],
      );
      const cookies = `return Services.cookies.getCookiesFromHost("127.0.0.1", { userContextId: arguments[0] }).map((c) => c.name + "=" + c.value);`;
      expect(await m.execute(cookies, [id])).toEqual(["essai=1"]);
      await w.close();

      await oldDataDir(dataDir, `${server.url}/a.html`);
      // starterHarvests: no starter widgets seeded next to the old `espace` folder.
      w = await launchWebAiOs({ profile, dataDir, env, starterHarvests: true });
      m = w.marionette;
      await m.setContext("chrome");
      await waitReady(m);
      const r = await m.execute<{ error: string | null; aside: string | null; spaces: string[]; profiles: string[]; urls: string[]; names: string[]; same: boolean }>(
        `return (async () => {
          const store = await ChromeUtils.importESModule("${STORE}").ready;
          const s = store.state;
          return {
            error: store.migrationError,
            aside: store.setAside,
            spaces: s.spaces.map((e) => e.name + ":" + e.profile),
            profiles: s.profiles.map((p) => p.id),
            urls: Object.values(s.tabs).map((t) => t.url).sort(),
            names: ${CIS}._identities.map((i) => i.name).filter((n) => n?.includes("webaios-def")),
            same: ${CIS}._identities.find((i) => i.name === "userContextIdInternal.webaios-default")?.userContextId === arguments[0],
          };
        })();`,
        [id],
      );
      expect(r).toEqual({
        error: null,
        aside: null,
        spaces: ["Perso:default", "Banque:p-123"],
        profiles: ["default", "p-123"],
        urls: [`${server.url}/a.html`, "webaios://apps"],
        names: ["userContextIdInternal.webaios-default"],
        same: true,
      });
      expect(await m.execute(cookies, [id])).toEqual(["essai=1"]);

      // The kernel half follows in the host: both markers, then the report.
      const marker = () => readFile(path.join(dataDir, ".format-version"), "utf8").then((t) => JSON.parse(t), () => null);
      for (let i = 0; i < 300 && (await marker())?.kernel !== 2; i++) await new Promise((ok) => setTimeout(ok, 100));
      expect(await marker()).toEqual({ store: 2, kernel: 2 });
      expect(await readFile(path.join(dataDir, "migration-anglais.md"), "utf8")).toContain("# Passage des données aux noms anglais");
      expect(existsSync(path.join(dataDir, "workspace/home/widgets/veille/widget.json"))).toBe(true);
      expect(JSON.parse(await readFile(path.join(dataDir, "permissions.json"), "utf8"))).toEqual({ [`${server.url} notifications`]: "allow" });

      // The full copy of before, and the profile's containers.json, beside the data folder.
      const backups = (await readdir(root)).filter((n) => n.startsWith("data.avant-anglais-")).sort();
      expect(backups).toHaveLength(2);
      const [backup, containers] = backups.map((n) => path.join(root, n));
      expect(JSON.parse(await readFile(path.join(backup!, "session.json"), "utf8"))).toEqual(oldSession(`${server.url}/a.html`));
      expect(existsSync(path.join(backup!, "espace/accueil/widgets/veille/widget.json"))).toBe(true);
      expect(containers).toBe(`${backup}.containers.json`);
      expect(await readFile(containers!, "utf8")).toContain("userContextIdInternal.webaios-defaut");
      await w.close();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    }
  });

  it("a workspace/ next to the old espace/: the kernel half stops before any write, and the agent says why", { timeout: 60_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "webaios-migration-"));
    const dataDir = path.join(root, "data");
    try {
      await oldDataDir(dataDir, `${server.url}/a.html`);
      // Made by a launch of an in-between version.
      await mkdir(path.join(dataDir, "workspace"));
      const w = await launchWebAiOs({ dataDir, env: { WEBAIOS_TEST_AMO_URL: "http://127.0.0.1:9" }, starterHarvests: true });
      const m = w.marionette;
      await m.setContext("chrome");
      await waitReady(m);
      const ensure = await m.execute<string>(
        `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.ensure().then(() => "started", (e) => e.message))();`,
      );
      expect(ensure).toContain("Le noyau de l'agent ne démarre pas");
      expect(ensure).toContain(`${path.join(dataDir, "espace")} et ${path.join(dataDir, "workspace")} existent tous les deux`);
      await w.close();
      const marker = JSON.parse(await readFile(path.join(dataDir, ".format-version"), "utf8"));
      expect([marker.store, marker.kernel ?? 1]).toEqual([2, 1]);
      expect(await readdir(path.join(dataDir, "workspace"))).toEqual([]);
      expect(existsSync(path.join(dataDir, "espace/accueil"))).toBe(true);
      expect(existsSync(path.join(dataDir, "migration-anglais.md"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    }
  });

  it("a backup that fails: nothing migrated, the error shown, the host never started", { timeout: 60_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "webaios-migration-"));
    const dataDir = path.join(root, "data");
    try {
      await oldDataDir(dataDir, `${server.url}/a.html`);
      // A file the copy cannot read.
      await writeFile(path.join(dataDir, "secret.json"), "{}");
      await chmod(path.join(dataDir, "secret.json"), 0o000);
      const before = await readFile(path.join(dataDir, "session.json"), "utf8");
      const w = await launchWebAiOs({ dataDir, env: { WEBAIOS_TEST_AMO_URL: "http://127.0.0.1:9" }, starterHarvests: true });
      const m = w.marionette;
      await m.setContext("chrome");
      await waitReady(m);
      const r = await m.execute<{ error: string | null; pid: number | null; ensure: string; notice: boolean }>(
        `return (async () => {
          const store = await ChromeUtils.importESModule("${STORE}").ready;
          const ensure = await store.agent.ensure().then(() => "started", (e) => e.message);
          return { error: store.migrationError, pid: store.agent.pid, ensure, notice: !!gNotificationBox.getNotificationWithValue("webaios-migration-failed") };
        })();`,
      );
      expect(r.error).toMatch(/sauvegarde.*rien n'est migré/);
      expect(r).toMatchObject({ pid: null, ensure: r.error, notice: true });
      // A tab opened now is not written over the old session.
      await m.execute(`return (async () => { const s = await ChromeUtils.importESModule("${STORE}").ready; s.dispatch({ type: "openTab", windowId: Object.values(s.state.windows)[0].id, url: "about:blank" }); await new Promise((ok) => setTimeout(ok, 1500)); })();`);
      await w.close();
      expect(await readFile(path.join(dataDir, "session.json"), "utf8")).toBe(before);
      expect(existsSync(path.join(dataDir, ".format-version"))).toBe(false);
      expect(existsSync(path.join(dataDir, "espace"))).toBe(true);
    } finally {
      await chmod(path.join(dataDir, "secret.json"), 0o600).catch(() => {});
      await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    }
  });
});
