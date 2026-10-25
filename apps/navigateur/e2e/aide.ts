import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, realpathSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { AddressInfo } from "node:net";

const RACINE = join(__dirname, "..");

export function nouveauProfil(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "webaios-profil-")));
}

/** Lance le navigateur construit (out/) sur un profil isolé et renvoie la fenêtre de l'interface. */
export async function lancer(o: { profil?: string; env?: Record<string, string> } = {}): Promise<{
  app: ElectronApplication;
  fenetre: Page;
  profil: string;
  fermer(): Promise<void>;
}> {
  const profil = o.profil ?? nouveauProfil();
  const app = await electron.launch({
    args: [join(RACINE, "out/main/index.js")],
    env: { ...process.env, WEBAIOS_PROFIL: profil, ...o.env } as Record<string, string>,
  });
  const fenetre = await app.firstWindow();
  await fenetre.waitForLoadState("domcontentloaded");
  return { app, fenetre, profil, fermer: () => app.close() };
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".pdf": "application/pdf", ".txt": "text/plain" };

/** Sert e2e/pages/* ; /telecharger/<nom> force le téléchargement, /cookie pose un cookie persistant. */
export async function serveurTest(): Promise<{ url: string; fermer(): Promise<void> }> {
  const serveur = createServer((req, res) => {
    const chemin = new URL(req.url ?? "/", "http://x").pathname;
    if (chemin === "/cookie") {
      res.writeHead(200, { "Set-Cookie": "essai=1; Max-Age=86400; Path=/", "Content-Type": "text/html" });
      return res.end("<title>cookie</title>ok");
    }
    if (chemin === "/lire-cookie") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(`<title>${req.headers.cookie ?? "aucun"}</title>`);
    }
    const telechargement = chemin.startsWith("/telecharger/");
    const fichier = join(__dirname, "pages", telechargement ? chemin.slice("/telecharger/".length) : chemin.slice(1));
    if (!existsSync(fichier)) return res.writeHead(404).end();
    res.writeHead(200, {
      "Content-Type": TYPES[extname(fichier)] ?? "application/octet-stream",
      ...(telechargement ? { "Content-Disposition": `attachment; filename="${chemin.split("/").pop()}"` } : {}),
    });
    res.end(readFileSync(fichier));
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`,
    fermer: () => new Promise((ok) => serveur.close(() => ok())),
  };
}
