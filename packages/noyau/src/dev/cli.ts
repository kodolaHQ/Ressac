// Dev command: the real agent in the container, plugged into a fake browser.
// Usage: corepack pnpm dev:noyau   (Ctrl-] to quit)
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKernel, WorkshopError } from "../noyau.js";
import { PontFactice } from "../mcp/pont-factice.js";
import type { TabInfo, BrowserBridge } from "../mcp/pont.js";

const github: TabInfo = { id: "github", titre: "sveltejs/svelte", url: "https://github.com/sveltejs/svelte", espace: "perso" };
const gmail: TabInfo = { id: "gmail", titre: "Gmail — Boîte de réception", url: "https://mail.google.com/mail/u/0/", espace: "perso" };
const CTRL_CROCHET = "\x1d";

const factice = new PontFactice([github, gmail], { actif: "github", autoriser: false });
let journal = "";

// The call log goes into a file: writing on stderr would damage the display of the agent's terminal.
const pont = new Proxy(factice, {
  get(target, key, receiver) {
    const valeur = Reflect.get(target, key, receiver);
    if (typeof valeur !== "function") return valeur;
    return (...args: unknown[]) => {
      if (journal) appendFileSync(journal, `${new Date().toISOString()} ${String(key)} ${JSON.stringify(args)}\n`);
      // No real browser yet: the tabs opened by the agent open in the default browser.
      if (key === "ouvrirOnglet") execFile("open", [String(args[0])]);
      return valeur.apply(target, args);
    };
  },
}) as BrowserBridge;

// Widgets' and actions' data: outside the workspace, in a temporary folder (no browser profile here).
const noyau = await createKernel({ pont, dossierWidgets: join(tmpdir(), "webaios-dev-widgets"), dossierActions: join(tmpdir(), "webaios-dev-actions") });
journal = join(noyau.chemins.interne, "dev-pont.log");
console.log(`Espace : ${noyau.chemins.racine}\nAppels du navigateur factice : tail -f ${journal}\nCtrl-] pour quitter.\n`);

let session;
try {
  session = await noyau.ouvrirSessionAgent({ cols: process.stdout.columns ?? 100, rows: process.stdout.rows ?? 30 });
  // After opening: a new session starts without authorization.
  noyau.politique.interactionUtilisateur(github); // the user « talks to the agent » from the GitHub tab
} catch (e) {
  console.error(e instanceof WorkshopError ? `Agent indisponible : ${e.message}` : e);
  await noyau.arreter();
  process.exit(1);
}

const quitter = async (code: number) => {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  session.arreter();
  await noyau.arreter();
  console.log(`\nAppels reçus : ${factice.appels.map((a) => a.methode).join(", ") || "aucun"}`);
  process.exit(code);
};

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d: string) => (d === CTRL_CROCHET ? void quitter(0) : session.ecrire(d)));
process.stdout.on("resize", () => session.redimensionner(process.stdout.columns, process.stdout.rows));
session.surDonnees((d) => process.stdout.write(d));
session.surFin((code) => void quitter(code));
