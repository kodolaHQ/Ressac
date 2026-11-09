import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { pressKeys } from "./ui";

// Probes of plan 24's unknowns (docs/superpowers/notes/2026-11-04-historique-telechargements-essai.md). They print what they
// see rather than assert it: rerun them with WEBAIOS_SPIKE=1 after a Firefox version change and compare with the note.

const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";
const note = (what: string, v: unknown) => console.log(`[spike] ${what}: ${JSON.stringify(v)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PLACES_OFF = 'Services.prefs.getDefaultBranch("").setBoolPref("places.history.enabled", false);';

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs | undefined;
let m: Marionette;
const dirs: string[] = [];

async function launch(o: { placesOff: boolean; profile?: string; dataDir?: string; dl?: string }): Promise<string> {
  const dl = o.dl ?? (await mkdtemp(path.join(os.tmpdir(), "webaios-dl-")));
  if (!o.dl) dirs.push(dl);
  w = await launchWebAiOs({ profile: o.profile, dataDir: o.dataDir, prefs: { "browser.download.folderList": 2, "browser.download.dir": dl } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  if (o.placesOff) await m.execute(PLACES_OFF);
  return dl;
}

/** Opens `url` in a WebAiOs tab and waits until it is loaded; returns the tab id. */
async function open(url: string): Promise<string> {
  const before = new Set(Object.keys((await state(m)).tabs));
  const s = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url });
  await loaded(url);
  return Object.keys(s.tabs).find((id) => !before.has(id))!;
}
const loaded = (url: string) =>
  waitFor(m, `return gBrowser.selectedBrowser.currentURI.spec === ${JSON.stringify(url)} && !gBrowser.selectedBrowser.webProgress.isLoadingDocument`, (v) => v === true);
const current = () => m.execute<string>("return gBrowser.selectedBrowser.currentURI.spec");
const hasVisits = (url: string) => m.execute<boolean>("return PlacesUtils.history.hasVisits(Services.io.newURI(arguments[0]))", [url]);

async function inPage<T>(id: string, script: string): Promise<T> {
  const handle = await m.execute<string>(
    `const t = gBrowser.tabs.find((t) => t.getAttribute("webaios-tab-id") === arguments[0]);
     return ChromeUtils.importESModule("${NAVIGABLES}").NavigableManager.getIdForBrowser(t.linkedBrowser);`,
    [id],
  );
  await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
  await m.setContext("content");
  try {
    return await m.execute<T>(script);
  } finally {
    await m.setContext("chrome");
  }
}

const DOWNLOADS = `return (async () => {
  const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
  const list = await Downloads.getList(Downloads.ALL);
  return (await list.getAll()).map((d) => ({ succeeded: d.succeeded, path: d.target.path, currentBytes: d.currentBytes, totalBytes: d.totalBytes, hasProgress: d.hasProgress, startTime: String(d.startTime) }));
})();`;

describe.skipIf(!process.env.WEBAIOS_SPIKE)("history and downloads spike", () => {
  beforeAll(async () => (server = await startServer()));
  afterAll(async () => {
    await server?.close();
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });
  afterEach(async () => {
    await w?.close();
    w = undefined;
  });

  for (const placesOff of [true, false]) {
    it(`S1: Places ${placesOff ? "off" : "on (control)"}`, async () => {
      const tag = `S1 ${placesOff ? "off" : "on"}`;
      await launch({ placesOff });
      await m.execute("Services.console.reset();");
      const a = `${server.url}/a.html`, icon = `${server.url}/icone`, b = `${server.url}/b.html`;
      await open(a);
      const id = await open(icon);
      // Read the icon while the tab still shows /icone.
      await sleep(3000);
      note(`${tag} favicon of /icone in the state`, (await state(m)).tabs[id]?.favicon);
      note(`${tag} tab image / mIconURL of /icone's browser`, await m.execute(
        `const t = gBrowser.tabs.find((t) => t.getAttribute("webaios-tab-id") === arguments[0]); return { image: t.image, mIconURL: t.linkedBrowser.mIconURL ?? null };`,
        [id],
      ));
      await m.execute("gBrowser.selectedBrowser.loadURI(Services.io.newURI(arguments[0]), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });", [b]);
      await loaded(b);
      await sleep(2500); // history writes are batched
      note(`${tag} hasVisits a/icone/b`, [await hasVisits(a), await hasVisits(icon), await hasVisits(b)]);
      note(`${tag} places.history.enabled`, await m.execute('return Services.prefs.getBoolPref("places.history.enabled")'));
      await pressKeys(m, "Meta+[");
      await loaded(icon).then(() => note(`${tag} Meta+[ goes back to /icone`, true), async () => note(`${tag} Meta+[`, { now: await current() }));
      await pressKeys(m, "Meta+]");
      await loaded(b).then(() => note(`${tag} Meta+] goes forward to b.html`, true), async () => note(`${tag} Meta+]`, { now: await current() }));
      const tabs = () => m.execute<number>("return gBrowser.tabs.filter((t) => t.hasAttribute('webaios-tab-id')).length");
      const before = await tabs();
      await pressKeys(m, "Meta+w");
      await sleep(800);
      const closed = await tabs();
      await pressKeys(m, "Meta+Shift+t");
      await sleep(1500);
      note(`${tag} tabs before close, after close, after Meta+Shift+t`, [before, closed, await tabs()]);
      note(`${tag} console errors naming places/favicon`, await m.execute(
        `return Services.console.getMessageArray().map((x) => x.message ?? String(x)).filter((s) => /places|favicon/i.test(s)).slice(0, 10).map((s) => s.slice(0, 300));`,
      ));
    }, 90_000);
  }

  /** Two clicks on #lien of telecharger.html, then what the Downloads API and the window show. */
  async function downloadTwice(dl: string, tag: string): Promise<void> {
    const id = await open(`${server.url}/telecharger.html`);
    for (let i = 0; i < 2; i++) {
      await inPage(id, 'document.getElementById("lien").click(); return 0');
      await sleep(1500);
    }
    note(`${tag} names in dl`, (await readdir(dl)).sort());
    note(`${tag} Downloads list`, await m.execute(DOWNLOADS));
    note(`${tag} panel and windows`, await m.execute(
      `return { panel: document.getElementById("downloadsPanel")?.state ?? null, alwaysOpenPanel: Services.prefs.getBoolPref("browser.download.alwaysOpenPanel", null),
        windows: [...Services.wm.getEnumerator(null)].map((x) => x.location.href), tabs: gBrowser.tabs.map((t) => t.linkedBrowser?.currentURI?.spec) };`,
    ));
  }

  it("S2: slow download and cancel", async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-spike-profile-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-spike-data-"));
    dirs.push(profile, dataDir);
    const dl = path.join(dataDir, "dl");
    await mkdir(dl);
    await launch({ placesOff: true, profile, dataDir, dl });
    await downloadTwice(dl, "S2");
    server.paths.length = 0;
    const slow = await m.execute<unknown>(
      `return (async () => {
        const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
        const d = await Downloads.createDownload({ source: arguments[0], target: arguments[1] });
        const list = await Downloads.getList(Downloads.ALL);
        await list.add(d);
        d.start().catch(() => {});
        await new Promise((r) => setTimeout(r, 1500));
        const before = { currentBytes: d.currentBytes, totalBytes: d.totalBytes, hasProgress: d.hasProgress };
        await d.cancel();
        return { before, canceled: d.canceled, stopped: d.stopped, hasPartialData: d.hasPartialData, error: d.error && String(d.error) };
      })();`,
      [`${server.url}/fichier-lent`, path.join(dl, "lent.bin")],
    );
    await sleep(3000);
    note("S2 /fichier-lent after cancel", { ...(slow as object), closedSeen: server.paths.includes("/fichier-lent:fermée") });
    await w!.close();
    w = undefined;
    note("S2 /fichier-lent connection closed once Firefox quit", server.paths.includes("/fichier-lent:fermée"));
  }, 120_000);

  /** Downloads once, quits, relaunches on the same profile: what each list gives back. */
  for (const placesOff of [true, false]) {
    it(`S2: restart with Places ${placesOff ? "off" : "on"}`, async () => {
      const tag = `S2 restart ${placesOff ? "off" : "on"}`;
      const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-spike-profile-"));
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-spike-data-"));
      dirs.push(profile, dataDir);
      const dl = path.join(dataDir, "dl");
      await mkdir(dl);
      await launch({ placesOff, profile, dataDir, dl });
      await downloadTwice(dl, tag);
      await sleep(2000); // downloads.json is saved with a delay
      await w!.close();
      w = undefined;
      await launch({ placesOff, profile, dataDir, dl });
      await sleep(3000);
      note(`${tag} after restart`, await m.execute(
        `return (async () => {
          const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
          const { DownloadHistory } = ChromeUtils.importESModule("resource://gre/modules/DownloadHistory.sys.mjs");
          const all = await (await Downloads.getList(Downloads.ALL)).getAll();
          const pub = await (await Downloads.getList(Downloads.PUBLIC)).getAll();
          const hist = await (await DownloadHistory.getList({ type: Downloads.PUBLIC, maxHistoryResults: 100 })).getAll();
          return { all: all.length, public: pub.length, history: hist.map((d) => ({ path: d.target.path, succeeded: d.succeeded })), files: arguments[0] };
        })();`,
        [await readdir(dl)],
      ));
    }, 120_000);
  }

  it("S2: control, Places on, two downloads", async () => {
    const dl = await launch({ placesOff: false });
    await downloadTwice(dl, "S2 control");
  }, 60_000);

  it("S3: native keys and commands", async () => {
    await launch({ placesOff: false });
    await open(`${server.url}/a.html`);
    const present = await m.execute<unknown>(
      `const out = {};
       for (const id of ["showAllHistoryKb", "key_gotoHistory", "manBookmarkKb", "key_openDownloads"]) {
         const k = document.getElementById(id);
         out[id] = k && { key: k.getAttribute("key"), keycode: k.getAttribute("keycode"), modifiers: k.getAttribute("modifiers"), command: k.getAttribute("command"), oncommand: k.getAttribute("oncommand"), disabled: k.getAttribute("disabled") };
       }
       for (const id of ["Browser:ShowAllHistory", "Browser:ShowAllBookmarks", "Tools:Downloads", "History:SearchHistory"]) {
         const c = document.getElementById(id);
         out[id] = c && { oncommand: c.getAttribute("oncommand"), disabled: c.getAttribute("disabled") };
       }
       return out;`,
    );
    note("S3 present", present);
    const KEYS: [string, string][] = [["showAllHistoryKb", "Meta+y"], ["key_gotoHistory", "Meta+Shift+h"], ["manBookmarkKb", "Meta+Shift+o"], ["key_openDownloads", "Meta+j"]];
    const COMMANDS = ["Browser:ShowAllHistory", "Browser:ShowAllBookmarks", "Tools:Downloads", "History:SearchHistory"];
    // What is open now; then it is closed again so the next probe starts clean.
    const seen = () =>
      m.execute<unknown>(
        `return { sidebar: SidebarController.isOpen, sidebarCommand: SidebarController.currentID ?? null, organizer: !!Services.wm.getMostRecentWindow("Places:Organizer"),
          downloadsPanel: document.getElementById("downloadsPanel")?.state ?? null, tabs: gBrowser.tabs.map((t) => t.linkedBrowser?.currentURI?.spec),
          windows: [...Services.wm.getEnumerator(null)].map((x) => x.location.href) };`,
      );
    const reset = () =>
      m.execute(`return (async () => {
        if (SidebarController.isOpen) SidebarController.hide();
        Services.wm.getMostRecentWindow("Places:Organizer")?.close();
        document.getElementById("downloadsPanel")?.hidePopup();
        for (let i = 0; i < 30 && Services.wm.getMostRecentWindow("Places:Organizer"); i++) await new Promise((r) => setTimeout(r, 100));
        for (const t of gBrowser.tabs.filter((t) => /^about:(downloads|library)/.test(t.linkedBrowser?.currentURI?.spec))) gBrowser.removeTab(t);
        await new Promise((r) => setTimeout(r, 500));
      })();`);
    const setDisabled = (ids: string[], on: boolean) =>
      m.execute(
        `for (const id of arguments[0]) { const e = document.getElementById(id); if (!e) continue; if (arguments[1]) e.setAttribute("disabled", "true"); else e.removeAttribute("disabled"); }`,
        [ids, on],
      );
    // key_openDownloads is already disabled by the app (FIREFOX_KEYS): the first pass re-enables it to see what it does.
    for (const mode of ["enabled", "commands disabled", "keys and commands disabled"]) {
      const tag = `S3 ${mode}`;
      await setDisabled([...KEYS.map(([id]) => id), ...COMMANDS], false);
      if (mode !== "enabled") await setDisabled(COMMANDS, true);
      if (mode === "keys and commands disabled") await setDisabled(KEYS.map(([id]) => id), true);
      for (const [id, combo] of KEYS) {
        await reset();
        await pressKeys(m, combo);
        await sleep(1200);
        note(`${tag} key ${id} (${combo})`, await seen());
      }
      for (const id of COMMANDS) {
        await reset();
        const error = await m.execute<string | null>(`try { document.getElementById(arguments[0]).doCommand(); return null; } catch (e) { return String(e); }`, [id]);
        await sleep(1200);
        note(`${tag} command ${id}`, { error, ...(await seen() as object) });
      }
      await reset();
    }
    // The state the app leaves: only key_openDownloads disabled.
    await setDisabled(COMMANDS, false);
    await setDisabled(KEYS.map(([id]) => id), false);
    await setDisabled(["key_openDownloads"], true);
    await reset();
    await pressKeys(m, "Meta+j");
    await sleep(1200);
    note("S3 as the app leaves it: key_openDownloads disabled, Meta+j", await seen());
  }, 120_000);
});
