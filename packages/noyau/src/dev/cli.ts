// Commande de développement : le vrai agent dans le conteneur, branché sur un navigateur factice.
// Usage : corepack pnpm dev:noyau   (Ctrl-] pour quitter)
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { creerNoyau, ErreurAtelier } from "../noyau.js";
import { PontFactice } from "../mcp/pont-factice.js";
import type { OngletInfo, PontNavigateur } from "../mcp/pont.js";

const github: OngletInfo = { id: "github", titre: "sveltejs/svelte", url: "https://github.com/sveltejs/svelte", espace: "perso" };
const gmail: OngletInfo = { id: "gmail", titre: "Gmail — Boîte de réception", url: "https://mail.google.com/mail/u/0/", espace: "perso" };
const CTRL_CROCHET = "\x1d";

const factice = new PontFactice([github, gmail], { actif: "github", autoriser: false });
let journal = "";

// Le journal des appels va dans un fichier : écrire sur stderr abîmerait l'affichage du terminal de l'agent.
const pont = new Proxy(factice, {
  get(cible, cle, recepteur) {
    const valeur = Reflect.get(cible, cle, recepteur);
    if (typeof valeur !== "function") return valeur;
    return (...args: unknown[]) => {
      if (journal) appendFileSync(journal, `${new Date().toISOString()} ${String(cle)} ${JSON.stringify(args)}\n`);
      // Pas encore de vrai navigateur : les onglets ouverts par l'agent s'ouvrent dans le navigateur par défaut.
      if (cle === "ouvrirOnglet") execFile("open", [String(args[0])]);
      return valeur.apply(cible, args);
    };
  },
}) as PontNavigateur;

const noyau = await creerNoyau({ pont });
journal = join(noyau.chemins.interne, "dev-pont.log");
console.log(`Espace : ${noyau.chemins.racine}\nAppels du navigateur factice : tail -f ${journal}\nCtrl-] pour quitter.\n`);

let session;
try {
  session = await noyau.ouvrirSessionAgent({ cols: process.stdout.columns ?? 100, rows: process.stdout.rows ?? 30 });
  // Après l'ouverture : une nouvelle session repart sans autorisation.
  noyau.politique.interactionUtilisateur(github); // L'utilisateur « parle à l'agent » depuis l'onglet GitHub
} catch (e) {
  console.error(e instanceof ErreurAtelier ? `Agent indisponible : ${e.message}` : e);
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
