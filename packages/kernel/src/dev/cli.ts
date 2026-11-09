// Dev command: the real agent in the container, plugged into a fake browser.
// Usage: corepack pnpm dev:kernel   (Ctrl-] to quit)
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKernel, WorkshopError } from "../kernel.js";
import { FakeBridge } from "../mcp/fake-bridge.js";
import type { TabInfo, BrowserBridge } from "../mcp/bridge.js";

const github: TabInfo = { id: "github", titre: "sveltejs/svelte", url: "https://github.com/sveltejs/svelte", espace: "perso" };
const gmail: TabInfo = { id: "gmail", titre: "Gmail — Boîte de réception", url: "https://mail.google.com/mail/u/0/", espace: "perso" };
const CTRL_BRACKET = "\x1d";

const fake = new FakeBridge([github, gmail], { actif: "github", autoriser: false });
let log = "";

// The call log goes into a file: writing on stderr would damage the display of the agent's terminal.
const bridge = new Proxy(fake, {
  get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      if (log) appendFileSync(log, `${new Date().toISOString()} ${String(key)} ${JSON.stringify(args)}\n`);
      // No real browser yet: the tabs opened by the agent open in the default browser.
      if (key === "ouvrirOnglet") execFile("open", [String(args[0])]);
      return value.apply(target, args);
    };
  },
}) as BrowserBridge;

// Widgets' and actions' data: outside the workspace, in a temporary folder (no browser profile here).
const kernel = await createKernel({ pont: bridge, dossierWidgets: join(tmpdir(), "webaios-dev-widgets"), dossierActions: join(tmpdir(), "webaios-dev-actions") });
log = join(kernel.chemins.interne, "dev-pont.log");
console.log(`Espace : ${kernel.chemins.racine}\nAppels du navigateur factice : tail -f ${log}\nCtrl-] pour quitter.\n`);

let session;
try {
  session = await kernel.ouvrirSessionAgent({ cols: process.stdout.columns ?? 100, rows: process.stdout.rows ?? 30 });
  // After opening: a new session starts without authorization.
  kernel.politique.interactionUtilisateur(github); // the user « talks to the agent » from the GitHub tab
} catch (e) {
  console.error(e instanceof WorkshopError ? `Agent indisponible : ${e.message}` : e);
  await kernel.arreter();
  process.exit(1);
}

const quit = async (code: number) => {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  session.arreter();
  await kernel.arreter();
  console.log(`\nAppels reçus : ${fake.appels.map((a) => a.methode).join(", ") || "aucun"}`);
  process.exit(code);
};

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d: string) => (d === CTRL_BRACKET ? void quit(0) : session.ecrire(d)));
process.stdout.on("resize", () => session.redimensionner(process.stdout.columns, process.stdout.rows));
session.surDonnees((d) => process.stdout.write(d));
session.surFin((code) => void quit(code));
