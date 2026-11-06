import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { inBrowser } from "./sites";

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
