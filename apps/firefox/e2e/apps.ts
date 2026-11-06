import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { dispatch, state, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { inBrowser } from "./sites";
import { click, inUi, waitUi } from "./ui";

// Agent app helpers, ported from Electron's e2e (apps/navigateur/e2e/aide.ts:363-403, applications.spec.ts) with English names.

/** A fake app's ports (one block of 5 per e2e file: they run in parallel) and Electron's short delay before « En erreur ». */
export const APPS_ENV = (block: [number, number]) => ({ WEBAIOS_PORTS_APPS: `${block[0]}-${block[1]}`, WEBAIOS_DELAI_APP_MS: "3000" });

// 1×1 PNG, the app's same-origin icon.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const SERVERS = {
  // Electron's: /redirige redirects elsewhere server side; /retient refuses to be left; /sans-titre has no <title>.
  // Added for Firefox: /page2 (same origin), /icone?href=<url> (a page whose icon is <url>), /icon.png, /vers-file and
  // /vers-data (redirects off the web).
  ok: (dossier: string) => `import { createServer } from "node:http";
const PNG = Buffer.from("${PNG}", "base64");
createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.url === "/redirige") return res.writeHead(302, { Location: "https://exemple.invalide/redirige" }).end();
  if (req.url === "/vers-file") return res.writeHead(302, { Location: "file:///etc/hosts" }).end();
  if (req.url === "/vers-data") return res.writeHead(302, { Location: "data:text/html,<title>data</title>" }).end();
  if (u.pathname === "/icon.png") return res.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  if (req.url === "/retient") return res.end('<title>Retient</title><script>addEventListener("beforeunload", (e) => e.preventDefault())</script>');
  if (req.url === "/sans-titre") return res.end("<p>sans titre</p>");
  if (req.url === "/page2") return res.end("<title>Page 2</title><p>page 2</p>");
  if (u.pathname === "/icone") return res.end('<title>Icone</title><link rel="icon" href="' + u.searchParams.get("href").replaceAll('"', "") + '">');
  res.end('<title>Essai ${dossier}</title><a href="https://exemple.invalide/">lien</a>');
}).listen(Number(process.env.PORT));
`,
  plante: () => `process.stderr.write("boum\\n");
process.exit(3);
`,
  muet: () => `setInterval(() => {}, 1000);
`,
  // A sign-up form: the design mode's test page in an app window.
  formulaire: () => `import { createServer } from "node:http";
createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end('<title>Inscription</title><form id="inscription"><input id="email" class="champ" type="email"> <button id="envoyer" type="button">Envoyer</button></form>');
}).listen(Number(process.env.PORT));
`,
};

/**
 * Electron's ecrireProjet: `<dataDir>/espace/projets/<dossier>/` with `serveur.mjs` and, if `manifeste` is given,
 * `webaios.json` (a string is written as is; an object completes `{ type: "application", lancement: "node serveur.mjs" }`).
 */
export function writeProject(dataDir: string, dossier: string, o: { manifeste?: object | string; serveur?: keyof typeof SERVERS } = {}): void {
  const dir = join(dataDir, "espace", "projets", dossier);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "serveur.mjs"), SERVERS[o.serveur ?? "ok"](dossier));
  if (o.manifeste === undefined) return;
  writeFileSync(join(dir, "webaios.json"), typeof o.manifeste === "string" ? o.manifeste : JSON.stringify({ type: "application", lancement: "node serveur.mjs", ...o.manifeste }));
}

/** Launches app « essai » with the agent's tool; returns its port. */
export async function launchEssai(dataDir: string): Promise<number> {
  const { texte } = await callTool(dataDir, "lancer_application", { dossier: "essai" });
  expect(texte).toMatch(/en marche sur http:\/\/localhost:\d+/);
  return Number(/localhost:(\d+)/.exec(texte)![1]);
}

/** Chrome-context expression: the window of app `dossier` (the attribute set by setupAppWindow), or undefined. */
export const appWindowExpr = (dossier: string) =>
  `[...Services.wm.getEnumerator("navigator:browser")].find((w) => w.document.documentElement.getAttribute("webaios-app") === ${JSON.stringify(dossier)})`;

/** Runs `script` in the content of app `dossier`'s view (see inBrowser). */
export const inAppView = <T>(m: Marionette, dossier: string, script: string, o: { frame?: number; gesture?: boolean } = {}): Promise<T> =>
  inBrowser<T>(m, `${appWindowExpr(dossier)}.gBrowser.selectedBrowser`, script, o);

/** The fake docker's stop scripts so far (`<dataDir>/espace/faux-docker-arrets.log`). */
export const stopsLog = (dataDir: string): string => {
  const f = join(dataDir, "espace", "faux-docker-arrets.log");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};

