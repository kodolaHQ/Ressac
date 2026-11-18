import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, waitUi } from "./ui";

// Plan 44 Task 6: the Settings page's Privacy (permissions) and Data sections.

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());

let w: LaunchedRessac | undefined;
let m: Marionette;
/** Folders this test made (data folder and its backups, profile, downloads), removed after it. */
let made: string[] = [];
let dataDir = "";
let reveals = "";
afterEach(async () => {
  await w?.close();
  w = undefined;
  const backups = dataDir ? readdirSync(dirname(dataDir)).filter((n) => n.startsWith(`${basename(dataDir)}.backup-`)).map((n) => join(dirname(dataDir), n)) : [];
  await Promise.all([...made, ...backups].map((d) => rm(d, { recursive: true, force: true })));
  made = [];
  dataDir = "";
});

const temp = async (prefix: string) => {
  const d = await mkdtemp(join(os.tmpdir(), prefix));
  made.push(d);
  return d;
};
async function prepare(): Promise<void> {
  dataDir = await temp("ressac-data-");
  reveals = join(dataDir, "..", `${basename(dataDir)}-reveals.txt`);
  made.push(reveals);
}
async function launch(o: { env?: Record<string, string>; profile?: string; prefs?: Record<string, string | number | boolean> } = {}): Promise<void> {
  w = await launchRessac({ dataDir, profile: o.profile, prefs: o.prefs, env: { RESSAC_TEST_REVEAL: reveals, RESSAC_OLLAMA_URL: "http://127.0.0.1:9", ...o.env } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
}
/** Opens the page on one of its sections. */
const openPage = async (section: "privacy" | "data" = "data") => {
  await click(m, '[data-testid="settings-button"]');
  await click(m, `[data-testid="settings-nav-${section}"]`);
  await waitUi(m, "return !!doc.querySelector(arguments[0])", [`[data-testid="settings-${section}"]`]);
};
const count = (selector: string, n: number, ms = 10_000) => waitUi(m, "return doc.querySelectorAll(arguments[0]).length === arguments[1]", [selector, n], ms);
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

describe("Settings page, permissions and data", () => {
  it("permissions: Réparer le partage d'écran says to relaunch", async () => {
    await prepare();
    await launch();
    await openPage("privacy");
    await click(m, '[data-testid="screen-sharing-repair-button"]');
    await waitUi(m, `return doc.querySelector('[data-testid="screen-sharing-repair"]')?.textContent.includes("Quittez puis rouvrez Ressac")`);
  });

  it("permissions: a site decision and a widget grant; Retirer forgets the site", async () => {
    await prepare();
    writeFileSync(join(dataDir, "permissions.json"), JSON.stringify({ "https://a.fr media-camera": "allow" }));
    mkdirSync(join(dataDir, "widgets"), { recursive: true });
    writeFileSync(join(dataDir, "widgets", "grants.json"), JSON.stringify({ meteo: { domains: ["a.fr"], public: [], profile: "default" } }));
    await launch();
    await openPage("privacy");
    await count('[data-testid="grant-row"]', 2);
    expect(await inUi(m, `return [...doc.querySelectorAll('[data-testid="grant-row"]')].map((r) => r.dataset.kind).sort()`)).toEqual(["site", "widget"]);
    await click(m, '[data-testid="grant-row"][data-kind="site"] [data-testid="grant-revoke"]');
    await count('[data-testid="grant-row"]', 1);
    await waitFor(m, "return true", () => !read(join(dataDir, "permissions.json")).includes("https://a.fr"));
  });

  it("the browsing notes button reveals the notes file", async () => {
    await prepare();
    await launch();
    await openPage();
    expect(await waitUi(m, `return doc.querySelector('[data-testid="settings-browsing-notes"]')?.textContent`)).toBe("Afficher dans le Finder");
    await click(m, '[data-testid="settings-browsing-notes"]');
    await waitFor(m, "return true", () => read(reveals).includes(join(dataDir, "workspace", ".ressac", "browsing-notes.md")));
  });

  it("backups: listed, shown in the Finder, deleted", async () => {
    await prepare();
    const backup = `${dataDir}.backup-2026-01-01T00-00-00-000Z`;
    mkdirSync(backup);
    writeFileSync(join(backup, "session.json"), "{}");
    await launch();
    await openPage();
    await count('[data-testid="backup-row"]', 1);
    await click(m, '[data-testid="backup-row"] [data-testid="backup-reveal"]');
    await waitFor(m, "return true", () => read(reveals).includes(backup));
    await click(m, '[data-testid="backup-delete"]');
    await click(m, '[data-testid="confirm-data"]');
    await count('[data-testid="backup-row"]', 0);
    expect(existsSync(backup)).toBe(false);
  });

  it("export: a zip lands in the downloads folder", async () => {
    await prepare();
    const downloads = await temp("ressac-downloads-");
    await launch({ prefs: { "browser.download.dir": downloads, "browser.download.folderList": 2 } });
    await openPage();
    await click(m, '[data-testid="data-export"]');
    await waitUi(m, `return doc.querySelector('[data-testid="settings-data"]').textContent.includes("Exporté dans")`, [], 30_000);
    expect(readdirSync(downloads).some((n) => /^Ressac-donnees-.*\.zip$/.test(n))).toBe(true);
  });

  it("reset: a cancelled quit resets nothing, and says so", async () => {
    await prepare();
    await launch({ env: { RESSAC_TEST_NO_RESTART: "1" } });
    // Like Firefox's « downloads in progress » question answered « stay ».
    await m.execute(`window.keepQuit = { observe: (s) => (s.QueryInterface(Ci.nsISupportsPRBool).data = true) }; Services.obs.addObserver(window.keepQuit, "quit-application-requested");`);
    await openPage();
    await click(m, '[data-testid="data-reset"]');
    await click(m, '[data-testid="confirm-reset"]');
    await waitUi(m, `return doc.querySelector('[data-testid="settings-data"]').textContent.includes("Redémarrage annulé : rien n'a été réinitialisé.")`);
    expect(existsSync(join(dataDir, ".reset-requested"))).toBe(false);
    process.kill(w!.pid, 0);
  });

  it("reset: data set aside, the workspace stays, a fresh start", { timeout: 90_000 }, async () => {
    await prepare();
    const profile = await temp("ressac-firefox-");
    mkdirSync(join(dataDir, "workspace", "projects", "a"), { recursive: true });
    writeFileSync(join(dataDir, "workspace", "projects", "a", "x.txt"), "x");
    await launch({ profile, env: { RESSAC_TEST_NO_RESTART: "1" } });
    const old = `${server.url}/ancienne`;
    await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: old, activate: false });
    // The session is written before the reset sets it aside.
    await waitFor(m, "return true", () => read(join(dataDir, "session.json")).includes(old), 15_000);
    await openPage();
    await click(m, '[data-testid="data-reset"]');
    await waitUi(m, `return doc.querySelector('[data-testid="settings-data"]').textContent.includes("données des widgets et des actions) sont mises de côté")`);
    await waitUi(m, `return doc.querySelector('[data-testid="settings-data"]').textContent.includes("les connexions de Claude et de Codex (boutons Se déconnecter, section Agent), la clé de l'API compatible de Codex (Trousseau macOS)")`);
    await click(m, '[data-testid="confirm-reset"]');
    const alive = () => {
      try {
        process.kill(w!.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (const deadline = Date.now() + 30_000; alive(); await new Promise((r) => setTimeout(r, 200))) if (Date.now() > deadline) throw new Error("Ressac did not quit");
    await w!.close();
    await launch({ profile });
    const backups = readdirSync(dirname(dataDir)).filter((n) => n.startsWith(`${basename(dataDir)}.backup-`));
    expect(backups).toHaveLength(1);
    expect(existsSync(join(dirname(dataDir), backups[0]!, "session.json"))).toBe(true);
    expect(existsSync(join(dataDir, "workspace", "projects", "a", "x.txt"))).toBe(true);
    const notes = await waitFor<string[]>(
      m,
      `return [...window.gNotificationBox.allNotifications].filter((n) => n.getAttribute("value") === "ressac-data-set-aside").map((n) => n.label?.textContent ?? n.messageText?.textContent ?? n.label ?? "");`,
      (v) => v.length > 0,
    );
    expect(notes[0]).toContain("Ressac repart à neuf");
    expect(Object.values((await state(m)).tabs).some((t) => t.url === old)).toBe(false);
  });
});
