import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

/** Writes the fixture to a temp dir, zips it (`zip -qr`) into a temp .xpi; returns its path. */
export async function writeXpi(f: Fixture): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "webaios-addon-"));
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