/** afterEach: kills the fake apps' process groups a failed test left on their ports (applications.spec.ts:9-20). */
export function killFakeApps(dataDir: string): void {
  const dir = join(dataDir, "espace");
  for (const f of existsSync(dir) ? readdirSync(dir) : [])
    if (/^faux-docker-app-.*\.pid$/.test(f))
      try {
        process.kill(-Number(readFileSync(join(dir, f), "utf8")), "SIGKILL");
      } catch {
        // already stopped
      }
}

/** Does something answer on the port? */
export async function answers(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

/** What the fake agent got as input (`<dataDir>/espace/faux-agent-entree.txt`): a pre-filled text without \r was never sent. */
export const agentInput = (dataDir: string): string => {
  const f = join(dataDir, "espace", "faux-agent-entree.txt");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};

export interface AppsPage {
  w: LaunchedWebAiOs;
  m: Marionette;
  dataDir: string;
  profile: string;
}

/**
 * Electron's ouvrirPage (applications.spec.ts:273): three projects (`essai` an application, `zod` a POC, `vieux` without
 * manifest) and the Applications page open. `lent`: essai's server waits a second before listening (« Lancement… » shows).
 * `dataDir` and `profile` given are reused (a restart); the caller removes the folders.
 */
export async function openAppsPage(
  block: [number, number],
  o: { env?: Record<string, string>; projets?: boolean; lent?: boolean; sansFiche?: string[]; prepare?: (dataDir: string) => void; dataDir?: string; profile?: string; page?: boolean } = {},
): Promise<AppsPage> {
  const dataDir = o.dataDir ?? (await mkdtemp(join(os.tmpdir(), "webaios-data-")));
  const profile = o.profile ?? (await mkdtemp(join(os.tmpdir(), "webaios-firefox-")));
  if (!o.dataDir) {
    if (o.projets ?? true) {
      writeProject(dataDir, "essai", { manifeste: { nom: "Essai", ...(o.lent ? { lancement: "sleep 1 && node serveur.mjs" } : {}) } });
      writeProject(dataDir, "zod", { manifeste: { type: "poc", origine: "https://github.com/colinhacks/zod" } });
      writeProject(dataDir, "vieux");
    }
    for (const d of o.sansFiche ?? []) writeProject(dataDir, d);
    o.prepare?.(dataDir);
  }
  const w = await launchWebAiOs({ dataDir, profile, env: { ...APPS_ENV(block), ...o.env } });
  const m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await expect.poll(() => existsSync(join(dataDir, "espace", ".webaios", "mcp.json")), { timeout: 15_000 }).toBe(true);
  if (o.page ?? true) {
    await dispatch(m, { type: "ouvrirApplications", fenetreId: (await state(m)).fenetres[0]!.id });
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"page-applications\"]')");
  }
  return { w, m, dataDir, profile };
}

/** Closes WebAiOs, kills the fake apps left, removes its folders. */
export async function closeAppsPage(p: AppsPage | undefined): Promise<void> {
  if (!p) return;
  await p.w.close();
  killFakeApps(p.dataDir);
  await rm(p.dataDir, { recursive: true, force: true });
  await rm(p.profile, { recursive: true, force: true });
}

/** The page's app rows (`appli-<dossier>`). */
export const rowCount = (m: Marionette): Promise<number> => inUi<number>(m, `return doc.querySelectorAll('[data-testid^="appli-"]').length;`);
export const appRow = (dossier: string) => `[data-testid="appli-${dossier}"]`;
/** Waits until row `dossier`'s data-etat is `etat`. */
export const rowState = (m: Marionette, dossier: string, etat: string, ms = 10_000) =>
  waitUi(m, "return doc.querySelector(arguments[0])?.dataset.etat === arguments[1]", [appRow(dossier), etat], ms);
/** Clicks the row's button whose text contains `name`. */
export const rowButton = (m: Marionette, dossier: string, name: string) => click(m, `${appRow(dossier)} .actions button`, { text: name });
/** Opens the row's ⋯ menu and clicks its item `name`. */
export async function rowMenu(m: Marionette, dossier: string, name: string): Promise<void> {
  await click(m, `${appRow(dossier)} button.options`);
  await click(m, '[role="menuitem"]', { text: name });
}
/** The labels of row `dossier`'s ⋯ menu (left open). */
export async function rowMenuItems(m: Marionette, dossier: string): Promise<string[]> {
  await click(m, `${appRow(dossier)} button.options`);
  return waitUi<string[]>(m, `const l = [...doc.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim()); return l.length > 0 && l;`);
}
