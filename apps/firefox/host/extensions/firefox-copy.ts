import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { GECKO_ID, VERSION_FOUR } from "./amo";

export const ID_SUFFIX = "@agent.ressac";
export const addonIdOf = (folder: string) => `${folder}${ID_SUFFIX}`;

const KEEP_BACKGROUND = "ressac-background-guard.js";
const BACKGROUND = "ressac-background.js";
const GENERATED_PAGE = "_generated_background_page.html";
const SANDBOX = "sandbox allow-scripts allow-same-origin allow-forms allow-modals";

const object = (v: unknown): Record<string, any> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : undefined);

/**
 * The rights an agent extension may hold in Firefox: the `connus` of
 * packages/kernel/src/extensions/manifeste.ts, but notifications, which Ressac never shows, and activeTab, which Ressac
 * lists as unsupported and with which Firefox lets a click capture a tab), plus declarativeNetRequest*.
 * Firefox has more (identity, dns, find, menus…), which no Ressac guard closes: refused.
 */
const ALLOWED_RIGHTS = new Set(["scripting", "storage", "unlimitedStorage", "tabs", "contextMenus", "cookies", "webNavigation", "alarms", "offscreen", "clipboardRead", "clipboardWrite"]);
/** Firefox manifest keys that grant a power outside the guards (a search engine, URL handlers, user scripts, privileged APIs, the address bar). */
const KEYS_DENIED = ["chrome_settings_overrides", "protocol_handlers", "user_scripts", "experiment_apis", "theme_experiment", "omnibox"];
/** Ressac's own refusal text (decision 9's style). */
export const unsupportedRight = (name: string) => `Droit non pris en charge par Ressac : ${name}`;

/**
 * Refusals prepareCopy does not make (GECKO_ID, VERSION_FOUR, a file named _generated_background_page.html, a
 * right or a key outside what an agent extension may use).
 */
export function firefoxDenial(manifest: Record<string, unknown>, files: readonly string[]): string[] {
  const denial: string[] = [];
  for (const key of ["permissions", "optional_permissions"])
    for (const right of Array.isArray(manifest[key]) ? (manifest[key] as unknown[]) : [])
      if (!(typeof right === "string" && (ALLOWED_RIGHTS.has(right) || right.startsWith("declarativeNetRequest")))) denial.push(unsupportedRight(String(right)));
  for (const key of KEYS_DENIED) if (key in manifest) denial.push(unsupportedRight(key));
  const gecko = object(object(manifest.browser_specific_settings)?.gecko) ?? object(object(manifest.applications)?.gecko);
  if (gecko && "id" in gecko) denial.push(GECKO_ID);
  if (typeof manifest.version === "string" && manifest.version.split(".").length > 3) denial.push(VERSION_FOUR);
  // Same text as prepareCopy's reserved names (packages/kernel/src/extensions/copie.ts); the guard finds the background by this name.
  if (files.includes(GENERATED_PAGE)) denial.push(`Nom de fichier réservé à Ressac : ${GENERATED_PAGE}`);
  return denial;
}

/**
 * The copy's manifest for Firefox (decisions 2, 3): gecko id, background.scripts, version `<a>.<b>.<c>.<n>`. Pure.
 * `m` is prepareCopy's manifest; `fondOriginal` (required, so a forgotten argument cannot drop the background) is the agent's `background.service_worker` (only the generated
 * ressac-background.js knows it after the copy), used for a classic background.
 */
export function firefoxManifest(m: Record<string, unknown>, folder: string, n: number, originalBackground: string | undefined): Record<string, unknown> {
  const background = object(m.background);
  const numbers = String(m.version ?? "").split(".");
  const version = [0, 1, 2].map((i) => numbers[i] || "0").concat(String(n)).join(".");
  const bss = object(m.browser_specific_settings) ?? {};
  const copy: Record<string, unknown> = {
    ...m,
    version,
    browser_specific_settings: { ...bss, gecko: { ...bss.gecko, id: addonIdOf(folder), data_collection_permissions: { required: ["none"] } } },
  };
  // No agent page opens a window (window.open, document.open with an
  // address, target=_blank). Firefox: its pages are sandboxed without allow-popups (the same origin, scripts and the
  // extension API kept).
  const csp = object(m.content_security_policy);
  // prepareCopy always writes a string CSP; without one, the sandbox is still set (never dropped silently).
  copy.content_security_policy = { ...csp, extension_pages: typeof csp?.extension_pages === "string" ? `${csp.extension_pages}; ${SANDBOX}` : `script-src 'self'; ${SANDBOX}` };
  if (background?.service_worker === BACKGROUND && background.type === "module") copy.background = { scripts: [BACKGROUND], type: "module" };
  else if (background?.service_worker === BACKGROUND && originalBackground) copy.background = { scripts: [KEEP_BACKGROUND, originalBackground.replace(/^(\.\/|\/)+/, "")] };
  else copy.background = { scripts: [KEEP_BACKGROUND] };
  return copy;
}

let file: Promise<unknown> = Promise.resolve();

/** amo-versions.json in `folder`: the counter of `id` + 1, written (atomic rename) before it is returned; never lowered nor cleared. */
export function nextVersion(folder: string, id: string): Promise<number> {
  const next = file.then(async () => {
    const file = path.join(folder, "amo-versions.json");
    let counters: Record<string, number> = {};
    // An unreadable file throws: starting over would reuse numbers AMO already took.
    try {
      counters = JSON.parse(await readFile(file, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const n = (counters[id] ?? 0) + 1;
    await mkdir(folder, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...counters, [id]: n }));
    await rename(tmp, file);
    return n;
  });
  file = next.catch(() => {});
  return next;
}

/** `zip -qrX` of the copy (like e2e/addons.ts), manifest first. */
export async function zipper(copy: string, xpi: string): Promise<void> {
  await rm(xpi, { force: true });
  await promisify(execFile)("zip", ["-qrX", xpi, "manifest.json", "."], { cwd: copy });
}
