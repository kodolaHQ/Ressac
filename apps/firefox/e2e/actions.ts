import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { dispatch, state } from "./firefox";
import type { Marionette } from "./marionette";
import { inUi, waitUi } from "./ui";

// Action helpers. Declarations live in the space
// (`<dataDir>/espace/actions/<id>/`, `<dataDir>/espace/composants/<nom>/`); runs, results and agreements outside it.

/** The execution every written result belongs to (actions.spec.ts EXECUTION). */
export const EXECUTION = "2026-10-31T08-00-00-000Z";

/** Runs, results and agreements of the actions, outside the space: `<dataDir>/actions/`. */
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

/** Writes an action into `<dataDir>/espace/actions/<id>/`. */
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

/** Writes a component into `<dataDir>/espace/composants/<nom>/`. */
export async function writeComponent(dataDir: string, nom: string, c: TestComponent): Promise<void> {
  const dir = path.join(dataDir, "espace", "composants", nom);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "composant.json"), JSON.stringify({ nom, description: c.description, proprietes: c.proprietes }));
  await writeFile(path.join(dir, "composant.html"), c.html);
}

/** AGENTS.md:660's « barres » example, unchanged. */
export const BARRES = `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; font: 13px system-ui, sans-serif; color: #222; background: transparent; }
  body.sombre { color: #eee; }
  h3 { margin: 0 0 6px; font-size: 14px; }
</style>
<h3 id="titre"></h3>
<svg id="graphique" width="100%" role="img"></svg>
<script>
  const NS = "http://www.w3.org/2000/svg";
  const el = (nom, attrs, texte) => {
    const e = document.createElementNS(NS, nom);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (texte !== undefined) e.textContent = texte;
    return e;
  };
  addEventListener("message", (m) => {
    if (m.data?.type !== "composant") return;
    const { props, theme, largeur } = m.data;
    document.body.className = theme === "sombre" ? "sombre" : "";
    document.getElementById("titre").textContent = props.titre ?? "";
    const valeurs = (Array.isArray(props.valeurs) ? props.valeurs : []).slice(0, 12)
      .map((v) => ({ libelle: String(v?.libelle ?? ""), valeur: Number(v?.valeur) || 0 }));
    const max = Math.max(1, ...valeurs.map((v) => v.valeur));
    const w = Math.max(200, largeur || 400), h = 24, marge = 110;
    const svg = document.getElementById("graphique");
    svg.replaceChildren();
    svg.setAttribute("viewBox", \`0 0 \${w} \${valeurs.length * h}\`);
    svg.setAttribute("height", valeurs.length * h);
    valeurs.forEach((v, i) => {
      const long = ((w - marge - 40) * v.valeur) / max;
      svg.append(
        el("text", { x: 0, y: i * h + 15, fill: "currentColor" }, v.libelle.slice(0, 16)),
        el("rect", { x: marge, y: i * h + 3, width: long, height: h - 8, rx: 3, fill: "#3b82f6" }),
        el("text", { x: marge + long + 6, y: i * h + 15, fill: "currentColor" }, String(v.valeur)),
      );
    });
    parent.postMessage({ type: "hauteur", px: document.documentElement.scrollHeight }, "*");
  });
</script>
`;

/** A component that tries the network three ways and the chrome, reports through parent.postMessage, then navigates itself. */
export const probe = (base: string) => `<!doctype html><meta charset="utf-8">
<img id="i" src="${base}/img">
<script>
  const out = { Components: typeof Components, ChromeUtils: typeof ChromeUtils, Services: typeof Services, origin: location.origin };
  try { out.top = String(top.document.title); } catch (e) { out.top = e.name; }
  try { out.frameElement = String(frameElement); } catch (e) { out.frameElement = e.name; }
  // Firefox's legacy content Components (plan 31 spike): what it holds, if anything.
  if (typeof Components !== "undefined") out.components = { keys: Object.keys(Components), interfaces: Object.keys(Components.interfaces ?? {}), classes: typeof Components.classes, utils: typeof Components.utils };
  try { fetch("${base}/fetch").then(() => (out.fetch = "loaded"), (e) => (out.fetch = e.name)); } catch (e) { out.fetch = "threw " + e.name; }
  try { const ws = new WebSocket("${base.replace("http", "ws")}/ws"); ws.onerror = () => (out.ws = "error"); ws.onopen = () => (out.ws = "open"); } catch (e) { out.ws = "threw " + e.name; }
  document.getElementById("i").onload = () => (out.img = "loaded");
  document.getElementById("i").onerror = () => (out.img = "error");
  // Then a self-navigation, which would carry data in its URL (which must be blocked).
  setTimeout(() => { parent.postMessage({ type: "sonde", out }, "*"); location.href = "${base}/nav?x=1"; }, 1500);
</script>`;

