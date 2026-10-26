import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { AddressInfo } from "node:net";

const RACINE = join(__dirname, "..");

/**
 * Espace de l'agent (~/WebAiOs pour l'utilisateur) : un dossier temporaire par test, jamais le vrai. Son `accueil/` existe
 * déjà : les blocs modèles ne sont pas copiés (daily.dev serait chargé depuis internet à chaque test).
 */
export function nouvelleRacine(): string {
  const racine = realpathSync(mkdtempSync(join(tmpdir(), "webaios-racine-")));
  mkdirSync(join(racine, "accueil", "blocs"), { recursive: true });
  return racine;
}

export type BlocTest =
  | { titre: string; type: "agent"; html?: string; etat?: Record<string, unknown> }
  | { titre: string; type: "app"; url: string };

/**
 * Écrit un bloc dans `accueil/blocs/<id>/`. Un bloc d'agent a par défaut un état « à jour maintenant » : le
 * planificateur ne lance pas de veille.
 */
export function ecrireBloc(racine: string, id: string, b: BlocTest): void {
  const dossier = join(racine, "accueil", "blocs", id);
  mkdirSync(dossier, { recursive: true });
  if (b.type === "app") {
    writeFileSync(join(dossier, "bloc.json"), JSON.stringify({ titre: b.titre, type: "app", url: b.url }));
    return;
  }
  const etat = b.etat ?? { derniereMaj: new Date().toISOString(), derniereTentative: new Date().toISOString(), statut: "ok" };
  writeFileSync(join(dossier, "etat.json"), JSON.stringify(etat));
  if (b.html !== undefined) writeFileSync(join(dossier, "index.html"), b.html);
  writeFileSync(join(dossier, "bloc.json"), JSON.stringify({ titre: b.titre, type: "agent", consigne: "test" }));
}

export function ecrireDisposition(racine: string, ordre: string[]): void {
  writeFileSync(join(racine, "accueil", "disposition.json"), JSON.stringify({ ordre }));
}

export function nouveauProfil(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "webaios-profil-")));
}

/** Lance le navigateur construit (out/) sur un profil isolé et renvoie la fenêtre de l'interface. */
export async function lancer(
  o: { profil?: string; racine?: string; env?: Record<string, string>; visible?: boolean } = {},
): Promise<{
  app: ElectronApplication;
  fenetre: Page;
  profil: string;
  racine: string;
  fermer(): Promise<void>;
}> {
  const profil = o.profil ?? nouveauProfil();
  const racine = o.racine ?? nouvelleRacine();
  const app = await electron.launch({
    args: [join(RACINE, "out/main/index.js")],
    // Invisible par défaut : seuls les tests qui ont besoin du focus ou du plein écran de macOS montrent leurs fenêtres.
    // Le faux docker (e2e/outils) passe avant tout vrai docker : aucun test ne touche à un conteneur.
    env: {
      ...process.env,
      PATH: `${join(__dirname, "outils")}:${process.env.PATH ?? ""}`,
      WEBAIOS_PROFIL: profil,
      WEBAIOS_RACINE: racine,
      ...(o.visible ? {} : { WEBAIOS_INVISIBLE: "1" }),
      ...o.env,
    } as Record<string, string>,
  });
  const fenetre = await fenetreInterface(app);
  await fenetre.waitForLoadState("domcontentloaded");
  // Le focus clavier n'existe que dans l'application active de macOS : un test visible l'active.
  if (o.visible) await app.evaluate(({ app }) => app.focus({ steal: true }));
  return { app, fenetre, profil, racine, fermer: () => app.close() };
}

/** La page de l'interface : les vues des onglets restaurés sont aussi des pages pour Playwright. */
async function fenetreInterface(app: ElectronApplication): Promise<Page> {
  const estInterface = (p: Page) => p.url().includes("/renderer/index.html");
  for (const fin = Date.now() + 10_000; Date.now() < fin; ) {
    const trouvee = app.windows().find(estInterface);
    if (trouvee) return trouvee;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("la fenêtre de l'interface n'est pas apparue");
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

/** Crée un espace et l'active dans la fenêtre. */
export async function creerEspace(fenetre: Page, nom: string, icone: string): Promise<void> {
  await fenetre.evaluate(
    ([nom, icone]) => {
      const w = window as unknown as AvecApi;
      w.webaios.agir({ type: "creerEspace", nom, icone, fenetreId: w.webaios.fenetreId });
    },
    [nom, icone] as const,
  );
}

/** Glisser-déposer progressif : `dragTo` va trop vite pour le glisser-déposer HTML quand la machine est chargée. */
export async function glisser(
  page: Page,
  source: import("@playwright/test").Locator,
  cible: import("@playwright/test").Locator,
  moitie: "haut" | "bas" = "haut",
): Promise<void> {
  const a = (await source.boundingBox())!;
  const b = (await cible.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 5, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * (moitie === "haut" ? 0.25 : 0.75), { steps: 10 });
  await page.mouse.up();
}

/** Appelle un outil du serveur MCP du navigateur, comme le ferait l'agent du conteneur. */
export async function appelerOutil(
  racine: string,
  nom: string,
  args: Record<string, unknown> = {},
): Promise<{ texte: string; image?: string; erreur: boolean }> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const config = JSON.parse(readFileSync(join(racine, ".webaios", "mcp.json"), "utf8")).mcpServers.webaios;
  const transport = new StreamableHTTPClientTransport(new URL(config.url.replace("host.docker.internal", "127.0.0.1")), {
    requestInit: { headers: config.headers },
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    const r = (await client.callTool({ name: nom, arguments: args })) as {
      content: { type: string; text?: string; data?: string }[];
      isError?: boolean;
    };
    return {
      texte: r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
      ...(r.content.some((c) => c.type === "image") ? { image: r.content.find((c) => c.type === "image")!.data } : {}),
      erreur: r.isError === true,
    };
  } finally {
    await client.close();
  }
}
