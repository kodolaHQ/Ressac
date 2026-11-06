import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { dispatch, state } from "./firefox";
import type { Marionette } from "./marionette";
import { waitUi } from "./ui";

// Ports of Electron's action helpers (e2e/aide.ts, e2e/actions.spec.ts). Declarations live in the space
// (`<dataDir>/espace/actions/<id>/`, `<dataDir>/espace/composants/<nom>/`); runs, results and agreements outside it.

/** The execution every written result belongs to (actions.spec.ts EXECUTION). */
export const EXECUTION = "2026-10-31T08-00-00-000Z";

/** Runs, results and agreements of the actions, outside the space: `<dataDir>/actions/` (Electron's dossierActions). */
export const actionsDataDir = (dataDir: string) => path.join(dataDir, "actions");

/** A test action: the keys of `action.json` (`sources` filled by default), its workflow and other files (aide.ts ActionTest). */
export interface TestAction {
  nom: string;
  description?: string;
  motsCles?: string[];
  saisie?: { libelle: string };
  /** `web` is written only when given. */
  sources?: { compte?: string[]; publiques?: string[]; web?: boolean };
  miseEnPage?: string;
  dureeMaxMinutes?: number;
  /** `workflow.json`: an object is written as JSON, a string as is. */
  workflow?: unknown;
  /** The `code` blocks' `.mjs`, by name. */
  fichiers?: Record<string, string>;
}

/** Electron's ecrireAction (aide.ts:96): `<dataDir>/espace/actions/<id>/`. */
export async function writeAction(dataDir: string, id: string, a: TestAction): Promise<void> {
  const dir = path.join(dataDir, "espace", "actions", id);
  await mkdir(dir, { recursive: true });
  const { workflow, fichiers, sources, ...keys } = a;
  const declaration = { ...keys, sources: { compte: sources?.compte ?? [], publiques: sources?.publiques ?? [], ...(sources?.web !== undefined ? { web: sources.web } : {}) } };
  await writeFile(path.join(dir, "action.json"), JSON.stringify(declaration));
  if (workflow !== undefined) await writeFile(path.join(dir, "workflow.json"), typeof workflow === "string" ? workflow : JSON.stringify(workflow));
  for (const [nom, text] of Object.entries(fichiers ?? {})) await writeFile(path.join(dir, nom), text);
}

/** An agent component: `composant.json` (without `nom`, taken from the folder) and `composant.html` (aide.ts ComposantTest). */
export interface TestComponent {
  description: string;
  proprietes: Record<string, { genre: string; description: string; requis?: boolean }>;
  html: string;
}

/** Electron's ecrireComposant (aide.ts:121): `<dataDir>/espace/composants/<nom>/`. */
export async function writeComponent(dataDir: string, nom: string, c: TestComponent): Promise<void> {
  const dir = path.join(dataDir, "espace", "composants", nom);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "composant.json"), JSON.stringify({ nom, description: c.description, proprietes: c.proprietes }));
  await writeFile(path.join(dir, "composant.html"), c.html);
}

export type Block = { composant: string; props: Record<string, unknown>; blocs?: Block[]; gauche?: Block[]; droite?: Block[] };

/** Electron's ecrireActionAvecResultat (actions.spec.ts:30): the action and its last run, with its result. */
export async function writeActionWithResult(
  dataDir: string,
  id: string,
  o: { nom: string; compte?: string[]; resultats: unknown; blocs: Block[]; secours?: boolean },
): Promise<void> {
  await writeAction(dataDir, id, { nom: o.nom, sources: { compte: o.compte ?? [] } });
  const data = path.join(actionsDataDir(dataDir), id);
  await mkdir(path.join(data, "executions"), { recursive: true });
  await mkdir(path.join(data, "resultats"), { recursive: true });
  await writeFile(
    path.join(data, "executions", `${EXECUTION}.json`),
    JSON.stringify({ version: 1, id: EXECUTION, proprietaire: { type: "action", id }, declencheur: "manuelle", debut: "2026-10-31T08:00:00.000Z", fin: "2026-10-31T08:00:05.000Z", statut: "reussie", blocs: [] }),
  );
  await writeFile(
    path.join(data, "resultats", `${EXECUTION}.json`),
    JSON.stringify({ version: 1, execution: EXECUTION, saisie: null, resultats: o.resultats, plan: { blocs: o.blocs }, secours: o.secours ?? false, vide: false }),
  );
}

