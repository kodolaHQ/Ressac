import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Marionette } from "./marionette";
import { ICON } from "./server";

/** A test WebExtension: its manifest (MV2, gecko id `<name>@webaios.test`) and its other files. */
export interface Fixture {
  id: string;
  manifest: Record<string, unknown>;
  files?: Record<string, string | Buffer>;
}

const xpiDirs: string[] = [];

/** Deletes the temp dirs of every xpi written so far. */
export async function cleanupXpis(): Promise<void> {
  await Promise.all(xpiDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

/** Writes the fixture to a temp dir, zips it (`zip -qr`) into a temp .xpi; returns its path. */
export async function writeXpi(f: Fixture): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "webaios-addon-"));
  xpiDirs.push(dir);
  const src = path.join(dir, "src");
  for (const [name, content] of Object.entries({ ...f.files, "manifest.json": JSON.stringify(f.manifest) })) {
    await mkdir(path.dirname(path.join(src, name)), { recursive: true });
    await writeFile(path.join(src, name), content);
  }
  const xpi = path.join(dir, `${f.id}.xpi`);
  await promisify(execFile)("zip", ["-qr", xpi, "."], { cwd: src });
  return xpi;
}

/** Marionette Addon:Install ({ path, temporary }), temporary by default; returns the add-on id. */
export async function installAddon(m: Marionette, f: Fixture, o: { temporary?: boolean } = {}): Promise<string> {
  const r = await m.command<{ value: string }>("Addon:Install", { path: await writeXpi(f), temporary: o.temporary ?? true });
  return r.value;
}

export async function uninstallAddon(m: Marionette, id: string): Promise<void> {
  await m.command("Addon:Uninstall", { id });
}

/** MV2, a browser action with an icon and a popup whose title becomes « Popup de test prête » once its script ran. */
export function button(o: { name?: string; badge?: string } = {}): Fixture {
  const id = "button@webaios.test";
  return {
    id,
    manifest: {
      manifest_version: 2,
      name: o.name ?? "Bouton de test",
      version: "1.0",
      browser_specific_settings: { gecko: { id } },
      browser_action: { default_icon: "icon.png", default_title: o.name ?? "Bouton de test", default_popup: "popup.html" },
      ...(o.badge === undefined ? {} : { background: { scripts: ["background.js"] } }),
    },
    files: {
      "icon.png": ICON,
      // Extension pages forbid inline scripts.
      "popup.html": '<!doctype html><meta charset="utf-8"><title>Popup</title><script src="popup.js"></script><p>Popup</p>',
      "popup.js": 'document.title = "Popup de test prête";',
      ...(o.badge === undefined ? {} : { "background.js": `browser.browserAction.setBadgeText({ text: ${JSON.stringify(o.badge)} });` }),
    },
  };
}

const gecko = (id: string) => ({ manifest_version: 2, version: "1.0", browser_specific_settings: { gecko: { id } } });

/** Cancels any request for pub.js (webRequest blocking). */
export function blocker(): Fixture {
  const id = "blocker@webaios.test";
  return {
    id,
    manifest: { ...gecko(id), name: "Bloqueur", permissions: ["webRequest", "webRequestBlocking", "<all_urls>"], background: { scripts: ["background.js"] } },
    files: { "background.js": 'browser.webRequest.onBeforeRequest.addListener(() => ({ cancel: true }), { urls: ["*://*/pub.js"] }, ["blocking"]);' },
  };
}

/** A content script CSS on every page that hides #cache-moi. */
export function hider(): Fixture {
  const id = "hider@webaios.test";
  return {
    id,
    manifest: { ...gecko(id), name: "Cacheur", content_scripts: [{ matches: ["<all_urls>"], css: ["hide.css"] }] },
    files: { "hide.css": "#cache-moi { display: none }" },
  };
}

/** Notes to `base`/note/<what> on runtime.onInstalled (`installed-<reason>`, plus `-from-<previousVersion>` on update) and at each background start (`started`). */
export function installed(base: string): Fixture {
  const id = "installed@webaios.test";
  return {
    id,
    manifest: { ...gecko(id), name: "Installé", permissions: ["<all_urls>"], background: { scripts: ["background.js"] } },
    files: {
      "background.js": `const note = (what) => fetch(${JSON.stringify(base)} + "/note/" + what).catch(() => {});
browser.runtime.onInstalled.addListener((d) => note("installed-" + d.reason + (d.previousVersion ? "-from-" + d.previousVersion : "")));
note("started");`,
    },
  };
}

/**
 * Electron's sonde, the part that opens tabs: on a page whose URL has `ouvrir-onglet`, its background calls tabs.create with
 * that URL, `ouverte-par-sonde` in place; on `ouvrir-actif`, tabs.create({ active: true }) with `ouverte-active`.
 */
export function probe(): Fixture {
  const id = "probe@webaios.test";
  return {
    id,
    manifest: {
      ...gecko(id),
      name: "Sonde",
      background: { scripts: ["background.js"] },
      content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
    },
    files: {
      "background.js": "browser.runtime.onMessage.addListener((m) => void browser.tabs.create(m));",
      "content.js": `const u = location.href;
if (u.includes("ouvrir-onglet")) browser.runtime.sendMessage({ url: u.replace("ouvrir-onglet", "ouverte-par-sonde") });
else if (u.includes("ouvrir-actif")) browser.runtime.sendMessage({ url: u.replace("ouvrir-actif", "ouverte-active"), active: true });`,
    },
  };
}

/** An options page (options_ui, open_in_tab as asked); a page whose query is `?options` makes its background call runtime.openOptionsPage(). */
export function options(o: { inTab: boolean }): Fixture {
  const id = `options-${o.inTab ? "tab" : "embedded"}@webaios.test`;
  return {
    id,
    manifest: {
      ...gecko(id),
      name: "Options",
      options_ui: { page: "options.html", open_in_tab: o.inTab },
      background: { scripts: ["background.js"] },
      content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
    },
    files: {
      "options.html": '<!doctype html><meta charset="utf-8"><title>Options de test</title><p>Options</p>',
      // Content scripts have no runtime.openOptionsPage.
      "background.js": "browser.runtime.onMessage.addListener(() => void browser.runtime.openOptionsPage());",
      "content.js": 'if (location.search === "?options") browser.runtime.sendMessage("options");',
    },
  };
}
