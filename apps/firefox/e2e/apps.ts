import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { dispatch, state, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { inBrowser } from "./sites";
import { click, inUi, startAgentSession, waitUi } from "./ui";

// Agent app helpers.

/** A fake app's ports (one block of 5 per e2e file: they run in parallel) and a short delay before « En erreur ». */
export const APPS_ENV = (block: [number, number]) => ({ RESSAC_APP_PORTS: `${block[0]}-${block[1]}`, RESSAC_APP_DELAY_MS: "3000" });

// 1×1 PNG, the app's same-origin icon.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const SERVERS = {
  // /redirige redirects elsewhere server side; /retient refuses to be left; /sans-titre has no <title>.
  // Added for Firefox: /page2 (same origin), /icone?href=<url> (a page whose icon is <url>), /icon.png, /vers-file and
  // /vers-data (redirects off the web).
  ok: (folder: string) => `import { createServer } from "node:http";
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
  res.end('<title>Essai ${folder}</title><a href="https://exemple.invalide/">lien</a>');
}).listen(Number(process.env.PORT));
`,
  crashed: () => `process.stderr.write("boum\\n");
process.exit(3);
`,
  muted: () => `setInterval(() => {}, 1000);
`,
  // A sign-up form: the design mode's test page in an app window.
  form: () => `import { createServer } from "node:http";
createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end('<title>Inscription</title><form id="inscription"><input id="email" class="champ" type="email"> <button id="envoyer" type="button">Envoyer</button></form>');
}).listen(Number(process.env.PORT));
`,
};

/**
 * Writes a project: `<dataDir>/workspace/projects/<dossier>/` with `serveur.mjs` and, if `manifeste` is given,
 * `ressac.json` (a string is written as is; an object completes `{ type: "app", launch: "node serveur.mjs" }`).
 */
export function writeProject(dataDir: string, folder: string, o: { manifest?: object | string; server?: keyof typeof SERVERS } = {}): void {
  const dir = join(dataDir, "workspace", "projects", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "serveur.mjs"), SERVERS[o.server ?? "ok"](folder));
  if (o.manifest === undefined) return;
  writeFileSync(join(dir, "ressac.json"), typeof o.manifest === "string" ? o.manifest : JSON.stringify({ type: "app", launch: "node serveur.mjs", ...o.manifest }));
}

/** Launches app « essai » with the agent's tool; returns its port. */
export async function launchAttempt(dataDir: string): Promise<number> {
  const { text } = await callTool(dataDir, "launch_app", { folder: "essai" });
  expect(text).toMatch(/en marche sur http:\/\/localhost:\d+/);
  return Number(/localhost:(\d+)/.exec(text)![1]);
}

/** Chrome-context expression: the window of app `dossier` (the attribute set by setupAppWindow), or undefined. */
export const appWindowExpr = (folder: string) =>
  `[...Services.wm.getEnumerator("navigator:browser")].find((w) => w.document.documentElement.getAttribute("ressac-app") === ${JSON.stringify(folder)})`;

/** Runs `script` in the content of app `dossier`'s view (see inBrowser). */
export const inAppView = <T>(m: Marionette, folder: string, script: string, o: { frame?: number; gesture?: boolean } = {}): Promise<T> =>
  inBrowser<T>(m, `${appWindowExpr(folder)}.gBrowser.selectedBrowser`, script, o);

/**
 * Starts the window's agent session (the panel never opens on its own); its first one runs a sweep that stops every app
 * and refuses agent launches while it runs: tests launch their apps after it.
 */
export async function waitFirstSweep(m: Marionette, dataDir: string): Promise<void> {
  await startAgentSession(m);
  for (const end = Date.now() + 15_000; !stopsLog(dataDir).includes("kill -KILL -1"); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > end) throw new Error("the first session's sweep did not run");
}

/** The fake docker's stop scripts so far (`<dataDir>/workspace/fake-docker-stops.log`). */
export const stopsLog = (dataDir: string): string => {
  const f = join(dataDir, "workspace", "fake-docker-stops.log");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};