export type Block = { composant: string; props: Record<string, unknown>; blocs?: Block[]; gauche?: Block[]; droite?: Block[] };

/** The action and its last run, with its result. */
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

/** Opens action `id`'s page in a tab of the first window, once the noyau serves it: nothing is launched. */
export async function openActionPage(m: Marionette, id: string, nom: string, execution = EXECUTION): Promise<void> {
  await waitUi(m, "return ui.webaios.actions.page(arguments[0], arguments[1]).then((p) => p !== null);", [id, execution], 30_000);
  await dispatch(m, { type: "ouvrirAction", fenetreId: (await state(m)).fenetres[0]!.id, id, nom, execution });
  await waitUi(m, `return !!doc.querySelector('[data-testid="rendu-page"]');`, [], 30_000);
}

/** What the UI says when the actions service does not answer. */
export const WITHOUT_NOYAU = "Le service des actions ne répond pas (agent arrêté ?)";

/** Waits until the noyau serves the actions: an unknown action is then refused as such. */
export async function waitNoyau(m: Marionette): Promise<void> {
  await waitUi(m, "return ui.webaios.actions.lancer('inconnue-du-test', null).then((r) => r.erreur !== arguments[0]);", [WITHOUT_NOYAU], 30_000);
}

/** Opens the action's page (its last result, or `execution`) without launching anything. */
export async function openAction(m: Marionette, id: string, nom: string, execution?: string): Promise<void> {
  await dispatch(m, { type: "ouvrirAction", fenetreId: (await state(m)).fenetres[0]!.id, id, nom, ...(execution ? { execution } : {}) });
  await waitUi(m, `return !!doc.querySelector('[data-testid="page-action"]');`, [], 10_000);
}

/** A workflow whose blocks follow one another in the array's order (actions.spec.ts enChaine). */
export const chained = (blocs: { id: string; type: string; parametres: Record<string, unknown> }[]) => ({
  version: 1,
  blocs,
  liens: blocs.slice(1).map((b, i) => ({ de: blocs[i]!.id, vers: b.id })),
});

/** A runnable action: a `code` block, the blocks between, then the output to the page. */
export function writeRunnableAction(
  dataDir: string,
  id: string,
  o: { nom: string; code: string; compte?: string[]; saisie?: string; motsCles?: string[]; blocs?: { id: string; type: string; parametres: Record<string, unknown> }[] },
): Promise<void> {
  const blocs = [{ id: "liste", type: "code", parametres: { source: "liste.mjs" } }, ...(o.blocs ?? []), { id: "sortie", type: "sortie", parametres: { vers: "page" } }];
  return writeAction(dataDir, id, {
    nom: o.nom,
    sources: { compte: o.compte ?? [] },
    ...(o.motsCles ? { motsCles: o.motsCles } : {}),
    ...(o.saisie ? { saisie: { libelle: o.saisie } } : {}),
    workflow: chained(blocs),
    fichiers: { "liste.mjs": o.code },
  });
}

/** Three pages of the slow site, read one by one: « Lecture de 127.0.0.1… » then « 3 / 3 ». */
export const writePagesAction = (dataDir: string, siteUrl: string, id = "pages", nom = "Pages") =>
  writeRunnableAction(dataDir, id, {
    nom,
    code: `export default async () => [1, 2, 3].map((n) => ({ url: "${siteUrl}/lent/" + n }));`,
    blocs: [{ id: "lecture", type: "source.page", parametres: { url: "{url}", parElement: true, champ: "page" } }],
  });

