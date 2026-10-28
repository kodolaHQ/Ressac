import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { AddressInfo } from "node:net";

const RACINE = join(__dirname, "..");

/**
 * Espace de l'agent (~/WebAiOs pour l'utilisateur) : un dossier temporaire par test, jamais le vrai. Son `accueil/widgets/`
 * existe déjà : les widgets de départ ne sont pas copiés (leurs récoltes liraient internet à chaque test).
 */
export function nouvelleRacine(): string {
  const racine = realpathSync(mkdtempSync(join(tmpdir(), "webaios-racine-")));
  mkdirSync(join(racine, "accueil", "widgets"), { recursive: true });
  return racine;
}

/** Un widget de test : `widget.json` (complété par défaut), et ses fichiers facultatifs. */
export interface WidgetTest {
  nom: string;
  tailles?: { min: { l: number; h: number }; max: { l: number; h: number }; defaut: { l: number; h: number } };
  recolte?: { minutes: number };
  sources?: { compte?: string[]; publiques?: string[] };
  config?: unknown;
  /** Contenu de `recolte.mjs`. */
  code?: string;
  /** Contenu de `affichage.html`. */
  affichage?: string;
  exemple?: unknown;
}

/** Écrit un widget dans `accueil/widgets/<id>/` (le code et l'affichage de l'agent ; ses données sont dans le profil). */
export function ecrireWidget(racine: string, id: string, w: WidgetTest): void {
  const dossier = join(racine, "accueil", "widgets", id);
  mkdirSync(dossier, { recursive: true });
  const declaration = {
    nom: w.nom,
    tailles: w.tailles ?? { min: { l: 2, h: 2 }, max: { l: 12, h: 8 }, defaut: { l: 4, h: 3 } },
    ...(w.recolte ? { recolte: w.recolte } : {}),
    sources: { compte: w.sources?.compte ?? [], publiques: w.sources?.publiques ?? [] },
    ...(w.config !== undefined ? { config: w.config } : {}),
  };
  writeFileSync(join(dossier, "widget.json"), JSON.stringify(declaration));
  if (w.code !== undefined) writeFileSync(join(dossier, "recolte.mjs"), w.code);
  if (w.affichage !== undefined) writeFileSync(join(dossier, "affichage.html"), w.affichage);
  if (w.exemple !== undefined) writeFileSync(join(dossier, "exemple.json"), JSON.stringify(w.exemple));
}

/** Données, état et accords d'un widget, rangés hors de l'espace : `<profil>/widgets/`. */
export const dossierWidgets = (profil: string) => join(profil, "widgets");

/** État d'un widget dans le profil (par défaut « à jour maintenant » : le planificateur ne le récolte pas au lancement). */
export function ecrireEtatWidget(profil: string, id: string, etat?: Record<string, unknown>): void {
  mkdirSync(join(dossierWidgets(profil), id), { recursive: true });
  const maintenant = new Date().toISOString();
  writeFileSync(
    join(dossierWidgets(profil), id, "etat.json"),
    JSON.stringify(etat ?? { statut: "ok", derniereMaj: maintenant, derniereTentative: maintenant }),
  );
}

export type PlacementTest = { id: string; x: number; y: number; l: number; h: number };

export function ecrireDisposition(racine: string, widgets: PlacementTest[]): void {
  writeFileSync(join(racine, "accueil", "disposition.json"), JSON.stringify({ version: 2, widgets }));
}

export function lireDisposition(racine: string): PlacementTest[] {
  return JSON.parse(readFileSync(join(racine, "accueil", "disposition.json"), "utf8")).widgets;
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
    // Une page coupée en plein envoi : elle s'affiche (la navigation aboutit) puis échoue (longueur annoncée non reçue).
    if (chemin === "/coupee") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": "100000" });
      res.write("<title>Coupée</title><p>Début d'une page jamais finie.</p>");
      return void setTimeout(() => res.destroy(), 200);
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
      w.webaios.agir({ type: "creerEspace", nom, icone, prive: false, profil: "defaut", fenetreId: w.webaios.fenetreId });
    },
    [nom, icone] as const,
  );
}

/** Rend privé (ou non) l'espace actif de la fenêtre, sans toucher à ses autres réglages. */
export async function reglerEspaceActifPrive(fenetre: Page, prive: boolean): Promise<void> {
  type Etat = { espaces: { id: string; nom: string; icone: string; profil: string }[]; fenetres: { id: string; espaceActif: string }[] };
  await fenetre.evaluate(
    (prive) =>
      new Promise<void>((ok) => {
        const w = window as unknown as Window & { webaios: AvecApi["webaios"] & { surEtat(r: (e: Etat) => void): () => void } };
        const fin = w.webaios.surEtat((e) => {
          setTimeout(() => fin());
          const actif = e.fenetres.find((f) => f.id === w.webaios.fenetreId)!.espaceActif;
          const esp = e.espaces.find((x) => x.id === actif)!;
          w.webaios.agir({ type: "reglerEspace", id: esp.id, nom: esp.nom, icone: esp.icone, prive, profil: esp.profil });
          ok();
        });
      }),
    prive,
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

const SERVEURS = {
  // /redirige renvoie ailleurs côté serveur ; /retient refuse qu'on quitte la page ; /sans-titre n'a pas de <title>.
  ok: (dossier: string) => `import { createServer } from "node:http";
createServer((req, res) => {
  if (req.url === "/redirige") return res.writeHead(302, { Location: "https://exemple.invalide/redirige" }).end();
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  if (req.url === "/retient") return res.end('<title>Retient</title><script>addEventListener("beforeunload", (e) => e.preventDefault())</script>');
  if (req.url === "/sans-titre") return res.end("<p>sans titre</p>");
  res.end('<title>Essai ${dossier}</title><a href="https://exemple.invalide/">lien</a>');
}).listen(Number(process.env.PORT));
`,
  plante: () => `process.stderr.write("boum\\n");
process.exit(3);
`,
  muet: () => `setInterval(() => {}, 1000);
`,
};

/**
 * Projet de l'espace (`projets/<dossier>/`) : `serveur.mjs` et, si `manifeste` est donné, `webaios.json` (une chaîne est
 * écrite telle quelle ; un objet complète `{ type: "application", lancement: "node serveur.mjs" }`).
 */
export function ecrireProjet(
  racine: string,
  dossier: string,
  o: { manifeste?: object | string; serveur?: keyof typeof SERVEURS } = {},
): void {
  const chemin = join(racine, "projets", dossier);
  mkdirSync(chemin, { recursive: true });
  writeFileSync(join(chemin, "serveur.mjs"), SERVEURS[o.serveur ?? "ok"](dossier));
  if (o.manifeste === undefined) return;
  const manifeste = typeof o.manifeste === "string" ? o.manifeste : JSON.stringify({ type: "application", lancement: "node serveur.mjs", ...o.manifeste });
  writeFileSync(join(chemin, "webaios.json"), manifeste);
}
