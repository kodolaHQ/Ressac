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

type AvecApi = Window & { webaios: { agir(a: unknown): void; fenetreId: string } };

/** Ouvre un onglet via l'API de l'interface. */
export async function ouvrirOnglet(fenetre: Page, url: string, o: { activer?: boolean; ouvertParAgent?: boolean } = {}): Promise<void> {
  await fenetre.evaluate(
    ([url, o]) => {
      const w = window as unknown as AvecApi;
      w.webaios.agir({ type: "ouvrirOnglet", fenetreId: w.webaios.fenetreId, url, ...o });
    },
    [url, o] as const,
  );
}

/** Nombre de webContents vivants (interface comprise). */
export function nombreWebContents(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => !w.isDestroyed()).length);
}

/** Exécute du JS dans la vue web dont l'URL contient `morceau` (avec geste utilisateur). */
export function dansLaVue(app: ElectronApplication, morceau: string, code: string): Promise<unknown> {
  return app.evaluate(
    ({ webContents }, [morceau, code]) => webContents.getAllWebContents().find((w) => w.getURL().includes(morceau))?.executeJavaScript(code, true),
    [morceau, code] as const,
  );
}