/** Finished runs written on disk for this action, without temporary files. */
export async function runsOnDisk(dataDir: string, id: string): Promise<string[]> {
  const dir = path.join(actionsDataDir(dataDir), id, "executions");
  return (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json")).sort();
}

/** The status of each finished run on disk, oldest first. */
export async function runStatuses(dataDir: string, id: string): Promise<string[]> {
  const dir = path.join(actionsDataDir(dataDir), id, "executions");
  return Promise.all((await runsOnDisk(dataDir, id)).map(async (f) => (JSON.parse(await readFile(path.join(dir, f), "utf8")) as { statut: string }).statut));
}

/** A finished run and its result (a title), written on disk. */
export async function writeResult(dataDir: string, id: string, execution: string, debut: string, titre: string, saisie: string | null = null): Promise<void> {
  const data = path.join(actionsDataDir(dataDir), id);
  await mkdir(path.join(data, "executions"), { recursive: true });
  await mkdir(path.join(data, "resultats"), { recursive: true });
  await writeFile(
    path.join(data, "executions", `${execution}.json`),
    JSON.stringify({ version: 1, id: execution, proprietaire: { type: "action", id }, declencheur: "manuelle", debut, fin: debut, statut: "reussie", ...(saisie ? { saisie } : {}), blocs: [] }),
  );
  await writeFile(
    path.join(data, "resultats", `${execution}.json`),
    JSON.stringify({ version: 1, execution, saisie, resultats: { titre }, plan: { blocs: [{ composant: "titre", props: { texte: titre } }] }, secours: false, vide: false }),
  );
}

export const tid = (id: string) => `[data-testid="${id}"]`;

/** Reads and waits on the sidebar UI's elements by CSS selector (Playwright's locators, as these files need them). */
export function uiQueries(m: Marionette) {
  const text = (selector: string) => inUi<string | null>(m, "return doc.querySelector(arguments[0])?.textContent ?? null;", [selector]);
  const count = (selector: string) => inUi<number>(m, "return doc.querySelectorAll(arguments[0]).length;", [selector]);
  /** Fails with the last text seen. */
  const until = async (selector: string, ok: (t: string | null) => boolean, what: string, ms: number) => {
    const deadline = Date.now() + ms;
    for (let t = await text(selector); ; t = await text(selector)) {
      if (ok(t)) return;
      if (Date.now() > deadline) throw new Error(`${selector}: expected ${what}, got ${JSON.stringify(t)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  return {
    text,
    count,
    waitText: (selector: string, expected: string, ms = 10_000) => until(selector, (t) => t?.trim() === expected, JSON.stringify(expected), ms),
    waitContains: (selector: string, part: string, ms = 10_000) => until(selector, (t) => !!t?.includes(part), `to contain ${JSON.stringify(part)}`, ms),
    waitCount: (selector: string, n: number, ms = 10_000) => waitUi(m, "return doc.querySelectorAll(arguments[0]).length === arguments[1];", [selector, n], ms),
    value: (selector: string) => inUi<string | null>(m, "return doc.querySelector(arguments[0])?.value ?? null;", [selector]),
  };
}

export interface TestServer {
  url: string;
  log: string[];
  close(): Promise<void>;
}

/** A local server, each URL asked noted in `log`. */
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
export const LAYOUT_PROMPT = "Tu mets en page le résultat d'une action pour l'utilisateur.";

/** A 1×1 red PNG. */
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

/** What the image server received: path, Cookie and Referer of each request. */
export type ImageRequestSeen = { path: string; cookie: string | null; referer: string | null };

/**
 * The action servers (the site, the fake Gemma and `reglages`, reset by `reset()`), plus the
 * fake Kev, and an image server noting each request's path, Cookie and Referer. Image server paths: `/cookie` sets
 * `seen=<value of ?v>` (a page), `*.png` a PNG with a Set-Cookie, `*\/r` a 302 to `/secret` (absolute http URL),
 * `/hop` a 302 to `/p.png`, `/secret` a PNG, `*.jpg` a PNG too, `*\/html.png` an HTML page, `*\/big.png` 6 MB.
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
    // Hostile images (Review Focus 3): not an image, or over the 5 MB limit.
    if (u.pathname.endsWith("/html.png")) return void res.writeHead(200, { "Content-Type": "text/html" }).end("<title>pas une image</title>");
    if (u.pathname.endsWith("/big.png")) return void res.writeHead(200, { "Content-Type": "image/png" }).end(Buffer.alloc(6 * 1024 * 1024));
    if (u.pathname.endsWith(".png") || u.pathname.endsWith(".jpg") || u.pathname === "/secret") return void res.writeHead(200, { "Content-Type": "image/png", "Set-Cookie": "leak=1; Max-Age=3600; Path=/" }).end(PNG);
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