/**
 * Opens action `id`'s page in a tab of the first window (Electron's ouvrirPage, actions.spec.ts): nothing is launched.
 * shortcut: waits for the page itself instead of polling the host's page first; Task 3 adds the poll once its RPC exists.
 */
export async function openActionPage(m: Marionette, id: string, nom: string, execution = EXECUTION): Promise<void> {
  await dispatch(m, { type: "ouvrirAction", fenetreId: (await state(m)).fenetres[0]!.id, id, nom, execution });
  await waitUi(m, `return !!doc.querySelector('[data-testid="rendu-page"]');`, [], 30_000);
}

export interface TestServer {
  url: string;
  log: string[];
  close(): Promise<void>;
}

/** Electron's ecouter (actions.spec.ts): a local server, each URL asked noted in `log`. */
export async function listen(handle: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<TestServer> {
  const log: string[] = [];
  const server = createServer((req, res) => {
    log.push(req.url ?? "/");
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => handle(req, res, body));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, log, close: () => new Promise((ok) => (server.closeAllConnections(), server.close(() => ok()))) };
}

export type GitlabTicket = { n: number; titre: string; projet: string; priorite: string };
export const GITLAB_TICKETS: GitlabTicket[] = [
  { n: 1, titre: "Connexion impossible", projet: "api", priorite: "urgent" },
  { n: 2, titre: "Facture en double", projet: "facturation", priorite: "normale" },
  { n: 3, titre: "Fuite mémoire du worker", projet: "api", priorite: "urgent" },
  { n: 4, titre: "Coquille sur l'accueil", projet: "site", priorite: "basse" },
  { n: 5, titre: "Export CSV lent", projet: "facturation", priorite: "normale" },
];
export const LBC_ADS = [
  { n: 1, titre: "Renault Clio 4", prix: 7200, ville: "Lyon" },
  { n: 2, titre: "Renault Clio 3", prix: 4900, ville: "Villeurbanne" },
];
export const adPhoto = (n: number) => `https://img.leboncoin.exemple/photos/${n}.jpg`;

/** The fake Gemma's plan for a layout request: a title, then the list of pages read (actions.spec.ts PLAN_GEMMA). */
export const GEMMA_PLAN = { blocs: [{ composant: "titre", props: { texte: "Pages lues" } }, { composant: "liste", props: { elements: "$", titre: "page.titre" } }] };
/** The start of the layout prompt (pages/mise-en-page.ts). */
const LAYOUT_PROMPT = "Tu mets en page le résultat d'une action pour l'utilisateur.";

/** A 1×1 red PNG. */
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

/** What the image server received: path, Cookie and Referer of each request. */
export type ImageRequestSeen = { path: string; cookie: string | null; referer: string | null };

/**
 * Electron's servers of actions.spec.ts:290-383 (the site, the fake Gemma and `reglages`, reset by `reset()`), plus the
 * fake Kev, and an image server noting each request's path, Cookie and Referer. Image server paths: `/cookie` sets
 * `seen=<value of ?v>` (a page), `*.png` a PNG with a Set-Cookie, `*\/r` a 302 to `/secret` (absolute http URL),
 * `/hop` a 302 to `/p.png`, `/secret` a PNG.
 */
export async function startActionServers() {
  const settings: { lenteurSiteMs: number; lenteurGemmaMs: number; plan: unknown; tickets: GitlabTicket[] } = { lenteurSiteMs: 0, lenteurGemmaMs: 0, plan: null, tickets: GITLAB_TICKETS };
  const pages: Record<string, () => string> = {
    "/gitlab/tickets": () =>
      `<title>Tickets</title><h1>Tableau de bord</h1><ul>${settings.tickets.map((t) => `<li><a href="/gitlab/ticket/${t.n}">#${t.n} ${t.titre} [${t.priorite}] (${t.projet})</a></li>`).join("")}</ul><a href="/gitlab/aide">Aide</a>`,
    "/leboncoin/recherche": () =>
      `<title>Annonces</title><ul>${LBC_ADS.map((a) => `<li><a href="https://www.leboncoin.exemple/ad/${a.n}">${a.titre} – ${a.prix} – ${a.ville}</a> <a href="${adPhoto(a.n)}">Photo</a></li>`).join("")}</ul>`,
    "/court": () => "<title>Court</title>",
    "/veille": () => `<title>Veille</title><ul><li><a href="/annonce/1">Vélo de course</a></li><li><a href="/annonce/2">Vélo pliant</a></li></ul>`,
  };
  const html = (res: ServerResponse, body: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
  const site = await listen((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    const page = pages[p];
    if (page) return void setTimeout(() => html(res, page()), p.startsWith("/gitlab/") ? settings.lenteurSiteMs : 0);
    const n = /^\/lent\/(\d+)$/.exec(p)?.[1];
    if (!n) return void res.writeHead(404).end();
    setTimeout(() => html(res, `<title>Page ${n}</title><p>Texte ${n}</p>`), settings.lenteurSiteMs);
  });
  const prompts: string[] = [];
  const ollama = await listen((req, res, body) => {
    if (req.url !== "/api/chat") return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"models":[]}');
    const prompt = String((JSON.parse(body) as { messages: { content: string }[] }).messages[0]?.content);
    prompts.push(prompt);
    const plan = settings.plan ?? GEMMA_PLAN;
    const content = !prompt.startsWith(LAYOUT_PROMPT) ? "Bonne affaire." : typeof plan === "string" ? plan : JSON.stringify(plan);
    setTimeout(() => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ message: { content } })), settings.lenteurGemmaMs);
  });
  // Fake Kev (watch.e2e.ts): every item matches.
  const kev = await listen((req, res) => {
    if (req.method === "GET") return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"data":[]}');
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ answers: { q: { noul: 0.9 } } }));
  });
  const seen: ImageRequestSeen[] = [];
  const images = await listen((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    seen.push({ path: u.pathname, cookie: req.headers.cookie ?? null, referer: req.headers.referer ?? null });
    if (u.pathname === "/cookie") return void res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": `seen=${u.searchParams.get("v") ?? "1"}; Max-Age=3600; Path=/` }).end("<title>cookie</title>");
    if (u.pathname.endsWith("/r")) return void res.writeHead(302, { Location: `${images.url}/secret` }).end();
    if (u.pathname === "/hop") return void res.writeHead(302, { Location: `${images.url}/p.png` }).end();
    if (u.pathname.endsWith(".png") || u.pathname === "/secret") return void res.writeHead(200, { "Content-Type": "image/png", "Set-Cookie": "leak=1; Max-Age=3600; Path=/" }).end(PNG);
    res.writeHead(404).end();
  });
  return {
    site,
    ollama: Object.assign(ollama, { prompts }),
    kev,
    images: Object.assign(images, { seen }),
    settings,
    /** actions.spec.ts beforeEach. */
    reset() {
      Object.assign(settings, { lenteurSiteMs: 0, lenteurGemmaMs: 0, plan: null, tickets: GITLAB_TICKETS });
      seen.length = 0;
    },
    close: () => Promise.all([site, ollama, kev, images].map((s) => s.close())),
  };
}
