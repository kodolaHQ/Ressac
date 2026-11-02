import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
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
  recolte?: { minutes?: number; heures?: string[]; dureeMaxMinutes?: number; notifier?: boolean };
  /** `web` n'est écrit que s'il est donné : la déclaration d'un widget d'aujourd'hui ne change pas. */
  sources?: { compte?: string[]; publiques?: string[]; web?: boolean };
  config?: unknown;
  /** Contenu de `recolte.mjs`. */
  code?: string;
  /** Contenu de `affichage.html`. */
  affichage?: string;
  exemple?: unknown;
  /** Contenu de `workflow.json` (un objet, écrit en JSON ; une chaîne, écrite telle quelle : JSON coupé…). */
  workflow?: unknown;
  /** Autres fichiers du dossier (le code des blocs `code` : `extraire.mjs`…), par nom. */
  fichiers?: Record<string, string>;
}

/** Écrit un widget dans `accueil/widgets/<id>/` (le code et l'affichage de l'agent ; ses données sont dans le profil). */
export function ecrireWidget(racine: string, id: string, w: WidgetTest): void {
  const dossier = join(racine, "accueil", "widgets", id);
  mkdirSync(dossier, { recursive: true });
  const declaration = {
    nom: w.nom,
    tailles: w.tailles ?? { min: { l: 2, h: 2 }, max: { l: 12, h: 8 }, defaut: { l: 4, h: 3 } },
    ...(w.recolte ? { recolte: w.recolte } : {}),
    sources: {
      compte: w.sources?.compte ?? [],
      publiques: w.sources?.publiques ?? [],
      ...(w.sources?.web !== undefined ? { web: w.sources.web } : {}),
    },
    ...(w.config !== undefined ? { config: w.config } : {}),
  };
  writeFileSync(join(dossier, "widget.json"), JSON.stringify(declaration));
  if (w.code !== undefined) writeFileSync(join(dossier, "recolte.mjs"), w.code);
  if (w.affichage !== undefined) writeFileSync(join(dossier, "affichage.html"), w.affichage);
  if (w.exemple !== undefined) writeFileSync(join(dossier, "exemple.json"), JSON.stringify(w.exemple));
  if (w.workflow !== undefined)
    writeFileSync(join(dossier, "workflow.json"), typeof w.workflow === "string" ? w.workflow : JSON.stringify(w.workflow));
  for (const [nom, contenu] of Object.entries(w.fichiers ?? {})) writeFileSync(join(dossier, nom), contenu);
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

/** Données, exécutions, résultats et accords des actions, rangés hors de l'espace : `<profil>/actions/`. */
export const dossierActions = (profil: string) => join(profil, "actions");

/** Une action de test : les clés d'`action.json` (`sources` complété par défaut), son workflow et ses autres fichiers. */
export interface ActionTest {
  nom: string;
  description?: string;
  motsCles?: string[];
  saisie?: { libelle: string };
  /** `web` n'est écrit que s'il est donné. */
  sources?: { compte?: string[]; publiques?: string[]; web?: boolean };
  miseEnPage?: string;
  dureeMaxMinutes?: number;
  /** Contenu de `workflow.json` (un objet, écrit en JSON ; une chaîne, écrite telle quelle). */
  workflow?: unknown;
  /** Les `.mjs` des blocs `code`, par nom. */
  fichiers?: Record<string, string>;
}

/** Écrit une action dans `actions/<id>/` de l'espace (ses données sont dans le profil, voir `dossierActions`). */
export function ecrireAction(racine: string, id: string, a: ActionTest): void {
  const dossier = join(racine, "actions", id);
  mkdirSync(dossier, { recursive: true });
  const { workflow, fichiers, sources, ...cles } = a;
  const declaration = {
    ...cles,
    sources: {
      compte: sources?.compte ?? [],
      publiques: sources?.publiques ?? [],
      ...(sources?.web !== undefined ? { web: sources.web } : {}),
    },
  };
  writeFileSync(join(dossier, "action.json"), JSON.stringify(declaration));
  if (workflow !== undefined) writeFileSync(join(dossier, "workflow.json"), typeof workflow === "string" ? workflow : JSON.stringify(workflow));
  for (const [nom, contenu] of Object.entries(fichiers ?? {})) writeFileSync(join(dossier, nom), contenu);
}

/** Un composant de l'agent de test : `composant.json` (sans `nom`, pris du dossier) et `composant.html`. */
export interface ComposantTest {
  description: string;
  proprietes: Record<string, { genre: string; description: string; requis?: boolean }>;
  html: string;
}

/** Écrit un composant de l'agent dans `composants/<nom>/` de l'espace. */
export function ecrireComposant(racine: string, nom: string, c: ComposantTest): void {
  const dossier = join(racine, "composants", nom);
  mkdirSync(dossier, { recursive: true });
  writeFileSync(join(dossier, "composant.json"), JSON.stringify({ nom, description: c.description, proprietes: c.proprietes }));
  writeFileSync(join(dossier, "composant.html"), c.html);
}

/** Chaque fichier d'un dossier (sous-dossiers compris), avec sa date de modification : « chemin:mtime », triés. */
export function lireMtimes(dossier: string): string[] {
  if (!existsSync(dossier)) return [];
  return readdirSync(dossier, { recursive: true, encoding: "utf8" })
    .map((f) => `${f}:${statSync(join(dossier, f)).mtimeMs}`)
    .sort();
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

/** Fichier où l'app lancée sur ce profil note ses notifications (une ligne JSON `{ titre, texte }` chacune), à côté du profil. */
export const fichierNotifications = (profil: string) => `${profil}-notifications.jsonl`;

/** Notifications notées par l'app lancée sur ce profil, dans l'ordre. */
export function lireNotifications(profil: string): { titre: string; texte: string }[] {
  const f = fichierNotifications(profil);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Lance le navigateur construit (out/) sur un profil isolé et renvoie la fenêtre de l'interface. */
export async function lancer(
  o: { profil?: string; racine?: string; env?: Record<string, string>; visible?: boolean; args?: string[] } = {},
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
    args: [...(o.args ?? []), join(RACINE, "out/main/index.js")],
    // Invisible par défaut : seuls les tests qui ont besoin du focus ou du plein écran de macOS montrent leurs fenêtres.
    // Le faux docker (e2e/outils) passe avant tout vrai docker : aucun test ne touche à un conteneur.
    env: {
      ...process.env,
      PATH: `${join(__dirname, "outils")}:${process.env.PATH ?? ""}`,
      WEBAIOS_PROFIL: profil,
      WEBAIOS_RACINE: racine,
      ...(o.visible ? {} : { WEBAIOS_INVISIBLE: "1" }),
      // Aucun e2e, même visible, ne montre une vraie notification de macOS : elles sont notées dans ce fichier.
      WEBAIOS_TEST_NOTIFICATIONS: fichierNotifications(profil),
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

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".js": "text/javascript; charset=utf-8",
};

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

/** Configs MCP des sessions d'agent des fenêtres (`.webaios/sessions/<session>.json`, une par fenêtre dont l'agent tourne). */
export const configsSession = (racine: string): string[] => {
  const dossier = join(racine, ".webaios", "sessions");
  return existsSync(dossier) ? readdirSync(dossier).filter((f) => f.endsWith(".json")).map((f) => join(dossier, f)) : [];
};

/**
 * Appelle un outil du serveur MCP du navigateur, comme le ferait l'agent du conteneur : avec le jeton principal
 * (`.webaios/mcp.json`, sans fenêtre), ou avec `session: true` celui de la seule session d'agent ouverte (celle d'une fenêtre).
 */
export async function appelerOutil(
  racine: string,
  nom: string,
  args: Record<string, unknown> = {},
  o: { session?: boolean } = {},
): Promise<{ texte: string; image?: string; erreur: boolean }> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  let chemin = join(racine, ".webaios", "mcp.json");
  if (o.session) {
    const sessions = configsSession(racine);
    if (sessions.length !== 1) throw new Error(`une seule session d'agent attendue, ${sessions.length} trouvée(s)`);
    chemin = sessions[0]!;
  }
  const config = JSON.parse(readFileSync(chemin, "utf8")).mcpServers.webaios;
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

/** Une appli de site de test : `site.json` (un objet, écrit en JSON ; une chaîne, écrite telle quelle) et d'autres fichiers. */
export interface SiteTest {
  declaration: object | string;
  /** Chemins relatifs au dossier de l'appli (`accueil/index.html`, `retouches/a.js`…) → contenu. */
  fichiers?: Record<string, string | Buffer>;
}

/** Écrit une appli de site dans `sites/<id>/` de l'espace (ce que l'agent y écrirait). */
export function ecrireSite(racine: string, id: string, s: SiteTest): void {
  const dossier = join(racine, "sites", id);
  mkdirSync(dossier, { recursive: true });
  writeFileSync(join(dossier, "site.json"), typeof s.declaration === "string" ? s.declaration : JSON.stringify(s.declaration));
  for (const [chemin, contenu] of Object.entries(s.fichiers ?? {})) {
    mkdirSync(join(dossier, chemin, ".."), { recursive: true });
    writeFileSync(join(dossier, chemin), contenu);
  }
}

/** Ce qu'une route de `serveurSites` répond : un texte HTML, ou la main sur la réponse. */
export type RouteSite = string | ((req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void);

/**
 * Un seul serveur pour tous les hôtes de test `*.localhost` (Chromium les résout vers la boucle locale sans DNS) : il
 * répond selon l'en-tête Host. `definir(hote, chemin, route)` ajoute une page ; `/cookie` pose un cookie sur tout hôte ;
 * `couper(hote)` coupe les connexions de cet hôte (site arrêté). Chaque requête reçue est notée dans `requetes`.
 */
export async function serveurSites(): Promise<{
  port: number;
  /** `http://<hote>:<port><chemin>`. */
  url(hote: string, chemin?: string): string;
  definir(hote: string, chemin: string, route: RouteSite): void;
  couper(hote: string, oui?: boolean): void;
  requetes: { hote: string; chemin: string; cookie: string | undefined }[];
  fermer(): Promise<void>;
}> {
  const routes = new Map<string, RouteSite>();
  const coupes = new Set<string>();
  const requetes: { hote: string; chemin: string; cookie: string | undefined }[] = [];
  const serveur = createServer((req, res) => {
    const hote = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    const chemin = req.url ?? "/";
    requetes.push({ hote, chemin, cookie: req.headers.cookie });
    // Réinitialisation (RST) : Chromium rend ERR_CONNECTION_RESET (-101), un site arrêté ; une fermeture propre donnerait -324.
    if (coupes.has(hote)) return void req.socket.resetAndDestroy();
    const route = routes.get(`${hote} ${chemin}`) ?? routes.get(`${hote} ${chemin.split("?")[0]}`);
    if (typeof route === "function") return route(req, res);
    if (typeof route === "string") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return void res.end(route);
    }
    if (chemin === "/cookie") {
      res.writeHead(200, { "Set-Cookie": `essai=${hote}; Max-Age=86400; Path=/`, "Content-Type": "text/html" });
      return void res.end("<title>cookie</title>ok");
    }
    if (chemin === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return void res.end(`<title>${hote}</title><p>${hote}</p>`);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  const port = (serveur.address() as AddressInfo).port;
  return {
    port,
    url: (hote, chemin = "/") => `http://${hote}:${port}${chemin}`,
    definir: (hote, chemin, route) => void routes.set(`${hote} ${chemin}`, route),
    couper: (hote, oui = true) => void (oui ? coupes.add(hote) : coupes.delete(hote)),
    requetes,
    fermer: () =>
      new Promise((ok) => {
        serveur.closeAllConnections();
        serveur.close(() => ok());
      }),
  };
}

/** La page de l'interface de la fenêtre d'une appli de site (`site.html?id=<id>`). */
export async function fenetreSite(app: ElectronApplication, id: string): Promise<Page> {
  const est = (p: Page) => p.url().includes("/renderer/site.html") && new URL(p.url()).searchParams.get("id") === id;
  for (const fin = Date.now() + 10_000; Date.now() < fin; ) {
    const trouvee = app.windows().find(est);
    if (trouvee) return trouvee;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`la fenêtre de l'appli de site ${id} n'est pas apparue`);
}

/**
 * Exécute `code` dans la vue du site de l'appli `id` (la WebContentsView sous la barre), avec un geste de l'utilisateur si
 * `geste`. `cadre` : l'indice d'un sous-cadre direct de la page. undefined si la fenêtre n'est pas ouverte.
 */
export function vueSite(app: ElectronApplication, id: string, code: string, o: { geste?: boolean; cadre?: number } = {}): Promise<unknown> {
  return app.evaluate(
    async ({ BrowserWindow }, [id, code, geste, cadre]) => {
      const f = BrowserWindow.getAllWindows().find((w) => {
        if (w.isDestroyed() || w.webContents.isDestroyed()) return false;
        const u = w.webContents.getURL();
        return u.includes("/renderer/site.html") && new URL(u).searchParams.get("id") === id;
      });
      const vue = f?.contentView.children[0] as Electron.WebContentsView | undefined;
      if (!vue || vue.webContents.isDestroyed()) return undefined;
      const wc = vue.webContents;
      if (cadre === -1) return wc.executeJavaScript(code, geste);
      const sous = wc.mainFrame.frames[cadre];
      return sous?.executeJavaScript(code, geste);
    },
    [id, code, o.geste ?? false, o.cadre ?? -1] as const,
  );
}

/** L'état de la vue du site de l'appli `id` vu du process principal : adresse, bornes, visibilité, et la taille de la fenêtre. */
export function etatVueSite(
  app: ElectronApplication,
  id: string,
): Promise<{ url: string; bornes: { x: number; y: number; width: number; height: number }; visible: boolean; contenu: [number, number] } | undefined> {
  return app.evaluate(({ BrowserWindow }, id) => {
    const f = BrowserWindow.getAllWindows().find((w) => {
      if (w.isDestroyed() || w.webContents.isDestroyed()) return false;
      const u = w.webContents.getURL();
      return u.includes("/renderer/site.html") && new URL(u).searchParams.get("id") === id;
    });
    const vue = f?.contentView.children[0] as Electron.WebContentsView | undefined;
    if (!f || !vue || vue.webContents.isDestroyed()) return undefined;
    const [l = 0, h = 0] = f.getContentSize();
    return { url: vue.webContents.getURL(), bornes: vue.getBounds(), visible: vue.getVisible(), contenu: [l, h] as [number, number] };
  }, id);
}