/** afterEach: kills the fake apps' process groups a failed test left on their ports (applications.spec.ts:9-20). */
export function killFakeApps(dataDir: string): void {
  const dir = join(dataDir, "workspace");
  for (const f of existsSync(dir) ? readdirSync(dir) : [])
    if (/^fake-docker-app-.*\.pid$/.test(f))
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

/** What the fake agent got as input (`<dataDir>/workspace/fake-agent-input.txt`): a pre-filled text without \r was never sent. */
export const agentInput = (dataDir: string): string => {
  const f = join(dataDir, "workspace", "fake-agent-input.txt");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};

export interface AppsPage {
  w: LaunchedRessac;
  m: Marionette;
  dataDir: string;
  profile: string;
}

/**
 * Three projects (`essai` an application, `zod` a POC, `vieux` without
 * manifest) and the Applications page open. `lent`: essai's server waits a second before listening (« Launch… » shows).
 * `dataDir` and `profile` given are reused (a restart); the caller removes the folders.
 */
export async function openAppsPage(
  block: [number, number],
  o: { env?: Record<string, string>; projects?: boolean; slow?: boolean; noManifest?: string[]; prepare?: (dataDir: string) => void; dataDir?: string; profile?: string; page?: boolean } = {},
): Promise<AppsPage> {
  const dataDir = o.dataDir ?? (await mkdtemp(join(os.tmpdir(), "ressac-data-")));
  const profile = o.profile ?? (await mkdtemp(join(os.tmpdir(), "ressac-firefox-")));
  if (!o.dataDir) {
    if (o.projects ?? true) {
      writeProject(dataDir, "essai", { manifest: { name: "Essai", ...(o.slow ? { launch: "sleep 1 && node serveur.mjs" } : {}) } });
      writeProject(dataDir, "zod", { manifest: { type: "poc", origin: "https://github.com/colinhacks/zod" } });
      writeProject(dataDir, "vieux");
    }
    for (const d of o.noManifest ?? []) writeProject(dataDir, d);
    o.prepare?.(dataDir);
  }
  const w = await launchRessac({ dataDir, profile, env: { ...APPS_ENV(block), ...o.env } });
  const m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await expect.poll(() => existsSync(join(dataDir, "workspace", ".ressac", "mcp.json")), { timeout: 15_000 }).toBe(true);
  // Docker absent or slow: no session opens before the tests, so no sweep to wait for.
  if (!o.env?.FAKE_DOCKER_ABSENT && !o.env?.FAKE_DOCKER_SLOW) await waitFirstSweep(m, dataDir);
  if (o.page ?? true) {
    await dispatch(m, { type: "openApps", windowId: (await state(m)).windows[0]!.id });
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"page-applications\"]')");
  }
  return { w, m, dataDir, profile };
}

/** Closes Ressac, kills the fake apps left, removes its folders. */
export async function closeAppsPage(p: AppsPage | undefined): Promise<void> {
  if (!p) return;
  await p.w.close();
  killFakeApps(p.dataDir);
  await rm(p.dataDir, { recursive: true, force: true });
  await rm(p.profile, { recursive: true, force: true });
}

/** The page's app rows (`appli-<dossier>`). */
export const rowCount = (m: Marionette): Promise<number> => inUi<number>(m, `return doc.querySelectorAll('[data-testid^="app-"]').length;`);
export const appRow = (folder: string) => `[data-testid="app-${folder}"]`;
/** Waits until row `dossier`'s data-etat is `etat`. */
export const rowState = (m: Marionette, folder: string, state: string, ms = 30_000) =>
  waitUi(m, "return doc.querySelector(arguments[0])?.dataset.state === arguments[1]", [appRow(folder), state], ms);
/** Clicks the row's button whose text contains `name`. */
export const rowButton = (m: Marionette, folder: string, name: string) => click(m, `${appRow(folder)} .actions button`, { text: name });
/** Opens the row's ⋯ menu and clicks its item `name`. */
export async function rowMenu(m: Marionette, folder: string, name: string): Promise<void> {
  await waitUi(m, "return !!doc.querySelector(arguments[0])", [`${appRow(folder)} button.options`]);
  // In one script, and again if the menu went away: the agent panel's focus retries (100 and 500 ms after Déboguer)
  // close an open menu, and under load they land between two calls from here.
  const done = await inUi<boolean>(
    m,
    `const press = (el) => { const r = el.getBoundingClientRect(); for (const t of ["mousedown", "mouseup"]) ui.synthesizeMouseEvent(t, r.left + r.width / 2, r.top + r.height / 2, { button: 0, clickCount: 1 }); };
     for (const end = Date.now() + 8000; Date.now() < end; ) {
       const options = doc.querySelector(arguments[0]);
       options.scrollIntoView({ block: "center" });
       await new Promise((r) => requestAnimationFrame(r));
       press(options);
       for (let i = 0; i < 30; i++) {
         await new Promise((r) => requestAnimationFrame(r));
         const item = [...doc.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.includes(arguments[1]));
         if (item) return press(item), true;
       }
     }
     return false;`,
    [`${appRow(folder)} button.options`, name],
  );
  if (!done) throw new Error(`no « ${name} » in the menu of ${folder}`);
}
/** The labels of row `dossier`'s ⋯ menu (left open). */
export async function rowMenuItems(m: Marionette, folder: string): Promise<string[]> {
  await click(m, `${appRow(folder)} button.options`);
  return waitUi<string[]>(m, `const l = [...doc.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim()); return l.length > 0 && l;`);
}
